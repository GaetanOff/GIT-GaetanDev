import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const dir = mkdtempSync(join(tmpdir(), 'gdg-askpass-'))
vi.mock('electron', () => ({ app: { getPath: () => dir } }))
const { onAbandon, registerPending, startAskPass, stopAskPass } = await import('../src/main/askpass')

afterAll(() => {
  stopAskPass()
  rmSync(dir, { recursive: true, force: true })
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
