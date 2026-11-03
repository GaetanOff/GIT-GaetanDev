import type { Blame, BlameCommit, FileCommit } from '@shared/types'
import { git, gitOut } from './exec'
import { cleanRef } from './log'

const RS = '\x1e'
const US = '\x1f'
const ZERO = '0'.repeat(40)

/** Commits that touched a file, newest first, following renames. */
export async function fileLog(repo: string, path: string, skip: number, limit: number): Promise<FileCommit[]> {
  const format = `${RS}${['%H', '%P', '%an', '%ae', '%at', '%s', '%D'].join('%x1f')}`
  const r = await git(repo, [
    'log', `--format=${format}`, '--decorate=full', '--follow', '--name-status', '-M', `--skip=${skip}`, `-n${limit}`, '--', path,
  ], { okCodes: [128] })
  if (r.code !== 0) return []

  const out: FileCommit[] = []
  for (const rec of r.stdout.split(RS)) {
    if (!rec.trim()) continue
    const [head, ...rest] = rec.split('\n')
    const [sha, parents, author, email, date, subject, refs] = head.split(US)
    const change = rest.find(l => l.trim())?.split('\t')
    const status = change?.[0]?.[0] ?? ''
    const renamed = status === 'R' || status === 'C'
    out.push({
      sha, parents: parents ? parents.split(' ') : [], author, email, date: +date, subject,
      refs: refs ? refs.split(', ').map(cleanRef).filter(Boolean) : [],
      status,
      path: (renamed ? change?.[2] : change?.[1]) ?? path,
      oldPath: renamed ? change?.[1] : undefined,
    })
  }
  return out
}

/** Line-by-line authorship. `rev` null blames the working tree, uncommitted lines included. */
export async function blame(repo: string, path: string, rev: string | null): Promise<Blame> {
  const out = await gitOut(repo, ['blame', '--porcelain', ...(rev ? [rev] : []), '--', path], { maxBytes: 64 * 1024 * 1024 })
  const result: Blame = { path, rev, lines: [], commits: {} }
  let sha = ''
  let origLine = 0
  let current: BlameCommit | null = null

  for (const line of out.split('\n')) {
    if (line.startsWith('\t')) {
      result.lines.push({ sha, origLine, text: line.slice(1).replace(/\r$/, '') })
      continue
    }
    const header = /^([0-9a-f]{40}) (\d+) \d+/.exec(line)
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
        current.previous = { sha: value.slice(0, i), path: value.slice(i + 1) }
        break
      }
    }
  }
  return result
}
