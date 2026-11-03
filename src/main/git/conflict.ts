import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConflictFile, TextEncoding } from '@shared/types'
import { decode, detect, encode } from './encoding'
import { git } from './exec'
import { gitDir, operation } from './status'

async function blob(repo: string, sha: string): Promise<Buffer> {
  return (await git(repo, ['cat-file', 'blob', sha])).raw
}

/**
 * Raw bytes of the index stages (1 base, 2 ours, 3 theirs), null where a side
 * has no file, and their blob ids, which tell one conflict from another.
 */
async function stages(repo: string, path: string): Promise<{ blobs: [Buffer | null, Buffer | null, Buffer | null]; ids: string }> {
  const out = (await git(repo, ['ls-files', '-s', '--', path])).stdout
  const sha: Record<string, string> = {}
  for (const line of out.split('\n')) {
    const [meta] = line.split('\t')
    const [, objectId, n] = meta.split(' ')
    if (n) sha[n] = objectId
  }
  const read = (n: string) => (sha[n] ? blob(repo, sha[n]) : Promise.resolve(null))
  const blobs = await Promise.all([read('1'), read('2'), read('3')])
  return { blobs, ids: ['1', '2', '3'].map(n => sha[n] ?? '-').join(' ') }
}

const isBinary = (b: Buffer | null) => !!b && b.subarray(0, 8000).includes(0)

/** "branch · subject" for a revision in one git call, using its decorations for the name. */
async function describe(repo: string, rev: string): Promise<string> {
  const r = await git(repo, ['log', '-1', '--format=%h%x1f%s%x1f%D', rev], { okCodes: [128] })
  if (r.code !== 0) return rev
  const [sha, subject, refs] = r.stdout.trim().split('\x1f')
  const name = refs?.split(', ').map(x => x.replace(/^HEAD -> /, '')).find(x => x && !x.startsWith('tag: ') && x !== 'HEAD')
  return `${name ?? sha} · ${subject}`.slice(0, 90)
}

async function labels(repo: string): Promise<{ ours: string; theirs: string }> {
  const dir = await gitDir(repo)
  const read = async (f: string) => (await readFile(join(dir, f), 'utf8').catch(() => '')).trim()
  const head = await read('HEAD')
  const branch = head.startsWith('ref: refs/heads/') ? head.slice(16) : 'HEAD'
  switch (operation(dir).operation) {
    case 'merge':
      return { ours: branch, theirs: await describe(repo, 'MERGE_HEAD') }
    case 'rebase': {
      // During a rebase "ours" is the branch being rebased onto, "theirs" your commit being replayed.
      const onto = (await read('rebase-merge/onto')) || (await read('rebase-apply/onto'))
      const [o, t] = await Promise.all([onto ? describe(repo, onto) : Promise.resolve('upstream'), describe(repo, 'REBASE_HEAD')])
      return { ours: `onto ${o}`, theirs: `your commit ${t}` }
    }
    case 'cherry-pick':
      return { ours: branch, theirs: `cherry-pick ${await describe(repo, 'CHERRY_PICK_HEAD')}` }
    case 'revert':
      return { ours: branch, theirs: `revert of ${await describe(repo, 'REVERT_HEAD')}` }
    default:
      return { ours: branch, theirs: 'Stashed or applied changes' }
  }
}

/**
 * Markers far longer than git's 7 characters: a content line that is exactly
 * "=======" (a Markdown or RST underline) must not be read as the separator.
 */
const MARKER_SIZE = 32
const MARK = {
  start: `${'<'.repeat(MARKER_SIZE)} ours`, base: `${'|'.repeat(MARKER_SIZE)} base`,
  mid: '='.repeat(MARKER_SIZE), end: `${'>'.repeat(MARKER_SIZE)} theirs`,
}

/**
 * Rebuilds the conflict from the index stages with `git merge-file --diff3`, so
 * the base is always available whatever merge.conflictStyle says, then splits
 * the result into common and conflicting chunks.
 */
