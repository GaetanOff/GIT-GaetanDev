import { api } from './api'
import type { IconName } from './icons'
import { app } from './state.svelte'
import { confirm, openDialog, openPalette, overlays, prompt, toast } from './ui.svelte'

export interface Command {
  id: string
  title: string
  group: 'Repository' | 'Branch' | 'Sync' | 'Changes' | 'View' | 'App'
  icon: IconName
  /** e.g. "mod+shift+p"; `mod` is Ctrl on Windows/Linux and ⌘ on macOS. */
  keys?: string
  when?: () => boolean
  run: () => unknown
}

const hasRepo = () => !!app.repo
const onBranch = () => !!app.status?.branch
const hasRemote = () => app.refs.remotes.length > 0

export async function pickAndAddRepo(): Promise<void> {
  const path = await api['dialog:pickFolder']('Add a local repository')
  if (path) await app.addRepo(path)
}

export async function pickAndInitRepo(): Promise<void> {
  const path = await api['dialog:pickFolder']('Choose a folder for the new repository')
  if (path) await app.initRepo(path)
}

export async function discardAll(): Promise<void> {
  if (!app.repo) return
  // The paths belong to this repo: never discard them in another one opened meanwhile.
  const repo = app.repo.path
  const paths = app.files.filter(f => !f.conflicted).map(f => f.path)
  if (!paths.length) return
  const ok = await confirm({
    title: 'Discard all changes?',
    message: `This drops every staged and unstaged change in ${paths.length} file(s). The current version of each file goes to the recycle bin.`,
    confirmLabel: 'Discard all',
    danger: true,
  })
  if (ok) await app.run('Discarding', () => api['git:discard'](repo, paths))
}

/**
 * Soft-resets the last commit. `ask` confirms first (the keyboard shortcut,
 * which is easy to press by accident); `repoId` ties the call to the repo a
 * toast was shown for, so it never undoes a commit in another tab; `sha` is the
 * commit it named, so a commit made after it is never the one taken back.
 */
export async function undoLastCommit(opts: { ask?: boolean; repoId?: string; sha?: string } = {}): Promise<void> {
  if (!app.repo || !app.status?.hasCommits) return
  // The commit the user means: the toast's, or HEAD as shown before any dialog opens.
  const expect = opts.sha ?? app.status.head ?? undefined
  if (opts.repoId && opts.repoId !== app.repo.id) {
    toast('info', 'That commit was made in another tab. Switch back to it to undo it.')
    return
  }
  // This repo and its draft, even if another tab is in front once the dialog closes or git answers.
  const repo = app.repo.path
  const draft = app.draft
  const ahead = app.status.upstream ? app.status.ahead : 1
  if (!ahead) {
    const ok = await confirm({
      title: 'Undo a pushed commit?',
      message: 'The last commit is already on the remote. Undoing it rewrites history, and you will need to force push.',
      confirmLabel: 'Undo anyway',
      danger: true,
    })
    if (!ok) return
  } else if (opts.ask) {
    const last = await api['git:lastCommitMessage'](repo).catch(() => '')
    const ok = await confirm({
      title: 'Undo the last commit?',
      message: `“${last.split('\n')[0]}” is removed from the branch. Its changes stay staged.`,
      confirmLabel: 'Undo commit',
    })
    if (!ok) return
  }
  const message = await app.run('Undoing commit', () => api['git:undoCommit'](repo, expect))
  if (message === undefined) return
  // Never replace a message being written; otherwise bring the commit's back.
  const writing = !!(draft.summary.trim() || draft.body.trim())
  if (!writing) {
    const [summary, ...rest] = message.split('\n')
    Object.assign(draft, { summary, body: rest.join('\n').trim(), amend: false })
  }
  if (app.repo?.path === repo) app.view = 'changes'
  toast('info', writing
    ? 'Last commit undone. Its changes are staged; the message you were writing was kept.'
    : 'Last commit undone. Its changes are staged and its message is back in the commit box.')
}

