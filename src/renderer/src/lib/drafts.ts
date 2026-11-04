import type { RepoStatus } from '@shared/types'

/**
 * A repository's commit message being written. `prefill`: the text was git's
 * prepared message (a merge, a cherry-pick, a squash), for the commit named
 * by `for` (see pendingCommit), and what it said then.
 */
export interface Draft {
  summary: string
  body: string
  amend: boolean
  coAuthors?: string[]
  prefill?: { for: string; text: string }
}

/** The merge, cherry-pick or revert commit waiting to be made, as "operation:commit"; '' when none. */
export function pendingCommit(s: RepoStatus | null | undefined): string {
  return s && (s.operation === 'merge' || s.operation === 'cherry-pick' || s.operation === 'revert') ? `${s.operation}:${s.operationHead ?? ''}` : ''
}

/** Whether the draft still says what git prepared, untouched. */
export const untouchedPrefill = (d: Draft): boolean => !!d.prefill && `${d.summary}\n${d.body}` === d.prefill.text

/**
 * The message a "Continue" commits the pending merge, cherry-pick or revert
 * with: the box's, only when it is git's prepared message for that very
 * commit, maybe corrected there. Otherwise undefined, and git uses its own.
 */
export function continueMessage(d: Draft, s: RepoStatus | null | undefined): string | undefined {
  const pending = pendingCommit(s)
  if (!pending || d.prefill?.for !== pending || !d.summary.trim()) return undefined
  return [d.summary.trim(), d.body.trim()].filter(Boolean).join('\n\n')
}
