import { spawn, type ChildProcess } from 'node:child_process'
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
 * argument. The path reaches the shell as an environment variable: sh
 * substitutes it without parsing it again, so a file named `$(cmd)` stays a
 * file name. cmd.exe substitutes `%GDG_TARGET%` before it parses the line, so
 * a quote in the value would close the quotes around it and let `&` start a
 * command: such a path (a file of a commit made elsewhere, never one on a
 * Windows disk) is refused, as are control characters (a line break ends the
 * command).
 */
const unsafeForCmd = (c: string) => c === '"' || c.charCodeAt(0) < 0x20

/**
 * The line with each `{path}` replaced by a reference to GDG_TARGET that the
 * shell keeps as one quoted word, wherever the user's own quotes put it.
 * Quoted again inside the user's quotes (`code -n "{path}"`), the reference
 * ended up outside any: `""%GDG_TARGET%""` let cmd.exe run what follows a `&`
 * in a file name, and sh split a path at its spaces.
 */
export function withTarget(line: string, posix = !win): string {
  let out = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    if (line.startsWith('{path}', i)) {
      if (posix) out += quote === '"' ? '${GDG_TARGET}' : quote === "'" ? `'"$GDG_TARGET"'` : '"$GDG_TARGET"'
      else out += quote ? '%GDG_TARGET%' : '"%GDG_TARGET%"'
      i += '{path}'.length - 1
      continue
    }
    const c = line[i]
    out += c
    // sh: a backslash keeps the next character from opening or closing quotes, except within single ones.
    if (posix && c === '\\' && quote !== "'" && i + 1 < line.length) out += line[++i]
    else if (c === '"' && quote !== "'") quote = quote ? null : '"'
    else if (posix && c === "'" && quote !== '"') quote = quote ? null : "'"
  }
  return out
}

export function launch(command: string, target: string, cwd: string): ChildProcess {
  if (win && [...target].some(unsafeForCmd)) {
    const shown = [...target].map(c => (c.charCodeAt(0) < 0x20 ? '?' : c)).join('')
    throw new Error(`"${shown}" cannot be opened: Windows file names cannot hold quotes or control characters.`)
  }
  const { line: program, builtin } = resolveProgram(command)
  const line = withTarget(program.includes('{path}') ? program : `${program} {path}`)
  // Only a line led by a cmd command needs cmd itself told not to search the repository.
  const env = { ...process.env, GDG_TARGET: target, ...(builtin ? { NoDefaultCurrentDirectoryInExePath: '1' } : {}) }
  const child = spawn(line, { cwd, shell: true, detached: true, stdio: 'ignore', windowsHide: false, env })
  child.on('error', () => undefined)
  child.unref()
  return child
}

const onPath = (exe: string) => !!findOnPath(exe, win ? ['.exe', '.cmd', '.bat'] : [''])

const EDITORS = ['code', 'cursor', 'code-insiders', 'codium', 'zed', 'subl', 'rider64', 'idea64', 'notepad++']

export function openEditor(command: string, repo: string, target: string): void {
  const cmd = command.trim() || EDITORS.find(onPath)
  if (!cmd) throw new Error('No editor found. Set one in Settings → Integrations (e.g. "code").')
  launch(cmd, target, repo)
}

export function openTerminal(command: string, repo: string): void {
  if (command.trim()) {
    launch(command, repo, repo)
  } else if (win) {
    const wt = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'wt.exe')
    if (existsSync(wt)) {
      // Started in the repository with "-d .": the path never reaches its command line, where
      // Windows Terminal splits on ";" even inside quotes ("lib;calc" would run calc).
      const child = spawn(wt, ['-d', '.'], { cwd: repo, detached: true, stdio: 'ignore' })
      child.on('error', () => undefined)
      child.unref()
      return
    }
    // Full paths: started in the repository, neither name may resolve to a file inside it.
    const powershell = join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const child = spawn(join(system32, 'cmd.exe'), ['/d', '/c', 'start', '', powershell, '-NoExit'], { cwd: repo, detached: true, stdio: 'ignore' })
    child.unref()
  } else if (process.platform === 'darwin') {
    launch('open -a Terminal', repo, repo)
  } else {
    launch('x-terminal-emulator --working-directory', repo, repo)
  }
}
