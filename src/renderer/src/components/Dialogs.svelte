<script lang="ts">
  import CloneDialog from './dialogs/CloneDialog.svelte'
  import SettingsDialog from './dialogs/SettingsDialog.svelte'
  import BranchDialog from './dialogs/BranchDialog.svelte'
  import ShortcutsDialog from './dialogs/ShortcutsDialog.svelte'
  import SimpleDialog from './dialogs/SimpleDialog.svelte'
  import WorktreeDialog from './dialogs/WorktreeDialog.svelte'
  import { closeDialog, dialogs } from '@/lib/ui.svelte'

  /*
   * Every open dialog stays mounted, only the top one shown: a credential
   * prompt coming up over the Clone dialog (a new SSH host) or over a half
   * typed tag no longer destroys what is under it. The clone went on with
   * its form emptied, and its error was written into a dialog gone.
   */
  const top = $derived(dialogs[dialogs.length - 1])
</script>

{#each dialogs as d (d)}
  <div class="layer" hidden={d !== top} inert={d !== top}>
    {#if d.kind === 'clone'}
      <CloneDialog onclose={() => closeDialog(d)} />
    {:else if d.kind === 'settings'}
      <SettingsDialog tab={d.tab} onclose={() => closeDialog(d)} />
    {:else if d.kind === 'branch'}
      <BranchDialog from={d.from} fromLabel={d.fromLabel} name={d.name} onclose={() => closeDialog(d)} />
    {:else if d.kind === 'shortcuts'}
      <ShortcutsDialog onclose={() => closeDialog(d)} />
    {:else if d.kind === 'worktree'}
      <WorktreeDialog branch={d.branch} onclose={() => closeDialog(d)} />
    {:else}
      <SimpleDialog {d} />
    {/if}
  </div>
{/each}

<style>
  .layer { display: contents; }
  .layer[hidden] { display: none; }
</style>
