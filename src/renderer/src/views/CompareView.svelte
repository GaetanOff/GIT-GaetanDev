<script lang="ts">
  import Icon from '@/components/Icon.svelte'
  import DiffView from '@/components/DiffView.svelte'
  import RefInput from '@/components/RefInput.svelte'
  import Resizer from '@/components/Resizer.svelte'
  import type { CompareResult } from '@shared/types'
  import { commitMenu } from '@/lib/actions'
  import { api, asError } from '@/lib/api'
  import { basename, dirname, initials, relativeTime, shortSha, statusStyle, tone } from '@/lib/format'
  import { app } from '@/lib/state.svelte'
  import { contextMenu } from '@/lib/ui.svelte'

  let last = app.compareTarget!
  const target = $derived(app.compareTarget ?? last)
  $effect(() => { if (app.compareTarget) last = app.compareTarget })
  let result = $state.raw<CompareResult | null>(null)
  let error = $state<string | null>(null)
  let loading = $state(false)
  let file = $state<string | null>(null)
  let tab = $state<'files' | 'commits'>('files')
  let width = $state(380)
  let token = 0

  $effect(() => {
    const repo = app.repo?.path
    const { base, head, threeDot } = target
    if (!repo || !app.compareTarget) return
    const t = ++token
    loading = true
    error = null
    api['git:compare'](repo, base, head, threeDot)
      .then(r => {
        if (t !== token) return
        result = r
        if (!file || !r.files.some(f => f.path === file)) file = r.files[0]?.path ?? null
      })
      .catch(e => { if (t === token) { error = asError(e).message; result = null } })
      .finally(() => { if (t === token) loading = false })
  })

  const set = (patch: Partial<typeof target>) => (app.compareTarget = { ...target, ...patch })

  /**
   * The branch a pull request targets on the server: a remote branch loses its remote's name
   * ("origin/release/2.0" → "release/2.0"), a local one keeps its whole name ("release/2.0",
   * which lost its first part and opened a pull request against "2.0").
   */
  function prBase(base: string): string {
    const remote = app.remoteBranches.find(b => b.name === base)?.remoteName
    return remote ? base.slice(remote.length + 1) : base
  }
  const current = $derived(result?.files.find(f => f.path === file) ?? null)
  const totals = $derived(result?.files.reduce((a, f) => ({ add: a.add + f.additions, del: a.del + f.deletions }), { add: 0, del: 0 }))

  function fileKeys(e: KeyboardEvent) {
    if (!result) return
    const i = result.files.findIndex(f => f.path === file)
    if (e.key === 'ArrowDown') { e.preventDefault(); file = result.files[Math.min(i + 1, result.files.length - 1)]?.path ?? file }
    if (e.key === 'ArrowUp') { e.preventDefault(); file = result.files[Math.max(i - 1, 0)]?.path ?? file }
  }
</script>

