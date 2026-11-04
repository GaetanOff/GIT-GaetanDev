import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Made when the tests run, not on import: filtered out, they left the folder behind.
let dir = ''
vi.mock('electron', () => ({ app: { getPath: () => dir, getAppPath: () => dir } }))
const { onAbandon, registerPending, startAskPass, stopAskPass } = await import('../src/main/askpass')

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'gdg-askpass-')) })
afterAll(() => {
  stopAskPass()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/** What a prompt helper gets back for one request on the pipe. */
function request(pipe: string, body: unknown): Promise<{ value: string | null }> {
  return new Promise((resolve, reject) => {
    const sock = connect(pipe, () => sock.write(`${JSON.stringify(body)}\n`))
    let buf = ''
    sock.on('data', d => { buf += d })
    sock.on('end', () => resolve(JSON.parse(buf)))
    sock.on('error', reject)
  })
}

describe('credential prompts', () => {
  it('answer only the git processes the app started, which hold its secret', async () => {
    const asked: string[] = []
    const env = startAskPass(async req => {
      asked.push(req.prompt)
      return 'hunter2'
    })
    const pipe = env.GDG_ASKPASS_PIPE!
    // Another local program: no token, or a wrong one of the right length.
    expect(await request(pipe, { prompt: 'Password for x:' })).toEqual({ value: null })
    expect(await request(pipe, { prompt: 'Password for x:', token: 'f'.repeat(env.GDG_ASKPASS_TOKEN!.length) })).toEqual({ value: null })
    expect(asked).toEqual([])
    expect(await request(pipe, { prompt: 'Password for x:', token: env.GDG_ASKPASS_TOKEN })).toEqual({ value: 'hunter2' })
    expect(asked).toEqual(['Password for x:'])
  })

  it('withdraws a prompt whose helper went away before it was answered', async () => {
    stopAskPass()
    const withdrawn: string[] = []
    onAbandon(id => withdrawn.push(id))
    let asked = ''
    const env = startAskPass(req => {
      asked = req.id
      // Waits for an answer that never comes, as a dialog would.
      return new Promise(resolve => registerPending(req.id, resolve))
    })
    const sock = connect(env.GDG_ASKPASS_PIPE!, () => sock.write(`${JSON.stringify({ prompt: 'Passphrase:', token: env.GDG_ASKPASS_TOKEN })}\n`))
    await vi.waitFor(() => expect(asked).not.toBe(''))
    sock.destroy()
    await vi.waitFor(() => expect(withdrawn).toEqual([asked]))
  })
})

describe('the prompt helper of Windows\' OpenSSH', () => {
  it('is no batch file, which cmd.exe would read prompt and all', () => {
    stopAskPass()
    // Written by an earlier version: removed, never used.
    writeFileSync(join(dir, 'askpass.cmd'), '@echo off\r\n')
    const env = startAskPass(async () => null)
    expect(existsSync(join(dir, 'askpass.cmd'))).toBe(false)
    expect(Object.values(env).some(v => /\.(cmd|bat)$/i.test(v ?? ''))).toBe(false)
  })

  it.runIf(process.platform === 'win32')('passes on a hostile prompt as text, and the answer back', async () => {
    stopAskPass()
    // Built where a checkout's app looks for it (see helperExe).
    const built = spawnSync(process.execPath, ['scripts/build-askpass.cjs', join(dir, 'out', 'askpass')], { encoding: 'utf8' })
    expect(built.status, built.stderr).toBe(0)
    let asked = ''
    const env = startAskPass(async req => {
      asked = req.prompt
      return 'hunter2 é'
    })
    expect(env.GDG_ASKPASS_HELPER_EXE).toMatch(/gdg-askpass\.exe$/)
    const marker = join(dir, 'pwned.txt')
    const prompt = `(git@evil.example) Code" & echo PWNED> "${marker}" & "`
    const child = spawn(env.GDG_ASKPASS_HELPER_EXE!, [prompt], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', d => { out += d })
    const code = await new Promise(resolve => child.on('exit', resolve))
    expect(code).toBe(0)
    expect(out).toBe('hunter2 é\n')
    expect(asked).toBe(prompt)
    expect(existsSync(marker)).toBe(false)
  })
})
