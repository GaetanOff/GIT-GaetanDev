import type { Commit, FileChange, LogQuery, Progress, Refs, RepoEntry, RepoStatus, RestorePoint, SearchMode, Settings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { api, asError, on, type AppError } from './api'
import type { Draft } from './drafts'
import { GraphBuilder, type GraphRow } from './graph'
import { choose, closeDialog, dialogs, openDialog, toast } from './ui.svelte'

export type View = 'changes' | 'history' | 'stash' | 'file' | 'rebase' | 'undo' | 'compare'
type MainView = 'changes' | 'history' | 'stash' | 'undo'
export interface FileTarget { path: string; tab: 'history' | 'blame'; rev: string | null; back: MainView }
export interface RebaseTarget { base: string | null; label: string; back: MainView }
export interface CompareTarget { base: string; head: string; threeDot: boolean; back: MainView }
export type Area = 'staged' | 'unstaged' | 'conflicted'

const PAGE = 400
/** How deep a refresh reloads a history the user scrolled through. */
const REFRESH_DEPTH = 5000

const emptyRefs = (): Refs => ({
  branches: [], tags: [], remotes: [], stashes: [], submodules: [], worktrees: [], lfs: { used: false, installed: true },
})

/** What a tab remembers while another repository is in front, so switching back is instant. */
interface TabMemory {
  status: RepoStatus | null
  refs: Refs
  commits: Commit[]
  graph: GraphRow[]
  historyDone: boolean
  view: View
  selected: AppState['selected']
  selectedCommit: string | null
  historySearch: string
  historySearchMode: SearchMode
  lastFetched: number | null
  fileTarget: FileTarget | null
  rebaseTarget: RebaseTarget | null
  compareTarget: CompareTarget | null
  selectedStash: string | null
}

class AppState {
  ready = $state(false)
  /** Why the app could not start (its state unreadable from the main process): shown instead of a spinner forever. */
  bootError = $state<string | null>(null)
  repos = $state<RepoEntry[]>([])
  repo = $state<RepoEntry | null>(null)
  settings = $state<Settings>({ ...DEFAULT_SETTINGS })
  platform = $state('win32')
  version = $state('')
  home = $state('')

  status = $state<RepoStatus | null>(null)
  refs = $state<Refs>(emptyRefs())
  /** Open repositories, as tabs, in order. */
  tabs = $state<string[]>([])
  view = $state<View>('changes')
  progress = $state<Progress | null>(null)
  lastFetched = $state<number | null>(null)

  /* Changes view */
  selected = $state<{ path: string; area: Area } | null>(null)
  multi = $state<Set<string>>(new Set())

  /* History view */
  commits = $state.raw<Commit[]>([])
  graph = $state.raw<GraphRow[]>([])
  historyDone = $state(false)
  historyLoading = $state(false)
  /** Refs moved while the history was not shown: it reloads once it is. */
  historyStale = $state(false)
  historySearch = $state('')
  historySearchMode = $state<SearchMode>('message')
  selectedCommit = $state<string | null>(null)
  /** The stash shown, by its commit: indexes shift when a stash is added or dropped. */
  selectedStash = $state<string | null>(null)

  /* File history & blame */
  fileTarget = $state<FileTarget | null>(null)
  rebaseTarget = $state<RebaseTarget | null>(null)
  compareTarget = $state<CompareTarget | null>(null)

  /* Commit drafts survive repo switches */
  drafts = $state<Record<string, Draft>>({})

  private graphBuilder = new GraphBuilder()
  private statusRuns = new Map<string, { again: boolean; done: Promise<void> }>()
  private busyLabels = $state<{ id: number; label: string }[]>([])
  private busyId = 0
  private fetchTimer: ReturnType<typeof setInterval> | null = null
  private historyToken = 0
  /** What the list in History was loaded with, for its next pages. */
  private historyQuery: { repoId: string; path: string; query: Omit<LogQuery, 'skip' | 'limit'> } | null = null
  private refsToken = 0
  private openToken = 0
  private memory = new Map<string, TabMemory>()
  private fsmonitorAsked = new Set<string>()
  /** Repositories with a background fetch running. */
  private backgroundFetches = new Set<string>()
  /** Background fetches that failed, by repository: when, and how long before the next try. */
  private fetchFailures = new Map<string, { at: number; wait: number }>()

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
  /** Label of the newest running foreground operation, which disables conflicting actions. */
  get busy(): string | null {
    return this.busyLabels.at(-1)?.label ?? null
  }

  /**
   * Marks an operation as running until the returned function is called
   * (calling it again is harmless). Overlapping operations each end their
   * own entry, so none can leave the app stuck busy.
   */
  beginBusy(label: string): () => void {
    const id = ++this.busyId
    this.busyLabels = [...this.busyLabels, { id, label }]
    return () => (this.busyLabels = this.busyLabels.filter(b => b.id !== id))
  }

  get draft() {
    return this.drafts[this.repo?.id ?? '_'] ?? { summary: '', body: '', amend: false }
  }

  /**
   * Whether the repository a dialog or a toast was about is still the one in
   * front. Both outlive a tab switch ("Open in" from Explorer brings another
   * repository forward): their answer must not land on the one shown now.
   */
  stillOn(id: string | undefined): boolean {
    if (id && this.repo?.id === id) return true
    toast('info', 'That was about another repository. Switch back to it and try again.')
    return false
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
      // Asked again after the page reloaded: once is enough.
      if (dialogs.some(x => x.kind === 'askpass' && x.id === req.id)) return
      openDialog({
        kind: 'askpass', id: req.id, prompt: req.prompt, mode: req.kind,
        resolve: v => api['askpass:respond'](req.id, v),
      })
    })
    on('askpass:cancel', ({ id, reason }) => {
      const d = dialogs.find(x => x.kind === 'askpass' && x.id === id)
      if (!d) return
      closeDialog(d)
      toast('info', reason === 'timeout'
        ? 'A credential prompt went unanswered for five minutes and was declined.'
        : 'Git stopped waiting for the credential prompt: the operation ended or was cancelled.')
    })
    on('menu', m => {
      if (m === 'focus' && this.repo) this.refreshAll()
    })

    try {
      const saved = JSON.parse(localStorage.getItem('tabs') ?? '[]') as string[]
      this.tabs = saved.filter(id => s.repos.some(r => r.id === id))
    } catch { /* no tabs yet */ }
    on('open:path', path => this.addRepo(path))
    const updateReady = (version: string) => toast('info', `Version ${version} is ready. It installs when you quit.`, {
      label: 'Restart now', run: () => api['app:installUpdate'](),
    }, 30_000)
    on('update:ready', updateReady)
    // Downloaded before this page listened (a reload, a slow start): said now.
    if (s.updateReady) updateReady(s.updateReady)
    if (s.launchPath) await this.addRepo(s.launchPath)
    else if (s.lastRepo && s.repos.some(r => r.id === s.lastRepo)) await this.openRepo(s.lastRepo).catch(() => undefined)
    this.ready = true
    this.scheduleAutoFetch()
    if (!s.git) toast('error', 'Git was not found. Install Git for Windows (git-scm.com), then restart the app.', undefined, 30_000)
    else if (!s.git.supported) toast('error', `Git ${s.git.version} is too old for this app, which needs ${s.git.minimum} or later: some views will fail. Update Git for Windows.`, undefined, 30_000)
    else if (!s.git.recommended) toast('info', `Git ${s.git.version} predates fixes for repositories that run code when cloned with submodules. Updating Git for Windows is recommended.`, undefined, 15_000)
    if (s.stateUnreadable) {
      toast('error', 'Your repository list and settings could not be read (another program may hold the file). Nothing is saved until you restart the app.', undefined, 20_000)
    }
    if (s.stateReset) {
      toast('error', `Your repository list and settings were damaged, so the app started afresh. The old file is kept as ${s.stateReset}.`, undefined, 30_000)
    }
  }

  saveDrafts(): void {
    try { localStorage.setItem('drafts', JSON.stringify(this.drafts)) } catch { /* storage unavailable */ }
  }

  /**
   * Shown at once; put back if the main process refuses it (a command change not confirmed,
   * a settings file that cannot be written), and then said. Twelve callers never caught the
   * error: the value went back without a word. `rethrow`: the caller reports it itself.
   */
  async updateSettings(patch: Partial<Settings>, opts: { rethrow?: boolean } = {}): Promise<boolean> {
    const before = { ...this.settings }
    Object.assign(this.settings, patch)
    try {
      this.settings = await api['app:settings'](patch)
    } catch (e) {
      this.settings = before
      if (opts.rethrow) throw e
      toast('error', `The setting was not saved: ${asError(e).message}`)
      return false
    }
    if ('autoFetchMinutes' in patch) this.scheduleAutoFetch()
    return true
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
    // Clicking through tabs quickly: only the last one asked for is opened.
    const t = ++this.openToken
    const entry = await api['repo:open'](id)
    if (t !== this.openToken) return
    // A tab just closed is still in front here: it has nothing to remember.
    if (this.repo && this.repo.id !== entry.id && this.tabs.includes(this.repo.id)) this.memory.set(this.repo.id, this.snapshot())
    this.drafts[entry.id] ??= { summary: '', body: '', amend: false }
    this.repo = entry
    // A history page or search still loading belongs to the repository left behind.
    this.historyToken++
    this.historyLoading = false
    if (!this.tabs.includes(entry.id)) this.tabs = [...this.tabs, entry.id]
    this.saveTabs()
    api['repo:list']().then(list => (this.repos = list)).catch(() => undefined)
    this.multi = new Set()
    this.selectedStash = null
    const mem = this.memory.get(entry.id)
    if (mem) {
      // Show the tab as it was at once; fresh data follows.
      Object.assign(this, mem)
    } else {
      this.status = null
      this.refs = emptyRefs()
      this.selected = null
      this.selectedCommit = null
      this.historySearch = ''
      this.lastFetched = null
      if (this.view !== 'changes' && this.view !== 'history') this.view = 'changes'
      this.fileTarget = null
      this.rebaseTarget = null
      this.compareTarget = null
      this.commits = []
      this.graph = []
    }
    await api['watch:set'](entry.path)
    if (t !== this.openToken) return
    await Promise.all([this.refreshStatus(), this.refreshRefs()])
    if (t !== this.openToken) return
    // History reloads here; the next refresh must not reload it again for the same HEAD.
    this.lastHead = this.headKey()
    this.reloadHistory(!!mem)
    // A quick background fetch keeps ahead/behind honest when opening a repo.
    if (this.refs.remotes.length && this.settings.autoFetchMinutes) this.fetch(true)
    this.suggestFsmonitor(entry)
  }

  /**
   * What a tab keeps while in the background. Only the first page of history:
   * coming back reloads it anyway, and a scrolled-through history can hold
   * tens of thousands of commits and graph rows per tab.
   */
  private snapshot(): TabMemory {
    return {
      status: this.status, refs: this.refs, commits: this.commits.slice(0, PAGE), graph: this.graph.slice(0, PAGE),
      historyDone: this.historyDone && this.commits.length <= PAGE,
      view: this.view, selected: this.selected, selectedCommit: this.selectedCommit, historySearch: this.historySearch,
      historySearchMode: this.historySearchMode, lastFetched: this.lastFetched,
      fileTarget: this.fileTarget, rebaseTarget: this.rebaseTarget, compareTarget: this.compareTarget, selectedStash: this.selectedStash,
    }
  }

  private saveTabs(): void {
    try { localStorage.setItem('tabs', JSON.stringify(this.tabs)) } catch { /* storage unavailable */ }
  }

  async closeTab(id: string): Promise<void> {
    const i = this.tabs.indexOf(id)
    if (i < 0) return
    this.tabs = this.tabs.filter(t => t !== id)
    this.memory.delete(id)
    this.saveTabs()
    if (this.repo?.id !== id) return
    const next = this.tabs[Math.min(i, this.tabs.length - 1)]
    if (next) await this.openRepo(next).catch(e => toast('error', asError(e).message))
    else {
      this.repo = null
      this.status = null
      this.refs = emptyRefs()
      await api['watch:set'](null)
    }
  }

  cycleTab(dir: 1 | -1): void {
    if (this.tabs.length < 2 || !this.repo) return
    const i = this.tabs.indexOf(this.repo.id)
    const next = this.tabs[(i + dir + this.tabs.length) % this.tabs.length]
    this.openRepo(next).catch(e => toast('error', asError(e).message))
  }

  moveTab(id: string, to: number): void {
    const tabs = this.tabs.filter(t => t !== id)
    tabs.splice(Math.max(0, Math.min(to, tabs.length)), 0, id)
    this.tabs = tabs
    this.saveTabs()
  }

  /** Large repositories get one suggestion to turn on Git's file system monitor. */
  private async suggestFsmonitor(entry: RepoEntry): Promise<void> {
    let asked: string[] = []
    try { asked = JSON.parse(localStorage.getItem('fsmonitor-asked') ?? '[]') } catch { /* ignore */ }
    if (asked.includes(entry.id) || this.fsmonitorAsked.has(entry.id)) return
    this.fsmonitorAsked.add(entry.id)
    const info = await api['repo:fsmonitor'](entry.path).catch(() => null)
    if (!info || info.enabled || !info.supported || info.files < 20_000) return
    try { localStorage.setItem('fsmonitor-asked', JSON.stringify([...asked, entry.id])) } catch { /* ignore */ }
    toast('info', `${entry.name} tracks ${info.files.toLocaleString('en')} files. Git's file system monitor makes status much faster here.`, {
      label: 'Turn it on', run: () => api['repo:setFsmonitor'](entry.path, true).then(() => toast('success', 'File system monitor on for this repository.')),
    }, 15_000)
  }

  /** A folder that is not a repository yet: the main process asks whether to create one. */
  async addRepo(path: string): Promise<void> {
    try {
      const entry = await api['repo:add'](path)
      await this.openRepo(entry.id)
    } catch (e) {
      const err = asError(e)
      if (err.code !== 'CANCELLED') toast('error', err.message)
    }
  }

  /** Adds the repositories GitHub Desktop lists, and says what happened. */
  async importGithubDesktop(): Promise<void> {
    const r = await this.run('Importing from GitHub Desktop', () => api['repo:importGithubDesktop'](), { refresh: false })
    if (!r) return
    this.repos = r.repos
    const parts = [
      r.added.length ? `${r.added.length} repositor${r.added.length > 1 ? 'ies' : 'y'} added` : 'No new repository',
      r.known ? `${r.known} already here` : '',
      r.skipped.length ? `${r.skipped.length} skipped (folder gone)` : '',
    ].filter(Boolean)
    toast(r.added.length ? 'success' : 'info', `GitHub Desktop: ${parts.join(', ')}.`)
    if (!this.repo && r.repos.length) await this.openRepo(r.repos[0].id).catch(() => undefined)
  }

  async initRepo(path: string): Promise<void> {
    await this.run('Creating repository', async () => {
      const entry = await api['repo:init'](path)
      await this.openRepo(entry.id)
    }, { refresh: false })
  }

  async removeRepo(id: string): Promise<void> {
    this.repos = await api['repo:remove'](id)
    // Nothing of a removed repository lingers in storage: its draft and recorded deleted branches.
    delete this.drafts[id]
    this.saveDrafts()
    try { localStorage.removeItem(`deleted-branches:${id}`) } catch { /* storage unavailable */ }
    if (this.tabs.includes(id)) return this.closeTab(id)
    if (this.repo?.id === id) {
      this.repo = null
      this.status = null
      await api['watch:set'](null)
    }
  }

  /* ─── Refresh ─────────────────────────────────────────────────────────────── */

  /**
   * Coalesced per repository: calls during a refresh of the same repo trigger
   * exactly one more, and a tab switch starts its own refresh at once rather
   * than waiting on the previous repo's, whose result it would then discard.
   */
  refreshStatus(): Promise<void> {
    const repo = this.repo
    if (!repo) return Promise.resolve()
    const running = this.statusRuns.get(repo.id)
    if (running) {
      running.again = true
      return running.done
    }
    const run = { again: false, done: Promise.resolve() }
    this.statusRuns.set(repo.id, run)
    run.done = (async () => {
      do {
        run.again = false
        try {
          const st = await api['git:status'](repo.path)
          if (this.repo?.id !== repo.id) return
          this.status = st
          this.pruneSelection()
        } catch (e) {
          if (this.repo?.id === repo.id) toast('error', asError(e).message)
          return
        }
      } while (run.again)
    })().finally(() => this.statusRuns.delete(repo.id))
    return run.done
  }

  /**
   * Watcher events, window focus, finished operations and fetches overlap:
   * only the newest call's answers are applied, so an older one arriving last
   * never puts back a branch, a count or a current branch that has changed.
   */
  async refreshRefs(): Promise<void> {
    const repo = this.repo
    if (!repo) return
    const t = ++this.refsToken
    const current = () => t === this.refsToken && this.repo?.id === repo.id
    try {
      const r = await api['git:refs'](repo.path)
      if (!current()) return
      // Keep the previous extras until fresh ones arrive, so sections do not flicker.
      this.refs = { ...r, submodules: this.refs.submodules, worktrees: this.refs.worktrees, lfs: this.refs.lfs }
      api['git:extras'](repo.path).then(x => {
        if (current()) this.refs = { ...this.refs, ...x }
      }).catch(() => undefined)
    } catch { /* status reports the error */ }
  }

  private lastHead = ''
  /**
   * What the history shows besides its commits: HEAD and the branch it names, every branch and tag.
   * A tag created or deleted, or a switch to a branch on the same commit, changed its labels (and,
   * in "All" scope, its commits) without reloading it, F5 included.
   */
  private headKey(): string {
    const refs = [...this.refs.branches.map(b => `${b.name}@${b.sha}`), ...this.refs.tags.map(t => `tag:${t.name}@${t.sha}`)]
    return `${this.repo?.id}|${this.status?.head}|${this.status?.branch}|${refs.join(',')}`
  }

  async refreshAll(): Promise<void> {
    await Promise.all([this.refreshStatus(), this.refreshRefs()])
    const head = this.headKey()
    if (head !== this.lastHead) {
      this.lastHead = head
      // Out of sight, the history reloads when it is shown again (HistoryView), not on every fetch.
      if (this.view === 'history') this.reloadHistory(true)
      else this.historyStale = true
    }
  }

  private pruneSelection(): void {
    // A file that left its area (staged, discarded) leaves the multi-selection too, so a
    // later Space or Delete never acts on files that are no longer shown there.
    if (this.multi.size) {
      const shown = new Set([
        ...this.staged.map(f => `staged\0${f.path}`),
        ...this.unstaged.map(f => `unstaged\0${f.path}`),
        ...this.conflicted.map(f => `conflicted\0${f.path}`),
      ])
      const kept = new Set([...this.multi].filter(k => shown.has(k)))
      if (kept.size !== this.multi.size) this.multi = kept
    }
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

  /**
   * `keepSelection`: a refresh of the same list (refs moved, a fetch). It keeps
   * the depth scrolled to (up to REFRESH_DEPTH) and the selected commit, even
   * one that is no longer in the list, instead of jumping back to the top.
   */
  async reloadHistory(keepSelection = false): Promise<void> {
    const token = ++this.historyToken
    this.historyStale = false
    const repo = this.repo
    if (!repo) return
    // The lanes of the new list, kept apart until it is shown: reset up front, a search git refused
    // (an invalid regex) left the old list with a flat builder, and every page after lost its graph.
    const builder = new GraphBuilder()
    builder.reset(!!this.historySearch)
    this.historyLoading = true
    const limit = keepSelection ? Math.min(Math.max(PAGE, this.commits.length), REFRESH_DEPTH) : PAGE
    const query = { scope: this.settings.historyScope, search: this.historySearch || undefined, searchMode: this.historySearchMode }
    try {
      const commits = await api['git:log'](repo.path, { ...query, skip: 0, limit })
      // Another tab may be in front by now, before its own reload started: this list is not its history.
      if (token !== this.historyToken || this.repo?.id !== repo.id) return
      this.historyQuery = { repoId: repo.id, path: repo.path, query }
      this.commits = commits
      this.graphBuilder = builder
      this.graph = builder.add(commits)
      this.historyDone = commits.length < limit
      if (!keepSelection || !this.selectedCommit) this.selectedCommit = commits[0]?.sha ?? null
    } catch (e) {
      if (token === this.historyToken) toast('error', asError(e).message)
    } finally {
      if (token === this.historyToken) this.historyLoading = false
    }
  }

  async loadMoreHistory(): Promise<void> {
    // The next page of the list shown: same repository and query as its first page. A tab
    // restored from memory, or a search typed but not run yet, must not get another list's page.
    const q = this.historyQuery
    if (this.historyDone || this.historyLoading || !q || q.repoId !== this.repo?.id) return
    const token = this.historyToken
    this.historyLoading = true
    try {
      // Each page makes git walk and sort the history again (topo order): pages double in
      // size, so scrolling through N commits costs log(N) walks rather than N / 400.
      const limit = Math.max(PAGE, this.commits.length)
      const more = await api['git:log'](q.path, { ...q.query, skip: this.commits.length, limit })
      if (token !== this.historyToken || this.repo?.id !== q.repoId) return
      this.commits = [...this.commits, ...more]
      this.graph = [...this.graph, ...this.graphBuilder.add(more)]
      this.historyDone = more.length < limit
    } catch (e) {
      // Paging runs from a scroll handler that nobody awaits: report the failure here.
      if (token === this.historyToken) toast('error', asError(e).message)
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
    // The repository the operation runs on: another tab may be in front when it fails.
    const id = this.repo?.id
    const end = this.beginBusy(label)
    try {
      const r = await fn()
      if (opts.success) toast('success', opts.success)
      return r
    } catch (e) {
      const err = asError(e)
      if (!opts.quiet) this.reportError(err, id)
      return undefined
    } finally {
      end()
      if (opts.refresh !== false) await this.refreshAll()
    }
  }

  /** `id`: the repository the failed operation ran on, so a follow-up never lands on another one. */
  private reportError(err: AppError, id: string | undefined): void {
    switch (err.code) {
      case 'CONFLICTS':
        if (this.repo?.id === id) this.view = 'changes'
        toast('error', 'Conflicts need your attention. Resolve them in the Changes view, then continue.')
        break
      case 'AUTH_FAILED':
        toast('error', `Authentication failed. Check your credentials or SSH key for this remote.\n${err.message}`)
        break
      case 'NON_FAST_FORWARD':
        toast('error', 'The remote has commits you do not have yet. Pull first, then push again.', {
          label: 'Pull now', run: () => this.stillOn(id) && this.pull(),
        })
        break
      case 'CANCELLED':
        // The user said no in a dialog: nothing to report.
        break
      default:
        toast('error', err.message)
    }
  }

  async fetch(background = false): Promise<void> {
    if (!this.repo) return
    const repo = this.repo.path
    // The time of the last fetch belongs to the repository fetched, whichever is in front by then.
    const fetched = () => { if (this.repo?.path === repo) this.lastFetched = Date.now() }
    if (background) {
      // Each tab switch asks for one, and fetches of a repository run one at a time: unchecked,
      // they would queue up in front of the user's own push or pull. One at a time, none right after another.
      const failed = this.fetchFailures.get(repo)
      if (this.backgroundFetches.has(repo) || (this.lastFetched && Date.now() - this.lastFetched < 60_000)) return
      // A fetch that failed (a credential prompt declined, no network) is not tried again at every tab
      // switch: the prompt came back each time, and offline each try held the push queued behind it.
      if (failed && Date.now() - failed.at < failed.wait) return
      this.backgroundFetches.add(repo)
      try {
        await api['git:fetch'](repo)
        this.fetchFailures.delete(repo)
      } catch (e) {
        const code = asError(e).code
        // Asked and refused: not before a good while. Otherwise twice as long each time, up to 15 minutes.
        const wait = code === 'AUTH_FAILED' || code === 'CANCELLED' ? 30 * 60_000 : Math.min((failed?.wait ?? 30_000) * 2, 15 * 60_000)
        this.fetchFailures.set(repo, { at: Date.now(), wait })
        return
      } finally {
        this.backgroundFetches.delete(repo)
      }
      fetched()
      await this.refreshAll()
      return
    }
    await this.run('Fetching', async () => {
      await api['git:fetch'](repo)
      fetched()
      // Answered by hand: background fetches go on as usual.
      this.fetchFailures.delete(repo)
    })
  }

  async pull(): Promise<void> {
    if (!this.repo) return
    const repo = this.repo.path
    await this.run('Pulling', () => api['git:pull'](repo))
    if (this.repo?.path === repo) this.lastFetched = Date.now()
  }

  async push(force = false): Promise<void> {
    if (!this.repo) return
    const { id, path: repo } = this.repo
    const publishing = !this.status?.upstream
    const branch = this.status?.branch ?? ''
    const end = this.beginBusy(publishing ? 'Publishing' : 'Pushing')
    try {
      await api['git:push'](repo, { force })
      toast('success', publishing ? `Published ${branch} to the remote.` : 'Pushed.', publishing ? {
        label: 'Create pull request', run: () => this.stillOn(id) && this.openProvider({ type: 'pr', branch }),
      } : undefined)
    } catch (e) {
      const err = asError(e)
      if (err.code === 'NON_FAST_FORWARD' && !force) {
        end()
        const choice = await choose({
          title: 'Push rejected',
          message: 'The remote branch has commits you do not have. Pull them first, or overwrite the remote with a force push (refused if it would drop commits you have not seen).',
          options: [
            { label: 'Pull', value: 'pull', variant: 'primary' },
            { label: 'Force push', value: 'force', variant: 'danger' },
          ],
        })
        if (choice && !this.stillOn(id)) return
        if (choice === 'pull') await this.pull()
        if (choice === 'force') await this.push(true)
        return
      }
      if (err.code === 'NON_FAST_FORWARD' && force) {
        // The lease held, but the remote has commits that never reached this branch's history.
        toast('error', 'Force push refused: the remote has commits you have not seen in this branch, so they would be lost. Pull or look at them first.', {
          label: 'Pull now', run: () => this.stillOn(id) && this.pull(),
        })
        return
      }
      this.reportError(err, id)
    } finally {
      end()
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
    const { id, path: repo } = this.repo
    const end = this.beginBusy(`Switching to ${branch}`)
    try {
      await api['git:checkout'](repo, branch)
    } catch (e) {
      const err = asError(e)
      if (err.code === 'LOCAL_CHANGES_OVERWRITTEN') {
        end()
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
      this.reportError(err, id)
    } finally {
      end()
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
    this.fileTarget = { path, tab, rev, back: this.mainView() }
    this.view = 'file'
  }

  closeFile(): void {
    this.view = this.fileTarget?.back ?? 'changes'
    this.fileTarget = null
  }

  /** The list view to return to when a full-screen tool (file, rebase, compare) closes. */
  private mainView(): MainView {
    const v = this.view
    if (v === 'file') return this.fileTarget?.back ?? 'changes'
    if (v === 'rebase') return this.rebaseTarget?.back ?? 'history'
    if (v === 'compare') return this.compareTarget?.back ?? 'history'
    return v
  }

  openRebase(base: string | null, label: string): void {
    this.rebaseTarget = { base, label, back: this.mainView() }
    this.view = 'rebase'
  }

  openCompare(base: string, head: string, threeDot = true): void {
    this.compareTarget = { base, head, threeDot, back: this.mainView() }
    this.view = 'compare'
  }

  closeTool(): void {
    this.view = this.mainView()
    this.fileTarget = null
    this.rebaseTarget = null
    this.compareTarget = null
  }

  /**
   * Goes back to a point of the undo history, then offers to come back (redo).
   * `id`: the repository the point was shown for, read before any dialog.
   */
  async restore(point: RestorePoint, label: string, id = this.repo?.id): Promise<void> {
    if (!this.repo || !this.stillOn(id)) return
    const repo = this.repo.path
    const prev = await this.run(`Restoring ${label}`, () => api['git:restore'](repo, point))
    if (prev) {
      toast('success', `Restored: ${label}`, { label: 'Redo', run: () => this.stillOn(id) && this.run('Redoing', () => api['git:restore'](repo, prev)) }, 10_000)
    }
  }

  copy(text: string, what = 'Copied'): void {
    api['clipboard:write'](text).then(
      () => toast('success', `${what} to clipboard.`, undefined, 1800),
      e => toast('error', `Could not copy: ${asError(e).message}`),
    )
  }
}

export const app = new AppState()
