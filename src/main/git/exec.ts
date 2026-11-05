import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import type { GitErrorCode } from '@shared/api'

export class GitError extends Error {
  /** Full output of the failed command (hook logs and the like), ANSI codes removed. */
  details = ''

  constructor(message: string, public code?: GitErrorCode, public stderr = '', public exitCode = 1) {
    super(message)
    this.name = 'GitError'
  }
}

export interface ExecOptions {
  input?: string | Buffer
  /** Exit codes treated as success (git diff --no-index exits 1 on differences). */
  okCodes?: number[]
  env?: NodeJS.ProcessEnv
  /** Called with each progress line git writes to stderr. */
  onStderrLine?: (line: string) => void
  maxBytes?: number
  /** Stops git and what it started; the call then fails with code CANCELLED. */
  signal?: AbortSignal
}

export interface ExecResult {
  stdout: string
  stderr: string
  code: number
  /** stdout as bytes, for content that may not be UTF-8. */
  raw: Buffer
  /** Output stopped at `maxBytes`: what is there is only the beginning. */
  truncated?: boolean
}

/** Git processes still running, so quitting the app can stop them. */
const running = new Set<ChildProcess>()

/**
 * Stops git processes with everything they started. On Windows killing
 * git.exe leaves its children running (git-remote-https, index-pack, ssh, a
 * hook), still holding files open after the app is gone: taskkill /T ends the
 * whole tree.
 */
function stop(children: ChildProcess[]): void {
  const pids = children.map(c => c.pid).filter((p): p is number => !!p)
  if (process.platform === 'win32' && pids.length) {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
    spawnSync(taskkill, ['/T', '/F', ...pids.flatMap(p => ['/PID', String(p)])], { windowsHide: true, stdio: 'ignore' })
  }
  for (const child of children) child.kill()
}

/** Stops every git process still running (clone, fetch, push…) and what it started: called on quit. */
export function killRunning(): void {
  stop([...running])
  running.clear()
}

/** Extra environment for every git call: askpass wiring, set once at startup. */
let baseEnv: NodeJS.ProcessEnv = {}
export function setGitEnv(env: NodeJS.ProcessEnv): void {
  baseEnv = env
}

/**
 * A program's absolute path, from the absolute folders of PATH only. Spawned
 * by bare name, Windows looks in the working directory first, and git runs in
 * the repository: a git.exe committed at its root would run instead of git.
 */
export function findOnPath(name: string, exts = process.platform === 'win32' ? ['.exe', '.com'] : ['']): string | null {
  for (const raw of (process.env.PATH ?? '').split(delimiter)) {
    const dir = raw.replace(/^"(.*)"$/, '$1')
    // "" and "." would mean the working directory again.
    if (!isAbsolute(dir)) continue
    for (const ext of exts) {
      const full = join(dir, name + ext)
      try {
        if (statSync(full).isFile()) {
          accessSync(full, constants.X_OK)
          return full
        }
      } catch { /* not here */ }
    }
  }
  return null
}

const MAX_STDERR = 1024 * 1024
/** How long git's output may keep arriving once git has exited (see run). */
const EXIT_GRACE_MS = 1000

/** Looked up on the first call, and again after it went missing (installed or moved while the app runs). */
let gitPath: string | null = null
const NOT_FOUND = 'Git was not found. Install Git for Windows and restart the app.'

/**
 * Output the parsers rely on, whatever the user's config says: "a/" and "b/"
 * diff prefixes (diff.noprefix made every line stage fail), a context line
 * kept as " " when blank, no signature check printed into log output.
 */
const GLOBAL_ARGS = [
  '-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'i18n.logOutputEncoding=UTF-8',
  '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.srcPrefix=a/', '-c', 'diff.dstPrefix=b/',
  '-c', 'diff.relative=false', '-c', 'diff.suppressBlankEmpty=false', '-c', 'log.showSignature=false',
  // A submodule as "Subproject commit" lines: "log" left no hunks ("The file is empty"), and "diff"
  // read the submodule's own files as hunks of the submodule.
  '-c', 'diff.submodule=short',
  // A folder holding a repository's data itself (HEAD, objects, refs and a config), not in a ".git",
  // is never taken for a repository. A cloned or checked-out one could set core.worktree to itself
  // and core.fsmonitor to a command, which the next status ran (git 2.38+; older ones ignore it).
  '-c', 'safe.bareRepository=explicit',
]

/** The git command an argument list runs: "stash" for ['-c', 'k=v', 'stash', 'push']. */
function subcommand(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c') i++
    else if (!args[i].startsWith('-')) return args[i]
  }
  return undefined
}

