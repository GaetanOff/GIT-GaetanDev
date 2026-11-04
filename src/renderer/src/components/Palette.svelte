<script lang="ts">
  import { tick } from 'svelte'
  import Icon from './Icon.svelte'
  import Highlight from './Highlight.svelte'
  import type { IconName } from '@/lib/icons'
  import { COMMANDS, keyLabels } from '@/lib/commands'
  import { rank } from '@/lib/fuzzy'
  import { basename } from '@/lib/format'
  import { asError } from '@/lib/api'
  import { app } from '@/lib/state.svelte'
  import { overlays, toast } from '@/lib/ui.svelte'

  interface Item {
    id: string
    group: string
    title: string
    sub?: string
    icon: IconName
    keys?: string[]
    run: () => unknown
  }

  let query = $state('')
  let active = $state(0)
  let input = $state<HTMLInputElement>()
  let listEl = $state<HTMLDivElement>()

  const mac = $derived(app.platform === 'darwin')
  const placeholder = $derived(
    { all: 'Type a command, branch, file or repository…', files: 'Go to a changed file…', branches: 'Switch to branch…', repos: 'Open repository…' }[overlays.paletteMode],
  )

  const items = $derived.by((): Item[] => {
    const mode = overlays.paletteMode
    const out: Item[] = []
    if (mode === 'all') {
      const seen = new Set<string>()
      for (const c of COMMANDS) {
        if ((c.when && !c.when()) || seen.has(c.title)) continue
        seen.add(c.title)
        out.push({ id: `cmd:${c.id}`, group: c.group, title: c.title, icon: c.icon, keys: c.keys ? keyLabels(c.keys, mac) : undefined, run: c.run })
      }
    }
    if (mode === 'all' || mode === 'files') {
      for (const f of app.files) {
        const area = f.conflicted ? 'conflicted' : f.untracked || f.worktree !== '.' ? 'unstaged' : 'staged'
        out.push({
          id: `file:${f.path}`, group: 'Changed files', title: basename(f.path), sub: f.path, icon: 'file',
          run: () => { app.view = 'changes'; app.selected = { path: f.path, area } },
        })
      }
    }
    if (mode === 'all' || mode === 'branches') {
      for (const b of app.localBranches) {
        if (b.current) continue
        out.push({ id: `br:${b.name}`, group: 'Switch branch', title: b.name, sub: b.subject, icon: 'branch', run: () => app.checkout(b.name) })
      }
      if (mode === 'branches') {
        for (const b of app.remoteBranches) out.push({ id: `rb:${b.name}`, group: 'Remote branches', title: b.name, icon: 'cloud', run: () => app.checkout(b.name) })
      }
    }
    if (mode === 'all' || mode === 'repos') {
      for (const r of app.repos) {
        if (r.id === app.repo?.id) continue
        out.push({ id: `repo:${r.id}`, group: 'Open repository', title: r.name, sub: r.path, icon: 'repo', run: () => app.openRepo(r.id).catch(e => toast('error', asError(e).message)) })
      }
    }
    return out
  })

  // Without a query, show commands plus a few of each other kind so the list stays scannable.
  const results = $derived.by(() => {
    if (query) return rank(items, query, i => i.title, 60)
    const perGroup = new Map<string, number>()
    return rank(items, '', i => i.title, 400).filter(r => {
      if (r.item.id.startsWith('cmd:') || overlays.paletteMode !== 'all') return true
      const n = (perGroup.get(r.item.group) ?? 0) + 1
      perGroup.set(r.item.group, n)
      return n <= 5
    })
  })

  $effect(() => {
    if (overlays.palette) {
      query = ''
      active = 0
      tick().then(() => input?.focus())
    }
  })
  $effect(() => {
    void query
    active = 0
  })
  $effect(() => {
    listEl?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  })

  function close() {
    overlays.palette = false
  }
  function pick(item: Item) {
    close()
    item.run()
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); close() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, results.length - 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0) }
    else if (e.key === 'Enter' && results[active]) { e.preventDefault(); pick(results[active].item) }
  }
