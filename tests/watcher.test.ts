import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { RepoChangeEvent } from '@shared/types'
import { gitFolders, RepoWatcher } from '../src/main/watcher'
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
})
