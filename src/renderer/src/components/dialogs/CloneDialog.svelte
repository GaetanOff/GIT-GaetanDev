<script lang="ts">
  import Modal from '../Modal.svelte'
  import Icon from '../Icon.svelte'
  import { api, asError } from '@/lib/api'
  import { app } from '@/lib/state.svelte'
  import { dismissToast, toast } from '@/lib/ui.svelte'

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

  /**
   * Closed while cloning: the clone goes on, with a toast that says so and can still cancel it, and
   * its outcome comes as a toast. It is not "busy" work: that disabled Sync, the Undo view and
   * auto-fetch in every tab until the clone ended.
   */
  let hidden = false
  let running: number | null = null
  /** Where the clone under way goes, which names it to cancel it: the fields may change meanwhile. */
  let into = { parent: '', name: '' }
  const cancel = () => void api['repo:cancelClone'](into.parent, into.name)

  async function clone() {
    if (!valid || cloning) return
    cloning = true
    error = null
    into = { parent: parent.trim(), name: name.trim() }
    try {
      try { localStorage.setItem('clone-parent', parent) } catch { /* ignore */ }
      const entry = await api['repo:clone'](url.trim(), into.parent, into.name)
      if (hidden) {
        // In the list of repositories (Ctrl+T, Welcome) like any other, though not opened: the user is
        // at work elsewhere by now, and the new repository does not take the front unasked.
        app.repos = await api['repo:list']().catch(() => app.repos)
        toast('success', `Cloned ${entry.name}.`, { label: 'Open', run: () => void app.openRepo(entry.id) })
        return
      }
      onclose()
      await app.openRepo(entry.id)
      app.lastFetched = Date.now()
      toast('success', `Cloned ${entry.name}.`)
    } catch (e) {
      const err = asError(e)
      if (err.code === 'CANCELLED') toast('info', err.message)
      else if (hidden) toast('error', `Clone of ${into.name} failed: ${err.message}`)
      else error = err.message
    } finally {
      cloning = false
      if (running !== null) dismissToast(running)
    }
  }

  /** Closing never waits for a long clone: it carries on, and can still be cancelled from its toast. */
  function close() {
    if (cloning && !hidden) {
      hidden = true
      running = toast('info', `Cloning ${into.name}…`, { label: 'Cancel clone', run: cancel }, Infinity)
    }
    onclose()
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

<Modal title="Clone a repository" icon="download" width={540} onclose={close} onsubmit={clone}>
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

  {#if cloning}<span class="hint">You can close this window: the clone goes on, and says when it is done.</span>{/if}

  {#snippet footer()}
    {#if cloning}
      <button type="button" class="btn btn-danger" onclick={cancel}>Cancel clone</button>
      <button type="button" class="btn btn-secondary" onclick={close}>Close</button>
    {:else}
      <button type="button" class="btn btn-secondary" onclick={close}>Cancel</button>
    {/if}
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
