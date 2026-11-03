import type { DiffLine, FileDiff } from '@shared/types'
import { pairLines, wordDiff, type Segment } from './intraline'

export type DiffRow =
  | { kind: 'hunk'; hi: number; header: string; section: string }
  | { kind: 'line'; hi: number; li: number; line: DiffLine; segs?: Segment[] }
  | { kind: 'pair'; hi: number; left?: { li: number; line: DiffLine; segs?: Segment[] }; right?: { li: number; line: DiffLine; segs?: Segment[] } }

/** Word-level segments for every replaced line of a hunk. */
function segmentsFor(lines: DiffLine[]): Map<number, Segment[]> {
  const out = new Map<number, Segment[]>()
  for (const [a, b] of pairLines(lines)) {
    if (lines[a].type !== 'del' || out.has(a)) continue
    const [before, after] = wordDiff(lines[a].text, lines[b].text)
    out.set(a, before)
    out.set(b, after)
  }
  return out
}

export function unifiedRows(d: FileDiff): DiffRow[] {
  const rows: DiffRow[] = []
  d.hunks.forEach((h, hi) => {
    rows.push({ kind: 'hunk', hi, header: h.header.replace(/ @@.*$/, ' @@'), section: h.section })
    const segs = segmentsFor(h.lines)
    h.lines.forEach((line, li) => rows.push({ kind: 'line', hi, li, line, segs: segs.get(li) }))
  })
  return rows
}

/** Side by side: context on both sides, each deletion run zipped with the additions that follow. */
export function splitRows(d: FileDiff): DiffRow[] {
  const rows: DiffRow[] = []
  d.hunks.forEach((h, hi) => {
    rows.push({ kind: 'hunk', hi, header: h.header.replace(/ @@.*$/, ' @@'), section: h.section })
    const segs = segmentsFor(h.lines)
    const L = h.lines
    let i = 0
    while (i < L.length) {
      if (L[i].type === 'ctx') {
        rows.push({ kind: 'pair', hi, left: { li: i, line: L[i] }, right: { li: i, line: L[i] } })
        i++
        continue
      }
      const dels: number[] = []
      const adds: number[] = []
      while (i < L.length && L[i].type === 'del') dels.push(i++)
      while (i < L.length && L[i].type === 'add') adds.push(i++)
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        const a = dels[k]
        const b = adds[k]
        rows.push({
          kind: 'pair', hi,
          left: a !== undefined ? { li: a, line: L[a], segs: segs.get(a) } : undefined,
          right: b !== undefined ? { li: b, line: L[b], segs: segs.get(b) } : undefined,
        })
      }
    }
  })
  return rows
}

export function longestLine(d: FileDiff): number {
  let max = 0
  for (const h of d.hunks) for (const l of h.lines) {
    // Tabs render four columns wide.
    const len = l.text.length + (l.text.match(/\t/g)?.length ?? 0) * 3
    if (len > max) max = len
  }
  return max
}
