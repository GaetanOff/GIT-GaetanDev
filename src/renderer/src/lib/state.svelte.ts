import type { Commit, FileChange, Progress, Refs, RepoEntry, RepoStatus, Settings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { api, asError, on, type AppError } from './api'
import { GraphBuilder, type GraphRow } from './graph'
import { choose, confirm, openDialog, toast } from './ui.svelte'

export type View = 'changes' | 'history' | 'stash' | 'file'
export interface FileTarget { path: string; tab: 'history' | 'blame'; rev: string | null; back: Exclude<View, 'file'> }
export type Area = 'staged' | 'unstaged' | 'conflicted'

const PAGE = 400

class AppState {
  ready = $state(false)
  repos = $state<RepoEntry[]>([])
  repo = $state<RepoEntry | null>(null)
  settings = $state<Settings>({ ...DEFAULT_SETTINGS })
  platform = $state('win32')
  version = $state('')
  home = $state('')

  status = $state<RepoStatus | null>(null)
  refs = $state<Refs>({ branches: [], tags: [], remotes: [], stashes: [] })
  view = $state<View>('changes')
  progress = $state<Progress | null>(null)
  /** Label of the foreground operation, which disables conflicting actions. */
  busy = $state<string | null>(null)
  lastFetched = $state<number | null>(null)

  /* Changes view */
  selected = $state<{ path: string; area: Area } | null>(null)
  multi = $state<Set<string>>(new Set())

  /* History view */
  commits = $state.raw<Commit[]>([])
  graph = $state.raw<GraphRow[]>([])
  historyDone = $state(false)
  historyLoading = $state(false)
  historySearch = $state('')
  selectedCommit = $state<string | null>(null)
  selectedStash = $state<number | null>(null)

  /* File history & blame */
  fileTarget = $state<FileTarget | null>(null)

  /* Commit drafts survive repo switches */
  drafts = $state<Record<string, { summary: string; body: string; amend: boolean }>>({})

  private graphBuilder = new GraphBuilder()
  private statusRun: Promise<void> | null = null
  private statusAgain = false
  private fetchTimer: ReturnType<typeof setInterval> | null = null
  private historyToken = 0

  /* ─── Derived ─────────────────────────────────────────────────────────────── */

  get files(): FileChange[] {
    return this.status?.files ?? []
  }
  get staged(): FileChange[] {
    return this.files.filter(f => !f.conflicted && !f.untracked && f.index !== '.' && f.index !== '?')
  }
  get unstaged(): FileChange[] {
    return this.files.filter(f => !f.conflicted && (f.untracked || f.worktree !== '.'))
  }
  get conflicted(): FileChange[] {
    return this.files.filter(f => f.conflicted)
  }
  get currentBranch() {
    return this.refs.branches.find(b => b.current) ?? null
  }
  get localBranches() {
    return this.refs.branches.filter(b => !b.remote)
  }
  get remoteBranches() {
    return this.refs.branches.filter(b => b.remote)
  }
  get provider() {
    const origin = this.refs.remotes.find(r => r.name === 'origin') ?? this.refs.remotes[0]
    return origin?.provider ?? null
  }
  get draft() {
    return this.drafts[this.repo?.id ?? '_'] ?? { summary: '', body: '', amend: false }
  }

  /* ─── Lifecycle ───────────────────────────────────────────────────────────── */

  async init(): Promise<void> {
    const s = await api['app:state']()
    this.repos = s.repos
    this.settings = s.settings
    this.platform = s.platform
    this.version = s.version
    this.home = s.home
    try {
      this.drafts = JSON.parse(localStorage.getItem('drafts') ?? '{}')
    } catch { /* fresh start */ }

    on('repo:changed', e => {
      if (e.repo !== this.repo?.path) return
      if (e.kinds.includes('meta')) this.refreshAll()
      else this.refreshStatus()
    })
    on('progress', p => (this.progress = p))
    on('askpass', req => {
      openDialog({
        kind: 'askpass', id: req.id, prompt: req.prompt, mode: req.kind,
        resolve: v => api['askpass:respond'](req.id, v),
      })
    })
    on('menu', m => {
      if (m === 'focus' && this.repo) this.refreshAll()
    })

    if (s.lastRepo && s.repos.some(r => r.id === s.lastRepo)) await this.openRepo(s.lastRepo).catch(() => undefined)
    this.ready = true
    this.scheduleAutoFetch()
  }

  saveDrafts(): void {
    try { localStorage.setItem('drafts', JSON.stringify(this.drafts)) } catch { /* storage unavailable */ }
  }

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    Object.assign(this.settings, patch)
    this.settings = await api['app:settings'](patch)
    if ('autoFetchMinutes' in patch) this.scheduleAutoFetch()
  }

  private scheduleAutoFetch(): void {
    if (this.fetchTimer) clearInterval(this.fetchTimer)
    const min = this.settings.autoFetchMinutes
    if (!min) return
    this.fetchTimer = setInterval(() => {
      if (this.repo && !this.busy && this.refs.remotes.length && document.visibilityState === 'visible') this.fetch(true)
    }, min * 60_000)
  }

  /* ─── Repositories ────────────────────────────────────────────────────────── */

  async openRepo(id: string): Promise<void> {
    const entry = await api['repo:open'](id)
    this.drafts[entry.id] ??= { summary: '', body: '', amend: false }
    this.repo = entry
    this.repos = await api['repo:list']()
    this.status = null
    this.refs = { branches: [], tags: [], remotes: [], stashes: [] }
    this.selected = null
    this.multi = new Set()
    this.selectedCommit = null
    this.selectedStash = null
    this.historySearch = ''
    this.lastFetched = null
    if (this.view === 'stash' || this.view === 'file') this.view = 'changes'
    this.fileTarget = null
    this.commits = []
    this.graph = []
    await api['watch:set'](entry.path)
    await Promise.all([this.refreshStatus(), this.refreshRefs()])
    this.reloadHistory()
    // A quick background fetch keeps ahead/behind honest when opening a repo.
    if (this.refs.remotes.length && this.settings.autoFetchMinutes) this.fetch(true)
  }

  async addRepo(path: string): Promise<void> {
    try {
      const entry = await api['repo:add'](path)
      await this.openRepo(entry.id)
    } catch (e) {
      const err = asError(e)
      if (err.code === 'NOT_A_REPO') {
        const ok = await confirm({
          title: 'Not a Git repository',
          message: `“${path}” is not a Git repository yet. Initialise one here?`,
          confirmLabel: 'Create repository',
        })
        if (ok) await this.initRepo(path)
      } else toast('error', err.message)
    }
  }

  async initRepo(path: string): Promise<void> {
    await this.run('Creating repository', async () => {
      const entry = await api['repo:init'](path)
      await this.openRepo(entry.id)
    }, { refresh: false })
  }

  async removeRepo(id: string): Promise<void> {
    this.repos = await api['repo:remove'](id)
    if (this.repo?.id === id) {
      this.repo = null
      this.status = null
      await api['watch:set'](null)
    }
  }

  /* ─── Refresh ─────────────────────────────────────────────────────────────── */

  /** Coalesced: calls during a refresh trigger exactly one more. */
  refreshStatus(): Promise<void> {
    if (this.statusRun) {
      this.statusAgain = true
      return this.statusRun
    }
    const repo = this.repo
    if (!repo) return Promise.resolve()
    this.statusRun = (async () => {
      do {
        this.statusAgain = false
        try {
          const st = await api['git:status'](repo.path)
          if (this.repo?.id !== repo.id) return
          this.status = st
          this.pruneSelection()
        } catch (e) {
          if (this.repo?.id === repo.id) toast('error', asError(e).message)
          return
        }
      } while (this.statusAgain)
    })().finally(() => (this.statusRun = null))
    return this.statusRun
  }

  async refreshRefs(): Promise<void> {
    const repo = this.repo
    if (!repo) return
    try {
      const r = await api['git:refs'](repo.path)
      if (this.repo?.id === repo.id) this.refs = r
    } catch { /* status reports the error */ }
  }

  private lastHead = ''
  async refreshAll(): Promise<void> {
    await Promise.all([this.refreshStatus(), this.refreshRefs()])
    const head = `${this.status?.head}|${this.refs.branches.map(b => b.sha).join(',')}`
    if (head !== this.lastHead) {
      this.lastHead = head
      this.reloadHistory(true)
    }
  }

  private pruneSelection(): void {
    if (!this.selected) return
    const { path, area } = this.selected
    const list = area === 'staged' ? this.staged : area === 'conflicted' ? this.conflicted : this.unstaged
    if (list.some(f => f.path === path)) return
    // The file moved to the other area (staged ↔ unstaged): follow it.
    const other: Area = area === 'staged' ? 'unstaged' : 'staged'
    const otherList = other === 'staged' ? this.staged : this.unstaged
    if (otherList.some(f => f.path === path)) this.selected = { path, area: other }
    else this.selected = null
  }

  /* ─── History ─────────────────────────────────────────────────────────────── */

  async reloadHistory(keepSelection = false): Promise<void> {
    const token = ++this.historyToken
    this.graphBuilder.reset()
    this.historyDone = false
    const repo = this.repo
    if (!repo) return
    this.historyLoading = true
    try {
      const commits = await api['git:log'](repo.path, {
        scope: this.settings.historyScope, skip: 0, limit: PAGE, search: this.historySearch || undefined,
      })
      if (token !== this.historyToken) return
      this.commits = commits
      this.graph = this.graphBuilder.add(commits)
      this.historyDone = commits.length < PAGE
      if (!keepSelection || !commits.some(c => c.sha === this.selectedCommit)) this.selectedCommit = commits[0]?.sha ?? null
    } catch (e) {
      if (token === this.historyToken) toast('error', asError(e).message)
    } finally {
      if (token === this.historyToken) this.historyLoading = false
    }
  }

  async loadMoreHistory(): Promise<void> {
    if (this.historyDone || this.historyLoading || !this.repo) return
    const token = this.historyToken
    this.historyLoading = true
    try {
      const more = await api['git:log'](this.repo.path, {
        scope: this.settings.historyScope, skip: this.commits.length, limit: PAGE, search: this.historySearch || undefined,
      })
      if (token !== this.historyToken) return
      this.commits = [...this.commits, ...more]
      this.graph = [...this.graph, ...this.graphBuilder.add(more)]
      this.historyDone = more.length < PAGE
    } finally {
      if (token === this.historyToken) this.historyLoading = false
    }
  }

  /* ─── Operations ──────────────────────────────────────────────────────────── */

  /**
   * Runs a git operation with a busy label, then refreshes. Known failures
   * get a helpful follow-up instead of a raw error.
   */
  async run<T>(label: string, fn: () => Promise<T>, opts: { refresh?: boolean; quiet?: boolean; success?: string } = {}): Promise<T | undefined> {
    const prev = this.busy
    this.busy = label
    try {
      const r = await fn()
      if (opts.success) toast('success', opts.success)
      return r
    } catch (e) {
      const err = asError(e)
      if (!opts.quiet) this.reportError(err)
      return undefined
    } finally {
      this.busy = prev
      if (opts.refresh !== false) await this.refreshAll()
    }
  }

  private reportError(err: AppError): void {
    switch (err.code) {
      case 'CONFLICTS':
        this.view = 'changes'
        toast('error', 'Conflicts need your attention. Resolve them in the Changes view, then continue.')
        break
      case 'AUTH_FAILED':
        toast('error', `Authentication failed. Check your credentials or SSH key for this remote.\n${err.message}`)
        break
      case 'NON_FAST_FORWARD':
        toast('error', 'The remote has commits you do not have yet. Pull first, then push again.', {
          label: 'Pull now', run: () => this.pull(),
        })
        break
      default:
        toast('error', err.message)
    }
  }

  async fetch(background = false): Promise<void> {
    if (!this.repo) return
    const repo = this.repo.path
    if (background) {
      try { await api['git:fetch'](repo) } catch { return }
      this.lastFetched = Date.now()
      await this.refreshAll()
      return
    }
    await this.run('Fetching', async () => {
      await api['git:fetch'](repo)
      this.lastFetched = Date.now()
    })
  }

  async pull(): Promise<void> {
    if (!this.repo) return
    const repo = this.repo.path
    await this.run('Pulling', () => api['git:pull'](repo))
    this.lastFetched = Date.now()
  }

  async push(force = false): Promise<void> {
    if (!this.repo) return
    const repo = this.repo.path
    const publishing = !this.status?.upstream
    try {
      this.busy = publishing ? 'Publishing' : 'Pushing'
      await api['git:push'](repo, { force })
      toast('success', publishing ? `Published ${this.status?.branch} to the remote.` : 'Pushed.', publishing ? {
        label: 'Create pull request', run: () => this.openProvider({ type: 'pr', branch: this.status?.branch ?? '' }),
      } : undefined)
    } catch (e) {
      const err = asError(e)
      if (err.code === 'NON_FAST_FORWARD' && !force) {
        this.busy = null
        const choice = await choose({
          title: 'Push rejected',
          message: 'The remote branch has commits you do not have. Pull them first, or overwrite the remote with a force push (with lease: it fails if someone pushed meanwhile).',
          options: [
            { label: 'Pull', value: 'pull', variant: 'primary' },
            { label: 'Force push', value: 'force', variant: 'danger' },
          ],
        })
        if (choice === 'pull') await this.pull()
        if (choice === 'force') await this.push(true)
        return
      }
      this.reportError(err)
    } finally {
      this.busy = null
      await this.refreshAll()
    }
  }

  /** Primary sync action, like the toolbar button: publish, pull or push. */
  async sync(): Promise<void> {
    const st = this.status
    if (!st?.branch) return this.fetch()
    if (!st.upstream) return this.push()
    if (st.behind) return this.pull()
    if (st.ahead) return this.push()
    return this.fetch()
  }

  async checkout(branch: string): Promise<void> {
    if (!this.repo) return
    const repo = this.repo.path
    try {
      this.busy = `Switching to ${branch}`
      await api['git:checkout'](repo, branch)
    } catch (e) {
      const err = asError(e)
      if (err.code === 'LOCAL_CHANGES_OVERWRITTEN') {
        this.busy = null
        const choice = await choose({
          title: 'You have uncommitted changes',
          message: `Switching to “${branch}” would overwrite local changes. Stash them first? You can bring them back from the Stashes section.`,
          options: [{ label: 'Stash and switch', value: 'stash', variant: 'primary' }],
        })
        if (choice === 'stash') {
          await this.run(`Switching to ${branch}`, () => api['git:checkout'](repo, branch, { stash: true }), {
            success: `Changes stashed. Now on ${branch}.`,
          })
        }
        return
      }
      this.reportError(err)
    } finally {
      this.busy = null
      this.selected = null
      await this.refreshAll()
    }
  }

  async openProvider(link: Parameters<typeof api['provider:url']>[1]): Promise<void> {
    if (!this.repo) return
    const url = await api['provider:url'](this.repo.path, link)
    if (url) await api['shell:openUrl'](url)
    else toast('info', 'This repository has no remote with a web page.')
  }

  /** Opens the history or blame of one file; Back returns to the current view. */
  openFile(path: string, tab: 'history' | 'blame', rev: string | null = null): void {
    const back = this.view === 'file' ? this.fileTarget?.back ?? 'changes' : this.view
    this.fileTarget = { path, tab, rev, back }
    this.view = 'file'
  }

  closeFile(): void {
    this.view = this.fileTarget?.back ?? 'changes'
    this.fileTarget = null
  }

  copy(text: string, what = 'Copied'): void {
    api['clipboard:write'](text)
    toast('success', `${what} to clipboard.`, undefined, 1800)
  }
}

export const app = new AppState()
