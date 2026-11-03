import type { FileChange } from '@shared/types'
import { api } from './api'
import { basename } from './format'
import { app, type Area } from './state.svelte'
import { confirm, openDialog, prompt, toast, type MenuItem } from './ui.svelte'

const repo = () => app.repo!.path

export async function stagePaths(paths: string[]): Promise<void> {
  if (paths.length) await app.run('Staging', () => api['git:stage'](repo(), paths), { quiet: false })
}

export async function unstagePaths(paths: string[]): Promise<void> {
  if (paths.length) await app.run('Unstaging', () => api['git:unstage'](repo(), paths))
}

export async function discardPaths(paths: string[]): Promise<void> {
  if (!paths.length) return
  if (app.settings.confirmDiscard) {
    const ok = await confirm({
      title: paths.length === 1 ? `Discard changes to ${basename(paths[0])}?` : `Discard changes to ${paths.length} files?`,
      message: 'Staged and unstaged changes are dropped. New files are moved to the recycle bin.',
      details: paths.length > 1 ? paths.slice(0, 12) : undefined,
      confirmLabel: 'Discard',
      danger: true,
    })
    if (!ok) return
  }
  await app.run('Discarding', () => api['git:discard'](repo(), paths))
}

export async function ignorePattern(pattern: string): Promise<void> {
  await app.run('Updating .gitignore', () => api['git:ignore'](repo(), pattern), { success: `Added “${pattern}” to .gitignore.` })
}

export function fileMenu(file: FileChange, area: Area, selection: string[]): MenuItem[] {
  const paths = selection.includes(file.path) ? selection : [file.path]
  const many = paths.length > 1
  const ext = file.path.includes('.') ? file.path.slice(file.path.lastIndexOf('.')) : ''
  const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/') + 1) : ''
  const items: MenuItem[] = []

  if (area === 'conflicted') {
    items.push(
      { label: 'Use my version (ours)', icon: 'check', run: () => app.run('Resolving', () => api['git:resolve'](repo(), file.path, 'ours')) },
      { label: 'Use their version (theirs)', icon: 'check', run: () => app.run('Resolving', () => api['git:resolve'](repo(), file.path, 'theirs')) },
      { label: 'Mark as resolved', icon: 'check', hint: 'Stage', run: () => stagePaths([file.path]) },
      'sep',
    )
  } else if (area === 'staged') {
    items.push({ label: many ? `Unstage ${paths.length} files` : 'Unstage', icon: 'minus', run: () => unstagePaths(paths) })
  } else {
    items.push({ label: many ? `Stage ${paths.length} files` : 'Stage', icon: 'plus', run: () => stagePaths(paths) })
  }
  if (area !== 'conflicted') {
    items.push({ label: many ? `Discard ${paths.length} files…` : 'Discard changes…', icon: 'trash', danger: true, run: () => discardPaths(paths) })
    items.push({ label: many ? 'Stash these files…' : 'Stash this file', icon: 'stash', run: () => stashPaths(paths) })
  }
  items.push('sep')
  if (file.untracked) {
    items.push({ label: `Ignore ${basename(file.path)}`, icon: 'eyeOff', run: () => ignorePattern(`/${file.path}`) })
    if (ext) items.push({ label: `Ignore all *${ext} files`, icon: 'eyeOff', run: () => ignorePattern(`*${ext}`) })
    if (dir) items.push({ label: `Ignore folder ${dir}`, icon: 'eyeOff', run: () => ignorePattern(`/${dir}`) })
    items.push('sep')
  }
  if (!file.untracked && app.status?.hasCommits) {
    items.push(
      { label: 'File history', icon: 'history', hint: 'Ctrl+Shift+H', run: () => app.openFile(file.oldPath ?? file.path, 'history') },
      { label: 'Blame', icon: 'user', hint: 'Ctrl+Shift+B', run: () => app.openFile(file.path, 'blame') },
      'sep',
    )
  }
  items.push(
    { label: 'Open in editor', icon: 'code', run: () => api['shell:editor'](repo(), file.path).catch(e => toast('error', e.message)) },
    { label: 'Show in Explorer', icon: 'folder', run: () => api['shell:reveal'](repo(), file.path) },
    { label: 'Copy path', icon: 'copy', run: () => app.copy(file.path, 'Path copied') },
  )
  if (app.provider && !file.untracked && app.status?.head) {
    items.push({ label: 'Open on the web', icon: 'globe', run: () => app.openProvider({ type: 'file', ref: app.status!.head!, path: file.oldPath ?? file.path }) })
  }
  return items
}

export async function stashPaths(paths: string[]): Promise<void> {
  const message = await prompt({
    title: 'Stash files',
    message: paths.length === 1 ? paths[0] : `${paths.length} files`,
    label: 'Message (optional)',
    confirmLabel: 'Stash',
  })
  if (message === null) return
  await app.run('Stashing', () => api['git:stash'](repo(), message, true, paths), { success: 'Stashed.' })
}

export function openStashDialog(): void {
  openDialog({ kind: 'stash' })
}
