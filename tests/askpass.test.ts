import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const dir = mkdtempSync(join(tmpdir(), 'gdg-askpass-'))
vi.mock('electron', () => ({ app: { getPath: () => dir } }))
const { startAskPass, stopAskPass } = await import('../src/main/askpass')

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
})
