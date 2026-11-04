import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { selectionFingerprint } from '@shared/types'
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
const { status } = await import('../src/main/git/status')
const { diff } = await import('../src/main/git/diff')
const { conflict, resolveContent } = await import('../src/main/git/conflict')
const { refs } = await import('../src/main/git/refs')
const { compare } = await import('../src/main/git/compare')
const { log } = await import('../src/main/git/log')
const { fileLog, parseFileLog, unquote } = await import('../src/main/git/blame')
const { rebasePlan, rebaseRun } = await import('../src/main/git/rebase')
const { git, assertRefName, gitVersion, readGitVersion, stallGuards } = await import('../src/main/git/exec')

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

  it('undoes only the commit it was asked for', async () => {
    const repo = makeRepo()
    commit(repo, 'base')
    commit(repo, 'first')
    const first = sh(repo, 'rev-parse', 'HEAD')
    commit(repo, 'second')
    await expect(ops.undoCommit(repo, first)).rejects.toThrow(/no longer the last one/)
    expect(sh(repo, 'log', '-1', '--format=%s')).toBe('second')
    expect(await ops.undoCommit(repo, sh(repo, 'rev-parse', 'HEAD'))).toBe('second')
    expect(sh(repo, 'log', '-1', '--format=%s')).toBe('first')
  })

  it('undoes the first commit into an unborn branch, and never on a detached HEAD', async () => {
    const repo = makeRepo()
    commit(repo, 'root', { 'a.txt': 'a\n' })
    commit(repo, 'second')
    sh(repo, 'checkout', '-q', '--detach', 'HEAD~1')
    await expect(ops.undoCommit(repo)).rejects.toThrow(/no branch is checked out/)
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(sh(repo, 'rev-parse', 'main~1'))
    sh(repo, 'checkout', '-q', '-b', 'only-root')
    expect(await ops.undoCommit(repo)).toBe('root')
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

  it('guards network commands against dead connections only, and not over the user\'s own limits', async () => {
    const repo = makeRepo()
    expect(await stallGuards(repo)).toMatchObject({ GIT_HTTP_LOW_SPEED_LIMIT: '1', GIT_HTTP_LOW_SPEED_TIME: '300' })
    sh(repo, 'config', 'http.lowSpeedTime', '30')
    sh(repo, 'config', 'core.sshCommand', 'plink -batch')
    expect(await stallGuards(repo)).toEqual({})
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
