import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { RepoChangeEvent } from '@shared/types'
import { gitFolders, RepoWatcher } from '../src/main/watcher'
import { worktrees } from '../src/main/git/modules'
import { cleanup, commit, makeRepo, sh } from './helpers'

afterAll(cleanup)

/** Waits until `check` holds, or fails after `ms`. */
async function until(check: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

describe('repository watcher', () => {
  it('finds the git folders of a linked worktree', () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'a\n' })
    const wt = join(repo, '..', 'wt')
    sh(repo, 'worktree', 'add', '-q', wt)
    const f = gitFolders(wt)
    // Git writes the long form of a path the temp folder gives in its short (8.3) form.
    const real = (p: string | null | undefined) => realpathSync.native(p ?? '').toLowerCase()
    expect(real(f?.dir)).toBe(real(join(repo, '.git', 'worktrees', 'wt')))
    expect(real(f?.common)).toBe(real(join(repo, '.git')))
    expect(gitFolders(repo)).toBeNull()
  })

  it('lists worktrees, paths with spaces included', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'a\n' })
    sh(repo, 'worktree', 'add', '-q', '-b', 'my-wt', join(repo, '..', 'my wt'))
    const list = await worktrees(repo)
    expect(list.map(w => [w.path.endsWith('my wt'), w.branch, w.current])).toEqual([[false, 'main', true], [true, 'my-wt', false]])
  })

  it('reports a commit made from the command line in a linked worktree', async () => {
    const repo = makeRepo()
    commit(repo, 'base', { 'a.txt': 'a\n' })
    const wt = join(repo, '..', 'wt')
    sh(repo, 'worktree', 'add', '-q', wt)
    const events: RepoChangeEvent[] = []
    const watcher = new RepoWatcher(e => events.push(e))
    watcher.set(wt)
    try {
      await new Promise(resolve => setTimeout(resolve, 300))
      events.length = 0
      sh(wt, 'commit', '-q', '--allow-empty', '-m', 'from the CLI')
      await until(() => events.some(e => e.kinds.includes('meta')))
    } finally {
      watcher.close()
    }
  })

  it('keeps trying to watch a folder that stays away for a while', () => {
    vi.useFakeTimers()
    const root = mkdtempSync(join(tmpdir(), 'gdg-watch-'))
    const repo = join(root, 'repo')
    mkdirSync(repo)
    const watcher = new RepoWatcher(() => undefined)
    const inside = watcher as unknown as { watcher: unknown; restartLater(repo: string): void }
    try {
      watcher.set(repo)
      expect(inside.watcher).not.toBeNull()
      // The watch fails (a network share drops), and the folder is still gone at the first retry.
      inside.restartLater(repo)
      rmSync(repo, { recursive: true, force: true })
      vi.advanceTimersByTime(2_000)
      expect(inside.watcher).toBeNull()
      // Back later: watched again, with no need to reopen the repository.
      mkdirSync(repo)
      vi.advanceTimersByTime(60_000)
      expect(inside.watcher).not.toBeNull()
    } finally {
      watcher.set(null)
      vi.useRealTimers()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
