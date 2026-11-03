import { existsSync } from 'node:fs'
import { appendFile, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { shell } from 'electron'
import type { Author, DiffOptions, LineSelection, Progress, PullMode, ResetMode, RepoStatus } from '@shared/types'
import { applyPatch, buildPartialPatch, diff } from './diff'
import { git, gitOut, GitError } from './exec'
import { currentBranch, defaultRemote, upstreamOf } from './refs'
import { gitDir, status } from './status'

/* ─── Staging ───────────────────────────────────────────────────────────────── */

/** Paths are passed through stdin so thousands of files never hit the command-line limit. */
const viaStdin = (paths: string[]) => ({ input: paths.join('\0') })

export async function stage(repo: string, paths: string[]): Promise<void> {
  if (!paths.length) return
  await git(repo, ['add', '--all', '--pathspec-from-file=-', '--pathspec-file-nul'], viaStdin(paths))
}

export async function unstage(repo: string, paths: string[]): Promise<void> {
  if (!paths.length) return
  const hasHead = await git(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [1] }).then(r => r.code === 0)
  if (hasHead) await git(repo, ['reset', '-q', 'HEAD', '--pathspec-from-file=-', '--pathspec-file-nul'], viaStdin(paths))
  else await git(repo, ['rm', '--cached', '-r', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], viaStdin(paths))
}

const FULL_CONTEXT: DiffOptions = { context: 3, ignoreWhitespace: false, force: true }

export async function stageLines(repo: string, path: string, selection: LineSelection, untracked: boolean, opts = FULL_CONTEXT): Promise<void> {
  if (untracked) await git(repo, ['add', '--intent-to-add', '--', path])
  const d = await diff(repo, { kind: 'worktree', path }, { ...opts, ignoreWhitespace: false, force: true })
  const patch = buildPartialPatch(d, selection, 'forward')
  if (patch) await applyPatch(repo, patch, ['--cached'], d.encoding)
}

export async function unstageLines(repo: string, path: string, selection: LineSelection, opts = FULL_CONTEXT): Promise<void> {
  const d = await diff(repo, { kind: 'index', path }, { ...opts, ignoreWhitespace: false, force: true })
  const patch = buildPartialPatch(d, selection, 'reverse')
  if (patch) await applyPatch(repo, patch, ['--cached', '--reverse'], d.encoding)
}

export async function discardLines(repo: string, path: string, selection: LineSelection, opts = FULL_CONTEXT): Promise<void> {
  const d = await diff(repo, { kind: 'worktree', path }, { ...opts, ignoreWhitespace: false, force: true })
  const patch = buildPartialPatch(d, selection, 'reverse')
  if (patch) await applyPatch(repo, patch, ['--reverse'], d.encoding)
}

/**
 * Drops every local change (staged and unstaged) to the given files. Files
 * that HEAD does not know go to the recycle bin rather than being deleted, so
 * a misclick is always recoverable.
 */
export async function discard(repo: string, paths: string[]): Promise<void> {
  const st = await status(repo)
  const byPath = new Map(st.files.map(f => [f.path, f]))
  const created: string[] = []
  const tracked: string[] = []
  for (const p of paths) {
    const f = byPath.get(p)
    if (!f) continue
    if (f.untracked || f.index === 'A' || f.index === 'R' || f.index === 'C' || !st.hasCommits) created.push(p)
    else tracked.push(p)
    // A rename is undone by restoring the original file as well.
    if (f.oldPath && f.index === 'R') tracked.push(f.oldPath)
  }
  if (tracked.length) {
    await git(repo, ['restore', '--source=HEAD', '--staged', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], viaStdin(tracked))
  }
  const staged = created.filter(p => !byPath.get(p)?.untracked)
  if (staged.length) await git(repo, ['rm', '--cached', '-q', '-r', '--pathspec-from-file=-', '--pathspec-file-nul'], viaStdin(staged))
  for (const p of created) await shell.trashItem(join(repo, p)).catch(() => undefined)
}

export async function ignore(repo: string, pattern: string): Promise<void> {
  const file = join(repo, '.gitignore')
  let current = ''
  try { current = await readFile(file, 'utf8') } catch { /* new file */ }
  const prefix = current && !current.endsWith('\n') ? '\n' : ''
  await appendFile(file, `${prefix}${pattern}\n`, 'utf8')
}

/* ─── Commits ───────────────────────────────────────────────────────────────── */

