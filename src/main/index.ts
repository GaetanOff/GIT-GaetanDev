import { app, BrowserWindow, dialog, Menu, net, protocol, screen, session, shell } from 'electron'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { folderArg as launchFolder } from './args'
import { startAskPass, stopAskPass } from './askpass'
import { killRunning, setGitEnv } from './git/exec'
import { devShot } from './devshot'
import { logToFile } from './log'
import { askRenderer, openFolder, queuesBusy, registerIpc, send, setLaunchPath, settleQueues } from './ipc'
import { flush, getState, save } from './store'
import { sweepImportCopies } from './importers'
import { startUpdates } from './updater'
import { RepoWatcher } from './watcher'

app.setAppUserModelId('fr.gaetandev.git')
// Development aids (a separate profile, a dev server URL, scripted screenshots) never apply to an installed build.
const dev = !app.isPackaged
if (dev && process.env.GDG_USER_DATA) app.setPath('userData', process.env.GDG_USER_DATA)
logToFile()

process.on('unhandledRejection', reason => console.error('Unhandled rejection in main:', reason))
// One failed callback must not take every open repository down with it.
process.on('uncaughtException', error => console.error('Uncaught exception in main:', error))

/**
 * The UI is served as app://bundle/…, not from file://. Electron lets a
 * file:// page fetch any local file; a page on a scheme of its own reaches
 * its bundle only. Registered before the app is ready, as Electron requires.
 */
const APP_ORIGIN = 'app://bundle'
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

function serveBundle(): void {
  const root = join(__dirname, '../renderer')
  protocol.handle('app', request => {
    const { host, pathname } = new URL(request.url)
    const file = resolve(root, `.${decodeURIComponent(pathname)}`)
    if (host !== 'bundle' || !file.startsWith(root + sep)) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(file).toString()).catch(() => new Response('Not found', { status: 404 }))
  })
}

/** The folder the app was launched on. Development runs pass the app's own folder first, which is skipped. */
const folderArg = (argv: string[], cwd = process.cwd()) => launchFolder(argv, cwd, dev ? 2 : 1)

// A second launch hands its folder to the running instance and exits before doing anything else.
if (!app.requestSingleInstanceLock()) app.exit(0)
else start()

function start(): void {
  const watcher = new RepoWatcher(e => send('repo:changed', e))
  setLaunchPath(folderArg(process.argv))

  /** Credential prompts in the app; without them (the helper could not be written) git still runs. */
  const askpass = () => {
    try {
      setGitEnv(startAskPass(askRenderer))
    } catch (e) {
      console.error('Credential prompts unavailable:', (e as Error).message)
    }
  }

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    // The app needs no camera, microphone, location or notifications: refuse every request.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    session.defaultSession.setPermissionCheckHandler(() => false)
    askpass()
    serveBundle()
    registerIpc(watcher)
    createWindow()
    startUpdates(version => send('update:ready', version))
    setTimeout(sweepImportCopies, 5_000).unref()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        askpass()
        createWindow()
      }
    })
  }).catch(e => {
    // Without a window the process would hold the single-instance lock, and every later launch
    // would exit at once: the app would look dead until killed. Say why, and let go.
    dialog.showErrorBox('GaetanDev Git could not start', (e as Error).stack ?? String(e))
    app.exit(1)
  })

  app.on('second-instance', (_e, argv, cwd) => {
    const folder = folderArg(argv, cwd)
    const win = BrowserWindow.getAllWindows()[0]
    // Every window was closed (macOS keeps the app running): open one for this launch.
    if (!win && app.isReady()) {
      if (folder) setLaunchPath(folder)
      createWindow()
      return
    }
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
    if (folder) openFolder(folder)
  })

  app.on('window-all-closed', () => {
    watcher.close()
    if (process.platform !== 'darwin') app.quit()
  })

  // Killed mid-way, a commit, checkout or rebase leaves .git/index.lock and a half-done operation, and
  // a fetch a ref lock: quitting waits for queued git work first, ten seconds at most.
  let waited = false
  app.on('before-quit', e => {
    if (waited || !queuesBusy()) return
    e.preventDefault()
    waited = true
    settleQueues(10_000).then(() => app.quit())
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
    // An installed build takes its icon from the executable; run from a checkout, Electron's would show.
    icon: dev ? join(app.getAppPath(), 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png') : undefined,
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
  // A crashed or killed page leaves a blank window: load it again, unless it keeps crashing.
  const crashes: number[] = []
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('Renderer gone:', details.reason)
    if (details.reason === 'clean-exit' || win.isDestroyed()) return
    const now = Date.now()
    crashes.push(now)
    if (crashes.filter(t => now - t < 60_000).length <= 3) win.webContents.reload()
  })

  if (dev) devShot(win)
  if (dev && process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadURL(`${APP_ORIGIN}/index.html`)
  return win
}
