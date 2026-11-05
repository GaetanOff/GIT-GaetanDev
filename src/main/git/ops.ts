import { existsSync } from 'node:fs'
import { appendFile, copyFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { shell } from 'electron'
import { selectionFingerprint, type Author, type DiffOptions, type FileChange, type FileDiff, type LineSelection, type Progress, type PullMode, type ResetMode, type RepoStatus } from '@shared/types'
import { resolveWhole } from './conflict'
import { applyPatch, buildPartialPatch, diff } from './diff'
import { assertRefName, git, gitOut, GitError, literal } from './exec'
import { initSubmodules, type SubmoduleUrlCheck } from './modules'
import { currentBranch, defaultRemote, remoteOf, upstreamOf } from './refs'
import { gitDir, operation, status } from './status'
import { withPruneJournal } from './recovery'

/* ─── Staging ───────────────────────────────────────────────────────────────── */

/** Paths are passed through stdin so thousands of files never hit the command-line limit. */
const viaStdin = (paths: string[]) => ({ input: paths.join('\0') })

export async function stage(repo: string, paths: string[]): Promise<void> {
  if (!paths.length) return
  await git(repo, ['add', '--all', '--pathspec-from-file=-', '--pathspec-file-nul'], viaStdin(paths))
}

export async function unstage(repo: string, paths: string[]): Promise<void> {
  if (!paths.length) return
  // A staged rename is two index entries: unstaging only the new path left the old one staged as
  // deleted, and a commit then recorded the deletion without the file under its new name.
  const wanted = new Set(paths)
  const renamed = (await status(repo)).files.filter(f => f.index === 'R' && f.oldPath && wanted.has(f.path)).map(f => f.oldPath!)
  paths = [...paths, ...renamed.filter(p => !wanted.has(p))]
  const hasHead = await git(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [1] }).then(r => r.code === 0)
  if (hasHead) await git(repo, ['reset', '-q', 'HEAD', '--pathspec-from-file=-', '--pathspec-file-nul'], viaStdin(paths))
  else await git(repo, ['rm', '--cached', '-r', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], viaStdin(paths))
}

const FULL_CONTEXT: DiffOptions = { context: 3, ignoreWhitespace: false, force: true }

/** Refuses a line operation whose selection no longer points at the lines the user saw. */
function sameSelection(d: FileDiff, selection: LineSelection, expect?: string): void {
  if (expect !== undefined && selectionFingerprint(d, selection) !== expect) {
    throw new GitError('The file changed since its diff was shown. Look at the new diff and select the lines again.')
  }
}

export async function stageLines(repo: string, path: string, selection: LineSelection, untracked: boolean, opts = FULL_CONTEXT, expect?: string): Promise<void> {
  if (untracked) await git(repo, ['add', '--intent-to-add', '--', path])
  try {
    const d = await diff(repo, { kind: 'worktree', path }, { ...opts, ignoreWhitespace: false, force: true })
    sameSelection(d, selection, expect)
    const patch = buildPartialPatch(d, selection, 'forward')
    if (patch) await applyPatch(repo, patch, ['--cached'], d.encoding)
    else if (untracked) await git(repo, ['rm', '--cached', '-q', '--', path])
  } catch (e) {
    // Leave no intent-to-add entry behind: the file is untracked again, as before.
    if (untracked) await git(repo, ['rm', '--cached', '-q', '--', path]).catch(() => undefined)
    throw e
  }
}

export async function unstageLines(repo: string, path: string, selection: LineSelection, opts = FULL_CONTEXT, expect?: string, oldPath?: string): Promise<void> {
  // A staged rename is diffed against its old path, as it was shown; without it the file reads as all new.
  const d = await diff(repo, { kind: 'index', path, oldPath }, { ...opts, ignoreWhitespace: false, force: true })
  sameSelection(d, selection, expect)
  const patch = buildPartialPatch(d, selection, 'reverse')
  if (patch) await applyPatch(repo, patch, ['--cached', '--reverse'], d.encoding)
}

export async function discardLines(repo: string, path: string, selection: LineSelection, opts = FULL_CONTEXT, expect?: string): Promise<void> {
  const d = await diff(repo, { kind: 'worktree', path }, { ...opts, ignoreWhitespace: false, force: true })
  sameSelection(d, selection, expect)
  const patch = buildPartialPatch(d, selection, 'reverse')
  if (!patch) return
  // The file stays in place, so a copy of it goes to the recycle bin.
  const dir = join(tmpdir(), 'GaetanDev discarded lines', String(Date.now()))
  await mkdir(dir, { recursive: true })
  const copy = join(dir, basename(path))
  await copyFile(join(repo, path), copy)
  await shell.trashItem(copy)
  await applyPatch(repo, patch, ['--reverse'], d.encoding)
}

