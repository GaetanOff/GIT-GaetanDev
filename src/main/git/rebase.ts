import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RebasePlan, RebaseStep } from '@shared/types'
import { git, gitOut, GitError } from './exec'
import { upstreamOf, currentBranch } from './refs'
import { gitDir } from './status'

const RS = '\x1e'
const US = '\x1f'

/** Commits after `base` (null: from the root), oldest first, as the rebase will replay them. */
export async function rebasePlan(repo: string, base: string | null): Promise<RebasePlan> {
  const range = base ? `${base}..HEAD` : 'HEAD'
  const out = await gitOut(repo, ['log', '--reverse', `--format=%H${US}%P${US}%an${US}%ae${US}%at${US}%s${US}%b${RS}`, range])
  const commits = out.split(RS).map(r => r.replace(/^\n/, '')).filter(Boolean).map(r => {
    const [sha, parents, author, email, date, subject, body] = r.split(US)
    return { sha, parents: parents ? parents.split(' ') : [], author, email, date: +date, subject, body: (body ?? '').trim(), refs: [] }
  })

  let pushed = 0
  const branch = await currentBranch(repo)
  const upstream = branch ? await upstreamOf(repo, branch) : null
  if (upstream && commits.length) {
    const local = +(await gitOut(repo, ['rev-list', '--count', range, `^${upstream}`])).trim()
    pushed = commits.length - local
  }
  return { base, commits, hasMerges: commits.some(c => c.parents.length > 1), pushed }
}

const posix = (p: string) => p.replace(/\\/g, '/')
const quote = (p: string) => `"${posix(p).replace(/"/g, '\\"')}"`

/**
 * Runs `git rebase -i` with a todo list written by the app. Squash groups and
 * rewords are done with `fixup` plus an `exec git commit --amend -F <file>`,
 * so git never opens an editor. Message files live in the git dir because a
 * rebase stopped on a conflict still needs them when it continues.
 */
export async function rebaseRun(repo: string, base: string | null, steps: RebaseStep[]): Promise<void> {
  const kept = steps.filter(s => s.action !== 'drop')
  if (!kept.length) throw new GitError('Every commit is dropped. Use a reset instead if that is what you want.')
  if (kept[0].action === 'squash' || kept[0].action === 'fixup') throw new GitError('The first commit cannot be squashed: there is nothing before it to squash into.')

  const dir = join(await gitDir(repo), 'gdg-rebase')
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })

  const todo: string[] = []
  let pending: string | null = null // message to apply once the current group ends
  let n = 0
  const flush = async () => {
    if (pending === null) return
    const file = join(dir, `msg-${++n}.txt`)
    await writeFile(file, pending, 'utf8')
    todo.push(`exec git commit --amend --allow-empty --cleanup=strip -F ${quote(file)}`)
    pending = null
  }

  for (const s of steps) {
    if (s.action === 'drop') {
      todo.push(`drop ${s.sha}`)
      continue
    }
    if (s.action === 'squash' || s.action === 'fixup') {
      todo.push(`fixup ${s.sha}`)
      continue
    }
    await flush()
    todo.push(`pick ${s.sha}`)
    if (s.message !== undefined && (s.action === 'reword' || s.message.trim())) pending = s.message
  }
  await flush()

  const todoFile = join(dir, 'todo')
  await writeFile(todoFile, `${todo.join('\n')}\n`, 'utf8')
  await git(repo, ['rebase', '-i', '--autostash', ...(base ? [base] : ['--root'])], {
    env: { GIT_SEQUENCE_EDITOR: `cp ${quote(todoFile)}`, GIT_EDITOR: 'true' },
  })
}
