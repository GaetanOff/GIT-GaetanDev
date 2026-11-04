export const shortSha = (sha: string) => sha.slice(0, 7)

/*
 * Formatters made once: toLocaleDateString builds a new Intl.DateTimeFormat on
 * every call (about 77 µs), and a sidebar of 5,000 branches dated more than a
 * week ago spent close to 400 ms on dates alone at each refresh.
 */
const DAY_MONTH = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })
const DAY_MONTH_YEAR = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
const FULL = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

export function relativeTime(unixSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds
  if (diff < 45) return 'just now'
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`
  if (diff < 86_400) return `${Math.round(diff / 3600)} h ago`
  if (diff < 7 * 86_400) return `${Math.round(diff / 86_400)} d ago`
  if (diff < 365 * 86_400) return DAY_MONTH.format(unixSeconds * 1000)
  return DAY_MONTH_YEAR.format(unixSeconds * 1000)
}

export function fullDate(unixSeconds: number): string {
  return FULL.format(unixSeconds * 1000)
}

export function initials(name: string): string {
  const parts = name.trim().split(/[\s._@-]+/).filter(Boolean)
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] ?? '?').slice(0, 2)
  return letters.toUpperCase()
}

/** Avatar tones from the SSH design system, picked by a stable hash. */
const TONES = [
  ['rgba(74,222,128,0.2)', '#86efac'], ['rgba(45,212,191,0.2)', '#99f6e4'], ['rgba(34,211,238,0.2)', '#a5f3fc'],
  ['rgba(96,165,250,0.2)', '#93c5fd'], ['rgba(192,132,252,0.2)', '#d8b4fe'], ['rgba(244,114,182,0.2)', '#f9a8d4'],
  ['rgba(251,191,36,0.2)', '#fde68a'],
]

export function tone(seed: string): { bg: string; fg: string } {
  let hash = 0
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  const [bg, fg] = TONES[Math.abs(hash) % TONES.length]
  return { bg, fg }
}

export function basename(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? path : path.slice(i + 1)
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** Status letter → label and colour for file rows. */
export function statusStyle(code: string): { label: string; letter: string; color: string } {
  switch (code) {
    case 'A': return { label: 'Added', letter: 'A', color: 'var(--green)' }
    case '?': return { label: 'Untracked', letter: 'U', color: 'var(--green)' }
    case 'D': return { label: 'Deleted', letter: 'D', color: 'var(--red)' }
    case 'R': return { label: 'Renamed', letter: 'R', color: 'var(--blue)' }
    case 'C': return { label: 'Copied', letter: 'C', color: 'var(--blue)' }
    case 'T': return { label: 'Type changed', letter: 'T', color: 'var(--purple)' }
    case 'U': return { label: 'Conflicted', letter: '!', color: 'var(--red)' }
    default: return { label: 'Modified', letter: 'M', color: 'var(--amber)' }
  }
}

export const isMac = navigator.platform.toLowerCase().includes('mac')
export const MOD = isMac ? '⌘' : 'Ctrl'