/**
 * Drops every local change (staged and unstaged) to the given files. Nothing
 * is lost for good: the current version of each file goes to the recycle bin,
 * and so does its staged version when that is another one.
 */
export async function discard(repo: string, paths: string[]): Promise<void> {
  const st = await status(repo)
  // A file removed from the index but still on disk ("git rm --cached") is listed twice, as a staged
  // deletion and as untracked: undoing the deletion is what brings it back to HEAD's version.
  const byPath = new Map<string, FileChange>()
  for (const f of st.files) if (!byPath.get(f.path) || byPath.get(f.path)!.untracked) byPath.set(f.path, f)
  const created: string[] = []
  const tracked: string[] = []
  for (const p of paths) {
    const f = byPath.get(p)
    if (!f) continue
    // "git add -N" entries (worktree "A") have no committed content either.
    if (f.untracked || f.index === 'A' || f.index === 'R' || f.index === 'C' || f.worktree === 'A' || !st.hasCommits) created.push(p)
    else tracked.push(p)
    // A rename is undone by restoring the original file as well.
    if (f.oldPath && f.index === 'R') tracked.push(f.oldPath)
  }
  // The versions being dropped are copied aside first, then HEAD's comes back, then the copies go to the
  // recycle bin (the GitHub Desktop way). Copied rather than moved: if the restore fails (index.lock
  // held elsewhere), every file is still where it was instead of only in the recycle bin.
  const restore: string[] = []
  const failed: string[] = []
  const copies: string[] = []
  const aside = join(tmpdir(), 'GaetanDev discarded', String(Date.now()))
  // A new or renamed file staged, then changed again (AM, RM, AD), or any file before the first
  // commit: its staged version is neither HEAD's nor the file's, and leaves with the index entry.
  for (const [i, p] of created.entries()) {
    const f = byPath.get(p)
    if (!f || f.untracked || f.conflicted || f.index === '.' || f.worktree === '.') continue
    try {
      const dir = join(aside, `new-${i}`)
      await mkdir(dir, { recursive: true })
      const stagedCopy = join(dir, `${basename(p)} (staged)`)
      await writeFile(stagedCopy, (await git(repo, ['show', `:${p}`])).raw)
      copies.push(stagedCopy)
    } catch {
      failed.push(p)
    }
  }
  for (const [i, p] of tracked.entries()) {
    // Only regular files: a deleted file has nothing to keep, a submodule is a whole checkout.
    const isFile = await lstat(join(repo, p)).then(s => s.isFile(), () => false)
    if (!isFile) {
      restore.push(p)
      continue
    }
    try {
      const dir = join(aside, String(i)) // one folder per file: two files may share a name
      await mkdir(dir, { recursive: true })
      await copyFile(join(repo, p), join(dir, basename(p)))
      copies.push(join(dir, basename(p)))
      // A staged version that is neither HEAD's nor the file's would be lost too.
      const f = byPath.get(p)
      // A conflicted file has no staged version (only its sides, which the merge keeps): its copy is enough.
      if (f && !f.conflicted && f.index !== '.' && f.worktree !== '.') {
        const stagedCopy = join(dir, `${basename(p)} (staged)`)
        await writeFile(stagedCopy, (await git(repo, ['show', `:${p}`])).raw)
        copies.push(stagedCopy)
      }
      restore.push(p)
    } catch {
      failed.push(p)
    }
  }
  if (restore.length) await git(repo, ['restore', '--source=HEAD', '--staged', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], viaStdin(restore))
  const binned: string[] = []
  for (const c of copies) await shell.trashItem(c).catch(() => binned.push(c))
  const dropped = created.filter(p => !failed.includes(p))
  const staged = dropped.filter(p => !byPath.get(p)?.untracked)
  // -f: without it git refuses an entry whose staged content differs from both HEAD and the file,
  // and it would do so after the restore above, leaving a rename half undone. Its copy is kept.
  if (staged.length) await git(repo, ['rm', '--cached', '-f', '-q', '-r', '--pathspec-from-file=-', '--pathspec-file-nul'], viaStdin(staged))
  for (const p of dropped) await shell.trashItem(join(repo, p)).catch(() => undefined)
  if (failed.length) throw new GitError(`Could not keep a copy of ${failed.length === 1 ? failed[0] : `${failed.length} files`}, so ${failed.length === 1 ? 'it was' : 'they were'} left as is.`)
  if (binned.length) throw new GitError(`The changes were discarded, but the recycle bin refused the copies: they are in "${aside}".`)
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
  // whitespace, not strip: the message comes from the app, and a line like "#123 fix login" is content.
  const args = ['commit', '-F', '-', '--cleanup=whitespace']
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
  // --git-path follows core.hooksPath and, in a linked worktree, finds the hooks it shares with the
  // main one (the worktree's own git folder has none).
  const dir = (await gitOut(repo, ['rev-parse', '--git-path', 'hooks'])).trim()
  const abs = isAbsolute(dir) ? dir : join(repo, dir)
  return ['pre-commit', 'commit-msg', 'prepare-commit-msg'].some(h => existsSync(join(abs, h)))
}

