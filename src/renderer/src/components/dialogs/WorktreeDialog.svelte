<script lang="ts">
  import Modal from '../Modal.svelte'
  import Icon from '../Icon.svelte'
  import { api } from '@/lib/api'
  import { sanitizeBranchName, validateBranchName } from '@/lib/commands'
  import { app } from '@/lib/state.svelte'

  let { branch: initial, onclose }: { branch?: string; onclose: () => void } = $props()

  const sep = app.platform === 'win32' ? '\\' : '/'
  // svelte-ignore state_referenced_locally
  let mode = $state<'existing' | 'new'>(initial ? 'existing' : 'new')
  // svelte-ignore state_referenced_locally
  let branch = $state(initial ?? '')
  let from = $state(app.status?.branch ?? 'HEAD')
  let path = $state('')
  let pathTouched = $state(false)
  let open = $state(true)

  // The repository the dialog was opened on. Another may be in front by the time it is submitted (a
  // clone finishing, "Open in" from Explorer): the worktree was created in that one instead.
  const opened = app.repo ? { id: app.repo.id, path: app.repo.path, name: app.repo.name } : null

  /** Worktrees go next to the repository: "<repo>-<branch>". */
  $effect(() => {
    if (pathTouched || !opened) return
    const parent = opened.path.replace(/[\\/][^\\/]+$/, '')
    const slug = branch.replace(/[\\/]/g, '-') || 'worktree'
    path = `${parent}${sep}${opened.name}-${slug}`
  })

  const taken = $derived(new Set(app.refs.worktrees.map(w => w.branch).filter(Boolean)))
  const choices = $derived(app.localBranches.filter(b => !taken.has(b.name)))
  const error = $derived(
    !branch.trim() ? 'Pick a branch.' : mode === 'new' ? validateBranchName(branch) ?? (app.localBranches.some(b => b.name === branch) ? 'This branch already exists.' : null)
      : taken.has(branch) ? 'This branch is already checked out in a worktree.' : null,
  )

  async function create() {
    if (error || !path.trim() || !opened) return
    onclose()
    if (!app.stillOn(opened.id)) return
    const repo = opened.path
    const ok = await app.run('Adding worktree', () => api['git:worktreeAdd'](repo, path.trim(), branch.trim(), mode === 'new', mode === 'new' ? from : null).then(() => true), {
      success: `Worktree ready at ${path.trim()}`,
    })
    if (ok && open) await app.addRepo(path.trim())
  }

  async function choose() {
    const p = await api['dialog:pickFolder']('Folder for the new worktree')
    if (p) { path = p; pathTouched = true }
  }
</script>

<Modal title="New worktree" icon="tree" tone="blue" width={520} {onclose} onsubmit={create}>
  <p class="intro">A second working folder on another branch, sharing this repository's history: no stash, no switching.</p>
  <div class="segmented">
    <button type="button" class:on={mode === 'new'} onclick={() => (mode = 'new')}>New branch</button>
    <button type="button" class:on={mode === 'existing'} onclick={() => (mode = 'existing')}>Existing branch</button>
  </div>
  <div class="field">
    <span class="label">Branch</span>
    {#if mode === 'new'}
      <input class="input mono" value={branch} oninput={e => (branch = sanitizeBranchName((e.target as HTMLInputElement).value))} placeholder="feature/side-work" spellcheck="false" />
      <span class="hint">Starts from <input class="from mono" bind:value={from} spellcheck="false" /></span>
    {:else}
      <select class="input" bind:value={branch}>
        <option value="" disabled>Choose a branch</option>
        {#each choices as b (b.name)}<option value={b.name}>{b.name}</option>{/each}
      </select>
    {/if}
    {#if branch && error}<span class="err">{error}</span>{/if}
  </div>
  <div class="field">
    <span class="label">Folder</span>
    <div class="row">
      <input class="input mono" bind:value={path} oninput={() => (pathTouched = true)} spellcheck="false" />
      <button type="button" class="btn btn-secondary" onclick={choose}><Icon name="folder" size={14} />Choose…</button>
    </div>
  </div>
  <div class="field"><label class="check"><input type="checkbox" bind:checked={open} />Open it as a repository tab</label></div>
  {#snippet footer()}
    <button type="button" class="btn btn-secondary" onclick={onclose}>Cancel</button>
    <button type="submit" class="btn btn-primary" disabled={!!error || !path.trim()}>Create worktree</button>
  {/snippet}
</Modal>

<style>
  .intro { margin: 0 0 12px; font-size: 12.5px; }
  .field { margin-top: 14px; }
  .err { font-size: 11.5px; color: var(--red); }
  .from { width: 160px; height: 22px; padding: 0 6px; border-radius: var(--radius-sm); border: 1px solid var(--border-strong); background: var(--surface-2); color: #fff; font-size: 11px; }
  select.input { appearance: auto; }
</style>
