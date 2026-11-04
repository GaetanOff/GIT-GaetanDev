import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'

/**
 * Development aid: with GDG_SHOT=<file.png> the app captures its window once
 * the UI settles, optionally runs GDG_SHOT_JS in the page first, then quits.
 * Used to check rendering from scripts; inert in normal use.
 */
export function devShot(win: BrowserWindow): void {
  const target = process.env.GDG_SHOT
  if (!target || app.isPackaged) return
  win.webContents.once('did-finish-load', async () => {
    await new Promise(r => setTimeout(r, +(process.env.GDG_SHOT_DELAY ?? 2500)))
    if (process.env.GDG_SHOT_JS) {
      await win.webContents.executeJavaScript(process.env.GDG_SHOT_JS).catch(e => console.error('shot js failed', e))
      await new Promise(r => setTimeout(r, 1200))
    }
    const image = await win.webContents.capturePage()
    writeFileSync(target, image.toPNG())
    app.quit()
  })
  // The event's own fields: the separate arguments are deprecated (Electron warns at each start).
  win.webContents.on('console-message', e => {
    if (e.level === 'warning' || e.level === 'error') console.error('[renderer]', e.message)
  })
}
