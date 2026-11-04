import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { FileChange, RepoOperation, RepoStatus, StatusChar } from '@shared/types'
import { git, gitOut } from './exec'

const gitDirs = new Map<string, string>()

/** Absolute path of the repository's git dir (handles worktrees and submodules). */
export async function gitDir(repo: string): Promise<string> {
  const cached = gitDirs.get(repo)
  if (cached) return cached
  const dir = (await gitOut(repo, ['rev-parse', '--git-dir'])).trim()
  const abs = isAbsolute(dir) ? dir : join(repo, dir)
  gitDirs.set(repo, abs)
  return abs
}

/**
 * Untracked files, listed one by one, unless the repository says not to list
 * them: status.showUntrackedFiles=no is what large monorepos set to keep
 * status fast, and forcing "all" over it scanned the whole tree at every
 * refresh. Read again at most every 30 seconds.
 */
const untrackedMode = new Map<string, { mode: string; at: number }>()
async function untracked(repo: string): Promise<string> {
  const known = untrackedMode.get(repo)
  if (known && Date.now() - known.at < 30_000) return known.mode
  const value = (await git(repo, ['config', '--get', 'status.showUntrackedFiles'], { okCodes: [1] })).stdout.trim().toLowerCase()
  const mode = value === 'no' || value === 'false' ? 'no' : 'all'
  untrackedMode.set(repo, { mode, at: Date.now() })
  return mode
}

/**
 * Status runs without optional locks (it never writes the index while the
 * user's own git may), so the stat data of files only touched was never
 * saved, and each of them was hashed again at every refresh of a large
 * repository. Once a minute per repository, status may update the index as
 * a plain `git status` does: only when the lock is free, never waiting.
 */
const indexRefreshed = new Map<string, number>()
function mayRefreshIndex(repo: string): boolean {
  const last = indexRefreshed.get(repo) ?? 0
  if (Date.now() - last < 60_000) return false
  indexRefreshed.set(repo, Date.now())
  return true
}

export async function status(repo: string): Promise<RepoStatus> {
  const env = mayRefreshIndex(repo) ? { GIT_OPTIONAL_LOCKS: '1' } : undefined
  const [out, dir] = await Promise.all([
    untracked(repo).then(mode => gitOut(repo, ['status', '--porcelain=v2', '--branch', '--show-stash', '-z', `--untracked-files=${mode}`, '--ignore-submodules=dirty'], { env })),
    gitDir(repo),
  ])
  const result: RepoStatus = {
    branch: null, head: null, upstream: null, ahead: 0, behind: 0, files: [],
    operation: null, hasCommits: true, stashCount: 0,
  }

  const tokens = out.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (!t) continue
    if (t.startsWith('# ')) {
      const [key, ...rest] = t.slice(2).split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') {
        result.hasCommits = value !== '(initial)'
        result.head = result.hasCommits ? value : null
      } else if (key === 'branch.head') result.branch = value === '(detached)' ? null : value
      else if (key === 'branch.upstream') result.upstream = value
      else if (key === 'branch.ab') {
        const m = /\+(\d+) -(\d+)/.exec(value)
        if (m) { result.ahead = +m[1]; result.behind = +m[2] }
      } else if (key === 'stash') result.stashCount = +value
      continue
    }

    const kind = t[0]
    if (kind === '?') {
      result.files.push({ path: t.slice(2), index: '.', worktree: '?', conflicted: false, untracked: true })
    } else if (kind === '1') {
      const f = t.split(' ')
      result.files.push(entry(f[1], f.slice(8).join(' '), f[2]))
    } else if (kind === '2') {
      const f = t.split(' ')
      const change = entry(f[1], f.slice(9).join(' '), f[2])
      change.oldPath = tokens[++i]
      result.files.push(change)
    } else if (kind === 'u') {
      const f = t.split(' ')
      result.files.push({
        path: f.slice(10).join(' '), index: 'U', worktree: 'U',
        conflicted: true, untracked: false, conflictCode: f[1], submodule: f[2].startsWith('S') || undefined,
      })
    }
  }

  Object.assign(result, operation(dir))
  return result
}

function entry(xy: string, path: string, sub: string): FileChange {
  return {
    path,
    index: xy[0] as StatusChar,
    worktree: xy[1] as StatusChar,
    conflicted: false,
    untracked: false,
    submodule: sub.startsWith('S') || undefined,
  }
}

export function operation(dir: string): { operation: RepoOperation; operationStep?: string } {
  const has = (p: string) => existsSync(join(dir, p))
  if (has('rebase-merge') || has('rebase-apply')) {
    const base = has('rebase-merge') ? 'rebase-merge' : 'rebase-apply'
    const read = (f: string) => { try { return readFileSync(join(dir, base, f), 'utf8').trim() } catch { return '' } }
    const step = read(base === 'rebase-merge' ? 'msgnum' : 'next')
    const end = read(base === 'rebase-merge' ? 'end' : 'last')
    // rebase-apply also holds a "git am" session, marked by "applying": continued and aborted with am.
    const op = base === 'rebase-apply' && has('rebase-apply/applying') ? 'am' : 'rebase'
    return { operation: op, operationStep: step && end ? `${step}/${end}` : undefined }
  }
  if (has('MERGE_HEAD')) return { operation: 'merge' }
  if (has('CHERRY_PICK_HEAD')) return { operation: 'cherry-pick' }
  if (has('REVERT_HEAD')) return { operation: 'revert' }
  // Several commits picked or reverted, one stopped on a conflict and was then committed by hand:
  // CHERRY_PICK_HEAD is gone, but the rest still waits in the sequencer for "--continue".
  const todo = (() => { try { return readFileSync(join(dir, 'sequencer', 'todo'), 'utf8') } catch { return '' } })()
  const next = todo.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#')) ?? ''
  if (/^(?:p|pick)\s/.test(next)) return { operation: 'cherry-pick' }
  if (/^revert\s/.test(next)) return { operation: 'revert' }
  return { operation: null }
}

/** True when `path` is the top level of a git working tree. */
export async function isRepo(path: string): Promise<boolean> {
  try {
    const r = await git(path, ['rev-parse', '--is-inside-work-tree'])
    return r.stdout.trim() === 'true'
  } catch {
    return false
  }
}

export async function topLevel(path: string): Promise<string> {
  return (await gitOut(path, ['rev-parse', '--show-toplevel'])).trim()
}
