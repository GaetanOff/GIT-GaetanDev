<script lang="ts">
  import Modal from '../Modal.svelte'
  import { api } from '@/lib/api'
  import { app } from '@/lib/state.svelte'
  import { closeDialog, type Dialog } from '@/lib/ui.svelte'

  /** One of the dialogs built in here (questions, prompts, small forms), with its own form state. */
  let { d }: { d: Dialog } = $props()

  // svelte-ignore state_referenced_locally
  let value = $state(d.kind === 'prompt' ? d.value : '')
  let extra = $state('')
  let flag = $state(true)
  let reveal = $state(false)

  const error = $derived(d.kind === 'prompt' && d.validate ? d.validate(value) : null)

  function resolveAndClose(v: unknown) {
    closeDialog(d)
    if ('resolve' in d) (d.resolve as (x: unknown) => void)(v)
  }

  function dismiss() {
    if (d.kind === 'confirm') resolveAndClose(false)
    else if ('resolve' in d) resolveAndClose(null)
    else closeDialog(d)
  }

  // The repository the dialog was opened on, even if another tab is in front once it is submitted.
  const repo = app.repo?.path

  async function submitTag(sha: string) {
    if (!value.trim() || !repo) return
    closeDialog(d)
    await app.run('Creating tag', () => api['git:createTag'](repo, value.trim(), sha, extra), { success: `Tag ${value.trim()} created.` })
  }
  async function submitStash() {
    if (!repo) return
    closeDialog(d)
    await app.run('Stashing', () => api['git:stash'](repo, value, flag), { success: 'Changes stashed.' })
  }
  async function submitRemote() {
    if (!value.trim() || !extra.trim() || !repo) return
    closeDialog(d)
    const added = await app.run('Adding remote', () => api['git:addRemote'](repo, value.trim(), extra.trim()).then(() => true), { success: `Remote ${value.trim()} added.` })
    // Fetched at once, not as a background fetch: one under a minute old would skip it, leaving
    // the new remote without branches (a compare with upstream/main failed).
    if (added && app.repo?.path === repo) await app.fetch()
  }
</script>