/**
 * `git status --show-stash` (porcelain v2) appeared in 2.35, `worktree list -z` and the
 * built-in fsmonitor in 2.36: older versions fail on every refresh.
 */
const MINIMUM = [2, 36, 0]
/** 2.50.1 fixed the last known ways a cloned repository (with submodules) could run code. */
const RECOMMENDED = [2, 50, 1]

const atLeast = (v: number[], min: number[]) => {
  for (let i = 0; i < min.length; i++) if ((v[i] ?? 0) !== min[i]) return (v[i] ?? 0) > min[i]
  return true
}

/** "git version 2.45.0.windows.1" → its version, and whether the app supports it and recommends it. */
export function readGitVersion(text: string): { version: string; supported: boolean; recommended: boolean; minimum: string } | null {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text)
  if (!m) return null
  const v = [+m[1], +m[2], +(m[3] ?? 0)]
  return { version: v.join('.'), supported: atLeast(v, MINIMUM), recommended: atLeast(v, RECOMMENDED), minimum: MINIMUM.join('.') }
}

/** The installed git's version, or null when git cannot be run. */
export async function gitVersion(): Promise<ReturnType<typeof readGitVersion>> {
  try {
    return readGitVersion((await run(tmpdir(), ['version'])).stdout)
  } catch {
    return null
  }
}

/**
 * Commands run without GIT_LITERAL_PATHSPECS: stash, and those that run hooks
 * (pre-commit, post-checkout, pre-push…), whose own git calls would inherit it.
 * Any path given to them is written ":(literal)path".
 */
const GLOB_PATHSPECS = new Set(['stash', 'commit', 'merge', 'pull', 'rebase', 'cherry-pick', 'revert', 'am', 'push', 'switch', 'checkout', 'clone', 'worktree'])

/** A file name as a pathspec that never reads as a pattern, whatever GIT_LITERAL_PATHSPECS says. */
export const literal = (path: string) => `:(literal)${path}`

/** Commands that talk to a remote. */
const NETWORK_COMMANDS = new Set(['fetch', 'pull', 'push', 'clone', 'ls-remote', 'submodule', 'lfs'])

/**
 * Whether the ssh git runs is Windows' own OpenSSH (System32\OpenSSH), which
 * starts SSH_ASKPASS with CreateProcess: it cannot run a "#!/bin/sh" script
 * ("error:193"), so it gets an executable. Git's own ssh reads the script. A bare
 * "ssh" is Git's when Git for Windows ships one (usr\bin\ssh.exe, absent
 * with its "Use external OpenSSH" option), else the one on PATH.
 */
export function windowsOpenSsh(command: string | null, bundledSsh: boolean): boolean {
  if (process.platform !== 'win32') return false
  const program = command?.trim().match(/^"([^"]+)"|^(\S+)/)
  const name = program ? (program[1] ?? program[2]) : 'ssh'
  if (/^ssh(\.exe)?$/i.test(name)) return !bundledSsh
  return /[\\/]system32[\\/]openssh[\\/]/i.test(name)
}

/** Git for Windows' own ssh, next to the git found on PATH (…\cmd\git.exe or …\mingw64\bin\git.exe). */
function bundledSsh(): boolean {
  gitPath ??= findOnPath('git')
  if (!gitPath) return true
  const root = join(gitPath, '..', '..')
  return [join(root, 'usr', 'bin', 'ssh.exe'), join(root, '..', 'usr', 'bin', 'ssh.exe')].some(p => { try { return statSync(p).isFile() } catch { return false } })
}

/**
 * The environment of a command that talks to a remote. A dead connection
 * fails instead of holding its queue until the app restarts: HTTPS below 1
 * byte/s for five minutes, SSH after two minutes of unanswered keepalives. A
 * server preparing a pack or running a push hook still sends progress, so
 * only a silent connection trips them. Settings of the user's own (git config
 * or environment) are left alone. Windows' OpenSSH gets its own prompt helper.
 */
