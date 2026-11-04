import { describe, expect, it } from 'vitest'
import { selectionFingerprint, type DiffLine, type FileDiff } from '@shared/types'
import { splitRows, unifiedRows } from '../src/renderer/src/lib/diffrows'
import { fuzzy, rank } from '../src/renderer/src/lib/fuzzy'
import { pairLines, wordDiff } from '../src/renderer/src/lib/intraline'
import { lineStates } from '../src/renderer/src/lib/syntax'
import { messageAfterSquash } from '../src/renderer/src/lib/squash'

const line = (type: DiffLine['type'], text: string): DiffLine => ({ type, text }) as DiffLine
const fileDiff = (lines: DiffLine[]): FileDiff =>
  ({ path: 'a.ts', header: [], hunks: [{ header: '@@ -1,4 +1,4 @@', section: '', oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, lines }] }) as unknown as FileDiff

describe('word diff', () => {
  it('highlights the changed words of a replaced line, widened to whole words', () => {
    const [before, after] = wordDiff('const total = price * 2', 'const total = cost * 2')
    expect(before.filter(s => s.changed).map(s => s.text)).toEqual(['price'])
    expect(after.filter(s => s.changed).map(s => s.text)).toEqual(['cost'])
    expect(before.map(s => s.text).join('')).toBe('const total = price * 2')
  })

  it('pairs each run of deletions with the additions that follow it', () => {
    const lines = [line('ctx', 'a'), line('del', 'b'), line('del', 'c'), line('add', 'B'), line('ctx', 'd'), line('add', 'e')]
    expect([...pairLines(lines)].filter(([a]) => lines[a].type === 'del')).toEqual([[1, 3]])
  })
})

describe('diff rows', () => {
  const d = fileDiff([line('ctx', 'a'), line('del', 'b'), line('del', 'c'), line('add', 'B'), line('ctx', 'd')])

  it('point every unified row at its own line, for line selection', () => {
    const rows = unifiedRows(d).filter(r => r.kind === 'line')
    expect(rows.map(r => (r.kind === 'line' ? [r.hi, r.li, r.line.text] : null))).toEqual([[0, 0, 'a'], [0, 1, 'b'], [0, 2, 'c'], [0, 3, 'B'], [0, 4, 'd']])
  })

  it('zip deletions with the additions that follow, side by side', () => {
    const pairs = splitRows(d).filter(r => r.kind === 'pair').map(r => (r.kind === 'pair' ? [r.left?.line.text, r.right?.line.text] : null))
    expect(pairs).toEqual([['a', 'a'], ['b', 'B'], ['c', undefined], ['d', 'd']])
  })

  it('fingerprint a selection by the lines it names, so a shifted diff is told apart', () => {
    const sel = { 0: [1, 3] }
    const shifted = fileDiff([line('add', 'new'), line('ctx', 'a'), line('del', 'b'), line('del', 'c'), line('add', 'B'), line('ctx', 'd')])
    expect(selectionFingerprint(d, sel)).toBe(selectionFingerprint(fileDiff([...d.hunks[0].lines]), sel))
    expect(selectionFingerprint(shifted, sel)).not.toBe(selectionFingerprint(d, sel))
  })
})

describe('fuzzy matching', () => {
  it('matches a subsequence, and nothing else', () => {
    expect(fuzzy('fb', 'feature/bar')?.hits).toEqual([0, 8])
    expect(fuzzy('xyz', 'feature/bar')).toBeNull()
  })

  it('ranks word starts and consecutive characters first', () => {
    const ranked = rank(['refactor-bus', 'feature/bar', 'fab'], 'fb', s => s).map(r => r.item)
    expect(ranked[0]).toBe('feature/bar')
  })
})

describe('squash messages', () => {
  it('lists each squashed message once, however many are squashed', () => {
    // A, then B squashed into it, then C: the message prefilled after B is no source for the next one.
    let head: { message?: string; edited?: boolean } = {}
    head = { message: messageAfterSquash(head, 'A', ['B'], 'B') }
    expect(head.message).toBe('A\n\nB')
    expect(messageAfterSquash(head, 'A', ['B', 'C'], 'C')).toBe('A\n\nB\n\nC')
  })

  it('keeps what the user wrote and adds the new message below', () => {
    expect(messageAfterSquash({ message: 'Login rework', edited: true }, 'A', ['B', 'C'], 'C')).toBe('Login rework\n\nC')
  })
})

describe('syntax states', () => {
  it('carries a block comment and a template string across lines', () => {
    expect(lineStates(['/* start', 'inside', 'end */', 'code', 'const s = `a', 'b`'], 'clike')).toEqual([null, 'block', 'block', null, null, 'tpl'])
  })
})
