import { app, type BrowserWindow } from 'electron'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `--smoke`: the packaged app starts, loads its page, checks the interface
 * mounted, then quits with 0 (or another code saying what failed). CI runs
 * the installer's build this way: a broken asar, fuse or protocol showed only
 * once released, in an app that could then not update itself out of it.
 */
export const smoke = process.argv.includes('--smoke')

/** A throwaway profile, so a check never reads or writes the user's repositories and settings. */
export function smokeProfile(): void {
  // One folder for every run, replaced each time: a folder per run piled up on CI machines and here.
  if (smoke) app.setPath('userData', join(tmpdir(), 'gdg-smoke'))
}

export function smokeTest(win: BrowserWindow): void {
  if (!smoke) return
  const fail = (code: number, why: string) => {
    console.error(`Smoke test failed: ${why}`)
    app.exit(code)
  }
  const timer = setTimeout(() => fail(3, 'the page did not load within 60 seconds'), 60_000)
  win.webContents.on('console-message', e => { if (e.level === 'error') console.error('[renderer]', e.message) })
  win.webContents.once('did-fail-load', (_e, code, description) => fail(1, `the page failed to load (${code} ${description})`))
  win.webContents.once('render-process-gone', (_e, details) => fail(2, `the page crashed (${details.reason})`))
  win.webContents.once('did-finish-load', async () => {
    await new Promise(resolve => setTimeout(resolve, 1500))
    const mounted = await win.webContents.executeJavaScript("!!document.getElementById('app')?.children.length").catch(() => false)
    clearTimeout(timer)
    if (!mounted) return fail(4, 'the page loaded but the interface did not mount')
    console.log('Smoke test passed.')
    app.exit(0)
  })
}
