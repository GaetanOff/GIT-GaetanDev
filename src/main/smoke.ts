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
  // Started means the interface got past its loading screen. The page's root always holds the
  // window's frame, which also shows "could not start" (a preload that did not run, the main process
  // refusing the page, app:state failing) or a spinner that never ends: those passed all the same.
  const check = `(() => {
    if (!window.gdg) return 'the preload did not run'
    if (!document.querySelector('.shell')) return 'starting'
    const failed = document.querySelector('.boot.failed')
    if (failed) return 'it says: ' + failed.textContent
    return document.querySelector('.boot') ? 'starting' : 'ok'
  })()`
  win.webContents.once('did-finish-load', async () => {
    let state = 'starting'
    for (const end = Date.now() + 30_000; state === 'starting' && Date.now() < end;) {
      await new Promise(resolve => setTimeout(resolve, 500))
      state = await win.webContents.executeJavaScript(check).catch((e: Error) => `the page could not be checked: ${e.message}`)
    }
    clearTimeout(timer)
    if (state !== 'ok') return fail(4, `the interface did not start (${state === 'starting' ? 'still loading after 30 seconds' : state})`)
    console.log('Smoke test passed.')
    app.exit(0)
  })
}
