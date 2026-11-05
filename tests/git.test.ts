import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { selectionFingerprint } from '@shared/types'
import { conflictSides } from '../src/renderer/src/lib/sides'
import { cleanup, commit, makeRepo, sh, write } from './helpers'

/** The recycle bin, in tests: a file "moved to the trash" is renamed next to itself. */
const trashed: string[] = []
/** What the last file of that name sent to the recycle bin held. */
const binned = (name: string) => readFileSync(`${trashed.filter(p => basename(p) === name).at(-1)}.trashed`, 'utf8')
vi.mock('electron', () => ({
  shell: {
    trashItem: async (path: string) => {
      renameSync(path, `${path}.trashed`)
      trashed.push(path)
    },
  },
}))

const ops = await import('../src/main/git/ops')
const { indexRefreshDue, isRepo, refreshIndex, status } = await import('../src/main/git/status')
const { diff, parseDiff } = await import('../src/main/git/diff')
const { conflict, resolveContent, resolveWhole } = await import('../src/main/git/conflict')
const { refs, upstreamOf } = await import('../src/main/git/refs')
const { compare } = await import('../src/main/git/compare')
const { log } = await import('../src/main/git/log')
const { blame, fileLog, parseFileLog, unquote } = await import('../src/main/git/blame')
const { rebasePlan, rebaseRun } = await import('../src/main/git/rebase')
const { operations, restore } = await import('../src/main/git/reflog')
const { newerTips } = await import('../src/main/git/recovery')
const { fsmonitorInfo, setFsmonitor } = await import('../src/main/git/perf')
const { git, assertRefName, gitVersion, killRunning, readGitVersion, setGitEnv, stallGuards, windowsOpenSsh } = await import('../src/main/git/exec')
const { classify } = await import('../src/main/askpass')
const { ignoreLiteral } = await import('../src/renderer/src/lib/gitignore')

afterAll(cleanup)

const OPTS = { context: 3, ignoreWhitespace: false }
/** Paths with changes (porcelain lines keep their leading space, so no trimming). */
const changed = (repo: string) =>
  execFileSync('git', ['-C', repo, 'status', '--porcelain', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean).map(l => l.slice(3))

describe('discard', () => {
  it('treats "[" and "]" in a file name literally', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'foo1.txt': 'a\n', 'foo[1].txt': 'b\n' })
    write(repo, 'foo1.txt', 'kept\n')
    write(repo, 'foo[1].txt', 'dropped\n')
    await ops.discard(repo, ['foo[1].txt'])
    expect(readFileSync(join(repo, 'foo1.txt'), 'utf8')).toBe('kept\n')
    expect(readFileSync(join(repo, 'foo[1].txt'), 'utf8')).toBe('b\n')
  })

  it('sends the changed version of a tracked file to the recycle bin', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'old\n' })
    write(repo, 'a.txt', 'work in progress\n')
    await ops.discard(repo, ['a.txt'])
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('old\n')
    expect(binned('a.txt')).toBe('work in progress\n')
  })

  it('sends a staged version that differs from the file to the recycle bin too', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'old\n' })
    write(repo, 'a.txt', 'staged\n')
    sh(repo, 'add', 'a.txt')
    write(repo, 'a.txt', 'staged, then edited\n')
    await ops.discard(repo, ['a.txt'])
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('old\n')
    expect(binned('a.txt')).toBe('staged, then edited\n')
    expect(binned('a.txt (staged)')).toBe('staged\n')
  })

  it('leaves the files in place when the restore fails', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'old\n' })
    write(repo, 'a.txt', 'work in progress\n')
    writeFileSync(join(repo, '.git', 'index.lock'), '')
    await expect(ops.discard(repo, ['a.txt'])).rejects.toThrow(/index.lock/)
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('work in progress\n')
  })

  it('keeps an "add -N" file in the recycle bin instead of deleting it', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'a\n' })
    write(repo, 'new.txt', 'never committed\n')
    sh(repo, 'add', '-N', 'new.txt')
    await ops.discard(repo, ['new.txt'])
    expect(existsSync(join(repo, 'new.txt'))).toBe(false)
    expect(readFileSync(join(repo, 'new.txt.trashed'), 'utf8')).toBe('never committed\n')
    expect(sh(repo, 'ls-files')).toBe('a.txt')
  })

  it('discards a new file staged then changed, keeping both versions', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'a\n' })
    write(repo, 'new.txt', 'staged\n')
    sh(repo, 'add', 'new.txt')
    write(repo, 'new.txt', 'staged, then edited\n')
    await ops.discard(repo, ['new.txt'])
    expect(changed(repo).filter(p => !p.endsWith('.trashed'))).toEqual([])
    expect(binned('new.txt (staged)')).toBe('staged\n')
    expect(readFileSync(join(repo, 'new.txt.trashed'), 'utf8')).toBe('staged, then edited\n')
  })

  it('undoes a renamed file changed after the rename in full', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'old.txt': '1\n2\n3\n' })
    sh(repo, 'mv', 'old.txt', 'new.txt')
    write(repo, 'new.txt', '1\n2\n3\n4\n')
    await ops.discard(repo, ['new.txt'])
    expect(changed(repo).filter(p => !p.endsWith('.trashed'))).toEqual([])
    expect(readFileSync(join(repo, 'old.txt'), 'utf8')).toBe('1\n2\n3\n')
  })

  it('discards a changed file of a repository with no commit yet', async () => {
    const repo = makeRepo()
    write(repo, 'a.txt', 'staged\n')
    sh(repo, 'add', 'a.txt')
    write(repo, 'a.txt', 'edited\n')
    await ops.discard(repo, ['a.txt'])
    expect(sh(repo, 'ls-files')).toBe('')
    expect(existsSync(join(repo, 'a.txt'))).toBe(false)
  })

  it('discards a conflicted file back to our version, keeping the file with its markers', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'base\n' })
    sh(repo, 'checkout', '-q', '-b', 'other')
    commit(repo, 'theirs', { 'a.txt': 'theirs\n' })
    sh(repo, 'checkout', '-q', 'main')
    commit(repo, 'ours', { 'a.txt': 'ours\n' })
    await git(repo, ['merge', 'other'], { okCodes: [1] })
    await ops.discard(repo, ['a.txt'])
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('ours\n')
    expect((await status(repo)).files.filter(f => f.conflicted)).toEqual([])
    expect(binned('a.txt')).toMatch(/^<<<<<<< /m)
  })

  it('brings back a file whose deletion was staged while it stays on disk', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'a\n' })
    sh(repo, 'rm', '--cached', '-q', 'a.txt')
    write(repo, 'a.txt', 'changed\n')
    await ops.discard(repo, ['a.txt'])
    expect(changed(repo)).toEqual([])
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('a\n')
    expect(binned('a.txt')).toBe('changed\n')
  })
})

describe('ignore', () => {
  it('ignores the file named, not others its name reads as a pattern', async () => {
    const repo = makeRepo()
    commit(repo, 'base')
    // check-ignore reads paths, existing or not: "a*b.txt" cannot exist on Windows, a commit made elsewhere can hold it.
    for (const name of ['data[1].csv', '#notes.md', 'a*b.txt']) await ops.ignore(repo, `/${ignoreLiteral(name)}`)
    const ignored = (name: string) => execFileSync('git', ['-C', repo, 'check-ignore', '-q', '--no-index', name]) && true
    for (const name of ['data[1].csv', '#notes.md', 'a*b.txt']) expect(() => ignored(name), name).not.toThrow()
    for (const name of ['data1.csv', 'axb.txt']) expect(() => ignored(name), name).toThrow()
  })
})

describe('stash', () => {
  it('stashes and restores untracked files despite literal pathspecs', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'a\n' })
    write(repo, 'a.txt', 'changed\n')
    write(repo, 'u.txt', 'untracked\n')
    await ops.stash(repo, 'all', true)
    expect(changed(repo)).toEqual([])
    await ops.stashApply(repo, 0, true)
    expect(changed(repo).sort()).toEqual(['a.txt', 'u.txt'])
  })

  it('puts auto-stashed changes back when the switch fails', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'a\n' })
    write(repo, 'a.txt', 'mine\n')
    await expect(ops.checkout(repo, 'no-such-branch', { stash: true })).rejects.toThrow()
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('mine\n')
    expect(sh(repo, 'stash', 'list')).toBe('')
  })

  it('keeps auto-stashed changes stashed when the switch is done but a hook fails', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'base\n' })
    sh(repo, 'checkout', '-q', '-b', 'other')
    commit(repo, 'other', { 'a.txt': 'other\n' })
    sh(repo, 'checkout', '-q', 'main')
    write(repo, 'a.txt', 'mine\n')
    writeFileSync(join(repo, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\nexit 2\n', { mode: 0o755 })
    await expect(ops.checkout(repo, 'other', { stash: true })).rejects.toThrow(/Switched to other/)
    // Not popped onto the other branch, where it conflicted.
    expect(sh(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('other')
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('other\n')
    expect(sh(repo, 'stash', 'list')).toMatch(/Auto-stash before switching to other/)
  })

  it('refuses an entry that moved since it was shown', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'a\n' })
    write(repo, 'a.txt', 'one\n')
    await ops.stash(repo, 'one', false)
    await expect(ops.stashDrop(repo, 0, 'f'.repeat(40))).rejects.toThrow(/stash list changed/)
  })

  // The tracked changes are already back when the untracked file is refused: applying again only adds a misleading error.
  it('reports an untracked file in the way instead of applying the stash a second time', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': '1\n' })
    write(repo, 'a.txt', '2\n')
    write(repo, 'u.txt', 'u\n')
    sh(repo, 'stash', 'push', '-q', '-u')
    write(repo, 'u.txt', 'other\n')
    const err = await ops.stashApply(repo, 0, true).then(() => null, (e: Error) => e)
    expect(err?.message).toBe('The changes are back, but untracked files of the stash are in the way: u.txt. The stash is kept.')
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('2\n')
    expect(sh(repo, 'stash', 'list')).not.toBe('')
  })

  it('still falls back to a plain apply when the staged state cannot be restored', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': '1\n' })
    write(repo, 'a.txt', '2\n')
    sh(repo, 'add', 'a.txt')
    sh(repo, 'stash', 'push', '-q')
    commit(repo, 'moved on', { 'a.txt': '3\n' })
    await expect(ops.stashApply(repo, 0, false)).rejects.toThrow()
    // The plain apply ran: a merge conflict, not "conflicts in index".
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toMatch(/^<<<<<<< /m)
  })
})

