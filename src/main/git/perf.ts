import { git } from './exec'

/**
 * Git's built-in file system monitor (Windows and macOS, git 2.36+) answers
 * "what changed?" from a daemon instead of scanning the tree, and the
 * untracked cache skips unchanged directories. Together they make `status`
 * fast on large repositories.
 */
export async function fsmonitorInfo(repo: string): Promise<{ enabled: boolean; supported: boolean; files: number }> {
  const [cfg, version, files] = await Promise.all([
    git(repo, ['config', '--get', 'core.fsmonitor'], { okCodes: [1] }).then(r => r.stdout.trim()),
    git(repo, ['version']).then(r => r.stdout),
    git(repo, ['ls-files', '-z']).then(r => r.raw.reduce((n, b) => (b === 0 ? n + 1 : n), 0)),
  ])
  const m = /(\d+)\.(\d+)/.exec(version)
  const recent = !!m && (+m[1] > 2 || (+m[1] === 2 && +m[2] >= 36))
  const supported = recent && (process.platform === 'win32' || process.platform === 'darwin')
  return { enabled: cfg === 'true', supported, files }
}

export async function setFsmonitor(repo: string, on: boolean): Promise<boolean> {
  if (on) {
    await git(repo, ['config', '--local', 'core.fsmonitor', 'true'])
    await git(repo, ['config', '--local', 'core.untrackedCache', 'true'])
  } else {
    await git(repo, ['config', '--local', '--unset', 'core.fsmonitor'], { okCodes: [5] })
    await git(repo, ['fsmonitor--daemon', 'stop'], { okCodes: [1, 128] }).catch(() => undefined)
  }
  return on
}

/**
 * Remembers which directories `.gitignore` excludes, so changes under
 * node_modules, build output and the like never trigger a refresh.
 */
export class IgnoreCache {
  private dirs = new Map<string, boolean>()

  constructor(private repo: string) {}

  clear(): void {
    this.dirs.clear()
  }

  /** Paths (relative, forward slashes) that are not ignored. */
  async filter(paths: string[]): Promise<string[]> {
    const unknown = new Set<string>()
    const candidates: string[] = []
    for (const p of paths) {
      const prefixes = dirPrefixes(p)
      if (prefixes.some(d => this.dirs.get(d) === true)) continue
      for (const d of prefixes) if (!this.dirs.has(d)) unknown.add(d)
      candidates.push(p)
    }
    if (!candidates.length) return []

    const query = [...unknown, ...candidates]
    const r = await git(this.repo, ['check-ignore', '-z', '--stdin'], { input: query.join('\0'), okCodes: [1] }).catch(() => null)
    if (!r) return candidates
    const ignored = new Set(r.stdout.split('\0').filter(Boolean))
    for (const d of unknown) this.dirs.set(d, ignored.has(d))
    if (this.dirs.size > 5000) this.dirs.clear()
    return candidates.filter(p => !ignored.has(p) && !dirPrefixes(p).some(d => this.dirs.get(d) === true))
  }
}

/** "a/b/c.txt" → ["a/", "a/b/"], at most four levels deep. */
function dirPrefixes(path: string): string[] {
  const parts = path.split('/')
  const out: string[] = []
  for (let i = 1; i < parts.length && i <= 4; i++) out.push(`${parts.slice(0, i).join('/')}/`)
  return out
}
