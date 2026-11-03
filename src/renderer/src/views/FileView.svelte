<script lang="ts">
  import Icon from '@/components/Icon.svelte'
  import VirtualList from '@/components/VirtualList.svelte'
  import Resizer from '@/components/Resizer.svelte'
  import DiffView from '@/components/DiffView.svelte'
  import Code from '@/components/Code.svelte'
  import { langFor } from '@/lib/syntax'
  import type { Blame, BlameCommit, FileCommit } from '@shared/types'
  import { api, asError } from '@/lib/api'
  import { basename, dirname, fullDate, initials, relativeTime, shortSha, statusStyle, tone } from '@/lib/format'
  import { app } from '@/lib/state.svelte'
  import { contextMenu, toast, type MenuItem } from '@/lib/ui.svelte'

  const PAGE = 300
  let last = app.fileTarget!
  const target = $derived(app.fileTarget ?? last)
  $effect(() => { if (app.fileTarget) last = app.fileTarget })
  const lang = $derived(langFor(target.path))

  /* ─── History ─────────────────────────────────────────────────────────────── */

  let commits = $state.raw<FileCommit[]>([])
  let selected = $state<string | null>(null)
  let done = $state(false)
  let loading = $state(false)
  let width = $state(loadWidth())
  let historyKey = ''

  function loadWidth() {
    try { return +(localStorage.getItem('file-history-width') ?? 440) } catch { return 440 }
  }

  async function loadHistory(more = false) {
    const repo = app.repo?.path
    if (!repo || loading || (more && done)) return
    loading = true
    const key = `${repo}\0${target.path}`
    try {
      const page = await api['git:fileLog'](repo, target.path, more ? commits.length : 0, PAGE)
      if (key !== `${app.repo?.path}\0${app.fileTarget?.path}`) return
      commits = more ? [...commits, ...page] : page
      done = page.length < PAGE
      if (!more) selected = target.rev && page.some(c => c.sha === target.rev) ? target.rev : page[0]?.sha ?? null
    } catch (e) {
      toast('error', asError(e).message)
    } finally {
      loading = false
    }
  }

  $effect(() => {
    const key = `${app.repo?.path}\0${target.path}`
    if (target.tab !== 'history' || key === historyKey) return
    historyKey = key
    commits = []
    done = false
    loadHistory()
  })

  $effect(() => {
    if (target.tab === 'history' && target.rev && commits.some(c => c.sha === target.rev)) selected = target.rev
  })

  const current = $derived(commits.find(c => c.sha === selected) ?? null)

  function historyKeys(e: KeyboardEvent) {
    const i = commits.findIndex(c => c.sha === selected)
    if (e.key === 'ArrowDown') { e.preventDefault(); selected = commits[Math.min(i + 1, commits.length - 1)]?.sha ?? selected }
    if (e.key === 'ArrowUp') { e.preventDefault(); selected = commits[Math.max(i - 1, 0)]?.sha ?? selected }
  }

  /* ─── Blame ───────────────────────────────────────────────────────────────── */

  let blame = $state.raw<Blame | null>(null)
  let blameError = $state<string | null>(null)
  let hovered = $state<string | null>(null)
  let blameKey = ''
  let token = 0

  $effect(() => {
    const repo = app.repo?.path
    const key = `${repo}\0${target.path}\0${target.rev}`
    if (!repo || target.tab !== 'blame' || key === blameKey) return
    blameKey = key
    const t = ++token
    blame = null
    blameError = null
    api['git:blame'](repo, target.path, target.rev)
      .then(b => { if (t === token) blame = b })
      .catch(e => { if (t === token) blameError = asError(e).message })
  })

  /** One annotation per run of consecutive lines from the same commit. */
  const runStart = $derived(blame ? blame.lines.map((l, i) => i === 0 || blame!.lines[i - 1].sha !== l.sha) : [])
  const range = $derived.by(() => {
    if (!blame) return { min: 0, max: 1 }
    const dates = Object.values(blame.commits).filter(c => !c.uncommitted).map(c => c.date)
    return { min: Math.min(...dates), max: Math.max(...dates, Math.min(...dates) + 1) }
  })
  /** Recent lines glow green, old ones fade: a heatmap of the file's age. */
  function heat(c: BlameCommit): string {
    if (c.uncommitted) return 'var(--amber)'
    const t = (c.date - range.min) / (range.max - range.min)
    return `color-mix(in srgb, var(--green) ${Math.round(15 + t * 85)}%, #1f2937)`
  }
  const lineWidth = $derived(blame ? `calc(${blame.lines.reduce((m, l) => Math.max(m, l.text.length), 0)}ch + 360px)` : undefined)

  function blameMenu(c: BlameCommit): MenuItem[] {
    if (c.uncommitted) return [{ label: 'Uncommitted changes', icon: 'info', disabled: true, run: () => undefined }]
    return [
      { label: 'Show commit in history', icon: 'history', run: () => showCommit(c.sha) },
      { label: 'Show this file at this commit', icon: 'file', run: () => app.openFile(target.path, 'history', c.sha) },
      {
        label: 'Blame before this change', icon: 'undo', disabled: !c.previous,
        run: () => app.openFile(c.previous!.path, 'blame', c.previous!.sha),
      },
      'sep',
      { label: 'Copy SHA', icon: 'copy', hint: shortSha(c.sha), run: () => app.copy(c.sha, 'SHA copied') },
      ...(app.provider ? [{ label: 'Open on the web', icon: 'globe' as const, run: () => app.openProvider({ type: 'commit', sha: c.sha }) }] : []),
    ]
  }

  function showCommit(sha: string) {
    app.fileTarget = null
    app.view = 'history'
    app.selectedCommit = sha
  }

  function setTab(tab: 'history' | 'blame') {
    app.fileTarget = { ...target, tab }
  }
