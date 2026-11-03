<script lang="ts">
  import Icon from './Icon.svelte'
  import Highlight from './Highlight.svelte'
  import type { IconName } from '@/lib/icons'
  import { rank } from '@/lib/fuzzy'
  import { app } from '@/lib/state.svelte'

  /** A revision field: type a branch, tag or SHA, with fuzzy suggestions. */
  let { value, label, onchange }: { value: string; label: string; onchange: (v: string) => void } = $props()

  /** Follows `value` from outside, and what is typed meanwhile. */
  let text = $derived(value)
  let open = $state(false)
  let active = $state(0)

  const refs = $derived([
    ...app.localBranches.map(b => ({ name: b.name, icon: 'branch' as IconName })),
    ...app.remoteBranches.map(b => ({ name: b.name, icon: 'cloud' as IconName })),
    ...app.refs.tags.map(t => ({ name: t.name, icon: 'tag' as IconName })),
  ])
  const results = $derived(rank(refs, text === value ? '' : text, r => r.name, 40))

  function commit(v: string) {
    open = false
    text = v
    if (v.trim() && v !== value) onchange(v.trim())
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); open = true; active = Math.min(active + 1, results.length - 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0) }
    else if (e.key === 'Enter') { e.preventDefault(); commit(open && results[active] ? results[active].item.name : text) }
    else if (e.key === 'Escape') { open = false; text = value }
  }
</script>

<div class="ref">
  <span class="lbl label">{label}</span>
  <input class="input mono" bind:value={text} spellcheck="false"
    onfocus={e => { open = true; active = 0; (e.target as HTMLInputElement).select() }}
    oninput={() => { open = true; active = 0 }}
    onkeydown={onKey}
    onblur={() => setTimeout(() => commit(text), 120)} />
  {#if open && results.length}
    <div class="sugg">
      {#each results as r, i (r.item.name + r.item.icon)}
        <button class="opt" class:on={i === active} onmousedown={e => { e.preventDefault(); commit(r.item.name) }} onmouseenter={() => (active = i)}>
          <Icon name={r.item.icon} size={13} /><span class="truncate"><Highlight text={r.item.name} hits={r.match.hits} /></span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .ref { position: relative; display: flex; align-items: center; gap: 8px; }
  .lbl { flex-shrink: 0; }
  .input { height: 28px; width: 220px; }
  .sugg {
    position: absolute; top: calc(100% + 4px); left: 0; right: 0; min-width: 260px; max-height: 300px; overflow-y: auto; z-index: 300; padding: 4px;
    border-radius: var(--radius-lg); background: var(--overlay); border: 1px solid var(--border-strong); box-shadow: var(--shadow-pop);
  }
  .opt { width: 100%; display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 8px; border: none; border-radius: var(--radius-sm); background: none; color: #d1d5db; text-align: left; font-size: 12.5px; }
  .opt :global(svg) { color: var(--text-faint); }
  .opt.on { background: var(--surface-3); color: #fff; }
</style>
