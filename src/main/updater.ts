import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { smoke } from './smoke'

const SIX_HOURS = 6 * 60 * 60_000

/**
 * Installed builds look for a newer GitHub release at startup and every six
 * hours, download it in the background and install it on quit. `onReady`
 * lets the window offer to restart now. Development runs never check.
 */
let ready: string | null = null
/** The version downloaded and waiting to install, for a page that was not listening yet when it came. */
export const updateReady = (): string | null => ready

export function startUpdates(onReady: (version: string) => void): void {
  // A start-up check (--smoke) downloads nothing.
  if (!app.isPackaged || smoke) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  // Offline, or no release yet: try again at the next check, quietly.
  autoUpdater.on('error', e => console.error('Update check failed:', e.message))
  // A newer release found while one waits: electron-updater drops the waiting file to download it,
  // and if that download fails nothing is left to install.
  autoUpdater.on('update-available', () => { ready = null })
  autoUpdater.on('update-downloaded', info => {
    ready = info.version
    onReady(info.version)
  })
  const check = () => autoUpdater.checkForUpdates().catch(() => undefined)
  check()
  setInterval(check, SIX_HOURS).unref()
}

/** Quits and installs the update already downloaded. */
export function installUpdate(): void {
  autoUpdater.quitAndInstall()
}
