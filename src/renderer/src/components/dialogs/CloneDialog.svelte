<script lang="ts">
  import Modal from '../Modal.svelte'
  import Icon from '../Icon.svelte'
  import { api, asError } from '@/lib/api'
  import { app } from '@/lib/state.svelte'
  import { toast } from '@/lib/ui.svelte'

  let { onclose }: { onclose: () => void } = $props()

  const sep = app.platform === 'win32' ? '\\' : '/'
  let url = $state('')
  let parent = $state(loadParent())
  let name = $state('')
  let nameTouched = $state(false)
  let cloning = $state(false)
  let error = $state<string | null>(null)

  function loadParent(): string {
    try {
      const saved = localStorage.getItem('clone-parent')
      if (saved) return saved
    } catch { /* ignore */ }
    return app.home ? [app.home, 'source', 'repos'].join(app.platform === 'win32' ? '\\' : '/') : ''
  }

  /** "https://github.com/owner/repo.git" → "repo"; also scp-like and Azure URLs. */
  function repoName(u: string): string {
    const clean = u.trim().replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/, '')
    const last = clean.split(/[/:]/).pop() ?? ''
    return last.replace(/[^\w.-]/g, '-')
  }

  function hostLabel(u: string): string | null {
    const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)/i.exec(u.trim())
    if (!m || !u.includes('/') && !u.includes(':')) return null
    const h = m[1].toLowerCase()
    if (h.includes('github')) return 'GitHub'
    if (h.includes('gitlab')) return 'GitLab'
    if (h.includes('dev.azure.com') || h.endsWith('visualstudio.com')) return 'Azure DevOps'
    if (h.includes('bitbucket')) return 'Bitbucket'
    if (h === 'codeberg.org') return 'Codeberg'
    if (h.includes('gitea') || h.includes('forgejo')) return 'Gitea'
    return h
  }

  $effect(() => {
    if (!nameTouched) name = repoName(url)
  })

  const provider = $derived(hostLabel(url))
  const target = $derived(parent && name ? `${parent.replace(/[\\/]+$/, '')}${sep}${name}` : '')
  const valid = $derived(!!url.trim() && !!parent.trim() && !!name.trim())

  async function choose() {
    const p = await api['dialog:pickFolder']('Clone into folder')
    if (p) parent = p
  }

  async function clone() {
    if (!valid || cloning) return
    cloning = true
    error = null
    const end = app.beginBusy('Cloning')
    try {
      try { localStorage.setItem('clone-parent', parent) } catch { /* ignore */ }
      const entry = await api['repo:clone'](url.trim(), parent.trim(), name.trim())
      onclose()
      await app.openRepo(entry.id)
      app.lastFetched = Date.now()
      toast('success', `Cloned ${entry.name}.`)
    } catch (e) {
      error = asError(e).message
    } finally {
      cloning = false
      end()
    }
  }

  async function paste() {
    try {
      const text = await api['clipboard:read']()
      if (/^(https?:\/\/|git@|ssh:\/\/)/.test(text.trim())) url = text.trim()
    } catch { /* clipboard unavailable */ }
  }
  $effect(() => {
    paste()
  })
</script>

<Modal title="Clone a repository" icon="download" width={540} onclose={() => !cloning && onclose()} onsubmit={clone}>
  <div class="field">
    <span class="label">Repository URL</span>
    <div class="url">
      <input class="input mono" bind:value={url} placeholder="https://github.com/owner/repo.git  or  git@host:owner/repo.git" spellcheck="false" disabled={cloning} />
      {#if provider}<span class="badge green">{provider}</span>{/if}
    </div>
    <span class="hint">HTTPS sign-in goes through Git Credential Manager; SSH uses your keys and agent.</span>
  </div>
  <div class="field">
    <span class="label">Location</span>
    <div class="url">
      <input class="input mono" bind:value={parent} spellcheck="false" disabled={cloning} />
      <button type="button" class="btn btn-secondary" onclick={choose} disabled={cloning}><Icon name="folder" size={14} />Choose…</button>
    </div>
  </div>
  <div class="field">
    <span class="label">Folder name</span>
    <input class="input mono" bind:value={name} oninput={() => (nameTouched = true)} spellcheck="false" disabled={cloning} />
    {#if target}<span class="hint mono">{target}</span>{/if}
  </div>

  {#if cloning}
    <div class="progress">
      <div class="row"><span class="spinner"></span><span class="grow">{app.progress?.phase ?? 'Connecting'}…</span><span class="mono">{app.progress?.percent ?? 0}%</span></div>
      <div class="track"><div class="fill" style="width:{app.progress?.percent ?? 2}%"></div></div>
    </div>
  {/if}
  {#if error}<div class="error">{error}</div>{/if}

  {#snippet footer()}
    <button type="button" class="btn btn-secondary" onclick={onclose} disabled={cloning}>Cancel</button>
    <button type="submit" class="btn btn-primary" disabled={!valid || cloning}>
      {#if cloning}<span class="spinner"></span>{/if}Clone
    </button>
  {/snippet}
</Modal>

<style>
  .field + .field { margin-top: 14px; }
  .url { display: flex; gap: 6px; align-items: center; }
  .progress { margin-top: 16px; display: flex; flex-direction: column; gap: 8px; color: #bbf7d0; font-size: 12px; }
  .track { height: 4px; border-radius: 2px; background: var(--surface-3); overflow: hidden; }
  .fill { height: 100%; background: var(--green); transition: width 200ms; }
  .error { margin-top: 14px; padding: 10px 12px; border-radius: var(--radius); background: var(--red-soft); border: 1px solid rgba(239, 68, 68, 0.3); color: #fecaca; font-size: 12px; white-space: pre-wrap; user-select: text; }
</style>
