<script lang="ts">
  import Modal from './Modal.svelte'
  import CloneDialog from './dialogs/CloneDialog.svelte'
  import SettingsDialog from './dialogs/SettingsDialog.svelte'
  import BranchDialog from './dialogs/BranchDialog.svelte'
  import ShortcutsDialog from './dialogs/ShortcutsDialog.svelte'
  import { api } from '@/lib/api'
  import { app } from '@/lib/state.svelte'
  import { closeDialog, dialogs, type Dialog } from '@/lib/ui.svelte'

  const top = $derived(dialogs[dialogs.length - 1] as Dialog | undefined)

  /* Local form state for the simple dialogs, reset whenever the top dialog changes. */
  let value = $state('')
  let extra = $state('')
  let flag = $state(true)
  let reveal = $state(false)
  let last: Dialog | undefined
  $effect(() => {
    if (top === last) return
    last = top
    value = top?.kind === 'prompt' ? top.value : ''
    extra = ''
    flag = true
    reveal = false
  })

  const error = $derived(top?.kind === 'prompt' && top.validate ? top.validate(value) : null)

  function resolveAndClose(d: Dialog, v: unknown) {
    closeDialog(d)
    if ('resolve' in d) (d.resolve as (x: unknown) => void)(v)
  }

  function dismiss(d: Dialog) {
    if (d.kind === 'confirm') resolveAndClose(d, false)
    else if ('resolve' in d) resolveAndClose(d, null)
    else closeDialog(d)
  }

  async function submitTag(sha: string) {
    const d = top!
    if (!value.trim()) return
    closeDialog(d)
    await app.run('Creating tag', () => api['git:createTag'](app.repo!.path, value.trim(), sha, extra), { success: `Tag ${value.trim()} created.` })
  }
  async function submitStash() {
    const d = top!
    closeDialog(d)
    await app.run('Stashing', () => api['git:stash'](app.repo!.path, value, flag), { success: 'Changes stashed.' })
  }
  async function submitRemote() {
    const d = top!
    if (!value.trim() || !extra.trim()) return
    closeDialog(d)
    await app.run('Adding remote', () => api['git:addRemote'](app.repo!.path, value.trim(), extra.trim()), { success: `Remote ${value.trim()} added.` })
    app.fetch(true)
  }
</script>

