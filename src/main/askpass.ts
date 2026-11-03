import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { writeFileSync, chmodSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import type { AskPassRequest } from '@shared/types'

/**
 * Credential prompts from git and ssh (passwords, passphrases, host keys) are
 * routed into the app: GIT_ASKPASS/SSH_ASKPASS point at a tiny script that
 * runs this executable as Node and asks the main process over a named pipe.
 * HTTPS credentials for GitHub, GitLab, Azure DevOps and Bitbucket are usually
 * handled first by Git Credential Manager, which has its own sign-in window.
 */
const CLIENT = `
const net = require('net')
const prompt = process.argv.slice(2).join(' ')
const sock = net.connect(process.env.GDG_ASKPASS_PIPE, () => sock.write(JSON.stringify({ prompt }) + '\\n'))
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
const pending = new Map<string, (value: string | null) => void>()

export function startAskPass(ask: Ask): NodeJS.ProcessEnv {
  const dir = app.getPath('userData')
  const client = join(dir, 'askpass.js')
  writeFileSync(client, CLIENT, 'utf8')

  let script: string
  if (process.platform === 'win32') {
    script = join(dir, 'askpass.cmd')
    writeFileSync(script, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${client}" %*\r\n`, 'utf8')
  } else {
    script = join(dir, 'askpass.sh')
    writeFileSync(script, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${client}" "$@"\n`, 'utf8')
    chmodSync(script, 0o755)
  }

  const pipe = process.platform === 'win32'
    ? `\\\\.\\pipe\\gaetandev-git-askpass-${process.pid}`
    : join(app.getPath('temp'), `gaetandev-git-askpass-${process.pid}.sock`)

  server = createServer(sock => {
    let buf = ''
    sock.on('data', async d => {
      buf += d.toString()
      if (!buf.includes('\n')) return
      let prompt = ''
      try { prompt = JSON.parse(buf.split('\n')[0]).prompt ?? '' } catch { /* malformed */ }
      const value = await ask({ id: randomUUID(), prompt, kind: classify(prompt) }).catch(() => null)
      sock.end(JSON.stringify({ value }))
    })
    sock.on('error', () => undefined)
  })
  server.listen(pipe)

  return {
    GIT_ASKPASS: script,
    SSH_ASKPASS: script,
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: process.env.DISPLAY ?? ':0',
    GDG_ASKPASS_PIPE: pipe,
  }
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
  for (const resolve of pending.values()) resolve(null)
  pending.clear()
}
