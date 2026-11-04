import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProviderInfo, ProviderKind, ProviderLink } from '@shared/types'

interface ParsedUrl {
  host: string
  /** Path without leading slash and without trailing `.git`. */
  path: string
  /** The web page's scheme: http only for an http remote. */
  scheme: 'https' | 'http'
  /** Reached over SSH (ssh:// or scp-like), whose port is never the web server's. */
  ssh: boolean
  /** The SSH port, when the URL names one. */
  port?: string
}

/**
 * Parses https://, ssh:// and scp-like (`git@host:owner/repo`) remote URLs.
 * Local paths (`C:\repos\x.git`, `/srv/x.git`) have no web page. An https
 * URL keeps its port (a self-hosted server on :8443); an ssh port is not the
 * web server's, so it is dropped.
 */
export function parseRemoteUrl(url: string): ParsedUrl | null {
  if (/^[a-z]:[\\/]/i.test(url) || url.startsWith('/') || url.startsWith('\\\\')) return null
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(url)
  // Azure DevOps writes a space in a project name as %20 in its SSH URLs too.
  if (scp && !/^[a-z]+:\/\//i.test(url)) return { host: scp[1].toLowerCase(), path: clean(decoded(scp[2])), scheme: 'https', ssh: true }
  try {
    const u = new URL(url)
    if (!u.hostname) return null
    const web = /^https?:$/.test(u.protocol)
    return {
      host: (web ? u.host : u.hostname).toLowerCase(),
      path: clean(decoded(u.pathname)),
      scheme: u.protocol === 'http:' ? 'http' : 'https',
      ssh: !web,
      port: web ? undefined : u.port || undefined,
    }
  } catch {
    return null
  }
}

/** Percent-decoded, or as is when it holds a "%" that is no escape. */
function decoded(path: string): string {
  try { return decodeURIComponent(path) } catch { return path }
}

function clean(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '')
}

/** Each path segment URL-encoded: an Azure project named "My Project" needs %20. */
const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/')

let sshConfig: { at: number; hosts: Map<string, string> } | null = null

/**
 * The real host behind an SSH alias of ~/.ssh/config (`Host github-work` with
 * `HostName github.com`), read again at most every 30 seconds. Exact aliases
 * only: a wildcard pattern names no single host.
 */
export function sshHostName(alias: string, configText?: string): string {
  if (configText === undefined && (!sshConfig || Date.now() - sshConfig.at > 30_000)) {
    let text = ''
    try { text = readFileSync(join(homedir(), '.ssh', 'config'), 'utf8') } catch { /* no config */ }
    sshConfig = { at: Date.now(), hosts: parseSshConfig(text) }
  }
  const hosts = configText === undefined ? sshConfig!.hosts : parseSshConfig(configText)
  return hosts.get(alias.toLowerCase()) ?? alias
}

function parseSshConfig(text: string): Map<string, string> {
  const hosts = new Map<string, string>()
  let current: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(\w+)\s*(?:=\s*|\s+)(.+?)\s*$/.exec(raw)
    if (!m) continue
    const key = m[1].toLowerCase()
    if (key === 'host' || key === 'match') current = key === 'host' ? m[2].split(/\s+/).filter(h => !/[*?!]/.test(h)).map(h => h.toLowerCase()) : []
    else if (key === 'hostname') for (const h of current) if (!hosts.has(h)) hosts.set(h, m[2].toLowerCase())
  }
  return hosts
}

/** Hosts that only serve git over SSH, and the web host behind them. */
const SSH_HOSTS: Record<string, string> = { 'ssh.github.com': 'github.com', 'altssh.gitlab.com': 'gitlab.com', 'altssh.bitbucket.org': 'bitbucket.org' }

const LABELS: Record<ProviderKind, string> = {
  github: 'GitHub', gitlab: 'GitLab', azure: 'Azure DevOps', bitbucket: 'Bitbucket', 'bitbucket-server': 'Bitbucket', gitea: 'Gitea', generic: 'Remote',
}

export function detectProvider(url: string): ProviderInfo | null {
  const p = parseRemoteUrl(url)
  if (!p) return null
  let host = p.host
  if (p.ssh) host = sshHostName(host)
  host = SSH_HOSTS[host] ?? host
  const { path } = p
  let kind: ProviderKind = 'generic'
  let web = `${p.scheme}://${host}/${enc(path)}`

  if (host === 'github.com' || host.endsWith('.ghe.com') || host.startsWith('github.')) kind = 'github'
  else if (host.includes('gitlab')) kind = 'gitlab'
  else if (host === 'bitbucket.org') kind = 'bitbucket'
  else if (host === 'dev.azure.com' || host === 'ssh.dev.azure.com' || host.endsWith('.visualstudio.com') || /(^|\/)_git\//.test(path)) {
    // Azure DevOps Services, and Azure DevOps Server (TFS) on premises: every repository path has /_git/.
    kind = 'azure'
    web = azureWeb(host, path, p.scheme) ?? web
  } else if (host.includes('bitbucket') || path.startsWith('scm/') || p.port === '7999') {
    // Bitbucket Server / Data Center: https://host/scm/PROJECT/repo, or ssh on port 7999.
    kind = 'bitbucket-server'
    const [project, repo] = path.replace(/^scm\//, '').split('/')
    web = `${p.scheme}://${host}/projects/${encodeURIComponent(project.toUpperCase())}/repos/${encodeURIComponent(repo ?? '')}`
  } else if (host === 'codeberg.org' || host.includes('gitea') || host.includes('forgejo')) kind = 'gitea'

  return { kind, label: kind === 'gitea' && host === 'codeberg.org' ? 'Codeberg' : LABELS[kind], host, web }
}

/**
 * Azure DevOps URL shapes:
 *  https://dev.azure.com/{org}/{project}/_git/{repo}
 *  git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
 *  https://{org}.visualstudio.com/{project}/_git/{repo}
 *  {org}@vs-ssh.visualstudio.com:v3/{org}/{project}/{repo}
 *  https://server/tfs/{collection}/{project}/_git/{repo} (Azure DevOps Server)
 */
function azureWeb(host: string, path: string, scheme: string): string | null {
  const seg = path.split('/')
  if ((host === 'ssh.dev.azure.com' || host === 'vs-ssh.visualstudio.com') && seg[0] === 'v3' && seg.length >= 4) {
    return `https://dev.azure.com/${enc(seg[1])}/${enc(seg[2])}/_git/${enc(seg[3])}`
  }
  if (host === 'dev.azure.com') return `https://dev.azure.com/${enc(path)}`
  if (host.endsWith('.visualstudio.com')) return `https://${host}/${enc(path.replace(/^DefaultCollection\//, ''))}`
  if (/(^|\/)_git\//.test(path)) return `${scheme}://${host}/${enc(path)}`
  return null
}

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
    case 'bitbucket-server':
      switch (link.type) {
        case 'repo': return `${w}/browse`
        case 'commit': return `${w}/commits/${link.sha}`
        case 'branch': return `${w}/browse?${new URLSearchParams({ at: `refs/heads/${link.branch}` })}`
        case 'pr': {
          const q = new URLSearchParams({ create: '', sourceBranch: `refs/heads/${link.branch}` })
          if (link.base) q.set('targetBranch', `refs/heads/${link.base}`)
          return `${w}/pull-requests?${q}`
        }
        case 'file': return `${w}/browse/${enc(link.path)}?${new URLSearchParams({ at: link.ref })}`
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