/** People who committed here, most active first: suggestions for co-authors. */
export async function authors(repo: string): Promise<Author[]> {
  // shortlog walks the whole history: reuse the answer while HEAD has not moved, for ten minutes.
  const head = (await git(repo, ['rev-parse', '-q', '--verify', 'HEAD'], { okCodes: [1] })).stdout.trim()
  const cached = authorsCache.get(repo)
  if (cached && cached.head === head && Date.now() - cached.at < 10 * 60_000) return cached.list
  const out = (await git(repo, ['shortlog', '-sne', '--all', 'HEAD'], { okCodes: [128] })).stdout
  const list = out.split('\n').map(l => /^\s*(\d+)\s+(.+?) <([^>]+)>$/.exec(l)).filter(m => !!m)
    .map(m => ({ commits: +m![1], name: m![2], email: m![3] })).slice(0, 300)
  authorsCache.set(repo, { head, at: Date.now(), list })
  return list
}

const authorsCache = new Map<string, { head: string; at: number; list: Author[] }>()

/** The commit.template file, without its comment lines, and whether commits get signed. */
export async function commitSetup(repo: string): Promise<{ template: string; signing: boolean }> {
  const read = (key: string, type?: string) => git(repo, ['config', ...(type ? [`--type=${type}`] : []), '--get', key], { okCodes: [1, 128] }).then(r => r.stdout.trim())
  // As a boolean: git also takes yes, on and 1, which a comparison with "true" read as off.
  const [templatePath, gpgsign] = await Promise.all([read('commit.template'), read('commit.gpgsign', 'bool')])
  let template = ''
  if (templatePath) {
    const file = templatePath.replace(/^~(?=[\\/])/, homedir())
    const text = await readFile(isAbsolute(file) ? file : join(repo, file), 'utf8').catch(() => '')
    template = text.split(/\r?\n/).filter(l => !l.startsWith('#')).join('\n').trim()
  }
  return { template, signing: gpgsign === 'true' }
}

/**
 * The message git prepared for an in-progress merge, squash or cherry-pick,
 * without the comments git added at its end ("# Conflicts: …"). Only that
 * trailing block goes, in git's comment character: dropping every line that
 * starts with "#" turned the cherry-pick of "#42 Fix login" into "Details
 * here", and a core.commentChar of ";" left git's own comments in.
 */
export async function preparedMessage(repo: string): Promise<string> {
  const dir = await gitDir(repo)
  for (const f of ['MERGE_MSG', 'SQUASH_MSG']) {
    const text = await readFile(join(dir, f), 'utf8').catch(() => '')
    if (!text) continue
    const lines = text.split(/\r?\n/)
    const configured = (await git(repo, ['config', '--get', 'core.commentChar'], { okCodes: [1] })).stdout.trim()
    const last = [...lines].reverse().find(l => l.trim())
    // "auto": git picked a character no line starts with; its own comments come last.
    const mark = configured && configured !== 'auto' ? configured : configured === 'auto' && last && '#;@!$%^&|:'.includes(last[0]) ? last[0] : '#'
    // git's own comment lines are the mark alone or followed by a space or a tab ("# Conflicts:",
    // "#\tf.txt"): "#42 Fix login", a subject with no body, went with them, and the prefill was empty.
    const comment = (l: string) => l.startsWith(mark) && [undefined, ' ', '\t'].includes(l[mark.length])
    while (lines.length && (!lines[lines.length - 1].trim() || comment(lines[lines.length - 1]))) lines.pop()
    return lines.join('\n').trim()
  }
  return ''
}

export async function lastCommitMessage(repo: string): Promise<string> {
  return (await gitOut(repo, ['log', '-1', '--format=%B'])).trim()
}

/**
 * Takes back the last commit and keeps its changes staged; returns its message
 * and whether it was an amend. With `expect`, only that commit is undone: a
 * toast's Undo must not take back a commit made after it.
 * - An amend goes back to the commit it replaced: going to that commit's
 *   parent took it back too.
 * - A merge becomes the merge in progress it was. The reset alone kept its
 *   changes staged without MERGE_HEAD, and committing them again made an
 *   ordinary commit, a squash of the merged branch.
 */