describe('commit', () => {
  it('keeps message lines that start with "#"', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'a\n' })
    write(repo, 'a.txt', 'b\n')
    sh(repo, 'add', 'a.txt')
    await ops.commit(repo, '#12 fix login\n\n# not a comment', false)
    expect(sh(repo, 'log', '-1', '--format=%B')).toBe('#12 fix login\n\n# not a comment')
  })

  // Without a body, git's "# Conflicts:" block was stripped together with the subject: the prefill
  // came out empty, and Continue failed on "Aborting commit due to empty commit message".
  it.each(['#42 Fix login\n\nDetails here', '#42 Fix login'])('prefills a cherry-pick message that starts with "#" in full: %j', async message => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'base\n' })
    sh(repo, 'checkout', '-q', '-b', 'topic')
    write(repo, 'a.txt', 'topic\n')
    sh(repo, 'add', 'a.txt')
    sh(repo, 'commit', '-q', '--cleanup=verbatim', '-m', message)
    const pick = sh(repo, 'rev-parse', 'HEAD')
    sh(repo, 'checkout', '-q', 'main')
    commit(repo, 'ours', { 'a.txt': 'ours\n' })
    await expect(ops.cherryPick(repo, [pick])).rejects.toThrow()
    expect(readFileSync(join(repo, '.git', 'MERGE_MSG'), 'utf8')).toMatch(/# Conflicts:/)
    expect(await ops.preparedMessage(repo)).toBe(message)
  })

  it('refuses branch and tag names git would reject or read as options', async () => {
    const repo = makeRepo()
    commit(repo, 'base')
    await expect(assertRefName(repo, 'tag', '--contains')).rejects.toThrow(/not a valid tag name/)
    await expect(assertRefName(repo, 'branch', 'a..b')).rejects.toThrow(/not a valid branch name/)
    await expect(assertRefName(repo, 'branch', 'feature/ok')).resolves.toBeUndefined()
  })

  it('blames a failing hook in a linked worktree too', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'a\n' })
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const wt = join(repo, '..', 'wt')
    sh(repo, 'worktree', 'add', '-q', wt)
    write(wt, 'a.txt', 'changed\n')
    sh(wt, 'add', 'a.txt')
    await expect(ops.commit(wt, 'blocked', false)).rejects.toMatchObject({ code: 'HOOK_FAILED' })
  })

  it('lets a hook use pathspec patterns', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'a\n' })
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\ngit diff --cached --name-only -- "*.js" > .git/seen\n', { mode: 0o755 })
    write(repo, 'y.js', 'y\n')
    await ops.stage(repo, ['y.js'])
    await ops.commit(repo, 'add y', false)
    expect(readFileSync(join(repo, '.git', 'seen'), 'utf8').trim()).toBe('y.js')
  })

  // The job holds git's output open: the commit, and its repository's queue, waited for it to end.
  it('finishes a commit when git does, even with a job a hook left running', async () => {
    const repo = makeRepo()
    commit(repo, 'base')
    const late = join(repo, '.git', 'late')
    writeFileSync(join(repo, '.git', 'hooks', 'post-commit'), '#!/bin/sh\n(sleep 10; echo done > .git/late) &\n', { mode: 0o755 })
    write(repo, 'a.txt', 'a\n')
    await ops.stage(repo, ['a.txt'])
    await ops.commit(repo, 'add a', false)
    expect(existsSync(late)).toBe(false)
    // Ended before the folder is removed.
    await vi.waitFor(() => expect(existsSync(late)).toBe(true), { timeout: 30_000, interval: 250 })
  })

  it('takes a side of a conflict for that file only, whatever its name', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a[1].txt': 'base\n', 'a1.txt': 'base\n' })
    sh(repo, 'checkout', '-q', '-b', 'other')
    commit(repo, 'theirs', { 'a[1].txt': 'theirs\n', 'a1.txt': 'theirs\n' })
    sh(repo, 'checkout', '-q', 'main')
    commit(repo, 'ours', { 'a[1].txt': 'ours\n', 'a1.txt': 'ours\n' })
    await git(repo, ['merge', 'other'], { okCodes: [1] })
    await ops.resolve(repo, 'a[1].txt', 'theirs')
    expect(readFileSync(join(repo, 'a[1].txt'), 'utf8')).toBe('theirs\n')
    expect(readFileSync(join(repo, 'a1.txt'), 'utf8')).toMatch(/^<<<<<<< /m)
  })

  it.each([
    ['merge', ['merge', 'other']],
    // git's "ours" is then the branch rebased onto: "Use my version" kept the upstream file.
    ['rebase', ['rebase', 'main']],
  ])('keeps the user’s own version of a file when a %s stops on it', async (_, command) => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'base\n' })
    sh(repo, 'checkout', '-q', '-b', 'other')
    commit(repo, 'other', { 'a.txt': 'other\n' })
    sh(repo, 'checkout', '-q', 'main')
    commit(repo, 'main', { 'a.txt': 'main\n' })
    // Merging, the user is on main; rebasing, on the branch replayed onto main.
    const mine = command[0] === 'merge' ? 'main\n' : 'other\n'
    if (command[0] === 'rebase') sh(repo, 'checkout', '-q', 'other')
    await git(repo, command, { okCodes: [1] })
    const [own, theirs] = conflictSides((await status(repo)).operation)
    await ops.resolve(repo, 'a.txt', own.side)
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe(mine)
    expect(theirs.side).not.toBe(own.side)
  })

  it('shows the identity a commit really gets, includeIf included', async () => {
    const repo = makeRepo()
    commit(repo, 'base')
    sh(repo, 'config', '--unset', 'user.name')
    sh(repo, 'config', '--unset', 'user.email')
    const dir = join(repo, '..')
    writeFileSync(join(dir, 'work.cfg'), '[user]\n\tname = Work Name\n\temail = me@work\n')
    writeFileSync(join(dir, 'global.cfg'), '[user]\n\tname = Personal\n\temail = me@home\n[includeIf "onbranch:main"]\n\tpath = work.cfg\n')
    const saved = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = join(dir, 'global.cfg')
    try {
      expect(await ops.identity(repo)).toEqual({ name: 'Work Name', email: 'me@work', scope: 'global' })
    } finally {
      if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = saved
    }
    expect((await ops.identity(makeRepo())).scope).toBe('local')
  })

  it('reads git booleans in all their spellings, and turns fsmonitor off over a global one', async () => {
    const repo = makeRepo()
    sh(repo, 'config', 'commit.gpgsign', 'yes')
    expect((await ops.commitSetup(repo)).signing).toBe(true)
    sh(repo, 'config', 'commit.gpgsign', 'off')
    expect((await ops.commitSetup(repo)).signing).toBe(false)
    writeFileSync(process.env.GIT_CONFIG_GLOBAL!, '[core]\n\tfsmonitor = on\n')
    try {
      expect((await fsmonitorInfo(repo)).enabled).toBe(true)
      await setFsmonitor(repo, false)
      expect((await fsmonitorInfo(repo)).enabled).toBe(false)
    } finally {
      writeFileSync(process.env.GIT_CONFIG_GLOBAL!, '')
    }
  })

  it('removes a repository identity instead of writing empty values', async () => {
    const repo = makeRepo()
    await ops.setIdentity(repo, { name: 'Work Name', email: '' })
    expect(sh(repo, 'config', '--local', 'user.name')).toBe('Work Name')
    expect(() => sh(repo, 'config', '--local', 'user.email')).toThrow()
    await ops.setIdentity(repo, null)
    expect(() => sh(repo, 'config', '--local', 'user.name')).toThrow()
  })

  it('undoes only the commit it was asked for', async () => {
    const repo = makeRepo()
    commit(repo, 'base')
    commit(repo, 'first')
    const first = sh(repo, 'rev-parse', 'HEAD')
    commit(repo, 'second')
    await expect(ops.undoCommit(repo, first)).rejects.toThrow(/no longer the last one/)
    expect(sh(repo, 'log', '-1', '--format=%s')).toBe('second')
    expect(await ops.undoCommit(repo, sh(repo, 'rev-parse', 'HEAD'))).toEqual({ message: 'second', amended: false })
    expect(sh(repo, 'log', '-1', '--format=%s')).toBe('first')
  })

  // A reset alone kept the merged changes staged without MERGE_HEAD: committing them again made a
  // one-parent commit, a squash of the merged branch.
  it('undoes a merge commit into the merge in progress it was', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'a\n' })
    sh(repo, 'checkout', '-q', '-b', 'feature')
    commit(repo, 'feature', { 'b.txt': 'b\n' })
    sh(repo, 'checkout', '-q', 'main')
    // A merge git could have fast-forwarded: made again, it must keep both parents.
    sh(repo, 'merge', '-q', '--no-ff', '-m', 'Merge feature', 'feature')
    expect(await ops.undoCommit(repo)).toEqual({ message: 'Merge feature', amended: false })
    expect(await status(repo)).toMatchObject({ operation: 'merge', operationHead: sh(repo, 'rev-parse', 'feature') })
    expect(sh(repo, 'diff', '--cached', '--name-only')).toBe('b.txt')
    await ops.continueOp(repo)
    expect(sh(repo, 'log', '-1', '--format=%P %s')).toBe(`${sh(repo, 'rev-parse', 'HEAD~1')} ${sh(repo, 'rev-parse', 'feature')} Merge feature`)
  })

  // Put back in progress with them, aborting the merge deleted a file staged after it, for good.
  it('undoes no merge commit while other changes are staged', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'a\n' })
    sh(repo, 'checkout', '-q', '-b', 'feature')
    commit(repo, 'feature', { 'b.txt': 'b\n' })
    sh(repo, 'checkout', '-q', 'main')
    sh(repo, 'merge', '-q', '--no-ff', '-m', 'Merge feature', 'feature')
    const merge = sh(repo, 'rev-parse', 'HEAD')
    write(repo, 'notes.txt', 'notes\n')
    await ops.stage(repo, ['notes.txt'])
    await expect(ops.undoCommit(repo)).rejects.toThrow(/staged since this merge/)
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(merge)
    expect((await status(repo)).operation).toBeNull()
    // Unstaged changes are left alone by an abort: the merge is undone with them.
    sh(repo, 'reset', '-q')
    write(repo, 'a.txt', 'edited\n')
    expect(await ops.undoCommit(repo)).toMatchObject({ message: 'Merge feature' })
    await ops.abortOp(repo)
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('edited\n')
    expect(existsSync(join(repo, 'notes.txt'))).toBe(true)
  })

  it('undoes an amend back to the commit it replaced', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'a\n' })
    commit(repo, 'first', { 'b.txt': 'b\n' })
    const first = sh(repo, 'rev-parse', 'HEAD')
    write(repo, 'c.txt', 'c\n')
    await ops.stage(repo, ['c.txt'])
    await ops.commit(repo, 'first, amended', true)
    expect(await ops.undoCommit(repo)).toEqual({ message: 'first, amended', amended: true })
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(first)
    expect(sh(repo, 'diff', '--cached', '--name-only')).toBe('c.txt')
  })

  it('keeps the branch of a shallow clone, whose oldest commit has a parent elsewhere', async () => {
    const origin = makeRepo('origin')
    commit(origin, 'one')
    commit(origin, 'two')
    const clone = join(origin, '..', 'clone')
    execFileSync('git', ['clone', '-q', '--depth', '1', pathToFileURL(origin).href, clone])
    await expect(ops.undoCommit(clone)).rejects.toThrow(/shallow clone/)
    expect(sh(clone, 'rev-parse', 'main')).toBe(sh(origin, 'rev-parse', 'main'))
  })

  it('undoes no commit while an operation is under way', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'base\n' })
    sh(repo, 'checkout', '-q', '-b', 'other')
    commit(repo, 'other', { 'a.txt': 'other\n' })
    sh(repo, 'checkout', '-q', 'main')
    commit(repo, 'main', { 'a.txt': 'main\n' })
    await git(repo, ['merge', 'other'], { okCodes: [1] })
    await expect(ops.undoCommit(repo)).rejects.toThrow(/merge is in progress/)
    expect(sh(repo, 'log', '-1', '--format=%s')).toBe('main')
  })

  it('undoes the first commit into an unborn branch, and never on a detached HEAD', async () => {
    const repo = makeRepo()
    commit(repo, 'root', { 'a.txt': 'a\n' })
    commit(repo, 'second')
    sh(repo, 'checkout', '-q', '--detach', 'HEAD~1')
    await expect(ops.undoCommit(repo)).rejects.toThrow(/no branch is checked out/)
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(sh(repo, 'rev-parse', 'main~1'))
    sh(repo, 'checkout', '-q', '-b', 'only-root')
    expect(await ops.undoCommit(repo)).toEqual({ message: 'root', amended: false })
    expect(sh(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/only-root')
    expect(sh(repo, 'diff', '--cached', '--name-only')).toBe('a.txt')
  })
})

