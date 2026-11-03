import { describe, expect, it } from 'vitest'
import { detectProvider, parseRemoteUrl } from '../src/main/provider'

describe('parseRemoteUrl', () => {
  it('reads scp-like URLs', () => {
    expect(parseRemoteUrl('git@github.com:owner/repo.git')).toEqual({ host: 'github.com', path: 'owner/repo' })
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
})
