import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NewerTip, Progress } from '@shared/types'
import { git, gitOut } from './exec'
import { gitDir } from './status'

/**
 * Finding where a deleted branch really ended up. Sources, from cheapest:
 *  - remote-tracking branches with the same name (pushed from elsewhere);
 *  - the prune journal: remote-tracking branches that a fetch removed because
 *    the branch was deleted on the server, with the commit they pointed to;
 *  - commits nothing references any more (`git fsck --unreachable`);
 *  - on demand, the remote itself: a fetch without pruning, plus the pull and
 *    merge request refs GitHub, GitLab and Azure DevOps keep after a branch is
 *    deleted, fetched into a temporary namespace.
 * Sources that carry the branch's name (remote-tracking refs, the prune
 * journal) always win: unnamed ones (unreferenced commits, PR refs) only say
 * "descends from the known tip", which another branch started from it could
 * also do, so they are used only when no named source knows the branch.
 * Within a tier, the newest descendant of the last known tip wins.
 */

type Reporter = (p: Progress | null) => void

interface Pruned { ref: string; sha: string; date: number }

const JOURNAL = 'gdg-pruned-refs.json'
const RECOVERY_NS = 'refs/gdg-recovery'

async function readJournal(repo: string): Promise<Pruned[]> {
  try {
    return JSON.parse(await readFile(join(await gitDir(repo), JOURNAL), 'utf8')) as Pruned[]
  } catch {
    return []
  }
}

async function remoteRefs(repo: string): Promise<Map<string, string>> {
  const out = await gitOut(repo, ['for-each-ref', '--format=%(refname:lstrip=2) %(objectname)', 'refs/remotes'])
  return new Map(out.split('\n').filter(Boolean).map(l => l.split(' ') as [string, string]).filter(([ref]) => !ref.endsWith('/HEAD')))
}

/**
 * Runs an operation that may delete remote-tracking branches (fetch --prune,
 * push --delete) and journals each removed one with its last commit, so the
 * commits stay findable after the ref is gone.
 */
export async function withPruneJournal<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const before = await remoteRefs(repo).catch(() => new Map<string, string>())
  try {
    return await fn()
  } finally {
    const after = await remoteRefs(repo).catch(() => null)
    if (after) {
      const now = Math.floor(Date.now() / 1000)
      const removed = [...before].filter(([ref]) => !after.has(ref)).map(([ref, sha]) => ({ ref, sha, date: now }))
      if (removed.length) {
        const journal = [...removed, ...(await readJournal(repo))].slice(0, 1000)
        await writeFile(join(await gitDir(repo), JOURNAL), JSON.stringify(journal), 'utf8').catch(() => undefined)
      }
    }
  }
}

interface Candidate { sha: string; via: NewerTip['via']; ref?: string }

/** Newest descendant of each branch's known tip among the candidates. */
async function bestDescendants(repo: string, branches: { name: string; sha: string }[], pool: (name: string) => Candidate[]): Promise<NewerTip[]> {
  const out: NewerTip[] = []
  for (const b of branches) {
    const candidates = pool(b.name)
    if (!candidates.length) continue
    // The known tip itself must exist: --ignore-missing would drop the "^" and walk all history.
    const known = await git(repo, ['cat-file', '-e', `${b.sha}^{commit}`], { okCodes: [1, 128] })
    if (known.code !== 0) continue
    // A journaled commit collected by gc since made the whole query fail, hiding the valid ones.
    const r = await git(repo, ['rev-list', '--ancestry-path', '--date-order', '-n1', '--ignore-missing', '--stdin'], {
      input: [`^${b.sha}`, ...new Set(candidates.map(c => c.sha))].join('\n') + '\n', okCodes: [128],
    })
    const newest = r.stdout.trim()
    if (r.code !== 0 || !newest) continue
    const [count, meta] = await Promise.all([
      gitOut(repo, ['rev-list', '--count', `${b.sha}..${newest}`]),
      gitOut(repo, ['log', '-1', '--format=%s%x1f%ct', newest]),
    ])
    const [subject, date] = meta.trim().split('\x1f')
    // Name the source: the first candidate (in priority order) that contains the newest commit.
    // Candidates that cannot be told apart (thousands of unreferenced commits) need no search.
    const alike = candidates.every(c => c.via === candidates[0].via && c.ref === candidates[0].ref)
    let source: Candidate | undefined = alike ? candidates[0] : undefined
    for (const c of alike ? [] : candidates) {
      if (c.sha === newest) { source = c; break }
      const anc = await git(repo, ['merge-base', '--is-ancestor', newest, c.sha], { okCodes: [1, 128] })
      if (anc.code === 0) { source = c; break }
    }
    out.push({ name: b.name, sha: newest, ahead: +count.trim(), subject, date: +date, via: source?.via ?? 'unreferenced', ref: source?.ref })
  }
  return out
}

const sameName = (ref: string, name: string) => ref.endsWith(`/${name}`)

const isNamed = (t: NewerTip) => t.via === 'remote' || t.via === 'pruned'

