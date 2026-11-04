import type { DeletedBranch, OperationKind, RepoOperationEntry, RestorePoint } from '@shared/types'
import { assertRefName, git, gitOut, GitError } from './exec'
import { currentBranch } from './refs'
import { status } from './status'

interface Entry {
  sha: string
  date: number
  subject: string
}

const US = '\x1f'

async function entries(repo: string, limit: number): Promise<Entry[]> {
  const r = await git(repo, ['reflog', 'show', '--date=unix', `--format=%H${US}%gd${US}%gs`, `-n${limit}`, 'HEAD'], { okCodes: [128] })
  if (r.code !== 0) return []
  return r.stdout.split('\n').filter(Boolean).map(line => {
    const [sha, selector, subject] = line.split(US)
    return { sha, date: +(/\{(\d+)\}/.exec(selector)?.[1] ?? 0), subject }
  })
}

const GROUP_END = /^(rebase|pull --rebase|pull)( -i| -m)?( \([^)]*\))? ?\((finish|abort)\): (?:returning to )?(?:refs\/heads\/)?(.*)$/
const GROUP_START = /\(start\)/

/**
 * Turns HEAD's reflog into user-level operations, newest first. A rebase is
 * one operation (its picks are folded in), and each operation knows the HEAD
 * and branch it started from, so it can be undone.
 */
export async function operations(repo: string, limit = 150): Promise<RepoOperationEntry[]> {
  const [list, branch, locals, remotes] = await Promise.all([
    entries(repo, limit * 4),
    currentBranch(repo),
    gitOut(repo, ['for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads']).then(s => new Set(s.split('\n').filter(Boolean))),
    gitOut(repo, ['remote']).then(s => s.split('\n').filter(Boolean)),
  ])
  // A name that is neither a hash nor a remote branch was a local branch, even if deleted since.
  const wasBranch = (n: string) =>
    locals.has(n) || (!/^[0-9a-f]{7,64}$/.test(n) && n !== 'HEAD' && !remotes.some(r => n.startsWith(`${r}/`)))
  const ops: RepoOperationEntry[] = []
  let after = branch

  for (let i = 0; i < list.length && ops.length < limit; i++) {
    const e = list[i]
    const end = GROUP_END.exec(e.subject)
    if (end) {
      let j = i + 1
      while (j < list.length && !GROUP_START.test(list[j].subject)) j++
      const start = list[j]
      const before = list[j + 1]
      const target = end[5] || after
      const ontoRaw = start ? /checkout (.*)$/.exec(start.subject)?.[1] : undefined
      const onto = ontoRaw && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(ontoRaw) ? ontoRaw.slice(0, 7) : ontoRaw
      const picks = list.slice(i + 1, j).length
      ops.push({
        id: `${e.sha}-${e.date}-${i}`,
        kind: end[1] === 'rebase' ? 'rebase' : 'pull',
        title: end[4] === 'abort' ? 'Aborted rebase' : end[1] === 'rebase' ? `Rebase ${target}${onto ? ` onto ${onto}` : ''}` : `Pull with rebase on ${target}`,
        detail: end[4] === 'abort' ? 'Returned to where it started' : `${picks} commit${picks === 1 ? '' : 's'} replayed`,
        date: e.date,
        before: { sha: before?.sha ?? '', branch: target },
        after: { sha: e.sha, branch: after },
      })
      after = target
      i = j
      continue
    }

    const before = list[i + 1]
    const [action, ...rest] = e.subject.split(': ')
    const message = rest.join(': ')
    let kind: OperationKind = 'other'
    let title = e.subject
    let branchBefore = after

    if (action === 'commit') { kind = 'commit'; title = message }
    else if (action === 'commit (initial)') { kind = 'commit'; title = message }
    else if (action === 'commit (amend)') { kind = 'amend'; title = `Amend: ${message}` }
    else if (action === 'commit (merge)') { kind = 'merge'; title = message }
    else if (action === 'checkout') {
      kind = 'checkout'
      const m = /^moving from (.+) to (.+)$/.exec(message)
      if (m) {
        branchBefore = wasBranch(m[1]) ? m[1] : null
        title = `Switched from ${m[1]} to ${m[2]}`
      }
    } else if (action === 'reset') { kind = 'reset'; title = `Reset ${message.replace('moving to ', 'to ')}` }
    else if (action.startsWith('merge ')) { kind = 'merge'; title = `Merged ${action.slice(6)}${message === 'Fast-forward' ? ' (fast-forward)' : ''}` }
    else if (action.startsWith('pull')) { kind = 'pull'; title = `Pull${message ? `: ${message}` : ''}` }
    else if (action.startsWith('cherry-pick')) { kind = 'cherry-pick'; title = `Cherry-pick: ${message}` }
    else if (action.startsWith('revert')) { kind = 'revert'; title = `Revert: ${message}` }
    else if (action.startsWith('rebase')) { kind = 'rebase'; title = `Rebase in progress: ${message}` }

    ops.push({
      id: `${e.sha}-${e.date}-${i}`,
      kind,
      title: title.replace(/\b[0-9a-f]{40}\b/g, s => s.slice(0, 7)),
      detail: e.subject,
      date: e.date,
      before: { sha: before?.sha ?? '', branch: branchBefore },
      after: { sha: e.sha, branch: after },
    })
    after = branchBefore
  }
  return ops
}

