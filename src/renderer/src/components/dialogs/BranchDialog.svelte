<script lang="ts">
  import Modal from '../Modal.svelte'
  import { api } from '@/lib/api'
  import { sanitizeBranchName, validateBranchName } from '@/lib/commands'
  import { app } from '@/lib/state.svelte'

  let { from, fromLabel, name: initial = '', onclose }: { from?: string; fromLabel?: string; name?: string; onclose: () => void } = $props()

  // svelte-ignore state_referenced_locally
  let name = $state(initial)
  let checkout = $state(true)
  const error = $derived(validateBranchName(name))
  const exists = $derived(app.localBranches.some(b => b.name === name))
  const base = $derived(fromLabel ?? app.status?.branch ?? 'HEAD')
  const dirty = $derived(app.files.length > 0)

  async function create() {
    if (error || exists) return
    onclose()
    const repo = app.repo!.path
    await app.run(`Creating ${name}`, () => api['git:createBranch'](repo, name, from ?? null, checkout), {
      success: checkout ? `Switched to new branch ${name}.` : `Created ${name}.`,
    })
  }
</script>

<Modal title="New branch" icon="branch" onclose={onclose} onsubmit={create}>
  <div class="field">
    <span class="label">Name</span>
    <input class="input mono" value={name} oninput={e => (name = sanitizeBranchName((e.target as HTMLInputElement).value))} placeholder="feature/my-change" spellcheck="false" />
    {#if name && error}<span class="err">{error}</span>{:else if exists}<span class="err">A branch with this name already exists.</span>{/if}
  </div>
  <p class="from">Based on <b class="mono">{base}</b>{#if checkout && dirty && !from}. Your uncommitted changes come along.{/if}</p>
  <label class="check"><input type="checkbox" bind:checked={checkout} />Switch to the new branch</label>
  {#snippet footer()}
    <button type="button" class="btn btn-secondary" onclick={onclose}>Cancel</button>
    <button type="submit" class="btn btn-primary" disabled={!!error || exists}>Create branch</button>
  {/snippet}
</Modal>

<style>
  .err { font-size: 11.5px; color: var(--red); }
  .from { margin: 12px 0; font-size: 12.5px; }
  .from b { color: #e5e7eb; font-weight: 600; }
</style>
