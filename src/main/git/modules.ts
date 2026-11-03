import { existsSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import type { LfsInfo, Progress, Submodule, Worktree } from '@shared/types'
import { git, gitOut } from './exec'

type Reporter = (p: Progress | null) => void

const progress = (op: string, title: string, report: Reporter) => {
  report({ op, title })
  return (line: string) => {
    const m = /^(?:remote: )?([A-Za-z ]+):\s+(\d+)%/.exec(line)
    if (m) report({ op, title, phase: m[1].trim(), percent: +m[2] })
  }
}

/* ─── Submodules ────────────────────────────────────────────────────────────── */

/**
 * Submodules from the index (gitlink entries) compared with what is checked
 * out in each folder. Much faster than `git submodule status`, a shell
 * script that spawns several processes per submodule.
 */
export async function submodules(repo: string): Promise<Submodule[]> {
  if (!existsSync(join(repo, '.gitmodules'))) return []
  const [index, config] = await Promise.all([
    git(repo, ['ls-files', '-s', '-z']).then(r => r.stdout),
    git(repo, ['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.(path|url)$'], { okCodes: [1] }).then(r => r.stdout),
  ])
  // .gitmodules maps a submodule name to its path and URL.
  const byName = new Map<string, { path?: string; url?: string }>()
  for (const line of config.split('\n')) {
    const kv = /^submodule\.(.+)\.(path|url) (.+)$/.exec(line.trim())
    if (!kv) continue
    const entry = byName.get(kv[1]) ?? {}
    entry[kv[2] as 'path' | 'url'] = kv[3]
    byName.set(kv[1], entry)
  }
  const urlByPath = new Map([...byName.values()].filter(e => e.path).map(e => [e.path!, e.url ?? '']))

  // Gitlinks have mode 160000; a stage above 0 means the submodule is in conflict.
  const links = new Map<string, { sha: string; conflict: boolean }>()
  for (const rec of index.split('\0')) {
    const t = rec.indexOf('\t')
    if (t < 0 || !rec.startsWith('160000 ')) continue
    const [, sha, stage] = rec.slice(0, t).split(' ')
    const path = rec.slice(t + 1)
    const prev = links.get(path)
    links.set(path, { sha: stage === '0' || !prev ? sha : prev.sha, conflict: stage !== '0' || !!prev?.conflict })
  }

  return Promise.all([...links].map(async ([path, link]) => {
    const dir = join(repo, path)
    let state: Submodule['state'] = 'ok'
    if (link.conflict) state = 'conflict'
    else if (!existsSync(join(dir, '.git'))) state = 'uninitialized'
    else {
      const head = await git(dir, ['rev-parse', 'HEAD'], { okCodes: [128] }).then(r => r.stdout.trim(), () => '')
      if (!head) state = 'uninitialized'
      else if (head !== link.sha) state = 'modified'
    }
    return { path, sha: link.sha, state, describe: '', url: urlByPath.get(path) ?? '' }
  }))
}

export async function submoduleUpdate(repo: string, path: string | null, report: Reporter): Promise<void> {
  try {
    await git(repo, ['submodule', 'update', '--init', '--recursive', '--progress', ...(path ? ['--', path] : [])], {
      onStderrLine: progress('submodule', path ? `Updating ${path}` : 'Updating submodules', report),
    })
  } finally {
    report(null)
  }
}

/* ─── Git LFS ───────────────────────────────────────────────────────────────── */

let lfsInstalled: boolean | null = null

export async function lfs(repo: string): Promise<LfsInfo> {
  const attrs = await readFile(join(repo, '.gitattributes'), 'utf8').catch(() => '')
  const used = /filter=lfs/.test(attrs)
  if (lfsInstalled === null) {
    lfsInstalled = await git(repo, ['lfs', 'version'], { okCodes: [1, 2, 128, 255] }).then(r => r.code === 0, () => false)
  }
  return { used, installed: lfsInstalled }
}

export async function lfsPull(repo: string, report: Reporter): Promise<void> {
  try {
    report({ op: 'lfs', title: 'Downloading LFS objects' })
    await git(repo, ['lfs', 'pull'])
  } finally {
    report(null)
  }
}

/* ─── Worktrees ─────────────────────────────────────────────────────────────── */

export async function worktrees(repo: string): Promise<Worktree[]> {
  const r = await git(repo, ['worktree', 'list', '--porcelain'], { okCodes: [128] })
  if (r.code !== 0) return []
  // Real paths: Windows short names (GAE~1.FAU) and long ones must compare equal.
  const real = (p: string) => { try { return realpathSync.native(p).toLowerCase() } catch { return normalize(p).toLowerCase() } }
  const here = real(repo)
  return r.stdout.split(/\n\n+/).filter(b => b.trim()).map(block => {
    const wt: Worktree = { path: '', head: '', branch: null, current: false, locked: false, prunable: false, bare: false }
    for (const line of block.split('\n')) {
      const [key, ...rest] = line.split(' ')
      const value = rest.join(' ')
      if (key === 'worktree') wt.path = normalize(value)
      else if (key === 'HEAD') wt.head = value
      else if (key === 'branch') wt.branch = value.replace(/^refs\/heads\//, '')
      else if (key === 'locked') wt.locked = true
      else if (key === 'prunable') wt.prunable = true
      else if (key === 'bare') wt.bare = true
    }
    wt.current = real(wt.path) === here
    return wt
  })
}

/** Adds a worktree on an existing branch, or on a new branch started from `from`. */
export async function worktreeAdd(repo: string, path: string, branch: string, create: boolean, from: string | null): Promise<void> {
  if (create) await git(repo, ['worktree', 'add', '-b', branch, path, ...(from ? [from] : [])])
  else await git(repo, ['worktree', 'add', path, branch])
}

export async function worktreeRemove(repo: string, path: string, force: boolean): Promise<void> {
  await git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), path])
  await gitOut(repo, ['worktree', 'prune'])
}
