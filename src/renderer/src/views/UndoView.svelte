<script lang="ts">
  import Icon from '@/components/Icon.svelte'
  import type { DeletedBranch, NewerTip, OperationKind, RepoOperationEntry } from '@shared/types'
  import { recordedDeleted, restoreDeleted } from '@/lib/actions'
  import type { IconName } from '@/lib/icons'
  import { api, asError } from '@/lib/api'
  import { fullDate, relativeTime, shortSha } from '@/lib/format'
  import { app } from '@/lib/state.svelte'
  import { confirm } from '@/lib/ui.svelte'

  let ops = $state.raw<RepoOperationEntry[]>([])
  let error = $state<string | null>(null)
  let loading = $state(true)
  let gone = $state.raw<DeletedBranch[]>([])
  /** Newer commits found for a deleted branch (pushed elsewhere, or orphaned), by name. */
  let newer = $state.raw<Record<string, NewerTip>>({})
  let searching = $state(false)

  // Reload whenever HEAD or a branch moves, so the list is always current.
  $effect(() => {
    const repo = app.repo?.path
    void app.status?.head
    void app.status?.branch
    if (!repo) return
    api['git:operations'](repo)
      .then(o => { ops = o; error = null })
      .catch(e => (error = asError(e).message))
      .finally(() => (loading = false))
    // Deleted branches: exact tips recorded by the app win over guesses from the reflog.
    void app.refs.branches
    api['git:deletedBranches'](repo).then(found => {
      const exact: DeletedBranch[] = recordedDeleted().map(r => ({ ...r, subject: found.find(f => f.sha === r.sha)?.subject ?? '', source: 'app' }))
      const names = new Set(exact.map(e => e.name))
      gone = [...exact, ...found.filter(f => !names.has(f.name))].sort((a, b) => b.date - a.date)
      if (!gone.length) return
      // Slower search (remote branches, unreferenced commits): fills in when ready.
      searching = true
      api['git:newerTips'](repo, gone.map(g => ({ name: g.name, sha: g.sha })))
        .then(list => (newer = Object.fromEntries(list.map(n => [n.name, n]))))
        .catch(() => (newer = {}))
        .finally(() => (searching = false))
    }).catch(() => (gone = []))
  })

  async function restoreBranch(b: DeletedBranch, at: 'newest' | 'known' = 'newest') {
    const n = at === 'newest' ? newer[b.name] : undefined
    const sha = n?.sha ?? b.sha
    const ok = await confirm({
      title: `Restore branch ${b.name}?`,
      message: n
        ? `It is recreated at ${shortSha(sha)}, ${n.ahead} commit${n.ahead > 1 ? 's' : ''} after the last one known here, found ${n.via === 'remote' ? `on ${n.ref}` : 'among commits nothing references any more'}: “${n.subject}”.`
        : b.source === 'app'
          ? `It is recreated at ${shortSha(sha)}, exactly where it was when it was deleted.`
          : `It is recreated at ${shortSha(sha)}, the last commit you had checked out on it. No newer commit was found on a remote branch or in the object store.`,
      confirmLabel: 'Restore',
    })
    if (ok) await restoreDeleted(b.name, sha)
  }

  const ICON: Record<OperationKind, IconName> = {
    commit: 'commit', amend: 'edit', checkout: 'branch', reset: 'undo', merge: 'merge', rebase: 'sync',
    pull: 'pull', 'cherry-pick': 'commit', revert: 'undo', other: 'history',
  }

  /** Plain words for what going back does, shown before anything moves. */
  function explain(op: RepoOperationEntry): string {
    const b = op.before
    const moveTo = `${b.branch ? `“${b.branch}”` : 'a detached HEAD'} at ${shortSha(b.sha)}`
    if (op.kind === 'checkout') return `Switch back to ${moveTo}.`
    return `Move ${moveTo}${b.branch !== app.status?.branch ? ' (switching branch first)' : ''}. Uncommitted changes are kept; commits after that point stay reachable through this history.`
  }

  async function undo(op: RepoOperationEntry) {
    const ok = await confirm({ title: `Undo “${op.title}”?`, message: explain(op), confirmLabel: 'Go back' })
    if (ok) await app.restore(op.before, `before “${op.title}”`)
  }

  const groups = $derived.by(() => {
    const out: { day: string; ops: RepoOperationEntry[] }[] = []
    for (const op of ops) {
      const day = new Date(op.date * 1000).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
      if (out[out.length - 1]?.day !== day) out.push({ day, ops: [] })
      out[out.length - 1].ops.push(op)
    }
    return out
  })
</script>