export async function undoCommit(repo: string, expect?: string): Promise<{ message: string; amended: boolean }> {
  const dir = await gitDir(repo)
  const busy = operation(dir).operation
  if (busy) throw new GitError(`A ${busy} is in progress. Continue or abort it first.`)
  const head = (await git(repo, ['rev-parse', '-q', '--verify', 'HEAD'], { okCodes: [1] })).stdout.trim()
  if (expect && head !== expect) throw new GitError('That commit is no longer the last one on this branch, so it was not undone.')
  const message = await lastCommitMessage(repo)
  const [last, before] = (await git(repo, ['reflog', 'show', '-n2', '--format=%H%x1f%gs', 'HEAD', '--'], { okCodes: [128] })).stdout
    .split('\n').filter(Boolean).map(l => l.split('\x1f'))
  if (last?.[0] === head && last[1].startsWith('commit (amend):') && before?.[0]) {
    await git(repo, ['reset', '--soft', before[0]])
    return { message, amended: true }
  }
  const parents = (await gitOut(repo, ['rev-parse', 'HEAD^@'])).split('\n').filter(Boolean)
  // Staged since the merge, changes would become part of the merge in progress: aborting it, as
  // the toast offers, ran "reset --merge" and deleted them for good, and committing it took them in.
  if (parents.length > 1 && (await git(repo, ['diff-index', '--cached', '--quiet', 'HEAD', '--'], { okCodes: [1] })).code === 1) {
    throw new GitError('Changes are staged since this merge, so it was not undone: put back in progress, the merge would take them in, and aborting it would delete them. Commit or unstage them first.')
  }
  if (parents.length) {
    await git(repo, ['reset', '--soft', 'HEAD~1'])
    if (parents.length > 1) {
      // As git leaves a merge stopped before its commit; "no-ff" keeps both parents when it is made.
      await writeFile(join(dir, 'MERGE_HEAD'), parents.slice(1).map(p => `${p}\n`).join(''))
      await writeFile(join(dir, 'MERGE_MSG'), `${message}\n`)
      await writeFile(join(dir, 'MERGE_MODE'), 'no-ff')
    }
    return { message, amended: false }
  }
  // The oldest commit of a shallow clone: its parent exists, only not here. Taken for the first
  // commit, its branch was deleted, and the next commit began a history unrelated to the remote's.
  const raw = await gitOut(repo, ['cat-file', 'commit', 'HEAD'])
  if (/^parent /m.test(raw.slice(0, raw.indexOf('\n\n')))) {
    throw new GitError('The commit before this one was not downloaded (a shallow clone), so this commit cannot be undone here. Fetch the full history first.')
  }
  // The first commit: its branch goes back to unborn. Never `update-ref -d HEAD`, which on a
  // detached HEAD deletes .git/HEAD itself and leaves a folder git no longer sees as a repository.
  const branch = (await git(repo, ['symbolic-ref', '-q', 'HEAD'], { okCodes: [1] })).stdout.trim()
  if (!branch) throw new GitError('This is the first commit and no branch is checked out, so there is nothing to undo it into.')
  await git(repo, ['update-ref', '-d', branch])
  return { message, amended: false }
}

/**
 * Takes one side of a conflicted file whole, from the file list. The same as
 * the conflict view's pick: "checkout --theirs" did nothing to a submodule,
 * and the "add" after it recorded the commit it had checked out, ours.
 */
export async function resolve(repo: string, path: string, side: 'ours' | 'theirs'): Promise<void> {
  await resolveWhole(repo, path, side)
}

