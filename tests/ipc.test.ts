import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, BrowserWindow: {}, clipboard: {}, dialog: {}, ipcMain: {}, shell: {} }))
vi.mock('../src/main/store', () => ({ isRegistered: () => true, getState: () => ({ settings: {} }) }))
vi.mock('../src/main/updater', () => ({ installUpdate: () => undefined }))

const { checkArgs, queuesBusy, schedule, settleQueues } = await import('../src/main/ipc')

const REPO = 'C:/repos/app'

describe('argument checks', () => {
  it('refuses a diff revision that git would read as an option', () => {
    expect(() => checkArgs('git:diff', [REPO, { kind: 'range', from: '--output=C:/x', to: 'HEAD', path: 'a.txt' }, {}])).toThrow(/not a valid/)
    expect(() => checkArgs('git:diff', [REPO, { kind: 'commit', sha: '-p', path: 'a.txt' }, {}])).toThrow(/not a valid/)
    expect(() => checkArgs('git:diff', [REPO, { kind: 'range', from: 'main', to: 'HEAD', path: 'a.txt' }, {}])).not.toThrow()
  })

  it('refuses file paths outside the repository', () => {
    const win = process.platform === 'win32'
    for (const path of ['../outside.txt', 'src/../../outside.txt', '..\\outside.txt', '/etc/passwd', '.git/hooks/pre-commit', '.GIT\\config', 'vendor/lib/.git/hooks/post-checkout', ...(win ? ['C:\\Windows\\win.ini', 'C:x.txt'] : [])]) {
      expect(() => checkArgs('git:resolveContent', [REPO, path, 'text']), path).toThrow(/inside the repository/)
    }
    // A file a commit made on Linux or macOS can hold.
    if (!win) expect(() => checkArgs('git:diff', [REPO, { kind: 'commit', sha: 'HEAD', path: 'c:notes.md' }, {}])).not.toThrow()
    expect(() => checkArgs('git:stage', [REPO, ['ok.txt', '../outside.txt']])).toThrow(/inside the repository/)
    expect(() => checkArgs('git:diff', [REPO, { kind: 'worktree', path: '../x', untracked: true }, {}])).toThrow(/inside the repository/)
    expect(() => checkArgs('git:conflict', [REPO, 'src/a b/[1].txt'])).not.toThrow()
    expect(() => checkArgs('shell:reveal', [process.cwd()])).not.toThrow()
  })
})

describe('scheduling', () => {
  const tick = () => new Promise(resolve => setTimeout(resolve, 20))

  it('runs network commands of a repository one at a time, without holding up writes', async () => {
    const order: string[] = []
    let release!: () => void
    const fetch = schedule('git:fetch', REPO, () => new Promise<void>(resolve => {
      order.push('fetch')
      release = () => { order.push('fetch done'); resolve() }
    }))
    const pull = schedule('git:pull', 'c:\\repos\\APP', async () => { order.push('pull') })
    const stage = schedule('git:stage', REPO, async () => { order.push('stage') })
    await tick()
    expect(order).toEqual(['fetch', 'stage'])
    release()
    await Promise.all([fetch, pull, stage])
    expect(order).toEqual(['fetch', 'stage', 'fetch done', 'pull'])
  })

  it('makes removing a remote wait for a fetch in progress', async () => {
    const order: string[] = []
    let release!: () => void
    const fetch = schedule('git:fetch', REPO, () => new Promise<void>(resolve => {
      order.push('fetch')
      release = () => { order.push('fetch done'); resolve() }
    }))
    const remove = schedule('git:removeRemote', REPO, async () => { order.push('remove') })
    await tick()
    expect(order).toEqual(['fetch'])
    release()
    await Promise.all([fetch, remove])
    expect(order).toEqual(['fetch', 'fetch done', 'remove'])
  })

  it('lets quitting wait for running git work, up to a limit', async () => {
    let done = false
    const commit = schedule('git:commit', REPO, () => new Promise<void>(resolve => setTimeout(() => { done = true; resolve() }, 60)))
    expect(queuesBusy()).toBe(true)
    await settleQueues(5_000)
    expect(done).toBe(true)
    await commit
    await tick()
    expect(queuesBusy()).toBe(false)
    // A repository of its own: this fetch never settles.
    const stuck = schedule('git:fetch', 'C:/repos/stuck', () => new Promise<void>(() => undefined))
    const started = Date.now()
    await settleQueues(50)
    expect(Date.now() - started).toBeLessThan(1_000)
    void stuck
  })

  it('makes a pull wait for writes in progress', async () => {
    const order: string[] = []
    let release!: () => void
    const commit = schedule('git:commit', REPO, () => new Promise<void>(resolve => {
      order.push('commit')
      release = () => { order.push('commit done'); resolve() }
    }))
    const pull = schedule('git:pull', REPO, async () => { order.push('pull') })
    const push = schedule('git:push', 'C:/repos/other', async () => { order.push('push elsewhere') })
    await tick()
    expect(order).toEqual(['commit', 'push elsewhere'])
    release()
    await Promise.all([commit, pull, push])
    expect(order).toEqual(['commit', 'push elsewhere', 'commit done', 'pull'])
  })
})