</script>

{#if overlays.palette}
  <div class="overlay" role="presentation" onpointerdown={e => e.target === e.currentTarget && close()}>
    <div class="palette" role="dialog" aria-label="Command palette">
      <div class="in">
        <Icon name="search" size={16} />
        <input bind:this={input} bind:value={query} onkeydown={onKey} {placeholder} spellcheck="false" />
        <kbd>Esc</kbd>
      </div>
      <div class="list" bind:this={listEl}>
        {#each results as { item, match }, i (item.id)}
          {#if i === 0 || results[i - 1].item.group !== item.group}
            <div class="group">{item.group}</div>
          {/if}
          <button class="pi" class:on={i === active} data-i={i} onclick={() => pick(item)} onmouseenter={() => (active = i)}>
            <span class="p-icon"><Icon name={item.icon} size={15} /></span>
            <span class="grow">
              <span class="p-title truncate"><Highlight text={item.title} hits={match.hits} /></span>
              {#if item.sub}<span class="p-sub truncate">{item.sub}</span>{/if}
            </span>
            {#if item.keys}<span class="keys">{#each item.keys as k}<kbd>{k}</kbd>{/each}</span>{/if}
          </button>
        {:else}
          <div class="none">No results for “{query}”.</div>
        {/each}
      </div>
      <div class="foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
        <span><kbd>↵</kbd> run</span>
        <span><kbd>Esc</kbd> close</span>
      </div>
    </div>
  </div>
{/if}

<style>
  /* The SSH Console command palette. */
  .overlay {
    position: fixed; inset: 0; z-index: 650; display: flex; justify-content: center; align-items: flex-start; padding: 11vh 16px 16px;
    background: rgba(3, 7, 18, 0.55); backdrop-filter: blur(6px); animation: fadeIn 120ms ease-out;
  }
  .palette {
    width: 100%; max-width: 640px; border-radius: 20px; overflow: hidden; display: flex; flex-direction: column; max-height: 70vh;
    background: rgba(17, 24, 39, 0.96); backdrop-filter: blur(24px); border: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow: 0 30px 80px rgba(0, 0, 0, 0.6); animation: popIn 160ms var(--ease-pop);
  }
  .in { display: flex; align-items: center; gap: 12px; padding: 0 16px; height: 54px; color: var(--text-faint); }
  .in input { flex: 1; border: none; outline: none; background: transparent; color: #fff; font-size: 15px; }
  .in input::placeholder { color: var(--text-faint); }
  .list { overflow-y: auto; padding: 6px; border-top: 1px solid rgba(255, 255, 255, 0.08); }
  .group { padding: 10px 12px 4px; font-size: 10px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--text-faint); }
  .pi { display: flex; align-items: center; gap: 12px; width: 100%; padding: 7px 10px; border-radius: 12px; border: none; background: none; text-align: left; color: #d1d5db; }
  .pi.on { background: rgba(255, 255, 255, 0.08); color: #fff; }
  .p-icon { width: 30px; height: 30px; border-radius: 9px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; background: rgba(255, 255, 255, 0.06); color: var(--text-muted); }
  .pi.on .p-icon { background: rgba(74, 222, 128, 0.18); color: var(--green); }
  .grow { display: flex; flex-direction: column; min-width: 0; }
  .p-title { font-size: 13.5px; font-weight: 600; }
  .p-sub { font-size: 11.5px; color: var(--text-faint); }
  .keys { display: flex; gap: 3px; flex-shrink: 0; }
  .none { padding: 26px; text-align: center; color: var(--text-faint); font-size: 13px; }
  .foot { display: flex; gap: 14px; padding: 9px 16px; border-top: 1px solid rgba(255, 255, 255, 0.08); font-size: 11px; color: var(--text-faint); }
  .foot kbd { margin-right: 3px; }
</style>
