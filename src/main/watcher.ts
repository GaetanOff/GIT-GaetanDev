import { watch, type FSWatcher } from 'node:fs'
import type { RepoChangeEvent } from '@shared/types'

/** Git metadata whose change means refs, HEAD, the index or an operation moved. */
const META = /^\.git[\\/](index|HEAD|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|packed-refs|refs[\\/]|rebase-(merge|apply)|logs[\\/]refs[\\/]stash)/
const IGNORED = /^\.git[\\/](objects|logs|hooks|info|lfs|modules)[\\/]|\.lock$/

/**
 * Watches the open repository and reports changes, coalesced so a burst
 * (a build, a checkout) costs one refresh.
 */
export class RepoWatcher {
  private watcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null
  private kinds = new Set<'worktree' | 'meta'>()
  private repo: string | null = null

  constructor(private emit: (e: RepoChangeEvent) => void) {}

  set(repo: string | null): void {
    if (repo === this.repo) return
    this.close()
    this.repo = repo
    if (!repo) return
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
      this.kinds.add('meta')
    } else {
      this.kinds.add('worktree')
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 250)
  }

  private flush(): void {
    if (!this.repo || !this.kinds.size) return
    this.emit({ repo: this.repo, kinds: [...this.kinds] })
    this.kinds.clear()
  }

  close(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.timer) clearTimeout(this.timer)
    this.kinds.clear()
  }
}
