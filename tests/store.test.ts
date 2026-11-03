import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
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
})
