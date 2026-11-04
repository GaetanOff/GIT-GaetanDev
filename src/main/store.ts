import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs'
import { open, rename, rm } from 'node:fs/promises'
import { basename, join, normalize } from 'node:path'
import { DEFAULT_SETTINGS, isSettingKey, validSetting, type RepoEntry, type Settings } from '@shared/types'

interface State {
  repos: RepoEntry[]
  lastRepo: string | null
  settings: Settings
  window?: { x?: number; y?: number; width: number; height: number; maximized: boolean }
}

const file = () => join(app.getPath('userData'), 'state.json')

/** Saved settings, each one kept only if it is a value the setting may hold (a hand edit may not be). */
function validSettings(saved: unknown): Settings {
  const settings = { ...DEFAULT_SETTINGS }
  if (!saved || typeof saved !== 'object') return settings
  for (const [key, value] of Object.entries(saved)) {
    if (isSettingKey(key) && validSetting(key, value)) (settings as Record<string, unknown>)[key] = value
  }
  return settings
}
const fresh = (): State => ({ repos: [], lastRepo: null, settings: { ...DEFAULT_SETTINGS } })

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES'])

/**
 * Set when state.json exists but cannot be read: the app starts empty, and
 * nothing is saved, so the file is still there once whatever held it lets go.
 */
let unreadable = false

/** Blocks the main process briefly: only while reading state.json at startup. */
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function load(): State {
  let text: string
  for (let attempt = 1; ; attempt++) {
    try {
      text = readFileSync(file(), 'utf8')
      break
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? ''
      if (code === 'ENOENT') return fresh() // first launch
      // Held by an antivirus or a sync client: a few retries, then start without it rather than over it.
      if (attempt < 5 && RETRYABLE.has(code)) {
        pause(100 * attempt)
        continue
      }
      unreadable = true
      console.error('Could not read settings, nothing will be saved this session:', (e as Error).message)
      return fresh()
    }
  }
  try {
    const raw = JSON.parse(text) as Partial<State>
    const isRepo = (r: unknown): r is RepoEntry =>
      !!r && typeof (r as RepoEntry).id === 'string' && typeof (r as RepoEntry).path === 'string'
    return {
      repos: Array.isArray(raw.repos) ? raw.repos.filter(isRepo) : [],
      lastRepo: typeof raw.lastRepo === 'string' ? raw.lastRepo : null,
      settings: validSettings(raw.settings),
      window: raw.window && typeof raw.window === 'object' ? raw.window : undefined,
    }
  } catch {
    // Unreadable: set it aside instead of overwriting it with defaults on the next save.
    try { renameSync(file(), join(app.getPath('userData'), `state.corrupt-${Date.now()}.json`)) } catch { /* keep going */ }
    return fresh()
  }
}

let state: State | null = null
let saveTimer: NodeJS.Timeout | null = null
let writing: Promise<void> = Promise.resolve()
let seq = 0
let inFlight = 0

export function getState(): State {
  state ??= load()
  return state
}

/** Whether state.json could not be read at startup (and so is never written this session). */
export function stateUnreadable(): boolean {
  getState()
  return unreadable
}

/**
 * Atomic write: the data goes to a temporary file of its own, is flushed to
 * disk, then replaces state.json, so a crash never leaves a truncated file.
 * An antivirus or sync client briefly holding state.json gets a few retries.
 */
async function write(): Promise<void> {
  const data = JSON.stringify(getState(), null, 2)
  const tmp = `${file()}.${process.pid}-${++seq}.tmp`
  const fh = await open(tmp, 'w')
  try {
    await fh.writeFile(data, 'utf8')
    await fh.sync()
  } finally {
    await fh.close()
  }
  for (let attempt = 1; ; attempt++) {
    try {
      return await rename(tmp, file())
    } catch (e) {
      if (attempt >= 5 || !RETRYABLE.has((e as NodeJS.ErrnoException).code ?? '')) {
        await rm(tmp, { force: true })
        throw e
      }
      await new Promise(r => setTimeout(r, 60 * attempt))
    }
  }
}

/** Debounced; writes run one after another, and a failure is logged rather than lost silently. */
export function save(): void {
  if (unreadable) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    inFlight++
    writing = writing.then(write).catch(e => console.error('Could not save settings:', (e as Error).message)).finally(() => inFlight--)
  }, 200)
}

/**
 * Writes the state at once, synchronously, if a save is pending or still
 * being written: called on quit, when neither a timer nor an async write
 * would get to finish.
 */
export function flush(): void {
  if ((!saveTimer && !inFlight) || !state || unreadable) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  const tmp = `${file()}.${process.pid}-${++seq}.tmp`
  try {
    const fd = openSync(tmp, 'w')
    try {
      writeSync(fd, JSON.stringify(state, null, 2))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, file())
  } catch (e) {
    rmSync(tmp, { force: true })
    console.error('Could not save settings on quit:', (e as Error).message)
  }
}

const samePath = (a: string, b: string) => normalize(a).toLowerCase() === normalize(b).toLowerCase()

/** The real path, so "C:\Users\GAE~1.FAU\x" and "C:/Users/gae.faucher/x" compare equal. */
function real(path: string): string {
  try { return realpathSync.native(path) } catch { return path }
}

/** Whether a path is one of the repositories the user added. */
export function isRegistered(path: string): boolean {
  const repos = getState().repos
  if (repos.some(r => samePath(r.path, path))) return true
  const target = real(path)
  return repos.some(r => samePath(real(r.path), target))
}

export function upsertRepo(path: string): RepoEntry {
  const s = getState()
  let entry = s.repos.find(r => samePath(r.path, path))
  if (!entry) {
    entry = { id: randomUUID(), path: normalize(path), name: basename(path), lastOpened: Date.now() }
    s.repos.push(entry)
  }
  entry.lastOpened = Date.now()
  s.lastRepo = entry.id
  save()
  return entry
}

/** Adds a repository to the list without opening it (imports). */
export function addRepoEntry(path: string, name?: string): RepoEntry {
  const entry: RepoEntry = { id: randomUUID(), path: normalize(path), name: name || basename(path), lastOpened: 0 }
  getState().repos.push(entry)
  save()
  return entry
}

export function repoById(id: string): RepoEntry {
  const r = getState().repos.find(x => x.id === id)
  if (!r) throw new Error('Repository not found. It may have been removed.')
  return r
}

export function removeRepo(id: string): RepoEntry[] {
  const s = getState()
  s.repos = s.repos.filter(r => r.id !== id)
  if (s.lastRepo === id) s.lastRepo = null
  save()
  return s.repos
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const s = getState()
  s.settings = { ...s.settings, ...patch }
  save()
  return s.settings
}
