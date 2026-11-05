import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RebasePlan, RebaseStep, RebaseTodoItem } from '@shared/types'
import { git, gitOut, GitError } from './exec'
import { keepingIndex } from './ops'
import { upstreamOf, currentBranch } from './refs'
import { gitDir, operation } from './status'

const RS = '\x1e'
const US = '\x1f'

const posix = (p: string) => p.replace(/\\/g, '/')
/** Single-quoted for sh: nothing inside is expanded, so a dollar sign or backtick in the path stays literal. */
const quote = (p: string) => `'${posix(p).replace(/'/g, `'\\''`)}'`

/** Commits after `base` (null: from the root), oldest first, as the rebase will replay them. */
export async function rebasePlan(repo: string, symbolicBase: string | null): Promise<RebasePlan> {
  // Both ends as commits, read once: the plan and the rebase that follows use the same range.
  const head = await resolveCommit(repo, 'HEAD')
  let base = symbolicBase && await resolveCommit(repo, symbolicBase)
  const branch = await currentBranch(repo)
  const upstream = branch ? await upstreamOf(repo, branch) : null
  if (base && !(await isAncestor(repo, base, head))) {
    // The unpushed commits of a branch also behind its upstream: edited where they are, since the
    // fork. Replayed onto the upstream, they took in its new commits as a pull would.
    if (upstream && base === await resolveCommit(repo, upstream)) base = (await gitOut(repo, ['merge-base', base, head])).trim()
    else throw new GitError(NOT_IN_BRANCH)
  }
  const range = base ? `${base}..${head}` : head
  // Full messages are needed (squashing combines them), so a range from the root of a long history is
  // large: past 32 MB of it, the user is asked for a later start instead of the app filling memory.
  const log = await git(repo, ['log', '--reverse', `--format=%H${US}%P${US}%an${US}%ae${US}%at${US}%s${US}%b${RS}`, range], { maxBytes: 32 * 1024 * 1024 })
  if (log.truncated) throw new GitError('There are too many commits to edit at once. Start from a later commit ("Edit history from here").')
  const out = log.stdout
  const commits = out.split(RS).map(r => r.replace(/^\n/, '')).filter(Boolean).map(r => {
    const [sha, parents, author, email, date, subject, body] = r.split(US)
    return { sha, parents: parents ? parents.split(' ') : [], author, email, date: +date, subject, body: (body ?? '').trim(), refs: [] }
  })

  let pushed = 0
  if (upstream && commits.length) {
    const local = +(await gitOut(repo, ['rev-list', '--count', range, `^${upstream}`])).trim()
    pushed = commits.length - local
  }
  const hasMerges = commits.some(c => c.parents.length > 1)
  const structure = hasMerges ? await extractTodo(repo, base, commits.map(c => c.sha)) : undefined
  return { base, head, commits, hasMerges, pushed, structure }
}

async function resolveCommit(repo: string, rev: string): Promise<string> {
  return (await gitOut(repo, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`])).trim()
}

const isAncestor = (repo: string, a: string, b: string) =>
  git(repo, ['merge-base', '--is-ancestor', a, b], { okCodes: [1] }).then(r => r.code === 0)

/**
 * A base outside the branch's history ("Edit history from here" on another
 * branch's commit) is refused: the rebase moved the branch onto it, a plan
 * that never showed the commit picked.
 */
const NOT_IN_BRANCH = 'That commit is not in the history of the current branch: editing history from it would move the branch onto it. Check out its branch first.'

/**
 * Asks git for the todo it would run with `--rebase-merges` (labels, resets,
 * merges) without running it: the sequence editor copies the list out and
 * empties it, so git stops with "nothing to do" before moving HEAD.
 *
 * Git only starts on a clean tree. Instead of stashing the user's changes
 * (`--autostash` puts them back unstaged, and fails on "add -N" files), the
 * dry run reads a throwaway index: HEAD's tree with every entry marked
 * skip-worktree, which git sees as clean. The real index and the files on
 * disk are never touched.
 */
