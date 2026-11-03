import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, posix } from 'node:path'
import type { Api, ApiChannel, ApiEvents, IpcEnvelope } from '@shared/api'
import { DEFAULT_SETTINGS, type Progress, type RepoImport, type Settings } from '@shared/types'
import { registerPending, respond } from './askpass'
import { blame, fileLog } from './git/blame'
import { compare } from './git/compare'
import { rebasePlan, rebaseRun } from './git/rebase'
import { lfsPull, submoduleUpdate, worktreeAdd, worktreeRemove } from './git/modules'
import { fsmonitorInfo, setFsmonitor } from './git/perf'
import { deletedBranches, operations, restore, restoreBranch } from './git/reflog'
import { newerTips, remoteSearch } from './git/recovery'
import { conflict, resolveContent, resolveWhole } from './git/conflict'
import { diff } from './git/diff'
import { git, GitError } from './git/exec'
import { commitDetail, log, stashDetail } from './git/log'
import * as ops from './git/ops'
import { defaultBranch, defaultRemote, extras, refs } from './git/refs'
import { isRepo, status, topLevel } from './git/status'
import { openEditor, openTerminal } from './integrations'
import { detectProvider, providerUrl } from './provider'
import { installUpdate } from './updater'
import { githubDesktopRepos } from './importers'
import { addRepoEntry, getState, isRegistered, removeRepo, repoById, save, updateSettings, upsertRepo } from './store'
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

/** A folder the app was launched with; the renderer opens it instead of the last repo. */
let launchPath: string | null = null
export function setLaunchPath(path: string | null): void {
  launchPath = path
}

export function registerIpc(watcher: RepoWatcher): void {
  const h: Handlers = {
    'app:state': async () => {
      const s = getState()
      const open = launchPath
      launchPath = null
      return { repos: s.repos, lastRepo: s.lastRepo, settings: s.settings, platform: process.platform, version: app.getVersion(), home: homedir(), launchPath: open }
    },
    'app:settings': async patch => updateSettings(patch),
    'app:installUpdate': async () => installUpdate(),
    'repo:list': async () => getState().repos,
    'repo:add': async path => addRepo(path),
    'repo:importGithubDesktop': async () => {
      const found = await githubDesktopRepos()
      const result: RepoImport = { added: [], known: 0, skipped: [], repos: [] }
      for (const r of found) {
        // A folder with a .git entry (a directory, or a file for worktrees and submodules).
        if (r.missing || !existsSync(join(r.path, '.git'))) { result.skipped.push(r.path); continue }
        if (isRegistered(r.path)) { result.known++; continue }
        addRepoEntry(r.path, r.alias ?? undefined)
        result.added.push(r.alias ?? basename(r.path))
      }
      result.repos = getState().repos
      return result
    },
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
    'git:stageLines': async (repo, path, sel, untracked, expect) => ops.stageLines(repo, path, sel, untracked, contextOpts(), expect),
    'git:unstageLines': async (repo, path, sel, expect, oldPath) => ops.unstageLines(repo, path, sel, contextOpts(), expect, oldPath),
    'git:discard': async (repo, paths) => ops.discard(repo, paths),
    'git:discardLines': async (repo, path, sel, expect) => ops.discardLines(repo, path, sel, contextOpts(), expect),
    'git:ignore': async (repo, pattern) => ops.ignore(repo, pattern),
    'git:commit': async (repo, message, amend, opts) => ops.commit(repo, message, amend, opts),
    'git:authors': async repo => ops.authors(repo),
    'git:commitSetup': async repo => ops.commitSetup(repo),
    'git:lastCommitMessage': async repo => ops.lastCommitMessage(repo),
    'git:preparedMessage': async repo => ops.preparedMessage(repo),
    'git:undoCommit': async (repo, expect) => ops.undoCommit(repo, expect),
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
    'git:remoteSearch': async (repo, branches) => remoteSearch(repo, branches, progress),
    'git:restore': async (repo, target) => restore(repo, target),
    'git:rebasePlan': async (repo, base) => rebasePlan(repo, base),
    'git:rebaseRun': async (repo, base, steps, head) => rebaseRun(repo, base, steps, head),

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
    'git:stashApply': async (repo, index, pop, sha) => ops.stashApply(repo, index, pop, sha),
    'git:stashDrop': async (repo, index, sha) => ops.stashDrop(repo, index, sha),
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
    ipcMain.handle(channel, async (e, ...args): Promise<IpcEnvelope<unknown>> => {
      try {
        if (!trustedSender(e)) throw new GitError('Request refused: it does not come from the app window.')
        checkArgs(channel, args)
        const run = () => (fn as (...a: unknown[]) => Promise<unknown>)(...args)
        return { ok: true, value: await schedule(channel, args[0] as string, run) }
      } catch (e) {
        const err = e as GitError
        return { ok: false, error: { message: err.message ?? String(e), code: err.code, details: err.details || undefined } }
      }
    })
  }
}

