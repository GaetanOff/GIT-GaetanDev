<script lang="ts">
  import { tick } from 'svelte'
  import Popover from './Popover.svelte'
  import Icon from './Icon.svelte'
  import Highlight from './Highlight.svelte'
  import type { Branch } from '@shared/types'
  import { branchMenu } from '@/lib/actions'
  import { sanitizeBranchName } from '@/lib/commands'
  import { rank } from '@/lib/fuzzy'
  import { relativeTime } from '@/lib/format'
  import { app } from '@/lib/state.svelte'
  import { contextMenu, openDialog } from '@/lib/ui.svelte'

  let { open = $bindable() }: { open: boolean } = $props()
  let query = $state('')
  let active = $state(0)
  let input = $state<HTMLInputElement>()
  let listEl = $state<HTMLDivElement>()

  // Remote branches already checked out locally are noise in a switcher.
  const candidates = $derived.by(() => {
    const locals = new Set(app.localBranches.map(b => b.name))
    const tracked = new Set(app.localBranches.map(b => b.upstream).filter(Boolean))
    const remotes = app.remoteBranches.filter(b => !tracked.has(b.name) && !locals.has(b.name.split('/').slice(1).join('/')))
    return [...app.localBranches, ...remotes]
  })
  const results = $derived(rank(candidates, query, b => b.name, 300))
  const local = $derived(results.filter(r => !r.item.remote))
  const remote = $derived(results.filter(r => r.item.remote))
  const flat = $derived([...local, ...remote])
  /**
   * A name typed in full that exists only on a remote ("feature/login" on origin) is that
   * branch: Enter checks it out with tracking. It offered "Create branch" first, and Enter made
   * a new branch from HEAD under the same name instead.
   */
  const exactRemote = $derived.by(() => {
    const name = sanitizeBranchName(query.trim())
    return name ? remote.findIndex(r => r.item.remoteName && r.item.name.slice(r.item.remoteName.length + 1) === name) : -1
  })
  const canCreate = $derived(!!query.trim() && exactRemote < 0 && !app.localBranches.some(b => b.name === sanitizeBranchName(query.trim())))
  const offset = $derived(canCreate ? 1 : 0)

  $effect(() => {
    if (open) {
      query = ''
      active = 0
      tick().then(() => input?.focus())
    }
  })
  $effect(() => {
    void query
    active = exactRemote >= 0 ? local.length + exactRemote : 0
  })
  $effect(() => {
    listEl?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  })

  function pick(b: Branch) {
    open = false
    if (!b.current) app.checkout(b.name)
  }

  function create() {
    open = false
    openDialog({ kind: 'branch', name: sanitizeBranchName(query.trim()) })
  }

  function onKey(e: KeyboardEvent) {
    const max = flat.length + offset - 1
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, max) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      if (canCreate && active === 0) create()
      else if (flat[active - offset]) pick(flat[active - offset].item)
    }
  }
</script>

<Popover bind:open width={420}>
  <div class="search">
    <Icon name="search" size={14} />
    <input bind:this={input} bind:value={query} onkeydown={onKey} placeholder="Filter or create a branch" spellcheck="false" />
  </div>
  <div class="list" bind:this={listEl}>
    {#if canCreate}
      <button class="item create" class:active={active === 0} data-i="0" onclick={create} onmouseenter={() => (active = 0)}>
        <Icon name="plus" size={14} />
        <span class="grow truncate">Create branch <b class="mono">{sanitizeBranchName(query.trim())}</b></span>
        <kbd>↵</kbd>
      </button>
    {/if}
    {#snippet row(b: Branch, hits: number[], i: number)}
      <button
        class="item" class:active={i === active} class:current={b.current} data-i={i}
        onclick={() => pick(b)} oncontextmenu={e => contextMenu(e, branchMenu(b))} onmouseenter={() => (active = i)}
      >
        <Icon name={b.remote ? 'cloud' : 'branch'} size={14} class="bicon" />
        <span class="grow name truncate"><Highlight text={b.name} {hits} /></span>
        {#if b.behind}<span class="ab down">↓{b.behind}</span>{/if}
        {#if b.ahead}<span class="ab up">↑{b.ahead}</span>{/if}
        {#if b.gone}<span class="badge red">gone</span>{/if}
        <span class="date">{relativeTime(b.date)}</span>
        {#if b.current}<Icon name="check" size={14} class="check" />{/if}
      </button>
    {/snippet}
    {#if local.length}
      <div class="group label">Local</div>
      {#each local as r, i (r.item.fullRef)}{@render row(r.item, r.match.hits, i + offset)}{/each}
    {/if}
    {#if remote.length}
      <div class="group label">Remote</div>
      {#each remote as r, i (r.item.fullRef)}{@render row(r.item, r.match.hits, i + local.length + offset)}{/each}
    {/if}
    {#if !flat.length && !canCreate}<div class="none">No branches yet.</div>{/if}
  </div>
  <div class="foot">
    <button class="btn btn-secondary sm" onclick={() => { open = false; openDialog({ kind: 'branch' }) }}><Icon name="plus" size={13} />New branch</button>
    <span class="hint">Right-click a branch for merge, rebase, PR…</span>
  </div>
</Popover>

<style>
  .search { display: flex; align-items: center; gap: 8px; padding: 0 12px; height: 42px; border-bottom: 1px solid var(--border); color: var(--text-faint); }
  .search input { flex: 1; border: none; background: transparent; outline: none; color: #fff; font-size: 13px; }
  .search input::placeholder { color: var(--text-faint); }
  .list { overflow-y: auto; padding: 5px; flex: 1; }
  .group { padding: 8px 8px 4px; }
  .item { width: 100%; display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 8px; border: none; border-radius: var(--radius); background: transparent; text-align: left; }
  .item.active { background: var(--surface-2); }
  .item :global(.bicon) { color: var(--text-faint); }
  .item.current :global(.bicon), .item :global(.check) { color: var(--green); }
  .name { color: #d1d5db; }
  .current .name { color: #fff; font-weight: 600; }
  .create { color: var(--green); }
  .create b { color: #fff; }
  .date { font-size: 11px; color: var(--text-dim); flex-shrink: 0; }
  .ab { font-size: 10.5px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .ab.down { color: #93c5fd; }
  .ab.up { color: #86efac; }
  .none { padding: 18px; text-align: center; color: var(--text-faint); font-size: 12.5px; }
  .foot { display: flex; align-items: center; gap: 10px; padding: 8px; border-top: 1px solid var(--border); }
  .hint { font-size: 11px; color: var(--text-dim); }
</style>
