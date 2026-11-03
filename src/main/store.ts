import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { basename, join, normalize } from 'node:path'
import { DEFAULT_SETTINGS, type RepoEntry, type Settings } from '@shared/types'

interface State {
  repos: RepoEntry[]
  lastRepo: string | null
  settings: Settings
  window?: { x?: number; y?: number; width: number; height: number; maximized: boolean }
}

const file = () => join(app.getPath('userData'), 'state.json')

function load(): State {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<State>
    return {
      repos: raw.repos ?? [],
      lastRepo: raw.lastRepo ?? null,
      settings: { ...DEFAULT_SETTINGS, ...raw.settings },
      window: raw.window,
    }
  } catch {
    return { repos: [], lastRepo: null, settings: { ...DEFAULT_SETTINGS } }
  }
}

let state: State | null = null
let saveTimer: NodeJS.Timeout | null = null

export function getState(): State {
  state ??= load()
  return state
}

/** Debounced atomic write: a crash mid-save never leaves a truncated file. */
export function save(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    const tmp = `${file()}.tmp`
    await writeFile(tmp, JSON.stringify(getState(), null, 2), 'utf8')
    await rename(tmp, file())
  }, 200)
}

const samePath = (a: string, b: string) => normalize(a).toLowerCase() === normalize(b).toLowerCase()

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
