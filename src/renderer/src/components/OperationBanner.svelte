<script lang="ts">
  import Icon from './Icon.svelte'
  import { api } from '@/lib/api'
  import { app } from '@/lib/state.svelte'
  import { confirm } from '@/lib/ui.svelte'

  const op = $derived(app.status?.operation)
  const conflicts = $derived(app.conflicted.length)
  const title = $derived(
    op === 'merge' ? 'Merge in progress' : op === 'rebase' ? `Rebase in progress${app.status?.operationStep ? ` · ${app.status.operationStep}` : ''}` : op === 'cherry-pick' ? 'Cherry-pick in progress' : 'Revert in progress',
  )

  async function skip() {
    const ok = await confirm({
      title: 'Skip this commit?',
      message: `The commit ${op === 'rebase' ? 'being replayed' : 'being applied'} is left out, along with any resolution made for it. The ${op} then goes on with the next one.`,
      confirmLabel: 'Skip commit',
      danger: true,
    })
    if (ok) await app.run('Skipping', () => api['git:skip'](app.repo!.path))
  }

  async function abort() {
    const ok = await confirm({ title: `Abort ${op}?`, message: 'The repository goes back to how it was before it started. Resolutions made so far are lost.', confirmLabel: 'Abort', danger: true })
    if (ok) await app.run('Aborting', () => api['git:abort'](app.repo!.path))
  }
</script>

{#if op}
  <div class="banner" class:ok={!conflicts}>
    <div class="row">
      <Icon name={conflicts ? 'alert' : 'check'} size={15} />
      <span class="grow">
        <b>{title}</b>
        <span class="sub">{conflicts ? `${conflicts} conflicted file${conflicts > 1 ? 's' : ''}: open them, fix, then mark resolved.` : 'All conflicts resolved. Ready to continue.'}</span>
      </span>
    </div>
    <div class="row acts">
      <button class="btn btn-danger sm" onclick={abort}>Abort</button>
      {#if op !== 'merge'}<button class="btn btn-secondary sm" onclick={skip}>Skip</button>{/if}
      <span class="grow"></span>
      <button class="btn btn-primary sm" disabled={!!conflicts} onclick={() => app.run('Continuing', () => api['git:continue'](app.repo!.path))}>
        {op === 'merge' ? 'Commit merge' : 'Continue'}
      </button>
    </div>
  </div>
{/if}

<style>
  .banner {
    margin: 8px; padding: 10px; border-radius: var(--radius-lg); display: flex; flex-direction: column; gap: 8px;
    background: var(--amber-soft); border: 1px solid rgba(252, 211, 77, 0.28); color: #fde68a;
  }
  .banner.ok { background: var(--green-soft); border-color: rgba(74, 222, 128, 0.3); color: #bbf7d0; }
  .row { align-items: flex-start; }
  .grow { display: flex; flex-direction: column; gap: 2px; }
  b { font-size: 12.5px; color: #fff; }
  .sub { font-size: 11.5px; opacity: 0.85; }
  .acts { align-items: center; }
</style>