describe('refs', () => {
  it('reads a name a branch and a tag share as it is, and pushes the branch under it', async () => {
    const repo = makeRepo()
    commit(repo, 'base')
    sh(repo, 'tag', 'release')
    sh(repo, 'checkout', '-q', '-b', 'release')
    const bare = join(repo, '..', 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', bare])
    sh(repo, 'remote', 'add', 'origin', bare)
    expect((await refs(repo)).tags.map(t => t.name)).toEqual(['release'])
    await ops.push(repo, {}, () => undefined)
    expect(execFileSync('git', ['-C', bare, 'for-each-ref', '--format=%(refname)', 'refs/heads'], { encoding: 'utf8' }).trim()).toBe('refs/heads/release')
    expect((await refs(repo)).branches.find(b => b.name === 'release')?.upstream).toBe('origin/release')
    // The next push and a pull go through that upstream.
    expect(await upstreamOf(repo, 'release')).toBe('origin/release')
    commit(repo, 'second')
    await ops.push(repo, {}, () => undefined)
    await ops.pull(repo, 'ff-only', () => undefined)
    expect(execFileSync('git', ['-C', bare, 'log', '-1', '--format=%s', 'release'], { encoding: 'utf8' }).trim()).toBe('second')
  })

  it('deletes a remote branch, never a remote tag of the same name', async () => {
    const repo = makeRepo()
    commit(repo, 'base')
    const bare = join(repo, '..', 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', bare])
    sh(repo, 'remote', 'add', 'origin', bare)
    sh(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/release', 'HEAD:refs/tags/release')
    sh(repo, 'fetch', '-q', 'origin')
    // Deleted on the server meanwhile: origin/release here is stale, the tag is still there.
    execFileSync('git', ['-C', bare, 'update-ref', '-d', 'refs/heads/release'])
    await ops.deleteRemoteBranch(repo, 'origin', 'release', () => undefined)
    expect(execFileSync('git', ['-C', bare, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' }).trim()).toBe('refs/tags/release')
  })

  it('reads and switches to a branch of a remote whose name holds a slash', async () => {
    const source = makeRepo()
    commit(source, 'base')
    sh(source, 'checkout', '-q', '-b', 'feature')
    commit(source, 'work')
    const repo = makeRepo()
    sh(repo, 'remote', 'add', 'team/upstream', source)
    sh(repo, 'fetch', '-q', 'team/upstream')
    const b = (await refs(repo)).branches.find(x => x.name === 'team/upstream/feature')
    expect(b).toMatchObject({ remote: true, remoteName: 'team/upstream' })
    await ops.checkout(repo, 'team/upstream/feature')
    expect(sh(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('feature')
    expect(await upstreamOf(repo, 'feature')).toBe('team/upstream/feature')
  })

  it('pushes a renamed branch under its new name', async () => {
    const bare = join(makeRepo(), '..', 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
    const repo = makeRepo()
    sh(repo, 'remote', 'add', 'origin', bare)
    commit(repo, 'base')
    sh(repo, 'checkout', '-q', '-b', 'feature')
    await ops.push(repo, {}, () => undefined)
    await ops.renameBranch(repo, 'feature', 'feature-login')
    commit(repo, 'more')
    await ops.push(repo, {}, () => undefined)
    const heads = execFileSync('git', ['-C', bare, 'for-each-ref', '--format=%(refname)', 'refs/heads'], { encoding: 'utf8' }).trim().split('\n')
    expect(heads).toEqual(['refs/heads/feature', 'refs/heads/feature-login'])
  })

  it('merges and compares the branch, not an older tag of the same name', async () => {
    const repo = makeRepo()
    commit(repo, 'base')
    sh(repo, 'tag', 'feature')
    sh(repo, 'checkout', '-q', '-b', 'feature')
    commit(repo, 'work', { 'f.txt': 'f\n' })
    sh(repo, 'checkout', '-q', 'main')
    expect((await compare(repo, 'main', 'feature', true)).files.map(f => f.path)).toEqual(['f.txt'])
    const feature = (await refs(repo)).branches.find(b => b.name === 'feature')!
    await ops.merge(repo, feature.fullRef)
    expect(existsSync(join(repo, 'f.txt'))).toBe(true)
  })
})

describe('changes kept across a pull or a rebase', () => {
  it('gives staged changes back staged after a pull and after editing history', async () => {
    const bare = join(makeRepo(), '..', 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
    const repo = makeRepo()
    sh(repo, 'remote', 'add', 'origin', bare)
    commit(repo, 'base', { 'a.txt': '1\n', 'b.txt': '1\n' })
    await ops.push(repo, {}, () => undefined)
    const other = makeRepo()
    sh(other, 'remote', 'add', 'origin', bare)
    sh(other, 'fetch', '-q', 'origin')
    sh(other, 'checkout', '-q', '-B', 'main', 'origin/main')
    commit(other, 'theirs', { 'c.txt': 'c\n' })
    sh(other, 'push', '-q', 'origin', 'main')
    write(repo, 'a.txt', 'staged\n')
    sh(repo, 'add', 'a.txt')
    write(repo, 'b.txt', 'unstaged\n')
    const kept = () => [sh(repo, 'diff', '--cached', '--name-only'), sh(repo, 'diff', '--name-only')]
    await ops.pull(repo, 'rebase', () => undefined)
    expect(existsSync(join(repo, 'c.txt'))).toBe(true)
    expect(kept()).toEqual(['a.txt', 'b.txt'])
    // A commit of its own file only: the changes stay as they are.
    write(repo, 'd.txt', 'd\n')
    sh(repo, 'add', 'd.txt')
    sh(repo, 'commit', '-q', '-m', 'two', '--', 'd.txt')
    const plan = await rebasePlan(repo, 'HEAD~1')
    await rebaseRun(repo, plan.base, [{ sha: plan.commits[0].sha, action: 'reword', message: 'two, reworded' }], plan.head)
    expect(sh(repo, 'log', '-1', '--format=%s')).toBe('two, reworded')
    expect(kept()).toEqual(['a.txt', 'b.txt'])
    expect(sh(repo, 'stash', 'list')).toBe('')
  })

  it('pulls nothing during a merge, which setting its resolved files aside would end', async () => {
    const bare = join(makeRepo(), '..', 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
    const repo = makeRepo()
    sh(repo, 'remote', 'add', 'origin', bare)
    commit(repo, 'base', { 'a.txt': 'base\n' })
    await ops.push(repo, { setUpstream: true }, () => undefined)
    sh(repo, 'checkout', '-q', '-b', 'side')
    commit(repo, 'side', { 'a.txt': 'side\n' })
    sh(repo, 'checkout', '-q', 'main')
    commit(repo, 'main', { 'a.txt': 'main\n' })
    await git(repo, ['merge', 'side'], { okCodes: [1] })
    // Resolved and staged: "Ready to continue", while the sync button still offers a pull.
    write(repo, 'a.txt', 'resolved\n')
    sh(repo, 'add', 'a.txt')
    await expect(ops.pull(repo, 'merge', () => undefined)).rejects.toThrow(/merge is in progress/)
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(true)
    expect(sh(repo, 'diff', '--cached', '--name-only')).toBe('a.txt')
    expect(sh(repo, 'stash', 'list')).toBe('')
  })
})

describe('undo and force push', () => {
  it('goes back before an operation without losing uncommitted work, and redoes it', async () => {
    const repo = makeRepo()
    commit(repo, 'one', { 'a.txt': '1\n', 'b.txt': 'b\n' })
    const one = sh(repo, 'rev-parse', 'HEAD')
    commit(repo, 'two', { 'a.txt': '2\n' })
    const two = sh(repo, 'rev-parse', 'HEAD')
    // A change in a file the undo would rewrite: reset --keep refuses rather than lose it.
    write(repo, 'a.txt', 'mine\n')
    await expect(restore(repo, { sha: one, branch: 'main' })).rejects.toThrow()
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('mine\n')
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(two)
    // A change elsewhere comes along.
    sh(repo, 'checkout', '--', 'a.txt')
    write(repo, 'b.txt', 'kept\n')
    const redo = await restore(repo, { sha: one, branch: 'main' })
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(one)
    expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('kept\n')
    await restore(repo, redo)
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(two)
  })

  it('undoes a rebase to where the branch was, whatever its commits say or where it ran from', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'a\n' })
    sh(repo, 'checkout', '-q', '-b', 'feature')
    commit(repo, 'f1', { 'f1.txt': '1\n' })
    commit(repo, 'fix the (start) button', { 'f2.txt': '2\n' })
    commit(repo, 'f3', { 'f3.txt': '3\n' })
    const tip = sh(repo, 'rev-parse', 'HEAD')
    sh(repo, 'checkout', '-q', 'main')
    commit(repo, 'main moves', { 'm.txt': 'm\n' })
    sh(repo, 'checkout', '-q', 'feature')
    sh(repo, 'rebase', '-q', 'main')
    const [rebase] = await operations(repo)
    expect(rebase).toMatchObject({ kind: 'rebase', before: { sha: tip, branch: 'feature' } })

    // Run from main, as `git rebase main other` does from the command line.
    sh(repo, 'checkout', '-q', '-b', 'other', 'main~1')
    commit(repo, 'o1', { 'o.txt': 'o\n' })
    const otherTip = sh(repo, 'rev-parse', 'HEAD')
    sh(repo, 'checkout', '-q', 'main')
    sh(repo, 'rebase', '-q', 'main', 'other')
    const [second] = await operations(repo)
    expect(second).toMatchObject({ kind: 'rebase', before: { sha: otherTip, branch: 'other' } })
  })

  // Any other name reached git as a URL: a tag's history published anywhere, or "\\host" looked up.
  it('pushes tags and deletes remote branches on the repository\'s own remotes only', async () => {
    const repo = makeRepo()
    commit(repo, 'base')
    sh(repo, 'tag', 'v1')
    await expect(ops.pushTag(repo, '\\\\attacker\\share\\r', 'v1', () => undefined)).rejects.toThrow(/not a remote/)
    await expect(ops.deleteRemoteBranch(repo, 'https://example.com/x.git', 'main', () => undefined)).rejects.toThrow(/not a remote/)
  })

  // git names those entries after the whole command, "pull --rebase --no-autostash --progress (pick)":
  // undoing the top one did nothing, and each pick undid to a half-rebased branch.
  it('undoes the app\'s own pull with rebase as one operation', async () => {
    const bare = join(makeRepo(), '..', 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
    const repo = makeRepo()
    sh(repo, 'remote', 'add', 'origin', bare)
    commit(repo, 'base')
    await ops.push(repo, { setUpstream: true }, () => undefined)
    const other = makeRepo()
    sh(other, 'remote', 'add', 'origin', bare)
    sh(other, 'fetch', '-q', 'origin')
    sh(other, 'checkout', '-q', '-B', 'main', 'origin/main')
    commit(other, 'theirs', { 'c.txt': 'c\n' })
    sh(other, 'push', '-q', 'origin', 'main')
    commit(repo, 'mine 1', { 'm1.txt': '1\n' })
    commit(repo, 'mine 2', { 'm2.txt': '2\n' })
    const tip = sh(repo, 'rev-parse', 'HEAD')
    await ops.pull(repo, 'rebase', () => undefined)
    const [pull, next] = await operations(repo)
    expect(pull).toMatchObject({ kind: 'pull', before: { sha: tip, branch: 'main' }, after: { sha: sh(repo, 'rev-parse', 'HEAD') } })
    expect(next.after.sha).toBe(tip)
  })

  it.each([
    ['push.default', 'matching'],
    // The remote's own refspecs come before push.default, which then changed nothing.
    ['remote.origin.push', 'refs/heads/*:refs/heads/*'],
  ])('pushes the current branch only, even where %s says "%s"', async (key, value) => {
    const bare = join(makeRepo(), '..', 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
    const repo = makeRepo()
    sh(repo, 'remote', 'add', 'origin', bare)
    commit(repo, 'base', { 'a.txt': 'a\n' })
    sh(repo, 'push', '-q', '-u', 'origin', 'main')
    sh(repo, 'push', '-q', 'origin', 'main:refs/heads/b')
    sh(repo, 'fetch', '-q', 'origin')
    sh(repo, 'branch', 'b', 'origin/b')
    // A local rewrite of b, not meant to be pushed yet.
    sh(repo, 'checkout', '-q', 'b')
    commit(repo, 'rewritten b', { 'b.txt': 'b\n' })
    sh(repo, 'checkout', '-q', 'main')
    commit(repo, 'main moves', { 'm.txt': 'm\n' })
    sh(repo, 'config', key, value)
    await ops.push(repo, { force: true }, () => undefined)
    const remoteLog = (ref: string) => execFileSync('git', ['-C', bare, 'log', '-1', '--format=%s', ref], { encoding: 'utf8' }).trim()
    expect(remoteLog('main')).toBe('main moves')
    expect(remoteLog('b')).toBe('base')
  })

  it('never force pushes over a remote commit that was fetched but never looked at', async () => {
    const bare = join(makeRepo(), '..', 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
    const repo = makeRepo()
    sh(repo, 'remote', 'add', 'origin', bare)
    commit(repo, 'base', { 'a.txt': 'a\n' })
    await ops.push(repo, {}, () => undefined)
    // Someone else pushes; the background fetch brings their commit in, nobody here sees it.
    const other = makeRepo()
    sh(other, 'remote', 'add', 'origin', bare)
    sh(other, 'fetch', '-q', 'origin')
    sh(other, 'checkout', '-q', '-B', 'main', 'origin/main')
    commit(other, 'theirs', { 't.txt': 't\n' })
    sh(other, 'push', '-q', 'origin', 'main')
    sh(repo, 'fetch', '-q', 'origin')
    commit(repo, 'amended locally', { 'a.txt': 'mine\n' })
    await expect(ops.push(repo, { force: true }, () => undefined)).rejects.toThrow()
    expect(execFileSync('git', ['-C', bare, 'log', '-1', '--format=%s', 'main'], { encoding: 'utf8' }).trim()).toBe('theirs')
  })
})

describe('deleted branches', () => {
  it('finds a deleted branch on its remote even when a journaled commit is gone', async () => {
    const repo = makeRepo()
    commit(repo, 'base')
    sh(repo, 'checkout', '-q', '-b', 'feat')
    commit(repo, 'known tip')
    const tip = sh(repo, 'rev-parse', 'HEAD')
    commit(repo, 'pushed from elsewhere')
    const newer = sh(repo, 'rev-parse', 'HEAD')
    sh(repo, 'remote', 'add', 'origin', '../origin.git')
    sh(repo, 'remote', 'add', 'origin2', '../origin2.git')
    sh(repo, 'update-ref', 'refs/remotes/origin/feat', newer)
    sh(repo, 'checkout', '-q', 'main')
    sh(repo, 'branch', '-q', '-D', 'feat')
    // A commit of the prune journal that gc has collected since.
    writeFileSync(join(repo, '.git', 'gdg-pruned-refs.json'), JSON.stringify([{ ref: 'origin2/feat', sha: 'f'.repeat(40), date: 1 }]))
    const [found] = await newerTips(repo, [{ name: 'feat', sha: tip }])
    expect(found).toMatchObject({ name: 'feat', sha: newer, via: 'remote', ahead: 1 })
  })

  it('finds commits made on a deleted branch that nothing references any more', async () => {
    const repo = makeRepo()
    commit(repo, 'base')
    sh(repo, 'checkout', '-q', '-b', 'feat')
    commit(repo, 'known tip')
    const tip = sh(repo, 'rev-parse', 'HEAD')
    commit(repo, 'made later')
    const newer = sh(repo, 'rev-parse', 'HEAD')
    sh(repo, 'checkout', '-q', 'main')
    sh(repo, 'branch', '-q', '-D', 'feat')
    const [found] = await newerTips(repo, [{ name: 'feat', sha: tip }])
    expect(found).toMatchObject({ name: 'feat', sha: newer, via: 'unreferenced', ahead: 1 })
  })

  it('takes another branch whose name ends like the deleted one for what it is', async () => {
    const repo = makeRepo()
    commit(repo, 'base')
    sh(repo, 'checkout', '-q', '-b', 'feature')
    commit(repo, 'known tip')
    const tip = sh(repo, 'rev-parse', 'HEAD')
    // Alice started her own branch from it: origin/alice/feature, not origin/feature.
    commit(repo, 'alice work')
    sh(repo, 'remote', 'add', 'origin', '../origin.git')
    sh(repo, 'update-ref', 'refs/remotes/origin/alice/feature', 'HEAD')
    sh(repo, 'checkout', '-q', 'main')
    sh(repo, 'branch', '-q', '-D', 'feature')
    const found = await newerTips(repo, [{ name: 'feature', sha: tip }])
    expect(found.filter(t => t.via === 'remote')).toEqual([])
  })
})

describe('edit history', () => {
  it('refuses a plan made before HEAD moved, so a new commit is never dropped', async () => {
    const repo = makeRepo()
    for (const i of [1, 2, 3]) commit(repo, `c${i}`, { 'f.txt': `${i}\n` })
    const plan = await rebasePlan(repo, 'HEAD~2')
    expect(plan.base).toBe(sh(repo, 'rev-parse', 'HEAD~2'))
    expect(plan.commits.map(c => c.subject)).toEqual(['c2', 'c3'])
    commit(repo, 'made elsewhere', { 'g.txt': 'g\n' })
    const steps = plan.commits.map(c => ({ sha: c.sha, action: 'pick' as const }))
    await expect(rebaseRun(repo, plan.base, steps, plan.head)).rejects.toThrow(/changed since this plan/)
    expect(sh(repo, 'log', '-1', '--format=%s')).toBe('made elsewhere')
  })

  // `rebase -i <base>` moved the branch onto a base outside it, from a plan that never showed it.
  it('edits only the current branch\'s own history', async () => {
    const repo = makeRepo()
    commit(repo, 'b0', { 'b.txt': '0\n' })
    sh(repo, 'checkout', '-q', '-b', 'release')
    commit(repo, 'r1', { 'r.txt': '1\n' })
    commit(repo, 'r2', { 'r.txt': '2\n' })
    sh(repo, 'checkout', '-q', '-b', 'feature', 'main')
    commit(repo, 'f1', { 'f.txt': '1\n' })
    const tip = sh(repo, 'rev-parse', 'HEAD')
    await expect(rebasePlan(repo, 'release~1')).rejects.toThrow(/not in the history of the current branch/)
    await expect(rebaseRun(repo, sh(repo, 'rev-parse', 'release~1'), [{ sha: tip, action: 'pick' }], tip)).rejects.toThrow(/not in the history/)
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(tip)
    // Behind its upstream as well: the unpushed commits are edited where they are.
    sh(repo, 'branch', '-q', '--set-upstream-to=release')
    const plan = await rebasePlan(repo, 'release')
    expect(plan.base).toBe(sh(repo, 'rev-parse', 'main'))
    expect(plan.commits.map(c => c.subject)).toEqual(['f1'])
  })

  // The message is applied by an "exec" step, which Continue went on past once it had failed.
  it('keeps a reworded message a hook refused, to apply it again on Continue', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'f.txt': 'base\n' })
    commit(repo, 'c1', { 'f.txt': 'one\n' })
    const hook = join(repo, '.git', 'hooks', 'commit-msg')
    writeFileSync(hook, '#!/bin/sh\ngrep -q "^JIRA-" "$1" || { echo "missing ticket" >&2; exit 1; }\n', { mode: 0o755 })
    const plan = await rebasePlan(repo, 'HEAD~1')
    await expect(rebaseRun(repo, plan.base, [{ sha: plan.commits[0].sha, action: 'reword', message: 'one, reworded' }], plan.head)).rejects.toThrow()
    expect((await status(repo)).operation).toBe('rebase')
    // The hook fixed (or bypassed), Continue applies the message it refused.
    rmSync(hook)
    await ops.continueOp(repo)
    expect(sh(repo, 'log', '-1', '--format=%s')).toBe('one, reworded')
  })

  it('keeps the messages of a stopped rebase when asked to edit history again', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'f.txt': 'base\n' })
    commit(repo, 'c1', { 'f.txt': 'one\n' })
    commit(repo, 'c2', { 'f.txt': 'two\n' })
    const plan = await rebasePlan(repo, 'HEAD~2')
    // c2 moved before c1: c2 stops on a conflict, its new message waiting in gdg-rebase.
    const [c1, c2] = plan.commits
    await expect(rebaseRun(repo, plan.base, [{ sha: c2.sha, action: 'reword', message: 'two, reworded' }, { sha: c1.sha, action: 'pick' }], plan.head)).rejects.toThrow()
    const messages = join(repo, '.git', 'gdg-rebase')
    const before = readFileSync(join(messages, 'msg-1.txt'), 'utf8')
    await expect(rebaseRun(repo, plan.base, [{ sha: c1.sha, action: 'pick' }, { sha: c2.sha, action: 'pick' }], sh(repo, 'rev-parse', 'HEAD'))).rejects.toThrow(/in progress/)
    expect(readFileSync(join(messages, 'msg-1.txt'), 'utf8')).toBe(before)
  })

  it('reads the plan of a history with merges without touching staged or unstaged changes', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': '1\n', 'b.txt': '1\n' })
    sh(repo, 'checkout', '-q', '-b', 'side')
    commit(repo, 'side', { 's.txt': 's\n' })
    sh(repo, 'checkout', '-q', 'main')
    commit(repo, 'main', { 'm.txt': 'm\n' })
    sh(repo, 'merge', '-q', '--no-edit', 'side')
    // Partly staged, fully staged, intent-to-add and untracked.
    write(repo, 'a.txt', '2\n')
    sh(repo, 'add', 'a.txt')
    write(repo, 'a.txt', '3\n')
    write(repo, 'b.txt', '2\n')
    sh(repo, 'add', 'b.txt')
    write(repo, 'n.txt', 'n\n')
    sh(repo, 'add', '-N', 'n.txt')
    write(repo, 'u.txt', 'u\n')
    const before = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })
    const plan = await rebasePlan(repo, 'HEAD~2')
    expect(plan.hasMerges).toBe(true)
    expect(plan.structure?.some(s => s.kind === 'line' && s.text.startsWith('merge '))).toBe(true)
    expect(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })).toBe(before)
    expect(sh(repo, 'show', ':a.txt')).toBe('2')
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('3\n')
    expect(sh(repo, 'stash', 'list')).toBe('')
  })

  it('reads the plan despite a lock file left by an earlier run', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': '1\n' })
    sh(repo, 'checkout', '-q', '-b', 'side')
    commit(repo, 'side', { 's.txt': 's\n' })
    sh(repo, 'checkout', '-q', 'main')
    commit(repo, 'main', { 'm.txt': 'm\n' })
    sh(repo, 'merge', '-q', '--no-edit', 'side')
    mkdirSync(join(repo, '.git', 'gdg-rebase'), { recursive: true })
    writeFileSync(join(repo, '.git', 'gdg-rebase', 'plan-index.lock'), '')
    expect((await rebasePlan(repo, 'HEAD~2')).structure?.length).toBeGreaterThan(0)
  })

  it('reads the plan of a sparse checkout with a change inside its cone', async () => {
    const repo = makeRepo()
    for (const dir of ['in', 'out']) mkdirSync(join(repo, dir))
    commit(repo, 'base', { 'in/a.txt': '1\n', 'out/b.txt': '1\n' })
    sh(repo, 'checkout', '-q', '-b', 'side')
    commit(repo, 'side', { 'in/s.txt': 's\n' })
    sh(repo, 'checkout', '-q', 'main')
    commit(repo, 'main', { 'in/m.txt': 'm\n' })
    sh(repo, 'merge', '-q', '--no-edit', 'side')
    sh(repo, 'sparse-checkout', 'set', 'in')
    write(repo, 'in/a.txt', '2\n')
    const plan = await rebasePlan(repo, 'HEAD~2')
    expect(plan.structure?.some(s => s.kind === 'line' && s.text.startsWith('merge '))).toBe(true)
    expect(sh(repo, 'status', '--porcelain')).toBe('M in/a.txt')
  })

  it('lists "fixup!" commits as picks even with rebase.autoSquash', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': '1\n' })
    sh(repo, 'checkout', '-q', '-b', 'side')
    commit(repo, 'side', { 's.txt': 's\n' })
    sh(repo, 'checkout', '-q', 'main')
    commit(repo, 'feature', { 'm.txt': 'm\n' })
    commit(repo, 'fixup! feature', { 'm.txt': 'm2\n' })
    sh(repo, 'merge', '-q', '--no-edit', 'side')
    sh(repo, 'config', 'rebase.autoSquash', 'true')
    const plan = await rebasePlan(repo, 'HEAD~3')
    expect(plan.structure?.filter(s => s.kind === 'pick')).toHaveLength(3)
    const steps = plan.structure!.map(s => (s.kind === 'pick' ? { sha: s.sha, action: 'pick' as const } : { sha: '', action: 'line' as const, line: s.text }))
    await rebaseRun(repo, plan.base, steps, plan.head)
    expect(sh(repo, 'log', '--format=%s', '-5').split('\n')).toContain('fixup! feature')
  })

  it('refuses steps that would run a command', async () => {
    const repo = makeRepo()
    for (const i of [1, 2]) commit(repo, `c${i}`, { 'f.txt': `${i}\n` })
    const plan = await rebasePlan(repo, 'HEAD~1')
    const picks = plan.commits.map(c => ({ sha: c.sha, action: 'pick' as const }))
    const exec = { sha: '', action: 'line' as const, line: 'exec git tag hacked' }
    await expect(rebaseRun(repo, plan.base, [exec, ...picks], plan.head)).rejects.toThrow(/not a step/)
    const smuggled = { sha: `${plan.commits[0].sha}\nexec git tag hacked`, action: 'pick' as const }
    await expect(rebaseRun(repo, plan.base, [smuggled], plan.head)).rejects.toThrow(/not a step/)
    expect(sh(repo, 'tag')).toBe('')
  })
})

