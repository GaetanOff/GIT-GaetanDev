import type { ProviderInfo, ProviderKind, ProviderLink } from '@shared/types'

interface ParsedUrl {
  host: string
  /** Path without leading slash and without trailing `.git`. */
  path: string
}

/** Parses https://, ssh:// and scp-like (`git@host:owner/repo`) remote URLs. */
export function parseRemoteUrl(url: string): ParsedUrl | null {
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(url)
  if (scp && !/^[a-z]+:\/\//i.test(url)) return { host: scp[1].toLowerCase(), path: clean(scp[2]) }
  try {
    const u = new URL(url)
    if (!u.hostname) return null
    return { host: u.hostname.toLowerCase(), path: clean(decodeURIComponent(u.pathname)) }
  } catch {
    return null
  }
}

function clean(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '')
}

const LABELS: Record<ProviderKind, string> = {
  github: 'GitHub', gitlab: 'GitLab', azure: 'Azure DevOps', bitbucket: 'Bitbucket', gitea: 'Gitea', generic: 'Remote',
}

export function detectProvider(url: string): ProviderInfo | null {
  const p = parseRemoteUrl(url)
  if (!p) return null
  const { host, path } = p
  let kind: ProviderKind = 'generic'
  let web = `https://${host}/${path}`

  if (host === 'github.com' || host.endsWith('.ghe.com') || host.startsWith('github.')) kind = 'github'
  else if (host.includes('gitlab')) kind = 'gitlab'
  else if (host === 'bitbucket.org' || host.includes('bitbucket')) kind = 'bitbucket'
  else if (host === 'codeberg.org' || host.includes('gitea') || host.includes('forgejo')) kind = 'gitea'
  else if (host === 'dev.azure.com' || host === 'ssh.dev.azure.com' || host.endsWith('.visualstudio.com')) {
    kind = 'azure'
    web = azureWeb(host, path) ?? web
  }

  return { kind, label: kind === 'gitea' && host === 'codeberg.org' ? 'Codeberg' : LABELS[kind], host, web }
}

/**
 * Azure DevOps URL shapes:
 *  https://dev.azure.com/{org}/{project}/_git/{repo}
 *  git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
 *  https://{org}.visualstudio.com/{project}/_git/{repo}
 */
function azureWeb(host: string, path: string): string | null {
  const seg = path.split('/')
  if (host === 'ssh.dev.azure.com' && seg[0] === 'v3' && seg.length >= 4) {
    return `https://dev.azure.com/${seg[1]}/${seg[2]}/_git/${seg[3]}`
  }
  if (host === 'dev.azure.com') return `https://dev.azure.com/${path}`
  if (host.endsWith('.visualstudio.com')) return `https://${host}/${path.replace(/^DefaultCollection\//, '')}`
  return null
}

const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/')

export function providerUrl(info: ProviderInfo, link: ProviderLink): string {
  const w = info.web
  switch (info.kind) {
    case 'github':
      switch (link.type) {
        case 'repo': return w
        case 'commit': return `${w}/commit/${link.sha}`
        case 'branch': return `${w}/tree/${enc(link.branch)}`
        case 'pr': return link.base ? `${w}/compare/${enc(link.base)}...${enc(link.branch)}?expand=1` : `${w}/pull/new/${enc(link.branch)}`
        case 'file': return `${w}/blob/${enc(link.ref)}/${enc(link.path)}`
      }
      break
    case 'gitlab':
      switch (link.type) {
        case 'repo': return w
        case 'commit': return `${w}/-/commit/${link.sha}`
        case 'branch': return `${w}/-/tree/${enc(link.branch)}`
        case 'pr': {
          const q = new URLSearchParams({ 'merge_request[source_branch]': link.branch })
          if (link.base) q.set('merge_request[target_branch]', link.base)
          return `${w}/-/merge_requests/new?${q}`
        }
        case 'file': return `${w}/-/blob/${enc(link.ref)}/${enc(link.path)}`
      }
      break
    case 'azure':
      switch (link.type) {
        case 'repo': return w
        case 'commit': return `${w}/commit/${link.sha}`
        case 'branch': return `${w}?version=GB${encodeURIComponent(link.branch)}`
        case 'pr': {
          const q = new URLSearchParams({ sourceRef: link.branch })
          if (link.base) q.set('targetRef', link.base)
          return `${w}/pullrequestcreate?${q}`
        }
        case 'file': return `${w}?path=/${encodeURIComponent(link.path)}&version=GC${link.ref}`
      }
      break
    case 'bitbucket':
      switch (link.type) {
        case 'repo': return w
        case 'commit': return `${w}/commits/${link.sha}`
        case 'branch': return `${w}/branch/${enc(link.branch)}`
        case 'pr': {
          const q = new URLSearchParams({ source: link.branch })
          if (link.base) q.set('dest', link.base)
          return `${w}/pull-requests/new?${q}`
        }
        case 'file': return `${w}/src/${enc(link.ref)}/${enc(link.path)}`
      }
      break
    case 'gitea':
    case 'generic':
      switch (link.type) {
        case 'repo': return w
        case 'commit': return `${w}/commit/${link.sha}`
        case 'branch': return `${w}/src/branch/${enc(link.branch)}`
        case 'pr': return `${w}/compare/${enc(link.base ?? 'main')}...${enc(link.branch)}`
        case 'file': return `${w}/src/commit/${link.ref}/${enc(link.path)}`
      }
  }
  return w
}
