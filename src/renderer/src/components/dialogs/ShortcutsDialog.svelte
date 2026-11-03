<script lang="ts">
  import Modal from '../Modal.svelte'
  import { COMMANDS, keyLabels } from '@/lib/commands'
  import { app } from '@/lib/state.svelte'

  let { onclose }: { onclose: () => void } = $props()
  const mac = $derived(app.platform === 'darwin')

  const contextual: [string, string][] = [
    ['Stage / unstage the selected file', 'Space'],
    ['Discard the selected file', 'Delete'],
    ['Select every file of a section', 'mod+a'],
    ['Commit', 'mod+enter'],
    ['Focus the commit summary', 'mod+l'],
    ['Search the history', 'mod+f'],
    ['Move in lists', '↑ ↓'],
  ]
  const seen = new Set<string>()
  const global = COMMANDS.filter(c => c.keys && !seen.has(c.title) && seen.add(c.title))
  const label = (k: string) => (k.includes('+') || k === 'mod' ? keyLabels(k.replace('enter', '↵'), mac) : [k])
</script>

<Modal title="Keyboard shortcuts" icon="command" width={620} {onclose}>
  <div class="cols">
    <dl>
      {#each global as c}
        <dt>{c.title}</dt>
        <dd>{#each keyLabels(c.keys!, mac) as k}<kbd>{k}</kbd>{/each}</dd>
      {/each}
    </dl>
    <dl>
      {#each contextual as [title, keys]}
        <dt>{title}</dt>
        <dd>{#each label(keys) as k}<kbd>{k}</kbd>{/each}</dd>
      {/each}
    </dl>
  </div>
</Modal>

<style>
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; padding-bottom: 14px; }
  dl { margin: 0; display: grid; grid-template-columns: 1fr auto; gap: 7px 12px; font-size: 12.5px; align-content: start; }
  dt { color: var(--text-muted); }
  dd { margin: 0; display: flex; gap: 3px; justify-content: flex-end; }
</style>