describe('staging', () => {
  it('unstages both sides of a staged rename', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'old.txt': '1\n2\n3\n' })
    sh(repo, 'mv', 'old.txt', 'new.txt')
    await ops.unstage(repo, ['new.txt'])
    expect(sh(repo, 'diff', '--cached', '--name-only')).toBe('')
    expect(changed(repo).sort()).toEqual(['new.txt', 'old.txt'])
    expect(sh(repo, 'ls-files')).toBe('old.txt')
  })
})

describe('line operations', () => {
  it('stages only the selected line, and refuses a stale selection', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'a\nb\nc\nd\ne\nf\ng\nh\n' })
    write(repo, 'a.txt', 'A\nb\nc\nd\ne\nf\ng\nH\n')
    const d = await diff(repo, { kind: 'worktree', path: 'a.txt' }, OPTS)
    const first = d.hunks[0].lines.findIndex(l => l.type === 'add' && l.text === 'A')
    const del = d.hunks[0].lines.findIndex(l => l.type === 'del' && l.text === 'a')
    const sel = { 0: [del, first] }
    await expect(ops.stageLines(repo, 'a.txt', sel, false, undefined, 'stale')).rejects.toThrow(/changed since/)
    await ops.stageLines(repo, 'a.txt', sel, false, undefined, selectionFingerprint(d, sel))
    expect(sh(repo, 'show', ':a.txt')).toBe('A\nb\nc\nd\ne\nf\ng\nh')
  })

  it('unstages some lines without the file\'s mode change, a change of its own', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'run.sh': 'a\nb\nc\nd\ne\nf\ng\nh\n' })
    write(repo, 'run.sh', 'A\nb\nc\nd\ne\nf\ng\nH\n')
    sh(repo, 'add', 'run.sh')
    sh(repo, 'update-index', '--chmod=+x', 'run.sh')
    const d = await diff(repo, { kind: 'index', path: 'run.sh' }, OPTS)
    const sel = { 0: d.hunks[0].lines.flatMap((l, i) => (l.text === 'H' || l.text === 'h' ? [i] : [])) }
    await ops.unstageLines(repo, 'run.sh', sel, undefined, selectionFingerprint(d, sel))
    expect(sh(repo, 'show', ':run.sh')).toBe('A\nb\nc\nd\ne\nf\ng\nh')
    expect(sh(repo, 'ls-files', '-s', 'run.sh')).toMatch(/^100755 /)
  })

  it('unstages lines of a renamed file without undoing the rename', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'old.txt': '1\n2\n3\n4\n' })
    sh(repo, 'mv', 'old.txt', 'new.txt')
    write(repo, 'new.txt', '1\nTWO\n3\n4\n')
    sh(repo, 'add', 'new.txt')
    const d = await diff(repo, { kind: 'index', path: 'new.txt', oldPath: 'old.txt' }, OPTS)
    const sel = { 0: d.hunks[0].lines.flatMap((l, i) => (l.type === 'ctx' ? [] : [i])) }
    await ops.unstageLines(repo, 'new.txt', sel, undefined, selectionFingerprint(d, sel), 'old.txt')
    expect(sh(repo, 'status', '--porcelain')).toBe('RM old.txt -> new.txt')
  })

  // The names put back into the patch's header were written in the content's encoding: git read
  // "r\351sum\351.txt", another file, and the index got an entry of that invalid name.
  it('unstages some lines of a new file named with accents and not stored as UTF-8', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'x.txt': 'x\n' })
    writeFileSync(join(repo, 'résumé.txt'), Buffer.from('caf\xe9 1\nline 2\n', 'latin1'))
    sh(repo, 'add', 'résumé.txt')
    const d = await diff(repo, { kind: 'index', path: 'résumé.txt' }, OPTS)
    expect(d.encoding).toBe('windows-1252')
    const sel = { 0: [1] }
    await ops.unstageLines(repo, 'résumé.txt', sel, undefined, selectionFingerprint(d, sel))
    expect(sh(repo, '-c', 'core.quotepath=false', 'status', '--porcelain')).toBe('AM résumé.txt')
    expect(execFileSync('git', ['-C', repo, 'show', ':résumé.txt']).toString('latin1')).toBe('caf\xe9 1\n')
  })

  it('unstages lines of a file renamed from a name with accents, its content not UTF-8', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'résumé.txt'), Buffer.from('caf\xe9 1\nline 2\nline 3\nline 4\n', 'latin1'))
    commit(repo, 'base')
    sh(repo, 'mv', 'résumé.txt', 'new.txt')
    writeFileSync(join(repo, 'new.txt'), Buffer.from('caf\xe9 1\nLINE 2\nline 3\nline 4\n', 'latin1'))
    sh(repo, 'add', 'new.txt')
    const d = await diff(repo, { kind: 'index', path: 'new.txt', oldPath: 'résumé.txt' }, OPTS)
    expect(d.oldPath).toBe('résumé.txt')
    const sel = { 0: d.hunks[0].lines.flatMap((l, i) => (l.type === 'ctx' ? [] : [i])) }
    await ops.unstageLines(repo, 'new.txt', sel, undefined, selectionFingerprint(d, sel), d.oldPath)
    expect(sh(repo, '-c', 'core.quotepath=false', 'status', '--porcelain')).toBe('RM résumé.txt -> new.txt')
  })

  it('stages some lines of a deleted file named with accents and not stored as UTF-8', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'résumé.txt'), Buffer.from('caf\xe9 1\nline 2\n', 'latin1'))
    commit(repo, 'base')
    rmSync(join(repo, 'résumé.txt'))
    const d = await diff(repo, { kind: 'worktree', path: 'résumé.txt' }, OPTS)
    const sel = { 0: [0] }
    await ops.stageLines(repo, 'résumé.txt', sel, false, undefined, selectionFingerprint(d, sel))
    expect(sh(repo, '-c', 'core.quotepath=false', 'status', '--porcelain')).toBe('MD résumé.txt')
    expect(execFileSync('git', ['-C', repo, 'show', ':résumé.txt']).toString('latin1')).toBe('line 2\n')
  })

  it('stages lines whatever diff prefixes and log options the user configured', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'a\n\nb\n' })
    for (const [k, v] of [['diff.noprefix', 'true'], ['diff.mnemonicPrefix', 'true'], ['diff.suppressBlankEmpty', 'true'], ['log.showSignature', 'true']]) sh(repo, 'config', k, v)
    write(repo, 'a.txt', 'A\n\nb\nc\n')
    const d = await diff(repo, { kind: 'worktree', path: 'a.txt' }, OPTS)
    const sel = { 0: d.hunks[0].lines.flatMap((l, i) => (l.type === 'add' && l.text === 'c' ? [i] : [])) }
    await ops.stageLines(repo, 'a.txt', sel, false, undefined, selectionFingerprint(d, sel))
    expect(execFileSync('git', ['-C', repo, 'show', ':a.txt'], { encoding: 'utf8' })).toBe('a\n\nb\nc\n')
    expect((await log(repo, { scope: 'current', skip: 0, limit: 5 })).map(c => c.subject)).toEqual(['base'])
  })

  it('says a diff is unchanged instead of sending it again', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'a\n' })
    write(repo, 'a.txt', 'b\n')
    const first = await diff(repo, { kind: 'worktree', path: 'a.txt' }, OPTS)
    expect(await diff(repo, { kind: 'worktree', path: 'a.txt' }, { ...OPTS, since: first.etag })).toMatchObject({ unchanged: true, hunks: [] })
    write(repo, 'a.txt', 'c\n')
    const changed = await diff(repo, { kind: 'worktree', path: 'a.txt' }, { ...OPTS, since: first.etag })
    expect(changed.unchanged).toBeUndefined()
    expect(changed.hunks[0].lines.map(l => l.text)).toEqual(['a', 'c'])
    expect((await diff(repo, { kind: 'worktree', path: 'a.txt' }, { context: 0, ignoreWhitespace: false, since: changed.etag })).unchanged).toBeUndefined()
  })

  // A symbolic link needs privileges on Windows: git's output for a file turned into one is given as is.
  it('reads a file turned into a link as two parts, not one hunk with headers inside', () => {
    const raw = [
      'diff --git a/x b/x', 'deleted file mode 100644', 'index 1111111..0000000', '--- a/x', '+++ /dev/null', '@@ -1 +0,0 @@', '-content',
      'diff --git a/x b/x', 'new file mode 120000', 'index 0000000..2222222', '--- /dev/null', '+++ b/x', '@@ -0,0 +1 @@', '+target', '\\ No newline at end of file', '',
    ].join('\n')
    const d = parseDiff(raw, 'x', true)
    expect(d).toMatchObject({ typeChange: true, isDeleted: false, isNew: false, modeChange: '100644 → 120000', additions: 1, deletions: 1 })
    expect(d.hunks.map(h => h.lines.map(l => `${l.type}:${l.text}`))).toEqual([['del:content'], ['add:target']])
  })

  it('stages the real lines of a file a textconv filter shows differently', async () => {
    const repo = makeRepo()
    sh(repo, 'config', 'diff.upper.textconv', 'tr a-z A-Z <')
    commit(repo, 'base', { '.gitattributes': '*.txt diff=upper\n', 'a.txt': 'one\ntwo\n' })
    write(repo, 'a.txt', 'one\ntwo\nnew line\n')
    const opts = { context: 0, ignoreWhitespace: false }
    const d = await diff(repo, { kind: 'worktree', path: 'a.txt' }, opts)
    const sel = { 0: [d.hunks[0].lines.findIndex(l => l.type === 'add')] }
    await ops.stageLines(repo, 'a.txt', sel, false, opts, selectionFingerprint(d, sel))
    expect(execFileSync('git', ['-C', repo, 'show', ':a.txt'], { encoding: 'utf8' })).toBe('one\ntwo\nnew line\n')
  })

  // "\ No newline at end of file" may only follow the last line: a line kept before a selected one needs its newline.
  it('stages a line added below a last line that had no newline without joining them', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'a\nb' })
    write(repo, 'a.txt', 'a\nb\nc\nd')
    const d = await diff(repo, { kind: 'worktree', path: 'a.txt' }, OPTS)
    const sel = { 0: [d.hunks[0].lines.findIndex(l => l.type === 'add' && l.text === 'c')] }
    await ops.stageLines(repo, 'a.txt', sel, false, undefined, selectionFingerprint(d, sel))
    expect(execFileSync('git', ['-C', repo, 'show', ':a.txt'], { encoding: 'utf8' })).toBe('a\nb\nc\n')
  })

  it('discards the removal of a last line that had no newline without joining it to the next', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'a\nb' })
    write(repo, 'a.txt', 'a\nb\nc\nd')
    const d = await diff(repo, { kind: 'worktree', path: 'a.txt' }, OPTS)
    const sel = { 0: [d.hunks[0].lines.findIndex(l => l.type === 'del' && l.text === 'b')] }
    await ops.discardLines(repo, 'a.txt', sel, undefined, selectionFingerprint(d, sel))
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('a\nb\nb\nc\nd')
  })
})

