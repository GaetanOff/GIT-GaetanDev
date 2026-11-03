<script lang="ts" module>
  /** Choices survive switching files, so a half-resolved file is never lost. */
  type Pick = 'ours' | 'theirs' | 'base' | 'ours+theirs' | 'theirs+ours' | 'custom'
  interface Resolution { pick: Pick; text?: string }
  const memory = new Map<string, Record<number, Resolution>>()
</script>

<script lang="ts">
  import { tick } from 'svelte'
  import Icon from './Icon.svelte'
  import DiffView from './DiffView.svelte'
  import type { ConflictChunk, ConflictFile } from '@shared/types'
  import { api, asError } from '@/lib/api'
  import { basename, dirname } from '@/lib/format'
  import { app } from '@/lib/state.svelte'
  import { confirm, toast } from '@/lib/ui.svelte'

  let { path }: { path: string } = $props()

  let file = $state.raw<ConflictFile | null>(null)
  let error = $state<string | null>(null)
  let picks = $state<Record<number, Resolution>>({})
  let editing = $state<number | null>(null)
  let draft = $state('')
  let showBase = $state(loadShowBase())
  let tab = $state<'resolve' | 'diff'>('resolve')
  let saving = $state(false)
  let body = $state<HTMLDivElement>()
  let expanded = $state<Set<number>>(new Set())
  let token = 0

  function loadShowBase() {
    try { return localStorage.getItem('conflict-base') === '1' } catch { return false }
  }

  $effect(() => {
    const p = path
    const repo = app.repo?.path
    if (!repo) return
    const t = ++token
    file = null
    error = null
    editing = null
    expanded = new Set()
    picks = memory.get(`${repo}\0${p}`) ?? {}
    api['git:conflict'](repo, p)
      .then(f => { if (t === token) file = f })
      .catch(e => { if (t === token) error = asError(e).message })
  })

  $effect(() => {
    if (app.repo) memory.set(`${app.repo.path}\0${path}`, $state.snapshot(picks))
  })

  const conflicts = $derived(file ? file.chunks.map((c, i) => ({ c, i })).filter(x => x.c.kind === 'conflict') : [])
  const resolvedCount = $derived(conflicts.filter(x => picks[x.i]).length)
  const allResolved = $derived(conflicts.length > 0 && resolvedCount === conflicts.length)

  function linesFor(chunk: Extract<ConflictChunk, { kind: 'conflict' }>, r: Resolution): string[] {
    switch (r.pick) {
      case 'ours': return chunk.ours
      case 'theirs': return chunk.theirs
      case 'base': return chunk.base
      case 'ours+theirs': return [...chunk.ours, ...chunk.theirs]
      case 'theirs+ours': return [...chunk.theirs, ...chunk.ours]
      case 'custom': return r.text === '' ? [] : (r.text ?? '').split(/\r?\n/)
    }
  }

  function pick(i: number, p: Pick) {
    picks[i] = { pick: p }
    if (editing === i) editing = null
    // Move on to the next unresolved conflict, like a merge tool.
    const next = conflicts.find(x => x.i > i && !picks[x.i])
    if (next) tick().then(() => scrollTo(next.i))
  }

  function reset(i: number) {
    delete picks[i]
    if (editing === i) editing = null
  }

  function edit(i: number) {
    const chunk = file!.chunks[i] as Extract<ConflictChunk, { kind: 'conflict' }>
    draft = linesFor(chunk, picks[i] ?? { pick: 'ours+theirs' }).join('\n')
    editing = i
  }

  function saveEdit(i: number) {
    picks[i] = { pick: 'custom', text: draft }
    editing = null
  }

  function all(p: 'ours' | 'theirs') {
    for (const x of conflicts) picks[x.i] = { pick: p }
  }

  function scrollTo(i: number) {
    body?.querySelector(`[data-chunk="${i}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function step(dir: 1 | -1) {
    if (!body || !conflicts.length) return
    const top = body.scrollTop + 10
    const els = conflicts.map(x => ({ i: x.i, y: (body!.querySelector(`[data-chunk="${x.i}"]`) as HTMLElement)?.offsetTop ?? 0 }))
    const target = dir === 1 ? els.find(e => e.y > top + 4) ?? els[0] : [...els].reverse().find(e => e.y < top - 4) ?? els[els.length - 1]
    scrollTo(target.i)
  }

  function content(): string {
    const f = file!
    const lines = f.chunks.flatMap((c, i) => (c.kind === 'common' ? c.lines : linesFor(c, picks[i])))
    if (!lines.length) return ''
    return lines.join(f.eol) + (f.finalNewline ? f.eol : '')
  }

  async function markResolved() {
    if (!file || !allResolved || !app.repo) return
    saving = true
    try {
      await api['git:resolveContent'](app.repo.path, path, content())
      memory.delete(`${app.repo.path}\0${path}`)
      toast('success', `${basename(path)} resolved and staged.`)
    } catch (e) {
      toast('error', asError(e).message)
    } finally {
      saving = false
      await app.refreshAll()
    }
  }

  async function whole(choice: 'ours' | 'theirs' | 'delete' | 'disk') {
    if (!app.repo) return
    if (choice === 'delete') {
      const ok = await confirm({ title: `Delete ${basename(path)}?`, message: 'The file is removed and the deletion staged.', confirmLabel: 'Delete', danger: true })
      if (!ok) return
    }
    await app.run('Resolving', () => api['git:resolveWhole'](app.repo!.path, path, choice), { success: `${basename(path)} resolved.` })
  }

  function toggleBase() {
    showBase = !showBase
    try { localStorage.setItem('conflict-base', showBase ? '1' : '0') } catch { /* ignore */ }
  }

  const PICK_LABEL: Record<Pick, string> = {
    ours: 'Ours', theirs: 'Theirs', base: 'Base', 'ours+theirs': 'Ours, then theirs', 'theirs+ours': 'Theirs, then ours', custom: 'Edited',
  }
  const FOLD = 8
</script>

<div class="cv">
  <div class="toolbar">
    <span class="path truncate">
      {#if dirname(path)}<span class="dir">{dirname(path)}/</span>{/if}<b>{basename(path)}</b>
    </span>
    {#if file?.mode === 'text' && tab === 'resolve'}
      <span class="progress" title="{resolvedCount} of {conflicts.length} conflicts resolved">
        <span class="track"><span class="fill" style="width:{conflicts.length ? (resolvedCount / conflicts.length) * 100 : 0}%"></span></span>
        <span class="mono">{resolvedCount}/{conflicts.length}</span>
      </span>
      <button class="icon-btn sm" title="Previous conflict" onclick={() => step(-1)}><Icon name="chevronDown" size={13} class="up" /></button>
      <button class="icon-btn sm" title="Next conflict" onclick={() => step(1)}><Icon name="chevronDown" size={13} /></button>
    {/if}
    <span class="grow"></span>
    {#if file?.mode === 'text' && tab === 'resolve'}
      <button class="btn btn-ghost sm" onclick={() => all('ours')}>All ours</button>
      <button class="btn btn-ghost sm" onclick={() => all('theirs')}>All theirs</button>
      <button class="icon-btn sm" class:active={showBase} title="Show the common ancestor (base)" onclick={toggleBase} disabled={!file.hasBase}><Icon name="merge" size={14} /></button>
    {/if}
    <div class="segmented">
      <button class:on={tab === 'resolve'} onclick={() => (tab = 'resolve')}>Resolve</button>
      <button class:on={tab === 'diff'} onclick={() => (tab = 'diff')}>Diff</button>
    </div>
    <button class="icon-btn sm" title="Open in editor" onclick={() => api['shell:editor'](app.repo!.path, path).catch(e => toast('error', e.message))}><Icon name="code" size={14} /></button>
    {#if file?.mode === 'text'}
      <button class="btn btn-primary sm" disabled={!allResolved || saving} onclick={markResolved} title={allResolved ? 'Write the result and stage it' : 'Resolve every conflict first'}>
        {#if saving}<span class="spinner"></span>{:else}<Icon name="check" size={13} />{/if}Mark resolved
      </button>
    {/if}
  </div>

  {#if tab === 'diff'}
    <DiffView source={{ kind: 'worktree', path, conflicted: true }} area="conflicted" />
  {:else if error}
    <div class="empty"><h3>Could not read the conflict</h3><p>{error}</p></div>
  {:else if !file}
    <div class="empty"><span class="spinner"></span></div>
  {:else}
    {#if file.resolvedOnDisk}
      <div class="disk">
        <Icon name="info" size={15} />
        <span class="grow">No conflict markers are left in the file on disk: it looks resolved in another editor.</span>
        <button class="btn btn-secondary sm" onclick={() => whole('disk')}>Keep the file on disk</button>
      </div>
    {/if}

    {#if file.mode === 'whole'}
      <div class="whole">
        <div class="empty-icon"><Icon name="alert" size={24} /></div>
        <h3>
          {#if !file.oursExists}Deleted on your side, changed on theirs
          {:else if !file.theirsExists}Changed on your side, deleted on theirs
          {:else}Binary file in conflict{/if}
        </h3>
        <p>Pick the version to keep. You can also fix it in another tool, then keep the file on disk.</p>
        <div class="choices">
          {#if file.oursExists}
            <button class="choice ours" onclick={() => whole('ours')}><span class="label">Ours</span><b class="truncate">{file.oursLabel}</b><span>Keep this version</span></button>
          {/if}
          {#if file.theirsExists}
            <button class="choice theirs" onclick={() => whole('theirs')}><span class="label">Theirs</span><b class="truncate">{file.theirsLabel}</b><span>Keep this version</span></button>
          {/if}
          {#if !file.oursExists || !file.theirsExists}
            <button class="choice del" onclick={() => whole('delete')}><span class="label">Delete</span><b>Remove the file</b><span>Accept the deletion</span></button>
          {/if}
        </div>
      </div>
    {:else}
      <div class="body" bind:this={body}>
        {#each file.chunks as chunk, i (i)}
          {#if chunk.kind === 'common'}
            {@const long = chunk.lines.length > FOLD * 2 + 2 && !expanded.has(i)}
            <div class="common mono">
              {#if long}
                {#each chunk.lines.slice(0, i === 0 ? 0 : FOLD) as l}<div class="ln">{l || ' '}</div>{/each}
                <button class="fold" onclick={() => (expanded = new Set([...expanded, i]))}>
                  <Icon name="more" size={12} />{chunk.lines.length - (i === 0 ? 0 : FOLD) - (i === file.chunks.length - 1 ? 0 : FOLD)} unchanged lines
                </button>
                {#each chunk.lines.slice(i === file.chunks.length - 1 ? chunk.lines.length : -FOLD) as l}<div class="ln">{l || ' '}</div>{/each}
              {:else}
                {#each chunk.lines as l}<div class="ln">{l || ' '}</div>{/each}
              {/if}
            </div>
          {:else}
            {@const r = picks[i]}
            {@const n = conflicts.findIndex(x => x.i === i) + 1}
            <section class="conflict" class:resolved={!!r} data-chunk={i}>
              <header>
                <span class="badge {r ? 'green' : 'amber'}">{r ? `✓ ${PICK_LABEL[r.pick]}` : `Conflict ${n} of ${conflicts.length}`}</span>
                <span class="grow"></span>
                <button class="btn btn-ghost sm" onclick={() => pick(i, 'ours+theirs')} title="Keep both, yours first">Both ↓</button>
                <button class="btn btn-ghost sm" onclick={() => pick(i, 'theirs+ours')} title="Keep both, theirs first">Both ↑</button>
                <button class="btn btn-ghost sm" onclick={() => edit(i)}><Icon name="edit" size={12} />Edit</button>
                {#if r}<button class="btn btn-ghost sm" onclick={() => reset(i)}><Icon name="undo" size={12} />Reset</button>{/if}
              </header>
              <div class="sides" class:three={showBase && file.hasBase}>
                <button class="side ours" class:picked={r?.pick === 'ours'} onclick={() => pick(i, 'ours')}>
                  <span class="side-head"><span class="label">Ours</span><span class="who truncate">{file.oursLabel}</span><span class="use">Use ours</span></span>
                  <span class="code mono">{#each chunk.ours as l}<span class="ln">{l || ' '}</span>{:else}<span class="nothing">(no lines)</span>{/each}</span>
                </button>
                {#if showBase && file.hasBase}
                  <button class="side base" class:picked={r?.pick === 'base'} onclick={() => pick(i, 'base')}>
                    <span class="side-head"><span class="label">Base</span><span class="who">common ancestor</span><span class="use">Use base</span></span>
                    <span class="code mono">{#each chunk.base as l}<span class="ln">{l || ' '}</span>{:else}<span class="nothing">(no lines)</span>{/each}</span>
                  </button>
                {/if}
                <button class="side theirs" class:picked={r?.pick === 'theirs'} onclick={() => pick(i, 'theirs')}>
                  <span class="side-head"><span class="label">Theirs</span><span class="who truncate">{file.theirsLabel}</span><span class="use">Use theirs</span></span>
                  <span class="code mono">{#each chunk.theirs as l}<span class="ln">{l || ' '}</span>{:else}<span class="nothing">(no lines)</span>{/each}</span>
                </button>
              </div>
              {#if editing === i}
                <div class="result">
                  <div class="result-head"><span class="label">Result</span><span class="grow"></span>
                    <button class="btn btn-ghost sm" onclick={() => (editing = null)}>Cancel</button>
                    <button class="btn btn-primary sm" onclick={() => saveEdit(i)}>Use this text</button>
                  </div>
                  <textarea class="input mono" rows={Math.min(18, Math.max(4, draft.split('\n').length + 1))} bind:value={draft} spellcheck="false"
                    onkeydown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveEdit(i) } }}></textarea>
                </div>
              {:else if r && (r.pick === 'custom' || r.pick.includes('+'))}
                <div class="result">
                  <div class="result-head"><span class="label">Result</span></div>
                  <div class="code mono">{#each linesFor(chunk, r) as l}<div class="ln">{l || ' '}</div>{:else}<span class="nothing">(empty)</span>{/each}</div>
                </div>
              {/if}
            </section>
          {/if}
        {/each}
        {#if !conflicts.length}
          <div class="empty"><h3>No conflicting hunks</h3><p>Git merged the content cleanly; mark the file resolved from the file list.</p></div>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .cv { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .toolbar { display: flex; align-items: center; gap: 6px; height: 36px; padding: 0 8px 0 12px; flex-shrink: 0; border-bottom: 1px solid var(--border); background: rgba(6, 10, 15, 0.3); }
  .path { font-size: 12.5px; }
  .path b { color: #fff; font-weight: 600; }
  .dir { color: var(--text-faint); }
  .progress { display: flex; align-items: center; gap: 6px; margin-left: 6px; font-size: 11px; color: var(--text-muted); }
  .track { width: 70px; height: 4px; border-radius: 2px; background: var(--surface-3); overflow: hidden; }
  .fill { display: block; height: 100%; background: var(--green); transition: width 200ms; }
  .toolbar :global(.up) { transform: rotate(180deg); }
  .segmented button { padding: 0 8px; }

  .disk { display: flex; align-items: center; gap: 10px; margin: 10px 12px 0; padding: 9px 12px; border-radius: var(--radius-lg); background: rgba(96, 165, 250, 0.1); border: 1px solid rgba(96, 165, 250, 0.25); color: #bfdbfe; font-size: 12px; }

  .body { flex: 1; min-height: 0; overflow: auto; padding: 10px 12px 40px; }
  .ln { white-space: pre; tab-size: 4; min-height: 19px; line-height: 19px; }
  .common { color: #8b929c; padding: 2px 10px; font-size: 12px; }
  .fold { display: flex; align-items: center; gap: 6px; margin: 2px 0; padding: 2px 8px; border: none; border-radius: var(--radius-sm); background: var(--surface-1); color: var(--text-faint); font-size: 11px; }
  .fold:hover { background: var(--surface-3); color: #fff; }

  .conflict { margin: 8px 0; border-radius: var(--radius-lg); border: 1px solid rgba(252, 211, 77, 0.3); background: rgba(252, 211, 77, 0.03); scroll-margin-top: 8px; }
  .conflict.resolved { border-color: rgba(74, 222, 128, 0.3); background: rgba(74, 222, 128, 0.025); }
  .conflict header { display: flex; align-items: center; gap: 4px; padding: 6px 8px 6px 10px; border-bottom: 1px solid var(--border); }
  .sides { display: grid; grid-template-columns: 1fr 1fr; }
  .sides.three { grid-template-columns: 1fr 1fr 1fr; }
  .side {
    display: flex; flex-direction: column; min-width: 0; padding: 0; border: none; text-align: left; background: transparent;
    border-right: 1px solid var(--border); cursor: pointer; transition: background 120ms; position: relative;
  }
  .side:last-child { border-right: none; }
  .side-head { display: flex; align-items: center; gap: 8px; padding: 5px 10px; font-size: 11px; }
  .who { color: var(--text-faint); flex: 1; }
  .use { opacity: 0; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; transition: opacity 120ms; }
  .side:hover .use { opacity: 1; }
  .side .ln { display: block; }
  .side .code { display: block; padding: 4px 10px 8px; font-size: 12px; overflow-x: auto; color: #d6dae0; }
  .side.ours { --c: var(--blue); }
  .side.theirs { --c: var(--purple); }
  .side.base { --c: var(--text-muted); }
  .side .label, .side .use { color: var(--c); }
  .side .code { background: color-mix(in srgb, var(--c) 6%, transparent); }
  .side:hover .code { background: color-mix(in srgb, var(--c) 12%, transparent); }
  .side.picked { box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--c) 70%, transparent); }
  .side.picked .code { background: color-mix(in srgb, var(--c) 16%, transparent); }
  .conflict.resolved .side:not(.picked) { opacity: 0.55; }
  .nothing { color: var(--text-dim); font-style: italic; font-family: var(--font-sans); }

  .result { border-top: 1px solid var(--border); padding: 6px 10px 10px; }
  .result-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .result-head .label { color: var(--green); }
  .result .code { padding: 4px 8px; border-radius: var(--radius); background: rgba(74, 222, 128, 0.07); font-size: 12px; overflow-x: auto; color: #e5e7eb; }
  .result textarea { font-size: 12px; tab-size: 4; white-space: pre; }

  .whole { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 32px; text-align: center; color: var(--text-faint); }
  .whole .empty-icon { width: 56px; height: 56px; border-radius: var(--radius-xl); display: flex; align-items: center; justify-content: center; background: var(--amber-soft); color: var(--amber); }
  .whole h3 { margin: 0; color: #fff; font-size: 15px; }
  .whole p { margin: 0; max-width: 420px; font-size: 12.5px; }
  .choices { display: flex; gap: 10px; margin-top: 10px; }
  .choice { width: 200px; display: flex; flex-direction: column; gap: 4px; padding: 14px; border-radius: var(--radius-lg); border: 1px solid var(--border-strong); background: var(--surface-1); text-align: left; }
  .choice:hover { background: var(--surface-3); }
  .choice b { color: #fff; font-size: 12.5px; }
  .choice span:last-child { font-size: 11px; color: var(--text-faint); }
  .choice.ours .label { color: var(--blue); }
  .choice.theirs .label { color: var(--purple); }
  .choice.del .label { color: var(--red); }
</style>