export async function commit(repo: string, message: string, amend: boolean, opts: { noVerify?: boolean } = {}): Promise<string> {
  const args = ['commit', '-F', '-', '--cleanup=strip']
  if (amend) args.push('--amend')
  if (opts.noVerify) args.push('--no-verify')
  try {
    await git(repo, args, { input: message })
  } catch (e) {
    // A failure git does not explain itself is almost always a pre-commit or commit-msg hook.
    if (e instanceof GitError && !e.code && (await hasCommitHook(repo))) e.code = 'HOOK_FAILED'
    throw e
  }
  return (await gitOut(repo, ['rev-parse', 'HEAD'])).trim()
}

async function hasCommitHook(repo: string): Promise<boolean> {
  const custom = (await git(repo, ['config', '--get', 'core.hooksPath'], { okCodes: [1] })).stdout.trim()
  const dir = custom ? (isAbsolute(custom) ? custom : join(repo, custom)) : join(await gitDir(repo), 'hooks')
  return ['pre-commit', 'commit-msg', 'prepare-commit-msg'].some(h => existsSync(join(dir, h)))
}

/** People who committed here, most active first: suggestions for co-authors. */
export async function authors(repo: string): Promise<Author[]> {
  const out = (await git(repo, ['shortlog', '-sne', '--all', 'HEAD'], { okCodes: [128] })).stdout
  return out.split('\n').map(l => /^\s*(\d+)\s+(.+?) <([^>]+)>$/.exec(l)).filter(m => !!m)
    .map(m => ({ commits: +m![1], name: m![2], email: m![3] })).slice(0, 300)
}

/** The commit.template file, without its comment lines, and whether commits get signed. */
export async function commitSetup(repo: string): Promise<{ template: string; signing: boolean }> {
  const read = (key: string) => git(repo, ['config', '--get', key], { okCodes: [1] }).then(r => r.stdout.trim())
  const [templatePath, gpgsign] = await Promise.all([read('commit.template'), read('commit.gpgsign')])
  let template = ''
  if (templatePath) {
    const file = templatePath.replace(/^~(?=[\\/])/, homedir())
    const text = await readFile(isAbsolute(file) ? file : join(repo, file), 'utf8').catch(() => '')
    template = text.split(/\r?\n/).filter(l => !l.startsWith('#')).join('\n').trim()
  }
  return { template, signing: gpgsign === 'true' }
}

/** The message git prepared for an in-progress merge, squash or cherry-pick, without comments. */
export async function preparedMessage(repo: string): Promise<string> {
  const dir = await gitDir(repo)
  for (const f of ['MERGE_MSG', 'SQUASH_MSG']) {
    const text = await readFile(join(dir, f), 'utf8').catch(() => '')
    if (text) return text.split(/\r?\n/).filter(l => !l.startsWith('#')).join('\n').trim()
  }
  return ''
}

export async function lastCommitMessage(repo: string): Promise<string> {
  return (await gitOut(repo, ['log', '-1', '--format=%B'])).trim()
}

/** Moves HEAD back one commit and keeps its changes staged; returns its message. */
export async function undoCommit(repo: string): Promise<string> {
  const message = await lastCommitMessage(repo)
  const hasParent = await git(repo, ['rev-parse', '--verify', '-q', 'HEAD~1'], { okCodes: [1] }).then(r => r.code === 0)
  if (hasParent) await git(repo, ['reset', '--soft', 'HEAD~1'])
  else await git(repo, ['update-ref', '-d', 'HEAD'])
  return message
}

export async function resolve(repo: string, path: string, side: 'ours' | 'theirs'): Promise<void> {
  await git(repo, ['checkout', `--${side}`, '--', path])
  await git(repo, ['add', '--', path])
}

