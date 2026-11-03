import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RebasePlan, RebaseStep, RebaseTodoItem } from '@shared/types'
import { git, gitOut, GitError } from './exec'
import { upstreamOf, currentBranch } from './refs'
import { gitDir } from './status'

const RS = '\x1e'
const US = '\x1f'

const posix = (p: string) => p.replace(/\\/g, '/')
const quote = (p: string) => `"${posix(p).replace(/"/g, '\\"')}"`

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
  const hasMerges = commits.some(c => c.parents.length > 1)
  const structure = hasMerges ? await extractTodo(repo, base, commits.map(c => c.sha)) : undefined
  return { base, commits, hasMerges, pushed, structure }
}

/**
 * Asks git for the todo it would run with `--rebase-merges` (labels, resets,
 * merges) without running it: the sequence editor copies the list out and
 * empties it, so git stops with "nothing to do" and restores everything,
 * autostash included.
 */
async function extractTodo(repo: string, base: string | null, shas: string[]): Promise<RebaseTodoItem[]> {
  const dir = join(await gitDir(repo), 'gdg-rebase')
  await mkdir(dir, { recursive: true })
  const out = join(dir, 'generated-todo')
  await rm(out, { force: true })
  await git(repo, ['rebase', '-i', '--rebase-merges', '--autostash', ...(base ? [base] : ['--root'])], {
    env: { GIT_SEQUENCE_EDITOR: `f() { cp "$1" ${quote(out)}; : > "$1"; }; f`, GIT_EDITOR: 'true' },
    okCodes: [1],
  })
  const text = await readFile(out, 'utf8').catch(() => '')
  if (!text) throw new GitError('Git did not produce a rebase plan for this range.')

  const items: RebaseTodoItem[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (!line || (line.startsWith('#') && !line.startsWith('# Branch '))) continue
    const pick = /^pick ([0-9a-f]+)/.exec(line)
    const full = pick && shas.find(s => s.startsWith(pick[1]))
    if (full) items.push({ kind: 'pick', sha: full })
    else items.push({ kind: 'line', text: line })
  }
  return items
}

/**
 * Runs `git rebase -i` with a todo list written by the app. Squash groups and
 * rewords are done with `fixup` plus an `exec git commit --amend -F <file>`,
 * so git never opens an editor. With merges in range, the structural lines
 * from git's own `--rebase-merges` plan (labels, resets, merges) are passed
 * through as `line` steps, and commits are reordered or squashed only within
 * the stretch between two such lines. Message files live in the git dir
 * because a rebase stopped on a conflict still needs them when it continues.
 */
export async function rebaseRun(repo: string, base: string | null, steps: RebaseStep[]): Promise<void> {
  const commits = steps.filter(s => s.action !== 'line')
  if (!commits.some(s => s.action !== 'drop')) throw new GitError('Every commit is dropped. Use a reset instead if that is what you want.')

  const dir = join(await gitDir(repo), 'gdg-rebase')
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })

  const todo: string[] = []
  let pending: string | null = null // message to apply once the current group ends
  let canSquash = false // a kept pick precedes in the current stretch
  let n = 0
  const flush = async () => {
    if (pending === null) return
    const file = join(dir, `msg-${++n}.txt`)
    await writeFile(file, pending, 'utf8')
    todo.push(`exec git commit --amend --allow-empty --cleanup=strip -F ${quote(file)}`)
    pending = null
  }

  for (const s of steps) {
    if (s.action === 'line') {
      await flush()
      todo.push(s.line ?? '')
      canSquash = false
      continue
    }
    if (s.action === 'drop') {
      todo.push(`drop ${s.sha}`)
      continue
    }
    if (s.action === 'squash' || s.action === 'fixup') {
      if (!canSquash) throw new GitError('A squashed commit needs a kept commit right above it, in the same part of the history.')
      todo.push(`fixup ${s.sha}`)
      continue
    }
    await flush()
    todo.push(`pick ${s.sha}`)
    canSquash = true
    if (s.message !== undefined && (s.action === 'reword' || s.message.trim())) pending = s.message
  }
  await flush()

  const merges = steps.some(s => s.action === 'line')
  const todoFile = join(dir, 'todo')
  await writeFile(todoFile, `${todo.join('\n')}\n`, 'utf8')
  await git(repo, ['rebase', '-i', ...(merges ? ['--rebase-merges'] : []), '--autostash', ...(base ? [base] : ['--root'])], {
    env: { GIT_SEQUENCE_EDITOR: `cp ${quote(todoFile)}`, GIT_EDITOR: 'true' },
  })
}
