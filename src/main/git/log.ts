import type { Commit, CommitDetail, CommitFile, LogQuery, Signature } from '@shared/types'
import { git, gitOut, toGitError } from './exec'

const RS = '\x1e'
const US = '\x1f'
export const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%s', '%D'].join('%x1f') + '%x1e'

export async function log(repo: string, q: LogQuery): Promise<Commit[]> {
  const args = ['log', `--format=${LOG_FORMAT}`, '--topo-order', `--skip=${q.skip}`, `-n${q.limit}`, '--decorate=full']
  if (q.search?.trim()) {
    const s = q.search.trim()
    const author = /^@(.+)$/.exec(s)
    const mode = author ? 'author' : q.searchMode ?? 'message'
    // -S finds commits that add or remove the string; -G those whose diff matches the regex.
    if (mode === 'author') args.push(`--author=${author?.[1] ?? s}`, '-i')
    else if (mode === 'content') args.push(`-S${s}`)
    else if (mode === 'regex') args.push(`-G${s}`)
    else args.push(`--grep=${s}`, '-i', '-F')
  }
  if (q.scope === 'all') args.push('--branches', '--remotes', '--tags', 'HEAD')
  else args.push('HEAD')
  if (q.path) args.push('--follow', '--', q.path)

  const r = await git(repo, args, { okCodes: [128] })
  if (r.code === 128) {
    // A branch with no commit yet has no history. Any other failure (a search regex git cannot
    // read, "foo(") is said, instead of showing as a search that found nothing.
    const born = await git(repo, ['rev-parse', '-q', '--verify', 'HEAD'], { okCodes: [1, 128] })
    if (born.code !== 0) return []
    throw toGitError(r.stdout, r.stderr, r.code)
  }
  const commits = parseLog(r.stdout)

  // A hash typed in the search box should find the commit even if no message matches.
  if (q.search && q.skip === 0 && /^[0-9a-f]{4,40}$/i.test(q.search.trim()) && !commits.length) {
    const one = await git(repo, ['log', `--format=${LOG_FORMAT}`, '-n1', q.search.trim(), '--decorate=full'], { okCodes: [128] })
    return one.code === 0 ? parseLog(one.stdout) : []
  }
  return commits
}

export function parseLog(out: string): Commit[] {
  const commits: Commit[] = []
  for (const rec of out.split(RS)) {
    const r = rec.replace(/^\n/, '')
    if (!r) continue
    const [sha, parents, author, email, date, subject, refs] = r.split(US)
    commits.push({
      sha,
      parents: parents ? parents.split(' ') : [],
      author,
      email,
      date: +date,
      subject,
      refs: refs ? refs.split(', ').map(cleanRef).filter(Boolean) : [],
    })
  }
  return commits
}

/** Turns `HEAD -> refs/heads/main` / `tag: refs/tags/v1` into short display names. */
export function cleanRef(ref: string): string {
  return ref
    .replace(/^HEAD -> refs\/heads\//, 'HEAD→')
    .replace(/^tag: refs\/tags\//, 'tag:')
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\//, 'remote:')
    .replace(/^refs\/stash$/, '')
}

const DETAIL_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%D', '%s', '%b'].join('%x1f')

export async function commitDetail(repo: string, sha: string): Promise<CommitDetail> {
  const meta = await gitOut(repo, ['show', '-s', `--format=${DETAIL_FORMAT}`, '--decorate=full', sha])
  const [h, parents, author, email, date, committer, committerEmail, committerDate, refs, subject, body] = meta.split(US)
  const parentList = parents ? parents.split(' ') : []
  const [files, sig] = await Promise.all([
    changedFiles(repo, parentList[0] ?? null, h),
    git(repo, ['show', '-s', '--format=%G?%x1f%GS%x1f%GK', h], { okCodes: [128] }).then(r => r.stdout.trim().split(US)).catch(() => ['N']),
  ])
  const signature = sig[0] && sig[0] !== 'N' ? { status: sig[0] as Signature['status'], signer: sig[1] ?? '', key: sig[2] ?? '' } : undefined
  return {
    sha: h, parents: parentList, author, email, date: +date, committer, committerEmail,
    committerDate: +committerDate, refs: refs ? refs.split(', ').map(cleanRef).filter(Boolean) : [],
    subject, body: (body ?? '').trim(), files, signature,
  }
}

/** Files changed between two trees, with line counts. `from` null means the root commit. */
export async function changedFiles(repo: string, from: string | null, to: string): Promise<CommitFile[]> {
  const range = from ? [from, to] : ['--root', to]
  const [status, numstat] = await Promise.all([
    gitOut(repo, ['diff-tree', '-r', '-z', '-M', '--no-commit-id', '--name-status', ...range]),
    gitOut(repo, ['diff-tree', '-r', '-z', '-M', '--no-commit-id', '--numstat', ...range]),
  ])

  const files: CommitFile[] = []
  const t = status.split('\0')
  for (let i = 0; i < t.length; i++) {
    const code = t[i]
    if (!code) continue
    if (code[0] === 'R' || code[0] === 'C') files.push({ status: code[0], oldPath: t[++i], path: t[++i], additions: 0, deletions: 0, binary: false })
    else files.push({ status: code[0], path: t[++i], additions: 0, deletions: 0, binary: false })
  }

  // numstat -z: "add\tdel\tpath\0" or, for renames, "add\tdel\t\0old\0new\0".
  const byPath = new Map(files.map(f => [f.path, f]))
  const n = numstat.split('\0')
  for (let i = 0; i < n.length; i++) {
    const rec = n[i]
    if (!rec) continue
    const [a, d, p] = rec.split('\t')
    let path = p
    if (p === '') { i++; path = n[++i] }
    const f = byPath.get(path)
    if (!f) continue
    if (a === '-') f.binary = true
    else { f.additions = +a; f.deletions = +d }
  }
  return files
}

/** Stash contents shaped like a commit, including untracked files kept in the third parent. */
export async function stashDetail(repo: string, index: number): Promise<CommitDetail> {
  const ref = `stash@{${index}}`
  const detail = await commitDetail(repo, ref)
  const hasUntracked = await git(repo, ['rev-parse', '--verify', '-q', `${ref}^3`], { okCodes: [1] }).then(r => r.code === 0)
  if (hasUntracked) {
    const names = (await gitOut(repo, ['ls-tree', '-r', '-z', '--name-only', `${ref}^3`])).split('\0').filter(Boolean)
    for (const path of names) detail.files.push({ path, status: '?', additions: 0, deletions: 0, binary: false })
  }
  return detail
}