/**
 * Branches seen in HEAD's reflog that no longer exist, with their last known
 * tip: the newest commit HEAD was at while that branch was checked out.
 * Commits made on the branch while it was not checked out (a fetch, a push
 * from elsewhere) are not known, so this is a best effort; the app records
 * the exact tip of branches it deletes itself.
 */
export async function deletedBranches(repo: string): Promise<DeletedBranch[]> {
  const [list, branch, locals, remotes] = await Promise.all([
    entries(repo, 3000),
    currentBranch(repo),
    gitOut(repo, ['for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads']).then(s => new Set(s.split('\n').filter(Boolean))),
    gitOut(repo, ['remote']).then(s => s.split('\n').filter(Boolean)),
  ])
  const looksLikeBranch = (n: string) =>
    !!n && n !== 'HEAD' && !/^[0-9a-f]{7,64}$/.test(n) && !/[~^:\s]/.test(n) && !remotes.some(r => n.startsWith(`${r}/`))

  const tips = new Map<string, { sha: string; date: number }>()
  let cur = branch
  for (let i = 0; i < list.length; i++) {
    const e = list[i]
    if (cur && !tips.has(cur)) tips.set(cur, { sha: e.sha, date: e.date })
    const co = /^checkout: moving from (.+) to (.+)$/.exec(e.subject)
    if (co) cur = looksLikeBranch(co[1]) ? co[1] : null
    const fin = GROUP_END.exec(e.subject)
    if (fin && fin[5]) cur = fin[5]
  }

  const gone = [...tips].filter(([name]) => !locals.has(name) && looksLikeBranch(name))
  if (!gone.length) return []
  // Only offer tips whose commit still exists (not garbage-collected): one batch query for all.
  const shas = [...new Set(gone.map(([, tip]) => tip.sha))]
  const check = await git(repo, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: `${shas.join('\n')}\n` })
  const alive = shas.filter(s => check.stdout.includes(`${s} commit`))
  const subjects = new Map<string, string>()
  if (alive.length) {
    const log = await gitOut(repo, ['log', '--no-walk=unsorted', `--format=%H${US}%s`, ...alive])
    for (const line of log.split('\n')) {
      const [sha, subject] = line.split(US)
      if (sha) subjects.set(sha, subject ?? '')
    }
  }
  return gone.filter(([, tip]) => subjects.has(tip.sha))
    .map(([name, tip]): DeletedBranch => ({ name, sha: tip.sha, date: tip.date, subject: subjects.get(tip.sha)!, source: 'reflog' }))
    .sort((a, b) => b.date - a.date)
}

export async function restoreBranch(repo: string, name: string, sha: string): Promise<void> {
  await assertRefName(repo, 'branch', name)
  await git(repo, ['branch', name, sha])
}

/**
 * Brings the repository back to a point: switches to its branch, then moves
 * that branch with `reset --keep`, which refuses to lose uncommitted work.
 * Returns where we were, so the caller can offer redo.
 */
export async function restore(repo: string, target: RestorePoint): Promise<RestorePoint> {
  const st = await status(repo)
  if (st.operation) throw new GitError(`A ${st.operation} is in progress. Abort or finish it first.`)
  if (!target.sha) throw new GitError('There is no earlier state to go back to.')
  const prev: RestorePoint = { sha: st.head ?? '', branch: st.branch }

  if (target.branch && target.branch !== st.branch) {
    const exists = await git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${target.branch}`], { okCodes: [1] })
    if (exists.code === 0) await git(repo, ['switch', target.branch])
    else await git(repo, ['switch', '-c', target.branch, target.sha])
  } else if (!target.branch && st.branch) {
    await git(repo, ['switch', '--detach', target.sha])
    return prev
  }
  const head = (await gitOut(repo, ['rev-parse', 'HEAD'])).trim()
  if (head !== target.sha) await git(repo, ['reset', '--keep', target.sha])
  return prev
}
