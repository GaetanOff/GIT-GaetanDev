import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { findOnPath } from './git/exec'

const win = process.platform === 'win32'
const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')

/**
 * Runs a user-configured command line detached, with `{path}` or a trailing
 * argument. The path reaches the shell as an environment variable, which the
 * shell substitutes without parsing it again: a file named `$(cmd)` or
 * `a&b.txt` in a cloned repo stays a file name. The shell runs in the
 * repository, so on Windows it is told not to look there for the program:
 * a `code.cmd` committed at the root would otherwise run instead of the editor.
 */
function launch(command: string, target: string, cwd: string): void {
  const ref = win ? '"%GDG_TARGET%"' : '"$GDG_TARGET"'
  const line = command.includes('{path}') ? command.replaceAll('{path}', ref) : `${command} ${ref}`
  const env = { ...process.env, GDG_TARGET: target, ...(win ? { NoDefaultCurrentDirectoryInExePath: '1' } : {}) }
  const child = spawn(line, { cwd, shell: true, detached: true, stdio: 'ignore', windowsHide: false, env })
  child.on('error', () => undefined)
  child.unref()
}

const onPath = (exe: string) => !!findOnPath(exe, win ? ['.exe', '.cmd', '.bat'] : [''])

const EDITORS = ['code', 'cursor', 'code-insiders', 'codium', 'zed', 'subl', 'rider64', 'idea64', 'notepad++']

export function openEditor(command: string, repo: string, target: string): void {
  const cmd = command.trim() || EDITORS.find(onPath)
  if (!cmd) throw new Error('No editor found. Set one in Settings → Integrations (e.g. "code").')
  launch(cmd, target, repo)
}

export function openTerminal(command: string, repo: string): void {
  if (command.trim()) return launch(command, repo, repo)
  if (win) {
    const wt = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'wt.exe')
    if (existsSync(wt)) return launch(`"${wt}" -d`, repo, repo)
    // Full paths: started in the repository, neither name may resolve to a file inside it.
    const powershell = join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const child = spawn(join(system32, 'cmd.exe'), ['/d', '/c', 'start', '', powershell, '-NoExit'], { cwd: repo, detached: true, stdio: 'ignore' })
    return child.unref()
  }
  if (process.platform === 'darwin') return launch('open -a Terminal', repo, repo)
  launch('x-terminal-emulator --working-directory', repo, repo)
}
