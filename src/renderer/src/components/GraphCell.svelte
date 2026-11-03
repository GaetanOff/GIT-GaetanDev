<script lang="ts">
  import type { GraphRow } from '@/lib/graph'
  import { laneColor } from '@/lib/graph'

  let { row, lanes, head = false }: { row: GraphRow; lanes: number; head?: boolean } = $props()

  const W = 14
  const H = 28
  const x = (i: number) => W / 2 + i * W
  const mid = H / 2

  function path(from: number, to: number, y0: number, y1: number): string {
    if (from === to) return `M${x(from)} ${y0}V${y1}`
    const ym = (y0 + y1) / 2
    return `M${x(from)} ${y0}C${x(from)} ${ym} ${x(to)} ${ym} ${x(to)} ${y1}`
  }
</script>

<svg width={Math.max(lanes, 1) * W} height={H} class="graph" aria-hidden="true">
  {#each row.top as e}
    <path d={path(e.from, e.to, 0, mid)} stroke={laneColor(e.color)} />
  {/each}
  {#each row.bottom as e}
    <path d={path(e.from, e.to, mid, H)} stroke={laneColor(e.color)} />
  {/each}
  {#if head}
    <circle cx={x(row.col)} cy={mid} r="5.5" fill="var(--panel-solid)" stroke={laneColor(row.color)} stroke-width="2.5" />
    <circle cx={x(row.col)} cy={mid} r="2" fill={laneColor(row.color)} />
  {:else if row.merge}
    <circle cx={x(row.col)} cy={mid} r="4" fill="var(--panel-solid)" stroke={laneColor(row.color)} stroke-width="2" />
  {:else}
    <circle cx={x(row.col)} cy={mid} r="4" fill={laneColor(row.color)} />
  {/if}
</svg>

<style>
  .graph { flex-shrink: 0; display: block; }
  path { fill: none; stroke-width: 2; stroke-linecap: round; }
</style>