/**
 * Only the app's own page, in the window's main frame, may call the bridge:
 * the built index.html, or the dev server while developing.
 */
function trustedSender(e: IpcMainInvokeEvent): boolean {
  const frame = e.senderFrame
  if (!frame || frame !== e.sender.mainFrame) return false
  const dev = !app.isPackaged && process.env.ELECTRON_RENDERER_URL
  if (dev && frame.url.startsWith(new URL(dev).origin)) return true
  return frame.url.startsWith('file:') && /\/renderer\/index\.html(?:[?#].*)?$/.test(frame.url.replace(/\\/g, '/'))
}

/**
 * Channels that write the index, HEAD, the working tree, local refs or the
 * config. Two at once on the same repository fail on a lock (index.lock, a
 * ref, config.lock) or interleave (staging during a pull, a discard during a
 * stash), so they run one after another per repository; reads stay concurrent.
 */
const WRITES = new Set([
  'git:stage', 'git:unstage', 'git:stageLines', 'git:unstageLines', 'git:discard', 'git:discardLines', 'git:ignore',
  'git:commit', 'git:undoCommit', 'git:resolve', 'git:continue', 'git:abort', 'git:skip', 'git:resolveContent', 'git:resolveWhole',
  'git:cherryPick', 'git:revert', 'git:reset', 'git:checkoutCommit', 'git:restore', 'git:rebaseRun', 'git:rebasePlan',
  'git:checkout', 'git:createBranch', 'git:renameBranch', 'git:deleteBranch', 'git:restoreBranch', 'git:merge', 'git:rebase',
  'git:createTag', 'git:deleteTag', 'git:stash', 'git:stashApply', 'git:stashDrop', 'git:addRemote', 'git:removeRemote', 'git:pull',
  'git:submoduleUpdate', 'git:lfsPull', 'git:worktreeAdd', 'git:worktreeRemove', 'repo:setFsmonitor',
])
/**
 * Channels that talk to a remote and update remote-tracking refs: two at once
 * fail on ref locks ("cannot lock ref 'refs/remotes/origin/main'"), as when
 * the background fetch meets a pull. They run one at a time per repository on
 * a queue of their own, so a slow fetch or push never holds up staging or a
 * commit. A pull is on both: the network first, then the writes. So is
 * removing a remote, which deletes its remote-tracking refs (a fetch running
 * meanwhile would fail on them, or write them back).
 */
const NETWORK = new Set(['git:fetch', 'git:pull', 'git:push', 'git:pushTag', 'git:deleteRemoteBranch', 'git:remoteSearch', 'git:removeRemote'])
const writeQueues = new Map<string, Promise<unknown>>()
const networkQueues = new Map<string, Promise<unknown>>()

/** Runs `fn` after every earlier call on the same queue and repository has settled. */
function serial<T>(queues: Map<string, Promise<unknown>>, repo: string, fn: () => Promise<T>): Promise<T> {
  const key = repo.replace(/\\/g, '/').toLowerCase()
  const result = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn)
  const tail = result.catch(() => undefined)
  queues.set(key, tail)
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key) })
  return result
}

/** Runs a channel's handler on the queues it belongs to (none for reads). */
export function schedule<T>(channel: string, repo: string, fn: () => Promise<T>): Promise<T> {
  const write = WRITES.has(channel) ? () => serial(writeQueues, repo, fn) : fn
  return NETWORK.has(channel) ? serial(networkQueues, repo, write) : write()
}

/** Arguments, by position, that name a revision, branch, tag or remote. */
const REF_ARGS: Record<string, number[]> = {
  'git:cherryPick': [1], 'git:revert': [1], 'git:reset': [1], 'git:checkoutCommit': [1], 'git:commit:detail': [1],
  'git:blame': [2], 'git:compare': [1, 2], 'git:rebasePlan': [1], 'git:rebaseRun': [1, 3], 'git:undoCommit': [1],
  'git:checkout': [1], 'git:createBranch': [1, 2], 'git:renameBranch': [1, 2], 'git:deleteBranch': [1], 'git:restoreBranch': [1, 2],
  'git:deleteRemoteBranch': [1, 2], 'git:merge': [1], 'git:rebase': [1], 'git:createTag': [1, 2], 'git:deleteTag': [1],
  'git:pushTag': [1, 2], 'git:addRemote': [1, 2], 'git:removeRemote': [1], 'git:worktreeAdd': [2, 4],
}

