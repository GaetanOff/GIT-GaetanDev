<script lang="ts">
  import { highlight } from '@/lib/fuzzy'

  let { text, hits }: { text: string; hits: number[] } = $props()
  const parts = $derived(highlight(text, hits))
</script>

{#each parts as p}{#if p.hit}<mark>{p.text}</mark>{:else}{p.text}{/if}{/each}

<style>
  mark { background: none; color: var(--green); font-weight: 700; }
</style>
