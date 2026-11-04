<script lang="ts">
  import Icon from './Icon.svelte'
  import Code from './Code.svelte'
  import VirtualList from './VirtualList.svelte'
  import { langFor, type LexState } from '@/lib/syntax'
  import { selectionFingerprint, type DiffLine, type DiffSource, type FileDiff, type LineSelection } from '@shared/types'
  import { api, asError } from '@/lib/api'
  import { longestLine, splitRows, unifiedRows, type DiffRow } from '@/lib/diffrows'
  import type { Segment } from '@/lib/intraline'
  import { basename, dirname } from '@/lib/format'
  import { app } from '@/lib/state.svelte'
  import { confirm, toast } from '@/lib/ui.svelte'

  let { source, area }: { source: DiffSource; area: 'staged' | 'unstaged' | 'conflicted' | 'commit' } = $props()

  const ROW = 20
  const ENCODING: Record<string, string> = { 'utf8-bom': 'UTF-8 BOM', utf16le: 'UTF-16 LE', utf16be: 'UTF-16 BE', 'windows-1252': 'Windows-1252' }
  const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`)
  const lang = $derived(langFor(source.path))

  let diff = $state.raw<FileDiff | null>(null)
  let error = $state<string | null>(null)
  let loading = $state(false)
  let force = $state(false)
  let selected = $state<Set<string>>(new Set())
  let token = 0
  let lastKey = ''

  const mode = $derived(app.settings.diffMode)
  const sourceKey = $derived(JSON.stringify(source))
  // As values: saving any setting replaces app.settings, which must not reload the diff by itself.
  const context = $derived(app.settings.diffContext)
  const ignoreWhitespace = $derived(app.settings.ignoreWhitespace)

  // Reload on a new file, new options, "Show anyway", or (for working-tree diffs) any status change.
  $effect(() => {
    const key = sourceKey
    if (key !== lastKey) {
      selected = new Set()
      // A new file starts without "Show anyway". Reset before `force` is read below: written after
      // the read, it ran this effect a second time and the diff loaded twice.
      force = false
      // Never show the previous file under the new one's name, with the new one's actions.
      diff = null
      error = null
    }
    lastKey = key
    const opts = { context, ignoreWhitespace, force }
    if (source.kind === 'worktree' || source.kind === 'index') void app.status
    load(source, opts)
  })

  async function load(src: DiffSource, opts: { context: number; ignoreWhitespace: boolean; force: boolean }) {
    const repo = app.repo?.path
    if (!repo) return
    const t = ++token
    loading = true
    try {
      // Every status refresh reloads a working-tree diff (any file may have changed). When this one
      // did not, the main process says so instead of sending it all again, and the rows already
      // built (word diff, highlighting) stay as they are.
      const since = diff?.etag
      const d = await api['git:diff'](repo, $state.snapshot(src) as DiffSource, { ...opts, since })
      if (t !== token) return
      const before = diff
      error = null
      if (d.unchanged && before) return
      diff = d
      // After a refresh, a key keeps its selection only if it still names the same line: a hunk
      // added above (an editor autosave) shifts positions, and the old key would select another line.
      if (selected.size) {
        const next = new Set([...selected].filter(k => {
          const was = lineAt(before, k)
          return !!was && was.type !== 'ctx' && lineId(was) === lineId(lineAt(d, k))
        }))
        if (next.size !== selected.size) selected = next
      }
    } catch (e) {
      if (t === token) error = asError(e).message
    } finally {
      if (t === token) loading = false
    }
  }

  const syntaxLang = $derived(app.settings.syntaxHighlight ? lang : null)
  const rows = $derived(diff ? (mode === 'split' ? splitRows(diff, syntaxLang) : unifiedRows(diff, syntaxLang)) : [])
  // Unified scrolls sideways for long lines; split keeps two equal halves that clip.
  const width = $derived(diff && mode === 'unified' ? `calc(${longestLine(diff)}ch + 120px)` : undefined)

  /* ─── Line selection ──────────────────────────────────────────────────────── */

  const lineOps = $derived(
    (area === 'staged' || area === 'unstaged') && !!diff && !diff.binary && !diff.tooLarge && !diff.typeChange && !app.settings.ignoreWhitespace &&
      // UTF-16 diffs are computed on decoded text: a line patch would not match the file's bytes.
      diff.encoding !== 'utf16le' && diff.encoding !== 'utf16be',
  )
  const untracked = $derived(source.kind === 'worktree' && !!source.untracked)

  function lineAt(d: FileDiff | null, k: string): DiffLine | undefined {
    const [hi, li] = k.split(':').map(Number)
    return d?.hunks[hi]?.lines[li]
  }
  const lineId = (l: DiffLine | undefined) => (l ? `${l.type} ${l.oldNo ?? ''}/${l.newNo ?? ''} ${l.text}` : '')

  function toSelection(keys: Iterable<string>): LineSelection {
    const sel: LineSelection = {}
    for (const k of keys) {
      const [hi, li] = k.split(':').map(Number)
      ;(sel[hi] ??= []).push(li)
    }
    return sel
  }

  let drag: { on: boolean } | null = null

  function gutterDown(e: PointerEvent, hi: number, li: number, line: DiffLine) {
    if (!lineOps || line.type === 'ctx' || e.button !== 0) return
    e.preventDefault()
    const k = `${hi}:${li}`
    const on = !selected.has(k)
    drag = { on }
    apply(k, on)
  }
  function gutterEnter(hi: number, li: number, line: DiffLine) {
    if (!drag || line.type === 'ctx') return
    apply(`${hi}:${li}`, drag.on)
  }
  function apply(k: string, on: boolean) {
    const next = new Set(selected)
    if (on) next.add(k)
    else next.delete(k)
    selected = next
  }

  function hunkKeys(hi: number): string[] {
    return diff!.hunks[hi].lines.flatMap((l, li) => (l.type === 'ctx' ? [] : [`${hi}:${li}`]))
  }

  async function runLines(kind: 'stage' | 'unstage' | 'discard', keys: Iterable<string>) {
    const repo = app.repo?.path
    if (!repo || !diff) return
    const sel = toSelection(keys)
    const path = diff.path
    const oldPath = diff.oldPath
    // The main process checks the lines are still the ones shown here before touching the file.
    // Taken before the dialog: the diff reloads while it is up (an editor autosave), and the
    // answer is about the lines the user selected, not those at the same positions afterwards.
    const expect = selectionFingerprint(diff, sel)
    if (kind === 'discard') {
      const ok = await confirm({ title: 'Discard selected lines?', message: 'These changes are removed from the file on disk. A copy of the file as it is now goes to the recycle bin.', confirmLabel: 'Discard', danger: true })
      if (!ok) return
    }
    await app.run(kind === 'stage' ? 'Staging lines' : kind === 'unstage' ? 'Unstaging lines' : 'Discarding lines', async () => {
      if (kind === 'stage') await api['git:stageLines'](repo, path, sel, untracked, expect)
      else if (kind === 'unstage') await api['git:unstageLines'](repo, path, sel, expect, oldPath)
      else await api['git:discardLines'](repo, path, sel, expect)
    })
    selected = new Set()
  }

  /* ─── Toolbar ─────────────────────────────────────────────────────────────── */

  function setContext(delta: number) {
    const v = Math.max(0, Math.min(25, app.settings.diffContext + delta))
    app.updateSettings({ diffContext: v })
  }

  /* Split view: a shared horizontal offset, driven by one scrollbar and shift+wheel. */
  let splitX = $state(0)
  let hbar = $state<HTMLDivElement>()
  let viewWidth = $state(1000)
  const splitOverflow = $derived(diff && mode === 'split' ? Math.max(0, longestLine(diff) * 7.3 + 80 - viewWidth / 2) : 0)
  $effect(() => {
    void sourceKey
    void mode
    splitX = 0
  })
  // A wider window can make the scrollbar go away: an offset left past what overflows cut the
  // start of every line, with no scrollbar to bring it back.
  $effect(() => {
    if (splitX > splitOverflow) splitX = splitOverflow
  })
  function onSplitWheel(e: WheelEvent) {
    if (mode !== 'split' || !hbar) return
    const dx = e.shiftKey ? e.deltaY : e.deltaX
    if (!dx) return
    e.preventDefault()
    hbar.scrollLeft += dx
  }

  const isImage = $derived(!!diff?.image && (!!diff.image.before || !!diff.image.after))
  const empty = $derived(!!diff && !diff.binary && !diff.tooLarge && !diff.hunks.length)
</script>

<svelte:window onpointerup={() => (drag = null)} />

{#snippet code(segs: Segment[] | undefined, text: string, state?: LexState)}<Code {text} {lang} {segs} {state} />{/snippet}

<div class="diff" bind:clientWidth={viewWidth}>
  <div class="toolbar">
    <span class="path truncate" title={diff?.oldPath ? `${diff.oldPath} → ${source.path}` : source.path}>
      {#if dirname(source.path)}<span class="dir">{dirname(source.path)}/</span>{/if}<b>{basename(source.path)}</b>
      {#if diff?.oldPath}<span class="badge blue">renamed</span>{/if}
      {#if diff?.modeChange}<span class="badge purple" title="File mode">{diff.modeChange}</span>{/if}
      {#if diff && diff.encoding !== 'utf8'}<span class="badge amber" title="File encoding, kept when staging lines">{ENCODING[diff.encoding]}</span>{/if}
      {#if diff?.lfs}<span class="badge cyan" title="Stored with Git LFS">LFS</span>{/if}
    </span>
    {#if diff && !diff.binary}
      <span class="stats"><span class="a">+{diff.additions}</span><span class="d">−{diff.deletions}</span></span>
    {/if}
    <span class="grow"></span>

    {#if lineOps && selected.size}
      <span class="selcount">{selected.size} line{selected.size > 1 ? 's' : ''}</span>
      {#if area === 'unstaged'}
        {#if !untracked}<button class="btn btn-danger sm" onclick={() => runLines('discard', selected)}>Discard</button>{/if}
        <button class="btn btn-primary sm" onclick={() => runLines('stage', selected)}>Stage lines</button>
      {:else}
        <button class="btn btn-secondary sm" onclick={() => runLines('unstage', selected)}>Unstage lines</button>
      {/if}
      <button class="icon-btn sm" title="Clear selection" onclick={() => (selected = new Set())}><Icon name="x" size={13} /></button>
      <span class="sep"></span>
    {/if}

    <div class="ctx" title="Context lines">
      <button class="icon-btn sm" onclick={() => setContext(-1)} disabled={app.settings.diffContext <= 0}><Icon name="minus" size={12} /></button>
      <span class="mono">{app.settings.diffContext}</span>
      <button class="icon-btn sm" onclick={() => setContext(1)}><Icon name="plus" size={12} /></button>
    </div>
    <button
      class="icon-btn sm" class:active={app.settings.ignoreWhitespace}
      title={app.settings.ignoreWhitespace ? 'Showing without whitespace changes (line staging disabled)' : 'Hide whitespace changes'}
      onclick={() => app.updateSettings({ ignoreWhitespace: !app.settings.ignoreWhitespace })}
    ><Icon name="whitespace" size={14} /></button>
    <div class="segmented">
      <button class:on={mode === 'unified'} onclick={() => app.updateSettings({ diffMode: 'unified' })} title="Unified"><Icon name="unified" size={13} /></button>
      <button class:on={mode === 'split'} onclick={() => app.updateSettings({ diffMode: 'split' })} title="Split"><Icon name="split" size={13} /></button>
    </div>
    {#if source.kind !== 'stash' && !(source.kind === 'worktree' && source.untracked) && app.status?.hasCommits}
      <button class="icon-btn sm" title="File history" onclick={() => app.openFile(source.path, 'history', source.kind === 'commit' ? source.sha : null)}><Icon name="history" size={14} /></button>
      <button class="icon-btn sm" title="Blame" onclick={() => app.openFile(source.path, 'blame', source.kind === 'commit' ? source.sha : null)}><Icon name="user" size={14} /></button>
    {/if}
    {#if source.kind !== 'commit' && source.kind !== 'stash'}
      <button class="icon-btn sm" title="Open in editor" onclick={() => api['shell:editor'](app.repo!.path, source.path).catch(e => toast('error', e.message))}><Icon name="code" size={14} /></button>
    {/if}
    {#if loading}<div class="loadbar"></div>{/if}
  </div>

  {#if error}
    <div class="empty"><div class="empty-icon" style="background:var(--red-soft);color:var(--red)"><Icon name="alert" size={24} /></div><h3>Could not load the diff</h3><p>{error}</p></div>
  {:else if !diff}
    <div class="empty"><span class="spinner"></span></div>
  {:else if diff.lfs}
    <div class="empty">
      <div class="empty-icon" style="background:rgba(103,232,249,0.12);color:var(--cyan)"><Icon name="cloud" size={24} /></div>
      <h3>Git LFS file</h3>
      <p>The content is stored on the LFS server; git only tracks a pointer.</p>
      <p class="mono">{#if diff.lfs.before}{formatBytes(diff.lfs.before.size)} → {/if}{formatBytes(diff.lfs.size)} · {diff.lfs.oid.slice(0, 12)}</p>
    </div>
  {:else if diff.submodule}
    <div class="empty">
      <div class="empty-icon"><Icon name="repo" size={24} /></div>
      <h3>Submodule</h3>
      <p class="mono">{diff.submodule.before ?? '—'} → {diff.submodule.after ?? '—'}</p>
    </div>
  {:else if isImage}
    <div class="images">
      {#if diff.image?.before}
        <figure><figcaption class="label del">Before</figcaption><div class="checker"><img src={diff.image.before} alt="Before" /></div></figure>
      {/if}
      {#if diff.image?.after}
        <figure><figcaption class="label add">{diff.image.before ? 'After' : 'Added'}</figcaption><div class="checker"><img src={diff.image.after} alt="After" /></div></figure>
      {/if}
    </div>
  {:else if diff.binary}
    <div class="empty"><div class="empty-icon"><Icon name="file" size={24} /></div><h3>Binary file</h3><p>This file changed, but its content cannot be shown as text.</p></div>
  {:else if diff.tooLarge}
    <div class="empty">
      <div class="empty-icon" style="background:var(--amber-soft);color:var(--amber)"><Icon name="alert" size={24} /></div>
      <h3>Large diff</h3>
      {#if diff.truncated}
        <p>Over 40 MB of changes: too large to show here. Open the file in your editor instead.</p>
      {:else}
        <p>+{diff.additions} −{diff.deletions} lines. Rendering it may take a moment.</p>
        <button class="btn btn-secondary" onclick={() => (force = true)}>Show anyway</button>
      {/if}
    </div>
  {:else if empty}
    <div class="empty"><div class="empty-icon"><Icon name="check" size={24} /></div><h3>No content changes</h3><p>{diff.oldPath ? 'The file was renamed without changes.' : diff.modeChange ? 'Only the file mode changed.' : app.settings.ignoreWhitespace ? 'Only whitespace changed.' : 'The file is empty.'}</p></div>
  {:else}
    <div class="lines-wrap" style="--sx:{splitX}px" onwheel={onSplitWheel}>
    {#key sourceKey}<!-- each file opens scrolled to the top -->
    <VirtualList items={rows} rowHeight={ROW} {width} class="lines {mode}" overscan={30}>
      {#snippet row(r: DiffRow)}
        {#if r.kind === 'hunk'}
          <div class="hunk">
            <span class="hh mono">{r.header}</span>
            <span class="sec truncate">{r.section}</span>
            {#if lineOps}
              <span class="hacts">
                {#if area === 'unstaged'}
                  {#if !untracked}<button class="btn btn-ghost sm" onclick={() => runLines('discard', hunkKeys(r.hi))}>Discard hunk</button>{/if}
                  <button class="btn btn-ghost sm stage" onclick={() => runLines('stage', hunkKeys(r.hi))}>Stage hunk</button>
                {:else}
                  <button class="btn btn-ghost sm" onclick={() => runLines('unstage', hunkKeys(r.hi))}>Unstage hunk</button>
                {/if}
              </span>
            {/if}
          </div>
        {:else if r.kind === 'line'}
          {@const sel = selected.has(`${r.hi}:${r.li}`)}
          <div class="dl {r.line.type}" class:sel>
            <span
              class="gut" class:pick={lineOps && r.line.type !== 'ctx'} role="presentation"
              onpointerdown={e => gutterDown(e, r.hi, r.li, r.line)} onpointerenter={() => gutterEnter(r.hi, r.li, r.line)}
            ><span class="no">{r.line.oldNo ?? ''}</span><span class="no">{r.line.newNo ?? ''}</span></span>
            <span class="sign">{r.line.type === 'add' ? '+' : r.line.type === 'del' ? '−' : ''}</span>
            <span class="code">{@render code(r.segs, r.line.text, r.st)}{#if r.line.noEol}<span class="eol" title="No newline at end of file">⏎̸</span>{/if}</span>
          </div>
        {:else}
          <div class="pair">
            {#each [r.left, r.right] as side, s}
              {#if side}
                {@const sel = selected.has(`${r.hi}:${side.li}`)}
                <div class="half dl {side.line.type}" class:sel title={side.line.text.length > 80 ? side.line.text : undefined}>
                  <span
                    class="gut one" class:pick={lineOps && side.line.type !== 'ctx'} role="presentation"
                    onpointerdown={e => gutterDown(e, r.hi, side.li, side.line)} onpointerenter={() => gutterEnter(r.hi, side.li, side.line)}
                  ><span class="no">{s === 0 ? side.line.oldNo ?? '' : side.line.newNo ?? ''}</span></span>
                  <span class="code">{@render code(side.segs, side.line.text, side.st)}</span>
                </div>
              {:else}
                <div class="half filler"></div>
              {/if}
            {/each}
          </div>
        {/if}
      {/snippet}
    </VirtualList>
    {/key}
    {#if mode === 'split' && splitOverflow > 0}
      <div class="hbar" bind:this={hbar} onscroll={() => (splitX = hbar!.scrollLeft)}><div style="width:calc(50% + {splitOverflow}px)"></div></div>
    {/if}
    </div>
    {#if lineOps && !selected.size}
      <div class="tip">Click or drag in the gutter to select lines</div>
    {/if}
  {/if}
</div>

<style>
  .diff { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; }
  .toolbar {
    position: relative; display: flex; align-items: center; gap: 6px; height: 36px; padding: 0 8px 0 12px; flex-shrink: 0;
    border-bottom: 1px solid var(--border); background: rgba(6, 10, 15, 0.3);
  }
  .path { display: flex; align-items: center; gap: 6px; font-size: 12.5px; }
  .path b { color: #fff; font-weight: 600; }
  .dir { color: var(--text-faint); }
  .stats { display: flex; gap: 6px; font-size: 11.5px; font-weight: 700; font-variant-numeric: tabular-nums; margin-left: 4px; }
  .stats .a { color: var(--green); }
  .stats .d { color: var(--red); }
  .selcount { font-size: 11.5px; color: #86efac; font-weight: 600; }
  .sep { width: 1px; height: 18px; background: var(--border-strong); margin: 0 2px; }
  .ctx { display: flex; align-items: center; gap: 1px; color: var(--text-muted); }
  .ctx .mono { width: 16px; text-align: center; font-size: 11px; }
  .segmented button { display: flex; align-items: center; padding: 0 7px; }
  .loadbar {
    position: absolute; left: 0; right: 0; bottom: -1px; height: 2px;
    background: linear-gradient(90deg, transparent, var(--green), var(--teal), transparent); background-size: 40% 100%; background-repeat: no-repeat;
    animation: load 900ms ease-in-out infinite;
  }
  @keyframes load { from { background-position: -40% 0; } to { background-position: 140% 0; } }

  .diff :global(.lines) { flex: 1; min-height: 0; font-family: var(--font-mono); font-size: 12px; font-variant-ligatures: none; }

  .hunk {
    display: flex; align-items: center; gap: 10px; height: 20px; padding: 0 8px 0 12px; position: sticky; left: 0;
    background: var(--hunk-bg); color: #93c5fd; border-top: 1px solid rgba(96, 165, 250, 0.1);
  }
  .hh { font-size: 11px; opacity: 0.85; white-space: nowrap; }
  .sec { color: var(--text-faint); font-family: var(--font-mono); font-size: 11px; flex: 1; }
  .hacts { display: flex; gap: 2px; position: sticky; right: 8px; }
  .hacts .btn { height: 18px; font-size: 10px; }
  .hacts .stage { color: var(--green); }

  .dl { display: flex; height: 20px; line-height: 20px; white-space: pre; tab-size: 4; }
  .dl.add { background: var(--add-bg); }
  .dl.del { background: var(--del-bg); }
  .gut {
    display: flex; flex-shrink: 0; position: sticky; left: 0; z-index: 1; color: var(--text-dim); font-size: 11px;
    background: var(--panel-solid); border-right: 1px solid var(--border);
  }
  .no { width: 44px; padding-right: 8px; text-align: right; }
  .gut.one .no { width: 48px; }
  .add .gut { background: #11231b; color: #6ee7a0; }
  .del .gut { background: #2a1519; color: #fca5a5; }
  .gut.pick { cursor: pointer; }
  .gut.pick:hover { filter: brightness(1.35); }
  .dl.sel .gut { background: #1f5a37; color: #fff; box-shadow: inset 3px 0 0 var(--green); }
  .dl.del.sel .gut { background: #5b2129; box-shadow: inset 3px 0 0 var(--red); }
  .sign { width: 18px; flex-shrink: 0; text-align: center; color: var(--text-dim); }
  .add .sign { color: var(--green); }
  .del .sign { color: var(--red); }
  .code { padding-right: 24px; color: #d6dae0; }
  .ctx .code { color: #aeb4bd; }
  .code :global(mark) { color: inherit; border-radius: 2px; }
  .add .code :global(mark) { background: var(--add-word); }
  .del .code :global(mark) { background: var(--del-word); }
  .eol { color: var(--red); margin-left: 4px; }

  .pair { display: grid; grid-template-columns: 1fr 1fr; height: 20px; }
  .half { min-width: 0; overflow: hidden; }
  .half + .half { border-left: 1px solid var(--border); }
  .half .code { padding-left: 10px; display: inline-block; transform: translateX(calc(-1 * var(--sx, 0px))); }
  .half .gut { position: relative; z-index: 1; }
  .lines-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; }
  .lines-wrap :global(.lines) { flex: 1; }
  .hbar { height: 12px; flex-shrink: 0; overflow-x: auto; overflow-y: hidden; margin-left: 50%; border-top: 1px solid var(--border); }
  .hbar > div { height: 1px; }
  .filler { background: repeating-linear-gradient(135deg, transparent 0 6px, rgba(255, 255, 255, 0.025) 6px 12px); }

  .tip {
    position: absolute; right: 18px; bottom: 12px; padding: 5px 10px; border-radius: var(--radius); pointer-events: none;
    background: var(--overlay); border: 1px solid var(--border); color: var(--text-faint); font-size: 11px; opacity: 0.85;
  }

  .images { flex: 1; overflow: auto; display: flex; gap: 20px; padding: 24px; align-items: flex-start; justify-content: center; }
  figure { margin: 0; display: flex; flex-direction: column; gap: 8px; max-width: 48%; }
  figcaption.del { color: var(--red); }
  figcaption.add { color: var(--green); }
  .checker {
    padding: 10px; border-radius: var(--radius-lg); border: 1px solid var(--border-strong);
    background: repeating-conic-gradient(#1b232d 0% 25%, #141b23 0% 50%) 50% / 16px 16px;
  }
  .checker img { display: block; max-width: 100%; max-height: 70vh; }
</style>
