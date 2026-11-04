import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, posix, resolve as resolvePath, sep } from 'node:path'
import type { Api, ApiChannel, ApiEvents, IpcEnvelope } from '@shared/api'
import { isSettingKey, validSetting, type Progress, type RepoImport } from '@shared/types'
import { onAbandon, registerPending, respond } from './askpass'
import { blame, fileLog } from './git/blame'
import { compare } from './git/compare'
import { rebasePlan, rebaseRun } from './git/rebase'
import { lfsPull, submoduleUpdate, worktreeAdd, worktreeRemove } from './git/modules'
import { fsmonitorInfo, setFsmonitor } from './git/perf'
import { deletedBranches, operations, restore, restoreBranch } from './git/reflog'
import { newerTips, remoteSearch } from './git/recovery'
import { conflict, resolveContent, resolveWhole } from './git/conflict'
import { diff } from './git/diff'
import { git, GitError, gitVersion } from './git/exec'
import { commitDetail, log, stashDetail } from './git/log'
import * as ops from './git/ops'
import { defaultBranch, defaultRemote, extras, refs } from './git/refs'
import { isRepo, status, topLevel } from './git/status'
import { openEditor, openTerminal } from './integrations'
import { logDir } from './log'
import { detectProvider, providerUrl } from './provider'
import { installUpdate } from './updater'
import { githubDesktopRepos } from './importers'
import { addRepoEntry, foldPath, getState, isInsideRegistered, isRegistered, removeRepo, repoById, save, stateUnreadable, updateSettings, upsertRepo } from './store'
import { gitFolders, type RepoWatcher } from './watcher'

type Handlers = { [K in ApiChannel]: (...args: Parameters<Api[K]>) => ReturnType<Api[K]> }

export function send<K extends keyof ApiEvents>(channel: K, payload: ApiEvents[K]): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload)
}

const progress = (p: Progress | null) => send('progress', p)

/**
 * Opening the same folder twice resolves to the repository root once. A
 * folder that is not a repository yet (dropped, or opened from Explorer)
 * becomes one only once the user says so in a dialog of the main process.
 */
async function addRepo(path: string) {
  if (!existsSync(path)) throw new GitError('This folder does not exist.')
  if (await isRepo(path)) return upsertRepo(await topLevel(path))
  if (!(await ask('This folder is not a Git repository yet. Create one in it?', path, 'Create repository'))) {
    throw new GitError('Cancelled: nothing was created.', 'CANCELLED')
  }
  await git(path, ['init', '-b', 'main'])
  return upsertRepo(path)
}

/**
 * A yes/no question in a dialog of the main process, which a compromised
 * page can neither show nor answer. Cancel is the default: Enter never
 * agrees by accident.
 */
async function ask(message: string, detail: string, button: string): Promise<boolean> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const opts = { type: 'question' as const, buttons: [button, 'Cancel'], defaultId: 1, cancelId: 1, message, detail }
  const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
  return response === 0
}

/**
 * Folders the user picked in a folder dialog of this session, or confirmed
 * as a destination: creating, cloning or adding a worktree inside one asks
 * nothing more.
 */
const chosenFolders = new Set<string>()
/** Worktrees git listed for one of the user's repositories: folders the app may open elsewhere. */
const knownWorktrees = new Set<string>()
const folderKey = (p: string) => {
  const r = resolvePath(p)
  return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r
}
const inChosen = (path: string) => {
  const p = folderKey(path)
  return [...chosenFolders].some(f => p === f || p.startsWith(f.endsWith(sep) ? f : f + sep))
}

/**
 * Where a repository or a worktree is created: a folder the user chose, or
 * one confirmed in a dialog of the main process, which a compromised page
 * can neither show nor answer. Without it, a page could create a repository
 * in ~/.config/git or the Startup folder and fill it with files of its own.
 */
export async function confirmDestination(path: string, message: string, button: string, remember: string): Promise<void> {
  if (inChosen(path)) return
  if (!(await ask(message, path, button))) throw new GitError('Cancelled: nothing was created.', 'CANCELLED')
  chosenFolders.add(folderKey(remember))
}

/** Stops the clone under way, if any: a large one or a stalled network no longer leaves only waiting. */
let cloneAbort: AbortController | null = null

/** A folder the app was launched with; the renderer opens it instead of the last repo. */
let launchPath: string | null = null
export function setLaunchPath(path: string | null): void {
  launchPath = path
}

/** Whether the page has read its start state (and so listens for open:path). */
let stateRead = false

/** A folder from a second launch: sent to the page, or kept for it while it is still starting. */
export function openFolder(path: string): void {
  if (stateRead) send('open:path', path)
  else launchPath = path
}

