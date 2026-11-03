<script lang="ts">
  import Icon from './Icon.svelte'
  import DiffView from './DiffView.svelte'
  import VirtualList from './VirtualList.svelte'
  import type { CommitDetail, CommitFile, DiffSource } from '@shared/types'
  import { commitMenu } from '@/lib/actions'
  import { api, asError } from '@/lib/api'
  import { basename, dirname, fullDate, initials, relativeTime, shortSha, statusStyle, tone } from '@/lib/format'
  import { app } from '@/lib/state.svelte'
  import { contextMenu, menuAt } from '@/lib/ui.svelte'
  import type { Snippet } from 'svelte'

  let { sha, stash, actions }: { sha?: string; stash?: number; actions?: Snippet } = $props()

  let detail = $state.raw<CommitDetail | null>(null)
  let error = $state<string | null>(null)
  let file = $state<string | null>(null)
  let filesHeight = $state(loadHeight())
  let fileList = $state<VirtualList<CommitFile>>()
  let token = 0

  function loadHeight() {
    try { return +(localStorage.getItem('detail-files-height') ?? 180) } catch { return 180 }
  }

  $effect(() => {
    const repo = app.repo?.path
    const s = sha
    const st = stash
    if (!repo) return
    const t = ++token
    const req = st !== undefined ? api['git:stashFiles'](repo, st) : api['git:commit:detail'](repo, s!)
    req.then(d => {
      if (t !== token) return
      detail = d
      error = null
      if (!file || !d.files.some(f => f.path === file)) file = d.files[0]?.path ?? null
    }).catch(e => {
      if (t === token) error = asError(e).message
    })
  })

  const current = $derived(detail?.files.find(f => f.path === file) ?? null)
  const source = $derived.by((): DiffSource | null => {
    if (!current || !detail) return null
    if (stash !== undefined) return { kind: 'stash', index: stash, path: current.path, untracked: current.status === '?' }
    return { kind: 'commit', sha: detail.sha, path: current.path, oldPath: current.oldPath }
  })
  const totals = $derived(detail?.files.reduce((a, f) => ({ add: a.add + f.additions, del: a.del + f.deletions }), { add: 0, del: 0 }))
  const t = $derived(tone(detail?.author ?? ''))
  const coAuthored = $derived(detail && detail.committer !== detail.author ? detail.committer : null)

  function fileKey(e: KeyboardEvent) {
    if (!detail) return
    const i = detail.files.findIndex(f => f.path === file)
    const to = e.key === 'ArrowDown' ? Math.min(i + 1, detail.files.length - 1) : e.key === 'ArrowUp' ? Math.max(i - 1, 0) : -1
    if (to < 0) return
    e.preventDefault()
    file = detail.files[to]?.path ?? file
    fileList?.reveal(to)
  }

  function fileMenu(e: MouseEvent, f: CommitFile) {
    file = f.path
    contextMenu(e, [
      ...(stash === undefined && f.status !== 'D' ? [
        { label: 'File history', icon: 'history' as const, run: () => app.openFile(f.path, 'history', detail!.sha) },
        { label: 'Blame at this commit', icon: 'user' as const, run: () => app.openFile(f.path, 'blame', detail!.sha) },
      ] : []),
      { label: 'Copy path', icon: 'copy', run: () => app.copy(f.path, 'Path copied') },
      ...(app.provider && detail && stash === undefined ? [{ label: 'Open file on the web', icon: 'globe' as const, run: () => app.openProvider({ type: 'file', ref: detail!.sha, path: f.path }) }] : []),
      { label: 'Show in Explorer', icon: 'folder', run: () => api['shell:reveal'](app.repo!.path, f.path) },
    ])
  }

  function dragFiles(e: PointerEvent) {
    const startY = e.clientY
    const start = filesHeight
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => (filesHeight = Math.max(60, Math.min(600, start + ev.clientY - startY)))
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      try { localStorage.setItem('detail-files-height', String(filesHeight)) } catch { /* ignore */ }
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }
</script>

