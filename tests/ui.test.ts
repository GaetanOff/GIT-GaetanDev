import { describe, expect, it } from 'vitest'
import { selectionFingerprint, type DiffLine, type FileDiff, type RepoStatus } from '@shared/types'
import { continueMessage, pendingCommit, untouchedPrefill, type Draft } from '../src/renderer/src/lib/drafts'
import { splitRows, unifiedRows } from '../src/renderer/src/lib/diffrows'
import { fuzzy, rank } from '../src/renderer/src/lib/fuzzy'
import { pairLines, wordDiff } from '../src/renderer/src/lib/intraline'
import { lineStates, pieces } from '../src/renderer/src/lib/syntax'
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

describe('syntax rules', () => {
  const kinds = (text: string, lang: string) => pieces(text, lang).filter(p => p.c).map(p => [p.c, p.t])

  it('highlight YAML keys and CSS numbers as before', () => {
    expect(kinds('  - name: web', 'yaml')[0]).toEqual(['prop', '  - name'])
    expect(kinds('margin: -1.5rem .5em 10px', 'css').filter(([t]) => t === 'num').map(([, x]) => x)).toEqual(['-1.5rem', '.5em', '10px'])
  })

  // Lines up to 2000 characters are highlighted: 400 spaces took seconds before.
  it('stay fast on lines made to backtrack', () => {
    const started = performance.now()
    pieces(' '.repeat(400), 'yaml')
    pieces(`${' '.repeat(1990)}x`, 'yaml')
    pieces(`a${' a'.repeat(990)}`, 'yaml')
    pieces(`${'1'.repeat(1990)}x`, 'css')
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('syntax states', () => {
  it('carries a block comment and a template string across lines', () => {
    expect(lineStates(['/* start', 'inside', 'end */', 'code', 'const s = `a', 'b`'], 'clike')).toEqual([null, 'block', 'block', null, null, 'tpl'])
  })
})

describe('the message a pending merge or pick is committed with', () => {
  const status = (operation: RepoStatus['operation'], operationHead?: string) => ({ operation, operationHead }) as RepoStatus
  const draft = (summary: string, prefill?: Draft['prefill']): Draft => ({ summary, body: '', amend: false, prefill })

  it('is the box\'s only when it holds git\'s message for that very commit, maybe corrected', () => {
    const pick = status('cherry-pick', 'b'.repeat(40))
    expect(continueMessage(draft('Fix login (corrected)', { for: pendingCommit(pick), text: 'Fix login\n' }), pick)).toBe('Fix login (corrected)')
    // A draft written before the pull, or the message an undo put back: git's own is used.
    expect(continueMessage(draft('Add OAuth'), status('merge', 'a'.repeat(40)))).toBeUndefined()
    // The previous pick's message, after it was skipped: not this commit's.
    expect(continueMessage(draft('B', { for: pendingCommit(pick), text: 'B\n' }), status('cherry-pick', 'c'.repeat(40)))).toBeUndefined()
    // A rebase writes its own messages.
    expect(continueMessage(draft('x', { for: '', text: 'x\n' }), status('rebase'))).toBeUndefined()
  })

  it('tells an untouched prepared message from an edited one', () => {
    expect(untouchedPrefill(draft('Merge branch x', { for: 'merge:a', text: 'Merge branch x\n' }))).toBe(true)
    expect(untouchedPrefill(draft('Merge branch x, fixed', { for: 'merge:a', text: 'Merge branch x\n' }))).toBe(false)
    expect(untouchedPrefill(draft('Mine'))).toBe(false)
  })
})
