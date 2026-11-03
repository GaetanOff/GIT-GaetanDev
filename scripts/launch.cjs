// Starts the app from this checkout the way an installed copy runs: the production
// bundles (rebuilt first when the sources are newer), no dev server, data in the
// usual %APPDATA%\GaetanDev Git. Used by `npm run app` and the desktop shortcut.
// Extra arguments are passed on (a folder opens as a repository).
const { spawn, spawnSync } = require('node:child_process')
const { existsSync, readdirSync, statSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const root = join(__dirname, '..')
const mtime = path => (existsSync(path) ? statSync(path).mtimeMs : 0)

/** Newest modification time of the files under a folder. */
function newest(dir) {
  let max = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    max = Math.max(max, entry.isDirectory() ? newest(full) : statSync(full).mtimeMs)
  }
  return max
}

const built = join(root, 'out', 'main', 'index.js')
const sources = Math.max(newest(join(root, 'src')), mtime(join(root, 'package.json')), mtime(join(root, 'electron.vite.config.ts')))
if (sources > mtime(built)) {
  const r = spawnSync(process.execPath, [join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'], { cwd: root, encoding: 'utf8' })
  if (r.status !== 0) {
    // The shortcut runs without a console: leave the reason where it can be found.
    const log = join(tmpdir(), 'gaetandev-git-launch.log')
    writeFileSync(log, `${r.stdout ?? ''}\n${r.stderr ?? ''}\n${r.error?.message ?? ''}`)
    console.error(`Build failed, see ${log}`)
    process.exit(r.status ?? 1)
  }
}

// Nothing from a development shell leaks in: no dev server URL, no scripted screenshots, no other profile.
const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (key === 'ELECTRON_RENDERER_URL' || key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('GDG_')) delete env[key]
}

const electron = require('electron') // the path of the Electron binary
spawn(electron, ['.', ...process.argv.slice(2)], { cwd: root, env, detached: true, stdio: 'ignore' }).unref()
