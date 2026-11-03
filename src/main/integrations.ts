import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { findOnPath } from './git/exec'

const win = process.platform === 'win32'
const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')

/** cmd.exe commands that are not files, so never looked up on disk themselves. */
const CMD_BUILTINS = new Set(['start', 'call', 'cd', 'pushd'])

/**
 * The command line with its program as a full path, on Windows. The shell runs
 * in the repository and looks for a bare name there first: a `code.cmd`
 * committed at the root would run instead of the editor. Found on PATH here
 * instead, so nothing has to be set in the environment the editor or terminal
 * inherits. `builtin`: the line starts with a cmd command (`start …`), whose
 * own program the shell still looks up.
 */
export function resolveProgram(command: string): { line: string; builtin: boolean } {
  const m = /^\s*(?:"([^"]+)"|(\S+))(.*)$/s.exec(command)
  if (!win || !m) return { line: command, builtin: false }
  const program = m[1] ?? m[2]
  if (CMD_BUILTINS.has(program.toLowerCase())) return { line: command, builtin: true }
  if (/[\\/:]/.test(program)) return { line: command, builtin: false }
  // In PATHEXT's order; a name with its extension is looked up as is.
  const full = /\.(exe|com|bat|cmd)$/i.test(program) ? findOnPath(program, ['']) : findOnPath(program, ['.com', '.exe', '.bat', '.cmd'])
  if (!full) throw new Error(`"${program}" was not found on PATH. Give its full path in Settings → Integrations.`)
  return { line: `"${full}"${m[3]}`, builtin: false }
}

/**
 * Runs a user-configured command line detached, with `{path}` or a trailing
 * argument. The path reaches the shell as an environment variable, which the
 * shell substitutes without parsing it again: a file named `$(cmd)` or
 * `a&b.txt` in a cloned repo stays a file name.
 */
function launch(command: string, target: string, cwd: string): void {
  const { line: program, builtin } = resolveProgram(command)
  const ref = win ? '"%GDG_TARGET%"' : '"$GDG_TARGET"'
  const line = program.includes('{path}') ? program.replaceAll('{path}', ref) : `${program} ${ref}`
  // Only a line led by a cmd command needs cmd itself told not to search the repository.
  const env = { ...process.env, GDG_TARGET: target, ...(builtin ? { NoDefaultCurrentDirectoryInExePath: '1' } : {}) }
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
