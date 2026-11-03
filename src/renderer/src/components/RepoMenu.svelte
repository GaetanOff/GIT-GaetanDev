<script lang="ts">
  import { tick } from 'svelte'
  import Popover from './Popover.svelte'
  import Icon from './Icon.svelte'
  import Highlight from './Highlight.svelte'
  import type { RepoEntry } from '@shared/types'
  import { api } from '@/lib/api'
  import { pickAndAddRepo, pickAndInitRepo } from '@/lib/commands'
  import { rank } from '@/lib/fuzzy'
  import { app } from '@/lib/state.svelte'
  import { contextMenu, openDialog, toast } from '@/lib/ui.svelte'
  import { tone } from '@/lib/format'

  let { open = $bindable() }: { open: boolean } = $props()
  let query = $state('')
  let active = $state(0)
  let input = $state<HTMLInputElement>()

  const sorted = $derived(
    [...app.repos].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.lastOpened - a.lastOpened),
  )
  const results = $derived(rank(sorted, query, r => r.name))

  $effect(() => {
    if (open) {
      query = ''
      active = 0
      tick().then(() => input?.focus())
    }
  })
  $effect(() => {
    void query
    active = 0
  })

  async function pick(r: RepoEntry) {
    open = false
    if (r.id === app.repo?.id) return
    try {
      await app.openRepo(r.id)
    } catch (e) {
      toast('error', (e as { message: string }).message)
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, results.length - 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0) }
    else if (e.key === 'Enter' && results[active]) { e.preventDefault(); pick(results[active].item) }
  }

  function menuFor(e: MouseEvent, r: RepoEntry) {
    contextMenu(e, [
      { label: 'Open', icon: 'repo', run: () => pick(r) },
      { label: r.pinned ? 'Unpin' : 'Pin to top', icon: 'star', run: async () => (app.repos = await api['repo:pin'](r.id, !r.pinned)) },
      'sep',
      { label: 'Show in Explorer', icon: 'folder', run: () => api['shell:reveal'](r.path) },
      { label: 'Open in editor', icon: 'code', run: () => api['shell:editor'](r.path).catch(err => toast('error', err.message)) },
      { label: 'Open in terminal', icon: 'terminal', run: () => api['shell:terminal'](r.path) },
      { label: 'Copy path', icon: 'copy', run: () => app.copy(r.path, 'Path copied') },
      'sep',
      { label: 'Remove from list', icon: 'x', danger: true, run: () => app.removeRepo(r.id) },
    ])
  }
</script>

<Popover bind:open width={400}>
  <div class="search">
    <Icon name="search" size={14} />
    <input bind:this={input} bind:value={query} onkeydown={onKey} placeholder="Filter repositories" spellcheck="false" />
  </div>
  <div class="list">
    {#each results as { item, match }, i (item.id)}
      {@const t = tone(item.name)}
      <button
        class="item" class:active={i === active} class:current={item.id === app.repo?.id}
        onclick={() => pick(item)} oncontextmenu={e => menuFor(e, item)} onmouseenter={() => (active = i)}
      >
        <span class="avatar" style="background:{t.bg};color:{t.fg}">{item.name.slice(0, 2).toUpperCase()}</span>
        <span class="grow">
          <span class="name truncate"><Highlight text={item.name} hits={match.hits} /></span>
          <span class="path truncate">{item.path}</span>
        </span>
        {#if item.pinned}<Icon name="star" size={12} class="pin" />{/if}
        {#if item.id === app.repo?.id}<Icon name="check" size={14} class="check" />{/if}
      </button>
    {:else}
      <div class="none">{app.repos.length ? 'No repository matches.' : 'No repositories yet. Add or clone one below.'}</div>
    {/each}
  </div>
  <div class="foot">
    <button class="btn btn-secondary sm" onclick={() => { open = false; pickAndAddRepo() }}><Icon name="folder" size={13} />Add</button>
    <button class="btn btn-secondary sm" onclick={() => { open = false; openDialog({ kind: 'clone' }) }}><Icon name="download" size={13} />Clone</button>
    <button class="btn btn-secondary sm" onclick={() => { open = false; pickAndInitRepo() }}><Icon name="plus" size={13} />Create</button>
  </div>
</Popover>

<style>
  .search { display: flex; align-items: center; gap: 8px; padding: 0 12px; height: 42px; border-bottom: 1px solid var(--border); color: var(--text-faint); }
  .search input { flex: 1; border: none; background: transparent; outline: none; color: #fff; font-size: 13px; }
  .search input::placeholder { color: var(--text-faint); }
  .list { overflow-y: auto; padding: 5px; flex: 1; }
  .item {
    width: 100%; display: flex; align-items: center; gap: 10px; padding: 6px 8px; border: none; border-radius: var(--radius);
    background: transparent; text-align: left;
  }
  .item.active { background: var(--surface-2); }
  .avatar { width: 28px; height: 28px; border-radius: var(--radius); display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 800; flex-shrink: 0; }
  .grow { display: flex; flex-direction: column; min-width: 0; }
  .name { font-weight: 600; color: #e5e7eb; }
  .current .name { color: #fff; }
  .path { font-size: 11px; color: var(--text-faint); direction: rtl; text-align: left; }
  .item :global(.pin) { color: var(--amber); }
  .item :global(.check) { color: var(--green); }
  .none { padding: 18px; text-align: center; color: var(--text-faint); font-size: 12.5px; }
  .foot { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--border); }
  .foot .btn { flex: 1; }
</style>