export async function conflict(repo: string, path: string): Promise<ConflictFile> {
  const [{ blobs: [base, ours, theirs], ids }, lbl] = await Promise.all([stages(repo, path), labels(repo)])
  const disk = await readFile(join(repo, path)).catch(() => null)
  const resolvedOnDisk = !!disk && !isBinary(disk) && !/^<<<<<<< /m.test(disk.toString('utf8'))

  const result: ConflictFile = {
    path, mode: 'text', oursLabel: lbl.ours, theirsLabel: lbl.theirs, hasBase: !!base,
    oursExists: !!ours, theirsExists: !!theirs, chunks: [], eol: '\n', finalNewline: true, resolvedOnDisk, encoding: 'utf8', stages: ids,
  }
  if (!ours || !theirs || isBinary(ours) || isBinary(theirs) || isBinary(base)) {
    result.mode = 'whole'
    return result
  }

  const dir = await mkdtemp(join(tmpdir(), 'gdg-merge-'))
  let mergedRaw: Buffer
  try {
    const files = { ours: join(dir, 'ours'), base: join(dir, 'base'), theirs: join(dir, 'theirs') }
    await Promise.all([writeFile(files.ours, ours), writeFile(files.base, base ?? Buffer.alloc(0)), writeFile(files.theirs, theirs)])
    // Exit code is the number of conflicts; negative (255) only on error.
    const r = await git(repo, ['merge-file', '-p', '--diff3', `--marker-size=${MARKER_SIZE}`, '-L', 'ours', '-L', 'base', '-L', 'theirs', files.ours, files.base, files.theirs], {
      okCodes: Array.from({ length: 127 }, (_, i) => i + 1),
    })
    mergedRaw = r.raw
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }

  // Decode with the encoding the file really has (Windows-1252, UTF-8 with BOM…), so it round-trips.
  result.encoding = detect(ours)
  const merged = decode(mergedRaw, result.encoding)
  // Keep the line endings the file has on disk (autocrlf checkouts), else those of the merge.
  const sample = disk && !isBinary(disk) ? decode(disk, detect(disk)) : merged
  const crlf = (sample.match(/\r\n/g)?.length ?? 0) > (sample.match(/(?<!\r)\n/g)?.length ?? 0)
  result.eol = crlf ? '\r\n' : '\n'
  result.finalNewline = merged.endsWith('\n')
  const lines = merged.split(/\r?\n/)
  if (result.finalNewline) lines.pop()

  let common: string[] = []
  let cur: { ours: string[]; base: string[]; theirs: string[] } | null = null
  let side: 'ours' | 'base' | 'theirs' = 'ours'
  for (const line of lines) {
    if (!cur && line === MARK.start) {
      if (common.length) result.chunks.push({ kind: 'common', lines: common })
      common = []
      cur = { ours: [], base: [], theirs: [] }
      side = 'ours'
    } else if (cur && line === MARK.base && side === 'ours') side = 'base'
    else if (cur && line === MARK.mid && side !== 'theirs') side = 'theirs'
    else if (cur && line === MARK.end && side === 'theirs') {
      result.chunks.push({ kind: 'conflict', ...cur })
      cur = null
    } else if (cur) cur[side].push(line)
    else common.push(line)
  }
  if (cur) common.push(MARK.start, ...cur.ours, MARK.mid, ...cur.theirs) // unterminated: keep as text
  if (common.length) result.chunks.push({ kind: 'common', lines: common })
  return result
}

/** Writes the resolved content and marks the file resolved. */
export async function resolveContent(repo: string, path: string, content: string, encoding: TextEncoding = 'utf8'): Promise<void> {
  await writeFile(join(repo, path), encode(content, encoding))
  await git(repo, ['add', '--', path])
}

/** Resolves a whole-file conflict: keep one side, or delete the file. */
export async function resolveWhole(repo: string, path: string, choice: 'ours' | 'theirs' | 'delete' | 'disk'): Promise<void> {
  if (choice === 'delete') {
    await git(repo, ['rm', '-q', '--', path])
    return
  }
  if (choice !== 'disk') await git(repo, ['checkout', `--${choice}`, '--', path])
  await git(repo, ['add', '--', path])
}

