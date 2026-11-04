import { app } from 'electron'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { format } from 'node:util'

const MAX_BYTES = 1024 * 1024

export const logDir = () => join(app.getPath('userData'), 'logs')

/**
 * Errors and warnings of the main process also go to <userData>/logs/main.log:
 * an installed build has no console to show them. Past 1 MB the file becomes
 * main.1.log, replacing the one before.
 */
export function logToFile(): void {
  const dir = logDir()
  const file = join(dir, 'main.log')
  try { mkdirSync(dir, { recursive: true }) } catch { return }
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args)
      try {
        try { if (statSync(file).size > MAX_BYTES) renameSync(file, join(dir, 'main.1.log')) } catch { /* no file yet */ }
        appendFileSync(file, `${new Date().toISOString()} ${level.toUpperCase()} ${format(...args)}\n`)
      } catch { /* logging never throws */ }
    }
  }
}
