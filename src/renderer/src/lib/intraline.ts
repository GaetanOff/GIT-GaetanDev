import type { DiffLine } from '@shared/types'

export interface Segment {
  text: string
  changed: boolean
}

const MAX_LEN = 600

/**
 * Highlights what changed inside a replaced line: the span between the
 * longest common prefix and suffix, widened to whole words so the highlight
 * reads naturally.
 */
export function wordDiff(before: string, after: string): [Segment[], Segment[]] {
  if (before.length > MAX_LEN || after.length > MAX_LEN || before === after) {
    return [[{ text: before, changed: false }], [{ text: after, changed: false }]]
  }
  let start = 0
  const max = Math.min(before.length, after.length)
  while (start < max && before[start] === after[start]) start++
  let end = 0
  while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++

  const word = /\w/
  while (start > 0 && word.test(before[start - 1]) && word.test(after[start - 1] ?? '')) start--
  while (end > 0 && word.test(before[before.length - end] ?? '') && word.test(after[after.length - end] ?? '')) end--

  const split = (s: string): Segment[] => {
    const mid = s.slice(start, s.length - end)
    const out: Segment[] = []
    if (start) out.push({ text: s.slice(0, start), changed: false })
    if (mid) out.push({ text: mid, changed: true })
    if (end) out.push({ text: s.slice(s.length - end), changed: false })
    return out.length ? out : [{ text: '', changed: false }]
  }

  // Lines that are mostly different read better without a highlight.
  const changedRatio = (Math.max(before.length, after.length) - start - end) / Math.max(before.length, after.length, 1)
  if (changedRatio > 0.75) return [[{ text: before, changed: false }], [{ text: after, changed: false }]]
  return [split(before), split(after)]
}

/**
 * Pairs each run of deletions with the run of additions that follows it, so
 * the word highlight compares a line with its replacement.
 */
export function pairLines(lines: DiffLine[]): Map<number, number> {
  const pairs = new Map<number, number>()
  let i = 0
  while (i < lines.length) {
    if (lines[i].type !== 'del') { i++; continue }
    const delStart = i
    while (i < lines.length && lines[i].type === 'del') i++
    const addStart = i
    while (i < lines.length && lines[i].type === 'add') i++
    const n = Math.min(addStart - delStart, i - addStart)
    for (let k = 0; k < n; k++) {
      pairs.set(delStart + k, addStart + k)
      pairs.set(addStart + k, delStart + k)
    }
  }
  return pairs
}
