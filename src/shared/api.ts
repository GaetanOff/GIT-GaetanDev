import type {
  AskPassRequest, Blame, Commit, ConflictFile, FileCommit, CommitDetail, DiffOptions, DiffSource, FileDiff, GitIdentity, LineSelection,
  LogQuery, Progress, ProviderLink, Refs, RepoChangeEvent, RepoEntry, RepoStatus, ResetMode, Settings,
} from './types'

/**
 * Every call the renderer can make into the main process. Each method maps to
 * one IPC channel of the same name; the preload builds the client from this
 * list so the two sides cannot drift.
 */
export interface Api {
  /* App & repositories */
  'app:state'(): Promise<{ repos: RepoEntry[]; lastRepo: string | null; settings: Settings; platform: string; version: string; home: string }>
  'app:settings'(patch: Partial<Settings>): Promise<Settings>
  'repo:list'(): Promise<RepoEntry[]>
  'repo:add'(path: string): Promise<RepoEntry>
  'repo:init'(path: string): Promise<RepoEntry>
  'repo:clone'(url: string, parent: string, name: string): Promise<RepoEntry>
  'repo:remove'(id: string): Promise<RepoEntry[]>
  'repo:open'(id: string): Promise<RepoEntry>
  'repo:pin'(id: string, pinned: boolean): Promise<RepoEntry[]>
  'dialog:pickFolder'(title: string): Promise<string | null>

  /* Working tree */
  'git:status'(repo: string): Promise<RepoStatus>
  'git:diff'(repo: string, source: DiffSource, opts: DiffOptions): Promise<FileDiff>
  'git:stage'(repo: string, paths: string[]): Promise<void>
  'git:unstage'(repo: string, paths: string[]): Promise<void>
  'git:stageLines'(repo: string, path: string, selection: LineSelection, untracked: boolean): Promise<void>
  'git:unstageLines'(repo: string, path: string, selection: LineSelection): Promise<void>
  'git:discard'(repo: string, paths: string[]): Promise<void>
  'git:discardLines'(repo: string, path: string, selection: LineSelection): Promise<void>
  'git:ignore'(repo: string, pattern: string): Promise<void>
  'git:commit'(repo: string, message: string, amend: boolean): Promise<string>
  'git:lastCommitMessage'(repo: string): Promise<string>
  'git:preparedMessage'(repo: string): Promise<string>
  'git:undoCommit'(repo: string): Promise<string>
  'git:resolve'(repo: string, path: string, side: 'ours' | 'theirs'): Promise<void>
  'git:continue'(repo: string): Promise<void>
  'git:abort'(repo: string): Promise<void>
  'git:skip'(repo: string): Promise<void>
  'git:conflict'(repo: string, path: string): Promise<ConflictFile>
  'git:resolveContent'(repo: string, path: string, content: string): Promise<void>
  'git:resolveWhole'(repo: string, path: string, choice: 'ours' | 'theirs' | 'delete' | 'disk'): Promise<void>

  /* History */
  'git:log'(repo: string, query: LogQuery): Promise<Commit[]>
  'git:commit:detail'(repo: string, sha: string): Promise<CommitDetail>
  'git:cherryPick'(repo: string, sha: string): Promise<void>
  'git:revert'(repo: string, sha: string): Promise<void>
  'git:reset'(repo: string, sha: string, mode: ResetMode): Promise<void>
  'git:checkoutCommit'(repo: string, sha: string): Promise<void>
  'git:fileLog'(repo: string, path: string, skip: number, limit: number): Promise<FileCommit[]>
  'git:blame'(repo: string, path: string, rev: string | null): Promise<Blame>

