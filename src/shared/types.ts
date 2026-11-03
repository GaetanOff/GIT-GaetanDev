/* ─── Repositories ──────────────────────────────────────────────────────────── */

export interface RepoEntry {
  id: string
  path: string
  name: string
  lastOpened: number
  pinned?: boolean
}

export type PullMode = 'merge' | 'rebase' | 'ff-only'
export type DiffMode = 'unified' | 'split'
export type HistoryScope = 'current' | 'all'

export interface Settings {
  autoFetchMinutes: number
  pullMode: PullMode
  diffMode: DiffMode
  diffContext: number
  ignoreWhitespace: boolean
  historyScope: HistoryScope
  editorCommand: string
  terminalCommand: string
  confirmDiscard: boolean
  sidebarWidth: number
  listWidth: number
  syntaxHighlight: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  autoFetchMinutes: 5,
  pullMode: 'merge',
  diffMode: 'unified',
  diffContext: 3,
  ignoreWhitespace: false,
  historyScope: 'current',
  editorCommand: '',
  terminalCommand: '',
  confirmDiscard: true,
  sidebarWidth: 248,
  listWidth: 340,
  syntaxHighlight: true,
}

/* ─── Working tree ──────────────────────────────────────────────────────────── */

/** One porcelain-v2 status letter: `.` means unchanged on that side. */
export type StatusChar = '.' | 'M' | 'T' | 'A' | 'D' | 'R' | 'C' | 'U' | '?'

export interface FileChange {
  path: string
  oldPath?: string
  index: StatusChar
  worktree: StatusChar
  conflicted: boolean
  untracked: boolean
  /** For conflicts: the porcelain XY code (UU, AA, DU, …). */
  conflictCode?: string
  submodule?: boolean
}

export type RepoOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null

export interface RepoStatus {
  branch: string | null
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: FileChange[]
  operation: RepoOperation
  /** Rebase progress as "3/7" when a rebase is running. */
  operationStep?: string
  hasCommits: boolean
  stashCount: number
}

export type TextEncoding = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be' | 'windows-1252'

/* ─── Diffs ─────────────────────────────────────────────────────────────────── */

export type DiffLineType = 'ctx' | 'add' | 'del'

export interface DiffLine {
  type: DiffLineType
  text: string
  oldNo?: number
  newNo?: number
  /** "\ No newline at end of file" follows this line. */
  noEol?: boolean
}

export interface DiffHunk {
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  section: string
  lines: DiffLine[]
}

export interface FileDiff {
  path: string
  oldPath?: string
  /** Raw `diff --git` header lines, reused to build partial patches. */
  header: string[]
  hunks: DiffHunk[]
  binary: boolean
  isNew: boolean
  isDeleted: boolean
  modeChange?: string
  additions: number
  deletions: number
  /** Over the line budget: hunks are dropped unless the caller forces. */
  tooLarge?: boolean
  image?: { before?: string; after?: string }
  /** Encoding of the file content; patches are written back with it. */
  encoding: TextEncoding
  /** Git LFS pointer: the real content lives on the LFS server. */
  lfs?: { oid: string; size: number; before?: { oid: string; size: number } }
  submodule?: { before?: string; after?: string }
}

export type DiffSource =
  | { kind: 'worktree'; path: string; untracked?: boolean; conflicted?: boolean }
  | { kind: 'index'; path: string; oldPath?: string }
  | { kind: 'commit'; sha: string; path: string; oldPath?: string }
  | { kind: 'stash'; index: number; path: string; untracked?: boolean }
  | { kind: 'range'; from: string; to: string; path: string; oldPath?: string }

export interface DiffOptions {
  context: number
  ignoreWhitespace: boolean
  force?: boolean
}

/** Line selection for partial staging: hunk index → selected line indexes. */
export type LineSelection = Record<number, number[]>

/* ─── History ───────────────────────────────────────────────────────────────── */

export interface Commit {
  sha: string
  parents: string[]
  author: string
  email: string
  date: number
  subject: string
  refs: string[]
}