describe('conflicts', () => {
  it('keeps a "=======" content line on its own side', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'doc.md': 'Title\n=====\nbase\n' })
    sh(repo, 'checkout', '-q', '-b', 'other')
    commit(repo, 'theirs', { 'doc.md': 'Title\n=====\ntheirs line\nSection\n=======\ntheirs end\n' })
    sh(repo, 'checkout', '-q', 'main')
    commit(repo, 'ours', { 'doc.md': 'Title\n=====\nours line\nPart\n=======\nours end\n' })
    await git(repo, ['merge', 'other'], { okCodes: [1] })
    const f = await conflict(repo, 'doc.md')
    const c = f.chunks.filter(k => k.kind === 'conflict')
    expect(c).toHaveLength(1)
    expect(c[0].ours).toEqual(['ours line', 'Part', '=======', 'ours end'])
    expect(c[0].theirs).toEqual(['theirs line', 'Section', '=======', 'theirs end'])
  })

  it('tells a new merge of the same file from an aborted one', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'f.txt': 'base\n' })
    sh(repo, 'checkout', '-q', '-b', 'a')
    commit(repo, 'a', { 'f.txt': 'from a\n' })
    sh(repo, 'checkout', '-q', '-b', 'b', 'main')
    commit(repo, 'b', { 'f.txt': 'from b\n' })
    sh(repo, 'checkout', '-q', 'main')
    commit(repo, 'ours', { 'f.txt': 'ours\n' })
    await git(repo, ['merge', 'a'], { okCodes: [1] })
    const first = await conflict(repo, 'f.txt')
    sh(repo, 'merge', '--abort')
    await git(repo, ['merge', 'b'], { okCodes: [1] })
    const second = await conflict(repo, 'f.txt')
    expect(first.stages).not.toBe(second.stages)
    expect((await conflict(repo, 'f.txt')).stages).toBe(second.stages)
  })

  it('resolves a conflict on a very large text file by picking a side', async () => {
    const repo = makeRepo()
    const big = (last: string) => 'line\n'.repeat(3_500_000) + last
    commit(repo, 'base', { 'big.txt': big('base\n') })
    sh(repo, 'checkout', '-q', '-b', 'other')
    commit(repo, 'theirs', { 'big.txt': big('theirs\n') })
    sh(repo, 'checkout', '-q', 'main')
    commit(repo, 'ours', { 'big.txt': big('ours\n') })
    await git(repo, ['merge', 'other'], { okCodes: [1] })
    const f = await conflict(repo, 'big.txt')
    expect(f.mode).toBe('whole')
    expect(f.chunks).toEqual([])
  })

  it('finds a conflict on the first line of a UTF-8 file with a BOM', async () => {
    const repo = makeRepo()
    const bom = '﻿'
    commit(repo, 'base', { 'a.cs': `${bom}using A;\nclass X {}\n` })
    sh(repo, 'checkout', '-q', '-b', 'other')
    commit(repo, 'theirs', { 'a.cs': `${bom}using B;\nclass X {}\n` })
    sh(repo, 'checkout', '-q', 'main')
    commit(repo, 'ours', { 'a.cs': `${bom}using C;\nclass X {}\n` })
    await git(repo, ['merge', 'other'], { okCodes: [1] })
    const f = await conflict(repo, 'a.cs')
    expect(f.encoding).toBe('utf8-bom')
    expect(f.chunks[0]).toEqual({ kind: 'conflict', ours: ['using C;'], base: ['using A;'], theirs: ['using B;'] })
    await resolveContent(repo, 'a.cs', 'using C;\nclass X {}\n', f.encoding)
    expect(readFileSync(join(repo, 'a.cs'), 'utf8')).toBe(`${bom}using C;\nclass X {}\n`)
  })

  it('resolves a UTF-16 file that git converts (working-tree-encoding) without staging garbage', async () => {
    const repo = makeRepo()
    const utf16 = (s: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')])
    const save = (text: string, message: string) => {
      writeFileSync(join(repo, 'a.txt'), utf16(text))
      sh(repo, 'add', '-A')
      sh(repo, 'commit', '-q', '-m', message)
    }
    writeFileSync(join(repo, '.gitattributes'), '*.txt text working-tree-encoding=UTF-16LE-BOM eol=crlf\n')
    save('one\r\ntwo\r\nthree\r\n', 'base')
    sh(repo, 'checkout', '-q', '-b', 'other')
    save('one\r\nTHEIRS\r\nthree\r\n', 'theirs')
    sh(repo, 'checkout', '-q', 'main')
    save('one\r\nOURS\r\nthree\r\n', 'ours')
    await git(repo, ['merge', 'other'], { okCodes: [1] })
    const f = await conflict(repo, 'a.txt')
    expect(f.chunks[1]).toEqual({ kind: 'conflict', ours: ['OURS'], base: ['two'], theirs: ['THEIRS'] })
    await resolveContent(repo, 'a.txt', ['one', 'OURS+THEIRS', 'three', ''].join(f.eol), f.encoding, f.disk)
    expect(sh(repo, 'show', ':a.txt')).toBe('one\nOURS+THEIRS\nthree')
    expect(readFileSync(join(repo, 'a.txt'))).toEqual(utf16('one\r\nOURS+THEIRS\r\nthree\r\n'))
    expect(sh(repo, 'status', '--porcelain')).toBe('M  a.txt')
  })

  it('keeps a side of a binary conflict from replacing edits made since it was shown', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.bin': 'base\0\n' })
    sh(repo, 'checkout', '-q', '-b', 'other')
    commit(repo, 'theirs', { 'a.bin': 'theirs\0\n' })
    sh(repo, 'checkout', '-q', 'main')
    commit(repo, 'ours', { 'a.bin': 'ours\0\n' })
    await git(repo, ['merge', 'other'], { okCodes: [1] })
    const f = await conflict(repo, 'a.bin')
    expect(f.mode).toBe('whole')
    // Adapted in another tool meanwhile.
    write(repo, 'a.bin', 'adapted\0\n')
    await expect(resolveWhole(repo, 'a.bin', 'theirs', f.disk)).rejects.toMatchObject({ code: 'CHANGED_ON_DISK' })
    expect(readFileSync(join(repo, 'a.bin'), 'utf8')).toBe('adapted\0\n')
    const again = await conflict(repo, 'a.bin')
    await resolveWhole(repo, 'a.bin', 'theirs', again.disk)
    expect(readFileSync(join(repo, 'a.bin'), 'utf8')).toBe('theirs\0\n')
  })

  it('does not bring back a BOM that our side removed', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': '﻿line\n' })
    sh(repo, 'checkout', '-q', '-b', 'other')
    commit(repo, 'theirs', { 'a.txt': '﻿theirs\n' })
    sh(repo, 'checkout', '-q', 'main')
    commit(repo, 'ours', { 'a.txt': 'ours\n' })
    await git(repo, ['merge', 'other'], { okCodes: [1] })
    expect((await conflict(repo, 'a.txt')).encoding).toBe('utf8')
  })

  it('reads each side of a conflict in its own encoding', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'name = x\n' })
    sh(repo, 'checkout', '-q', '-b', 'other')
    writeFileSync(join(repo, 'a.txt'), Buffer.from('name = caf\xe9\n', 'latin1'))
    commit(repo, 'theirs')
    sh(repo, 'checkout', '-q', 'main')
    commit(repo, 'ours', { 'a.txt': 'name = cafe\n' })
    await git(repo, ['merge', 'other'], { okCodes: [1] })
    const f = await conflict(repo, 'a.txt')
    expect(f.encoding).toBe('windows-1252')
    expect(f.chunks[0]).toEqual({ kind: 'conflict', ours: ['name = cafe'], base: ['name = x'], theirs: ['name = café'] })
  })

  it.each([
    ['the conflict view', (repo: string, path: string) => resolveWhole(repo, path, 'theirs')],
    // The file list's "Use their version" kept ours: "checkout --theirs" does nothing to a gitlink.
    ['the file list', (repo: string, path: string) => ops.resolve(repo, path, 'theirs')],
  ])('resolves a submodule conflict with the side picked in %s', async (_, pick) => {
    const lib = makeRepo('lib')
    commit(lib, 'l1')
    sh(lib, 'checkout', '-q', '-b', 'a')
    commit(lib, 'la')
    sh(lib, 'checkout', '-q', '-b', 'b', 'main')
    commit(lib, 'lb')
    sh(lib, 'checkout', '-q', 'main')
    const app = makeRepo('app')
    sh(app, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib')
    sh(app, 'commit', '-q', '-m', 'base')
    sh(app, 'checkout', '-q', '-b', 'other')
    sh(join(app, 'lib'), 'checkout', '-q', 'b')
    sh(app, 'commit', '-q', '-am', 'theirs')
    sh(app, 'checkout', '-q', 'main')
    sh(join(app, 'lib'), 'checkout', '-q', 'a')
    sh(app, 'commit', '-q', '-am', 'ours')
    await git(app, ['merge', 'other'], { okCodes: [1] })
    expect((await status(app)).files.find(f => f.path === 'lib')).toMatchObject({ conflicted: true, submodule: true })
    expect(await conflict(app, 'lib')).toMatchObject({ mode: 'whole', oursExists: true, theirsExists: true })
    await pick(app, 'lib')
    expect(sh(app, 'ls-files', '-s', 'lib')).toBe(`160000 ${sh(lib, 'rev-parse', 'b')} 0\tlib`)
  })

  it.each(['short', 'log', 'diff'])('shows a submodule moved to another commit as such, with diff.submodule=%s', async format => {
    const lib = makeRepo('lib')
    commit(lib, 'l1')
    const first = sh(lib, 'rev-parse', 'HEAD')
    commit(lib, 'l2', { 'x.txt': 'x\n' })
    const app = makeRepo('app')
    sh(app, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib')
    sh(app, 'commit', '-q', '-m', 'base')
    sh(join(app, 'lib'), 'checkout', '-q', first)
    sh(app, 'config', 'diff.submodule', format)
    const d = await diff(app, { kind: 'worktree', path: 'lib' }, OPTS)
    expect(d.submodule).toEqual({ before: sh(lib, 'rev-parse', 'HEAD').slice(0, 12), after: first.slice(0, 12) })
    expect(d.typeChange).toBeFalsy()
    await expect(ops.discardLines(app, 'lib', { 0: [0] }, undefined, selectionFingerprint(d, { 0: [0] }))).rejects.toThrow(/as a whole/)
  })

  it('resolves a conflict on a Git LFS file by picking a side', async () => {
    const repo = makeRepo()
    const pointer = (oid: string) => `version https://git-lfs.github.com/spec/v1\noid sha256:${oid.repeat(64)}\nsize 1234\n`
    commit(repo, 'base', { 'big.psd': pointer('a') })
    sh(repo, 'checkout', '-q', '-b', 'other')
    commit(repo, 'theirs', { 'big.psd': pointer('b') })
    sh(repo, 'checkout', '-q', 'main')
    commit(repo, 'ours', { 'big.psd': pointer('c') })
    await git(repo, ['merge', 'other'], { okCodes: [1] })
    expect((await conflict(repo, 'big.psd')).mode).toBe('whole')
  })

  it('never writes a result over edits made in an editor since the conflict was read', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'base\n' })
    sh(repo, 'checkout', '-q', '-b', 'other')
    commit(repo, 'theirs', { 'a.txt': 'theirs\n' })
    sh(repo, 'checkout', '-q', 'main')
    commit(repo, 'ours', { 'a.txt': 'ours\n' })
    await git(repo, ['merge', 'other'], { okCodes: [1] })
    const f = await conflict(repo, 'a.txt')
    write(repo, 'a.txt', 'merged by hand in an editor\n')
    await expect(resolveContent(repo, 'a.txt', 'ours\n', f.encoding, f.disk)).rejects.toMatchObject({ code: 'CHANGED_ON_DISK' })
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('merged by hand in an editor\n')
    const again = await conflict(repo, 'a.txt')
    await resolveContent(repo, 'a.txt', 'ours\n', again.encoding, again.disk)
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('ours\n')
  })

  it('writes only a file that is in conflict', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'a\n', 'hooks.txt': 'kept\n' })
    await expect(resolveContent(repo, 'hooks.txt', 'overwritten\n')).rejects.toThrow(/not in conflict/)
    await expect(resolveContent(repo, 'new.txt', 'created\n')).rejects.toThrow(/not in conflict/)
    expect(readFileSync(join(repo, 'hooks.txt'), 'utf8')).toBe('kept\n')
    expect(existsSync(join(repo, 'new.txt'))).toBe(false)
  })
})