export async function stallGuards(cwd: string): Promise<NodeJS.ProcessEnv> {
  const r = await run(cwd, ['config', '--get-regexp', '^(http\\.lowspeed(limit|time)|core\\.sshcommand)$'], { okCodes: [1] })
  const values = new Map(r.stdout.split('\n').filter(Boolean).map(l => {
    const i = l.indexOf(' ')
    return [(i < 0 ? l : l.slice(0, i)).toLowerCase(), i < 0 ? '' : l.slice(i + 1)] as const
  }))
  const env: NodeJS.ProcessEnv = {}
  const http = ['http.lowspeedlimit', 'http.lowspeedtime'].some(k => values.has(k)) || process.env.GIT_HTTP_LOW_SPEED_LIMIT || process.env.GIT_HTTP_LOW_SPEED_TIME
  if (!http) Object.assign(env, { GIT_HTTP_LOW_SPEED_LIMIT: '1', GIT_HTTP_LOW_SPEED_TIME: '300' })
  const sshCommand = process.env.GIT_SSH_COMMAND || process.env.GIT_SSH || values.get('core.sshcommand') || null
  if (!sshCommand) env.GIT_SSH_COMMAND = 'ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=8'
  if (baseEnv.GDG_ASKPASS_HELPER_EXE && windowsOpenSsh(sshCommand, bundledSsh())) env.SSH_ASKPASS = baseEnv.GDG_ASKPASS_HELPER_EXE
  return env
}

/**
 * Runs git and resolves with its output. Rejects with a GitError whose message
 * is the last meaningful stderr line, and whose code classifies the failure.
 */
export async function git(cwd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  if (!NETWORK_COMMANDS.has(subcommand(args) ?? '')) return run(cwd, args, opts)
  return run(cwd, args, { ...opts, env: { ...(await stallGuards(cwd)), ...opts.env } })
}

/**
 * Variables that point git at another repository, index or object store. The
 * app started from a hook or an alias (`code .` in a post-checkout, a script
 * run by git) inherits them, and every command would then act on that
 * repository whatever folder it runs in: staging went into another index.
 */
const LOCATION_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX']
function inheritedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (LOCATION_VARS.includes(k.toUpperCase())) delete env[k]
  return env
}

function run(cwd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    gitPath ??= findOnPath('git')
    if (!gitPath) return reject(new GitError(NOT_FOUND, 'GIT_NOT_FOUND'))
    const child = spawn(gitPath, [...GLOBAL_ARGS, ...args], {
      cwd,
      windowsHide: true,
      env: {
        ...inheritedEnv(),
        ...baseEnv,
        LANG: 'C',
        LC_ALL: 'C',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
        // Paths are file names, not patterns: discarding "a[1].txt" must not touch "a1.txt".
        // Except for stash, whose own pathspec magic (":/" to clear stashed untracked files)
        // breaks in literal mode, and for commands that run hooks, which inherit the variable:
        // a pre-commit "git diff --cached -- '*.js'" then matched nothing and checked nothing.
        // Callers give those ":(literal)" paths instead.
        GIT_LITERAL_PATHSPECS: GLOB_PATHSPECS.has(subcommand(args) ?? '') ? '0' : '1',
        ...opts.env,
      },
    })

    running.add(child)
    child.on('exit', () => running.delete(child))

    const out: Buffer[] = []
    const err: Buffer[] = []
    let outBytes = 0
    let errBytes = 0
    let truncated = false
    let pending = ''
    let cancelled = false

    const cancel = () => {
      cancelled = true
      stop([child])
    }
    if (opts.signal?.aborted) cancel()
    opts.signal?.addEventListener('abort', cancel, { once: true })
    child.on('exit', () => opts.signal?.removeEventListener('abort', cancel))

    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return
      if (opts.maxBytes && outBytes + chunk.length > opts.maxBytes) {
        truncated = true
        stop([child])
        return
      }
      outBytes += chunk.length
      out.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      // Only the end of stderr is kept past 1 MB (a chatty hook, endless progress): errors come last.
      err.push(chunk)
      errBytes += chunk.length
      while (errBytes > MAX_STDERR && err.length > 1) errBytes -= err.shift()!.length
      if (!opts.onStderrLine) return
      pending += chunk.toString('utf8')
      const parts = pending.split(/[\r\n]/)
      pending = parts.pop() ?? ''
      for (const line of parts) if (line.trim()) opts.onStderrLine(line)
    })

    let settled = false
    let grace: ReturnType<typeof setTimeout> | undefined
    child.on('error', (e: NodeJS.ErrnoException) => {
      settled = true
      // Node reports a working folder that is gone (a repository moved, a drive removed) as ENOENT
      // too: "Install Git" then showed at every focus of the window, and git was looked up again.
      if (e.code === 'ENOENT' && !existsSync(cwd)) {
        reject(new GitError(`"${cwd}" no longer exists: it was moved, renamed or deleted, or its drive is not connected.`))
      } else if (e.code === 'ENOENT') {
        gitPath = null
        reject(new GitError(NOT_FOUND, 'GIT_NOT_FOUND'))
      } else reject(new GitError(e.message))
    })

    // 'close' waits for every process that holds git's output: a hook that leaves a job running in
    // the background without redirecting it ("npm ci &" in post-checkout) kept the command, and the
    // repository's queue behind it, going until that job ended. Once git itself has exited, the
    // rest of its output gets a moment to arrive, and the job keeps running on its own.
    child.on('exit', code => {
      grace = setTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        finish(code)
      }, EXIT_GRACE_MS)
    })
    child.on('close', code => finish(code))

    function finish(code: number | null) {
      if (settled) return
      settled = true
      clearTimeout(grace)
      const raw = Buffer.concat(out)
      const stdout = raw.toString('utf8')
      const stderr = Buffer.concat(err).toString('utf8')
      if (truncated) return resolve({ stdout, stderr, code: -1, raw, truncated: true })
      if (cancelled) return reject(new GitError('Cancelled.', 'CANCELLED', stderr))
      const exit = code ?? 1
      if (exit === 0 || opts.okCodes?.includes(exit)) return resolve({ stdout, stderr, code: exit, raw })
      reject(toGitError(stdout, stderr, exit))
    }

    // Git may exit before reading all its input (a lock held elsewhere, a failing hook): the write then
    // fails, which 'close' already reports through the exit code. Unhandled, it would crash the main process.
    child.stdin.on('error', () => undefined)
    if (typeof opts.input === 'string') child.stdin.end(opts.input, 'utf8')
    else if (opts.input) child.stdin.end(opts.input)
    else child.stdin.end()
  })
}

