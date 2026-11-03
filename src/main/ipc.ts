import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Api, ApiChannel, ApiEvents, IpcEnvelope } from '@shared/api'
import type { Progress } from '@shared/types'
import { registerPending, respond } from './askpass'
import { blame, fileLog } from './git/blame'
import { compare } from './git/compare'
import { rebasePlan, rebaseRun } from './git/rebase'
import { lfsPull, submoduleUpdate, worktreeAdd, worktreeRemove } from './git/modules'
import { fsmonitorInfo, setFsmonitor } from './git/perf'
import { deletedBranches, newerTips, operations, restore, restoreBranch } from './git/reflog'
import { conflict, resolveContent, resolveWhole } from './git/conflict'
import { diff } from './git/diff'
import { git, GitError } from './git/exec'
import { commitDetail, log, stashDetail } from './git/log'
import * as ops from './git/ops'
import { defaultBranch, defaultRemote, extras, refs } from './git/refs'
import { isRepo, status, topLevel } from './git/status'
import { openEditor, openTerminal } from './integrations'
import { detectProvider, providerUrl } from './provider'
import { getState, removeRepo, repoById, save, updateSettings, upsertRepo } from './store'
import type { RepoWatcher } from './watcher'

type Handlers = { [K in ApiChannel]: (...args: Parameters<Api[K]>) => ReturnType<Api[K]> }

export function send<K extends keyof ApiEvents>(channel: K, payload: ApiEvents[K]): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload)
}

const progress = (p: Progress | null) => send('progress', p)

/** Opening the same folder twice resolves to the repository root once. */
async function addRepo(path: string) {
  if (!existsSync(path)) throw new GitError('This folder does not exist.')
  if (!(await isRepo(path))) throw new GitError('This folder is not a Git repository. Use "Create repository" to initialise it.', 'NOT_A_REPO')
  return upsertRepo(await topLevel(path))
}

