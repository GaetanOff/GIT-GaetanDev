import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import type { DiffHunk, DiffLine, DiffOptions, DiffSource, FileDiff, LineSelection, TextEncoding } from '@shared/types'
import { decode, decodeOutput, detect, encode } from './encoding'
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
const MAX_SIDE_BYTES = 16 * 1024 * 1024

function baseArgs(opts: DiffOptions): string[] {
  const args = ['--no-ext-diff', '--no-color', `-U${Math.max(0, Math.min(opts.context, 100))}`, '--find-renames']
  if (opts.ignoreWhitespace) args.push('-w')
  return args
}

export async function diff(repo: string, source: DiffSource, opts: DiffOptions): Promise<FileDiff> {
  const out = await rawDiff(repo, source, opts)
  const { text, encoding } = decodeOutput(out.raw)
  // Cut at MAX_DIFF_BYTES: the end is missing, so it is shown as too large, without hunks to act on.
  const parsed = parseDiff(text, source.path, opts.force && !out.truncated)
  if (out.truncated) {
    parsed.tooLarge = true
    parsed.truncated = true
    parsed.hunks = []
  }
  parsed.encoding = encoding
  parsed.lfs = lfsPointer(parsed)
  if (!parsed.binary) return parsed
  const both = await sides(repo, source, parsed)
  const utf16 = await utf16Diff(repo, source.path, both, opts)
  if (utf16) return { ...utf16, oldPath: parsed.oldPath, modeChange: parsed.modeChange }
  parsed.image = imagePreview(source.path, both)
  return parsed
}

async function rawDiff(repo: string, source: DiffSource, opts: DiffOptions): Promise<{ raw: Buffer; truncated: boolean }> {
  const args = baseArgs(opts)
  const paths = (p: string, old?: string) => (old && old !== p ? ['--', old, p] : ['--', p])
  const run = (a: string[], okCodes?: number[]) =>
    git(repo, a, { maxBytes: MAX_DIFF_BYTES, okCodes }).then(r => ({ raw: r.raw, truncated: !!r.truncated }))

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

/** Raw bytes of both sides of a change, each capped at MAX_SIDE_BYTES (null when absent or too big). */
async function sides(repo: string, source: DiffSource, d: FileDiff): Promise<{ before: Buffer | null; after: Buffer | null }> {
  const blob = async (spec: string): Promise<Buffer | null> => {
    try {
      const size = +(await gitOut(repo, ['cat-file', '-s', spec])).trim()
      if (size > MAX_SIDE_BYTES) return null
      return (await git(repo, ['cat-file', 'blob', spec])).raw
    } catch {
      return null
    }
  }
  const disk = async (p: string) => {
    try {
      const full = join(repo, p)
      if ((await stat(full)).size > MAX_SIDE_BYTES) return null
      return await readFile(full)
    } catch {
      return null
    }
  }

  const oldPath = d.oldPath ?? source.path
  switch (source.kind) {
    case 'worktree':
      if (source.conflicted) return { before: await blob(`HEAD:${oldPath}`), after: await disk(source.path) }
      return { before: d.isNew || source.untracked ? null : await blob(`:${oldPath}`), after: await disk(source.path) }
    case 'index':
      return { before: d.isNew ? null : await blob(`HEAD:${oldPath}`), after: d.isDeleted ? null : await blob(`:${source.path}`) }
    case 'commit':
      return {
        before: d.isNew ? null : await blob(`${source.sha}^:${oldPath}`),
        after: d.isDeleted ? null : await blob(`${source.sha}:${source.path}`),
      }
    case 'stash': {
      const ref = `stash@{${source.index}}`
      if (source.untracked) return { before: null, after: await blob(`${ref}^3:${source.path}`) }
      return { before: await blob(`${ref}^1:${source.path}`), after: await blob(`${ref}:${source.path}`) }
    }
    case 'range':
      return {
        before: d.isNew ? null : await blob(`${source.from}:${oldPath}`),
        after: d.isDeleted ? null : await blob(`${source.to}:${source.path}`),
      }
  }
}

function imagePreview(path: string, both: { before: Buffer | null; after: Buffer | null }): FileDiff['image'] {
  const mime = IMAGE_TYPES[extname(path).toLowerCase()]
  if (!mime) return undefined
  const toUrl = (buf: Buffer | null) => (buf && buf.length <= MAX_IMAGE_BYTES ? `data:${mime};base64,${buf.toString('base64')}` : undefined)
  return { before: toUrl(both.before), after: toUrl(both.after) }
}

const isUtf16 = (b: Buffer | null) => !!b && b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))

/**
 * Git sees UTF-16 files as binary (they are full of NUL bytes). When both
 * sides are UTF-16 (or one is absent), they are decoded, diffed as UTF-8 text
 * in temporary files, and the result is labelled with the real path. Line
 * staging stays off for these: patches would not match the UTF-16 bytes.
 */
async function utf16Diff(repo: string, path: string, both: { before: Buffer | null; after: Buffer | null }, opts: DiffOptions): Promise<FileDiff | null> {
  const { before, after } = both
  if (!(isUtf16(before) || isUtf16(after)) || (before && !isUtf16(before)) || (after && !isUtf16(after))) return null
  const encoding = detect((after ?? before)!)
  const dir = await mkdtemp(join(tmpdir(), 'gdg-utf16-'))
  try {
    const a = join(dir, 'a')
    const b = join(dir, 'b')
    await Promise.all([
      writeFile(a, before ? decode(before, detect(before)) : '', 'utf8'),
      writeFile(b, after ? decode(after, detect(after)) : '', 'utf8'),
    ])
    const r = await git(repo, ['diff', '--no-index', ...baseArgs(opts), '--', a, b], { okCodes: [1] })
    const d = parseDiff(r.stdout, path, opts.force)
    d.header = [`diff --git a/${path} b/${path}`]
    d.isNew = !before
    d.isDeleted = !after
    d.encoding = encoding
    return d
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
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
