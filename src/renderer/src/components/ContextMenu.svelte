<script lang="ts">
  import { tick } from 'svelte'
  import Icon from './Icon.svelte'
  import { menu, type MenuItem } from '@/lib/ui.svelte'

  let el = $state<HTMLDivElement>()
  let pos = $state({ x: 0, y: 0 })
  let active = $state(-1)

  /**
   * Where the focus was when the menu opened: it goes back there when the menu closes without
   * having moved it (Escape, a click elsewhere), instead of being left on the page's body where
   * the arrow keys of the list behind did nothing.
   */
  let previous: HTMLElement | null = null
  $effect(() => {
    if (menu.open) {
      previous = document.activeElement as HTMLElement | null
      return
    }
    const back = previous
    previous = null
    tick().then(() => {
      const lost = !document.activeElement || document.activeElement === document.body
      if (back?.isConnected && lost) back.focus()
    })
  })

  // Keep the menu inside the window.
  $effect(() => {
    if (!menu.open) return
    pos = { x: menu.x, y: menu.y }
    active = -1
    tick().then(() => {
      if (!el) return
      const r = el.getBoundingClientRect()
      pos = {
        x: Math.min(menu.x, window.innerWidth - r.width - 8),
        y: menu.y + r.height > window.innerHeight - 8 ? Math.max(8, menu.y - r.height) : menu.y,
      }
      el.focus()
    })
  })

  const actionable = $derived(menu.items.map((it, i) => ({ it, i })).filter(x => x.it !== 'sep' && !x.it.disabled).map(x => x.i))

  function run(item: MenuItem) {
    if (item === 'sep' || item.disabled) return
    menu.open = false
    item.run()
  }

  function onKey(e: KeyboardEvent) {
    const pos = actionable.indexOf(active)
    if (e.key === 'ArrowDown') { e.preventDefault(); active = actionable[(pos + 1) % actionable.length] }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = actionable[(pos - 1 + actionable.length) % actionable.length] }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); run(menu.items[active]) }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); menu.open = false }
  }
</script>

<svelte:window
  onpointerdown={e => { if (menu.open && el && !el.contains(e.target as Node)) menu.open = false }}
  onblur={() => (menu.open = false)}
  onresize={() => (menu.open = false)}
/>

{#if menu.open}
  <div class="menu" bind:this={el} style="left:{pos.x}px;top:{pos.y}px" role="menu" tabindex="-1" onkeydown={onKey}>
    {#each menu.items as item, i}
      {#if item === 'sep'}
        <div class="sep"></div>
      {:else}
        <button
          class="mi" class:danger={item.danger} class:active={i === active} disabled={item.disabled} role="menuitem"
          onclick={() => run(item)} onmouseenter={() => (active = i)}
        >
          <span class="ic">{#if item.icon}<Icon name={item.icon} size={14} />{/if}</span>
          <span class="grow truncate">{item.label}</span>
          {#if item.hint}<span class="hint">{item.hint}</span>{/if}
        </button>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .menu {
    position: fixed; z-index: 700; min-width: 220px; max-width: 340px; padding: 4px; outline: none;
    border-radius: var(--radius-lg); background: var(--overlay); backdrop-filter: blur(20px);
    border: 1px solid var(--border-strong); box-shadow: var(--shadow-pop); animation: popIn 110ms var(--ease-pop);
  }
  .mi { width: 100%; display: flex; align-items: center; gap: 9px; height: 28px; padding: 0 8px; border: none; border-radius: var(--radius-sm); background: none; color: #d1d5db; font-size: 12.5px; text-align: left; }
  .mi.active { background: var(--surface-3); color: #fff; }
  .mi:disabled { opacity: 0.38; cursor: default; }
  .mi.danger { color: #fca5a5; }
  .mi.danger.active { background: var(--red-soft); color: #fecaca; }
  .ic { width: 14px; display: flex; color: var(--text-faint); }
  .mi.active .ic { color: var(--green); }
  .mi.danger .ic { color: var(--red); }
  .hint { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-dim); }
  .sep { height: 1px; margin: 4px 6px; background: var(--border); }
</style>