export interface CommitFile {
  path: string
  oldPath?: string
  status: string
  additions: number
  deletions: number
  binary: boolean
}

export interface CommitDetail extends Commit {
  body: string
  signature?: Signature
  committer: string
  committerEmail: string
  committerDate: number
  files: CommitFile[]
}

/** message: --grep; author: --author; content: -S (adds/removes the text); regex: -G (diff matches). */
export type SearchMode = 'message' | 'author' | 'content' | 'regex'

export interface LogQuery {
  scope: HistoryScope
  skip: number
  limit: number
  search?: string
  searchMode?: SearchMode
  path?: string
}

/* ─── Compare ───────────────────────────────────────────────────────────────── */

export interface CompareResult {
  base: string
  head: string
  /** Resolved commit the file diff starts from: the merge base in three-dot mode. */
  from: string
  to: string
  mergeBase: string | null
  /** Commits in head that base does not have, newest first. */
  ahead: Commit[]
  /** Number of commits in base that head does not have. */
  behind: number
  files: CommitFile[]
  threeDot: boolean
}

/* ─── Reflog / undo ─────────────────────────────────────────────────────────── */

export type OperationKind = 'commit' | 'amend' | 'checkout' | 'reset' | 'merge' | 'rebase' | 'pull' | 'cherry-pick' | 'revert' | 'other'

/** One user-level operation reconstructed from HEAD's reflog (a rebase is one entry, not many). */
export interface RepoOperationEntry {
  id: string
  kind: OperationKind
  title: string
  detail: string
  date: number
  /** HEAD and branch just before the operation: the point "undo" goes back to. */
  before: { sha: string; branch: string | null }
  after: { sha: string; branch: string | null }
}

/** A local branch that no longer exists, with the last commit it is known to have pointed to. */
export interface DeletedBranch {
  name: string
  sha: string
  date: number
  subject: string
  /** reflog: guessed from HEAD's history; app: recorded when the app deleted it (exact). */
  source: 'reflog' | 'app'
}

/** A more recent commit found for a deleted branch than its last known tip. */
export interface NewerTip {
  name: string
  sha: string
  /** Commits between the known tip and this one. */
  ahead: number
  subject: string
  date: number
  /** remote: still on a remote-tracking branch (pushed from elsewhere); unreferenced: only in git's object store. */
  via: 'remote' | 'unreferenced'
  ref?: string
}

export interface RestorePoint {
  sha: string
  branch: string | null
}

/* ─── Interactive rebase ────────────────────────────────────────────────────── */

export type RebaseAction = 'pick' | 'reword' | 'squash' | 'fixup' | 'drop'

export interface RebaseStep {
  /** Empty for a structural line. */
  sha: string
  /** `line`: a label, reset or merge line of a --rebase-merges plan, passed through as is. */
  action: RebaseAction | 'line'
  /** New message for a reword, or for a commit absorbing squashes. */
  message?: string
  line?: string
}

/** One entry of git's own --rebase-merges plan: a commit, or a structural line. */
export type RebaseTodoItem = { kind: 'pick'; sha: string } | { kind: 'line'; text: string }

export interface RebasePlan {
  base: string | null
  commits: (Commit & { body: string })[]
  hasMerges: boolean
  /** How many of these commits are already on the upstream (a force push follows). */
  pushed: number
  /** With merges in range: git's plan, in order (commits and label/reset/merge lines). */
  structure?: RebaseTodoItem[]
}

/** A commit that touched a file, with the file's path in that commit (it follows renames). */
export interface FileCommit extends Commit {
  path: string
  oldPath?: string
  status: string
}

/* ─── Blame ─────────────────────────────────────────────────────────────────── */

export interface BlameCommit {
  sha: string
  author: string
  email: string
  date: number
  summary: string
  /** Where the line came from before this commit, to blame further back. */
  previous?: { sha: string; path: string }
  uncommitted: boolean
}

