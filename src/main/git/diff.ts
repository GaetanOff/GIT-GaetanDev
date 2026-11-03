import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { DiffHunk, DiffLine, DiffOptions, DiffSource, FileDiff, LineSelection, TextEncoding } from '@shared/types'
import { decodeOutput, encode } from './encoding'
import { git, gitOut } from './exec'

/** Beyond this many diff lines the UI asks before rendering. */
const LINE_BUDGET = 25_000
const MAX_DIFF_BYTES = 40 * 1024 * 1024
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.avif': 'image/avif',
}
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

function baseArgs(opts: DiffOptions): string[] {
  const args = ['--no-ext-diff', '--no-color', `-U${Math.max(0, Math.min(opts.context, 100))}`, '--find-renames']
  if (opts.ignoreWhitespace) args.push('-w')
  return args
}

export async function diff(repo: string, source: DiffSource, opts: DiffOptions): Promise<FileDiff> {
  const { text, encoding } = decodeOutput(await rawDiff(repo, source, opts))
  const parsed = parseDiff(text, source.path, opts.force)
  parsed.encoding = encoding
  parsed.lfs = lfsPointer(parsed)
  if (parsed.binary) parsed.image = await imagePreview(repo, source, parsed)
  return parsed
}

async function rawDiff(repo: string, source: DiffSource, opts: DiffOptions): Promise<Buffer> {
  const args = baseArgs(opts)
  const paths = (p: string, old?: string) => (old && old !== p ? ['--', old, p] : ['--', p])
  const run = (a: string[], okCodes?: number[]) =>
    git(repo, a, { maxBytes: MAX_DIFF_BYTES, okCodes }).then(r => r.raw)

  switch (source.kind) {
    case 'worktree':
      if (source.untracked) return run(['diff', ...args, '--no-index', '--', '/dev/null', source.path], [1])
      // A combined diff is hard to read; against HEAD the conflict markers show as additions.
      if (source.conflicted) return run(['diff', ...args, 'HEAD', ...paths(source.path)])
      return run(['diff', ...args, ...paths(source.path)])
    case 'index': {
      const hasHead = await git(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [1] }).then(r => r.code === 0)
      return run(['diff', ...args, '--cached', ...(hasHead ? [] : [EMPTY_TREE]), ...paths(source.path, source.oldPath)])
    }
    case 'commit': {
      const parents = (await gitOut(repo, ['rev-list', '--parents', '-n', '1', source.sha])).trim().split(' ').slice(1)
      const base = parents[0] ?? EMPTY_TREE
      return run(['diff', ...args, base, source.sha, ...paths(source.path, source.oldPath)])
    }
    case 'stash': {
      const ref = `stash@{${source.index}}`
      if (source.untracked) return run(['diff', ...args, EMPTY_TREE, `${ref}^3`, '--', source.path])
      return run(['diff', ...args, `${ref}^1`, ref, '--', source.path])
    }
    case 'range':
      return run(['diff', ...args, source.from, source.to, ...paths(source.path, source.oldPath)])
  }
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

