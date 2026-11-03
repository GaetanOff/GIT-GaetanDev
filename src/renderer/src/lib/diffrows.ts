import type { DiffLine, FileDiff } from '@shared/types'
import { pairLines, wordDiff, type Segment } from './intraline'
import { nextState, type LexState } from './syntax'

interface Side { li: number; line: DiffLine; segs?: Segment[]; st?: LexState }

export type DiffRow =
  | { kind: 'hunk'; hi: number; header: string; section: string }
  | ({ kind: 'line'; hi: number } & Side)
  | { kind: 'pair'; hi: number; left?: Side; right?: Side }

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

/**
 * The lexer state each line starts in. The old side (context and deletions)
 * and the new side (context and additions) are separate texts, so each is
 * threaded on its own. A hunk starts in an unknown state.
 */
function statesFor(lines: DiffLine[], lang: string | null): (LexState | undefined)[] {
  if (!lang) return []
  const out: (LexState | undefined)[] = []
  let older: LexState | undefined
  let newer: LexState | undefined
  for (const l of lines) {
    if (l.type === 'del') {
      out.push(older)
      older = nextState(l.text, lang, older ?? null)
    } else if (l.type === 'add') {
      out.push(newer)
      newer = nextState(l.text, lang, newer ?? null)
    } else {
      out.push(newer)
      older = nextState(l.text, lang, older ?? null)
      newer = nextState(l.text, lang, newer ?? null)
    }
  }
  return out
}

export function unifiedRows(d: FileDiff, lang: string | null = null): DiffRow[] {
  const rows: DiffRow[] = []
  d.hunks.forEach((h, hi) => {
    rows.push({ kind: 'hunk', hi, header: h.header.replace(/ @@.*$/, ' @@'), section: h.section })
    const segs = segmentsFor(h.lines)
    const sts = statesFor(h.lines, lang)
    h.lines.forEach((line, li) => rows.push({ kind: 'line', hi, li, line, segs: segs.get(li), st: sts[li] }))
  })
  return rows
}

/** Side by side: context on both sides, each deletion run zipped with the additions that follow. */
export function splitRows(d: FileDiff, lang: string | null = null): DiffRow[] {
  const rows: DiffRow[] = []
  d.hunks.forEach((h, hi) => {
    rows.push({ kind: 'hunk', hi, header: h.header.replace(/ @@.*$/, ' @@'), section: h.section })
    const segs = segmentsFor(h.lines)
    const sts = statesFor(h.lines, lang)
    const L = h.lines
    const side = (i: number): Side => ({ li: i, line: L[i], segs: segs.get(i), st: sts[i] })
    let i = 0
    while (i < L.length) {
      if (L[i].type === 'ctx') {
        rows.push({ kind: 'pair', hi, left: side(i), right: side(i) })
        i++
        continue
      }
      const dels: number[] = []
      const adds: number[] = []
      while (i < L.length && L[i].type === 'del') dels.push(i++)
      while (i < L.length && L[i].type === 'add') adds.push(i++)
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        rows.push({
          kind: 'pair', hi,
          left: dels[k] !== undefined ? side(dels[k]) : undefined,
          right: adds[k] !== undefined ? side(adds[k]) : undefined,
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
