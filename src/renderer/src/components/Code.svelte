<script lang="ts">
  import type { Segment } from '@/lib/intraline'
  import { pieces } from '@/lib/syntax'
  import { app } from '@/lib/state.svelte'

  /** One line of code, coloured by language, with word-level change marks on top. */
  let { text, lang, segs }: { text: string; lang: string | null; segs?: Segment[] } = $props()
  const parts = $derived(pieces(text, app.settings.syntaxHighlight ? lang : null, segs))
</script>

{#each parts as p}{#if p.m}<mark class={p.c ? `sx-${p.c}` : undefined}>{p.t}</mark>{:else if p.c}<span class="sx-{p.c}">{p.t}</span>{:else}{p.t}{/if}{/each}