</script>

<div class="fv">
  <div class="bar">
    <button class="icon-btn" title="Back" onclick={() => app.closeFile()}><Icon name="arrowLeft" size={15} /></button>
    <Icon name="file" size={15} class="fi" />
    <span class="path truncate" title={target.path}>
      {#if dirname(target.path)}<span class="dir">{dirname(target.path)}/</span>{/if}<b>{basename(target.path)}</b>
    </span>
    {#if target.tab === 'blame'}
      <span class="badge {target.rev ? 'purple' : 'green'}">{target.rev ? `at ${shortSha(target.rev)}` : 'Working tree'}</span>
      {#if target.rev}<button class="btn btn-ghost sm" onclick={() => app.openFile(target.path, 'blame', null)}>Latest</button>{/if}
    {/if}
    <span class="grow"></span>
    <div class="segmented">
      <button class:on={target.tab === 'history'} onclick={() => setTab('history')}><Icon name="history" size={12} />History</button>
      <button class:on={target.tab === 'blame'} onclick={() => setTab('blame')}><Icon name="user" size={12} />Blame</button>
    </div>
    <button class="icon-btn sm" title="Open in editor" onclick={() => api['shell:editor'](app.repo!.path, target.path).catch(e => toast('error', e.message))}><Icon name="code" size={14} /></button>
  </div>

  {#if target.tab === 'history'}
    <div class="split">
      <section class="list" style="width:{width}px">
        {#if !commits.length}
          <div class="empty">{#if loading}<span class="spinner"></span>{:else}<h3>No history</h3><p>This file has no commits yet.</p>{/if}</div>
        {:else}
          <div class="list-wrap" role="listbox" tabindex="0" aria-label="File commits" onkeydown={historyKeys}>
            <VirtualList items={commits} rowHeight={46} class="vl" onEnd={() => loadHistory(true)}>
              {#snippet row(c: FileCommit)}
                {@const t = tone(c.author)}
                {@const st = statusStyle(c.status || 'M')}
                <div class="fc" class:sel={c.sha === selected} role="option" aria-selected={c.sha === selected} tabindex="-1"
                  onclick={() => (selected = c.sha)} onkeydown={() => undefined}
                  oncontextmenu={e => { selected = c.sha; contextMenu(e, [
                    { label: 'Show commit in history', icon: 'history', run: () => showCommit(c.sha) },
                    { label: 'Blame at this commit', icon: 'user', run: () => app.openFile(c.path, 'blame', c.sha) },
                    { label: 'Copy SHA', icon: 'copy', run: () => app.copy(c.sha, 'SHA copied') },
                  ]) }}>
                  <div class="row1">
                    <span class="subject truncate">{c.subject}</span>
                    <span class="st" style="color:{st.color}" title={st.label}>{st.letter}</span>
                  </div>
                  <div class="row2">
                    <span class="av" style="background:{t.bg};color:{t.fg}">{initials(c.author)}</span>
                    <span class="truncate">{c.author}</span>
                    <span class="dot">·</span>
                    <span title={fullDate(c.date)}>{relativeTime(c.date)}</span>
                    {#if c.oldPath}<span class="badge blue" title="{c.oldPath} → {c.path}">renamed</span>{/if}
                    <span class="grow"></span>
                    <span class="mono sha">{shortSha(c.sha)}</span>
                  </div>
                </div>
              {/snippet}
            </VirtualList>
          </div>
        {/if}
      </section>
      <Resizer value={width} min={300} max={800} onchange={v => (width = v)} oncommit={v => { try { localStorage.setItem('file-history-width', String(v)) } catch { /* ignore */ } }} />
      <section class="detail">
        {#if current}
          <div class="meta">
            <b class="truncate">{current.subject}</b>
            <button class="btn btn-ghost sm" onclick={() => showCommit(current!.sha)}>Open commit</button>
            <button class="btn btn-ghost sm" onclick={() => app.openFile(current!.path, 'blame', current!.sha)}>Blame here</button>
          </div>
          {#key current.sha}
            <DiffView source={{ kind: 'commit', sha: current.sha, path: current.path, oldPath: current.oldPath }} area="commit" />
          {/key}
        {:else}
          <div class="empty"><div class="empty-icon"><Icon name="history" size={24} /></div><h3>Select a commit</h3></div>
        {/if}
      </section>
    </div>
  {:else if blameError}
    <div class="empty"><h3>Blame unavailable</h3><p>{blameError}</p></div>
  {:else if !blame}
    <div class="empty"><span class="spinner"></span></div>
  {:else}
    <VirtualList items={blame.lines} rowHeight={20} width={lineWidth} class="blame mono" overscan={40}>
      {#snippet row(l, i: number)}
        {@const c = blame!.commits[l.sha]}
        {@const first = runStart[i]}
        <div class="bl" class:first class:hot={hovered === l.sha} role="presentation"
          onmouseenter={() => (hovered = l.sha)} oncontextmenu={e => contextMenu(e, blameMenu(c))}>
          <button class="ann" style="--heat:{heat(c)}" onclick={e => contextMenu(e, blameMenu(c))}
            title={c.uncommitted ? 'Not committed yet' : `${c.summary}\n${c.author} <${c.email}>\n${fullDate(c.date)}\n${c.sha}`}>
            {#if first}
              <span class="sha">{c.uncommitted ? '·······' : shortSha(c.sha)}</span>
              <span class="who truncate">{c.author}</span>
              <span class="when">{c.uncommitted ? 'now' : relativeTime(c.date)}</span>
              <span class="sum truncate">{c.summary}</span>
            {/if}
          </button>
          <span class="no">{i + 1}</span>
          <span class="code"><Code text={l.text} {lang} /></span>
        </div>
      {/snippet}
    </VirtualList>
  {/if}
</div>

<style>
  .fv { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .bar { display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 8px 0 6px; flex-shrink: 0; border-bottom: 1px solid var(--border); background: rgba(6, 10, 15, 0.3); }
  .bar :global(.fi) { color: var(--text-faint); }
  .path { font-size: 13px; }
  .path b { color: #fff; font-weight: 600; }
  .dir { color: var(--text-faint); }
  .segmented button { display: inline-flex; align-items: center; gap: 5px; }

  .split { flex: 1; min-height: 0; display: flex; }
  .list { flex-shrink: 0; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); }
  .list-wrap { flex: 1; min-height: 0; display: flex; }
  .list-wrap :global(.vl) { flex: 1; }
  .fc { height: 46px; padding: 5px 12px; display: flex; flex-direction: column; justify-content: center; gap: 3px; border-bottom: 1px solid rgba(255, 255, 255, 0.03); }
  .fc:hover { background: var(--surface-1); }
  .fc.sel { background: var(--surface-3); box-shadow: inset 2px 0 0 var(--green); }
  .row1, .row2 { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .subject { flex: 1; color: #e5e7eb; font-size: 12.5px; }
  .fc.sel .subject { color: #fff; }
  .st { font-size: 10px; font-weight: 800; }
  .row2 { font-size: 11px; color: var(--text-faint); }
  .av { width: 16px; height: 16px; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 7.5px; font-weight: 800; flex-shrink: 0; }
  .dot { color: var(--text-dim); }
  .sha { color: var(--text-dim); font-size: 10.5px; }
  .detail { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .meta { display: flex; align-items: center; gap: 6px; height: 34px; padding: 0 8px 0 12px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
  .meta b { flex: 1; color: #fff; font-size: 12.5px; }

  .fv :global(.blame) { flex: 1; min-height: 0; font-size: 12px; font-variant-ligatures: none; }
  .bl { display: flex; height: 20px; line-height: 20px; white-space: pre; tab-size: 4; }
  .bl.first { box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05); }
  .bl.hot { background: rgba(74, 222, 128, 0.05); }
  .ann {
    position: sticky; left: 0; z-index: 1; width: 340px; flex-shrink: 0; display: flex; align-items: center; gap: 8px;
    padding: 0 10px 0 12px; border: none; text-align: left; font: inherit; font-size: 11px; color: var(--text-faint);
    background: var(--panel-solid); border-left: 3px solid var(--heat); border-right: 1px solid var(--border);
  }
  .bl.hot .ann { background: #122119; }
  .ann .sha { color: #93c5fd; width: 56px; flex-shrink: 0; }
  .ann .who { width: 92px; flex-shrink: 0; color: var(--text-muted); font-family: var(--font-sans); }
  .ann .when { width: 66px; flex-shrink: 0; font-family: var(--font-sans); }
  .ann .sum { flex: 1; font-family: var(--font-sans); color: var(--text-faint); }
  .no { width: 48px; flex-shrink: 0; padding-right: 10px; text-align: right; color: var(--text-dim); font-size: 11px; }
  .code { color: #d6dae0; padding-right: 24px; }
</style>
