import type { Branch, Refs, Remote, Stash, Tag } from '@shared/types'
import { detectProvider } from '../provider'
import { lfs, submodules, worktrees } from './modules'
import { git, gitOut } from './exec'

const US = '\x1f'

export async function refs(repo: string): Promise<Refs> {
  const [branches, tags, remotes, stashes] = await Promise.all([listBranches(repo), listTags(repo), listRemotes(repo), listStashes(repo)])
  return { branches, tags, remotes, stashes, submodules: [], worktrees: [], lfs: { used: false, installed: true } }
}

/** The slower extras, loaded after the refs so branches never wait for them. */
export async function extras(repo: string): Promise<Pick<Refs, 'submodules' | 'worktrees' | 'lfs'>> {
  const [subs, trees, lfsInfo] = await Promise.all([submodules(repo).catch(() => []), worktrees(repo).catch(() => []), lfs(repo)])
  return { submodules: subs, worktrees: trees, lfs: lfsInfo }
}

async function listBranches(repo: string): Promise<Branch[]> {
  const fmt = ['%(refname)', '%(objectname)', '%(upstream:lstrip=2)', '%(upstream:track,nobracket)', '%(committerdate:unix)', '%(HEAD)', '%(contents:subject)'].join(US)
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
  const fmt = ['%(refname:lstrip=2)', '%(*objectname)', '%(objectname)', '%(creatordate:unix)', '%(contents:subject)'].join(US)
  const out = await gitOut(repo, ['for-each-ref', `--format=${fmt}`, '--sort=-creatordate', 'refs/tags'])
  return out.split('\n').filter(Boolean).map(line => {
    const [name, peeled, sha, date, subject] = line.split(US)
    return { name, sha: peeled || sha, date: +date, subject }
  })
}

/**
 * One "git remote get-url" per remote rather than parsing "git remote -v",
 * whose columns are split by spaces: a local remote like "C:/My Repos/x.git"
 * has spaces too. get-url also applies url.<base>.insteadOf, as -v does.
 */
async function listRemotes(repo: string): Promise<Remote[]> {
  const names = (await gitOut(repo, ['remote'])).split('\n').map(s => s.trim()).filter(Boolean)
  const url = (name: string, push: boolean) =>
    git(repo, ['remote', 'get-url', ...(push ? ['--push'] : []), name], { okCodes: [2, 128] }).then(r => (r.code === 0 ? r.stdout.split('\n')[0].trim() : ''))
  return Promise.all(names.map(async name => {
    const [fetchUrl, pushUrl] = await Promise.all([url(name, false), url(name, true)])
    return { name, fetchUrl, pushUrl: pushUrl || fetchUrl, provider: fetchUrl ? detectProvider(fetchUrl) : null }
  }))
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

/**
 * Ref names come in full and lose only their prefix. Git's short form
 * (`--short`, `:short`, `--abbrev-ref`) keeps more when a name is
 * ambiguous: with a branch and a tag "release", HEAD's branch reads
 * "heads/release", and pushing it published refs/heads/heads/release.
 */
const strip = (ref: string) => ref.replace(/^refs\/(?:heads|remotes|tags)\//, '')

export async function currentBranch(repo: string): Promise<string | null> {
  const r = await git(repo, ['symbolic-ref', '--quiet', 'HEAD'], { okCodes: [1, 128] })
  return r.code === 0 ? strip(r.stdout.trim()) : null
}

/** The branch's upstream, read from the branch's own ref: "x@{upstream}" takes no full ref name. */
export async function upstreamOf(repo: string, branch: string): Promise<string | null> {
  const out = (await gitOut(repo, ['for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`])).trim()
  return out ? strip(out) : null
}

export async function defaultRemote(repo: string): Promise<string | null> {
  const remotes = (await gitOut(repo, ['remote'])).split('\n').filter(Boolean)
  return remotes.includes('origin') ? 'origin' : remotes[0] ?? null
}

/** The branch PRs usually target: the remote's HEAD, else main/master. */
export async function defaultBranch(repo: string, remote: string): Promise<string> {
  const r = await git(repo, ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`], { okCodes: [1, 128] })
  if (r.code === 0) return r.stdout.trim().replace(`refs/remotes/${remote}/`, '')
  for (const name of ['main', 'master', 'develop']) {
    const c = await git(repo, ['rev-parse', '--verify', '-q', `refs/remotes/${remote}/${name}`], { okCodes: [1] })
    if (c.code === 0) return name
  }
  return 'main'
}
