import { existsSync, statSync } from 'node:fs'
import { app, BrowserWindow, Menu, screen, session, shell } from 'electron'
import { join, resolve } from 'node:path'
import { startAskPass, stopAskPass } from './askpass'
import { killRunning, setGitEnv } from './git/exec'
import { devShot } from './devshot'
import { askRenderer, registerIpc, send, setLaunchPath } from './ipc'
import { flush, getState, save } from './store'
import { startUpdates } from './updater'
import { RepoWatcher } from './watcher'

app.setAppUserModelId('fr.gaetandev.git')
// Development aids (a separate profile, a dev server URL, scripted screenshots) never apply to an installed build.
const dev = !app.isPackaged
if (dev && process.env.GDG_USER_DATA) app.setPath('userData', process.env.GDG_USER_DATA)

process.on('unhandledRejection', reason => console.error('Unhandled rejection in main:', reason))

/**
 * A folder given on the command line ("Open with", a shortcut, `gaetandev-git .`):
 * the first argument that names an existing directory. Development runs pass
 * the app's own folder first, which is skipped.
 */
function folderArg(argv: string[], cwd = process.cwd()): string | null {
  for (const arg of argv.slice(dev ? 2 : 1)) {
    if (arg.startsWith('-')) continue
    const full = resolve(cwd, arg)
    try { if (existsSync(full) && statSync(full).isDirectory()) return full } catch { /* unreadable */ }
  }
  return null
}

// A second launch hands its folder to the running instance and exits before doing anything else.
if (!app.requestSingleInstanceLock()) app.exit(0)
else start()

function start(): void {
  const watcher = new RepoWatcher(e => send('repo:changed', e))
  setLaunchPath(folderArg(process.argv))

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    // The app needs no camera, microphone, location or notifications: refuse every request.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    session.defaultSession.setPermissionCheckHandler(() => false)
    setGitEnv(startAskPass(askRenderer))
    registerIpc(watcher)
    createWindow()
    startUpdates(version => send('update:ready', version))
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        setGitEnv(startAskPass(askRenderer))
        createWindow()
      }
    })
  })

  app.on('second-instance', (_e, argv, cwd) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
    const folder = folderArg(argv, cwd)
    if (folder) send('open:path', folder)
  })

  app.on('window-all-closed', () => {
    watcher.close()
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('will-quit', () => {
    stopAskPass()
    // Clones, fetches and pushes in flight would otherwise outlive the app and keep files locked.
    killRunning()
    flush()
  })
}

function boundsFromState() {
  const w = getState().window
  const fallback = { width: 1400, height: 880 }
  if (!w) return fallback
  const visible = w.x !== undefined && w.y !== undefined && screen.getAllDisplays().some(d => {
    const a = d.workArea
    return w.x! >= a.x - 50 && w.y! >= a.y - 50 && w.x! < a.x + a.width && w.y! < a.y + a.height
  })
  return visible ? { x: w.x, y: w.y, width: w.width, height: w.height } : { width: w.width, height: w.height }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...boundsFromState(),
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b1117',
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : { color: '#00000000', symbolColor: '#9ca3af', height: 44 },
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
    },
  })

  if (getState().window?.maximized) win.maximize()
  win.once('ready-to-show', () => win.show())

  const remember = () => {
    const s = getState()
    const maximized = win.isMaximized()
    const b = maximized ? s.window ?? win.getNormalBounds() : win.getBounds()
    s.window = { x: b.x, y: b.y, width: b.width, height: b.height, maximized }
    save()
  }
  win.on('resized', remember)
  win.on('moved', remember)
  win.on('maximize', remember)
  win.on('unmaximize', remember)

  // Links open in the browser; the app never navigates away from itself.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })
  win.on('focus', () => win.webContents.send('menu', 'focus'))

  if (dev) devShot(win)
  if (dev && process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}