<div class="undo">
  <div class="bar">
    <Icon name="undo" size={15} class="bi" />
    <span class="title">Undo history</span>
    <span class="sub">Every change to HEAD, from git's reflog. Go back to before any of them.</span>
    <span class="grow"></span>
    {#if ops[0]?.before.sha}
      <button class="btn btn-secondary sm" onclick={() => undo(ops[0])} disabled={!!app.busy}><Icon name="undo" size={13} />Undo last</button>
    {/if}
  </div>

  {#if error}
    <div class="empty"><h3>Could not read the history</h3><p>{error}</p></div>
  {:else if loading}
    <div class="empty"><span class="spinner"></span></div>
  {:else if !ops.length}
    <div class="empty"><div class="empty-icon"><Icon name="history" size={24} /></div><h3>Nothing to undo yet</h3><p>Commits, checkouts, merges, rebases and resets will appear here.</p></div>
  {:else}
    <div class="list">
      {#if gone.length}
        <div class="day label">Deleted branches</div>
        {#each gone as b (b.name)}
          <div class="op gone">
            <span class="ico"><Icon name="branch" size={14} /></span>
            <div class="grow">
              <div class="t truncate">{b.name}</div>
              {#if newer[b.name]}
                {@const n = newer[b.name]}
                <div class="d truncate newer"><Icon name="push" size={10} />{n.ahead} newer commit{n.ahead > 1 ? 's' : ''} {n.via === 'remote' ? `on ${n.ref}` : 'found unreferenced'} · <span class="mono">{shortSha(n.sha)}</span> {n.subject}</div>
              {:else}
                <div class="d truncate"><span class="mono">{shortSha(b.sha)}</span>{#if b.subject} · {b.subject}{/if}{#if searching} · <span class="dim">looking for newer commits…</span>{/if}</div>
              {/if}
            </div>
            <span class="src" title={b.source === 'app' ? 'Deleted from this app: exact tip' : 'Found in the reflog: last commit checked out on it'}>{b.source === 'app' ? 'exact' : 'last seen'}</span>
            <span class="when" title={fullDate(b.date)}>{relativeTime(b.date)}</span>
            {#if newer[b.name]}<button class="btn btn-ghost sm" disabled={!!app.busy} title="Restore at {shortSha(b.sha)} instead, the last commit known here" onclick={() => restoreBranch(b, 'known')}>At last seen</button>{/if}
            <button class="btn btn-ghost sm" disabled={!!app.busy} onclick={() => restoreBranch(b)}>Restore</button>
          </div>
        {/each}
      {/if}
      {#each groups as g}
        <div class="day label">{g.day}</div>
        {#each g.ops as op, i (op.id)}
          <div class="op {op.kind}" class:latest={op === ops[0]}>
            <span class="ico"><Icon name={ICON[op.kind]} size={14} /></span>
            <div class="grow">
              <div class="t truncate">{op.title}</div>
              <div class="d truncate">
                {op.kind} · {op.after.branch ?? 'detached'} · <span class="mono">{shortSha(op.before.sha || op.after.sha)} → {shortSha(op.after.sha)}</span>
                {#if op.detail && op.detail !== op.title && op.kind === 'rebase'} · {op.detail}{/if}
              </div>
            </div>
            <span class="when" title={fullDate(op.date)}>{relativeTime(op.date)}</span>
            <button class="btn btn-ghost sm" disabled={!op.before.sha || !!app.busy} onclick={() => undo(op)} title={op.before.sha ? explain(op) : 'No earlier state'}>
              Go back before
            </button>
          </div>
        {/each}
      {/each}
    </div>
  {/if}
</div>

<style>
  .undo { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .bar { display: flex; align-items: center; gap: 10px; height: 40px; padding: 0 10px 0 14px; border-bottom: 1px solid var(--border); flex-shrink: 0; background: rgba(6, 10, 15, 0.3); }
  .bar :global(.bi) { color: var(--green); }
  .title { font-weight: 700; color: #fff; }
  .sub { color: var(--text-faint); font-size: 12px; }
  .list { flex: 1; overflow-y: auto; padding: 4px 14px 24px; }
  .day { padding: 14px 4px 6px; }
  .gone .ico { color: var(--red); background: var(--red-soft); }
  .op.gone .btn { opacity: 1; }
  .newer { color: #86efac; display: flex; align-items: center; gap: 4px; }
  .dim { color: var(--text-dim); }
  .src { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-dim); }
  .op { display: flex; align-items: center; gap: 12px; padding: 8px 10px; border-radius: var(--radius); }
  .op:hover { background: var(--surface-1); }
  .op.latest { background: rgba(74, 222, 128, 0.05); }
  .ico { width: 28px; height: 28px; border-radius: var(--radius); display: flex; align-items: center; justify-content: center; flex-shrink: 0; background: var(--surface-2); color: var(--text-muted); }
  .commit .ico, .amend .ico { color: var(--green); background: var(--green-soft); }
  .checkout .ico { color: var(--blue); background: rgba(96, 165, 250, 0.14); }
  .merge .ico, .rebase .ico { color: var(--purple); background: var(--purple-soft); }
  .reset .ico, .revert .ico { color: var(--amber); background: var(--amber-soft); }
  .pull .ico { color: var(--cyan); background: rgba(103, 232, 249, 0.12); }
  .t { color: #e5e7eb; font-size: 12.5px; }
  .d { color: var(--text-faint); font-size: 11px; margin-top: 1px; }
  .when { font-size: 11.5px; color: var(--text-faint); flex-shrink: 0; }
  .op .btn { opacity: 0; }
  .op:hover .btn, .op.latest .btn { opacity: 1; }
</style>