export function registerIpc(watcher: RepoWatcher): void {
  const h: Handlers = {
    'app:state': async () => {
      const s = getState()
      return { repos: s.repos, lastRepo: s.lastRepo, settings: s.settings, platform: process.platform, version: app.getVersion(), home: homedir() }
    },
    'app:settings': async patch => updateSettings(patch),
    'repo:list': async () => getState().repos,
    'repo:add': async path => addRepo(path),
    'repo:init': async path => {
      mkdirSync(path, { recursive: true })
      await git(path, ['init', '-b', 'main'])
      return upsertRepo(path)
    },
    'repo:clone': async (url, parent, name) => {
      const target = join(parent, name)
      if (existsSync(target)) throw new GitError(`"${target}" already exists.`)
      mkdirSync(parent, { recursive: true })
      await ops.clone(url, parent, name, progress)
      return upsertRepo(target)
    },
    'repo:remove': async id => removeRepo(id),
    'repo:open': async id => {
      const r = repoById(id)
      if (!existsSync(r.path)) throw new GitError(`"${r.path}" no longer exists. Remove it from the list or locate it again.`)
      return upsertRepo(r.path)
    },
    'repo:pin': async (id, pinned) => {
      repoById(id).pinned = pinned
      save()
      return getState().repos
    },
    'dialog:pickFolder': async title => {
      const win = BrowserWindow.getFocusedWindow()
      const opts = { title, properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      return r.canceled ? null : r.filePaths[0] ?? null
    },

    'git:status': async repo => status(repo),
    'git:diff': async (repo, source, opts) => diff(repo, source, opts),
    'git:stage': async (repo, paths) => ops.stage(repo, paths),
    'git:unstage': async (repo, paths) => ops.unstage(repo, paths),
    'git:stageLines': async (repo, path, sel, untracked) => ops.stageLines(repo, path, sel, untracked, contextOpts()),
    'git:unstageLines': async (repo, path, sel) => ops.unstageLines(repo, path, sel, contextOpts()),
    'git:discard': async (repo, paths) => ops.discard(repo, paths),
    'git:discardLines': async (repo, path, sel) => ops.discardLines(repo, path, sel, contextOpts()),
    'git:ignore': async (repo, pattern) => ops.ignore(repo, pattern),
    'git:commit': async (repo, message, amend, opts) => ops.commit(repo, message, amend, opts),
    'git:authors': async repo => ops.authors(repo),
    'git:commitSetup': async repo => ops.commitSetup(repo),
    'git:lastCommitMessage': async repo => ops.lastCommitMessage(repo),
    'git:preparedMessage': async repo => ops.preparedMessage(repo),
    'git:undoCommit': async repo => ops.undoCommit(repo),
    'git:resolve': async (repo, path, side) => ops.resolve(repo, path, side),
    'git:continue': async repo => ops.continueOp(repo),
    'git:abort': async repo => ops.abortOp(repo),
    'git:skip': async repo => ops.skipOp(repo),
    'git:conflict': async (repo, path) => conflict(repo, path),
    'git:resolveContent': async (repo, path, content, encoding) => resolveContent(repo, path, content, encoding),
    'git:resolveWhole': async (repo, path, choice) => resolveWhole(repo, path, choice),

    'git:log': async (repo, q) => log(repo, q),
    'git:commit:detail': async (repo, sha) => commitDetail(repo, sha),
    'git:cherryPick': async (repo, shas) => ops.cherryPick(repo, shas),
    'git:revert': async (repo, shas) => ops.revert(repo, shas),
    'git:reset': async (repo, sha, mode) => ops.reset(repo, sha, mode),
    'git:checkoutCommit': async (repo, sha) => ops.checkoutCommit(repo, sha),
    'git:fileLog': async (repo, path, skip, limit) => fileLog(repo, path, skip, limit),
    'git:blame': async (repo, path, rev) => blame(repo, path, rev),
    'git:compare': async (repo, base, head, threeDot) => compare(repo, base, head, threeDot),
    'git:operations': async repo => operations(repo),
    'git:deletedBranches': async repo => deletedBranches(repo),
    'git:restoreBranch': async (repo, name, sha) => restoreBranch(repo, name, sha),
    'git:newerTips': async (repo, branches) => newerTips(repo, branches),
    'git:restore': async (repo, target) => restore(repo, target),
    'git:rebasePlan': async (repo, base) => rebasePlan(repo, base),
    'git:rebaseRun': async (repo, base, steps) => rebaseRun(repo, base, steps),

    'git:refs': async repo => refs(repo),
    'git:extras': async repo => extras(repo),
    'git:checkout': async (repo, branch, opts) => ops.checkout(repo, branch, opts),
    'git:createBranch': async (repo, name, from, co) => ops.createBranch(repo, name, from, co),
    'git:renameBranch': async (repo, from, to) => ops.renameBranch(repo, from, to),
    'git:deleteBranch': async (repo, name, force) => ops.deleteBranch(repo, name, force),
    'git:deleteRemoteBranch': async (repo, remote, branch) => ops.deleteRemoteBranch(repo, remote, branch, progress),
    'git:merge': async (repo, ref, opts) => ops.merge(repo, ref, opts),
    'git:rebase': async (repo, onto) => ops.rebase(repo, onto),
    'git:createTag': async (repo, name, sha, msg) => ops.createTag(repo, name, sha, msg),
    'git:deleteTag': async (repo, name) => ops.deleteTag(repo, name),
    'git:pushTag': async (repo, remote, name) => ops.pushTag(repo, remote, name, progress),
    'git:stash': async (repo, msg, untracked, paths) => ops.stash(repo, msg, untracked, paths),
    'git:stashApply': async (repo, index, pop) => ops.stashApply(repo, index, pop),
    'git:stashDrop': async (repo, index) => ops.stashDrop(repo, index),
    'git:stashFiles': async (repo, index) => stashDetail(repo, index),
    'git:addRemote': async (repo, name, url) => ops.addRemote(repo, name, url),
    'git:removeRemote': async (repo, name) => ops.removeRemote(repo, name),
    'git:submoduleUpdate': async (repo, path) => submoduleUpdate(repo, path, progress),
    'git:lfsPull': async repo => lfsPull(repo, progress),
    'git:worktreeAdd': async (repo, path, branch, create, from) => worktreeAdd(repo, path, branch, create, from),
    'git:worktreeRemove': async (repo, path, force) => worktreeRemove(repo, path, force),
    'repo:fsmonitor': async repo => fsmonitorInfo(repo),
    'repo:setFsmonitor': async (repo, on) => setFsmonitor(repo, on),

    'git:fetch': async repo => ops.fetchAll(repo, progress),
    'git:pull': async repo => ops.pull(repo, getState().settings.pullMode, progress),
    'git:push': async (repo, opts) => ops.push(repo, opts ?? {}, progress),

    'git:identity': async repo => ops.identity(repo),
    'git:setIdentity': async (repo, id) => ops.setIdentity(repo, id),
    'provider:url': async (repo, link) => {
      const remote = await defaultRemote(repo)
      if (!remote) return null
      const url = (await git(repo, ['remote', 'get-url', remote])).stdout.trim()
      const info = detectProvider(url)
      if (!info) return null
      if (link.type === 'pr' && !link.base) link = { ...link, base: await defaultBranch(repo, remote) }
      return providerUrl(info, link)
    },
    'shell:openUrl': async url => {
      if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
    },
    'shell:reveal': async (repo, path) => {
      if (path) shell.showItemInFolder(join(repo, path))
      else await shell.openPath(repo)
    },
    'shell:editor': async (repo, path) => openEditor(getState().settings.editorCommand, repo, path ? join(repo, path) : repo),
    'shell:terminal': async repo => openTerminal(getState().settings.terminalCommand, repo),
    'clipboard:write': async text => clipboard.writeText(text),
    'askpass:respond': async (id, value) => respond(id, value),
    'watch:set': async repo => watcher.set(repo),
  }

  for (const [channel, fn] of Object.entries(h)) {
    ipcMain.handle(channel, async (_e, ...args): Promise<IpcEnvelope<unknown>> => {
      try {
        return { ok: true, value: await (fn as (...a: unknown[]) => Promise<unknown>)(...args) }
      } catch (e) {
        const err = e as GitError
        return { ok: false, error: { message: err.message ?? String(e), code: err.code, details: err.details || undefined } }
      }
    })
  }
}

function contextOpts() {
  const s = getState().settings
  return { context: s.diffContext, ignoreWhitespace: false, force: true }
}

/** Asks the focused window for a credential and waits for the answer. */
export function askRenderer(req: { id: string; prompt: string; kind: 'password' | 'text' | 'confirm' }): Promise<string | null> {
  return new Promise(resolve => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return resolve(null)
    const timer = setTimeout(() => respond(req.id, null), 5 * 60_000)
    registerPending(req.id, value => {
      clearTimeout(timer)
      resolve(value)
    })
    if (win.isMinimized()) win.restore()
    win.focus()
    win.webContents.send('askpass', req)
  })
}
