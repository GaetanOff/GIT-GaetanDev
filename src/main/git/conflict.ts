import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import type { ConflictFile, TextEncoding } from '@shared/types'
import { decode, detect, encode } from './encoding'
import { git, GitError, literal } from './exec'
import { gitDir, operation } from './status'

/**
 * Past this size a side is not read and merged line by line (four copies of
 * it would sit in memory): the conflict is resolved by picking a side, as for
 * a binary file.
 */
const MAX_SIDE = 16 * 1024 * 1024

/** The index stages of a path (1 base, 2 ours, 3 theirs): object ids and modes, and whether one is a submodule's commit. */
async function stageIds(repo: string, path: string): Promise<{ sha: Record<string, string>; mode: Record<string, string>; gitlink: boolean }> {
  const out = (await git(repo, ['ls-files', '-s', '--', path])).stdout
  const sha: Record<string, string> = {}
  const modes: Record<string, string> = {}
  let gitlink = false
  for (const line of out.split('\n')) {
    const [meta] = line.split('\t')
    const [mode, objectId, n] = meta.split(' ')
    if (n) {
      sha[n] = objectId
      modes[n] = mode
    }
    if (mode === '160000') gitlink = true
  }
  return { sha, mode: modes, gitlink }
}

/**
 * The encoding git converts the file from when it stores it, and back when it
 * writes it (`working-tree-encoding`, as for UTF-16 files on Windows), unless
 * it is UTF-8. Its index stages are then UTF-8 while the file on disk is not.
 */
async function treeEncoding(repo: string, path: string): Promise<string | null> {
  const out = (await git(repo, ['check-attr', '-z', 'working-tree-encoding', '--', path])).stdout
  const value = out.split('\0')[2] ?? ''
  return value && !/^(unspecified|unset|set|utf-?8)$/i.test(value) ? value : null
}

/**
 * Raw bytes of the index stages (1 base, 2 ours, 3 theirs), null where a side
 * has no file, and their blob ids, which tell one conflict from another.
 * `large`: a side is over MAX_SIDE, and its bytes are only the beginning.
 * `gitlink`: a submodule's conflict, whose sides are commits, not files.
 */
async function stages(repo: string, path: string): Promise<{ blobs: [Buffer | null, Buffer | null, Buffer | null]; ids: string; large: boolean; gitlink: boolean }> {
  const { sha, gitlink } = await stageIds(repo, path)
  let large = false
  const read = async (n: string) => {
    if (!sha[n] || gitlink) return null
    const r = await git(repo, ['cat-file', 'blob', sha[n]], { maxBytes: MAX_SIDE })
    if (r.truncated) large = true
    return r.raw
  }
  const blobs = await Promise.all([read('1'), read('2'), read('3')])
  return { blobs, ids: ['1', '2', '3'].map(n => sha[n] ?? '-').join(' '), large, gitlink }
}

/** The file on disk, unless it is missing or too large to read whole. */
async function readDisk(file: string): Promise<Buffer | null> {
  const size = await stat(file).then(s => s.size, () => -1)
  return size >= 0 && size <= MAX_SIDE ? readFile(file).catch(() => null) : null
}

/** What the file on disk is, to tell whether it changed: a hash of its bytes, else its size and time. */
async function fingerprint(file: string, bytes?: Buffer | null): Promise<string> {
  const data = bytes === undefined ? await readDisk(file) : bytes
  if (data) return createHash('sha1').update(data).digest('hex')
  return stat(file).then(s => `${s.size}:${s.mtimeMs}`, () => 'missing')
}

const isBinary = (b: Buffer | null) => !!b && b.subarray(0, 8000).includes(0)
const isLfsPointer = (b: Buffer | null) => !!b && b.length < 1024 && b.subarray(0, 40).toString('utf8').startsWith('version https://git-lfs.github.com/spec/')

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

const isAscii = (b: Buffer) => b.every(c => c < 0x80)

const hasBom = (b: Buffer | null) => !!b && detect(b) === 'utf8-bom'

/**
 * The encoding the resolved file is written back in, so it round-trips.
 * Windows-1252 when the first side whose text is not plain ASCII (ours first)
 * is in it. The BOM is merged like any other change: theirs only when ours
 * left it as the base had it, so a BOM ours removed does not come back.
 */
function fileEncoding(ours: Buffer, theirs: Buffer, base: Buffer | null): TextEncoding {
  const telling = [ours, theirs, base].find(b => b && !isAscii(hasBom(b) ? b.subarray(3) : b))
  if (telling && detect(telling) === 'windows-1252') return 'windows-1252'
  return (hasBom(ours) === hasBom(base) ? hasBom(theirs) : hasBom(ours)) ? 'utf8-bom' : 'utf8'
}

/**
 * Rebuilds the conflict from the index stages with `git merge-file --diff3`, so
 * the base is always available whatever merge.conflictStyle says, then splits
 * the result into common and conflicting chunks.
 */