/** Commands that keep going without opening an editor. */
const NO_EDITOR = { env: { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' } }

async function currentOp(repo: string): Promise<RepoStatus['operation']> {
  return (await status(repo)).operation
}

/**
 * Goes on with the operation in progress. With `message`, the one written in
 * the commit box, a merge, cherry-pick or revert is committed with it: "Commit
 * merge" used git's prepared message and ignored the one corrected there. A
 * cherry-pick or revert of several commits then goes on with the next ones.
 */
export async function continueOp(repo: string, message?: string): Promise<void> {
  const op = await currentOp(repo)
  if (!op) return
  if (message?.trim() && (op === 'merge' || op === 'cherry-pick' || op === 'revert')) {
    // The commit of a picked or reverted commit keeps its author, read by git from CHERRY_PICK_HEAD.
    const pending = (await git(repo, ['rev-parse', '-q', '--verify', op === 'merge' ? 'MERGE_HEAD' : op === 'revert' ? 'REVERT_HEAD' : 'CHERRY_PICK_HEAD'], { okCodes: [1] })).code === 0
    if (pending) await git(repo, ['commit', '-F', '-', '--cleanup=whitespace'], { ...NO_EDITOR, input: message })
    if (op !== 'merge' && (await currentOp(repo)) === op) await git(repo, [op, '--continue'], NO_EDITOR)
    return
  }
  if (op === 'merge') await git(repo, ['commit', '--no-edit'], NO_EDITOR)
  else await git(repo, [op, '--continue'], NO_EDITOR)
}

export async function abortOp(repo: string): Promise<void> {
  const op = await currentOp(repo)
  if (op) await git(repo, [op, '--abort'])
}

export async function skipOp(repo: string): Promise<void> {
  const op = await currentOp(repo)
  if (op === 'rebase' && (await skipRefusedMessage(repo))) return
  if (op && op !== 'merge') await git(repo, [op, '--skip'], NO_EDITOR)
}

/**
 * Skips the step of an Edit history that applies a new message, when a
 * commit-msg hook refused it. The rebase puts that step back to run again
 * (--reschedule-failed-exec), so Continue and Skip both ran it again, and a
 * hook that always refuses left Abort, which throws away the whole plan, as
 * the only way out. Skipped, the commit keeps the message it had.
 */
async function skipRefusedMessage(repo: string): Promise<boolean> {
  const dir = join(await gitDir(repo), 'rebase-merge')
  const lines = async (name: string) => (await readFile(join(dir, name), 'utf8').catch(() => '')).split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  const [todo, done] = await Promise.all([lines('git-rebase-todo'), lines('done')])
  const failed = done.at(-1)
  // Stopped by that step itself, not on a conflict of a pick with the step next in line.
  if (!failed || todo[0] !== failed || !/^exec git commit --amend --allow-empty --cleanup=whitespace -F .*gdg-rebase[\\/]msg-\d+\.txt'$/.test(failed)) return false
  await writeFile(join(dir, 'git-rebase-todo'), `${todo.slice(1).join('\n')}\n`)
  await git(repo, ['rebase', '--continue'], NO_EDITOR)
  return true
}

/**
 * Oldest first, so several picked commits land in their original order. Rebased commits
 * often share the same second, so ancestry decides and the date only orders commits on
 * separate lines: that is `rev-list --date-order`, walked once from the picked commits back
 * to where they meet (pairwise ancestry checks took up to ~1,600 git processes for 40).
 */
async function chronological(repo: string, shas: string[]): Promise<string[]> {
  if (shas.length < 2) return shas
  const base = (await git(repo, ['merge-base', '--octopus', ...shas], { okCodes: [1] })).stdout.trim()
  // Down to the meeting point itself, which can be one of the picked commits; unrelated histories: to the roots.
  const walk = (await gitOut(repo, ['rev-list', '--date-order', '--reverse', ...shas, ...(base ? [`^${base}^@`] : [])])).split('\n')
  const wanted = new Set(shas)
  const ordered = walk.filter(s => wanted.has(s))
  return [...ordered, ...shas.filter(s => !ordered.includes(s))]
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
  if (!opts.stash) return switchTo(repo, branch)
  const top = () => git(repo, ['rev-parse', '-q', '--verify', 'refs/stash'], { okCodes: [1] }).then(r => r.stdout.trim())
  const label = `Auto-stash before switching to ${branch}`
  // Where HEAD is: the branch it names, else its commit.
  const where = () => git(repo, ['symbolic-ref', '-q', 'HEAD'], { okCodes: [1] })
    .then(r => r.stdout.trim() || git(repo, ['rev-parse', '-q', '--verify', 'HEAD'], { okCodes: [1] }).then(c => c.stdout.trim()))
    .catch(() => '')
  const start = await where()
  const before = await top()
  await git(repo, ['stash', 'push', '--include-untracked', '-m', label])
  const stashed = (await top()) !== before
  try {
    await switchTo(repo, branch)
  } catch (e) {
    // A post-checkout hook (Git LFS's, without git-lfs on PATH) can fail once the switch is done:
    // the changes then stay in the stash, instead of being popped onto the other branch.
    if ((await where()) !== start) {
      if (e instanceof GitError) e.message = `Switched to ${branch}, but git then reported: ${e.message}${stashed ? `\nYour changes are kept in the stash “${label}”.` : ''}`
      throw e
    }
    // Still on the old branch: put the changes back where they were, so nothing seems lost.
    if (stashed) await git(repo, ['stash', 'pop', '--index']).catch(() => git(repo, ['stash', 'pop'])).catch(() => undefined)
    throw e
  }
}

async function switchTo(repo: string, branch: string): Promise<void> {
  // A remote branch ("origin/feature") gets a local tracking branch.
  const isLocal = await git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { okCodes: [1] }).then(r => r.code === 0)
  if (isLocal) return void (await git(repo, ['switch', branch]))
  const isRemote = await git(repo, ['rev-parse', '--verify', '-q', `refs/remotes/${branch}`], { okCodes: [1] }).then(r => r.code === 0)
  if (isRemote) {
    // "team/upstream/main" is main on the remote "team/upstream", not upstream/main on "team".
    const remotes = (await gitOut(repo, ['remote'])).split('\n').map(r => r.trim()).filter(Boolean)
    const local = branch.slice(remoteOf(branch, remotes).length + 1)
    const exists = await git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${local}`], { okCodes: [1] }).then(r => r.code === 0)
    if (exists) await git(repo, ['switch', local])
    else await git(repo, ['switch', '-c', local, '--track', `refs/remotes/${branch}`])
    return
  }
  await git(repo, ['switch', branch])
}

export async function checkoutCommit(repo: string, sha: string): Promise<void> {
  await git(repo, ['switch', '--detach', sha])
}

export async function createBranch(repo: string, name: string, from: string | null, doCheckout: boolean): Promise<void> {
  await assertRefName(repo, 'branch', name)
  if (doCheckout) await git(repo, ['switch', '-c', name, ...(from ? [from] : []), '--no-track'])
  else await git(repo, ['branch', '--no-track', name, ...(from ? [from] : [])])
}

/**
 * Renames a local branch. One that tracked a remote branch of its old name
 * stops tracking it: git refuses to push it there ("the upstream branch of
 * your current branch does not match the name"), and the next push publishes
 * it under its new name instead. The remote branch is left as it is.
 */
export async function renameBranch(repo: string, from: string, to: string): Promise<void> {
  await assertRefName(repo, 'branch', to)
  const upstream = await upstreamOf(repo, from)
  await git(repo, ['branch', '-m', from, to])
  if (upstream && upstream.endsWith(`/${from}`) && from !== to) await git(repo, ['branch', '--unset-upstream', to])
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
  await assertRefName(repo, 'tag', name)
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
  // stash runs without the literal pathspec mode (see exec): mark each path literal itself.
  if (paths?.length) args.push('--', ...paths.map(literal))
  await git(repo, args)
}

/**
 * Stash entries are addressed by index, which shifts whenever a stash is
 * added or dropped (an auto-stash, another tool): with the sha the user saw,
 * an entry that moved is refused rather than the wrong one applied or dropped.
 */
async function checkStash(repo: string, index: number, sha?: string): Promise<void> {
  if (!sha) return
  const at = (await git(repo, ['rev-parse', '-q', '--verify', `stash@{${index}}`], { okCodes: [1, 128] })).stdout.trim()
  if (at !== sha) throw new GitError('The stash list changed since it was shown. Look at it again and retry.')
}

export async function stashApply(repo: string, index: number, pop: boolean, sha?: string): Promise<void> {
  await checkStash(repo, index, sha)
  await git(repo, ['stash', pop ? 'pop' : 'apply', '--index', `stash@{${index}}`]).catch(async e => {
    // --index fails up front when the staged state cannot be restored: then a plain apply is the way.
    // Other failures are not about the index. An untracked file in the way stops git after the changes
    // are back: applying again would bury that under "your local changes would be overwritten".
    if (e instanceof GitError && /conflicts in index/i.test(`${e.message}\n${e.stderr}`)) return git(repo, ['stash', pop ? 'pop' : 'apply', `stash@{${index}}`])
    if (e instanceof GitError && /could not restore untracked files/i.test(e.message)) {
      const inTheWay = [...e.stderr.matchAll(/^(.+) already exists, no checkout\r?$/gm)].map(m => m[1])
      e.message = `The changes are back, but untracked files of the stash are in the way${inTheWay.length ? `: ${inTheWay.join(', ')}` : ''}. The stash is kept.`
    }
    throw e
  })
}

export async function stashDrop(repo: string, index: number, sha?: string): Promise<void> {
  await checkStash(repo, index, sha)
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

/**
 * Fetches every remote. Unless the repository says otherwise, git also
 * writes its commit-graph file: without one (a fresh clone), the history's
 * --topo-order walked the whole history for every page loaded.
 */
export async function fetchAll(repo: string, report: Reporter): Promise<void> {
  const setByUser = (await git(repo, ['config', '--get', 'fetch.writeCommitGraph'], { okCodes: [1] })).code === 0
  const graph = setByUser ? [] : ['-c', 'fetch.writeCommitGraph=true']
  try {
    await withPruneJournal(repo, () => git(repo, [...graph, 'fetch', '--all', '--prune', '--progress'], { onStderrLine: progressHandler('fetch', 'Fetching', report) }))
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
    await keepingIndex(repo, 'Changes set aside by GaetanDev Git before a pull', autostash =>
      withPruneJournal(repo, () => git(repo, ['pull', flag, autostash ? '--autostash' : '--no-autostash', '--progress'], { ...NO_EDITOR, onStderrLine: progressHandler('pull', 'Pulling', report) })))
  } finally {
    report(null)
  }
}

/**
 * Runs an operation that needs a clean working tree (a pull, a rebase) and
 * gives the changes back as they were. Git's --autostash re-applies them
 * without --index: everything staged, lines picked one by one included,
 * came back unstaged. With staged changes the app stashes them itself and
 * restores them with the index; without, git's --autostash does (`run`
 * receives which). An operation that stops on a conflict leaves the stash
 * for later, and says so. Never during a merge, cherry-pick, revert or
 * rebase: stashing its resolved files ended it (MERGE_HEAD gone), and the
 * next commit recorded no merge.
 */
export async function keepingIndex<T>(repo: string, label: string, run: (autostash: boolean) => Promise<T>): Promise<T> {
  const busy = operation(await gitDir(repo)).operation
  if (busy) throw new GitError(`A ${busy} is in progress. Continue or abort it first.`)
  const staged = (await git(repo, ['diff', '--cached', '--quiet'], { okCodes: [1, 128] })).code === 1
  if (!staged) return run(true)
  const top = () => git(repo, ['rev-parse', '-q', '--verify', 'refs/stash'], { okCodes: [1] }).then(r => r.stdout.trim())
  const before = await top()
  await git(repo, ['stash', 'push', '-q', '-m', label])
  const mine = await top()
  if (!mine || mine === before) return run(true)
  let result: T
  try {
    result = await run(false)
  } catch (e) {
    if (await currentOp(repo)) {
      if (e instanceof GitError) e.message += `\nYour uncommitted changes are kept in the stash “${label}”: apply it once this is finished.`
    } else {
      // Nothing started: the changes go back where they were.
      await git(repo, ['stash', 'pop', '-q', '--index']).catch(() => undefined)
    }
    throw e
  }
  if ((await top()) === mine) await stashApply(repo, 0, true, mine)
  return result
}

export async function push(repo: string, opts: { force?: boolean; setUpstream?: boolean }, report: Reporter): Promise<void> {
  const branch = await currentBranch(repo)
  if (!branch) throw new GitError('You are not on a branch (detached HEAD).')
  const upstream = await upstreamOf(repo, branch)
  // "Push" and "Force push" are about this branch: with push.default=matching, git pushed every
  // branch that has a remote counterpart, and a force push rewrote them too.
  const pushDefault = (await git(repo, ['config', '--get', 'push.default'], { okCodes: [1] })).stdout.trim().toLowerCase()
  const args = [...(pushDefault === 'matching' ? ['-c', 'push.default=simple'] : []), 'push', '--progress']
  // The background fetch keeps origin/x current, which alone would satisfy the lease even
  // for commits nobody here has seen: --force-if-includes also requires them to be in HEAD's history.
  if (opts.force) args.push('--force-with-lease', '--force-if-includes')
  if (!upstream) {
    const remote = await defaultRemote(repo)
    if (!remote) throw new GitError('This repository has no remote. Add one in the sidebar first.')
    args.push('--set-upstream', remote, `HEAD:refs/heads/${branch}`)
  } else {
    // A remote's own push refspecs (remote.<name>.push) come before push.default: left to git,
    // `refs/heads/*:refs/heads/*` published every local branch, and a force push rewrote them all.
    // The branch goes where git itself would push it, named, so nothing else goes along. With no
    // single destination (an upstream of another name under "simple"), git's own push says why.
    const format = '--format=%(push:remotename)%00%(push:remoteref)%00%(upstream:remotename)'
    const [remote, ref, upstreamRemote] = (await gitOut(repo, ['for-each-ref', format, `refs/heads/${branch}`])).trim().split('\0')
    if (remote && ref) args.push(remote, `HEAD:${ref}`)
    else {
      // Unless the remote names refs of its own to push that leave this branch out, or mirrors:
      // git then pushed those instead (another branch, every ref, deleting the server's others),
      // said it succeeded, and a force push rewrote them.
      const name = remote || upstreamRemote
      if (name && (await pushesOwnRefs(repo, name))) {
        throw new GitError(`"${name}" is set to push other refs than this branch (remote.${name}.push or remote.${name}.mirror), so nothing was pushed. Push this branch from a terminal, naming where it goes, or change that setting.`)
      }
    }
  }
  try {
    await git(repo, args, { onStderrLine: progressHandler('push', upstream ? 'Pushing' : 'Publishing branch', report) })
  } finally {
    report(null)
  }
}

/** Whether a remote pushes refs of its own (remote.<name>.push) or everything (mirror), whatever is asked. */
async function pushesOwnRefs(repo: string, remote: string): Promise<boolean> {
  if ((await git(repo, ['config', '--get-all', `remote.${remote}.push`], { okCodes: [1] })).stdout.trim()) return true
  return (await git(repo, ['config', '--type=bool', '--get', `remote.${remote}.mirror`], { okCodes: [1] })).stdout.trim() === 'true'
}

/**
 * A remote this repository has. Given anything else, git pushed to it as a
 * URL: a compromised page could publish a tag's whole history anywhere, or
 * name "\\host\share" and send the user's NTLM hash there.
 */
async function assertRemote(repo: string, remote: string): Promise<void> {
  const remotes = (await gitOut(repo, ['remote'])).split('\n').filter(Boolean)
  if (!remotes.includes(remote)) throw new GitError(`"${remote}" is not a remote of this repository.`)
}

export async function pushTag(repo: string, remote: string, name: string, report: Reporter): Promise<void> {
  await assertRemote(repo, remote)
  try {
    await git(repo, ['push', '--progress', remote, `refs/tags/${name}`], { onStderrLine: progressHandler('push', `Pushing tag ${name}`, report) })
  } finally {
    report(null)
  }
}

export async function deleteRemoteBranch(repo: string, remote: string, branch: string, report: Reporter): Promise<void> {
  await assertRemote(repo, remote)
  try {
    // By its full name: a bare one is resolved on the server, where a tag of that name (the branch
    // itself already gone) was deleted instead.
    await withPruneJournal(repo, () => git(repo, ['push', '--progress', remote, '--delete', `refs/heads/${branch}`], { onStderrLine: progressHandler('push', `Deleting ${remote}/${branch}`, report) }))
  } finally {
    report(null)
  }
}

/**
 * Clones into a new folder `parent/name`, then its submodules, whose URLs go
 * through `allowed` first (see initSubmodules); those not allowed are left out.
 * Stopped through `signal`, the folder it was creating is removed: git, ended
 * from outside, leaves it half filled.
 */
export async function clone(url: string, parent: string, name: string, report: Reporter, signal?: AbortSignal, allowed: SubmoduleUrlCheck = async () => true): Promise<void> {
  try {
    await git(parent, ['clone', '--progress', '--', url, name], { onStderrLine: progressHandler('clone', `Cloning ${name}`, report), signal })
    await initSubmodules(join(parent, name), null, report, allowed, signal)
  } catch (e) {
    if (e instanceof GitError && e.code === 'CANCELLED') {
      await rm(join(parent, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
      throw new GitError('Clone cancelled: nothing was kept.', 'CANCELLED')
    }
    throw e
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

/**
 * The identity commits get. In a repository, the one git itself resolves:
 * every config file with its include and includeIf (a work identity for
 * repositories under ~/work, say), then GIT_AUTHOR_NAME/EMAIL. Reading only
 * the local and global values showed "Personal <me@home>" for commits made as
 * "Work <me@work>", and blocked committing when the identity came only from
 * an include. `scope` is "local" when the repository sets one of its own.
 */
export async function identity(repo: string | null): Promise<{ name: string; email: string; scope: 'local' | 'global' | 'none' }> {
  const cwd = repo ?? homedir()
  const read = async (key: string) => {
    const r = await git(cwd, ['config', ...(repo ? ['--show-scope'] : ['--global', '--includes']), '--get', key], { okCodes: [1] })
    const out = r.stdout.trim()
    if (!repo) return { value: out, local: false }
    const [scope, ...value] = out.split('\t')
    return { value: value.join('\t'), local: scope === 'local' || scope === 'worktree' }
  }
  const [n, e] = await Promise.all([read('user.name'), read('user.email')])
  let name = n.value
  let email = e.value
  if (repo) {
    // What a commit would really use, environment included; fails when git knows no identity.
    const ident = await git(repo, ['var', 'GIT_AUTHOR_IDENT'], { okCodes: [128] })
    const m = /^(.*) <(.*)> \d+ [+-]\d{4}$/.exec(ident.stdout.trim())
    if (ident.code === 0 && m) [name, email] = [m[1], m[2]]
  }
  const scope = n.local || e.local ? 'local' : name || email ? 'global' : 'none'
  return { name, email, scope }
}

/**
 * Sets the repository's own identity, or the global one. Null, or a field
 * left empty, removes it instead: unticking "a different identity for this
 * repository" wrote the global one only, the local one stayed in use (and
 * the box came back ticked), and empty fields wrote `user.name ""`, which
 * every commit then refused.
 */
export async function setIdentity(repo: string | null, id: { name: string; email: string } | null): Promise<void> {
  const scope = repo ? '--local' : '--global'
  const cwd = repo ?? homedir()
  for (const [key, value] of [['user.name', id?.name.trim()], ['user.email', id?.email.trim()]] as const) {
    // Exit 5: the key was not set, nothing to remove.
    if (value) await git(cwd, ['config', scope, key, value])
    else await git(cwd, ['config', scope, '--unset-all', key], { okCodes: [5] })
  }
}
