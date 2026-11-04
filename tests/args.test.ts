import { describe, expect, it } from 'vitest'
import { folderArg } from '../src/main/args'

describe('folder on the command line', () => {
  it('finds the first existing folder, past switches', () => {
    expect(folderArg(['app.exe', '--flag', process.cwd()], 'C:\\', 1)).toBe(process.cwd())
    expect(folderArg(['app.exe', 'no-such-folder-here'], process.cwd(), 1)).toBeNull()
  })

  it.runIf(process.platform === 'win32')('reads a drive root that Explorer quoted as "C:\\"', () => {
    // The parser turns "C:\" into C:" (the backslash escapes the quote).
    expect(folderArg(['app.exe', 'C:"'], process.cwd(), 1)).toBe('C:\\')
    expect(folderArg(['app.exe', 'C:'], process.cwd(), 1)).toBe('C:\\')
  })
})
