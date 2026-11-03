// Renders build/icon.png (512×512) from HTML: the SSH Console gradient with the branch glyph.
// Run with: npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron')
const { writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

const html = `<!doctype html><html><body style="margin:0;background:transparent">
<div style="width:512px;height:512px;border-radius:112px;overflow:hidden;position:relative;
  background:linear-gradient(135deg,#111827 0%,#155e75 55%,#15803d 100%)">
  <div style="position:absolute;width:300px;height:300px;border-radius:50%;background:#5eead4;opacity:.22;filter:blur(60px);top:-60px;right:-60px"></div>
  <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
    <svg width="300" height="300" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M6 3v12 M18 9a3 3 0 100-6 3 3 0 000 6z M6 21a3 3 0 100-6 3 3 0 000 6z M18 9a9 9 0 01-9 9"/>
    </svg>
  </div>
</div></body></html>`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } })
  win.webContents.setZoomFactor(1)
  await win.loadURL(`data:text/html,${encodeURIComponent(html)}`)
  await new Promise(r => setTimeout(r, 400))
  const image = (await win.webContents.capturePage()).resize({ width: 512, height: 512 })
  mkdirSync(join(__dirname, '..', 'build'), { recursive: true })
  writeFileSync(join(__dirname, '..', 'build', 'icon.png'), image.toPNG())
  app.quit()
})