export async function renameCurrentBranch(): Promise<void> {
  const b = app.status?.branch
  if (!b || !app.repo) return
  const repo = app.repo.path
  const name = await prompt({ title: 'Rename branch', label: 'New name', value: b, confirmLabel: 'Rename', mono: true, validate: validateBranchName })
  if (name && name !== b) await app.run('Renaming branch', () => api['git:renameBranch'](repo, b, name))
}

export function validateBranchName(name: string): string | null {
  if (!name.trim()) return 'A name is required.'
  if (/\s/.test(name)) return 'Branch names cannot contain spaces.'
  if (/(^[./-])|([./]$)|\.\.|[~^:?*[\\]|@\{|\/\/|\.lock$/.test(name)) return 'This is not a valid Git branch name.'
  return null
}

/** Turns "Fix login bug" into "fix-login-bug" as the user types. */
export function sanitizeBranchName(name: string): string {
  return name.replace(/\s+/g, '-').replace(/[~^:?*[\\]+/g, '-').replace(/-{2,}/g, '-')
}

export const COMMANDS: Command[] = [
  { id: 'palette', title: 'Command palette', group: 'App', icon: 'command', keys: 'mod+k', run: () => openPalette('all') },
  { id: 'palette2', title: 'Command palette', group: 'App', icon: 'command', keys: 'mod+shift+p', run: () => openPalette('all') },
  { id: 'repos', title: 'Switch repository…', group: 'Repository', icon: 'repo', keys: 'mod+t', run: () => (overlays.repoMenu = true) },
  { id: 'branches', title: 'Switch branch…', group: 'Branch', icon: 'branch', keys: 'mod+b', when: hasRepo, run: () => (overlays.branchMenu = true) },
  { id: 'files', title: 'Go to changed file…', group: 'Changes', icon: 'file', keys: 'mod+p', when: hasRepo, run: () => openPalette('files') },
  { id: 'add', title: 'Add local repository…', group: 'Repository', icon: 'folder', keys: 'mod+o', run: pickAndAddRepo },
  { id: 'importGithubDesktop', title: 'Import repositories from GitHub Desktop', group: 'Repository', icon: 'download', run: () => app.importGithubDesktop() },
  { id: 'clone', title: 'Clone repository…', group: 'Repository', icon: 'download', keys: 'mod+shift+o', run: () => openDialog({ kind: 'clone' }) },
  { id: 'init', title: 'Create new repository…', group: 'Repository', icon: 'plus', run: pickAndInitRepo },
  { id: 'changes', title: 'Show changes', group: 'View', icon: 'changes', keys: 'mod+1', when: hasRepo, run: () => (app.view = 'changes') },
  { id: 'history', title: 'Show history', group: 'View', icon: 'history', keys: 'mod+2', when: hasRepo, run: () => (app.view = 'history') },
  { id: 'fetch', title: 'Fetch all remotes', group: 'Sync', icon: 'fetch', keys: 'mod+shift+f', when: () => hasRepo() && hasRemote(), run: () => app.fetch() },
  { id: 'pull', title: 'Pull', group: 'Sync', icon: 'pull', keys: 'mod+shift+l', when: () => onBranch() && !!app.status?.upstream, run: () => app.pull() },
  { id: 'push', title: 'Push', group: 'Sync', icon: 'push', keys: 'mod+shift+u', when: () => onBranch() && hasRemote(), run: () => app.push() },
  { id: 'forcePush', title: 'Force push (with lease)', group: 'Sync', icon: 'push', when: () => onBranch() && !!app.status?.upstream, run: async () => {
    const id = app.repo?.id
    const ok = await confirm({ title: 'Force push?', message: 'This overwrites the remote branch with your local one. It fails safely if someone pushed in the meantime.', confirmLabel: 'Force push', danger: true })
    if (ok && app.stillOn(id)) await app.push(true)
  } },
  { id: 'newBranch', title: 'New branch…', group: 'Branch', icon: 'plus', keys: 'mod+shift+n', when: hasRepo, run: () => openDialog({ kind: 'branch' }) },
  { id: 'renameBranch', title: 'Rename current branch…', group: 'Branch', icon: 'edit', when: onBranch, run: renameCurrentBranch },
  { id: 'pr', title: 'Create pull request', group: 'Branch', icon: 'pr', keys: 'mod+shift+r', when: () => onBranch() && !!app.provider, run: () => app.openProvider({ type: 'pr', branch: app.status!.branch! }) },
  { id: 'openWeb', title: 'Open repository on the web', group: 'Repository', icon: 'globe', keys: 'mod+shift+g', when: () => hasRepo() && !!app.provider, run: () => app.openProvider({ type: 'repo' }) },
  { id: 'fileHistory', title: 'History of the selected file', group: 'Changes', icon: 'history', keys: 'mod+shift+h', when: () => !!app.selected && !!app.status?.hasCommits, run: () => app.openFile(app.selected!.path, 'history') },
  { id: 'blame', title: 'Blame the selected file', group: 'Changes', icon: 'user', keys: 'mod+shift+b', when: () => !!app.selected && !!app.status?.hasCommits, run: () => app.openFile(app.selected!.path, 'blame') },
  { id: 'stash', title: 'Stash all changes…', group: 'Changes', icon: 'stash', keys: 'mod+shift+s', when: () => app.files.length > 0, run: () => openDialog({ kind: 'stash' }) },
  { id: 'discardAll', title: 'Discard all changes…', group: 'Changes', icon: 'trash', keys: 'mod+shift+backspace', when: () => app.files.length > 0, run: discardAll },
  { id: 'undo', title: 'Undo last commit', group: 'Changes', icon: 'undo', keys: 'mod+z', when: () => !!app.status?.hasCommits && app.view !== 'history' && !isTyping(), run: () => undoLastCommit({ ask: true }) },
  { id: 'explorer', title: 'Show in Explorer', group: 'Repository', icon: 'folder', keys: 'mod+shift+e', when: hasRepo, run: () => api['shell:reveal'](app.repo!.path) },
  { id: 'editor', title: 'Open in editor', group: 'Repository', icon: 'code', keys: 'mod+shift+a', when: hasRepo, run: () => api['shell:editor'](app.repo!.path).catch(e => toast('error', e.message)) },
  { id: 'terminal', title: 'Open in terminal', group: 'Repository', icon: 'terminal', keys: 'mod+`', when: hasRepo, run: () => api['shell:terminal'](app.repo!.path).catch(e => toast('error', e.message)) },
  { id: 'refresh', title: 'Refresh', group: 'Repository', icon: 'fetch', keys: 'f5', when: hasRepo, run: () => app.refreshAll() },
  { id: 'addRemote', title: 'Add remote…', group: 'Repository', icon: 'cloud', when: hasRepo, run: () => openDialog({ kind: 'remote' }) },
  { id: 'undoHistory', title: 'Show undo history', group: 'View', icon: 'undo', keys: 'mod+3', when: hasRepo, run: () => (app.view = 'undo') },
  { id: 'undoOp', title: 'Undo last operation (checkout, merge, rebase, reset…)', group: 'Repository', icon: 'undo', keys: 'mod+shift+z', when: () => hasRepo() && !isTyping(), run: undoLastOperation },
  { id: 'rebase', title: 'Edit history (interactive rebase)…', group: 'Branch', icon: 'edit', keys: 'mod+alt+r', when: onBranch, run: startRebase },
  { id: 'compare', title: 'Compare branches…', group: 'Branch', icon: 'split', keys: 'mod+alt+c', when: hasRepo, run: () => app.openCompare(defaultBase(), app.status?.branch ?? 'HEAD') },
  { id: 'syntax', title: 'Toggle syntax highlighting', group: 'View', icon: 'code', run: () => app.updateSettings({ syntaxHighlight: !app.settings.syntaxHighlight }) },
  { id: 'nextTab', title: 'Next repository tab', group: 'Repository', icon: 'repo', keys: 'mod+tab', when: () => app.tabs.length > 1, run: () => app.cycleTab(1) },
  { id: 'prevTab', title: 'Previous repository tab', group: 'Repository', icon: 'repo', keys: 'mod+shift+tab', when: () => app.tabs.length > 1, run: () => app.cycleTab(-1) },
  { id: 'closeTab', title: 'Close repository tab', group: 'Repository', icon: 'x', keys: 'mod+w', when: hasRepo, run: () => app.closeTab(app.repo!.id) },
  { id: 'worktree', title: 'New worktree…', group: 'Branch', icon: 'tree', when: () => hasRepo() && !!app.status?.hasCommits, run: () => openDialog({ kind: 'worktree' }) },
  { id: 'submodules', title: 'Update submodules', group: 'Repository', icon: 'download', when: () => app.refs.submodules.length > 0, run: () => app.run('Updating submodules', () => api['git:submoduleUpdate'](app.repo!.path, null)) },
  { id: 'lfsPull', title: 'Download Git LFS objects', group: 'Sync', icon: 'cloud', when: () => app.refs.lfs.used && app.refs.lfs.installed, run: () => app.run('Downloading LFS objects', () => api['git:lfsPull'](app.repo!.path)) },
  { id: 'settings', title: 'Settings', group: 'App', icon: 'cog', keys: 'mod+,', run: () => openDialog({ kind: 'settings' }) },
  { id: 'shortcuts', title: 'Keyboard shortcuts', group: 'App', icon: 'command', keys: 'mod+/', run: () => openDialog({ kind: 'shortcuts' }) },
]

/** The branch most work is compared against: the remote default, else main/master/develop. */
export function defaultBase(): string {
  const names = app.refs.branches.map(b => b.name)
  return ['origin/main', 'origin/master', 'origin/develop', 'main', 'master', 'develop'].find(n => names.includes(n) && n !== app.status?.branch) ?? 'HEAD~1'
}

/** Rebase the commits not pushed yet, or the last ten when there is no upstream. */
function startRebase(): void {
  const st = app.status
  if (st?.upstream && st.ahead) app.openRebase(st.upstream, `${st.ahead} unpushed commit${st.ahead > 1 ? 's' : ''} on ${st.branch}`)
  else app.openRebase('HEAD~10', 'the last 10 commits')
}

export async function undoLastOperation(): Promise<void> {
  if (!app.repo) return
  const { id, path } = app.repo
  const ops = await api['git:operations'](path)
  const op = ops[0]
  if (!op?.before.sha) return void toast('info', 'Nothing to undo.')
  const ok = await confirm({
    title: `Undo “${op.title}”?`,
    message: `Go back to ${op.before.branch ?? 'detached HEAD'} at ${op.before.sha.slice(0, 7)}. Uncommitted changes are kept, and you can redo.`,
    confirmLabel: 'Undo',
  })
  if (ok) await app.restore(op.before, `before “${op.title}”`, id)
}

export function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

const PUNCTUATION = new Set([',', '/', '`', '.', ';'])

export function eventKeys(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('mod')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  // Matched by the character typed, so "Ctrl+," is the key that types a comma on any layout
  // (on AZERTY, not the key that sits where QWERTY has its comma).
  let k = e.key.toLowerCase()
  // Digits by position: the top row, whether the layout needs Shift for them (AZERTY) or not.
  if (e.code.startsWith('Digit')) k = e.code.slice(5)
  // A dead key (` on many layouts) types nothing by itself: fall back to its position.
  else if (k === 'dead' && e.code === 'Backquote') k = '`'
  // Punctuation some layouts only reach with Shift ("/" on AZERTY) still matches without it.
  if (PUNCTUATION.has(k) && parts.at(-1) === 'shift') parts.pop()
  parts.push(k)
  return parts.join('+')
}

/** "mod+shift+p" → ["Ctrl", "Shift", "P"] for display. */
export function keyLabels(keys: string, mac: boolean): string[] {
  return keys.split('+').map(k => {
    if (k === 'mod') return mac ? '⌘' : 'Ctrl'
    if (k === 'shift') return mac ? '⇧' : 'Shift'
    if (k === 'alt') return mac ? '⌥' : 'Alt'
    if (k === 'backspace') return '⌫'
    return k.length === 1 ? k.toUpperCase() : k.toUpperCase()
  })
}