export function parseDiff(raw: string, path: string, force = false): FileDiff {
  const result: FileDiff = {
    path, header: [], hunks: [], binary: false, isNew: false, isDeleted: false, additions: 0, deletions: 0, encoding: 'utf8',
  }
  const lines = raw.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()

  let i = 0
  for (; i < lines.length && !lines[i].startsWith('@@'); i++) {
    const l = lines[i]
    result.header.push(l)
    if (l.startsWith('new file mode')) result.isNew = true
    else if (l.startsWith('deleted file mode')) result.isDeleted = true
    else if (l.startsWith('old mode')) result.modeChange = l.slice(9)
    else if (l.startsWith('new mode') && result.modeChange) result.modeChange += ` → ${l.slice(9)}`
    else if (l.startsWith('rename from ')) result.oldPath = l.slice(12)
    else if (l.startsWith('Binary files') || l === 'GIT binary patch') result.binary = true
    else if (l.startsWith('Subproject commit')) {
      result.submodule ??= {}
    }
  }

  const total = lines.length - i
  if (total > LINE_BUDGET && !force) {
    result.tooLarge = true
    for (; i < lines.length; i++) {
      if (lines[i][0] === '+' && !lines[i].startsWith('+++')) result.additions++
      else if (lines[i][0] === '-' && !lines[i].startsWith('---')) result.deletions++
    }
    return result
  }

  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0
  for (; i < lines.length; i++) {
    const l = lines[i]
    const m = HUNK_RE.exec(l)
    if (m) {
      oldNo = +m[1]
      newNo = +m[3]
      hunk = {
        header: l, oldStart: oldNo, oldLines: m[2] === undefined ? 1 : +m[2],
        newStart: newNo, newLines: m[4] === undefined ? 1 : +m[4], section: m[5] ?? '', lines: [],
      }
      result.hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    const c = l[0]
    let line: DiffLine | null = null
    if (c === '+') { line = { type: 'add', text: l.slice(1), newNo: newNo++ }; result.additions++ }
    else if (c === '-') { line = { type: 'del', text: l.slice(1), oldNo: oldNo++ }; result.deletions++ }
    else if (c === ' ' || l === '') line = { type: 'ctx', text: l.slice(1), oldNo: oldNo++, newNo: newNo++ }
    else if (c === '\\') {
      const prev = hunk.lines[hunk.lines.length - 1]
      if (prev) prev.noEol = true
      continue
    }
    if (line) hunk.lines.push(line)
  }

  if (result.submodule) {
    for (const h of result.hunks) for (const ln of h.lines) {
      const sha = ln.text.replace('Subproject commit ', '').slice(0, 12)
      if (ln.type === 'del') result.submodule.before = sha
      if (ln.type === 'add') result.submodule.after = sha
    }
  }
  return result
}

async function imagePreview(repo: string, source: DiffSource, d: FileDiff): Promise<FileDiff['image']> {
  const mime = IMAGE_TYPES[extname(source.path).toLowerCase()]
  if (!mime) return undefined
  const toUrl = (buf: Buffer | null) => (buf && buf.length <= MAX_IMAGE_BYTES ? `data:${mime};base64,${buf.toString('base64')}` : undefined)

  const blob = async (spec: string): Promise<Buffer | null> => {
    try {
      const size = +(await gitOut(repo, ['cat-file', '-s', spec])).trim()
      if (size > MAX_IMAGE_BYTES) return null
      return await new Promise<Buffer>((resolve, reject) => {
        const child = spawn('git', ['cat-file', 'blob', spec], { cwd: repo, windowsHide: true })
        const parts: Buffer[] = []
        child.stdout.on('data', (c: Buffer) => parts.push(c))
        child.on('close', code => (code === 0 ? resolve(Buffer.concat(parts)) : reject(new Error('cat-file failed'))))
        child.on('error', reject)
      })
    } catch {
      return null
    }
  }
  const disk = async (p: string) => {
    try {
      const full = join(repo, p)
      if ((await stat(full)).size > MAX_IMAGE_BYTES) return null
      return await readFile(full)
    } catch {
      return null
    }
  }

  const oldPath = d.oldPath ?? source.path
  switch (source.kind) {
    case 'worktree':
      return { before: d.isNew || source.untracked ? undefined : toUrl(await blob(`:${oldPath}`)), after: toUrl(await disk(source.path)) }
    case 'index':
      return { before: d.isNew ? undefined : toUrl(await blob(`HEAD:${oldPath}`)), after: d.isDeleted ? undefined : toUrl(await blob(`:${source.path}`)) }
    case 'commit':
      return {
        before: d.isNew ? undefined : toUrl(await blob(`${source.sha}^:${oldPath}`)),
        after: d.isDeleted ? undefined : toUrl(await blob(`${source.sha}:${source.path}`)),
      }
    case 'stash': {
      const ref = `stash@{${source.index}}`
      if (source.untracked) return { after: toUrl(await blob(`${ref}^3:${source.path}`)) }
      return { before: toUrl(await blob(`${ref}^1:${source.path}`)), after: toUrl(await blob(`${ref}:${source.path}`)) }
    }
    case 'range':
      return {
        before: d.isNew ? undefined : toUrl(await blob(`${source.from}:${oldPath}`)),
        after: d.isDeleted ? undefined : toUrl(await blob(`${source.to}:${source.path}`)),
      }
  }
}

/** Detects a Git LFS pointer diff: "version https://git-lfs…", "oid sha256:…", "size N". */
function lfsPointer(d: FileDiff): FileDiff['lfs'] {
  const lines = d.hunks.flatMap(h => h.lines)
  if (!lines.some(l => l.text.startsWith('version https://git-lfs'))) return undefined
  const read = (type: 'add' | 'del' | 'ctx') => {
    const side = lines.filter(l => l.type === type || l.type === 'ctx')
    const oid = side.find(l => l.text.startsWith('oid sha256:'))?.text.slice(11)
    const size = side.find(l => l.text.startsWith('size '))?.text.slice(5)
    return oid && size ? { oid, size: +size } : undefined
  }
  const after = read('add')
  const before = read('del')
  if (!after && !before) return undefined
  return { ...(after ?? before!), before: after && before && before.oid !== after.oid ? before : undefined }
}

/* ─── Partial patches ───────────────────────────────────────────────────────── */

/**
 * Builds a patch containing only the selected lines.
 *
 * `forward` (staging): the patch applies to the index, whose content is the
 * diff's old side. Unselected deletions stay as context; unselected additions
 * are dropped. `reverse` (unstaging, discarding): the patch is applied with
 * --reverse, so its new side must match the target. Unselected additions stay
 * as context; unselected deletions are dropped.
 */
export function buildPartialPatch(d: FileDiff, selection: LineSelection, direction: 'forward' | 'reverse'): string | null {
  const out: string[] = []
  let partial = false

  d.hunks.forEach((hunk, hi) => {
    const picked = new Set(selection[hi] ?? [])
    const body: string[] = []
    let oldCount = 0
    let newCount = 0
    let firstOld: number | undefined
    let firstNew: number | undefined
    let changed = false
    const keep = (prefix: string, ln: DiffLine, oldSide: boolean, newSide: boolean) => {
      body.push(prefix + ln.text)
      if (ln.noEol) body.push('\\ No newline at end of file')
      if (oldSide) { oldCount++; firstOld ??= ln.oldNo }
      if (newSide) { newCount++; firstNew ??= ln.newNo }
    }

    hunk.lines.forEach((ln, li) => {
      if (ln.type === 'ctx') return keep(' ', ln, true, true)
      if (picked.has(li)) {
        changed = true
        return ln.type === 'add' ? keep('+', ln, false, true) : keep('-', ln, true, false)
      }
      partial = true
      // An unselected change that exists on the side the patch must match becomes context.
      if (ln.type === 'add' && direction === 'reverse') keep(' ', ln, true, true)
      if (ln.type === 'del' && direction === 'forward') keep(' ', ln, true, true)
    })

    if (!changed) return
    // With zero context git locates a hunk by its start line, so it must be exact
    // on the side being matched; an empty side keeps git's "line before" convention.
    const oldStart = direction === 'forward' && firstOld !== undefined ? firstOld : hunk.oldStart
    const newStart = direction === 'reverse' && firstNew !== undefined ? firstNew : hunk.newStart
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...body)
  })

  if (!out.length) return null
  let header = d.header.filter(h => !/^(index |similarity|dissimilarity|Binary)/.test(h))
  // Part of a created/deleted file is a plain modification of the target.
  if (partial && ((direction === 'reverse' && d.isNew) || (direction === 'forward' && d.isDeleted))) {
    header = header
      .filter(h => !/^(new|deleted) file mode/.test(h))
      .map(h => (h === '--- /dev/null' ? `--- a/${d.path}` : h === '+++ /dev/null' ? `+++ b/${d.path}` : h))
  }
  return [...header, ...out, ''].join('\n')
}

export async function applyPatch(repo: string, patch: string, args: string[], encoding: TextEncoding = 'utf8'): Promise<void> {
  // Content lines must reach git with the bytes the file really has.
  const input = encoding === 'windows-1252' ? encode(patch, encoding) : patch
  await git(repo, ['apply', '--recount', '--whitespace=nowarn', '--unidiff-zero', ...args, '-'], { input })
}
