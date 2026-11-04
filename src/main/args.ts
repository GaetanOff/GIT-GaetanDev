import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * A folder given on the command line ("Open with", a shortcut, `gaetandev-git .`):
 * the first argument that names an existing directory. `skip`: the arguments
 * before it (the executable, and the app's own folder in development).
 */
export function folderArg(argv: string[], cwd: string, skip: number): string | null {
  for (const raw of argv.slice(skip)) {
    if (raw.startsWith('-')) continue
    // Explorer passes a drive root as "C:\" and the command-line parser reads the backslash as
    // escaping the closing quote: it arrives as C:". "C:" alone would mean that drive's current folder.
    const arg = raw.replace(/"$/, '')
    const full = resolve(cwd, /^[a-z]:$/i.test(arg) ? `${arg}\\` : arg)
    try { if (existsSync(full) && statSync(full).isDirectory()) return full } catch { /* unreadable */ }
  }
  return null
}
