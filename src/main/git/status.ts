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

export async function status(repo: string): Promise<RepoStatus> {
  const [out, dir] = await Promise.all([
    gitOut(repo, ['status', '--porcelain=v2', '--branch', '--show-stash', '-z', '--untracked-files=all', '--ignore-submodules=dirty']),
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
        conflicted: true, untracked: false, conflictCode: f[1],
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
