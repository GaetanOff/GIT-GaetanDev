import { describe, expect, it } from 'vitest'
import type { DiffLine, FileDiff } from '@shared/types'
import { unifiedRows } from '../src/renderer/src/lib/diffrows'
import { pieces } from '../src/renderer/src/lib/syntax'

const line = (type: DiffLine['type'], text: string, n: number): DiffLine =>
  ({ type, text, oldNo: type === 'add' ? undefined : n, newNo: type === 'del' ? undefined : n }) as DiffLine

const fileDiff = (lines: DiffLine[]): FileDiff =>
  ({ path: 'a.ts', header: [], hunks: [{ header: '@@ -10,4 +10,4 @@', section: '', oldStart: 10, oldCount: 4, newStart: 10, newCount: 4, lines }] }) as unknown as FileDiff

describe('diff rows', () => {
  it('colours every line of a hunk that starts inside a block comment', () => {
    const d = fileDiff([line('ctx', ' * first', 10), line('ctx', ' * second', 11), line('ctx', ' */', 12), line('add', 'run()', 13)])
    const rows = unifiedRows(d, 'clike').filter(r => r.kind === 'line')
    const colour = (i: number) => {
      const r = rows[i] as { line: DiffLine; st?: Parameters<typeof pieces>[3] }
      return pieces(r.line.text, 'clike', undefined, r.st).map(p => p.c ?? 'plain')
    }
    expect(colour(0)).toEqual(['com'])
    expect(colour(1)).toEqual(['com'])
    expect(colour(2)).toEqual(['com'])
    expect(colour(3)).not.toContain('com')
  })
})