/** Commands that keep going without opening an editor. */
const NO_EDITOR = { env: { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' } }

async function currentOp(repo: string): Promise<RepoStatus['operation']> {
  return (await status(repo)).operation
}

export async function continueOp(repo: string): Promise<void> {
  const op = await currentOp(repo)
  if (!op) return
  if (op === 'merge') await git(repo, ['commit', '--no-edit'], NO_EDITOR)
  else await git(repo, [op, '--continue'], NO_EDITOR)
}

export async function abortOp(repo: string): Promise<void> {
  const op = await currentOp(repo)
  if (op) await git(repo, [op, '--abort'])
}

export async function skipOp(repo: string): Promise<void> {
  const op = await currentOp(repo)
  if (op && op !== 'merge') await git(repo, [op, '--skip'], NO_EDITOR)
}

/** Oldest first, so several picked commits land in their original order. */
async function chronological(repo: string, shas: string[]): Promise<string[]> {
  if (shas.length < 2) return shas
  const order = (await gitOut(repo, ['rev-list', '--topo-order', '--no-walk', ...shas])).trim().split('\n')
  return order.reverse()
}

export async function cherryPick(repo: string, shas: string[]): Promise<void> {
  await git(repo, ['cherry-pick', ...(await chronological(repo, shas))], NO_EDITOR)
}

/** Reverts newest first, so each revert applies cleanly on top of the previous one. */
export async function revert(repo: string, shas: string[]): Promise<void> {
  const ordered = (await chronological(repo, shas)).reverse()
  const merges = await Promise.all(ordered.map(async sha => (await gitOut(repo, ['rev-list', '--parents', '-n1', sha])).trim().split(' ').length > 2))
  if (merges.some(Boolean) && ordered.length > 1) throw new GitError('Revert merge commits one at a time.')
  await git(repo, ['revert', '--no-edit', ...(merges[0] ? ['-m', '1'] : []), ...ordered], NO_EDITOR)
}

export async function reset(repo: string, sha: string, mode: ResetMode): Promise<void> {
  await git(repo, ['reset', `--${mode}`, sha])
}

/* ─── Branches ──────────────────────────────────────────────────────────────── */

export async function checkout(repo: string, branch: string, opts: { stash?: boolean } = {}): Promise<void> {
  if (opts.stash) await git(repo, ['stash', 'push', '--include-untracked', '-m', `Auto-stash before switching to ${branch}`])
  // A remote branch ("origin/feature") gets a local tracking branch.
  const isLocal = await git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { okCodes: [1] }).then(r => r.code === 0)
  if (isLocal) return void (await git(repo, ['switch', branch]))
  const isRemote = await git(repo, ['rev-parse', '--verify', '-q', `refs/remotes/${branch}`], { okCodes: [1] }).then(r => r.code === 0)
  if (isRemote) {
    const local = branch.split('/').slice(1).join('/')
    const exists = await git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${local}`], { okCodes: [1] }).then(r => r.code === 0)
    if (exists) await git(repo, ['switch', local])
    else await git(repo, ['switch', '--track', branch])
    return
  }
  await git(repo, ['switch', branch])
}

export async function checkoutCommit(repo: string, sha: string): Promise<void> {
  await git(repo, ['switch', '--detach', sha])
}

export async function createBranch(repo: string, name: string, from: string | null, doCheckout: boolean): Promise<void> {
  if (doCheckout) await git(repo, ['switch', '-c', name, ...(from ? [from] : []), '--no-track'])
  else await git(repo, ['branch', '--no-track', name, ...(from ? [from] : [])])
}

export async function renameBranch(repo: string, from: string, to: string): Promise<void> {
  await git(repo, ['branch', '-m', from, to])
}

/** Deletes a local branch and returns the commit it pointed to, so it can be restored. */
export async function deleteBranch(repo: string, name: string, force: boolean): Promise<string> {
  const sha = (await gitOut(repo, ['rev-parse', `refs/heads/${name}`])).trim()
  await git(repo, ['branch', force ? '-D' : '-d', name])
  return sha
}

export async function merge(repo: string, ref: string, opts: { squash?: boolean; noFf?: boolean } = {}): Promise<void> {
  const args = ['merge', '--no-edit']
  if (opts.squash) args.push('--squash')
  if (opts.noFf) args.push('--no-ff')
  await git(repo, [...args, ref], NO_EDITOR)
}

export async function rebase(repo: string, onto: string): Promise<void> {
  await git(repo, ['rebase', onto], NO_EDITOR)
}

export async function createTag(repo: string, name: string, sha: string, message: string): Promise<void> {
  if (message.trim()) await git(repo, ['tag', '-a', name, sha, '-F', '-'], { input: message })
  else await git(repo, ['tag', name, sha])
}

export async function deleteTag(repo: string, name: string): Promise<void> {
  await git(repo, ['tag', '-d', name])
}

/* ─── Stash ─────────────────────────────────────────────────────────────────── */

export async function stash(repo: string, message: string, includeUntracked: boolean, paths?: string[]): Promise<void> {
  const args = ['stash', 'push']
  if (includeUntracked) args.push('--include-untracked')
  if (message.trim()) args.push('-m', message.trim())
  if (paths?.length) args.push('--', ...paths)
  await git(repo, args)
}

export async function stashApply(repo: string, index: number, pop: boolean): Promise<void> {
  await git(repo, ['stash', pop ? 'pop' : 'apply', '--index', `stash@{${index}}`]).catch(async e => {
    // --index fails when the staged state cannot be restored; fall back to a plain apply.
    if (e instanceof GitError && e.code !== 'CONFLICTS') await git(repo, ['stash', pop ? 'pop' : 'apply', `stash@{${index}}`])
    else throw e
  })
}

export async function stashDrop(repo: string, index: number): Promise<void> {
  await git(repo, ['stash', 'drop', `stash@{${index}}`])
}

/* ─── Remotes ───────────────────────────────────────────────────────────────── */

type Reporter = (p: Progress | null) => void

const PROGRESS_RE = /^(?:remote: )?([A-Za-z ]+):\s+(\d+)%/

function progressHandler(op: string, title: string, report: Reporter) {
  report({ op, title })
  return (line: string) => {
    const m = PROGRESS_RE.exec(line)
    if (m) report({ op, title, phase: m[1].trim(), percent: +m[2] })
  }
}

export async function fetchAll(repo: string, report: Reporter): Promise<void> {
  try {
    await git(repo, ['fetch', '--all', '--prune', '--progress'], { onStderrLine: progressHandler('fetch', 'Fetching', report) })
  } finally {
    report(null)
  }
}

export async function pull(repo: string, mode: PullMode, report: Reporter): Promise<void> {
  const branch = await currentBranch(repo)
  if (!branch) throw new GitError('You are not on a branch (detached HEAD).')
  if (!(await upstreamOf(repo, branch))) throw new GitError(`Branch "${branch}" has no upstream to pull from. Push it first.`, 'NO_UPSTREAM')
  const flag = mode === 'rebase' ? '--rebase' : mode === 'ff-only' ? '--ff-only' : '--no-rebase'
  try {
    await git(repo, ['pull', flag, '--autostash', '--progress'], { ...NO_EDITOR, onStderrLine: progressHandler('pull', 'Pulling', report) })
  } finally {
    report(null)
  }
}

export async function push(repo: string, opts: { force?: boolean; setUpstream?: boolean }, report: Reporter): Promise<void> {
  const branch = await currentBranch(repo)
  if (!branch) throw new GitError('You are not on a branch (detached HEAD).')
  const upstream = await upstreamOf(repo, branch)
  const args = ['push', '--progress']
  if (opts.force) args.push('--force-with-lease')
  if (!upstream) {
    const remote = await defaultRemote(repo)
    if (!remote) throw new GitError('This repository has no remote. Add one in the sidebar first.')
    args.push('--set-upstream', remote, `HEAD:refs/heads/${branch}`)
  }
  try {
    await git(repo, args, { onStderrLine: progressHandler('push', upstream ? 'Pushing' : 'Publishing branch', report) })
  } finally {
    report(null)
  }
}

export async function pushTag(repo: string, remote: string, name: string, report: Reporter): Promise<void> {
  try {
    await git(repo, ['push', '--progress', remote, `refs/tags/${name}`], { onStderrLine: progressHandler('push', `Pushing tag ${name}`, report) })
  } finally {
    report(null)
  }
}

export async function deleteRemoteBranch(repo: string, remote: string, branch: string, report: Reporter): Promise<void> {
  try {
    await git(repo, ['push', '--progress', remote, '--delete', branch], { onStderrLine: progressHandler('push', `Deleting ${remote}/${branch}`, report) })
  } finally {
    report(null)
  }
}

export async function clone(url: string, parent: string, name: string, report: Reporter): Promise<void> {
  try {
    await git(parent, ['clone', '--progress', '--recurse-submodules', '--', url, name], { onStderrLine: progressHandler('clone', `Cloning ${name}`, report) })
  } finally {
    report(null)
  }
}

export async function addRemote(repo: string, name: string, url: string): Promise<void> {
  await git(repo, ['remote', 'add', name, url])
}

export async function removeRemote(repo: string, name: string): Promise<void> {
  await git(repo, ['remote', 'remove', name])
}

/* ─── Identity ──────────────────────────────────────────────────────────────── */

export async function identity(repo: string | null): Promise<{ name: string; email: string; scope: 'local' | 'global' | 'none' }> {
  const read = async (scope: string, key: string) => {
    const r = await git(repo ?? process.cwd(), ['config', scope, '--get', key], { okCodes: [1] })
    return r.stdout.trim()
  }
  if (repo) {
    const [name, email] = await Promise.all([read('--local', 'user.name'), read('--local', 'user.email')])
    if (name || email) {
      const [gName, gEmail] = await Promise.all([read('--global', 'user.name'), read('--global', 'user.email')])
      return { name: name || gName, email: email || gEmail, scope: 'local' }
    }
  }
  const [name, email] = await Promise.all([read('--global', 'user.name'), read('--global', 'user.email')])
  return { name, email, scope: name || email ? 'global' : 'none' }
}

export async function setIdentity(repo: string | null, id: { name: string; email: string }): Promise<void> {
  const scope = repo ? '--local' : '--global'
  const cwd = repo ?? process.cwd()
  await git(cwd, ['config', scope, 'user.name', id.name])
  await git(cwd, ['config', scope, 'user.email', id.email])
}
