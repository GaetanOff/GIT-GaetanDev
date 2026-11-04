import type { Branch, Commit, Stash, Tag } from '@shared/types'
import { api } from './api'
import { validateBranchName } from './commands'
import { shortSha } from './format'
import { app } from './state.svelte'
import { choose, confirm, openDialog, prompt, toast, type MenuItem } from './ui.svelte'

/**
 * The repo in front. Actions that ask first read it before the dialog: an
 * "Open in" from Explorer can switch repos while it is up, and the answer
 * belongs to the repo the question was about.
 */
const repo = () => app.repo!.path

/* ─── Branches ──────────────────────────────────────────────────────────────── */

/*
 * Branches reach git by their full ref (refs/heads/x, refs/remotes/o/x) and
 * are named by their short one: by name alone git takes a tag first, so with
 * an old tag "feature" a merge of the branch merged the tag ("Already up to
 * date") and the app said the branch was merged.
 */

export async function mergeInto(ref: string, name = ref): Promise<void> {
  const current = app.status?.branch
  if (!current) return
  const path = repo()
  const how = await choose({
    title: `Merge ${name} into ${current}`,
    message: 'A merge commit keeps history as it happened. Squash folds every commit of the branch into staged changes you then commit once.',
    options: [
      { label: 'Merge', value: 'merge', variant: 'primary' },
      { label: 'Squash', value: 'squash', variant: 'secondary' },
    ],
  })
  if (!how) return
  await app.run(`Merging ${name}`, () => api['git:merge'](path, ref, { squash: how === 'squash' }), {
    success: how === 'squash' ? `Squashed ${name}: review and commit the staged changes.` : `Merged ${name} into ${current}.`,
  })
  if (how === 'squash') app.view = 'changes'
}

export async function rebaseOnto(ref: string, name = ref): Promise<void> {
  const current = app.status?.branch
  if (!current) return
  const path = repo()
  const ok = await confirm({
    title: `Rebase ${current} onto ${name}?`,
    message: `Your commits on ${current} are replayed on top of ${name}. If ${current} was already pushed you will need to force push.`,
    confirmLabel: 'Rebase',
  })
  if (ok) await app.run(`Rebasing onto ${name}`, () => api['git:rebase'](path, ref), { success: `Rebased ${current} onto ${name}.` })
}

export async function deleteBranch(b: Branch): Promise<void> {
  if (b.remote) {
    const path = repo()
    // The remote's own name, which may hold a slash ("team/upstream"), then the branch on it.
    const remote = b.remoteName ?? b.name.split('/')[0]
    const branch = b.name.slice(remote.length + 1)
    const ok = await confirm({
      title: 'Delete remote branch?',
      message: `“${branch}” will be deleted from ${remote} for everyone.`,
      confirmLabel: 'Delete on remote',
      danger: true,
    })
    if (ok) await app.run(`Deleting ${b.name}`, () => api['git:deleteRemoteBranch'](path, remote, branch), { success: `Deleted ${b.name}.` })
    return
  }
  if (!app.repo) return
  // The repo the question is about, even if another tab is in front once it is answered or git is done.
  const target = { path: app.repo.path, id: app.repo.id }
  const ok = await confirm({
    title: `Delete branch “${b.name}”?`,
    message: b.upstream ? `The remote branch ${b.upstream} is kept.` : 'This branch was never pushed: its unique commits will only be reachable through the reflog.',
    confirmLabel: 'Delete',
    danger: true,
  })
  if (!ok) return
  try {
    const sha = await api['git:deleteBranch'](target.path, b.name, false)
    deleted(b.name, sha, target)
  } catch (e) {
    const err = e as { message: string; code?: string }
    if (err.code !== 'BRANCH_NOT_MERGED') return void toast('error', err.message)
    const force = await confirm({
      title: 'Branch not fully merged',
      message: `“${b.name}” has commits that are not merged anywhere. Delete it anyway?`,
      confirmLabel: 'Delete anyway',
      danger: true,
    })
    if (force) {
      const sha = await app.run('Deleting branch', () => api['git:deleteBranch'](target.path, b.name, true))
      if (sha) deleted(b.name, sha, target)
    }
  } finally {
    await app.refreshAll()
  }
}