<div class="detail">
  {#if error}
    <div class="empty"><h3>Could not load this commit</h3><p>{error}</p></div>
  {:else if detail}
    <header class="meta">
      <div class="top">
        <h2 class="subject">{detail.subject || '(no message)'}</h2>
        {#if actions}{@render actions()}{:else}
          <button class="icon-btn" title="Commit actions" onclick={e => menuAt(e.currentTarget as HTMLElement, commitMenu(detail!))}><Icon name="more" size={16} /></button>
        {/if}
      </div>
      {#if detail.body}<pre class="body">{detail.body}</pre>{/if}
      <div class="facts">
        <span class="who">
          <span class="av" style="background:{t.bg};color:{t.fg}">{initials(detail.author)}</span>
          <b>{detail.author}</b>
          <span class="dim">{detail.email}</span>
        </span>
        <span class="dim" title={fullDate(detail.date)}>{relativeTime(detail.date)}</span>
        {#if coAuthored}<span class="dim">committed by {coAuthored}</span>{/if}
        {#if detail.signature}
          {@const sg = detail.signature}
          <span class="sig {sg.status === 'G' ? 'ok' : sg.status === 'U' ? 'warn' : sg.status === 'B' || sg.status === 'R' ? 'bad' : 'warn'}"
            title="{sg.signer ? `Signed by ${sg.signer}` : 'Signed'}{sg.key ? `\nKey ${sg.key}` : ''}">
            <Icon name="lock" size={11} />
            {sg.status === 'G' ? 'Verified' : sg.status === 'U' ? 'Signed, untrusted key' : sg.status === 'B' ? 'Bad signature' : sg.status === 'R' ? 'Revoked key' : sg.status === 'X' || sg.status === 'Y' ? 'Expired' : 'Signed, unverified'}
          </span>
        {/if}
      </div>
      <div class="facts">
        {#if stash === undefined}
          <button class="chip mono" title="Copy full SHA" onclick={() => app.copy(detail!.sha, 'SHA copied')}><Icon name="commit" size={12} />{shortSha(detail.sha)}<Icon name="copy" size={11} /></button>
          {#each detail.parents as p, i}
            <button class="chip mono parent" title="Go to parent" onclick={() => (app.selectedCommit = p)}>{i === 0 ? 'parent' : 'merged'} {shortSha(p)}</button>
          {/each}
        {/if}
        {#if totals}
          <span class="stat"><Icon name="file" size={12} />{detail.files.length} file{detail.files.length === 1 ? '' : 's'}</span>
          <span class="stat a">+{totals.add}</span>
          <span class="stat d">−{totals.del}</span>
        {/if}
        {#if app.provider && stash === undefined}
          <button class="chip" onclick={() => app.openProvider({ type: 'commit', sha: detail!.sha })}><Icon name="external" size={12} />{app.provider.label}</button>
        {/if}
      </div>
    </header>

    <div class="files" style="height:{filesHeight}px" role="listbox" tabindex="0" aria-label="Files" onkeydown={fileKey}>
      <!-- Virtualized: a vendoring or import commit can touch tens of thousands of files. -->
      <VirtualList bind:this={fileList} items={detail.files} rowHeight={26} class="flist">
        {#snippet row(f: CommitFile)}
          {@const st = statusStyle(f.status)}
          <div class="file" class:sel={f.path === file} role="option" aria-selected={f.path === file} tabindex="-1"
            onclick={() => (file = f.path)} oncontextmenu={e => fileMenu(e, f)} onkeydown={() => undefined}
            title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
            <span class="st" style="color:{st.color};background:color-mix(in srgb, {st.color} 16%, transparent)">{st.letter}</span>
            <span class="name truncate"><b>{basename(f.path)}</b>{#if dirname(f.path)}<span class="dir">{dirname(f.path)}</span>{/if}</span>
            {#if f.binary}<span class="badge">bin</span>{:else}
              <span class="n a">+{f.additions}</span><span class="n d">−{f.deletions}</span>
            {/if}
          </div>
        {/snippet}
      </VirtualList>
      {#if !detail.files.length}<div class="none">No file changes (empty or merge commit).</div>{/if}
    </div>
    <div class="hsplit" role="separator" aria-orientation="horizontal" onpointerdown={dragFiles}></div>

    {#if source}
      <DiffView {source} area="commit" />
    {/if}
  {:else}
    <div class="empty"><span class="spinner"></span></div>
  {/if}
</div>

<style>
  .detail { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .meta { padding: 12px 14px 10px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; max-height: 40%; overflow-y: auto; user-select: text; }
  .top { display: flex; align-items: flex-start; gap: 8px; }
  .subject { flex: 1; margin: 0; font-size: 15px; font-weight: 700; color: #fff; line-height: 1.35; }
  .body { margin: 0; font-family: var(--font-sans); font-size: 12.5px; color: var(--text-muted); white-space: pre-wrap; word-break: break-word; }
  .facts { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; font-size: 12px; }
  .who { display: flex; align-items: center; gap: 7px; }
  .who b { color: #e5e7eb; font-weight: 600; }
  .av { width: 20px; height: 20px; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 8.5px; font-weight: 800; }
  .dim { color: var(--text-faint); }
  .sig { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 7px; border-radius: 10px; font-size: 10.5px; font-weight: 700; }
  .sig.ok { background: var(--green-soft); color: #86efac; }
  .sig.warn { background: var(--amber-soft); color: #fde68a; }
  .sig.bad { background: var(--red-soft); color: #fca5a5; }
  .chip {
    display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 7px; border-radius: var(--radius-sm);
    border: 1px solid var(--border); background: var(--surface-1); color: var(--text-muted); font-size: 11px;
  }
  .chip:hover { background: var(--surface-3); color: #fff; }
  .chip.parent { color: var(--text-faint); }
  .stat { display: inline-flex; align-items: center; gap: 4px; color: var(--text-faint); font-weight: 600; font-variant-numeric: tabular-nums; }
  .stat.a { color: var(--green); }
  .stat.d { color: var(--red); }

  .files { overflow: hidden; flex-shrink: 0; display: flex; flex-direction: column; }
  .files :global(.flist) { flex: 1; min-height: 0; }
  .file { display: flex; align-items: center; gap: 8px; height: 26px; padding: 0 12px; }
  .file:hover { background: var(--surface-1); }
  .file.sel { background: var(--surface-3); }
  .files:focus-visible .file.sel { background: rgba(74, 222, 128, 0.14); }
  .files:focus-visible { outline: none; }
  .st { width: 16px; height: 16px; border-radius: 4px; display: inline-flex; align-items: center; justify-content: center; font-size: 9.5px; font-weight: 800; flex-shrink: 0; }
  .name { flex: 1; font-size: 12.5px; color: #d1d5db; }
  .name b { font-weight: 500; color: #e5e7eb; }
  .dir { margin-left: 6px; color: var(--text-faint); font-size: 11.5px; }
  .n { font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .n.a { color: var(--green); }
  .n.d { color: var(--red); }
  .none { padding: 12px 14px; color: var(--text-faint); font-size: 12px; }
  .hsplit { height: 5px; margin: -2px 0; cursor: row-resize; position: relative; z-index: 2; flex-shrink: 0; }
  .hsplit::after { content: ''; position: absolute; left: 0; right: 0; top: 2px; height: 1px; background: var(--border); }
  .hsplit:hover::after { background: var(--green-ring); height: 2px; }
</style>
