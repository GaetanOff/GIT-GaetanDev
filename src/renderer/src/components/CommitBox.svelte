<script lang="ts">
  import Icon from './Icon.svelte'
  import { api, asError } from '@/lib/api'
  import { undoLastCommit } from '@/lib/commands'
  import { initials, MOD, tone } from '@/lib/format'
  import { app } from '@/lib/state.svelte'
  import { dialogs, openDialog, toast } from '@/lib/ui.svelte'

  let identity = $state<{ name: string; email: string; scope: string } | null>(null)
  let committing = $state(false)
  let summaryEl = $state<HTMLInputElement>()
  let amendBackup: { summary: string; body: string } | null = null

  // Re-read after any dialog closes: the identity may have been edited in Settings.
  $effect(() => {
    const repo = app.repo?.path
    if (!repo || dialogs.length) return
    api['git:identity'](repo).then(id => (identity = id)).catch(() => (identity = null))
  })

  const draft = $derived(app.draft)

  // A merge, squash or cherry-pick comes with a message from git: offer it.
  let prefilledFor = ''
  $effect(() => {
    const repo = app.repo?.path
    const key = `${repo}|${app.status?.operation}|${app.status?.head}`
    if (!repo || !app.status || key === prefilledFor || draft.summary.trim()) return
    prefilledFor = key
    api['git:preparedMessage'](repo).then(msg => {
      if (!msg || draft.summary.trim()) return
      const [summary, ...rest] = msg.split('\n')
      draft.summary = summary
      draft.body = rest.join('\n').trim()
    }).catch(() => undefined)
  })
  const stagedCount = $derived(app.staged.length)
  const unstagedCount = $derived(app.unstaged.length)
  const conflicts = $derived(app.conflicted.length)
  const op = $derived(app.status?.operation)
  const willStageAll = $derived(!stagedCount && unstagedCount > 0 && !draft.amend)
  const branch = $derived(app.status?.branch ?? 'detached HEAD')
  const summaryLen = $derived(draft.summary.length)

  const canCommit = $derived(
    !committing && !conflicts && !!identity?.name && !!draft.summary.trim() &&
      (stagedCount > 0 || willStageAll || draft.amend || op === 'merge'),
  )

  const buttonLabel = $derived.by(() => {
    if (draft.amend) return 'Amend last commit'
    if (op === 'merge' && !stagedCount) return 'Commit merge'
    if (willStageAll) return `Commit all ${unstagedCount} to ${branch}`
    return `Commit ${stagedCount || ''} to ${branch}`.replace('  ', ' ')
  })

  async function toggleAmend(e: Event) {
    const on = (e.target as HTMLInputElement).checked
    if (on) {
      amendBackup = { summary: draft.summary, body: draft.body }
      if (!draft.summary.trim()) {
        const msg = await api['git:lastCommitMessage'](app.repo!.path).catch(() => '')
        const [summary, ...rest] = msg.split('\n')
        draft.summary = summary
        draft.body = rest.join('\n').trim()
      }
    } else if (amendBackup) {
      draft.summary = amendBackup.summary
      draft.body = amendBackup.body
      amendBackup = null
    }
    draft.amend = on
    app.saveDrafts()
  }

  async function commit() {
    if (!canCommit || !app.repo) return
    const repo = app.repo.path
    const message = draft.body.trim() ? `${draft.summary.trim()}\n\n${draft.body.trim()}` : draft.summary.trim()
    committing = true
    app.busy = 'Committing'
    try {
      if (willStageAll) await api['git:stage'](repo, app.unstaged.map(f => f.path))
      const sha = await api['git:commit'](repo, message, draft.amend)
      Object.assign(draft, { summary: '', body: '', amend: false })
      amendBackup = null
      app.saveDrafts()
      toast('success', `Committed ${sha.slice(0, 7)} to ${branch}.`, { label: 'Undo', run: undoLastCommit })
    } catch (e) {
      toast('error', asError(e).message)
    } finally {
      committing = false
      app.busy = null
      await app.refreshAll()
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      commit()
    }
  }

  function autosize(el: HTMLTextAreaElement) {
    const fit = () => {
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 180)}px`
    }
    fit()
    $effect(() => {
      void draft.body
      fit()
    })
  }

  // Ctrl+Enter from anywhere in the Changes view commits; Ctrl+L focuses the summary.
  function onWindowKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l' && app.view === 'changes') {
      e.preventDefault()
      summaryEl?.focus()
    }
  }
  const t = $derived(tone(identity?.name || '?'))
</script>

<svelte:window onkeydown={onWindowKey} />

<div class="box">
  {#if identity && !identity.name}
    <button class="warn" onclick={() => openDialog({ kind: 'settings', tab: 'git' })}>
      <Icon name="alert" size={14} />
      <span>Set your Git name and email before committing</span>
    </button>
  {/if}
  <div class="summary-row">
    <span class="avatar" style="background:{t.bg};color:{t.fg}" title="{identity?.name} <{identity?.email}>">{initials(identity?.name || '?')}</span>
    <input
      bind:this={summaryEl}
      class="input summary"
      placeholder={op === 'merge' ? 'Merge commit summary' : 'Summary (required)'}
      bind:value={draft.summary}
      oninput={() => app.saveDrafts()}
      onkeydown={onKey}
      spellcheck="true"
    />
    {#if summaryLen > 50}
      <span class="len" class:over={summaryLen > 72} title="Keep summaries under 72 characters">{72 - summaryLen}</span>
    {/if}
  </div>
  <textarea
    use:autosize
    class="input body"
    rows="3"
    placeholder="Description"
    bind:value={draft.body}
    oninput={() => app.saveDrafts()}
    onkeydown={onKey}
  ></textarea>
  <div class="opts">
    <label class="check" title="Rewrite the last commit with the staged changes and this message">
      <input type="checkbox" checked={draft.amend} onchange={toggleAmend} disabled={!app.status?.hasCommits} />
      Amend
    </label>
    <span class="grow"></span>
    <span class="hint"><kbd>{MOD}</kbd><kbd>↵</kbd></span>
  </div>
  <button class="btn btn-primary lg block" disabled={!canCommit} onclick={commit} title={conflicts ? 'Resolve conflicts first' : ''}>
    {#if committing}<span class="spinner"></span>{:else}<Icon name="commit" size={15} />{/if}
    <span class="truncate">{buttonLabel}</span>
  </button>
</div>

<style>
  .box { flex-shrink: 0; display: flex; flex-direction: column; gap: 8px; padding: 10px 12px 12px; border-top: 1px solid var(--border); background: rgba(6, 10, 15, 0.35); }
  .warn {
    display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: var(--radius); border: 1px solid rgba(252, 211, 77, 0.3);
    background: var(--amber-soft); color: #fde68a; font-size: 12px; text-align: left;
  }
  .summary-row { position: relative; display: flex; align-items: center; gap: 8px; }
  .avatar { width: 28px; height: 28px; border-radius: var(--radius); flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 800; }
  .summary { font-weight: 600; padding-right: 36px; }
  .len { position: absolute; right: 9px; font-size: 10.5px; font-weight: 700; color: var(--text-faint); font-variant-numeric: tabular-nums; }
  .len.over { color: var(--red); }
  .body { min-height: 58px; font-size: 12.5px; }
  .opts { display: flex; align-items: center; }
  .hint { display: flex; gap: 3px; opacity: 0.7; }
</style>
