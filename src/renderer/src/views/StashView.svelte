<script lang="ts">
  import Icon from '@/components/Icon.svelte'
  import CommitDetail from '@/components/CommitDetail.svelte'
  import { applyStash, dropStash } from '@/lib/actions'
  import { app } from '@/lib/state.svelte'

  const stash = $derived(app.refs.stashes.find(s => s.index === app.selectedStash) ?? null)
</script>

<div class="stash">
  {#if stash}
    <div class="bar">
      <Icon name="stash" size={15} />
      <span class="grow"><span class="label">Stash</span> <span class="truncate">on {stash.branch}</span></span>
      <button class="btn btn-danger sm" onclick={() => dropStash(stash)}>Drop</button>
      <button class="btn btn-secondary sm" onclick={() => applyStash(stash, false)}>Apply</button>
      <button class="btn btn-primary sm" onclick={() => applyStash(stash, true)}>Restore</button>
    </div>
    {#key stash.sha}
      <CommitDetail stash={stash.index}>
        {#snippet actions()}<span></span>{/snippet}
      </CommitDetail>
    {/key}
  {:else}
    <div class="empty"><div class="empty-icon"><Icon name="stash" size={24} /></div><h3>Stash not found</h3><p>It may have been applied or dropped.</p></div>
  {/if}
</div>

<style>
  .stash { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .bar { display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 10px 0 14px; border-bottom: 1px solid var(--border); background: var(--purple-soft); color: var(--purple); flex-shrink: 0; }
  .grow { display: flex; align-items: center; gap: 6px; color: #e9d5ff; font-size: 12.5px; }
  .grow .label { color: var(--purple); }
</style>