export function registerIpc(watcher: RepoWatcher): void {
  onAbandon(id => send('askpass:cancel', { id, reason: 'gone' }))
  const h: Handlers = {
    'app:state': async () => {
      const s = getState()
      const open = launchPath
      launchPath = null
      stateRead = true
      return { repos: s.repos, lastRepo: s.lastRepo, settings: s.settings, platform: process.platform, version: app.getVersion(), home: homedir(), launchPath: open, stateUnreadable: stateUnreadable(), git: await gitVersion() }
    },
    'app:settings': async patch => {
      // Commands the app runs change only once confirmed in a dialog of the main process, which a
      // compromised page could neither show nor answer: it cannot point the editor at any program.
      const current = getState().settings
      const commands = (['editorCommand', 'terminalCommand'] as const).filter(k => patch[k] && patch[k] !== current[k])
      if (commands.length) {
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
        const opts = {
          type: 'question' as const, buttons: ['Use them', 'Cancel'], defaultId: 0, cancelId: 1,
          message: 'GaetanDev Git will run these commands to open your editor or terminal.',
          detail: commands.map(k => `${k === 'editorCommand' ? 'Editor' : 'Terminal'}: ${patch[k]}`).join('\n'),
        }
        const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
        if (response !== 0) throw new GitError('Integrations were not changed.', 'CANCELLED')
      }
      return updateSettings(patch)
    },
    // "Restart now" during a commit or a checkout: the update waits for it (ten seconds at most).
    'app:installUpdate': async () => {
      await settleQueues(10_000)
      installUpdate()
    },
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
      await confirmDestination(path, 'This folder is not a Git repository yet. Create one in it?', 'Create repository', path)
      mkdirSync(path, { recursive: true })
      await git(path, ['init', '-b', 'main'])
      return upsertRepo(path)
    },
    'repo:clone': async (url, parent, name) => {
      const target = join(parent, name)
      if (existsSync(target)) throw new GitError(`"${target}" already exists.`)
      await confirmDestination(target, 'Clone the repository into this folder?', 'Clone', parent)
      mkdirSync(parent, { recursive: true })
      const abort = new AbortController()
      cloneAbort = abort
      try {
        await ops.clone(url, parent, name, progress, abort.signal)
      } finally {
        if (cloneAbort === abort) cloneAbort = null
      }
      return upsertRepo(target)
    },
    'repo:cancelClone': async () => cloneAbort?.abort(),
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
      const picked = r.canceled ? null : r.filePaths[0] ?? null
      if (picked) chosenFolders.add(folderKey(picked))
      return picked
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
    'git:continue': async (repo, message) => ops.continueOp(repo, message),
    'git:abort': async repo => ops.abortOp(repo),
    'git:skip': async repo => ops.skipOp(repo),
    'git:conflict': async (repo, path) => conflict(repo, path),
    'git:resolveContent': async (repo, path, content, encoding, expect) => resolveContent(repo, path, content, encoding, expect),
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
    'git:extras': async repo => {
      const x = await extras(repo)
      // The worktrees git lists may be opened in Explorer, an editor or a terminal (see checkArgs).
      for (const w of x.worktrees) knownWorktrees.add(folderKey(w.path))
      return x
    },
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
    'git:worktreeAdd': async (repo, path, branch, create, from) => {
      // Where the dialog puts it needs no confirmation: "<repo>-<branch>" next to the repository.
      // Not any folder there: next to a repository in the home folder, ".config" holds git's global config.
      const name = (p: string) => (process.platform === 'win32' || process.platform === 'darwin' ? basename(p).toLowerCase() : basename(p))
      const suggested = folderKey(dirname(path)) === folderKey(dirname(repo)) && name(path).startsWith(`${name(repo)}-`)
      if (!suggested) {
        await confirmDestination(path, 'Create the worktree in this folder?', 'Create worktree', dirname(path))
      }
      return worktreeAdd(repo, path, branch, create, from)
    },
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
    'clipboard:read': async () => clipboard.readText(),
    'app:openLogs': async () => {
      mkdirSync(logDir(), { recursive: true })
      await shell.openPath(logDir())
    },
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
 * app://bundle/index.html (see serveBundle in index.ts), or the dev server
 * while developing. Any file:// page, the importer's included, is refused.
 */
function trustedSender(e: IpcMainInvokeEvent): boolean {
  const frame = e.senderFrame
  if (!frame || frame !== e.sender.mainFrame) return false
  const dev = !app.isPackaged && process.env.ELECTRON_RENDERER_URL
  if (dev && frame.url.startsWith(`${new URL(dev).origin}/`)) return true
  return /^app:\/\/bundle\/index\.html(?:[?#].*)?$/.test(frame.url)
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
  // Case folded only where the file system ignores it: two Linux repositories differing by case are two queues.
  const key = foldPath(repo).replace(/\\/g, '/')
  const result = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn)
  const tail = result.catch(() => undefined)
  queues.set(key, tail)
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key) })
  return result
}

/**
 * The git folder a repository shares with its linked worktrees, which keep
 * their refs (remote-tracking branches included) there: a fetch in one
 * worktree and a pull in another updated the same refs at once ("cannot lock
 * ref"), each on its own queue. Network commands queue by it.
 */
