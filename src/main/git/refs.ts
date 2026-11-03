import type { Branch, Refs, Remote, Stash, Tag } from '@shared/types'
import { detectProvider } from '../provider'
import { git, gitOut } from './exec'

const US = '\x1f'

export async function refs(repo: string): Promise<Refs> {
  const [branches, tags, remotes, stashes] = await Promise.all([listBranches(repo), listTags(repo), listRemotes(repo), listStashes(repo)])
  return { branches, tags, remotes, stashes }
}

async function listBranches(repo: string): Promise<Branch[]> {
  const fmt = ['%(refname)', '%(objectname)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(committerdate:unix)', '%(HEAD)', '%(contents:subject)'].join(US)
  const out = await gitOut(repo, ['for-each-ref', `--format=${fmt}`, '--sort=-committerdate', 'refs/heads', 'refs/remotes'])
  const branches: Branch[] = []
  for (const line of out.split('\n')) {
    if (!line) continue
    const [ref, sha, upstream, track, date, head, subject] = line.split(US)
    if (ref.endsWith('/HEAD')) continue
    const remote = ref.startsWith('refs/remotes/')
    const short = ref.replace(/^refs\/(heads|remotes)\//, '')
    const ahead = /ahead (\d+)/.exec(track)
    const behind = /behind (\d+)/.exec(track)
    branches.push({
      name: short,
      fullRef: ref,
      remote,
      remoteName: remote ? short.split('/')[0] : undefined,
      sha,
      upstream: upstream || undefined,
      ahead: ahead ? +ahead[1] : 0,
      behind: behind ? +behind[1] : 0,
      gone: track === 'gone',
      current: head === '*',
      date: +date,
      subject,
    })
  }
  return branches
}

async function listTags(repo: string): Promise<Tag[]> {
  const fmt = ['%(refname:short)', '%(*objectname)', '%(objectname)', '%(creatordate:unix)', '%(contents:subject)'].join(US)
  const out = await gitOut(repo, ['for-each-ref', `--format=${fmt}`, '--sort=-creatordate', 'refs/tags'])
  return out.split('\n').filter(Boolean).map(line => {
    const [name, peeled, sha, date, subject] = line.split(US)
    return { name, sha: peeled || sha, date: +date, subject }
  })
}

async function listRemotes(repo: string): Promise<Remote[]> {
  const out = await gitOut(repo, ['remote', '-v'])
  const map = new Map<string, Remote>()
  for (const line of out.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim())
    if (!m) continue
    const r = map.get(m[1]) ?? { name: m[1], fetchUrl: '', pushUrl: '', provider: null }
    if (m[3] === 'fetch') { r.fetchUrl = m[2]; r.provider = detectProvider(m[2]) }
    else r.pushUrl = m[2]
    map.set(m[1], r)
  }
  return [...map.values()]
}

async function listStashes(repo: string): Promise<Stash[]> {
  const r = await git(repo, ['stash', 'list', `--format=%gd${US}%H${US}%at${US}%gs`], { okCodes: [1, 128] })
  return r.stdout.split('\n').filter(Boolean).map(line => {
    const [ref, sha, date, msg] = line.split(US)
    // "On main: message" / "WIP on main: abc123 subject"
    const m = /^(?:WIP on|On) ([^:]+): (.*)$/.exec(msg)
    return {
      index: +(/\{(\d+)\}/.exec(ref)?.[1] ?? 0),
      ref,
      sha,
      date: +date,
      branch: m?.[1] ?? '',
      message: m?.[2] ?? msg,
    }
  })
}

export async function currentBranch(repo: string): Promise<string | null> {
  const r = await git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { okCodes: [1, 128] })
  return r.code === 0 ? r.stdout.trim() : null
}

export async function upstreamOf(repo: string, branch: string): Promise<string | null> {
  const r = await git(repo, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { okCodes: [128] })
  return r.code === 0 ? r.stdout.trim() : null
}

export async function defaultRemote(repo: string): Promise<string | null> {
  const remotes = (await gitOut(repo, ['remote'])).split('\n').filter(Boolean)
  return remotes.includes('origin') ? 'origin' : remotes[0] ?? null
}

/** The branch PRs usually target: the remote's HEAD, else main/master. */
export async function defaultBranch(repo: string, remote: string): Promise<string> {
  const r = await git(repo, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`], { okCodes: [1, 128] })
  if (r.code === 0) return r.stdout.trim().replace(`${remote}/`, '')
  for (const name of ['main', 'master', 'develop']) {
    const c = await git(repo, ['rev-parse', '--verify', '-q', `refs/remotes/${remote}/${name}`], { okCodes: [1] })
    if (c.code === 0) return name
  }
  return 'main'
}