describe('file history', () => {
  it('diffs and blames in a SHA-256 repository', async () => {
    const root = join(makeRepo(), '..', 'sha256')
    execFileSync('git', ['init', '-q', '-b', 'main', '--object-format=sha256', root])
    for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com']]) sh(root, 'config', k, v)
    write(root, 'a.txt', 'one\n')
    sh(root, 'add', 'a.txt')
    expect((await diff(root, { kind: 'index', path: 'a.txt' }, OPTS)).hunks[0].lines.map(l => l.text)).toEqual(['one'])
    sh(root, 'commit', '-q', '-m', 'first')
    const sha = sh(root, 'rev-parse', 'HEAD')
    expect(sha).toHaveLength(64)
    expect((await diff(root, { kind: 'commit', sha, path: 'a.txt' }, OPTS)).additions).toBe(1)
    const b = await blame(root, 'a.txt', null)
    expect(b.lines.map(l => l.sha)).toEqual([sha])
  })

  it('shows only the file\'s own change in a commit that copied it from another', async () => {
    const repo = makeRepo()
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n'
    commit(repo, 'one', { 'a.txt': lines })
    write(repo, 'b.txt', lines)
    write(repo, 'a.txt', `${lines}more\n`)
    commit(repo, 'copy')
    const sha = sh(repo, 'rev-parse', 'HEAD')
    // As file history asks for it: "--follow" reported the copy, with its source as old path.
    const d = await diff(repo, { kind: 'commit', sha, path: 'b.txt', oldPath: 'a.txt' }, OPTS)
    expect(d.typeChange).toBeFalsy()
    expect(d.additions).toBe(20)
    expect(d.hunks.flatMap(h => h.lines).some(l => l.text === 'more')).toBe(false)
  })

  it('follows a file across a rename, paths kept as they are', async () => {
    const repo = makeRepo()
    commit(repo, 'one', { 'a.txt': 'x\ny\nz\n' })
    sh(repo, 'mv', 'a.txt', 'b c.txt')
    commit(repo, 'two')
    commit(repo, 'three', { 'b c.txt': 'x\ny\nz\nw\n' })
    const commits = await fileLog(repo, 'b c.txt', 0, 10)
    expect(commits.map(c => [c.subject, c.status, c.path, c.oldPath])).toEqual([
      ['three', 'M', 'b c.txt', undefined], ['two', 'R', 'b c.txt', 'a.txt'], ['one', 'A', 'a.txt', undefined],
    ])
  })

  it('unquotes the C-quoted paths of blame output', () => {
    expect(unquote('plain name.txt')).toBe('plain name.txt')
    expect(unquote('"a\\"b\\\\c\\td.txt"')).toBe('a"b\\c\td.txt')
    expect(unquote('"caf\\303\\251.txt"')).toBe('café.txt')
  })

  // Git C-quotes such a name ("a\tb") unless -z; Windows file names cannot hold a tab, so the output is crafted.
  it('reads -z output whose names hold tabs and quotes', () => {
    const out = '\x1eabc\x1f\x1fA\x1fa@x\x1f1\x1fmove\x1f\0\nR100\0old\tname.txt\0new "name".txt\0'
    expect(parseFileLog(out, 'x')[0]).toMatchObject({ status: 'R', oldPath: 'old\tname.txt', path: 'new "name".txt' })
  })
})