async function extractTodo(repo: string, base: string | null, shas: string[]): Promise<RebaseTodoItem[]> {
  const dir = join(await gitDir(repo), 'gdg-rebase')
  await mkdir(dir, { recursive: true })
  const out = join(dir, 'generated-todo')
  await rm(out, { force: true })
  // No hooks for this dry run (pre-rebase could refuse or act), full command names and no autosquash
  // (rebase.autoSquash turns "fixup!" commits into fixup lines) whatever the user's config: the plan
  // lists every commit as a pick, and squashing is the user's to do here.
  const noHooks = join(dir, 'no-hooks')
  await mkdir(noHooks, { recursive: true })
  const index = { GIT_INDEX_FILE: join(dir, 'plan-index') }
  // Only this function uses that index, one call at a time per repository (the write queue): a lock
  // file left by a git killed mid-way (the app quit) would otherwise refuse every later plan.
  await rm(`${index.GIT_INDEX_FILE}.lock`, { force: true })
  // In a sparse checkout git clears skip-worktree from files present on disk, and the throwaway
  // index would read as changed: for these commands the checkout is not sparse.
  const notSparse = ['-c', 'core.sparseCheckout=false']
  let refusal: string
  try {
    await git(repo, [...notSparse, 'read-tree', 'HEAD'], { env: index })
    const files = await git(repo, [...notSparse, 'ls-files', '-z'], { env: index })
    if (files.raw.length) await git(repo, [...notSparse, 'update-index', '-z', '--skip-worktree', '--stdin'], { env: index, input: files.raw })
    const r = await git(repo, [...notSparse, '-c', `core.hooksPath=${posix(noHooks)}`, '-c', 'rebase.abbreviateCommands=false',
      'rebase', '-i', '--rebase-merges', '--no-autostash', '--no-autosquash', ...(base ? [base] : ['--root'])], {
      env: { ...index, GIT_SEQUENCE_EDITOR: `f() { cp "$1" ${quote(out)}; : > "$1"; }; f`, GIT_EDITOR: 'true' },
      okCodes: [1],
    })
    refusal = r.stderr.split(/\r?\n/).filter(l => /^(error|fatal): /.test(l) && !/nothing to do/.test(l)).join('\n')
  } finally {
    await rm(index.GIT_INDEX_FILE, { force: true })
  }
  const text = await readFile(out, 'utf8').catch(() => '')
  // Exit code 1 is the expected "nothing to do": anything git said besides it is why there is no plan.
  if (!text) throw new GitError(`Git did not produce a rebase plan for this range.${refusal ? `\n${refusal}` : ''}`)

  const items: RebaseTodoItem[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (!line || (line.startsWith('#') && !line.startsWith('# Branch '))) continue
    const pick = /^(?:pick|p) ([0-9a-f]+)/.exec(line)
    const full = pick && shas.find(s => s.startsWith(pick[1]))
    if (full) items.push({ kind: 'pick', sha: full })
    else items.push({ kind: 'line', text: line })
  }
  return items
}

const ACTIONS = new Set(['pick', 'reword', 'squash', 'fixup', 'drop', 'line'])
/** What git's own --rebase-merges plan holds besides commits: never `exec`, `break` or anything that runs a command. */
const PLAN_LINE = /^(?:label|reset|merge|update-ref|pick|noop|#)(?: |$)/

/**
 * Every step goes into the todo file as one line: a sha must be a sha, and a
 * structural line one that git's plan has, or a newline or an `exec` line
 * would run a command.
 */
function checkSteps(steps: RebaseStep[]): void {
  if (!Array.isArray(steps)) throw new GitError('Invalid history plan.')
  for (const s of steps) {
    const ok = !!s && ACTIONS.has(s.action) && (s.message === undefined || typeof s.message === 'string') && (s.action === 'line'
      ? typeof s.line === 'string' && !/[\r\n]/.test(s.line) && PLAN_LINE.test(s.line)
      : typeof s.sha === 'string' && /^[0-9a-f]{4,64}$/i.test(s.sha))
    if (!ok) throw new GitError(`"${String(s?.line ?? s?.sha)}" is not a step of a history plan.`)
  }
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
export async function rebaseRun(repo: string, base: string | null, steps: RebaseStep[], head: string): Promise<void> {
  checkSteps(steps)
  const commits = steps.filter(s => s.action !== 'line')
  if (!commits.some(s => s.action !== 'drop')) throw new GitError('Every commit is dropped. Use a reset instead if that is what you want.')
  // A commit made since the plan was shown is not in the todo: git would drop it.
  if ((await resolveCommit(repo, 'HEAD')) !== head) {
    throw new GitError('The branch changed since this plan was shown. Reopen "Edit history" to see the new commits.')
  }
  if (base && !(await isAncestor(repo, base, head))) throw new GitError(NOT_IN_BRANCH)

  const gd = await gitDir(repo)
  // A rebase stopped on a conflict still reads its messages from gdg-rebase when it continues:
  // removing them first, then failing on "already a rebase-merge directory", lost them.
  const busy = operation(gd).operation
  if (busy) throw new GitError(`A ${busy} is in progress. Continue or abort it before editing history again.`)
  const dir = join(gd, 'gdg-rebase')
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
    // whitespace, not strip: a line starting with "#" ("#123 fixed") is part of the message.
    todo.push(`exec git commit --amend --allow-empty --cleanup=whitespace -F ${quote(file)}`)
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
  // Staged changes come back staged afterwards (see keepingIndex), not all unstaged.
  // --reschedule-failed-exec: a message a commit-msg hook refuses stops the rebase and is applied
  // again on Continue. Without it, Continue went on past it and the commit kept its old message.
  await keepingIndex(repo, 'Changes set aside by GaetanDev Git before editing history', autostash =>
    git(repo, ['rebase', '-i', '--reschedule-failed-exec', ...(merges ? ['--rebase-merges'] : []), autostash ? '--autostash' : '--no-autostash', ...(base ? [base] : ['--root'])], {
      env: { GIT_SEQUENCE_EDITOR: `cp ${quote(todoFile)}`, GIT_EDITOR: 'true' },
    }))
}
