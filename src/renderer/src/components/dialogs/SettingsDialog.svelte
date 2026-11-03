<script lang="ts">
  import Modal from '../Modal.svelte'
  import { api, asError } from '@/lib/api'
  import { app } from '@/lib/state.svelte'
  import { toast } from '@/lib/ui.svelte'
  import type { PullMode } from '@shared/types'

  let { tab: initialTab = 'general', onclose }: { tab?: string; onclose: () => void } = $props()
  // svelte-ignore state_referenced_locally
  let tab = $state(initialTab)
  let perf = $state<{ enabled: boolean; supported: boolean; files: number } | null>(null)
  $effect(() => {
    if (app.repo) api['repo:fsmonitor'](app.repo.path).then(p => (perf = p)).catch(() => (perf = null))
  })

  let gName = $state('')
  let gEmail = $state('')
  let lName = $state('')
  let lEmail = $state('')
  let localScope = $state(false)
  let editor = $state(app.settings.editorCommand)
  let terminal = $state(app.settings.terminalCommand)

  $effect(() => {
    api['git:identity'](null).then(id => { gName = id.name; gEmail = id.email })
    if (app.repo) {
      api['git:identity'](app.repo.path).then(id => {
        localScope = id.scope === 'local'
        if (localScope) { lName = id.name; lEmail = id.email }
      })
    }
  })

  async function saveIdentity() {
    try {
      await api['git:setIdentity'](null, { name: gName.trim(), email: gEmail.trim() })
      if (app.repo && localScope && lName.trim()) await api['git:setIdentity'](app.repo.path, { name: lName.trim(), email: lEmail.trim() })
      toast('success', 'Git identity saved.')
    } catch (e) {
      toast('error', asError(e).message)
    }
  }

  function saveIntegrations() {
    app.updateSettings({ editorCommand: editor.trim(), terminalCommand: terminal.trim() })
    toast('success', 'Integrations saved.')
  }

  const tabs = [
    { id: 'general', label: 'General' },
    { id: 'git', label: 'Git identity' },
    { id: 'integrations', label: 'Integrations' },
  ]
</script>

<Modal title="Settings" icon="cog" width={600} {onclose}>
  <div class="layout">
    <nav>
      {#each tabs as t}
        <button type="button" class:on={tab === t.id} onclick={() => (tab = t.id)}>{t.label}</button>
      {/each}
    </nav>
    <div class="pane">
      {#if tab === 'general'}
        <div class="field">
          <span class="label">Auto fetch</span>
          <select class="input" value={String(app.settings.autoFetchMinutes)} onchange={e => app.updateSettings({ autoFetchMinutes: +(e.target as HTMLSelectElement).value })}>
            <option value="0">Off</option>
            <option value="2">Every 2 minutes</option>
            <option value="5">Every 5 minutes</option>
            <option value="10">Every 10 minutes</option>
            <option value="30">Every 30 minutes</option>
          </select>
          <span class="hint">Keeps ahead/behind counts fresh. Only runs while the window is visible.</span>
        </div>
        <div class="field">
          <span class="label">Pull strategy</span>
          <div class="segmented">
            {#each [['merge', 'Merge'], ['rebase', 'Rebase'], ['ff-only', 'Fast-forward only']] as [v, l]}
              <button type="button" class:on={app.settings.pullMode === v} onclick={() => app.updateSettings({ pullMode: v as PullMode })}>{l}</button>
            {/each}
          </div>
          <span class="hint">Local changes are stashed and restored automatically around a pull.</span>
        </div>
        <div class="field">
          <label class="check"><input type="checkbox" checked={app.settings.confirmDiscard} onchange={e => app.updateSettings({ confirmDiscard: (e.target as HTMLInputElement).checked })} />Ask before discarding changes</label>
        </div>
        <div class="field">
          <label class="check"><input type="checkbox" checked={app.settings.syntaxHighlight} onchange={e => app.updateSettings({ syntaxHighlight: (e.target as HTMLInputElement).checked })} />Syntax highlighting in diffs, blame and conflicts</label>
        </div>
        {#if app.repo && perf}
          <div class="field">
            <span class="label">Performance · {app.repo.name}</span>
            <label class="check" title={perf.supported ? '' : 'Needs Git 2.36+ on Windows or macOS'}>
              <input type="checkbox" checked={perf.enabled} disabled={!perf.supported}
                onchange={async e => { const on = (e.target as HTMLInputElement).checked; await api['repo:setFsmonitor'](app.repo!.path, on); perf = { ...perf!, enabled: on } }} />
              Git file system monitor and untracked cache
            </label>
            <span class="hint">{perf.files.toLocaleString('en')} tracked files. Recommended above ~20,000: status stops scanning the whole tree.</span>
          </div>
        {/if}
      {:else if tab === 'git'}
        <p class="intro">Who your commits are attributed to. Most providers match this email to your account.</p>
        <div class="field"><span class="label">Name</span><input class="input" bind:value={gName} placeholder="Jane Doe" /></div>
        <div class="field"><span class="label">Email</span><input class="input" bind:value={gEmail} placeholder="jane@example.com" /></div>
        {#if app.repo}
          <div class="field">
            <label class="check"><input type="checkbox" bind:checked={localScope} />Use a different identity for {app.repo.name}</label>
          </div>
          {#if localScope}
            <div class="field"><span class="label">Name for this repository</span><input class="input" bind:value={lName} /></div>
            <div class="field"><span class="label">Email for this repository</span><input class="input" bind:value={lEmail} /></div>
          {/if}
        {/if}
        <div class="actions"><button type="button" class="btn btn-primary" onclick={saveIdentity}>Save identity</button></div>
      {:else}
        <div class="field">
          <span class="label">Editor command</span>
          <input class="input mono" bind:value={editor} placeholder="Auto-detect (code, cursor, zed, …)" spellcheck="false" />
          <span class="hint">The path is appended, or replaces <code>{'{path}'}</code> if present. Example: <code>code -n</code></span>
        </div>
        <div class="field">
          <span class="label">Terminal command</span>
          <input class="input mono" bind:value={terminal} placeholder={app.platform === 'win32' ? 'Windows Terminal, else PowerShell' : 'System terminal'} spellcheck="false" />
          <span class="hint">Example: <code>"C:\Program Files\Git\git-bash.exe" --cd={'{path}'}</code></span>
        </div>
        <div class="actions"><button type="button" class="btn btn-primary" onclick={saveIntegrations}>Save integrations</button></div>
      {/if}
    </div>
  </div>
</Modal>

<style>
  .layout { display: flex; gap: 18px; min-height: 300px; padding-bottom: 16px; }
  nav { display: flex; flex-direction: column; gap: 2px; width: 140px; flex-shrink: 0; }
  nav button { text-align: left; height: 30px; padding: 0 10px; border: none; border-radius: var(--radius); background: none; color: var(--text-muted); font-weight: 500; }
  nav button:hover { background: var(--surface-2); color: #fff; }
  nav button.on { background: var(--surface-3); color: #fff; }
  .pane { flex: 1; min-width: 0; }
  .field + .field { margin-top: 16px; }
  .intro { margin: 0 0 14px; font-size: 12.5px; }
  .actions { margin-top: 18px; display: flex; justify-content: flex-end; }
  select.input { appearance: auto; }
  code { font-family: var(--font-mono); font-size: 11px; color: #d1d5db; background: var(--surface-2); padding: 1px 4px; border-radius: 4px; }
</style>