function sharedGitDir(repo: string): string {
  const f = gitFolders(repo)
  const dir = f ? f.common ?? f.dir : join(repo, '.git')
  try { return realpathSync.native(dir) } catch { return dir }
}

/** Whether queued git work (a write or a network command) is still running. */
export const queuesBusy = (): boolean => writeQueues.size + networkQueues.size > 0

/** Resolves once every queued write and network command has settled, or after `ms`. */
export function settleQueues(ms: number): Promise<void> {
  const pending = [...writeQueues.values(), ...networkQueues.values()]
  if (!pending.length) return Promise.resolve()
  return Promise.race([Promise.all(pending).then(() => undefined), new Promise<void>(resolve => setTimeout(resolve, ms))])
}

/** Runs a channel's handler on the queues it belongs to (none for reads). */
export function schedule<T>(channel: string, repo: string, fn: () => Promise<T>): Promise<T> {
  const write = WRITES.has(channel) ? () => serial(writeQueues, repo, fn) : fn
  return NETWORK.has(channel) ? serial(networkQueues, sharedGitDir(repo), write) : write()
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

/**
 * Names Windows resolves to the .git folder besides ".git" itself: its 8.3
 * short name ("GIT~1"), the directory stream (".git::$INDEX_ALLOCATION",
 * ".git:$I30:$INDEX_ALLOCATION"), and trailing dots or spaces, which Win32
 * drops. Git refuses to check out any of them (core.protectNTFS), so no file
 * shown can be one; any ":" goes too, as it names a stream or a drive.
 */
const isGitDir = (part: string) => {
  const p = part.toLowerCase()
  if (p === '.git') return true
  return process.platform === 'win32' && (p.includes(':') || /^git~\d+$/.test(p) || p.replace(/[. ]+$/, '') === '.git')
}

/** A path relative to the repository that stays inside it: files are read and written at `join(repo, path)`. */
function insideRepo(path: string): boolean {
  // "c:notes.md" names a drive on Windows only; elsewhere it is a file a commit can hold.
  if (!path || path.includes('\0') || isAbsolute(path) || (process.platform === 'win32' && /^[a-z]:/i.test(path))) return false
  const parts = posix.normalize(path.replace(/\\/g, '/'))
  if (parts === '..' || parts.startsWith('../')) return false
  // Nor inside a .git folder (hooks, config): git never tracks a path through one, so no file shown is.
  return !parts.split('/').some(isGitDir)
}

/** Channels whose first argument may be null (the global identity, no repo to watch). */
const NULL_REPO_OK = new Set(['git:identity', 'git:setIdentity', 'watch:set'])
/** Channels that open a folder in another program: worktrees and submodules count, executables do not. */
const OPENS_FOLDER = new Set(['shell:reveal', 'shell:editor', 'shell:terminal'])

/**
 * Git and integration channels act on a repository the user added, never on
 * an arbitrary path, and on files inside it; settings take known keys with
 * the expected types. Defence in depth against a compromised page, which
 * could otherwise run git in any folder or write outside the repository.
 * (Adding a repository takes any folder: the user picks or drops it.)
 */
export function checkArgs(channel: string, args: unknown[]): void {
  const repoFirst = channel.startsWith('git:') || OPENS_FOLDER.has(channel) ||
    ['watch:set', 'provider:url', 'repo:fsmonitor', 'repo:setFsmonitor'].includes(channel)
  if (repoFirst) {
    const repo = args[0]
    if (repo === null && NULL_REPO_OK.has(channel)) return
    if (typeof repo !== 'string') throw new GitError('A repository path is required.')
    if (OPENS_FOLDER.has(channel)) {
      // A repository, a folder inside one (a submodule) or a worktree git listed for one: any other
      // folder (the Startup folder in Explorer, a network path looked up) is not the app's to open.
      if (!isRegistered(repo) && !isInsideRegistered(repo) && !knownWorktrees.has(folderKey(repo))) {
        throw new GitError(`"${repo}" is not one of your repositories, or a folder of one.`)
      }
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
      if (!isSettingKey(key)) throw new GitError(`Unknown setting "${key}".`)
      if (!validSetting(key, value)) throw new GitError(`"${String(value)}" is not a valid value for the setting "${key}".`)
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
    // Unanswered, the prompt is declined, and its dialog closes: an answer typed later would go nowhere.
    const timer = setTimeout(() => {
      respond(req.id, null)
      send('askpass:cancel', { id: req.id, reason: 'timeout' })
    }, 5 * 60_000)
    // A page reloaded meanwhile (a crash recovered) lost the dialog: it is asked again, rather than
    // git waiting five minutes for an answer, holding the repository's network queue.
    const again = () => win.webContents.send('askpass', req)
    win.webContents.on('did-finish-load', again)
    registerPending(req.id, value => {
      clearTimeout(timer)
      if (!win.isDestroyed()) win.webContents.removeListener('did-finish-load', again)
      resolve(value)
    })
    if (win.isMinimized()) win.restore()
    win.focus()
    win.webContents.send('askpass', req)
  })
}