describe('operations in progress', () => {
  it('saves the stat data of touched files once in a while, never from status itself', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'a\n' })
    const index = join(repo, '.git', 'index')
    // The file touched (same content, new time): the index has stale stat data until something refreshes it.
    const later = new Date(Date.now() + 5_000)
    utimesSync(join(repo, 'a.txt'), later, later)
    const before = statSync(index).mtimeMs
    await new Promise(resolve => setTimeout(resolve, 50))
    // Status takes no lock: holding index.lock while it ran, it made a stage or a commit meanwhile fail.
    await status(repo)
    expect(statSync(index).mtimeMs).toBe(before)
    expect(indexRefreshDue(repo)).toBe(true)
    await refreshIndex(repo)
    expect(statSync(index).mtimeMs).toBeGreaterThan(before)
    // And not at every refresh.
    expect(indexRefreshDue(repo)).toBe(false)
  })

  it('names the commit a cherry-pick in progress brings in, which tells one pick from the next', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'base\n' })
    sh(repo, 'checkout', '-q', '-b', 'other')
    commit(repo, 'theirs', { 'a.txt': 'theirs\n' })
    const picked = sh(repo, 'rev-parse', 'HEAD')
    sh(repo, 'checkout', '-q', 'main')
    commit(repo, 'ours', { 'a.txt': 'ours\n' })
    await git(repo, ['cherry-pick', picked], { okCodes: [1] })
    expect(await status(repo)).toMatchObject({ operation: 'cherry-pick', operationHead: picked })
  })

  it('lists untracked files unless the repository says not to', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'a\n' })
    write(repo, 'new.txt', 'n\n')
    expect((await status(repo)).files.map(f => f.path)).toEqual(['new.txt'])
    const quiet = makeRepo()
    sh(quiet, 'config', 'status.showUntrackedFiles', 'no')
    commit(quiet, 'base', { 'a.txt': 'a\n' })
    write(quiet, 'new.txt', 'n\n')
    expect((await status(quiet)).files).toEqual([])
  })

  it('tells a git am session from a rebase, and aborts it with am', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'base\n' })
    commit(repo, 'change', { 'a.txt': 'patched\n' })
    const patch = sh(repo, 'format-patch', '-1', '--stdout') + '\n'
    sh(repo, 'reset', '-q', '--hard', 'HEAD~1')
    commit(repo, 'conflicting', { 'a.txt': 'other\n' })
    await git(repo, ['am'], { input: patch, okCodes: [128] })
    expect((await status(repo)).operation).toBe('am')
    await ops.abortOp(repo)
    expect((await status(repo)).operation).toBeNull()
    expect(sh(repo, 'log', '-1', '--format=%s')).toBe('conflicting')
  })

  it('commits a merge or a cherry-pick with the message written for it', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'base\n' })
    sh(repo, 'checkout', '-q', '-b', 'other')
    commit(repo, 'theirs', { 'a.txt': 'theirs\n' })
    sh(repo, 'checkout', '-q', '-b', 'third', 'main')
    execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'by someone else'], { env: { ...process.env, GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com' } })
    write(repo, 'a.txt', 'third\n')
    sh(repo, 'commit', '-q', '--amend', '-a', '--no-edit')
    const third = sh(repo, 'rev-parse', 'HEAD')
    sh(repo, 'checkout', '-q', 'main')
    commit(repo, 'ours', { 'a.txt': 'ours\n' })
    await git(repo, ['merge', 'other'], { okCodes: [1] })
    write(repo, 'a.txt', 'merged\n')
    await ops.stage(repo, ['a.txt'])
    await ops.continueOp(repo, 'Merge other, keeping both')
    expect(sh(repo, 'log', '-1', '--format=%s')).toBe('Merge other, keeping both')
    await expect(ops.cherryPick(repo, [third])).rejects.toThrow()
    write(repo, 'a.txt', 'picked\n')
    await ops.stage(repo, ['a.txt'])
    await ops.continueOp(repo, 'Picked, reworded')
    expect(sh(repo, 'log', '-1', '--format=%s|%an')).toBe('Picked, reworded|Someone')
    expect((await status(repo)).operation).toBeNull()
  })

  it('keeps a multi-commit cherry-pick going after its conflict is committed by hand', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'base\n' })
    sh(repo, 'checkout', '-q', '-b', 'topic')
    commit(repo, 'c1', { 'a.txt': 'topic\n' })
    commit(repo, 'c2', { 'b.txt': 'b\n' })
    const [c2, c1] = sh(repo, 'rev-list', '-2', 'HEAD').split('\n')
    sh(repo, 'checkout', '-q', 'main')
    commit(repo, 'ours', { 'a.txt': 'ours\n' })
    await expect(ops.cherryPick(repo, [c1, c2])).rejects.toThrow()
    write(repo, 'a.txt', 'resolved\n')
    await ops.stage(repo, ['a.txt'])
    await ops.commit(repo, 'c1 resolved', false)
    expect((await status(repo)).operation).toBe('cherry-pick')
    await ops.continueOp(repo)
    expect((await status(repo)).operation).toBeNull()
    expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('b\n')
  })
})

