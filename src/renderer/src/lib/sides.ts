import type { RepoOperation } from '@shared/types'

export interface ConflictSide {
  /** git's name for it, as `checkout --ours/--theirs` takes it. */
  side: 'ours' | 'theirs'
  label: string
  title: string
  /** What the file becomes, in "… becomes your version as a whole". */
  becomes: string
  confirmLabel: string
}

/**
 * The user's own version of a conflicted file, then the other one. During a
 * rebase (a pull with rebase too) git's "ours" is the branch being rebased
 * onto and "theirs" the user's commit being replayed: "Use my version (ours)"
 * kept the upstream file, and the user's change left the rebased commit.
 * With no operation under way, the conflict comes from putting changes back
 * (a stash applied, the changes a pull or a switch set aside): "theirs" are
 * those changes, "ours" the branch. "Use my version (ours)" kept the branch's
 * file, and the user's own edits left it.
 */
export function conflictSides(op: RepoOperation | null | undefined): [ConflictSide, ConflictSide] {
  if (op === 'rebase') {
    return [
      { side: 'theirs', label: 'Use my commit’s version (theirs)', title: 'Use your commit’s version?', becomes: 'your commit’s version', confirmLabel: 'Use mine' },
      { side: 'ours', label: 'Use the version rebased onto (ours)', title: 'Use the version rebased onto?', becomes: 'the version your commit is rebased onto', confirmLabel: 'Use it' },
    ]
  }
  if (!op) {
    return [
      { side: 'theirs', label: 'Use my changes put back (theirs)', title: 'Use your changes put back?', becomes: 'your stashed or set-aside changes', confirmLabel: 'Use mine' },
      { side: 'ours', label: 'Use the branch’s version (ours)', title: 'Use the branch’s version?', becomes: 'the branch’s version', confirmLabel: 'Use it' },
    ]
  }
  return [
    { side: 'ours', label: 'Use my version (ours)', title: 'Use your version?', becomes: 'your version', confirmLabel: 'Use mine' },
    { side: 'theirs', label: 'Use their version (theirs)', title: 'Use their version?', becomes: 'their version', confirmLabel: 'Use theirs' },
  ]
}
