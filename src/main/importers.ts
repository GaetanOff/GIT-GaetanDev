import { app, BrowserWindow, session } from 'electron'
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { GitError } from './git/exec'

export interface ForeignRepo {
  path: string
  /** The name the other app shows, when the user renamed it there. */
  alias: string | null
  /** The other app could not find the folder any more. */
  missing: boolean
}

/**
 * The repositories GitHub Desktop lists. It keeps them in IndexedDB (a
 * LevelDB store with compressed blocks), so the list is read the way it was
 * written: by Chromium, in a hidden window whose session points at a copy of
 * GitHub Desktop's IndexedDB folder. The copy leaves GitHub Desktop's own
 * files untouched, even while it runs.
 */
const COPY_PREFIX = 'gdg-github-desktop-'

/**
 * Removes the copies earlier imports left in the temp folder: the session
 * still held their files open when the import tried. Run at startup (no
 * session holds them then) and before each import; one still held is skipped.
 */
export function sweepImportCopies(): void {
  let names: string[] = []
  try { names = readdirSync(tmpdir()) } catch { /* unreadable */ }
  for (const name of names.filter(n => n.startsWith(COPY_PREFIX))) {
    try { rmSync(join(tmpdir(), name), { recursive: true, force: true }) } catch { /* still held */ }
  }
}

export async function githubDesktopRepos(): Promise<ForeignRepo[]> {
  const source = join(app.getPath('appData'), 'GitHub Desktop', 'IndexedDB')
  if (!existsSync(source)) throw new GitError('GitHub Desktop was not found on this computer.')

  sweepImportCopies()
  const dir = mkdtempSync(join(tmpdir(), COPY_PREFIX))
  // The page must be on the file:// origin, the one GitHub Desktop's database belongs to.
  cpSync(source, join(dir, 'IndexedDB'), { recursive: true, filter: p => basename(p) !== 'LOCK' })
  writeFileSync(join(dir, 'blank.html'), '<!doctype html><meta charset="utf-8"><title>import</title>')
  const ses = session.fromPath(dir)
  const win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true } })
  try {
    await win.loadFile(join(dir, 'blank.html'))
    const rows = (await win.webContents.executeJavaScript(`(async () => {
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open('Database')
        r.onsuccess = () => resolve(r.result)
        r.onerror = () => reject(r.error)
      })
      if (![...db.objectStoreNames].includes('repositories')) return []
      return new Promise((resolve, reject) => {
        const q = db.transaction('repositories').objectStore('repositories').getAll()
        q.onsuccess = () => resolve(q.result.map(r => ({ path: r.path, alias: r.alias ?? null, missing: !!r.missing })))
        q.onerror = () => reject(q.error)
      })
    })()`)) as ForeignRepo[]
    return rows.filter(r => typeof r.path === 'string' && r.path)
  } catch (e) {
    throw new GitError(`Could not read GitHub Desktop's repository list: ${(e as Error).message}`)
  } finally {
    win.destroy()
    // Electron keeps a session for the app's lifetime, and this one held the copy's database open:
    // each import kept its files (and the session's) until the app quit. Its storage is cleared,
    // which closes them, so the copy goes now; sweepImportCopies still catches one left held.
    await ses.clearStorageData().catch(() => undefined)
    await ses.closeAllConnections().catch(() => undefined)
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) } catch { /* swept later */ }
  }
}
