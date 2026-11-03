import type { CompareResult } from '@shared/types'
import { git, gitOut, GitError } from './exec'
import { changedFiles, LOG_FORMAT, parseLog } from './log'

async function resolve(repo: string, rev: string): Promise<string> {
  const r = await git(repo, ['rev-parse', '--verify', '-q', `${rev}^{commit}`], { okCodes: [1, 128] })
  if (r.code !== 0) throw new GitError(`“${rev}” is not a branch, tag or commit.`)
  return r.stdout.trim()
}

/**
 * What `head` brings over `base`. Three-dot compares against their merge base
 * (what a pull request shows); two-dot compares the two tips directly.
 */
export async function compare(repo: string, base: string, head: string, threeDot: boolean): Promise<CompareResult> {
  const [baseSha, headSha] = await Promise.all([resolve(repo, base), resolve(repo, head)])
  const mb = await git(repo, ['merge-base', baseSha, headSha], { okCodes: [1] })
  const mergeBase = mb.code === 0 ? mb.stdout.trim() : null

  const [ahead, behind] = await Promise.all([
    gitOut(repo, ['log', `--format=${LOG_FORMAT}`, '--decorate=full', '-n500', `${baseSha}..${headSha}`]).then(parseLog),
    gitOut(repo, ['rev-list', '--count', `${headSha}..${baseSha}`]).then(s => +s.trim()),
  ])
  const from = threeDot && mergeBase ? mergeBase : baseSha
  const files = await changedFiles(repo, from, headSha)
  return { base, head, from, to: headSha, mergeBase, ahead, behind, files, threeDot }
}
