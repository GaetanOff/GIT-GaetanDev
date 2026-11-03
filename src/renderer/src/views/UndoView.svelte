<script lang="ts">
  import Icon from '@/components/Icon.svelte'
  import type { OperationKind, RepoOperationEntry } from '@shared/types'
  import type { IconName } from '@/lib/icons'
  import { api, asError } from '@/lib/api'
  import { fullDate, relativeTime, shortSha } from '@/lib/format'
  import { app } from '@/lib/state.svelte'
  import { confirm } from '@/lib/ui.svelte'

  let ops = $state.raw<RepoOperationEntry[]>([])
  let error = $state<string | null>(null)
  let loading = $state(true)

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
  })

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
