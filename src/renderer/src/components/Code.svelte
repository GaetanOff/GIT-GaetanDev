<script lang="ts">
  import type { Segment } from '@/lib/intraline'
  import { pieces, type LexState } from '@/lib/syntax'
  import { app } from '@/lib/state.svelte'

  /**
   * One line of code, coloured by language, with word-level change marks on
   * top. `state` is the lexer state the line starts in (inside a comment…);
   * leave it undefined when unknown.
   */
  let { text, lang, segs, state }: { text: string; lang: string | null; segs?: Segment[]; state?: LexState } = $props()
  const parts = $derived(pieces(text, app.settings.syntaxHighlight ? lang : null, segs, state))
</script>

{#each parts as p}{#if p.m}<mark class={p.c ? `sx-${p.c}` : undefined}>{p.t}</mark>{:else if p.c}<span class="sx-{p.c}">{p.t}</span>{:else}{p.t}{/if}{/each}
