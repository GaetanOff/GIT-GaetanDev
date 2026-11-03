import { app, BrowserWindow, Menu, screen, shell } from 'electron'
import { join } from 'node:path'
import { startAskPass, stopAskPass } from './askpass'
import { setGitEnv } from './git/exec'
import { devShot } from './devshot'
import { askRenderer, registerIpc, send } from './ipc'
import { getState, save } from './store'
import { RepoWatcher } from './watcher'

app.setAppUserModelId('fr.gaetandev.git')
// Development aids (a separate profile, a dev server URL, scripted screenshots) never apply to an installed build.
const dev = !app.isPackaged
if (dev && process.env.GDG_USER_DATA) app.setPath('userData', process.env.GDG_USER_DATA)
if (!app.requestSingleInstanceLock()) app.quit()

const watcher = new RepoWatcher(e => send('repo:changed', e))

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

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  setGitEnv(startAskPass(askRenderer))
  registerIpc(watcher)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
})

app.on('window-all-closed', () => {
  watcher.close()
  stopAskPass()
  if (process.platform !== 'darwin') app.quit()
})
