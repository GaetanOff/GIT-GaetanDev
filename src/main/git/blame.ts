import type { Blame, BlameCommit, FileCommit } from '@shared/types'
import { decode, decodeOutput } from './encoding'
import { git, GitError } from './exec'
import { cleanRef } from './log'

const RS = '\x1e'
const US = '\x1f'
const ZERO = '0'.repeat(40)

/** Commits that touched a file, newest first, following renames. */
export async function fileLog(repo: string, path: string, skip: number, limit: number): Promise<FileCommit[]> {
  const format = `${RS}${['%H', '%P', '%an', '%ae', '%at', '%s', '%D'].join('%x1f')}`
  // -z: paths come out as they are. Without it, a name holding a tab, a quote or a backslash is
  // C-quoted ("a\tb"), and the tab-separated status line split it apart.
  // No --skip: it counts the commits walked, before --follow keeps those that touch the file (and
  // finds its renames). A page after the first repeated most of the one before, and history before
  // a rename skipped over was never reached. -n counts the commits shown: those before are dropped here.
  const r = await git(repo, [
    'log', `--format=${format}`, '--decorate=full', '--follow', '--name-status', '-M', '-z', `-n${skip + limit}`, '--', path,
  ], { okCodes: [128] })
  if (r.code !== 0) return []
  return parseFileLog(r.stdout, path).slice(skip)
}

/** `RS header NUL \n status NUL path NUL [new path NUL]`, per commit. */
export function parseFileLog(stdout: string, path: string): FileCommit[] {
  const out: FileCommit[] = []
  for (const rec of stdout.split(RS)) {
    if (!rec.trim()) continue
    const end = rec.indexOf('\0')
    const head = end < 0 ? rec : rec.slice(0, end)
    const change = end < 0 ? [] : rec.slice(end + 1).replace(/^\n/, '').split('\0')
    const [sha, parents, author, email, date, subject, refs] = head.split(US)
    const status = change[0]?.[0] ?? ''
    const renamed = status === 'R' || status === 'C'
    out.push({
      sha, parents: parents ? parents.split(' ') : [], author, email, date: +date, subject,
      refs: refs ? refs.split(', ').map(cleanRef).filter(Boolean) : [],
      status,
      path: (renamed ? change[2] : change[1]) || path,
      oldPath: renamed ? change[1] : undefined,
    })
  }
  return out
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }

/**
 * A path as git prints it in blame's porcelain output, which has no -z: a
 * name holding a quote, a backslash or a control character comes C-quoted
 * ("a\"b", "\303\251" when core.quotepath is on). Anything else is as is.
 */
export function unquote(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) return path
  const bytes: number[] = []
  const body = Buffer.from(path.slice(1, -1), 'utf8')
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== 0x5c) { bytes.push(body[i]); continue }
    const next = String.fromCharCode(body[i + 1])
    const octal = /^[0-7]{3}$/.test(body.subarray(i + 1, i + 4).toString('latin1'))
    if (octal) { bytes.push(parseInt(body.subarray(i + 1, i + 4).toString('latin1'), 8)); i += 3 }
    else { bytes.push(ESCAPES[next] ?? body[i + 1]); i += 1 }
  }
  return Buffer.from(bytes).toString('utf8')
}

function splitLines(buf: Buffer): Buffer[] {
  const lines: Buffer[] = []
  let start = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      lines.push(buf.subarray(start, i))
      start = i + 1
    }
  }
  if (start < buf.length) lines.push(buf.subarray(start))
  return lines
}

/** Line-by-line authorship. `rev` null blames the working tree, uncommitted lines included. */
export async function blame(repo: string, path: string, rev: string | null): Promise<Blame> {
  const r = await git(repo, ['blame', '--porcelain', ...(rev ? [rev] : []), '--', path], { maxBytes: 64 * 1024 * 1024 })
  if (r.truncated) throw new GitError('This file is too large to blame here (over 64 MB of annotations).')
  const raw = r.raw
  const result: Blame = { path, rev, lines: [], commits: {} }
  // Metadata is UTF-8; content lines (tab-prefixed) keep the file's own encoding, e.g. Windows-1252.
  const lines = splitLines(raw)
  const content = decodeOutput(Buffer.concat(lines.filter(l => l[0] === 0x09))).encoding
  const out = lines.map(l => (l[0] === 0x09 ? decode(l, content) : l.toString('utf8')))
  let sha = ''
  let origLine = 0
  let current: BlameCommit | null = null

  for (const line of out) {
    if (line.startsWith('\t')) {
      result.lines.push({ sha, origLine, text: line.slice(1).replace(/\r$/, '') })
      continue
    }
    // 40 hex digits, or 64 in a SHA-256 repository.
    const header = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) (\d+) \d+/.exec(line)
    if (header) {
      sha = header[1]
      origLine = +header[2]
      current = result.commits[sha] ??= {
        sha, author: '', email: '', date: 0, summary: '', uncommitted: sha === ZERO,
      }
      continue
    }
    if (!current) continue
    const space = line.indexOf(' ')
    const key = space < 0 ? line : line.slice(0, space)
    const value = space < 0 ? '' : line.slice(space + 1)
    switch (key) {
      case 'author': current.author = current.uncommitted ? 'You' : value; break
      case 'author-mail': current.email = value.replace(/^<|>$/g, ''); break
      case 'author-time': current.date = +value; break
      case 'summary': current.summary = current.uncommitted ? 'Uncommitted changes' : value; break
      case 'previous': {
        const i = value.indexOf(' ')
        current.previous = { sha: value.slice(0, i), path: unquote(value.slice(i + 1)) }
        break
      }
    }
  }
  return result
}