describe('history', () => {
  it('says why a search failed instead of finding nothing', async () => {
    const repo = makeRepo()
    expect(await log(repo, { scope: 'current', skip: 0, limit: 5 })).toEqual([])
    commit(repo, 'base', { 'a.txt': 'a\n' })
    await expect(log(repo, { scope: 'current', skip: 0, limit: 5, search: 'foo(', searchMode: 'regex' })).rejects.toThrow()
  })

  it('cherry-picks several commits in history order even with equal dates', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'f.txt': 'base\n' })
    sh(repo, 'checkout', '-q', '-b', 'topic')
    const env = { ...process.env, GIT_COMMITTER_DATE: '2026-01-01T10:00:00', GIT_AUTHOR_DATE: '2026-01-01T10:00:00' }
    const shas: string[] = []
    for (const i of [1, 2, 3]) {
      write(repo, 'f.txt', readFileSync(join(repo, 'f.txt'), 'utf8') + `line ${i}\n`)
      await git(repo, ['commit', '-qam', `c${i}`], { env })
      shas.push(sh(repo, 'rev-parse', 'HEAD'))
    }
    sh(repo, 'checkout', '-q', 'main')
    await ops.cherryPick(repo, [shas[2], shas[0], shas[1]])
    expect(sh(repo, 'log', '--format=%s', '-4').split('\n')).toEqual(['c3', 'c2', 'c1', 'base'])
  })

  it('does not read a tag that already exists on the remote as commits to pull', async () => {
    const remote = makeRepo('remote.git')
    sh(remote, 'config', 'receive.denyCurrentBranch', 'ignore')
    commit(remote, 'base', { 'a.txt': 'a\n' })
    sh(remote, 'tag', 'v1')
    const repo = makeRepo()
    commit(repo, 'other', { 'b.txt': 'b\n' })
    sh(repo, 'remote', 'add', 'origin', remote)
    sh(repo, 'tag', 'v1')
    const err = await ops.pushTag(repo, 'origin', 'v1', () => undefined).then(() => null, (e: { code?: string }) => e)
    expect(err).not.toBeNull()
    expect(err?.code).not.toBe('NON_FAST_FORWARD')
  })

  it('orders commits picked from two branches by ancestry, then date', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'f.txt': 'base\n' })
    // A commit adding its own file, at a given date.
    const dated = async (name: string, date: string) => {
      write(repo, `${name}.txt`, `${name}\n`)
      sh(repo, 'add', `${name}.txt`)
      await git(repo, ['commit', '-q', '-m', name], { env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } })
      return sh(repo, 'rev-parse', 'HEAD')
    }
    sh(repo, 'checkout', '-q', '-b', 'one')
    const oneA = await dated('one-a', '2026-01-01T10:00:00')
    const oneB = await dated('one-b', '2026-01-03T10:00:00')
    sh(repo, 'checkout', '-q', '-b', 'two', 'main')
    const twoA = await dated('two-a', '2026-01-02T10:00:00')
    sh(repo, 'checkout', '-q', 'main')
    await ops.cherryPick(repo, [oneB, twoA, oneA])
    expect(sh(repo, 'log', '--format=%s', '-3').split('\n')).toEqual(['one-b', 'two-a', 'one-a'])
  })

  it('lists remotes whose URL has spaces', async () => {
    const repo = makeRepo()
    commit(repo, 'base')
    sh(repo, 'remote', 'add', 'local', 'C:/My Repos/x.git')
    const r = await refs(repo)
    expect(r.remotes.find(x => x.name === 'local')?.fetchUrl).toBe('C:/My Repos/x.git')
  })

  // Windows looks for a program named without a path in the working directory first, unless told not to.
  it.runIf(process.platform === 'win32')('never runs a git.exe shipped inside the repository', async () => {
    const repo = makeRepo()
    copyFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'hostname.exe'), join(repo, 'git.exe'))
    const saved = process.env.NoDefaultCurrentDirectoryInExePath
    delete process.env.NoDefaultCurrentDirectoryInExePath
    try {
      expect((await git(repo, ['--version'])).stdout).toMatch(/^git version/)
    } finally {
      if (saved !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = saved
    }
  })

  it('reads the git version, and tells a supported or recommended one', async () => {
    expect(readGitVersion('git version 2.56.0.windows.4')).toEqual({ version: '2.56.0', supported: true, recommended: true, minimum: '2.36.0' })
    expect(readGitVersion('git version 2.45.2.windows.1')).toMatchObject({ version: '2.45.2', supported: true, recommended: false })
    expect(readGitVersion('git version 2.35.8')).toMatchObject({ version: '2.35.8', supported: false, recommended: false })
    expect(readGitVersion('git version 3.0')).toMatchObject({ supported: true, recommended: true })
    expect(readGitVersion('not git')).toBeNull()
    expect((await gitVersion())?.supported).toBe(true)
  })

  // A repository git refuses was taken for a plain folder, and "Create one in it?" made a second
  // repository inside it.
  it('tells a folder a repository may be created in from one git refuses', async () => {
    const repo = makeRepo()
    commit(repo, 'base')
    mkdirSync(join(repo, 'src'))
    expect(await isRepo(join(repo, '..'))).toBe(false)
    expect(await isRepo(join(repo, 'src'))).toBe(true)
    await expect(isRepo(join(repo, '.git'))).rejects.toThrow(/repository's own data/)
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1'
    try {
      await expect(isRepo(join(repo, 'src'))).rejects.toThrow(/dubious ownership/)
    } finally {
      delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER
    }
  })

  // A folder that is a repository's data and its own working tree (core.worktree=.), as a clone or a
  // checkout can plant one: it was opened as a repository, and its first status ran core.fsmonitor.
  it('neither opens nor runs the config of a repository planted as plain files', async () => {
    const root = join(makeRepo(), '..')
    const planted = join(root, 'inner')
    execFileSync('git', ['init', '-q', '--bare', planted])
    for (const [k, v] of [['core.bare', 'false'], ['core.worktree', '.'], ['core.fsmonitor', 'echo ran > ../marker.txt; false']]) sh(planted, 'config', k, v)
    await expect(isRepo(planted)).rejects.toThrow()
    await status(planted).catch(() => undefined)
    expect(existsSync(join(root, 'marker.txt'))).toBe(false)
  })

  it('says a repository\'s folder is gone, not that git is missing', async () => {
    const repo = makeRepo()
    rmSync(repo, { recursive: true, force: true })
    await expect(git(repo, ['status'])).rejects.toThrow(/no longer exists/)
    expect((await gitVersion())?.supported).toBe(true)
  })

  it('guards network commands against dead connections only, and not over the user\'s own limits', async () => {
    const repo = makeRepo()
    expect(await stallGuards(repo)).toMatchObject({ GIT_HTTP_LOW_SPEED_LIMIT: '1', GIT_HTTP_LOW_SPEED_TIME: '300' })
    sh(repo, 'config', 'http.lowSpeedTime', '30')
    sh(repo, 'config', 'core.sshCommand', 'plink -batch')
    expect(await stallGuards(repo)).toEqual({})
  })

  it.runIf(process.platform === 'win32')('tells Windows\' OpenSSH, which runs no shell script for prompts, from Git\'s ssh', () => {
    expect(windowsOpenSsh(null, true)).toBe(false)
    expect(windowsOpenSsh(null, false)).toBe(true)
    expect(windowsOpenSsh('ssh -o ServerAliveInterval=15', true)).toBe(false)
    expect(windowsOpenSsh('C:/Windows/System32/OpenSSH/ssh.exe', true)).toBe(true)
    expect(windowsOpenSsh('"C:\\Windows\\System32\\OpenSSH\\ssh.exe" -i key', true)).toBe(true)
    expect(windowsOpenSsh('plink -batch', false)).toBe(false)
    // A host key question cut after its first line is still asked as one.
    expect(classify("The authenticity of host 'h (1.2.3.4)' can't be established.")).toBe('confirm')
    expect(classify('Enter passphrase for key /c/Users/me/.ssh/id_ed25519: ')).toBe('password')
  })

  it.runIf(process.platform === 'win32')('gives Windows\' OpenSSH its own prompt helper program, never a batch file', async () => {
    const repo = makeRepo()
    const helper = 'C:/Apps/GaetanDev Git/resources/gdg-askpass.exe'
    sh(repo, 'config', 'core.sshCommand', 'C:/Windows/System32/OpenSSH/ssh.exe')
    setGitEnv({ GDG_ASKPASS_HELPER_EXE: helper })
    try {
      expect(await stallGuards(repo)).toEqual({ GIT_HTTP_LOW_SPEED_LIMIT: '1', GIT_HTTP_LOW_SPEED_TIME: '300', SSH_ASKPASS: helper })
      // Any other ssh runs the shell script.
      sh(repo, 'config', 'core.sshCommand', 'plink -batch')
      expect(await stallGuards(repo)).toEqual({ GIT_HTTP_LOW_SPEED_LIMIT: '1', GIT_HTTP_LOW_SPEED_TIME: '300' })
    } finally {
      setGitEnv({})
    }
  })

  it('works on the repository it runs in, whatever GIT_DIR or GIT_INDEX_FILE the app inherited', async () => {
    const repo = makeRepo()
    const elsewhere = makeRepo()
    commit(repo, 'base', { 'a.txt': 'a\n' })
    write(repo, 'a.txt', 'changed\n')
    const saved = { dir: process.env.GIT_DIR, index: process.env.GIT_INDEX_FILE }
    process.env.GIT_DIR = join(elsewhere, '.git')
    process.env.GIT_INDEX_FILE = join(elsewhere, '.git', 'other-index')
    try {
      await ops.stage(repo, ['a.txt'])
    } finally {
      for (const [k, v] of [['GIT_DIR', saved.dir], ['GIT_INDEX_FILE', saved.index]] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
    expect(sh(repo, 'diff', '--cached', '--name-only')).toBe('a.txt')
    expect(existsSync(join(elsewhere, '.git', 'other-index'))).toBe(false)
  })

  it('writes the commit-graph when fetching, unless the repository says not to', async () => {
    const source = makeRepo()
    for (const i of [1, 2, 3]) commit(source, `c${i}`)
    const repo = makeRepo()
    sh(repo, 'remote', 'add', 'origin', source)
    await ops.fetchAll(repo, () => undefined)
    const info = join(repo, '.git', 'objects', 'info')
    expect(existsSync(join(info, 'commit-graph')) || existsSync(join(info, 'commit-graphs'))).toBe(true)
  })

  it('cancels a clone and leaves no half-filled folder', async () => {
    const source = makeRepo()
    commit(source, 'base', { 'a.txt': 'a\n' })
    const parent = join(source, '..', 'clones')
    mkdirSync(parent)
    const abort = new AbortController()
    abort.abort()
    await expect(ops.clone(source, parent, 'copy', () => undefined, abort.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(existsSync(join(parent, 'copy'))).toBe(false)
    await ops.clone(source, parent, 'copy', () => undefined)
    // The checkout follows the machine's core.autocrlf.
    expect(readFileSync(join(parent, 'copy', 'a.txt'), 'utf8')).toMatch(/^a\r?\n$/)
  })

  it('stops what git started too when the app quits', async () => {
    const repo = makeRepo()
    const running = git(repo, ['-c', 'alias.slow=!sleep 4 && echo done > marker', 'slow']).catch(() => undefined)
    await new Promise(resolve => setTimeout(resolve, 1500))
    killRunning()
    await running
    await new Promise(resolve => setTimeout(resolve, 4000))
    expect(existsSync(join(repo, 'marker'))).toBe(false)
  })

  it('shows why the server refused a push', async () => {
    const bare = join(makeRepo(), '..', 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
    // A server hook standing for a protected branch rule (GitHub's GH006).
    writeFileSync(join(bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho "error: GH006: Protected branch update failed for refs/heads/main." >&2\nexit 1\n', { mode: 0o755 })
    const repo = makeRepo()
    sh(repo, 'remote', 'add', 'origin', bare)
    commit(repo, 'base', { 'a.txt': 'a\n' })
    const err = await ops.push(repo, {}, () => undefined).then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/GH006: Protected branch update failed/)
  })

  it('survives git exiting before it reads its input', async () => {
    const repo = makeRepo()
    commit(repo, 'base')
    const r = await git(repo, ['rev-parse', 'HEAD'], { input: 'x'.repeat(20_000_000) })
    expect(r.stdout.trim()).toMatch(/^[0-9a-f]{40}$/)
    // A write error on stdin would surface on the next turns of the event loop.
    await new Promise(resolve => setTimeout(resolve, 200))
  })

  it('keeps only the end of a huge stderr, where the error is', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'a\n' })
    // A hook printing 3 MB, then failing with its reason last.
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nhead -c 3000000 /dev/zero | tr "\\0" x >&2\necho "error: the real reason" >&2\nexit 1\n', { mode: 0o755 })
    write(repo, 'a.txt', 'b\n')
    sh(repo, 'add', 'a.txt')
    const err = await ops.commit(repo, 'x', false).then(() => null, (e: { stderr: string; details: string }) => e)
    expect(err?.stderr.length).toBeLessThanOrEqual(1024 * 1024 + 65_536)
    expect(err?.details).toMatch(/the real reason/)
  })

  it('reports output cut at maxBytes', async () => {
    const repo = makeRepo()
    for (let i = 0; i < 30; i++) commit(repo, `commit number ${i}`)
    const r = await git(repo, ['log'], { maxBytes: 512 })
    expect(r.truncated).toBe(true)
    expect(r.raw.length).toBeLessThanOrEqual(512)
    expect((await status(repo)).files).toEqual([])
  })
})