/** Arguments, by position, that name files of the repository (a list of them, for some). */
const PATH_ARGS: Record<string, number[]> = {
  'git:stage': [1], 'git:unstage': [1], 'git:discard': [1], 'git:stash': [3],
  'git:stageLines': [1], 'git:unstageLines': [1, 4], 'git:discardLines': [1], 'git:resolve': [1], 'git:conflict': [1],
  'git:resolveContent': [1], 'git:resolveWhole': [1], 'git:fileLog': [1], 'git:blame': [1], 'git:submoduleUpdate': [1],
  'shell:reveal': [1], 'shell:editor': [1],
}

/** A path relative to the repository that stays inside it: files are read and written at `join(repo, path)`. */
function insideRepo(path: string): boolean {
  if (!path || path.includes('\0') || isAbsolute(path) || /^[a-z]:/i.test(path)) return false
  const parts = posix.normalize(path.replace(/\\/g, '/'))
  return parts !== '..' && !parts.startsWith('../')
}

/** Channels whose first argument may be null (the global identity, no repo to watch). */
const NULL_REPO_OK = new Set(['git:identity', 'git:setIdentity', 'watch:set'])
/** Channels that open a folder in another program: worktrees and submodules count, executables do not. */
const OPENS_FOLDER = new Set(['shell:reveal', 'shell:editor', 'shell:terminal'])

/**
 * Git and integration channels act on a repository the user added, never on
 * an arbitrary path; settings take known keys with the expected types. A
 * compromised page could otherwise run git in any folder or point the
 * editor command at any program.
 */
export function checkArgs(channel: string, args: unknown[]): void {
  const repoFirst = channel.startsWith('git:') || OPENS_FOLDER.has(channel) ||
    ['watch:set', 'provider:url', 'repo:fsmonitor', 'repo:setFsmonitor'].includes(channel)
  if (repoFirst) {
    const repo = args[0]
    if (repo === null && NULL_REPO_OK.has(channel)) return
    if (typeof repo !== 'string') throw new GitError('A repository path is required.')
    if (OPENS_FOLDER.has(channel)) {
      let isDir = false
      try { isDir = statSync(repo).isDirectory() } catch { /* missing */ }
      if (!isDir) throw new GitError(`"${repo}" is not a folder.`)
    } else if (!isRegistered(repo)) {
      throw new GitError(`"${repo}" is not one of your repositories. Add it first.`)
    }
  }
  // A revision, branch, tag or remote that starts with "-" would reach git as an option ("--exec=…").
  const refs = (REF_ARGS[channel] ?? []).flatMap(i => {
    const v = args[i]
    return Array.isArray(v) ? v : [v]
  })
  // A file path leaving the repository ("../…", "C:\…") would be read or written out there.
  const paths = (PATH_ARGS[channel] ?? []).flatMap(i => {
    const v = args[i]
    return Array.isArray(v) ? v : [v]
  })
  if (channel === 'git:diff') {
    const source = args[1] as Partial<Record<'sha' | 'from' | 'to' | 'path' | 'oldPath' | 'index', unknown>> | undefined
    refs.push(source?.sha, source?.from, source?.to)
    paths.push(source?.path, source?.oldPath)
    if (source?.index !== undefined && !(Number.isInteger(source.index) && (source.index as number) >= 0)) throw new GitError('Invalid stash entry.')
  }
  if (channel === 'git:restore') refs.push((args[1] as { sha?: unknown; branch?: unknown } | undefined)?.sha, (args[1] as { branch?: unknown } | undefined)?.branch)
  for (const r of refs) {
    if (typeof r === 'string' && (r.startsWith('-') || r.includes('\0'))) throw new GitError(`"${r}" is not a valid name or revision.`)
  }
  for (const p of paths) {
    if (p !== undefined && p !== null && (typeof p !== 'string' || !insideRepo(p))) throw new GitError(`"${String(p)}" must be a file inside the repository.`)
  }
  if ((channel === 'git:stashApply' || channel === 'git:stashDrop') && !(Number.isInteger(args[1]) && (args[1] as number) >= 0)) {
    throw new GitError('Invalid stash entry.')
  }
  if (channel === 'app:settings') {
    const patch = args[0]
    if (!patch || typeof patch !== 'object') throw new GitError('Invalid settings.')
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULT_SETTINGS)) throw new GitError(`Unknown setting "${key}".`)
      if (typeof value !== typeof DEFAULT_SETTINGS[key as keyof Settings]) throw new GitError(`Setting "${key}" has the wrong type.`)
    }
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
