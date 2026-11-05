<script lang="ts" generics="T">
  import type { Snippet } from 'svelte'

  let {
    items,
    rowHeight,
    row,
    overscan = 12,
    onEnd,
    class: cls = '',
    /** Content width for horizontal scrolling (CSS length); rows clip otherwise. */
    width,
    viewport = $bindable(),
  }: {
    items: T[]
    rowHeight: number
    row: Snippet<[T, number]>
    overscan?: number
    /** Called when the user scrolls near the end, for paging. */
    onEnd?: () => void
    class?: string
    width?: string
    viewport?: HTMLDivElement
  } = $props()

  let scrollTop = $state(0)
  let height = $state(0)

  const start = $derived(Math.max(0, Math.floor(scrollTop / rowHeight) - overscan))
  const end = $derived(Math.min(items.length, Math.ceil((scrollTop + height) / rowHeight) + overscan))
  const visible = $derived(items.slice(start, end))

  function onScroll() {
    scrollTop = viewport!.scrollTop
    if (onEnd && scrollTop + height > items.length * rowHeight - rowHeight * 30) onEnd()
  }

  /**
   * A row clicked took the focus itself (rows have tabindex -1), and lost it
   * to the page once scrolled out of the rows drawn: the arrow keys then did
   * nothing until the next click. The listbox around the rows, which points
   * at the selected one, keeps the focus instead.
   */
  function onFocusIn(e: FocusEvent) {
    const owner = viewport?.closest<HTMLElement>('[role="listbox"]')
    const target = e.target as HTMLElement
    if (owner && target !== owner && target.getAttribute('tabindex') === '-1') owner.focus({ preventScroll: true })
  }

  /** Keeps a row in view, for keyboard navigation. */
  export function reveal(index: number) {
    if (!viewport) return
    const top = index * rowHeight
    if (top < viewport.scrollTop) viewport.scrollTop = top
    else if (top + rowHeight > viewport.scrollTop + height) viewport.scrollTop = top + rowHeight - height
  }
</script>

<div class="vl {cls}" class:hscroll={!!width} bind:this={viewport} bind:clientHeight={height} onscroll={onScroll} onfocusin={onFocusIn}>
  <div class="spacer" style="height:{items.length * rowHeight}px;{width ? `min-width:${width}` : ''}">
    <div class="window" style="transform:translateY({start * rowHeight}px)">
      {#each visible as item, i (start + i)}
        {@render row(item, start + i)}
      {/each}
    </div>
  </div>
</div>

<style>
  .vl { overflow-y: auto; overflow-x: hidden; position: relative; contain: strict; }
  .spacer { position: relative; }
  .window { position: absolute; left: 0; right: 0; top: 0; will-change: transform; }
  .hscroll { overflow-x: auto; }
</style>