/** Records a deleted branch's exact tip and offers to bring it back. */
function deleted(name: string, sha: string, target: { path: string; id: string }): void {
  rememberDeleted(name, sha, target.id)
  toast('success', `Deleted ${name}.`, { label: 'Undo', run: () => restoreDeleted(name, sha, target.path) }, 10_000)
}

const deletedKey = (id = app.repo?.id) => `deleted-branches:${id}`

export function rememberDeleted(name: string, sha: string, repoId = app.repo?.id): void {
  try {
    const list = JSON.parse(localStorage.getItem(deletedKey(repoId)) ?? '[]') as { name: string; sha: string; date: number }[]
    const next = [{ name, sha, date: Math.floor(Date.now() / 1000) }, ...list.filter(x => x.name !== name)].slice(0, 100)
    localStorage.setItem(deletedKey(repoId), JSON.stringify(next))
  } catch { /* storage unavailable */ }
}

/** Branches the app deleted, exact tips; restored ones drop out once the branch exists again. */
export function recordedDeleted(): { name: string; sha: string; date: number }[] {
  try {
    const names = new Set(app.localBranches.map(b => b.name))
    return (JSON.parse(localStorage.getItem(deletedKey()) ?? '[]') as { name: string; sha: string; date: number }[]).filter(x => !names.has(x.name))
  } catch {
    return []
  }
}

export async function restoreDeleted(name: string, sha: string, repoPath = repo()): Promise<void> {
  await app.run(`Restoring ${name}`, () => api['git:restoreBranch'](repoPath, name, sha), { success: `Branch ${name} restored at ${sha.slice(0, 7)}.` })
}

export async function renameBranch(b: Branch): Promise<void> {
  const path = repo()
  const name = await prompt({ title: 'Rename branch', label: 'New name', value: b.name, confirmLabel: 'Rename', mono: true, validate: validateBranchName })
  if (name && name !== b.name) await app.run('Renaming branch', () => api['git:renameBranch'](path, b.name, name))
}

export function branchMenu(b: Branch): MenuItem[] {
  const current = app.status?.branch
  const isCurrent = b.current
  const short = b.remote && b.remoteName ? b.name.slice(b.remoteName.length + 1) : b.name
  const items: MenuItem[] = [
    { label: isCurrent ? 'Current branch' : `Switch to ${b.remote ? short : b.name}`, icon: 'branch', disabled: isCurrent, run: () => app.checkout(b.name) },
    { label: 'New branch from here…', icon: 'plus', run: () => openDialog({ kind: 'branch', from: b.fullRef, fromLabel: b.name }) },
    ...(current && !isCurrent ? [{ label: `Compare with ${current}`, icon: 'split' as const, run: () => app.openCompare(current, b.name) }] : []),
    'sep',
  ]
  if (current && !isCurrent) {
    items.push(
      { label: `Merge into ${current}…`, icon: 'merge', run: () => mergeInto(b.fullRef, b.name) },
      { label: `Rebase ${current} onto this`, icon: 'sync', run: () => rebaseOnto(b.fullRef, b.name) },
      'sep',
    )
  }
  if (!b.remote) {
    items.push({ label: 'Rename…', icon: 'edit', run: () => renameBranch(b) })
    if (app.provider) {
      items.push({ label: 'Create pull request', icon: 'pr', disabled: !b.upstream, run: () => app.openProvider({ type: 'pr', branch: b.name }) })
    }
  } else if (app.provider) {
    items.push({ label: 'Open on the web', icon: 'globe', run: () => app.openProvider({ type: 'branch', branch: short }) })
    items.push({ label: 'Create pull request', icon: 'pr', run: () => app.openProvider({ type: 'pr', branch: short }) })
  }
  items.push(
    { label: 'Copy name', icon: 'copy', run: () => app.copy(b.remote ? short : b.name, 'Branch name copied') },
    'sep',
    { label: b.remote ? 'Delete on remote…' : 'Delete…', icon: 'trash', danger: true, disabled: isCurrent, run: () => deleteBranch(b) },
  )
  return items
}

/* ─── Commits ───────────────────────────────────────────────────────────────── */