{#if top}
  {#key top}
    {#if top.kind === 'confirm'}
      <Modal title={top.title} icon={top.danger ? 'alert' : 'info'} tone={top.danger ? 'red' : 'green'} onclose={() => dismiss(top)} onsubmit={() => resolveAndClose(top, true)}>
        <p class="msg">{top.message}</p>
        {#if top.details?.length}
          <ul class="details mono">{#each top.details as d}<li class="truncate">{d}</li>{/each}</ul>
        {/if}
        {#snippet footer()}
          <button type="button" class="btn btn-secondary" onclick={() => dismiss(top)}>Cancel</button>
          <button type="submit" class="btn {top.kind === 'confirm' && top.danger ? 'btn-danger' : 'btn-primary'}">{top.kind === 'confirm' ? top.confirmLabel : ''}</button>
        {/snippet}
      </Modal>
    {:else if top.kind === 'prompt'}
      <Modal title={top.title} icon="edit" onclose={() => dismiss(top)} onsubmit={() => !error && resolveAndClose(top, value)}>
        {#if top.message}<p class="msg mono sm">{top.message}</p>{/if}
        <div class="field">
          <span class="label">{top.label}</span>
          <input class="input" class:mono={top.mono} bind:value placeholder={top.placeholder} spellcheck="false" />
          {#if error && value}<span class="err">{error}</span>{/if}
        </div>
        {#snippet footer()}
          <button type="button" class="btn btn-secondary" onclick={() => dismiss(top)}>Cancel</button>
          <button type="submit" class="btn btn-primary" disabled={!!error}>{top.kind === 'prompt' ? top.confirmLabel : ''}</button>
        {/snippet}
      </Modal>
    {:else if top.kind === 'choice'}
      <Modal title={top.title} icon="info" onclose={() => dismiss(top)}>
        <p class="msg">{top.message}</p>
        {#snippet footer()}
          <button type="button" class="btn btn-ghost" onclick={() => dismiss(top)}>Cancel</button>
          {#if top.kind === 'choice'}
            {#each top.options as o}
              <button type="button" class="btn btn-{o.variant ?? 'secondary'}" onclick={() => resolveAndClose(top, o.value)}>{o.label}</button>
            {/each}
          {/if}
        {/snippet}
      </Modal>
    {:else if top.kind === 'askpass'}
      <Modal title={top.mode === 'confirm' ? 'Confirm connection' : 'Authentication required'} icon={top.mode === 'confirm' ? 'key' : 'lock'} tone="purple" width={500}
        onclose={() => dismiss(top)} onsubmit={() => resolveAndClose(top, top.kind === 'askpass' && top.mode === 'confirm' ? 'yes' : value)}>
        <p class="msg pre">{top.prompt}</p>
        {#if top.mode !== 'confirm'}
          <div class="field">
            <div class="pw">
              <input class="input" type={top.mode === 'password' && !reveal ? 'password' : 'text'} bind:value autocomplete="off" spellcheck="false" />
              {#if top.mode === 'password'}
                <button type="button" class="btn btn-ghost sm" onclick={() => (reveal = !reveal)}>{reveal ? 'Hide' : 'Show'}</button>
              {/if}
            </div>
            <span class="hint">Sent only to git for this operation. Nothing is stored by the app.</span>
          </div>
        {/if}
        {#snippet footer()}
          <button type="button" class="btn btn-secondary" onclick={() => dismiss(top)}>{top.kind === 'askpass' && top.mode === 'confirm' ? 'No' : 'Cancel'}</button>
          <button type="submit" class="btn btn-purple">{top.kind === 'askpass' && top.mode === 'confirm' ? 'Yes, trust it' : 'Continue'}</button>
        {/snippet}
      </Modal>
    {:else if top.kind === 'tag'}
      <Modal title="Create tag" icon="tag" tone="amber" onclose={() => dismiss(top)} onsubmit={() => top.kind === 'tag' && submitTag(top.sha)}>
        <div class="field"><span class="label">Name</span><input class="input mono" bind:value placeholder="v1.2.0" spellcheck="false" /></div>
        <div class="field"><span class="label">Message</span><textarea class="input" rows="3" bind:value={extra} placeholder="Optional. With a message the tag is annotated."></textarea></div>
        {#snippet footer()}
          <button type="button" class="btn btn-secondary" onclick={() => dismiss(top)}>Cancel</button>
          <button type="submit" class="btn btn-primary" disabled={!value.trim()}>Create tag</button>
        {/snippet}
      </Modal>
    {:else if top.kind === 'stash'}
      <Modal title="Stash changes" icon="stash" tone="purple" onclose={() => dismiss(top)} onsubmit={submitStash}>
        <p class="msg">Put {app.files.length} changed file{app.files.length === 1 ? '' : 's'} aside and get a clean working tree. Restore them later from the sidebar.</p>
        <div class="field"><span class="label">Message</span><input class="input" bind:value placeholder="Optional description" /></div>
        <div class="field"><label class="check"><input type="checkbox" bind:checked={flag} />Include untracked files</label></div>
        {#snippet footer()}
          <button type="button" class="btn btn-secondary" onclick={() => dismiss(top)}>Cancel</button>
          <button type="submit" class="btn btn-purple">Stash</button>
        {/snippet}
      </Modal>
    {:else if top.kind === 'remote'}
      <Modal title="Add remote" icon="cloud" tone="blue" onclose={() => dismiss(top)} onsubmit={submitRemote}>
        <div class="field"><span class="label">Name</span><input class="input mono" bind:value placeholder={app.refs.remotes.length ? 'upstream' : 'origin'} spellcheck="false" /></div>
        <div class="field">
          <span class="label">URL</span>
          <input class="input mono" bind:value={extra} placeholder="https://… or git@host:owner/repo.git" spellcheck="false" />
          <span class="hint">Works with GitHub, GitLab, Azure DevOps, Bitbucket, Gitea or any Git server.</span>
        </div>
        {#snippet footer()}
          <button type="button" class="btn btn-secondary" onclick={() => dismiss(top)}>Cancel</button>
          <button type="submit" class="btn btn-primary" disabled={!value.trim() || !extra.trim()}>Add remote</button>
        {/snippet}
      </Modal>
    {:else if top.kind === 'clone'}
      <CloneDialog onclose={() => closeDialog(top)} />
    {:else if top.kind === 'settings'}
      <SettingsDialog tab={top.tab} onclose={() => closeDialog(top)} />
    {:else if top.kind === 'branch'}
      <BranchDialog from={top.from} fromLabel={top.fromLabel} name={top.name} onclose={() => closeDialog(top)} />
    {:else if top.kind === 'shortcuts'}
      <ShortcutsDialog onclose={() => closeDialog(top)} />
    {/if}
  {/key}
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
</style>
