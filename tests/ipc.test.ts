import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { cleanup, commit, makeRepo, sh } from './helpers'

const showMessageBox = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({
  app: {}, BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }, clipboard: {}, dialog: { showMessageBox }, ipcMain: {}, shell: {},
}))
const registered = vi.hoisted(() => vi.fn((_path: string) => true))
vi.mock('../src/main/store', () => ({ isRegistered: registered, isInsideRegistered: () => false, foldPath: (p: string) => (process.platform === 'linux' ? p : p.toLowerCase()), getState: () => ({ settings: {} }) }))
vi.mock('../src/main/updater', () => ({ installUpdate: () => undefined }))

const { checkArgs, closeQueues, confirmDestination, queuesBusy, schedule, settleQueues } = await import('../src/main/ipc')

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

  it.runIf(process.platform === 'win32')('refuses the other names Windows gives the .git folder', () => {
    for (const path of ['.git::$INDEX_ALLOCATION/config', '.git:$I30:$INDEX_ALLOCATION/config', 'GIT~1/config', 'sub/git~2/hooks/x', '.git./config', '.git . /config', 'a.txt:stream']) {
      expect(() => checkArgs('git:resolveContent', [REPO, path, 'text']), path).toThrow(/inside the repository/)
    }
    expect(() => checkArgs('git:resolveContent', [REPO, 'docs/.github/git~notes.md', 'text'])).not.toThrow()
  })
})

describe('option words', () => {
  it('takes only the sides, modes and answers each channel offers', () => {
    expect(() => checkArgs('git:reset', [REPO, 'HEAD~1', 'merge'])).toThrow(/is not one of/)
    expect(() => checkArgs('git:resolve', [REPO, 'a.txt', 'base'])).toThrow(/is not one of/)
    expect(() => checkArgs('git:resolveWhole', [REPO, 'a.txt', 'disk'])).not.toThrow()
    expect(() => checkArgs('git:newerTips', [REPO, [{ name: '--output=x', sha: 'abcd' }]])).toThrow(/not a valid/)
    expect(() => checkArgs('git:remoteSearch', [REPO, [{ name: 'feat', sha: '--all' }]])).toThrow(/Invalid branches/)
    expect(() => checkArgs('repo:pin', ['id', 'yes'])).toThrow(/Invalid pin/)
    expect(() => checkArgs('askpass:respond', ['id', 42])).toThrow(/Invalid answer/)
    expect(() => checkArgs('askpass:respond', ['id', null])).not.toThrow()
  })
})

describe('folders opened elsewhere', () => {
  it('opens only repositories and their folders in Explorer, an editor or a terminal', () => {
    registered.mockImplementation(p => p === REPO)
    try {
      for (const folder of ['\\\\attacker\\share', '//attacker/share', process.cwd()]) {
        expect(() => checkArgs('shell:terminal', [folder]), folder).toThrow(/not one of your repositories/)
      }
    } finally {
      registered.mockImplementation(() => true)
    }
  })
})

describe('destinations', () => {
  it('creates a repository only where the user chose or agreed to', async () => {
    const home = process.platform === 'win32' ? 'C:\\Users\\me' : '/home/me'
    const sep = process.platform === 'win32' ? '\\' : '/'
    showMessageBox.mockResolvedValueOnce({ response: 1 })
    await expect(confirmDestination(`${home}${sep}.config${sep}git`, 'Create?', 'Create', `${home}${sep}.config${sep}git`)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    // Agreed once for a folder: what goes inside it later asks nothing more.
    showMessageBox.mockResolvedValueOnce({ response: 0 })
    await confirmDestination(`${home}${sep}repos${sep}a`, 'Clone?', 'Clone', `${home}${sep}repos`)
    await confirmDestination(`${home}${sep}repos${sep}b`, 'Clone?', 'Clone', `${home}${sep}repos`)
    expect(showMessageBox).toHaveBeenCalledTimes(2)
    showMessageBox.mockResolvedValueOnce({ response: 1 })
    await expect(confirmDestination(`${home}${sep}repos-evil${sep}c`, 'Clone?', 'Clone', `${home}${sep}repos-evil`)).rejects.toThrow(/Cancelled/)
  })
})

describe('settings checks', () => {
  it('takes only values a setting may hold', () => {
    for (const patch of [{ diffContext: 2.5 }, { autoFetchMinutes: -1 }, { pullMode: 'octopus' }, { sidebarWidth: Infinity }, { editorCommand: null }]) {
      expect(() => checkArgs('app:settings', [patch]), JSON.stringify(patch)).toThrow(/not a valid value/)
    }
    expect(() => checkArgs('app:settings', [JSON.parse('{"__proto__": {"x": 1}}')])).toThrow(/Unknown setting/)
    expect(() => checkArgs('app:settings', [{ diffContext: 5, pullMode: 'rebase', autoFetchMinutes: 0, listWidth: 360 }])).not.toThrow()
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
    // The same repository written another way, where the file system ignores case.
    const pull = schedule('git:pull', process.platform === 'linux' ? REPO : 'c:\\repos\\APP', async () => { order.push('pull') })
    const stage = schedule('git:stage', REPO, async () => { order.push('stage') })
    await tick()
    expect(order).toEqual(['fetch', 'stage'])
    release()
    await Promise.all([fetch, pull, stage])
    expect(order).toEqual(['fetch', 'stage', 'fetch done', 'pull'])
  })

  it('runs network commands of linked worktrees one at a time, as they share refs', async () => {
    const repo = makeRepo()
    commit(repo, 'base')
    const wt = join(repo, '..', 'wt')
    sh(repo, 'worktree', 'add', '-q', wt)
    const order: string[] = []
    let release!: () => void
    const fetch = schedule('git:fetch', repo, () => new Promise<void>(resolve => {
      order.push('fetch')
      release = () => { order.push('fetch done'); resolve() }
    }))
    const pull = schedule('git:pull', wt, async () => { order.push('pull in worktree') })
    await tick()
    expect(order).toEqual(['fetch'])
    release()
    await Promise.all([fetch, pull])
    expect(order).toEqual(['fetch', 'fetch done', 'pull in worktree'])
    cleanup()
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

  // Last: once closing, the queues stay closed for the rest of this file.
  it('starts no write or network command once the app is closing', async () => {
    closeQueues()
    await expect(schedule('git:fetch', 'C:/repos/closing', async () => 'ran')).rejects.toThrow(/closing/)
    await expect(schedule('git:commit', 'C:/repos/closing', async () => 'ran')).rejects.toThrow(/closing/)
    // Reads still answer the page while it closes.
    await expect(schedule('git:status', 'C:/repos/closing', async () => 'ran')).resolves.toBe('ran')
  })
})