export async function resetTo(c: Commit): Promise<void> {
  const path = repo()
  const mode = await choose({
    title: `Reset ${app.status?.branch ?? 'HEAD'} to ${shortSha(c.sha)}`,
    message: 'Soft keeps your changes staged. Mixed keeps them as unstaged changes. Hard throws every change away.',
    options: [
      { label: 'Soft', value: 'soft' as const, variant: 'secondary' },
      { label: 'Mixed', value: 'mixed' as const, variant: 'primary' },
      { label: 'Hard', value: 'hard' as const, variant: 'danger' },
    ],
  })
  if (!mode) return
  if (mode === 'hard') {
    const ok = await confirm({ title: 'Hard reset?', message: 'All uncommitted changes and every commit after this one on the branch will be discarded.', confirmLabel: 'Reset hard', danger: true })
    if (!ok) return
  }
  await app.run('Resetting', () => api['git:reset'](path, c.sha, mode), { success: `Reset to ${shortSha(c.sha)} (${mode}).` })
}

export function commitMenu(c: Commit): MenuItem[] {
  const onBranch = !!app.status?.branch
  return [
    { label: 'Copy SHA', icon: 'copy', hint: shortSha(c.sha), run: () => app.copy(c.sha, 'SHA copied') },
    { label: 'Copy subject', icon: 'copy', run: () => app.copy(c.subject, 'Subject copied') },
    ...(app.provider ? [{ label: 'Open on the web', icon: 'globe' as const, run: () => app.openProvider({ type: 'commit', sha: c.sha }) }] : []),
    'sep',
    { label: 'New branch from here…', icon: 'branch', run: () => openDialog({ kind: 'branch', from: c.sha, fromLabel: shortSha(c.sha) }) },
    { label: 'Create tag here…', icon: 'tag', run: () => openDialog({ kind: 'tag', sha: c.sha }) },
    { label: 'Edit history from here…', icon: 'edit', disabled: !onBranch, run: () => app.openRebase(c.parents[0] ?? null, `from ${shortSha(c.sha)} “${c.subject}”`) },
    { label: 'Compare with HEAD', icon: 'split', run: () => app.openCompare(c.sha, 'HEAD') },
    { label: 'Checkout (detached)', icon: 'commit', run: async () => {
      const path = repo()
      const ok = await confirm({ title: 'Checkout this commit?', message: 'You will be in “detached HEAD” state: new commits will not belong to any branch until you create one.', confirmLabel: 'Checkout' })
      if (ok) await app.run('Checking out', () => api['git:checkoutCommit'](path, c.sha))
    } },
    'sep',
    { label: 'Cherry-pick onto current branch', icon: 'commit', disabled: !onBranch, run: () => app.run('Cherry-picking', () => api['git:cherryPick'](repo(), [c.sha]), { success: `Cherry-picked ${shortSha(c.sha)}.` }) },
    { label: 'Revert this commit', icon: 'undo', disabled: !onBranch, run: async () => {
      const path = repo()
      const ok = await confirm({ title: 'Revert commit?', message: `A new commit will undo the changes of “${c.subject}”.`, confirmLabel: 'Revert' })
      if (ok) await app.run('Reverting', () => api['git:revert'](path, [c.sha]), { success: 'Revert commit created.' })
    } },
    { label: 'Reset current branch to here…', icon: 'undo', danger: true, disabled: !onBranch, run: () => resetTo(c) },
  ]
}

/** Actions on several selected commits in History. */
export function commitsMenu(list: Commit[]): MenuItem[] {
  const onBranch = !!app.status?.branch
  const n = list.length
  const shas = list.map(c => c.sha)
  return [
    { label: `Cherry-pick ${n} commits onto ${app.status?.branch ?? 'HEAD'}`, icon: 'commit', disabled: !onBranch, run: () => app.run('Cherry-picking', () => api['git:cherryPick'](repo(), shas), { success: `Cherry-picked ${n} commits.` }) },
    { label: `Revert ${n} commits`, icon: 'undo', disabled: !onBranch, run: async () => {
      const path = repo()
      const ok = await confirm({ title: `Revert ${n} commits?`, message: 'One revert commit is created per commit, newest first.', confirmLabel: 'Revert' })
      if (ok) await app.run('Reverting', () => api['git:revert'](path, shas), { success: `Reverted ${n} commits.` })
    } },
    'sep',
    { label: 'Compare oldest and newest', icon: 'split', run: () => app.openCompare(`${list[list.length - 1].sha}^`, list[0].sha, false) },
    { label: 'Copy SHAs', icon: 'copy', run: () => app.copy(shas.join('\n'), `${n} SHAs copied`) },
  ]
}

