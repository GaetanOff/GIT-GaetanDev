<script lang="ts">
  import Icon from '@/components/Icon.svelte'
  import VirtualList from '@/components/VirtualList.svelte'
  import Resizer from '@/components/Resizer.svelte'
  import DiffView from '@/components/DiffView.svelte'
  import ConflictView from '@/components/ConflictView.svelte'
  import CommitBox from '@/components/CommitBox.svelte'
  import OperationBanner from '@/components/OperationBanner.svelte'
  import type { DiffSource, FileChange } from '@shared/types'
  import { discardAll } from '@/lib/commands'
  import { discardPaths, fileMenu, markResolved, stagePaths, unstagePaths } from '@/lib/files'
  import { basename, dirname, statusStyle } from '@/lib/format'
  import { app, type Area } from '@/lib/state.svelte'
  import { contextMenu, isMenuKey, menuAt, openDialog, toast } from '@/lib/ui.svelte'

  type Row = { kind: 'head'; area: Area; count: number } | { kind: 'file'; area: Area; file: FileChange }

  let collapsed = $state<Record<Area, boolean>>({ conflicted: false, staged: false, unstaged: false })
  let list = $state<ReturnType<typeof VirtualList<Row>>>()
  /**
   * Where a Shift+click range starts: a file, not a row number. The list changes under the
   * user (a file staged, saved or deleted elsewhere), and a row number then named another file:
   * the range, and the Delete that discards it, took files never clicked.
   */
  let anchor = $state<string | null>(null)
  let focused = $state(false)

  const key = (area: Area, path: string) => `${area}\0${path}`

  const rows = $derived.by(() => {
    const out: Row[] = []
    const add = (area: Area, files: FileChange[]) => {
      if (!files.length && area !== 'unstaged' && area !== 'staged') return
      out.push({ kind: 'head', area, count: files.length })
      if (!collapsed[area]) for (const file of files) out.push({ kind: 'file', area, file })
    }
    add('conflicted', app.conflicted)
    add('staged', app.staged)
    add('unstaged', app.unstaged)
    return out
  })

  const selectedIndex = $derived(
    app.selected ? rows.findIndex(r => r.kind === 'file' && r.area === app.selected!.area && r.file.path === app.selected!.path) : -1,
  )
  const selectedFile = $derived(selectedIndex >= 0 ? (rows[selectedIndex] as Extract<Row, { kind: 'file' }>).file : null)

  const source = $derived.by((): DiffSource | null => {
    const sel = app.selected
    if (!sel || !selectedFile) return null
    if (sel.area === 'staged') return { kind: 'index', path: sel.path, oldPath: selectedFile.oldPath }
    if (sel.area === 'conflicted') return { kind: 'worktree', path: sel.path, conflicted: true }
    return { kind: 'worktree', path: sel.path, untracked: selectedFile.untracked }
  })

  // Pick the first file when nothing is selected, so the diff is never empty for no reason.
  $effect(() => {
    if (!app.selected) {
      const first = rows.find(r => r.kind === 'file')
      if (first && first.kind === 'file') app.selected = { path: first.file.path, area: first.area }
    }
  })

  function selectedPathsIn(area: Area): string[] {
    const fromMulti = [...app.multi].filter(k => k.startsWith(`${area}\0`)).map(k => k.slice(area.length + 1))
    if (fromMulti.length) return fromMulti
    return app.selected?.area === area ? [app.selected.path] : []
  }

  function click(e: MouseEvent, i: number, area: Area, file: FileChange) {
    const k = key(area, file.path)
    const from = anchor === null ? -1 : rows.findIndex(r => r.kind === 'file' && key(r.area, r.file.path) === anchor)
    if (e.shiftKey && from >= 0) {
      const [a, b] = [Math.min(from, i), Math.max(from, i)]
      const next = new Set<string>()
      for (let j = a; j <= b; j++) {
        const r = rows[j]
        if (r.kind === 'file' && r.area === area) next.add(key(r.area, r.file.path))
      }
      app.multi = next
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set([...app.multi].filter(x => x.startsWith(`${area}\0`)))
      if (!next.size && app.selected?.area === area) next.add(key(area, app.selected.path))
      if (next.has(k)) next.delete(k)
      else next.add(k)
      app.multi = next
      anchor = k
    } else {
      app.multi = new Set()
      anchor = k
    }
    app.selected = { path: file.path, area }
  }

  function toggleStage(area: Area, paths: string[]) {
    if (area === 'staged') unstagePaths(paths)
    else stagePaths(paths)
  }

  function onKey(e: KeyboardEvent) {
    const files = rows.map((r, i) => ({ r, i })).filter(x => x.r.kind === 'file')
    const pos = files.findIndex(x => x.i === selectedIndex)
    const move = (to: number) => {
      const target = files[Math.max(0, Math.min(files.length - 1, to))]
      if (!target || target.r.kind !== 'file') return
      app.multi = new Set()
      app.selected = { path: target.r.file.path, area: target.r.area }
      anchor = key(target.r.area, target.r.file.path)
      list?.reveal(target.i)
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(pos + 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(pos - 1) }
    else if ((e.key === ' ' || e.key === 'Enter') && app.selected) {
      e.preventDefault()
      const area = app.selected.area
      // Keep the cursor on the next file of the same area after staging.
      const next = files[pos + 1]?.r
      toggleStage(area, selectedPathsIn(area))
      // The selected files move away: the next key acts on the file under the cursor alone.
      app.multi = new Set()
      if (next && next.kind === 'file' && next.area === area) app.selected = { path: next.file.path, area }
    } else if (e.key === 'Delete' && app.selected && app.selected.area !== 'conflicted') {
      e.preventDefault()
      discardPaths(selectedPathsIn(app.selected.area))
    } else if (isMenuKey(e) && app.selected && selectedFile) {
      // The context menu from the keyboard, under the selected file.
      e.preventDefault()
      const el = (e.currentTarget as HTMLElement).querySelector<HTMLElement>('.file.sel')
      if (el) menuAt(el, fileMenu(selectedFile, app.selected.area, selectedPathsIn(app.selected.area)))
    } else if (e.key === 'a' && (e.ctrlKey || e.metaKey) && app.selected) {
      e.preventDefault()
      const area = app.selected.area
      app.multi = new Set(rows.filter(r => r.kind === 'file' && r.area === area).map(r => key(area, (r as { file: FileChange }).file.path)))
    }
  }

  const titles: Record<Area, string> = { conflicted: 'Conflicts', staged: 'Staged', unstaged: 'Unstaged' }

  function moreMenu(e: MouseEvent) {
    menuAt(e.currentTarget as HTMLElement, [
      { label: 'Stage all', icon: 'plus', disabled: !app.unstaged.length, run: () => stagePaths(app.unstaged.map(f => f.path)) },
      { label: 'Unstage all', icon: 'minus', disabled: !app.staged.length, run: () => unstagePaths(app.staged.map(f => f.path)) },
      'sep',
      { label: 'Stash all changes…', icon: 'stash', disabled: !app.files.length, run: () => openDialog({ kind: 'stash' }) },
      { label: 'Discard all changes…', icon: 'trash', danger: true, disabled: !app.files.length, run: discardAll },
    ])
  }

  const fileCount = $derived(app.files.length)
</script>

<div class="changes">
  <section class="left" style="width:{app.settings.listWidth}px">
    <OperationBanner />
    <div class="head">
      <span class="label">{fileCount ? `${fileCount} changed file${fileCount > 1 ? 's' : ''}` : 'No changes'}</span>
      <span class="grow"></span>
      <button class="icon-btn sm" title="More" onclick={moreMenu}><Icon name="more" size={14} /></button>
    </div>

    {#if fileCount}
      <div class="files-wrap" class:focused role="listbox" tabindex="0" aria-label="Changed files"
        aria-activedescendant={selectedIndex >= 0 ? `file-${selectedIndex}` : undefined}
        onkeydown={onKey} onfocus={() => (focused = true)} onblur={() => (focused = false)}>
        <VirtualList bind:this={list} items={rows} rowHeight={28} class="files">
          {#snippet row(r: Row, i: number)}
            {#if r.kind === 'head'}
              <div class="section">
                <button class="sec-toggle" onclick={() => (collapsed[r.area] = !collapsed[r.area])}>
                  <Icon name={collapsed[r.area] ? 'chevronRight' : 'chevronDown'} size={11} />
                  <span class="label" class:red={r.area === 'conflicted'}>{titles[r.area]}</span>
                  <span class="n">{r.count}</span>
                </button>
                {#if r.area === 'staged' && r.count}
                  <button class="btn btn-ghost sm" onclick={() => unstagePaths(app.staged.map(f => f.path))}>Unstage all</button>
                {:else if r.area === 'unstaged' && r.count}
                  <button class="btn btn-ghost sm" onclick={() => stagePaths(app.unstaged.map(f => f.path))}>Stage all</button>
                {/if}
              </div>
            {:else}
              {@const st = statusStyle(r.area === 'conflicted' ? 'U' : r.area === 'staged' ? r.file.index : r.file.untracked ? '?' : r.file.worktree)}
              {@const sel = app.selected?.area === r.area && app.selected.path === r.file.path}
              {@const multi = app.multi.has(key(r.area, r.file.path))}
              <div
                id="file-{i}" class="file" class:sel class:multi role="option" aria-selected={sel || multi} tabindex="-1"
                onclick={e => click(e, i, r.area, r.file)}
                ondblclick={() => r.area !== 'conflicted' && toggleStage(r.area, [r.file.path])}
                oncontextmenu={e => {
                  if (!multi) click(e, i, r.area, r.file)
                  contextMenu(e, fileMenu(r.file, r.area, selectedPathsIn(r.area)))
                }}
                onkeydown={() => undefined}
                title="{st.label}: {r.file.oldPath ? `${r.file.oldPath} → ` : ''}{r.file.path}"
              >
                <span class="st" style="color:{st.color};background:color-mix(in srgb, {st.color} 16%, transparent)">{st.letter}</span>
                <span class="name truncate">
                  <b>{basename(r.file.path)}</b>
                  {#if dirname(r.file.path)}<span class="dir">{dirname(r.file.path)}</span>{/if}
                </span>
                <span class="acts">
                  {#if r.area === 'conflicted'}
                    <button class="icon-btn sm" title="Mark resolved (stage)" onclick={e => { e.stopPropagation(); markResolved(r.file.path) }}><Icon name="check" size={13} /></button>
                  {:else}
                    {#if r.area === 'unstaged'}
                      <button class="icon-btn sm danger" title="Discard changes" onclick={e => { e.stopPropagation(); discardPaths([r.file.path]) }}><Icon name="trash" size={13} /></button>
                    {/if}
                    <button
                      class="icon-btn sm stage" title={r.area === 'staged' ? 'Unstage' : 'Stage'}
                      onclick={e => { e.stopPropagation(); toggleStage(r.area, multi ? selectedPathsIn(r.area) : [r.file.path]) }}
                    ><Icon name={r.area === 'staged' ? 'minus' : 'plus'} size={13} /></button>
                  {/if}
                </span>
              </div>
            {/if}
          {/snippet}
        </VirtualList>
      </div>
    {:else}
      <div class="clean">
        <div class="empty-icon"><Icon name="check" size={26} /></div>
        <h3>Working tree clean</h3>
        <p>
          {#if app.status?.ahead}
            You have {app.status.ahead} commit{app.status.ahead > 1 ? 's' : ''} to push.
          {:else if app.status?.behind}
            {app.status.behind} new commit{app.status.behind > 1 ? 's' : ''} on the remote.
          {:else}
            Everything is committed. Edit files and they show up here instantly.
          {/if}
        </p>
        {#if app.status?.ahead && !app.status?.behind}
          <button class="btn btn-primary" onclick={() => app.push()}><Icon name="push" size={14} />Push {app.status.ahead}</button>
        {:else if app.status?.behind}
          <button class="btn btn-primary" onclick={() => app.pull()}><Icon name="pull" size={14} />Pull {app.status.behind}</button>
        {/if}
      </div>
    {/if}

    <CommitBox />
  </section>

  <Resizer
    value={app.settings.listWidth} min={260} max={640}
    onchange={v => (app.settings.listWidth = v)}
    oncommit={v => app.updateSettings({ listWidth: v })}
  />

  <section class="right">
    {#if source && app.selected?.area === 'conflicted'}
      {#key `${app.repo?.id}\0${app.selected.path}`}<ConflictView path={app.selected.path} />{/key}
    {:else if source}
      <DiffView {source} area={app.selected?.area ?? 'unstaged'} />
    {:else}
      <div class="empty">
        <div class="empty-icon"><Icon name="changes" size={26} /></div>
        <h3>{fileCount ? 'Select a file' : 'No local changes'}</h3>
        <p>{fileCount ? 'Pick a file on the left to see its diff.' : 'Open the repository in your editor and start coding.'}</p>
        {#if !fileCount}
          <div class="row" style="margin-top:6px">
            <button class="btn btn-secondary" onclick={() => window.gdg.invoke['shell:editor'](app.repo!.path).catch(e => toast('error', e.message))}><Icon name="code" size={14} />Open in editor</button>
            <button class="btn btn-secondary" onclick={() => window.gdg.invoke['shell:reveal'](app.repo!.path)}><Icon name="folder" size={14} />Show in Explorer</button>
          </div>
        {/if}
      </div>
    {/if}
  </section>
</div>

<style>
  .changes { flex: 1; display: flex; min-height: 0; }
  .left { flex-shrink: 0; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); }
  .right { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .head { display: flex; align-items: center; height: 36px; padding: 0 8px 0 12px; border-bottom: 1px solid var(--border); flex-shrink: 0; }

  .files-wrap { flex: 1; min-height: 0; display: flex; }
  .files-wrap :global(.files) { flex: 1; }
  .section { display: flex; align-items: center; height: 28px; padding: 0 6px 0 4px; background: rgba(255, 255, 255, 0.015); }
  .sec-toggle { flex: 1; display: flex; align-items: center; gap: 6px; height: 100%; border: none; background: none; color: var(--text-faint); padding: 0 4px; }
  .label.red { color: var(--red); }
  .n { font-size: 10.5px; color: var(--text-dim); }

  .file { display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 6px 0 12px; cursor: default; }
  .file:hover { background: var(--surface-1); }
  .file.multi { background: rgba(74, 222, 128, 0.07); }
  .file.sel { background: var(--surface-3); }
  .focused .file.sel { background: rgba(74, 222, 128, 0.14); box-shadow: inset 2px 0 0 var(--green); }
  .st { width: 16px; height: 16px; border-radius: 4px; display: inline-flex; align-items: center; justify-content: center; font-size: 9.5px; font-weight: 800; flex-shrink: 0; }
  .name { flex: 1; font-size: 12.5px; color: #d1d5db; }
  .name b { font-weight: 500; color: #e5e7eb; }
  .sel .name b { color: #fff; }
  .dir { margin-left: 6px; color: var(--text-faint); font-size: 11.5px; }
  .acts { display: none; gap: 2px; }
  .file:hover .acts, .file.sel .acts { display: flex; }
  .acts .stage:hover { background: var(--green-soft); color: var(--green); }

  .clean { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 24px; text-align: center; color: var(--text-faint); }
  .clean h3 { margin: 0; font-size: 14px; color: #fff; }
  .clean p { margin: 0 0 6px; font-size: 12px; max-width: 240px; }
  .clean .empty-icon { width: 48px; height: 48px; border-radius: var(--radius-lg); display: flex; align-items: center; justify-content: center; background: var(--green-soft); color: var(--green); }
</style>
