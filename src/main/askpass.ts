import { app } from 'electron'
import { spawnSync } from 'node:child_process'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import type { AskPassRequest } from '@shared/types'

/**
 * Credential prompts from git and ssh (passwords, passphrases, host keys) are
 * routed into the app: GIT_ASKPASS/SSH_ASKPASS point at a tiny script that
 * runs this executable as Node and asks the main process over a named pipe.
 * HTTPS credentials for GitHub, GitLab, Azure DevOps and Bitbucket are usually
 * handled first by Git Credential Manager, which has its own sign-in window.
 *
 * The pipe has a random name and every request must carry a secret that only
 * the git processes this app starts receive, so another local program can
 * neither make the app show a credential prompt nor answer one in its place.
 */
const CLIENT = `
const net = require('net')
const prompt = process.argv.slice(2).join(' ')
const sock = net.connect(process.env.GDG_ASKPASS_PIPE, () => sock.write(JSON.stringify({ prompt, token: process.env.GDG_ASKPASS_TOKEN }) + '\\n'))
let buf = ''
sock.on('data', d => { buf += d })
sock.on('end', () => {
  try {
    const r = JSON.parse(buf)
    if (r.value === null || r.value === undefined) process.exit(1)
    process.stdout.write(r.value + '\\n')
    process.exit(0)
  } catch { process.exit(1) }
})
sock.on('error', () => process.exit(1))
`

const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s)

/**
 * A file's path in plain ASCII: Windows' OpenSSH cannot start a program
 * whose path holds "ë" (CreateProcess "error:2"), as in a profile folder named
 * after its user. The folder's 8.3 short name is ASCII when the volume keeps
 * short names (the system drive does by default); otherwise the path stays.
 */
function asciiPath(dir: string, file: string): string {
  const full = join(dir, file)
  if (isAscii(full)) return full
  try {
    const comspec = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
    // Run in the folder itself: its name never has to be quoted on a command line.
    const short = spawnSync(comspec, ['/d', '/c', 'for %I in (.) do @echo %~sI'], { cwd: dir, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true }).stdout.trim()
    return isAscii(short) && short ? join(short, file) : full
  } catch {
    return full
  }
}

type Ask = (req: AskPassRequest) => Promise<string | null>

let server: Server | null = null
let env: NodeJS.ProcessEnv | null = null
const pending = new Map<string, (value: string | null) => void>()

/** Starts the prompt server once; later calls return the same environment. */
export function startAskPass(ask: Ask): NodeJS.ProcessEnv {
  if (env) return env
  const dir = app.getPath('userData')
  const client = join(dir, 'askpass.js')
  writeFileSync(client, CLIENT, 'utf8')

  // A shell script on every platform, run the way git runs hooks: Git for Windows reads its
  // "#!/bin/sh" line, and so does its ssh. The paths travel in the environment, not in the file:
  // a .cmd was read in the OEM code page ("Gaëtan" in the profile path broke every prompt), a "%"
  // in it was expanded, and cmd cut a multi-line prompt (a host key and its fingerprint) short.
  const script = join(dir, 'askpass.sh')
  writeFileSync(script, '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "$GDG_ASKPASS_EXE" "$GDG_ASKPASS_JS" "$@"\n', 'utf8')
  if (process.platform !== 'win32') chmodSync(script, 0o755)
  // Windows' own OpenSSH starts SSH_ASKPASS with CreateProcess, which runs no shell script: it
  // gets this .cmd instead (see windowsOpenSsh). Plain ASCII, paths from the environment; cmd
  // still cuts a prompt at its first line break, which classify() allows for.
  let cmd = join(dir, 'askpass.cmd')
  if (process.platform === 'win32') {
    writeFileSync(cmd, '@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%GDG_ASKPASS_EXE%" "%GDG_ASKPASS_JS%" %*\r\n', 'ascii')
    cmd = asciiPath(dir, 'askpass.cmd')
  }

  // A Unix socket path holds at most 104 bytes on macOS, and its temp folder (/var/folders/…)
  // with a UUID went past it: listen failed and every prompt with it. A short name in /tmp, only
  // the user may connect to; the secret below still has to come with each request.
  const pipe = process.platform === 'win32'
    ? `\\\\.\\pipe\\gaetandev-git-askpass-${randomUUID()}`
    : join('/tmp', `gdg-askpass-${randomBytes(6).toString('hex')}.sock`)
  const secret = randomBytes(32).toString('hex')
  const valid = (token: unknown) =>
    typeof token === 'string' && token.length === secret.length && timingSafeEqual(Buffer.from(token), Buffer.from(secret))

  server = createServer(sock => {
    let buf = ''
    let handled = false
    sock.on('data', async d => {
      if (handled) return
      buf += d.toString()
      if (!buf.includes('\n')) return
      // One request per connection: anything after the first line is ignored.
      handled = true
      let req: { prompt?: unknown; token?: unknown } = {}
      try { req = JSON.parse(buf.split('\n')[0]) } catch { /* malformed */ }
      if (!valid(req.token)) return void sock.end(JSON.stringify({ value: null }))
      const prompt = typeof req.prompt === 'string' ? req.prompt : ''
      const id = randomUUID()
      let answered = false
      // The helper gone before an answer (git killed, the operation cancelled): its dialog goes too,
      // instead of staying up for an answer nobody waits for.
      sock.on('close', () => { if (!answered) abandon(id) })
      const value = await ask({ id, prompt, kind: classify(prompt) }).catch(() => null)
      answered = true
      sock.end(JSON.stringify({ value }))
    })
    sock.on('error', () => undefined)
  })
  // Prompts then fail like a declined one; nothing else depends on the server.
  server.on('error', e => console.error('askpass server:', e.message))
  server.listen(pipe, () => {
    if (process.platform !== 'win32') try { chmodSync(pipe, 0o600) } catch { /* the secret still guards it */ }
  })

  env = {
    GIT_ASKPASS: script,
    SSH_ASKPASS: script,
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: process.env.DISPLAY ?? ':0',
    GDG_ASKPASS_PIPE: pipe,
    GDG_ASKPASS_TOKEN: secret,
    GDG_ASKPASS_EXE: process.execPath,
    GDG_ASKPASS_JS: client,
    ...(process.platform === 'win32' ? { GDG_ASKPASS_CMD: cmd } : {}),
  }
  return env
}

export function classify(prompt: string): AskPassRequest['kind'] {
  // A host key question cut after its first line (the .cmd helper) is still one.
  if (/\(yes\/no/i.test(prompt) || /^The authenticity of host .* can't be established\.?\s*$/i.test(prompt)) return 'confirm'
  if (/password|passphrase|token|PIN/i.test(prompt)) return 'password'
  return 'text'
}

export function registerPending(id: string, resolve: (value: string | null) => void): void {
  pending.set(id, resolve)
}

export function respond(id: string, value: string | null): void {
  pending.get(id)?.(value)
  pending.delete(id)
}

let abandoned: ((id: string) => void) | null = null
/** Called with a prompt whose helper went away before it was answered. */
export function onAbandon(fn: (id: string) => void): void {
  abandoned = fn
}

function abandon(id: string): void {
  if (!pending.has(id)) return
  respond(id, null)
  abandoned?.(id)
}

export function stopAskPass(): void {
  server?.close()
  server = null
  env = null
  for (const resolve of pending.values()) resolve(null)
  pending.clear()
}
