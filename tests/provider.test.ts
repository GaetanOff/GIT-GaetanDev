import { describe, expect, it } from 'vitest'
import { detectProvider, parseRemoteUrl, providerUrl, sshHostName } from '../src/main/provider'

describe('parseRemoteUrl', () => {
  it('reads scp-like URLs', () => {
    expect(parseRemoteUrl('git@github.com:owner/repo.git')).toMatchObject({ host: 'github.com', path: 'owner/repo', ssh: true })
  })

  it('keeps an https port and drops an ssh one', () => {
    expect(parseRemoteUrl('https://git.example.com:8443/team/repo.git')?.host).toBe('git.example.com:8443')
    expect(parseRemoteUrl('ssh://git@git.example.com:2222/team/repo.git')?.host).toBe('git.example.com')
  })

  it('has no web page for local paths', () => {
    expect(parseRemoteUrl('C:\\repos\\x.git')).toBeNull()
    expect(parseRemoteUrl('C:/My Repos/x.git')).toBeNull()
    expect(parseRemoteUrl('/srv/git/x.git')).toBeNull()
    expect(parseRemoteUrl('\\\\server\\share\\x.git')).toBeNull()
  })
})

describe('detectProvider', () => {
  it('recognises GitHub and builds its web link', () => {
    const p = detectProvider('git@github.com:owner/proj.git')
    expect(p?.kind).toBe('github')
    expect(p?.web).toBe('https://github.com/owner/proj')
  })

  it('treats an unknown host as generic', () => {
    expect(detectProvider('https://git.example.com:8443/team/repo.git')?.kind).toBe('generic')
  })

  it('maps SSH-only hosts to their web host', () => {
    expect(detectProvider('ssh://git@ssh.github.com:443/owner/proj.git')).toMatchObject({ kind: 'github', web: 'https://github.com/owner/proj' })
    expect(detectProvider('git@altssh.gitlab.com:group/sub/proj.git')).toMatchObject({ kind: 'gitlab', web: 'https://gitlab.com/group/sub/proj' })
  })

  it('keeps http for an http remote', () => {
    expect(detectProvider('http://git.lan/team/repo.git')?.web).toBe('http://git.lan/team/repo')
  })

  it('reads every Azure DevOps shape, and encodes project names with spaces', () => {
    const web = 'https://dev.azure.com/org/My%20Project/_git/repo'
    expect(detectProvider('https://org@dev.azure.com/org/My%20Project/_git/repo')?.web).toBe(web)
    expect(detectProvider('git@ssh.dev.azure.com:v3/org/My%20Project/repo')?.web).toBe(web)
    expect(detectProvider('org@vs-ssh.visualstudio.com:v3/org/My%20Project/repo')?.web).toBe(web)
    expect(detectProvider('https://org.visualstudio.com/DefaultCollection/proj/_git/repo')?.web).toBe('https://org.visualstudio.com/proj/_git/repo')
    // Azure DevOps Server on premises.
    const tfs = detectProvider('https://tfs.corp.local/tfs/Collection/Proj/_git/Repo')
    expect(tfs).toMatchObject({ kind: 'azure', web: 'https://tfs.corp.local/tfs/Collection/Proj/_git/Repo' })
    expect(providerUrl(tfs!, { type: 'branch', branch: 'main' })).toBe('https://tfs.corp.local/tfs/Collection/Proj/_git/Repo?version=GBmain')
  })

  it('tells Bitbucket Server from Bitbucket Cloud', () => {
    const https = detectProvider('https://git.corp.local/scm/proj/repo.git')
    expect(https).toMatchObject({ kind: 'bitbucket-server', web: 'https://git.corp.local/projects/PROJ/repos/repo' })
    expect(detectProvider('ssh://git@bitbucket.corp.local:7999/proj/repo.git')?.web).toBe('https://bitbucket.corp.local/projects/PROJ/repos/repo')
    expect(providerUrl(https!, { type: 'commit', sha: 'abc' })).toBe('https://git.corp.local/projects/PROJ/repos/repo/commits/abc')
    expect(providerUrl(https!, { type: 'pr', branch: 'feat/x', base: 'main' }))
      .toBe('https://git.corp.local/projects/PROJ/repos/repo/pull-requests?create=&sourceBranch=refs%2Fheads%2Ffeat%2Fx&targetBranch=refs%2Fheads%2Fmain')
    expect(detectProvider('git@bitbucket.org:team/repo.git')?.kind).toBe('bitbucket')
  })
})

describe('sshHostName', () => {
  const config = 'Host github-work\n  HostName github.com\n  User git\nHost *.corp\n  HostName ignored\nHost gl gl-alt\n  HostName = gitlab.example.com\n'

  it('follows an exact alias of ~/.ssh/config to its host', () => {
    expect(sshHostName('github-work', config)).toBe('github.com')
    expect(sshHostName('GL-ALT', config)).toBe('gitlab.example.com')
  })

  it('leaves wildcard patterns and unknown hosts alone', () => {
    expect(sshHostName('x.corp', config)).toBe('x.corp')
    expect(sshHostName('example.org', config)).toBe('example.org')
  })
})
