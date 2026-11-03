import { watch, type FSWatcher } from 'node:fs'
import type { RepoChangeEvent } from '@shared/types'
import { IgnoreCache } from './git/perf'

/** Git metadata whose change means refs, HEAD, the index or an operation moved. */
const META = /^\.git[\\/](index|HEAD|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|packed-refs|refs[\\/]|rebase-(merge|apply)|logs[\\/]refs[\\/]stash)/
const IGNORED = /^\.git[\\/](objects|logs|hooks|info|lfs|modules)[\\/]|\.lock$/

/**
 * Watches the open repository and reports changes, coalesced so a burst
 * (a build, a checkout) costs one refresh. Working-tree changes that
 * `.gitignore` excludes (node_modules, build output…) are dropped, so a build
 * or an install never triggers a status refresh.
 */
export class RepoWatcher {
  private watcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null
  private meta = false
  private paths = new Set<string>()
  private repo: string | null = null
  private ignore: IgnoreCache | null = null

  constructor(private emit: (e: RepoChangeEvent) => void) {}

  set(repo: string | null): void {
    if (repo === this.repo) return
    this.close()
    this.repo = repo
    if (!repo) return
    this.ignore = new IgnoreCache(repo)
    try {
      this.watcher = watch(repo, { recursive: true }, (_event, name) => this.onChange(name?.toString() ?? ''))
      this.watcher.on('error', () => this.close())
    } catch {
      this.watcher = null // unsupported filesystem: focus-based refresh still works
    }
  }

  private onChange(name: string): void {
    if (!name || IGNORED.test(name)) return
    if (name === '.git' || name.startsWith('.git\\') || name.startsWith('.git/')) {
      if (!META.test(name)) return
      this.meta = true
      // A new .gitignore or a checkout can change what is ignored.
      if (/^\.git[\\/](HEAD|index)$/.test(name)) this.ignore?.clear()
    } else {
      const path = name.replace(/\\/g, '/')
      if (path === '.gitignore' || path.endsWith('/.gitignore')) this.ignore?.clear()
      if (this.paths.size < 2000) this.paths.add(path)
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 250)
  }

  private async flush(): Promise<void> {
    const repo = this.repo
    if (!repo) return
    const meta = this.meta
    const paths = [...this.paths]
    this.meta = false
    this.paths.clear()
    // Thousands of events (a checkout) mean a real change: skip the ignore check.
    const relevant = paths.length >= 2000 ? paths : await (this.ignore?.filter(paths) ?? Promise.resolve(paths))
    if (repo !== this.repo) return
    const kinds: RepoChangeEvent['kinds'] = []
    if (meta) kinds.push('meta')
    if (relevant.length) kinds.push('worktree')
    if (kinds.length) this.emit({ repo, kinds })
  }

  close(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.timer) clearTimeout(this.timer)
    this.meta = false
    this.paths.clear()
    this.ignore = null
  }
}