/** A branch dropped on another one: merge it in, or rebase onto it. */
export async function dropBranch(dragged: Branch, target: string): Promise<void> {
  if (dragged.name === target && !dragged.remote) return
  const current = app.status?.branch
  const id = app.repo?.id
  const choice = await choose({
    title: `${dragged.name} → ${target}`,
    message: target === current
      ? `Merge ${dragged.name} into the current branch, or replay ${target} on top of ${dragged.name}?`
      : `${target} is not checked out: it is switched to first, then the operation runs.`,
    options: [
      { label: `Merge into ${target}`, value: 'merge' as const, variant: 'primary' },
      { label: `Rebase ${target} onto it`, value: 'rebase' as const, variant: 'secondary' },
    ],
  })
  // The branches in the question are that repository's; checkout, merge and rebase act on the one in front.
  if (!choice || !app.stillOn(id)) return
  if (target !== current) {
    await app.checkout(target)
    if (app.status?.branch !== target) return
  }
  if (choice === 'merge') await mergeInto(dragged.fullRef, dragged.name)
  else await rebaseOnto(dragged.fullRef, dragged.name)
}

/* ─── Tags & stashes ────────────────────────────────────────────────────────── */

export function tagMenu(t: Tag): MenuItem[] {
  const remote = app.refs.remotes[0]?.name
  return [
    { label: 'Show commit', icon: 'commit', run: () => { app.view = 'history'; app.selectedCommit = t.sha } },
    { label: 'Checkout (detached)', icon: 'tag', run: () => app.run('Checking out', () => api['git:checkoutCommit'](repo(), `refs/tags/${t.name}`)) },
    { label: 'New branch from tag…', icon: 'branch', run: () => openDialog({ kind: 'branch', from: `refs/tags/${t.name}`, fromLabel: t.name }) },
    { label: `Push to ${remote ?? 'remote'}`, icon: 'push', disabled: !remote, run: () => app.run('Pushing tag', () => api['git:pushTag'](repo(), remote!, t.name), { success: `Pushed ${t.name}.` }) },
    { label: 'Copy name', icon: 'copy', run: () => app.copy(t.name, 'Tag copied') },
    'sep',
    { label: 'Delete locally', icon: 'trash', danger: true, run: async () => {
      const path = repo()
      const ok = await confirm({ title: `Delete tag ${t.name}?`, message: 'The tag is removed from this repository only.', confirmLabel: 'Delete', danger: true })
      if (ok) await app.run('Deleting tag', () => api['git:deleteTag'](path, t.name))
    } },
  ]
}

export async function applyStash(s: Stash, pop: boolean): Promise<void> {
  await app.run(pop ? 'Popping stash' : 'Applying stash', () => api['git:stashApply'](repo(), s.index, pop, s.sha), {
    success: pop ? 'Stash restored and removed.' : 'Stash applied.',
  })
  if (pop && app.view === 'stash') {
    app.view = 'changes'
    app.selectedStash = null
  }
}

export async function dropStash(s: Stash): Promise<void> {
  const path = repo()
  const ok = await confirm({ title: 'Drop stash?', message: `“${s.message}” will be deleted.`, confirmLabel: 'Drop', danger: true })
  if (!ok) return
  await app.run('Dropping stash', () => api['git:stashDrop'](path, s.index, s.sha))
  if (app.selectedStash === s.sha) {
    app.selectedStash = null
    app.view = 'changes'
  }
}

export function stashMenu(s: Stash): MenuItem[] {
  return [
    { label: 'Pop (apply and remove)', icon: 'download', run: () => applyStash(s, true) },
    { label: 'Apply (keep stash)', icon: 'check', run: () => applyStash(s, false) },
    'sep',
    { label: 'Drop…', icon: 'trash', danger: true, run: () => dropStash(s) },
  ]
}