/** Refuses a new branch or tag name git would reject (or read as an option), saying which. */
export async function assertRefName(repo: string, kind: 'branch' | 'tag', name: string): Promise<void> {
  const ok = !!name && !name.startsWith('-') &&
    (await git(repo, ['check-ref-format', `refs/${kind === 'branch' ? 'heads' : 'tags'}/${name}`], { okCodes: [1] })).code === 0
  if (!ok) throw new GitError(`"${name}" is not a valid ${kind} name.`)
}

/** Shorthand returning stdout only. */
export async function gitOut(cwd: string, args: string[], opts?: ExecOptions): Promise<string> {
  return (await git(cwd, args, opts)).stdout
}

const PATTERNS: [RegExp, GitErrorCode][] = [
  [/would be overwritten by (checkout|merge)|Please commit your changes or stash them/i, 'LOCAL_CHANGES_OVERWRITTEN'],
  // Not a tag that already exists on the remote: pulling would not help there.
  [/\[rejected\].*\((non-fast-forward|fetch first)\)|Updates were rejected because (?!the tag already exists)/i, 'NON_FAST_FORWARD'],
  [/has no upstream branch|no tracking information/i, 'NO_UPSTREAM'],
  [/Authentication failed|could not read Username|Permission denied \(publickey|terminal prompts disabled|HTTP Basic: Access denied|returned error: 40[13]/i, 'AUTH_FAILED'],
  [/CONFLICT \(|Merge conflict|fix conflicts|could not apply|after resolving the conflicts/i, 'CONFLICTS'],
  [/nothing to commit|no changes added to commit/i, 'NOTHING_TO_COMMIT'],
  [/is not fully merged/i, 'BRANCH_NOT_MERGED'],
  [/not a git repository/i, 'NOT_A_REPO'],
]

export function toGitError(stdout: string, stderr: string, exitCode: number): GitError {
  const text = `${stderr}\n${stdout}`
  const code = PATTERNS.find(([re]) => re.test(text))?.[1]
  const error = new GitError(summarize(stderr || stdout) || `git exited with code ${exitCode}`, code, stderr, exitCode)
  error.details = stripAnsi(`${stdout}\n${stderr}`.trim()).slice(-40_000)
  return error
}

/**
 * Keeps the lines a human needs: errors, fatal messages and hints, minus
 * noise. The server's own errors come first: a push refused by a protected
 * branch (GH006) or a server hook says why only on "remote:" lines and on
 * "! [remote rejected] … (reason)", and showed just "failed to push some refs".
 */
function summarize(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map(l => l.trimEnd())
    .filter(l => l && !/^(remote: )?(Enumerating|Counting|Compressing|Writing|Total|Delta|Receiving|Resolving)/.test(l))
  const server = lines.filter(l => /^remote: *(error|fatal|GH\d+)\b/i.test(l) || /^ ?! \[remote rejected\]/.test(l))
  const important = lines.filter(l => /^(error|fatal|CONFLICT|hint: Updates)/.test(l))
  const picked = [...server, ...important].slice(0, 6)
  return (picked.length ? picked : lines.slice(0, 6)).map(l => l.replace(/^(error|fatal): /, '').replace(/^remote: */, '')).join('\n')
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r(?!\n)/g, '\n')
}