export async function conflict(repo: string, path: string): Promise<ConflictFile> {
  const [{ blobs: [base, ours, theirs], ids, large, gitlink }, lbl] = await Promise.all([stages(repo, path), labels(repo)])
  const disk = await readDisk(join(repo, path))
  const resolvedOnDisk = !!disk && !isBinary(disk) && !/^<<<<<<< /m.test(disk.toString('utf8'))
  const [hasBase, oursExists, theirsExists] = ids.split(' ').map(id => id !== '-')

  const result: ConflictFile = {
    path, mode: 'text', oursLabel: lbl.ours, theirsLabel: lbl.theirs, hasBase, oursExists, theirsExists,
    chunks: [], eol: '\n', finalNewline: true, resolvedOnDisk, encoding: 'utf8', stages: ids, disk: await fingerprint(join(repo, path), disk),
  }
  // Git LFS keeps pointers in the index: mixing their lines makes an invalid pointer, and the
  // file written back would be the pointer's text instead of the real content. A submodule's
  // sides are commits ("git cat-file blob" failed with "bad file"): one is kept, as a whole.
  const lfs = [base, ours, theirs].some(isLfsPointer)
  if (gitlink || large || lfs || !ours || !theirs || isBinary(ours) || isBinary(theirs) || isBinary(base)) {
    result.mode = 'whole'
    return result
  }

  // Each side is decoded with its own encoding and merged as UTF-8 without a BOM: a BOM on line 1
  // would stand in front of the conflict marker, and a Windows-1252 side would not read as text.
  result.encoding = fileEncoding(ours, theirs, base)
  const utf8 = (side: Buffer | null) => (side ? Buffer.from(decode(side), 'utf8') : Buffer.alloc(0))
  const dir = await mkdtemp(join(tmpdir(), 'gdg-merge-'))
  let mergedRaw: Buffer
  try {
    const files = { ours: join(dir, 'ours'), base: join(dir, 'base'), theirs: join(dir, 'theirs') }
    await Promise.all([writeFile(files.ours, utf8(ours)), writeFile(files.base, utf8(base)), writeFile(files.theirs, utf8(theirs))])
    // Exit code is the number of conflicts; negative (255) only on error.
    const r = await git(repo, ['merge-file', '-p', '--diff3', `--marker-size=${MARKER_SIZE}`, '-L', 'ours', '-L', 'base', '-L', 'theirs', files.ours, files.base, files.theirs], {
      okCodes: Array.from({ length: 127 }, (_, i) => i + 1),
    })
    mergedRaw = r.raw
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }

  const merged = mergedRaw.toString('utf8')
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

/**
 * Writes the resolved content and marks the file resolved. Only a file git
 * lists as unmerged, and never through a symbolic link: this is the one
 * place the app writes a file of the repository itself, so it writes no
 * other (a hook, a config read through a link to .git). With `expect`, the
 * conflict's `disk` fingerprint: the result was built from the file as it
 * was then, and edits made since in an editor are not overwritten.
 */
export async function resolveContent(repo: string, path: string, content: string, encoding: TextEncoding = 'utf8', expect?: string): Promise<void> {
  const unmerged = (await git(repo, ['ls-files', '-u', '-z', '--', path])).stdout
  if (!unmerged.split('\0').some(l => l.split('\t')[1] === path.replace(/\\/g, '/'))) {
    throw new GitError(`${path} is not in conflict, so nothing was written.`)
  }
  const file = join(repo, path)
  const [root, parent] = await Promise.all([realpath(repo), realpath(dirname(file))])
  const link = await lstat(file).then(s => s.isSymbolicLink(), () => false)
  if (link || (parent !== root && !parent.startsWith(root.endsWith(sep) ? root : root + sep))) {
    throw new GitError(`${path} is reached through a symbolic link, so it was not written. Resolve it from the command line.`)
  }
  if (expect !== undefined && (await fingerprint(file)) !== expect) {
    throw new GitError(`${path} changed on disk since it was opened here (in an editor?), so nothing was written. It is shown again as it is now.`, 'CHANGED_ON_DISK')
  }
  if (await treeEncoding(repo, path)) {
    // The sides merged here are UTF-8, as git stores the file. Written so to disk, "git add" read it
    // as UTF-16 and staged garbage: the result is stored the way git stores it, then git writes the
    // file in its own encoding and line endings.
    const { mode } = await stageIds(repo, path)
    const blob = (await git(repo, ['hash-object', '-w', '--no-filters', '--stdin'], { input: Buffer.from(content, 'utf8') })).stdout.trim()
    await git(repo, ['update-index', '--cacheinfo', `${mode['2'] ?? mode['3'] ?? '100644'},${blob},${path}`])
    await git(repo, ['checkout', '--', literal(path)])
    return
  }
  await writeFile(file, encode(content, encoding))
  await git(repo, ['add', '--', path])
}

/**
 * Resolves a whole-file conflict: keep one side, or delete the file. With
 * `expect` (the conflict's `disk` fingerprint), a file changed on disk since
 * the conflict was shown (adapted in an editor meanwhile) is not replaced.
 */
export async function resolveWhole(repo: string, path: string, choice: 'ours' | 'theirs' | 'delete' | 'disk', expect?: string): Promise<void> {
  const { sha, gitlink } = await stageIds(repo, path)
  // A submodule's pick writes the index only: its folder is not replaced.
  if (expect !== undefined && choice !== 'disk' && !gitlink && (await fingerprint(join(repo, path))) !== expect) {
    throw new GitError(`${path} changed on disk since it was opened here (in an editor?), so nothing was replaced. It is shown again as it is now.`, 'CHANGED_ON_DISK')
  }
  if (choice === 'delete') {
    await git(repo, ['rm', '-q', '--', path])
    return
  }
  if (gitlink && choice !== 'disk') {
    // "checkout --theirs" does nothing to a submodule, and the "add" after it recorded the commit the
    // submodule had checked out, ours: the side picked is written into the index directly instead.
    const pick = sha[choice === 'ours' ? '2' : '3']
    if (!pick) throw new GitError(`${path} has no ${choice} side.`)
    await git(repo, ['update-index', '--cacheinfo', `160000,${pick},${path}`])
    return
  }
  if (choice !== 'disk') await git(repo, ['checkout', `--${choice}`, '--', literal(path)])
  await git(repo, ['add', '--', path])
}

