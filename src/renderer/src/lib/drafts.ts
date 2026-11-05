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
  /**
   * What the box held when Amend was ticked, put back when it is unticked.
   * The repository's own: kept by the commit box for all of them, another
   * tab's text came back here, and after a restart none did.
   */
  amendBackup?: { summary: string; body: string }
}

/** The merge, cherry-pick or revert commit waiting to be made, as "operation:commit"; '' when none. */
export function pendingCommit(s: RepoStatus | null | undefined): string {
  return s && (s.operation === 'merge' || s.operation === 'cherry-pick' || s.operation === 'revert') ? `${s.operation}:${s.operationHead ?? ''}` : ''
}

/**
 * The draft once a commit is undone; says whether it held a message being
 * written, which is kept. Otherwise the commit's message comes back, with
 * Amend ticked again for an amend taken back, and as git's prepared message
 * for a merge in progress again (`pending`, see pendingCommit). Amend never
 * stays ticked once the branch went back past the commit it was for: kept
 * with a message being written, the next commit amended that commit's parent.
 */
export function draftAfterUndo(d: Draft, undone: { message: string; amended: boolean }, pending: string): boolean {
  const writing = !!(d.summary.trim() || d.body.trim())
  if (!writing) {
    const [summary, ...rest] = undone.message.split('\n')
    const body = rest.join('\n').trim()
    Object.assign(d, { summary, body, amend: undone.amended, amendBackup: undefined, prefill: pending ? { for: pending, text: `${summary}\n${body}` } : undefined })
  } else if (d.amend && !undone.amended) {
    Object.assign(d, { amend: false, amendBackup: undefined })
  }
  return writing
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
