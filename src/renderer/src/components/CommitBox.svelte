<script lang="ts">
  import { untrack } from 'svelte'
  import Icon from './Icon.svelte'
  import { api, asError } from '@/lib/api'
  import { undoLastCommit } from '@/lib/commands'
  import { initials, MOD, tone } from '@/lib/format'
  import { app } from '@/lib/state.svelte'
  import { dialogs, menuAt, openDialog, showOutput, toast } from '@/lib/ui.svelte'
  import { rank } from '@/lib/fuzzy'
  import type { Author } from '@shared/types'

  let identity = $state<{ name: string; email: string; scope: string } | null>(null)
  let committing = $state(false)
  let summaryEl = $state<HTMLInputElement>()
  let amendBackup: { summary: string; body: string } | null = null
  let setup = $state<{ template: string; signing: boolean }>({ template: '', signing: false })
  let authors = $state.raw<Author[]>([])
  let authorsRepo = ''
  let coOpen = $state(false)
  let coQuery = $state('')
  let coInput = $state<HTMLInputElement>()

  // commit.template and commit.gpgsign, read once per repository.
  $effect(() => {
    const repo = app.repo?.path
    if (!repo) return
    const d = untrack(() => app.draft)
    api['git:commitSetup'](repo).then(s => {
      if (app.repo?.path !== repo) return
      setup = s
      if (s.template && !d.summary.trim() && !d.body.trim()) Object.assign(d, splitTemplate(s.template))
    }).catch(() => undefined)
  })

  /** A commit template's first line is the summary, the rest the description. */
  function splitTemplate(t: string): { summary: string; body: string } {
    const [first, ...rest] = t.split('\n')
    return { summary: first ?? '', body: rest.join('\n').trim() }
  }

  const coAuthors = $derived(app.draft.coAuthors ?? [])
  const coResults = $derived(
    rank(authors.filter(a => a.email !== identity?.email), coQuery, a => `${a.name} ${a.email}`, 12),
  )

  async function openCoAuthors() {
    coOpen = !coOpen
    coQuery = ''
    if (coOpen && app.repo) {
      // Asked each time (the main process caches it); another repository's people never show here.
      const repo = app.repo.path
      if (authorsRepo !== repo) authors = []
      const list = await api['git:authors'](repo).catch(() => null)
      if (list && app.repo?.path === repo) { authors = list; authorsRepo = repo }
    }
    queueMicrotask(() => coInput?.focus())
  }

  function toggleCoAuthor(a: { name: string; email: string }) {
    const line = `${a.name} <${a.email}>`
    draft.coAuthors = coAuthors.includes(line) ? coAuthors.filter(x => x !== line) : [...coAuthors, line]
    app.saveDrafts()
  }

  /** "Name <email>" typed by hand when the person never committed here. */
  function addTyped() {
    const m = /^(.+?)\s*<([^>]+@[^>]+)>$/.exec(coQuery.trim())
    if (m) { toggleCoAuthor({ name: m[1], email: m[2] }); coQuery = '' }
    else if (coResults[0]) toggleCoAuthor(coResults[0].item)
  }

  const TYPES = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert']
  /** Conventional Commits prefix: replaces an existing "type(scope)!: " or adds one. */
  function setType(e: MouseEvent) {
    menuAt(e.currentTarget as HTMLElement, TYPES.map(type => ({
      label: type, run: () => {
        const m = /^(\w+)(\([^)]*\))?(!)?:\s*/.exec(draft.summary)
        draft.summary = m ? `${type}${m[2] ?? ''}${m[3] ?? ''}: ${draft.summary.slice(m[0].length)}` : `${type}: ${draft.summary}`
        app.saveDrafts()
        summaryEl?.focus()
      },
    })))
  }

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
    const d = draft
    api['git:preparedMessage'](repo).then(msg => {
      if (!msg || d.summary.trim()) return
      const [summary, ...rest] = msg.split('\n')
      d.summary = summary
      d.body = rest.join('\n').trim()
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
    const d = draft
    if (on) {
      amendBackup = { summary: d.summary, body: d.body }
      if (!d.summary.trim()) {
        const msg = await api['git:lastCommitMessage'](app.repo!.path).catch(() => '')
        const [summary, ...rest] = msg.split('\n')
        d.summary = summary
        d.body = rest.join('\n').trim()
      }
    } else if (amendBackup) {
      d.summary = amendBackup.summary
      d.body = amendBackup.body
      amendBackup = null
    }
    d.amend = on
    app.saveDrafts()
  }

  async function commit(opts: { noVerify?: boolean } = {}) {
    if (!canCommit || !app.repo) return
    // Everything this commit belongs to, read before the first await: hooks can
    // run for a while, and another tab may be in front when git answers.
    const repo = app.repo.path
    const repoId = app.repo.id
    const d = draft
    const target = branch
    const template = setup.template
    const toStage = willStageAll ? app.unstaged.map(f => f.path) : []
    const trailers = coAuthors.map(c => `Co-authored-by: ${c}`).join('\n')
    const body = [d.body.trim(), trailers].filter(Boolean).join('\n\n')
    const message = body ? `${d.summary.trim()}\n\n${body}` : d.summary.trim()
    committing = true
    const end = app.beginBusy('Committing')
    try {
      if (toStage.length) await api['git:stage'](repo, toStage)
      const sha = await api['git:commit'](repo, message, d.amend, opts)
      Object.assign(d, { ...splitTemplate(template), amend: false, coAuthors: [] })
      amendBackup = null
      app.saveDrafts()
      toast('success', `Committed ${sha.slice(0, 7)} to ${target}.`, { label: 'Undo', run: () => undoLastCommit({ repoId }) })
    } catch (e) {
      const err = asError(e) as { message: string; code?: string; details?: string }
      // Hook output (linters, tests…) deserves more than a toast.
      if (err.code === 'HOOK_FAILED' || (err.details && err.details.split('\n').length > 3)) {
        showOutput(
          err.code === 'HOOK_FAILED' ? 'Commit blocked by a hook' : 'Commit failed',
          err.details ?? err.message,
          err.code === 'HOOK_FAILED' ? 'A pre-commit or commit-msg hook rejected the commit. Fix what it reports, or commit without running hooks.' : undefined,
          err.code === 'HOOK_FAILED' ? [{ label: 'Commit without hooks', variant: 'danger', run: () => (app.repo?.id === repoId ? commit({ noVerify: true }) : toast('info', 'Switch back to that repository to commit.')) }] : undefined,
        )
      } else toast('error', err.message)
    } finally {
      committing = false
      end()
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
  {#if coAuthors.length}
    <div class="chips">
      {#each coAuthors as c (c)}
        <span class="chip" title={c}><Icon name="user" size={11} />{c.replace(/ <.*$/, '')}<button onclick={() => { draft.coAuthors = coAuthors.filter(x => x !== c); app.saveDrafts() }} aria-label="Remove"><Icon name="x" size={10} /></button></span>
      {/each}
    </div>
  {/if}
  <div class="opts">
    <label class="check" title="Rewrite the last commit with the staged changes and this message">
      <input type="checkbox" checked={draft.amend} onchange={toggleAmend} disabled={!app.status?.hasCommits} />
      Amend
    </label>
    <button class="mini" onclick={setType} title="Conventional Commits type">type</button>
    <div class="co">
      <button class="mini" class:on={coAuthors.length} onclick={openCoAuthors} title="Add co-authors (Co-authored-by trailers)"><Icon name="user" size={11} />+</button>
      {#if coOpen}
        <div class="co-pop">
          <input bind:this={coInput} bind:value={coQuery} class="input" placeholder="Search, or Name <email>" spellcheck="false"
            onkeydown={e => { if (e.key === 'Enter') { e.preventDefault(); addTyped() } else if (e.key === 'Escape') { e.stopPropagation(); coOpen = false } }} />
          <div class="co-list">
            {#each coResults as { item } (item.email)}
              {@const on = coAuthors.includes(`${item.name} <${item.email}>`)}
              <button class="co-item" class:on onclick={() => toggleCoAuthor(item)}>
                <Icon name={on ? 'check' : 'user'} size={12} />
                <span class="grow truncate">{item.name} <span class="dim">{item.email}</span></span>
                <span class="dim">{item.commits}</span>
              </button>
            {:else}
              <div class="dim pad">{authors.length ? 'No match. Type Name <email> and press Enter.' : 'Loading…'}</div>
            {/each}
          </div>
        </div>
      {/if}
    </div>
    {#if setup.signing}<span class="signed" title="commit.gpgsign is on: commits are signed"><Icon name="lock" size={11} />Signed</span>{/if}
    <span class="grow"></span>
    <span class="hint"><kbd>{MOD}</kbd><kbd>↵</kbd></span>
  </div>
  <button class="btn btn-primary lg block" disabled={!canCommit} onclick={() => commit()} title={conflicts ? 'Resolve conflicts first' : ''}>
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
  .mini { height: 20px; padding: 0 6px; border: 1px solid var(--border); border-radius: 5px; background: var(--surface-1); color: var(--text-faint); font-size: 10.5px; font-weight: 700; display: inline-flex; align-items: center; gap: 2px; margin-left: 6px; }
  .mini:hover, .mini.on { color: #fff; background: var(--surface-3); }
  .co { position: relative; }
  .co-pop { position: absolute; bottom: calc(100% + 6px); left: 0; width: 320px; z-index: 50; padding: 6px; border-radius: var(--radius-lg); background: var(--overlay); border: 1px solid var(--border-strong); box-shadow: var(--shadow-pop); animation: popIn 120ms var(--ease-pop); }
  .co-list { max-height: 220px; overflow-y: auto; margin-top: 4px; }
  .co-item { width: 100%; display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 6px; border: none; border-radius: var(--radius-sm); background: none; color: #d1d5db; text-align: left; font-size: 12px; }
  .co-item:hover { background: var(--surface-2); }
  .co-item.on { color: #86efac; }
  .dim { color: var(--text-faint); font-size: 11px; }
  .pad { padding: 8px; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 4px 0 6px; border-radius: 10px; background: var(--purple-soft); color: #e9d5ff; font-size: 11px; }
  .chip button { border: none; background: none; color: inherit; display: flex; padding: 1px; border-radius: 50%; }
  .chip button:hover { background: rgba(255, 255, 255, 0.15); }
  .signed { display: inline-flex; align-items: center; gap: 3px; margin-left: 8px; font-size: 10.5px; font-weight: 700; color: #86efac; }
  .opts { display: flex; align-items: center; }
  .hint { display: flex; gap: 3px; opacity: 0.7; }
</style>