export interface BlameLine {
  sha: string
  /** Line number in the commit that introduced it. */
  origLine: number
  text: string
}

export interface Blame {
  path: string
  rev: string | null
  lines: BlameLine[]
  commits: Record<string, BlameCommit>
}

/* ─── Conflicts ─────────────────────────────────────────────────────────────── */

export type ConflictChunk =
  | { kind: 'common'; lines: string[] }
  | { kind: 'conflict'; ours: string[]; base: string[]; theirs: string[] }

export interface ConflictFile {
  path: string
  /** `text`: chunk by chunk; `whole`: binary, or deleted on one side — pick a side. */
  mode: 'text' | 'whole'
  oursLabel: string
  theirsLabel: string
  hasBase: boolean
  oursExists: boolean
  theirsExists: boolean
  chunks: ConflictChunk[]
  eol: '\n' | '\r\n'
  encoding: TextEncoding
  finalNewline: boolean
  /** The file on disk has no conflict markers left: it was resolved elsewhere. */
  resolvedOnDisk: boolean
}

/* ─── Refs ──────────────────────────────────────────────────────────────────── */

export interface Branch {
  name: string
  fullRef: string
  remote: boolean
  remoteName?: string
  sha: string
  upstream?: string
  ahead: number
  behind: number
  gone: boolean
  current: boolean
  date: number
  subject: string
}

export interface Tag {
  name: string
  sha: string
  date: number
  subject: string
}

export interface Remote {
  name: string
  fetchUrl: string
  pushUrl: string
  provider: ProviderInfo | null
}

export interface Stash {
  index: number
  ref: string
  sha: string
  date: number
  message: string
  branch: string
}

export interface Submodule {
  path: string
  url: string
  sha: string
  /** uninitialized: not cloned yet; modified: checked out at another commit than recorded. */
  state: 'ok' | 'uninitialized' | 'modified' | 'conflict'
  describe: string
}

export interface Worktree {
  path: string
  head: string
  branch: string | null
  current: boolean
  locked: boolean
  prunable: boolean
  bare: boolean
}

export interface LfsInfo {
  /** .gitattributes routes files through LFS. */
  used: boolean
  /** git-lfs is installed on this machine. */
  installed: boolean
}

export interface Refs {
  branches: Branch[]
  tags: Tag[]
  remotes: Remote[]
  stashes: Stash[]
  submodules: Submodule[]
  worktrees: Worktree[]
  lfs: LfsInfo
}

export interface Author {
  name: string
  email: string
  commits: number
}

/** G good, U good but untrusted key, B bad, X/Y expired, R revoked, E cannot check, N unsigned. */
export interface Signature {
  status: 'G' | 'U' | 'B' | 'X' | 'Y' | 'R' | 'E' | 'N'
  signer: string
  key: string
}

/* ─── Providers ─────────────────────────────────────────────────────────────── */

export type ProviderKind = 'github' | 'gitlab' | 'azure' | 'bitbucket' | 'gitea' | 'generic'

export interface ProviderInfo {
  kind: ProviderKind
  label: string
  host: string
  /** Web URL of the repository home page. */
  web: string
}

export type ProviderLink =
  | { type: 'repo' }
  | { type: 'commit'; sha: string }
  | { type: 'branch'; branch: string }
  | { type: 'pr'; branch: string; base?: string }
  | { type: 'file'; ref: string; path: string }

/* ─── Long-running operations ───────────────────────────────────────────────── */

export interface Progress {
  op: string
  title: string
  phase?: string
  percent?: number
}

export interface AskPassRequest {
  id: string
  prompt: string
  kind: 'password' | 'text' | 'confirm'
}

export type ResetMode = 'soft' | 'mixed' | 'hard'

export interface GitIdentity {
  name: string
  email: string
}

export interface RepoChangeEvent {
  repo: string
  /** `worktree`: files changed; `meta`: refs, HEAD or index changed. */
  kinds: ('worktree' | 'meta')[]
}
