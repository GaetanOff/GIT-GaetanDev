import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const made: string[] = []

/** A new repository in a temporary folder, with a local identity and no line-ending conversion. */
export function makeRepo(name = 'repo'): string {
  const root = mkdtempSync(join(tmpdir(), 'gdg-test-'))
  made.push(root)
  const repo = join(root, name)
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false'], ['commit.gpgsign', 'false']]) {
    execFileSync('git', ['-C', repo, 'config', k, v])
  }
  return repo
}

/** Runs git in a repository and returns its trimmed output. */
export function sh(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' } }).trim()
}

export function write(repo: string, path: string, content: string): void {
  writeFileSync(join(repo, path), content)
}

/** Writes files and commits them. */
export function commit(repo: string, message: string, files: Record<string, string> = {}): void {
  for (const [path, content] of Object.entries(files)) write(repo, path, content)
  sh(repo, 'add', '-A')
  sh(repo, 'commit', '-q', '--allow-empty', '-m', message)
}

export function cleanup(): void {
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true })
}
