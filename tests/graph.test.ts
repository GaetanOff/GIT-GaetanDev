import { describe, expect, it } from 'vitest'
import type { Commit } from '@shared/types'
import { GraphBuilder, MAX_LANES } from '../src/renderer/src/lib/graph'

const commit = (sha: string, parents: string[]) => ({ sha, parents, author: 'a', email: 'a@x', date: 0, subject: sha, refs: [] }) as unknown as Commit

describe('history graph', () => {
  it('joins a branch and its merge into lanes', () => {
    const g = new GraphBuilder()
    const rows = g.add([commit('m', ['b', 's']), commit('s', ['a']), commit('b', ['a']), commit('a', [])])
    expect(rows.map(r => r.col)).toEqual([0, 1, 0, 0])
    expect(rows[0].merge).toBe(true)
    expect(Math.max(...rows.map(r => r.width))).toBe(2)
  })

  // Search results skip the commits in between: their parents never show up, so every real lane would stay open.
  it('lays search results out in one column, whatever their parents', () => {
    const g = new GraphBuilder()
    g.reset(true)
    const rows = g.add(Array.from({ length: 3000 }, (_, i) => commit(`s${i}`, i % 10 ? [`p${i}`] : [`p${i}`, `q${i}`])))
    expect(rows.every(r => r.col === 0 && r.width === 1 && !r.top.length && !r.bottom.length)).toBe(true)
    expect(rows[0].merge).toBe(true)
  })

  // Thousands of open branches: every row used to keep an edge per lane, millions of them, though only MAX_LANES are drawn.
  it('keeps only the edges it can draw, however many lanes are open', () => {
    const g = new GraphBuilder()
    const rows = g.add(Array.from({ length: 2000 }, (_, i) => commit(`c${i}`, [`p${i}`])))
    expect(rows.at(-1)!.width).toBe(2000)
    expect(Math.max(...rows.map(r => r.top.length + r.bottom.length))).toBeLessThanOrEqual(2 * MAX_LANES + 2)
    expect(rows[5].top.map(e => e.from)).toEqual([0, 1, 2, 3, 4])
  })
})
