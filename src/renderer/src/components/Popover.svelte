<script lang="ts">
  import type { Snippet } from 'svelte'

  let { open = $bindable(), width = 380, align = 'left', children }: {
    open: boolean
    width?: number
    align?: 'left' | 'right'
    children: Snippet
  } = $props()

  let el = $state<HTMLDivElement>()

  function onPointerDown(e: PointerEvent) {
    if (!open || !el) return
    const anchor = el.parentElement
    if (anchor && !anchor.contains(e.target as Node)) open = false
  }
  function onKey(e: KeyboardEvent) {
    if (open && e.key === 'Escape') {
      e.stopPropagation()
      open = false
    }
  }
</script>

<svelte:window onpointerdown={onPointerDown} onkeydown={onKey} />

{#if open}
  <div class="popover" bind:this={el} style="width:{width}px;{align === 'right' ? 'right:0' : 'left:0'}">
    {@render children()}
  </div>
{/if}

<style>
  .popover {
    position: absolute; top: calc(100% + 6px); z-index: 300;
    max-height: min(70vh, 560px); display: flex; flex-direction: column; overflow: hidden;
    border-radius: var(--radius-lg); background: var(--overlay); backdrop-filter: blur(20px);
    border: 1px solid var(--border-strong); box-shadow: var(--shadow-pop);
    animation: popIn 140ms var(--ease-pop); -webkit-app-region: no-drag;
  }
</style>
