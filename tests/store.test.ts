import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const userData = mkdtempSync(join(tmpdir(), 'gdg-store-'))
vi.mock('electron', () => ({ app: { getPath: () => userData } }))
afterAll(() => rmSync(userData, { recursive: true, force: true }))

describe('saved state', () => {
  it('starts empty without writing over a state.json it cannot read', async () => {
    // A folder in its place: reading fails with something other than "missing".
    mkdirSync(join(userData, 'state.json'))
    const store = await import('../src/main/store')
    expect(store.getState().repos).toEqual([])
    expect(store.stateUnreadable()).toBe(true)
    store.upsertRepo('C:/repos/x')
    store.flush()
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(statSync(join(userData, 'state.json')).isDirectory()).toBe(true)
  })

  it('drops hand-edited settings a setting may not hold', async () => {
    rmSync(join(userData, 'state.json'), { recursive: true, force: true })
    writeFileSync(join(userData, 'state.json'), JSON.stringify({ repos: [], settings: { diffContext: 2.5, editorCommand: null, pullMode: 'rebase', autoFetchMinutes: -1 } }))
    vi.resetModules()
    const store = await import('../src/main/store')
    const s = store.getState().settings
    expect([s.diffContext, s.editorCommand, s.pullMode, s.autoFetchMinutes]).toEqual([3, '', 'rebase', 5])
  })

  it('says when a damaged state.json was set aside, and repairs half-written entries', async () => {
    writeFileSync(join(userData, 'state.json'), '{"repos": [')
    vi.resetModules()
    const damaged = await import('../src/main/store')
    expect(damaged.getState().repos).toEqual([])
    expect(damaged.stateReset()).toMatch(/state\.corrupt-\d+\.json$/)
    writeFileSync(join(userData, 'state.json'), JSON.stringify({ repos: [{ id: 'a', path: 'C:/repos/app', pinned: 'yes' }, { id: 'b' }] }))
    vi.resetModules()
    const store = await import('../src/main/store')
    expect(store.getState().repos).toEqual([{ id: 'a', path: 'C:/repos/app', name: 'app', lastOpened: 0 }])
    expect(store.stateReset()).toBeNull()
  })
})
