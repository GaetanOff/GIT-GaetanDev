import { spawn, type ChildProcess } from 'node:child_process'
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

/** Stops every git process still running (clone, fetch, push…): called on quit. */
export function killRunning(): void {
  for (const child of running) child.kill()
  running.clear()
}

/** Extra environment for every git call: askpass wiring, set once at startup. */
let baseEnv: NodeJS.ProcessEnv = {}
export function setGitEnv(env: NodeJS.ProcessEnv): void {
  baseEnv = env
}

const GLOBAL_ARGS = ['-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'i18n.logOutputEncoding=UTF-8']

/** The git command an argument list runs: "stash" for ['-c', 'k=v', 'stash', 'push']. */
function subcommand(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c') i++
    else if (!args[i].startsWith('-')) return args[i]
  }
  return undefined
}

/**
 * Runs git and resolves with its output. Rejects with a GitError whose message
 * is the last meaningful stderr line, and whose code classifies the failure.
 */
export function git(cwd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...GLOBAL_ARGS, ...args], {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        ...baseEnv,
        LANG: 'C',
        LC_ALL: 'C',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
        // Paths are file names, not patterns: discarding "a[1].txt" must not touch "a1.txt".
        // Except for stash, whose own pathspec magic (":/" to clear stashed untracked files)
        // breaks in literal mode: callers give it ":(literal)" paths instead.
        GIT_LITERAL_PATHSPECS: subcommand(args) === 'stash' ? '0' : '1',
        ...opts.env,
      },
    })

    running.add(child)
    child.on('exit', () => running.delete(child))

    const out: Buffer[] = []
    const err: Buffer[] = []
    let outBytes = 0
    let truncated = false
    let pending = ''

    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return
      if (opts.maxBytes && outBytes + chunk.length > opts.maxBytes) {
        truncated = true
        child.kill()
        return
      }
      outBytes += chunk.length
      out.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      err.push(chunk)
      if (!opts.onStderrLine) return
      pending += chunk.toString('utf8')
      const parts = pending.split(/[\r\n]/)
      pending = parts.pop() ?? ''
      for (const line of parts) if (line.trim()) opts.onStderrLine(line)
    })

    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') reject(new GitError('Git was not found. Install Git for Windows and restart the app.', 'GIT_NOT_FOUND'))
      else reject(new GitError(e.message))
    })

    child.on('close', code => {
      const raw = Buffer.concat(out)
      const stdout = raw.toString('utf8')
      const stderr = Buffer.concat(err).toString('utf8')
      if (truncated) return resolve({ stdout, stderr, code: -1, raw, truncated: true })
      const exit = code ?? 1
      if (exit === 0 || opts.okCodes?.includes(exit)) return resolve({ stdout, stderr, code: exit, raw })
      reject(toGitError(stdout, stderr, exit))
    })

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
  [/\[rejected\].*\((non-fast-forward|fetch first)\)|Updates were rejected because/i, 'NON_FAST_FORWARD'],
  [/has no upstream branch|no tracking information/i, 'NO_UPSTREAM'],
  [/Authentication failed|could not read Username|Permission denied \(publickey|terminal prompts disabled|HTTP Basic: Access denied|returned error: 40[13]/i, 'AUTH_FAILED'],
  [/CONFLICT \(|Merge conflict|fix conflicts|could not apply|after resolving the conflicts/i, 'CONFLICTS'],
  [/nothing to commit|no changes added to commit/i, 'NOTHING_TO_COMMIT'],
  [/is not fully merged/i, 'BRANCH_NOT_MERGED'],
  [/not a git repository/i, 'NOT_A_REPO'],
]

function toGitError(stdout: string, stderr: string, exitCode: number): GitError {
  const text = `${stderr}\n${stdout}`
  const code = PATTERNS.find(([re]) => re.test(text))?.[1]
  const error = new GitError(summarize(stderr || stdout) || `git exited with code ${exitCode}`, code, stderr, exitCode)
  error.details = stripAnsi(`${stdout}\n${stderr}`.trim()).slice(-40_000)
  return error
}

/** Keeps the lines a human needs: errors, fatal messages and hints, minus noise. */
function summarize(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map(l => l.trimEnd())
    .filter(l => l && !/^(remote: )?(Enumerating|Counting|Compressing|Writing|Total|Delta|Receiving|Resolving)/.test(l))
  const important = lines.filter(l => /^(error|fatal|CONFLICT|hint: Updates)/.test(l))
  const picked = (important.length ? important : lines).slice(0, 6)
  return picked.map(l => l.replace(/^(error|fatal): /, '')).join('\n')
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r(?!\n)/g, '\n')
}