{#if d.kind === 'confirm'}
  <Modal title={d.title} icon={d.danger ? 'alert' : 'info'} tone={d.danger ? 'red' : 'green'} onclose={dismiss} onsubmit={() => resolveAndClose(true)}>
    <p class="msg">{d.message}</p>
    {#if d.details?.length}
      <ul class="details mono">{#each d.details as line}<li class="truncate">{line}</li>{/each}</ul>
    {/if}
    {#snippet footer()}
      <button type="button" class="btn btn-secondary" onclick={dismiss}>Cancel</button>
      <button type="submit" class="btn {d.kind === 'confirm' && d.danger ? 'btn-danger' : 'btn-primary'}">{d.kind === 'confirm' ? d.confirmLabel : ''}</button>
    {/snippet}
  </Modal>
{:else if d.kind === 'prompt'}
  <Modal title={d.title} icon="edit" onclose={dismiss} onsubmit={() => !error && resolveAndClose(value)}>
    {#if d.message}<p class="msg mono sm">{d.message}</p>{/if}
    <div class="field">
      <span class="label">{d.label}</span>
      <input class="input" class:mono={d.mono} bind:value placeholder={d.placeholder} spellcheck="false" />
      {#if error && value}<span class="err">{error}</span>{/if}
    </div>
    {#snippet footer()}
      <button type="button" class="btn btn-secondary" onclick={dismiss}>Cancel</button>
      <button type="submit" class="btn btn-primary" disabled={!!error}>{d.kind === 'prompt' ? d.confirmLabel : ''}</button>
    {/snippet}
  </Modal>
{:else if d.kind === 'choice'}
  <Modal title={d.title} icon="info" onclose={dismiss}>
    <p class="msg">{d.message}</p>
    {#snippet footer()}
      <button type="button" class="btn btn-ghost" onclick={dismiss}>Cancel</button>
      {#if d.kind === 'choice'}
        {#each d.options as o}
          <button type="button" class="btn btn-{o.variant ?? 'secondary'}" onclick={() => resolveAndClose(o.value)}>{o.label}</button>
        {/each}
      {/if}
    {/snippet}
  </Modal>
{:else if d.kind === 'askpass'}
  <Modal title={d.mode === 'confirm' ? 'Confirm connection' : 'Authentication required'} icon={d.mode === 'confirm' ? 'key' : 'lock'} tone="purple" width={500}
    onclose={dismiss} onsubmit={() => resolveAndClose(d.kind === 'askpass' && d.mode === 'confirm' ? 'yes' : value)}>
    <p class="msg pre">{d.prompt}</p>
    {#if d.mode !== 'confirm'}
      <div class="field">
        <div class="pw">
          <input class="input" type={d.mode === 'password' && !reveal ? 'password' : 'text'} bind:value autocomplete="off" spellcheck="false" />
          {#if d.mode === 'password'}
            <button type="button" class="btn btn-ghost sm" onclick={() => (reveal = !reveal)}>{reveal ? 'Hide' : 'Show'}</button>
          {/if}
        </div>
        <span class="hint">Sent only to git for this operation. Nothing is stored by the app.</span>
      </div>
    {/if}
    {#snippet footer()}
      <button type="button" class="btn btn-secondary" onclick={dismiss}>{d.kind === 'askpass' && d.mode === 'confirm' ? 'No' : 'Cancel'}</button>
      <button type="submit" class="btn btn-purple">{d.kind === 'askpass' && d.mode === 'confirm' ? 'Yes, trust it' : 'Continue'}</button>
    {/snippet}
  </Modal>
{:else if d.kind === 'tag'}
  <Modal title="Create tag" icon="tag" tone="amber" onclose={dismiss} onsubmit={() => d.kind === 'tag' && submitTag(d.sha)}>
    <div class="field"><span class="label">Name</span><input class="input mono" bind:value placeholder="v1.2.0" spellcheck="false" /></div>
    <div class="field"><span class="label">Message</span><textarea class="input" rows="3" bind:value={extra} placeholder="Optional. With a message the tag is annotated."></textarea></div>
    {#snippet footer()}
      <button type="button" class="btn btn-secondary" onclick={dismiss}>Cancel</button>
      <button type="submit" class="btn btn-primary" disabled={!value.trim()}>Create tag</button>
    {/snippet}
  </Modal>
{:else if d.kind === 'stash'}
  <Modal title="Stash changes" icon="stash" tone="purple" onclose={dismiss} onsubmit={submitStash}>
    <p class="msg">Put {app.files.length} changed file{app.files.length === 1 ? '' : 's'} aside and get a clean working tree. Restore them later from the sidebar.</p>
    <div class="field"><span class="label">Message</span><input class="input" bind:value placeholder="Optional description" /></div>
    <div class="field"><label class="check"><input type="checkbox" bind:checked={flag} />Include untracked files</label></div>
    {#snippet footer()}
      <button type="button" class="btn btn-secondary" onclick={dismiss}>Cancel</button>
      <button type="submit" class="btn btn-purple">Stash</button>
    {/snippet}
  </Modal>
{:else if d.kind === 'remote'}
  <Modal title="Add remote" icon="cloud" tone="blue" onclose={dismiss} onsubmit={submitRemote}>
    <div class="field"><span class="label">Name</span><input class="input mono" bind:value placeholder={app.refs.remotes.length ? 'upstream' : 'origin'} spellcheck="false" /></div>
    <div class="field">
      <span class="label">URL</span>
      <input class="input mono" bind:value={extra} placeholder="https://… or git@host:owner/repo.git" spellcheck="false" />
      <span class="hint">Works with GitHub, GitLab, Azure DevOps, Bitbucket, Gitea or any Git server.</span>
    </div>
    {#snippet footer()}
      <button type="button" class="btn btn-secondary" onclick={dismiss}>Cancel</button>
      <button type="submit" class="btn btn-primary" disabled={!value.trim() || !extra.trim()}>Add remote</button>
    {/snippet}
  </Modal>
{:else if d.kind === 'output'}
  <Modal title={d.title} icon="terminal" tone="red" width={760} onclose={() => closeDialog(d)}>
    {#if d.message}<p class="msg">{d.message}</p>{/if}
    <pre class="output mono">{d.text || '(no output)'}</pre>
    {#snippet footer()}
      <button type="button" class="btn btn-ghost" onclick={() => d.kind === 'output' && app.copy(d.text, 'Output copied')}>Copy</button>
      <span style="flex:1"></span>
      <button type="button" class="btn btn-secondary" onclick={() => closeDialog(d)}>Close</button>
      {#if d.kind === 'output'}
        {#each d.actions ?? [] as a}
          <button type="button" class="btn btn-{a.variant ?? 'secondary'}" onclick={() => { closeDialog(d); a.run() }}>{a.label}</button>
        {/each}
      {/if}
    {/snippet}
  </Modal>
{/if}

<style>
  .msg { margin: 0 0 4px; line-height: 1.55; }
  .msg.pre { white-space: pre-wrap; word-break: break-word; color: #e5e7eb; }
  .msg.sm { font-size: 11.5px; color: var(--text-faint); margin-bottom: 12px; }
  .details { margin: 10px 0 0; padding: 8px 12px; list-style: none; border-radius: var(--radius); background: var(--surface-1); border: 1px solid var(--border); font-size: 11.5px; max-height: 180px; overflow-y: auto; }
  .details li { padding: 1px 0; }
  .field { margin-top: 14px; }
  .err { font-size: 11.5px; color: var(--red); }
  .pw { display: flex; gap: 6px; align-items: center; }
  .output { margin: 8px 0 0; max-height: 52vh; overflow: auto; padding: 12px 14px; border-radius: var(--radius-lg); background: #070b10; border: 1px solid var(--border); color: #d1d5db; font-size: 11.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; user-select: text; }
</style>
