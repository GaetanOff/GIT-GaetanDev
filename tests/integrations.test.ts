import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launch, resolveProgram } from '../src/main/integrations'

// Made when the tests run, not on import: skipped (another platform, a name filter), they left it behind.
let bin = ''
const savedPath = process.env.PATH
beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), 'gdg-bin-'))
  writeFileSync(join(bin, 'myeditor.cmd'), '@echo off\r\n')
  process.env.PATH = `${bin}${delimiter}${savedPath}`
})
afterAll(() => {
  process.env.PATH = savedPath
  if (bin) rmSync(bin, { recursive: true, force: true })
})

describe.runIf(process.platform === 'win32')('editor and terminal commands', () => {
  it('names the program by its full path, found on PATH and never in the repository', () => {
    expect(resolveProgram('myeditor --wait {path}')).toEqual({ line: `"${join(bin, 'myeditor.cmd')}" --wait {path}`, builtin: false })
    expect(resolveProgram('myeditor.cmd').line).toBe(`"${join(bin, 'myeditor.cmd')}"`)
  })

  it('keeps a program given with its path, and flags a line led by a cmd command', () => {
    expect(resolveProgram('"C:\\Tools\\My Editor\\ed.exe" -n')).toEqual({ line: '"C:\\Tools\\My Editor\\ed.exe" -n', builtin: false })
    expect(resolveProgram('start wt -d .')).toEqual({ line: 'start wt -d .', builtin: true })
  })

  it('says when the program is nowhere on PATH', () => {
    expect(() => resolveProgram('no-such-editor-here')).toThrow(/not found on PATH/)
  })

  it('never lets a file name run a command through cmd.exe', async () => {
    const marker = join(bin, 'injected.txt')
    // A quote would close the quotes around the path: refused, as Windows cannot name a file so.
    expect(() => launch('cmd /c echo', 'x" & echo INJECTED> injected.txt & rem "', bin)).toThrow(/quotes/)
    // Without one, "&" stays part of the name.
    const child = launch('cmd /c echo', 'a & echo INJECTED> injected.txt', bin)
    await new Promise(resolve => child.on('exit', resolve))
    expect(existsSync(marker)).toBe(false)
  })
})