<div class="cmp">
  <div class="bar">
    <button class="icon-btn" title="Back" onclick={() => app.closeTool()}><Icon name="arrowLeft" size={15} /></button>
    <Icon name="split" size={15} class="bi" />
    <RefInput label="Base" value={target.base} onchange={v => set({ base: v })} />
    <button class="icon-btn sm" title="Swap" onclick={() => set({ base: target.head, head: target.base })}><Icon name="sync" size={14} /></button>
    <RefInput label="Compare" value={target.head} onchange={v => set({ head: v })} />
    <div class="segmented" title="Three dots: changes since the branches diverged, like a pull request. Two dots: the two tips directly.">
      <button class:on={target.threeDot} onclick={() => set({ threeDot: true })}>Since fork ···</button>
      <button class:on={!target.threeDot} onclick={() => set({ threeDot: false })}>Direct ··</button>
    </div>
    <span class="grow"></span>
    {#if loading}<span class="spinner"></span>{/if}
    {#if result && app.provider && app.localBranches.some(b => b.name === target.head)}
      <button class="btn btn-secondary sm" onclick={() => app.openProvider({ type: 'pr', branch: target.head, base: prBase(target.base) })}><Icon name="pr" size={13} />Open PR</button>
    {/if}
  </div>

  {#if error}
    <div class="empty"><div class="empty-icon" style="background:var(--red-soft);color:var(--red)"><Icon name="alert" size={24} /></div><h3>Cannot compare</h3><p>{error}</p></div>
  {:else if result}
    <div class="stats">
      <span><b class="up">↑ {result.ahead.length}{result.ahead.length >= 500 ? '+' : ''}</b> commit{result.ahead.length === 1 ? '' : 's'} in <span class="mono">{target.head}</span> not in <span class="mono">{target.base}</span></span>
      <span><b class="down">↓ {result.behind}</b> the other way</span>
      <span><b>{result.files.length}</b> files · <b class="a">+{totals?.add}</b> <b class="d">−{totals?.del}</b></span>
      {#if result.threeDot && result.mergeBase}<span class="mono dim">since {shortSha(result.mergeBase)}</span>{/if}
    </div>
    <div class="split">
      <section class="left" style="width:{width}px">
        <div class="tabs">
          <button class:on={tab === 'files'} onclick={() => (tab = 'files')}>Files <span class="n">{result.files.length}</span></button>
          <button class:on={tab === 'commits'} onclick={() => (tab = 'commits')}>Commits <span class="n">{result.ahead.length}</span></button>
        </div>
        {#if tab === 'files'}
          <div class="items" role="listbox" tabindex="0" aria-label="Changed files" onkeydown={fileKeys}>
            {#each result.files as f (f.path)}
              {@const st = statusStyle(f.status)}
              <div class="file" class:sel={f.path === file} role="option" aria-selected={f.path === file} tabindex="-1"
                onclick={() => (file = f.path)} onkeydown={() => undefined} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                <span class="st" style="color:{st.color};background:color-mix(in srgb, {st.color} 16%, transparent)">{st.letter}</span>
                <span class="name truncate"><b>{basename(f.path)}</b>{#if dirname(f.path)}<span class="dir">{dirname(f.path)}</span>{/if}</span>
                {#if f.binary}<span class="badge">bin</span>{:else}<span class="nn a">+{f.additions}</span><span class="nn d">−{f.deletions}</span>{/if}
              </div>
            {:else}
              <div class="none">No differences.</div>
            {/each}
          </div>
        {:else}
          <div class="items">
            {#each result.ahead as c (c.sha)}
              {@const t = tone(c.author)}
              <div class="commit" role="button" tabindex="-1" onkeydown={() => undefined}
                ondblclick={() => { app.closeTool(); app.view = 'history'; app.selectedCommit = c.sha }}
                oncontextmenu={e => contextMenu(e, commitMenu(c))} title="Double-click to open in history">
                <span class="av" style="background:{t.bg};color:{t.fg}">{initials(c.author)}</span>
                <span class="grow truncate">{c.subject}</span>
                <span class="when">{relativeTime(c.date)}</span>
                <span class="mono sha">{shortSha(c.sha)}</span>
              </div>
            {:else}
              <div class="none">{target.head} has no commits that {target.base} lacks.</div>
            {/each}
          </div>
        {/if}
      </section>
      <Resizer value={width} min={280} max={720} onchange={v => (width = v)} />
      <section class="right">
        {#if current}
          {#key `${result.from}..${result.to}:${current.path}`}
            <DiffView source={{ kind: 'range', from: result.from, to: result.to, path: current.path, oldPath: current.oldPath }} area="commit" />
          {/key}
        {:else}
          <div class="empty"><div class="empty-icon"><Icon name="split" size={24} /></div><h3>{result.files.length ? 'Select a file' : 'Identical trees'}</h3></div>
        {/if}
      </section>
    </div>
  {:else}
    <div class="empty"><span class="spinner"></span></div>
  {/if}
</div>

<style>
  .cmp { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .bar { display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 10px 0 6px; border-bottom: 1px solid var(--border); flex-shrink: 0; background: rgba(6, 10, 15, 0.3); }
  .bar :global(.bi) { color: var(--cyan); }
  .stats { display: flex; align-items: center; gap: 18px; padding: 8px 14px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted); flex-shrink: 0; flex-wrap: wrap; }
  .stats b { color: #fff; font-variant-numeric: tabular-nums; }
  .stats .up { color: #86efac; }
  .stats .down { color: #93c5fd; }
  .stats .a { color: var(--green); }
  .stats .d { color: var(--red); }
  .dim { color: var(--text-faint); }
  .split { flex: 1; min-height: 0; display: flex; }
  .left { flex-shrink: 0; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); }
  .right { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .tabs { display: flex; gap: 2px; padding: 6px 8px; border-bottom: 1px solid var(--border); }
  .tabs button { flex: 1; height: 26px; border: none; border-radius: var(--radius-sm); background: none; color: var(--text-faint); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
  .tabs button.on { background: var(--surface-3); color: #fff; }
  .n { color: var(--text-dim); margin-left: 4px; }
  .items { flex: 1; overflow-y: auto; padding: 4px 0; outline: none; }
  .file, .commit { display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 12px; }
  .file:hover, .commit:hover { background: var(--surface-1); }
  .file.sel { background: var(--surface-3); }
  .st { width: 16px; height: 16px; border-radius: 4px; display: inline-flex; align-items: center; justify-content: center; font-size: 9.5px; font-weight: 800; flex-shrink: 0; }
  .name { flex: 1; font-size: 12.5px; color: #d1d5db; }
  .name b { font-weight: 500; color: #e5e7eb; }
  .dir { margin-left: 6px; color: var(--text-faint); font-size: 11.5px; }
  .nn { font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .nn.a { color: var(--green); }
  .nn.d { color: var(--red); }
  .commit .grow { font-size: 12.5px; color: #e5e7eb; }
  .av { width: 18px; height: 18px; border-radius: 5px; display: flex; align-items: center; justify-content: center; font-size: 8px; font-weight: 800; flex-shrink: 0; }
  .when { font-size: 11px; color: var(--text-faint); }
  .sha { font-size: 10.5px; color: var(--text-dim); }
  .none { padding: 14px; color: var(--text-faint); font-size: 12px; }
</style>