  /* Refs */
  'git:refs'(repo: string): Promise<Refs>
  'git:checkout'(repo: string, branch: string, opts?: { stash?: boolean }): Promise<void>
  'git:createBranch'(repo: string, name: string, from: string | null, checkout: boolean): Promise<void>
  'git:renameBranch'(repo: string, from: string, to: string): Promise<void>
  'git:deleteBranch'(repo: string, name: string, force: boolean): Promise<void>
  'git:deleteRemoteBranch'(repo: string, remote: string, branch: string): Promise<void>
  'git:merge'(repo: string, ref: string, opts?: { squash?: boolean; noFf?: boolean }): Promise<void>
  'git:rebase'(repo: string, onto: string): Promise<void>
  'git:createTag'(repo: string, name: string, sha: string, message: string): Promise<void>
  'git:deleteTag'(repo: string, name: string): Promise<void>
  'git:pushTag'(repo: string, remote: string, name: string): Promise<void>
  'git:stash'(repo: string, message: string, includeUntracked: boolean, paths?: string[]): Promise<void>
  'git:stashApply'(repo: string, index: number, pop: boolean): Promise<void>
  'git:stashDrop'(repo: string, index: number): Promise<void>
  'git:stashFiles'(repo: string, index: number): Promise<CommitDetail>
  'git:addRemote'(repo: string, name: string, url: string): Promise<void>
  'git:removeRemote'(repo: string, name: string): Promise<void>

  /* Network */
  'git:fetch'(repo: string): Promise<void>
  'git:pull'(repo: string): Promise<void>
  'git:push'(repo: string, opts?: { force?: boolean; setUpstream?: boolean }): Promise<void>

  /* Config & integrations */
  'git:identity'(repo: string | null): Promise<GitIdentity & { scope: 'local' | 'global' | 'none' }>
  'git:setIdentity'(repo: string | null, identity: GitIdentity): Promise<void>
  'provider:url'(repo: string, link: ProviderLink): Promise<string | null>
  'shell:openUrl'(url: string): Promise<void>
  'shell:reveal'(repo: string, path?: string): Promise<void>
  'shell:editor'(repo: string, path?: string): Promise<void>
  'shell:terminal'(repo: string): Promise<void>
  'clipboard:write'(text: string): Promise<void>
  'askpass:respond'(id: string, value: string | null): Promise<void>
  'watch:set'(repo: string | null): Promise<void>
}

export type ApiChannel = keyof Api

export const API_CHANNELS: ApiChannel[] = [
  'app:state', 'app:settings', 'repo:list', 'repo:add', 'repo:init', 'repo:clone', 'repo:remove', 'repo:open', 'repo:pin',
  'dialog:pickFolder',
  'git:status', 'git:diff', 'git:stage', 'git:unstage', 'git:stageLines', 'git:unstageLines', 'git:discard',
  'git:discardLines', 'git:ignore', 'git:commit', 'git:lastCommitMessage', 'git:preparedMessage', 'git:undoCommit', 'git:resolve',
  'git:continue', 'git:abort', 'git:skip', 'git:conflict', 'git:resolveContent', 'git:resolveWhole',
  'git:log', 'git:commit:detail', 'git:cherryPick', 'git:revert', 'git:reset', 'git:checkoutCommit', 'git:fileLog', 'git:blame',
  'git:refs', 'git:checkout', 'git:createBranch', 'git:renameBranch', 'git:deleteBranch', 'git:deleteRemoteBranch',
  'git:merge', 'git:rebase', 'git:createTag', 'git:deleteTag', 'git:pushTag', 'git:stash', 'git:stashApply',
  'git:stashDrop', 'git:stashFiles', 'git:addRemote', 'git:removeRemote',
  'git:fetch', 'git:pull', 'git:push',
  'git:identity', 'git:setIdentity', 'provider:url', 'shell:openUrl', 'shell:reveal', 'shell:editor', 'shell:terminal',
  'clipboard:write', 'askpass:respond', 'watch:set',
]

/** Events pushed from main to renderer. */
export interface ApiEvents {
  'repo:changed': RepoChangeEvent
  'progress': Progress | null
  'askpass': AskPassRequest
  'menu': string
}

/** Errors cross IPC as plain data so the renderer gets a clean message. */
export interface IpcEnvelope<T> {
  ok: boolean
  value?: T
  error?: { message: string; code?: string }
}

/**
 * Stable error codes the UI reacts to (offer a stash, force-push, …).
 * Anything else is shown as-is.
 */
export type GitErrorCode =
  | 'LOCAL_CHANGES_OVERWRITTEN'
  | 'NON_FAST_FORWARD'
  | 'NO_UPSTREAM'
  | 'AUTH_FAILED'
  | 'CONFLICTS'
  | 'NOTHING_TO_COMMIT'
  | 'BRANCH_NOT_MERGED'
  | 'NOT_A_REPO'
  | 'CANCELLED'
  | 'GIT_NOT_FOUND'