/** Local search: remote-tracking branches and the prune journal first, then unreferenced commits. */
export async function newerTips(repo: string, branches: { name: string; sha: string }[]): Promise<NewerTip[]> {
  if (!branches.length) return []
  const [remotes, journal, fsck] = await Promise.all([
    remoteRefs(repo),
    readJournal(repo),
    // Years of rebases can leave millions of loose objects: only the first 16 MB of the list is read.
    git(repo, ['fsck', '--unreachable', '--no-reflogs', '--no-progress'], { okCodes: [1, 2, 4, 8], maxBytes: 16 * 1024 * 1024 }).then(r => r.stdout, () => ''),
  ])
  const named = await bestDescendants(repo, branches, name => [
    ...[...remotes].filter(([ref]) => sameName(ref, name)).map(([ref, sha]): Candidate => ({ sha, via: 'remote', ref })),
    ...journal.filter(p => sameName(p.ref, name)).map((p): Candidate => ({ sha: p.sha, via: 'pruned', ref: p.ref })),
  ])
  const rest = branches.filter(b => !named.some(n => n.name === b.name))
  const dangling = fsck.split('\n').map(l => /^unreachable commit ([0-9a-f]{40})$/.exec(l)?.[1]).filter((s): s is string => !!s).slice(0, 3000)
  const unnamed = await bestDescendants(repo, rest, () => dangling.map((sha): Candidate => ({ sha, via: 'unreferenced' })))
  return [...named, ...unnamed]
}

/**
 * Network search, on demand: fetches every remote without pruning (new and
 * never-fetched branches arrive), then the pull/merge request heads the
 * providers keep after a branch is deleted, into a temporary namespace that
 * is removed afterwards (the objects stay until git's garbage collection,
 * long enough to restore).
 */
export async function remoteSearch(repo: string, branches: { name: string; sha: string }[], report: Reporter): Promise<NewerTip[]> {
  if (!branches.length) return []
  const remoteNames = (await gitOut(repo, ['remote'])).split('\n').filter(Boolean)
  const prRefs: Candidate[] = []
  try {
    for (const remote of remoteNames) {
      report({ op: 'fetch', title: `Searching ${remote}`, phase: 'Fetching branches' })
      await withPruneJournal(repo, () => git(repo, ['fetch', '--no-prune', '--no-tags', remote])).catch(() => undefined)

      report({ op: 'fetch', title: `Searching ${remote}`, phase: 'Listing pull requests' })
      const listed = await git(repo, ['ls-remote', remote, 'refs/pull/*', 'refs/merge-requests/*']).then(r => r.stdout, () => '')
      const refs = listed.split('\n').map(l => l.split('\t')[1]).filter(Boolean)
      if (!refs.length) continue
      report({ op: 'fetch', title: `Searching ${remote}`, phase: `Fetching ${refs.length} pull request refs` })
      const specs = ['refs/pull', 'refs/merge-requests']
        .filter(ns => refs.some(r => r.startsWith(`${ns}/`)))
        .map(ns => `+${ns}/*:${RECOVERY_NS}/${remote}/${ns.slice(5)}/*`)
      await git(repo, ['fetch', '--no-tags', '--no-write-fetch-head', remote, ...specs]).catch(() => undefined)

      const got = await gitOut(repo, ['for-each-ref', '--format=%(refname) %(objectname)', `${RECOVERY_NS}/${remote}`])
      const rows = got.split('\n').filter(Boolean).map(l => l.split(' ') as [string, string])
      const heads = new Set(rows.filter(([r]) => r.endsWith('/head')).map(([r]) => r.replace(/\/head$/, '')))
      for (const [ref, sha] of rows) {
        const m = /\/(pull|merge-requests)\/(\d+)\/(head|merge)$/.exec(ref)
        if (!m) continue
        const label = `${remote} ${m[1] === 'pull' ? 'PR' : 'MR'} #${m[2]}`
        if (m[3] === 'head') prRefs.push({ sha, via: 'pull-request', ref: label })
        // Azure DevOps only exposes the merge preview: its second parent is the source branch.
        else if (!heads.has(ref.replace(/\/merge$/, ''))) {
          const src = await git(repo, ['rev-parse', '--verify', '-q', `${sha}^2`], { okCodes: [1] })
          if (src.code === 0) prRefs.push({ sha: src.stdout.trim(), via: 'pull-request', ref: label })
        }
      }
    }
    report({ op: 'fetch', title: 'Searching', phase: 'Comparing histories' })
    const local = await newerTips(repo, branches)
    // PR refs are unnamed: only for branches no remote branch or journal entry knows.
    const unknown = branches.filter(b => !local.some(t => t.name === b.name && isNamed(t)))
    const viaPr = await bestDescendants(repo, unknown, () => prRefs)
    const best = new Map<string, NewerTip>(local.map(t => [t.name, t]))
    for (const t of viaPr) {
      const cur = best.get(t.name)
      if (!cur || (!isNamed(cur) && (t.date > cur.date || (t.date === cur.date && t.ahead > cur.ahead)))) best.set(t.name, t)
    }
    return [...best.values()]
  } finally {
    const leftovers = await gitOut(repo, ['for-each-ref', '--format=delete %(refname)', RECOVERY_NS]).catch(() => '')
    if (leftovers.trim()) await git(repo, ['update-ref', '--stdin'], { input: leftovers }).catch(() => undefined)
    report(null)
  }
}
