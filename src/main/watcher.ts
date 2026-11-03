import { watch, type FSWatcher } from 'node:fs'
import type { RepoChangeEvent } from '@shared/types'
import { IgnoreCache } from './git/perf'

/** Git metadata whose change means refs, HEAD, the index or an operation moved. */
const META = /^\.git[\\/](index|HEAD|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|packed-refs|refs[\\/]|rebase-(merge|apply)|logs[\\/]refs[\\/]stash)/
const IGNORED = /^\.git[\\/](objects|logs|hooks|info|lfs|modules)[\\/]|\.lock$/

/** Quiet time before a burst is reported, and the longest a steady stream of events can hold it back. */
const SETTLE_MS = 250
const MAX_WAIT_MS = 1000
const RETRY_MS = 2000

/**
 * Watches the open repository and reports changes, coalesced so a burst
 * (a build, a checkout) costs one refresh. Working-tree changes that
 * `.gitignore` excludes (node_modules, build output…) are dropped, so a build
 * or an install never triggers a status refresh.
 */
export class RepoWatcher {
  private watcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null
  private retry: NodeJS.Timeout | null = null
  /** When the pending burst started: past MAX_WAIT_MS, new events no longer push the report back. */
  private since = 0
  private meta = false
  /** The OS dropped events (buffer overflow): anything may have changed. */
  private overflow = false
  private paths = new Set<string>()
  private repo: string | null = null
  private ignore: IgnoreCache | null = null

  constructor(private emit: (e: RepoChangeEvent) => void) {}

  set(repo: string | null): void {
    if (repo === this.repo && (this.watcher || this.retry)) return
    this.close()
    this.repo = repo
    if (!repo) return
    this.ignore = new IgnoreCache(repo)
    this.start(repo)
  }

  private start(repo: string): void {
    try {
      this.watcher = watch(repo, { recursive: true }, (_event, name) => this.onChange(name?.toString() ?? ''))
      // The folder was renamed, deleted or became unreadable: try again shortly, and refresh meanwhile.
      this.watcher.on('error', () => this.restartLater(repo))
    } catch {
      this.watcher = null // unsupported filesystem: focus-based refresh still works
    }
  }

  private restartLater(repo: string): void {
    this.watcher?.close()
    this.watcher = null
    this.overflow = true
    this.schedule()
    if (this.retry) clearTimeout(this.retry)
    this.retry = setTimeout(() => {
      this.retry = null
      if (this.repo === repo) this.start(repo)
    }, RETRY_MS)
  }

  private onChange(name: string): void {
    if (!name) {
      // No file name: the OS overflowed and lost track of what changed.
      this.overflow = true
      return this.schedule()
    }
    if (IGNORED.test(name)) return
    if (name === '.git' || name.startsWith('.git\\') || name.startsWith('.git/')) {
      if (!META.test(name)) return
      this.meta = true
      // A new .gitignore or a checkout can change what is ignored.
      if (/^\.git[\\/](HEAD|index)$/.test(name)) this.ignore?.clear()
    } else {
      const path = name.replace(/\\/g, '/')
      if (path === '.gitignore' || path.endsWith('/.gitignore')) this.ignore?.clear()
      // Inside a folder already known to be ignored (build output being written): not even a delay.
      else if (this.ignore?.knownIgnored(path)) return
      if (this.paths.size < 2000) this.paths.add(path)
    }
    this.schedule()
  }

  private schedule(): void {
    const now = Date.now()
    if (!this.timer) this.since = now
    else if (now - this.since >= MAX_WAIT_MS) return // let the pending report go out
    else clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), SETTLE_MS)
  }

  private async flush(): Promise<void> {
    this.timer = null
    const repo = this.repo
    if (!repo) return
    const meta = this.meta || this.overflow
    const overflow = this.overflow
    const paths = [...this.paths]
    this.meta = false
    this.overflow = false
    this.paths.clear()
    // Thousands of events (a checkout) mean a real change: skip the ignore check.
    const relevant = overflow || paths.length >= 2000 ? paths : await (this.ignore?.filter(paths) ?? Promise.resolve(paths))
    if (repo !== this.repo) return
    const kinds: RepoChangeEvent['kinds'] = []
    if (meta) kinds.push('meta')
    if (overflow || relevant.length) kinds.push('worktree')
    if (kinds.length) this.emit({ repo, kinds })
  }

  close(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.timer) clearTimeout(this.timer)
    if (this.retry) clearTimeout(this.retry)
    this.timer = null
    this.retry = null
    this.meta = false
    this.overflow = false
    this.paths.clear()
    this.ignore = null
    // Forget the repo too, so set() with the same one watches it again.
    this.repo = null
  }
}
