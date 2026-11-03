import { app } from 'electron'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, rmSync, writeFileSync } from 'node:fs'
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
  rmSync(join(dir, 'askpass.cmd'), { force: true }) // written by earlier versions

  const pipe = process.platform === 'win32'
    ? `\\\\.\\pipe\\gaetandev-git-askpass-${randomUUID()}`
    : join(app.getPath('temp'), `gaetandev-git-askpass-${randomUUID()}.sock`)
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
      const value = await ask({ id: randomUUID(), prompt, kind: classify(prompt) }).catch(() => null)
      sock.end(JSON.stringify({ value }))
    })
    sock.on('error', () => undefined)
  })
  // Prompts then fail like a declined one; nothing else depends on the server.
  server.on('error', e => console.error('askpass server:', e.message))
  server.listen(pipe)

  env = {
    GIT_ASKPASS: script,
    SSH_ASKPASS: script,
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: process.env.DISPLAY ?? ':0',
    GDG_ASKPASS_PIPE: pipe,
    GDG_ASKPASS_TOKEN: secret,
    GDG_ASKPASS_EXE: process.execPath,
    GDG_ASKPASS_JS: client,
  }
  return env
}

function classify(prompt: string): AskPassRequest['kind'] {
  if (/\(yes\/no/i.test(prompt)) return 'confirm'
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

export function stopAskPass(): void {
  server?.close()
  server = null
  env = null
  for (const resolve of pending.values()) resolve(null)
  pending.clear()
}
