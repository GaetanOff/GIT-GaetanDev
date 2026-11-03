import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { resolveProgram } from '../src/main/integrations'

const bin = mkdtempSync(join(tmpdir(), 'gdg-bin-'))
writeFileSync(join(bin, 'myeditor.cmd'), '@echo off\r\n')
const savedPath = process.env.PATH
process.env.PATH = `${bin}${delimiter}${savedPath}`
afterAll(() => {
  process.env.PATH = savedPath
  rmSync(bin, { recursive: true, force: true })
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
})
