import type { IconName } from './icons'

/* ─── Toasts ────────────────────────────────────────────────────────────────── */

export interface Toast {
  id: number
  kind: 'success' | 'error' | 'info'
  message: string
  action?: { label: string; run: () => void }
  leaving?: boolean
}

let toastId = 0
export const toasts = $state<Toast[]>([])

/** Time left for each toast; paused while the pointer is over it. */
const timers = new Map<number, { left: number; started: number; handle: ReturnType<typeof setTimeout> | null }>()

/**
 * Shows a toast. One with an action (Undo, Pull now…) stays 10 s by default,
 * long enough to reach it, and is the last to be pushed out when more than
 * four are on screen.
 */
export function toast(kind: Toast['kind'], message: string, action?: Toast['action'], ms = action ? 10_000 : kind === 'error' ? 8000 : 3500): void {
  const t: Toast = { id: ++toastId, kind, message, action }
  toasts.push(t)
  while (toasts.length > 4) {
    const plain = toasts.findIndex(x => !x.action && x.id !== t.id)
    const [gone] = toasts.splice(plain >= 0 ? plain : 0, 1)
    clearTimer(gone.id)
  }
  timers.set(t.id, { left: ms, started: Date.now(), handle: setTimeout(() => dismissToast(t.id), ms) })
}

function clearTimer(id: number): void {
  const timer = timers.get(id)
  if (timer?.handle) clearTimeout(timer.handle)
  timers.delete(id)
}

/** Hovering a toast stops its countdown, so its action stays within reach. */
export function pauseToast(id: number): void {
  const timer = timers.get(id)
  if (!timer?.handle) return
  clearTimeout(timer.handle)
  timer.handle = null
  timer.left -= Date.now() - timer.started
}

export function resumeToast(id: number): void {
  const timer = timers.get(id)
  if (!timer || timer.handle) return
  timer.started = Date.now()
  timer.handle = setTimeout(() => dismissToast(id), Math.max(timer.left, 1500))
}

export function dismissToast(id: number): void {
  clearTimer(id)
  const t = toasts.find(x => x.id === id)
  if (!t || t.leaving) return
  t.leaving = true
  setTimeout(() => {
    const i = toasts.findIndex(x => x.id === id)
    if (i >= 0) toasts.splice(i, 1)
  }, 200)
}

/* ─── Dialogs ───────────────────────────────────────────────────────────────── */

export interface ChoiceOption<T> {
  label: string
  value: T
  variant?: 'primary' | 'secondary' | 'danger' | 'purple'
}

export type Dialog =
  | { kind: 'confirm'; title: string; message: string; details?: string[]; confirmLabel: string; danger: boolean; resolve: (v: boolean) => void }
  | { kind: 'prompt'; title: string; message?: string; label: string; value: string; placeholder?: string; confirmLabel: string; mono?: boolean; validate?: (v: string) => string | null; resolve: (v: string | null) => void }
  | { kind: 'choice'; title: string; message: string; options: ChoiceOption<unknown>[]; resolve: (v: unknown) => void }
  | { kind: 'askpass'; id: string; prompt: string; mode: 'password' | 'text' | 'confirm'; resolve: (v: string | null) => void }
  | { kind: 'clone' }
  | { kind: 'settings'; tab?: string }
  | { kind: 'branch'; from?: string; fromLabel?: string; name?: string }
  | { kind: 'tag'; sha: string }
  | { kind: 'stash' }
  | { kind: 'remote' }
  | { kind: 'shortcuts' }
  | { kind: 'worktree'; branch?: string }
  | { kind: 'output'; title: string; message?: string; text: string; actions?: { label: string; variant?: 'primary' | 'secondary' | 'danger'; run: () => void }[] }

export const dialogs = $state<Dialog[]>([])

export function openDialog(d: Dialog): void {
  dialogs.push(d)
}

export function closeDialog(d?: Dialog): void {
  const i = d ? dialogs.indexOf(d) : dialogs.length - 1
  if (i >= 0) dialogs.splice(i, 1)
}

export function confirm(opts: { title: string; message: string; details?: string[]; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise(resolve => {
    openDialog({ kind: 'confirm', confirmLabel: 'Confirm', danger: false, ...opts, resolve })
  })
}

export function prompt(opts: { title: string; message?: string; label: string; value?: string; placeholder?: string; confirmLabel?: string; mono?: boolean; validate?: (v: string) => string | null }): Promise<string | null> {
  return new Promise(resolve => {
    openDialog({ kind: 'prompt', value: '', confirmLabel: 'Save', ...opts, resolve })
  })
}

export function choose<T>(opts: { title: string; message: string; options: ChoiceOption<T>[] }): Promise<T | null> {
  return new Promise(resolve => {
    openDialog({ kind: 'choice', ...opts, resolve: resolve as (v: unknown) => void })
  })
}

/** Shows a command's full output (hook logs…), with optional follow-up actions. */
export function showOutput(title: string, text: string, message?: string, actions?: { label: string; variant?: 'primary' | 'secondary' | 'danger'; run: () => void }[]): void {
  openDialog({ kind: 'output', title, text, message, actions })
}

/* ─── Context menu ──────────────────────────────────────────────────────────── */

export type MenuItem =
  | { label: string; icon?: IconName; hint?: string; danger?: boolean; disabled?: boolean; run: () => void }
  | 'sep'

export const menu = $state<{ open: boolean; x: number; y: number; items: MenuItem[] }>({ open: false, x: 0, y: 0, items: [] })

export function contextMenu(e: MouseEvent, items: MenuItem[]): void {
  e.preventDefault()
  e.stopPropagation()
  menu.items = items
  menu.x = e.clientX
  menu.y = e.clientY
  menu.open = true
}

/** The keys that open a context menu from the keyboard: the Menu key, or Shift+F10. */
export function isMenuKey(e: KeyboardEvent): boolean {
  return e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)
}

export function menuAt(el: HTMLElement, items: MenuItem[]): void {
  const r = el.getBoundingClientRect()
  menu.items = items
  menu.x = r.left
  menu.y = r.bottom + 4
  menu.open = true
}

/* ─── Overlays ──────────────────────────────────────────────────────────────── */

export const overlays = $state({ palette: false, paletteMode: 'all' as 'all' | 'branches' | 'repos' | 'files', repoMenu: false, branchMenu: false })

/**
 * Whether a dialog, the palette, a repository or branch menu, or a context
 * menu is open. Window-wide shortcuts then stay out of the way: they would
 * act behind it (focus an input outside a dialog's focus trap, close the tab
 * a menu's items belong to).
 */
export const overlayOpen = (): boolean =>
  dialogs.length > 0 || overlays.palette || overlays.repoMenu || overlays.branchMenu || menu.open

export function openPalette(mode: typeof overlays.paletteMode = 'all'): void {
  overlays.paletteMode = mode
  overlays.palette = true
}
