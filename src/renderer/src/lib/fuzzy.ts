export interface FuzzyMatch {
  score: number
  /** Indexes of matched characters, for highlighting. */
  hits: number[]
}

/**
 * Subsequence matching with bonuses for consecutive characters and word
 * starts (after `/`, `-`, `_`, `.`, space or a case change). Good enough for
 * branch names, paths and commands, and fast on thousands of items.
 */
export function fuzzy(query: string, text: string): FuzzyMatch | null {
  if (!query) return { score: 0, hits: [] }
  const q = query.toLowerCase()
  const t = text.toLowerCase()

  const direct = t.indexOf(q)
  if (direct >= 0) {
    const hits = Array.from({ length: q.length }, (_, i) => direct + i)
    const boundary = direct === 0 || /[\s/_.-]/.test(t[direct - 1])
    return { score: 1000 - direct + (boundary ? 200 : 0) - t.length * 0.1, hits }
  }

  const hits: number[] = []
  let score = 0
  let ti = 0
  let prev = -2
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi]
    while (ti < t.length && t[ti] !== c) ti++
    if (ti >= t.length) return null
    const boundary = ti === 0 || /[\s/_.-]/.test(t[ti - 1]) || (text[ti] !== t[ti] && text[ti - 1] === t[ti - 1])
    score += (ti === prev + 1 ? 15 : 0) + (boundary ? 10 : 0) - (ti - prev - 1) * 0.5
    hits.push(ti)
    prev = ti
    ti++
  }
  return { score: score - t.length * 0.1, hits }
}

/** Splits text into segments, flagging matched characters. */
export function highlight(text: string, hits: number[]): { text: string; hit: boolean }[] {
  if (!hits.length) return [{ text, hit: false }]
  const set = new Set(hits)
  const out: { text: string; hit: boolean }[] = []
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i)
    const last = out[out.length - 1]
    if (last && last.hit === hit) last.text += text[i]
    else out.push({ text: text[i], hit })
  }
  return out
}

export function rank<T>(items: T[], query: string, key: (item: T) => string, limit = 200): { item: T; match: FuzzyMatch }[] {
  const out: { item: T; match: FuzzyMatch }[] = []
  for (const item of items) {
    const match = fuzzy(query, key(item))
    if (match) out.push({ item, match })
  }
  if (query) out.sort((a, b) => b.match.score - a.match.score)
  return out.slice(0, limit)
}
