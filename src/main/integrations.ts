import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Runs a user-configured command line detached, with `{path}` or a trailing argument. */
function launch(command: string, target: string, cwd: string): void {
  const line = command.includes('{path}') ? command.replaceAll('{path}', `"${target}"`) : `${command} "${target}"`
  const child = spawn(line, { cwd, shell: true, detached: true, stdio: 'ignore', windowsHide: false })
  child.on('error', () => undefined)
  child.unref()
}

function onPath(exe: string): boolean {
  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  return dirs.some(d => exts.some(e => d && existsSync(join(d, exe + e))))
}

const EDITORS = ['code', 'cursor', 'code-insiders', 'codium', 'zed', 'subl', 'rider64', 'idea64', 'notepad++']

export function openEditor(command: string, repo: string, target: string): void {
  const cmd = command.trim() || EDITORS.find(onPath)
  if (!cmd) throw new Error('No editor found. Set one in Settings → Integrations (e.g. "code").')
  launch(cmd, target, repo)
}

export function openTerminal(command: string, repo: string): void {
  if (command.trim()) return launch(command, repo, repo)
  if (process.platform === 'win32') {
    const wt = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'wt.exe')
    if (existsSync(wt)) return launch(`"${wt}" -d`, repo, repo)
    const child = spawn('cmd.exe', ['/c', 'start', 'powershell.exe', '-NoExit'], { cwd: repo, detached: true, stdio: 'ignore' })
    return child.unref()
  }
  if (process.platform === 'darwin') return launch('open -a Terminal', repo, repo)
  launch('x-terminal-emulator --working-directory', repo, repo)
}
