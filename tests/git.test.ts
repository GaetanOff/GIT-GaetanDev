import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { selectionFingerprint } from '@shared/types'
import { cleanup, commit, makeRepo, sh, write } from './helpers'

/** The recycle bin, in tests: a file "moved to the trash" is renamed next to itself. */
const trashed: string[] = []
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
const { conflict } = await import('../src/main/git/conflict')
const { refs } = await import('../src/main/git/refs')
const { git, assertRefName } = await import('../src/main/git/exec')

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
    expect(readFileSync(join(repo, 'a.txt.trashed'), 'utf8')).toBe('work in progress\n')
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

  it('lists remotes whose URL has spaces', async () => {
    const repo = makeRepo()
    commit(repo, 'base')
    sh(repo, 'remote', 'add', 'local', 'C:/My Repos/x.git')
    const r = await refs(repo)
    expect(r.remotes.find(x => x.name === 'local')?.fetchUrl).toBe('C:/My Repos/x.git')
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
