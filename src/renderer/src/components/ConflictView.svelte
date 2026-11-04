<script lang="ts" module>
  /** Choices survive switching files, so a half-resolved file is never lost. */
  type Pick = 'ours' | 'theirs' | 'base' | 'ours+theirs' | 'theirs+ours' | 'custom'
  interface Resolution { pick: Pick; text?: string }
  const memory = new Map<string, Record<number, Resolution>>()
  /** Unsaved Result editor text, by repo and path, so moving to another file loses nothing. */
  const results = new Map<string, string>()

  /** Keeps a value, most recent last, and forgets the oldest past 200: files resolved elsewhere never come back. */
  function keep<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key)
    map.set(key, value)
    while (map.size > 200) map.delete(map.keys().next().value!)
  }
</script>

<script lang="ts">
  import { tick } from 'svelte'
  import Icon from './Icon.svelte'
  import DiffView from './DiffView.svelte'
  import Code from './Code.svelte'
  import { langFor, nextState, type LexState } from '@/lib/syntax'
  import type { ConflictChunk, ConflictFile } from '@shared/types'
  import { api, asError } from '@/lib/api'
  import { basename, dirname } from '@/lib/format'
  import { app } from '@/lib/state.svelte'
  import { confirm, toast } from '@/lib/ui.svelte'

  let { path }: { path: string } = $props()
  const lang = $derived(langFor(path))

  let file = $state.raw<ConflictFile | null>(null)
  let error = $state<string | null>(null)
  let picks = $state<Record<number, Resolution>>({})
  let editing = $state<number | null>(null)
  let draft = $state('')
  let showBase = $state(loadShowBase())
  let tab = $state<'resolve' | 'result' | 'diff'>('resolve')
  /**
   * Repo, path and index stages of the conflict shown: choices and Result text are
   * remembered under it, so an aborted merge's picks never apply to the next merge
   * of the same file. Null while the conflict loads.
   */
  let memKey = $state<string | null>(null)
  /** The whole result file, edited freely; null until the Result tab is opened. */
  let resultText = $state<string | null>(null)
  $effect(() => {
    if (memKey && resultText !== null) keep(results, memKey, resultText)
  })
  let gutter = $state<HTMLDivElement>()
  let saving = $state(false)
  /** In the Result editor, Tab inserts a tab until Escape is pressed. */
  let tabMoves = false
  let body = $state<HTMLDivElement>()
  let expanded = $state<Set<number>>(new Set())
  let token = 0
  /** Bumped to read the conflict again: the file changed on disk since it was shown. */
  let reload = $state(0)

  function loadShowBase() {
    try { return localStorage.getItem('conflict-base') === '1' } catch { return false }
  }

  $effect(() => {
    const p = path
    const repo = app.repo?.path
    void reload
    if (!repo) return
    const t = ++token
    file = null
    error = null
    editing = null
    expanded = new Set()
    memKey = null
    picks = {}
    resultText = null
    api['git:conflict'](repo, p)
      .then(f => {
        if (t !== token) return
        const key = `${repo}\0${p}\0${f.stages}`
        memKey = key
        picks = memory.get(key) ?? {}
        resultText = results.get(key) ?? null
        file = f
      })
      .catch(e => { if (t === token) error = asError(e).message })
  })

  $effect(() => {
    if (!memKey) return
    // A file with no choice made yet has nothing worth remembering.
    if (Object.keys(picks).length) keep(memory, memKey, $state.snapshot(picks))
    else memory.delete(memKey)
  })

  /** As a value of its own: saving any setting replaces app.settings, which would lex the file again. */
  const highlight = $derived(app.settings.syntaxHighlight)
  /** Lexer state at the start of every rendered line, keyed "chunk:side:line". */
  const states = $derived.by(() => {
    const map = new Map<string, LexState>()
    if (!file || !highlight || !lang) return map
    let st: LexState = null
    const run = (key: string, lines: string[], from: LexState) => {
      let s = from
      // Threaded from a known start, the state stays known: never undefined here.
      lines.forEach((l, i) => { map.set(`${key}:${i}`, s); s = nextState(l, lang, s) ?? null })
      return s
    }
    file.chunks.forEach((c, ci) => {
      if (c.kind === 'common') st = run(`${ci}:c`, c.lines, st)
      else {
        run(`${ci}:b`, c.base, st)
        run(`${ci}:t`, c.theirs, st)
        st = run(`${ci}:o`, c.ours, st)
      }
    })
    return map
  })
  const stOf = (key: string) => states.get(key)

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

  /** The result as it stands: chosen sides where picked, conflict markers elsewhere. */
  function draftResult(): string {
    const f = file!
    const lines = f.chunks.flatMap((c, i) => {
      if (c.kind === 'common') return c.lines
      if (picks[i]) return linesFor(c, picks[i])
      return [
        `<<<<<<< ours (${f.oursLabel})`, ...c.ours,
        ...(f.hasBase ? ['||||||| base', ...c.base] : []),
        '=======', ...c.theirs, `>>>>>>> theirs (${f.theirsLabel})`,
      ]
    })
    return lines.join('\n') + (f.finalNewline && lines.length ? '\n' : '')
  }

  function openResult() {
    if (resultText === null) resultText = draftResult()
    tab = 'result'
  }

  const markersLeft = $derived(resultText !== null && /^(<<<<<<<|=======$|>>>>>>>)/m.test(resultText))

  /* The Result editor is a transparent textarea over a coloured copy of its text. */
  let hl = $state<HTMLPreElement>()
  const HL_MAX_LINES = 4000
  const resultArr = $derived(resultText === null ? [] : resultText.split('\n'))
  const resultLines = $derived(resultArr.length)

  /**
   * Only the lines in view (and a margin) are drawn in the overlay and the
   * gutter; spacers keep the full height so both scroll with the textarea.
   * Rows are a fixed 19px (see .hl / .gutter). Typing then costs the lines on
   * screen, not the whole file.
   */
  const ROW = 19
  let resultScroll = $state(0)
  let editorHeight = $state(0)
  /** The textarea's content width, so the overlay can scroll sideways as far as it does. */
  let textWidth = $state(0)
  const first = $derived(Math.max(0, Math.floor(resultScroll / ROW) - 40))
  const last = $derived(Math.min(resultLines, Math.ceil((resultScroll + editorHeight) / ROW) + 40))
  /** The overlay also shows conflict markers and regions, so it stays on even without a language. */
  const highlightResult = $derived(resultArr.length <= HL_MAX_LINES)
  const codeLang = $derived(highlight ? lang : null)

  type Marker = 'start' | 'base' | 'mid' | 'end'
  const markerOf = (l: string): Marker | null =>
    /^<{7}( |$)/.test(l) ? 'start' : /^\|{7}( |$)/.test(l) ? 'base' : /^={7}$/.test(l) ? 'mid' : /^>{7}( |$)/.test(l) ? 'end' : null

  /**
   * Per line: conflict marker kind, the side it belongs to, and the lexer
   * state. Markers are not code: they neither get coloured as code nor feed
   * the lexer, so a comment opened before a conflict still closes after it.
   */
  const resultInfo = $derived.by(() => {
    const markers: (Marker | null)[] = []
    const regions: ('' | 'ours' | 'base' | 'theirs')[] = []
    const states: LexState[] = []
    let region: '' | 'ours' | 'base' | 'theirs' = ''
    let st: LexState = null
    for (const l of highlightResult ? resultArr : []) {
      const m = markerOf(l)
      markers.push(m)
      if (m === 'start') region = 'ours'
      else if (m === 'base' && region) region = 'base'
      else if (m === 'mid' && region) region = 'theirs'
      regions.push(m ? '' : region)
      states.push(st)
      if (m === 'end') region = ''
      if (!m && codeLang) st = nextState(l, codeLang, st) ?? null
    }
    return { markers, regions, states }
  })
  function syncScroll(t: HTMLTextAreaElement) {
    resultScroll = t.scrollTop
    textWidth = t.scrollWidth
    if (gutter) gutter.scrollTop = t.scrollTop
    if (hl) { hl.scrollTop = t.scrollTop; hl.scrollLeft = t.scrollLeft }
  }

  async function saveResult() {
    if (!file || resultText === null || !app.repo) return
    // This file's repo, even if another one is opened while the dialog is up.
    const repo = app.repo.path
    if (markersLeft) {
      const ok = await confirm({ title: 'Conflict markers remain', message: 'The result still contains <<<<<<< / ======= / >>>>>>> lines. Save and mark resolved anyway?', confirmLabel: 'Save anyway', danger: true })
      if (!ok || !file || resultText === null) return
    }
    saving = true
    try {
      // The editor works with \n; write the file back with its own line endings and encoding.
      const text = file.eol === '\r\n' ? resultText.replace(/\r?\n/g, '\r\n') : resultText
      await api['git:resolveContent'](repo, path, text, file.encoding, file.disk)
      forget()
      toast('success', `${basename(path)} resolved and staged.`)
    } catch (e) {
      failed(e)
    } finally {
      saving = false
      await app.refreshAll()
    }
  }

  async function markResolved() {
    if (!file || !allResolved || !app.repo) return
    saving = true
    try {
      await api['git:resolveContent'](app.repo.path, path, content(), file.encoding, file.disk)
      forget()
      toast('success', `${basename(path)} resolved and staged.`)
    } catch (e) {
      failed(e)
    } finally {
      saving = false
      await app.refreshAll()
    }
  }

  async function whole(choice: 'ours' | 'theirs' | 'delete' | 'disk') {
    if (!app.repo) return
    const repo = app.repo.path
    if (choice === 'delete') {
      const ok = await confirm({ title: `Delete ${basename(path)}?`, message: 'The file is removed and the deletion staged.', confirmLabel: 'Delete', danger: true })
      if (!ok) return
    }
    const done = await app.run('Resolving', () => api['git:resolveWhole'](repo, path, choice).then(() => true), { success: `${basename(path)} resolved.` })
    if (done) forget()
  }

  /** A file edited elsewhere since it was read is shown again as it is now; the choices made stay. */
  function failed(e: unknown) {
    const err = asError(e)
    toast('error', err.message)
    if (err.code === 'CHANGED_ON_DISK') reload++
  }

  /** The conflict is resolved: its choices and Result text have nothing left to restore. */
  function forget() {
    if (!memKey) return
    memory.delete(memKey)
    results.delete(memKey)
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
      <button class:on={tab === 'result'} onclick={openResult} disabled={file?.mode !== 'text'} title="Edit the whole result file">Result</button>
      <button class:on={tab === 'diff'} onclick={() => (tab = 'diff')}>Diff</button>
    </div>
    <button class="icon-btn sm" title="Open in editor" onclick={() => api['shell:editor'](app.repo!.path, path).catch(e => toast('error', e.message))}><Icon name="code" size={14} /></button>
    {#if file?.mode === 'text' && tab === 'result'}
      <button class="btn btn-primary sm" disabled={saving} onclick={saveResult} title="Write this text and stage it">
        {#if saving}<span class="spinner"></span>{:else}<Icon name="check" size={13} />{/if}Save &amp; mark resolved
      </button>
    {:else if file?.mode === 'text'}
      <button class="btn btn-primary sm" disabled={!allResolved || saving} onclick={markResolved} title={allResolved ? 'Write the result and stage it' : 'Resolve every conflict first'}>
        {#if saving}<span class="spinner"></span>{:else}<Icon name="check" size={13} />{/if}Mark resolved
      </button>
    {/if}
  </div>

  {#if tab === 'diff'}
    <DiffView source={{ kind: 'worktree', path, conflicted: true }} area="conflicted" />
  {:else if tab === 'result' && file && resultText !== null}
    <div class="resbar">
      {#if markersLeft}<span class="badge amber"><Icon name="alert" size={11} />Conflict markers left</span>{:else}<span class="badge green"><Icon name="check" size={11} />No markers left</span>{/if}
      <span class="dim">{resultLines} lines · {file.eol === '\r\n' ? 'CRLF' : 'LF'} · {file.encoding === 'utf8' ? 'UTF-8' : file.encoding}</span>
      <span class="grow"></span>
      <button class="btn btn-ghost sm" onclick={() => (resultText = draftResult())} title="Discard edits here and rebuild from the choices made in Resolve">Rebuild from choices</button>
    </div>
    <div class="editor" bind:clientHeight={editorHeight}>
      <div class="gutter mono" bind:this={gutter} aria-hidden="true"><div style="height:{first * ROW}px"></div>{#each { length: last - first } as _, n}<div>{first + n + 1}</div>{/each}<div style="height:{(resultLines - last) * ROW}px"></div></div>
      <div class="code-wrap">
      {#if highlightResult}
        <pre class="hl mono" bind:this={hl} aria-hidden="true"><div style="height:{first * ROW}px;width:{textWidth}px"></div>{#each resultArr.slice(first, last) as l, j}{@const i = first + j}{@const mk = resultInfo.markers[i]}{#if mk}<div class="ln mk {mk}">{l}</div>{:else}<div class="ln {resultInfo.regions[i]}">{#if l}<Code text={l} lang={codeLang} state={resultInfo.states[i]} />{:else}{' '}{/if}</div>{/if}{/each}<div style="height:{(resultLines - last) * ROW}px"></div><div class="ln"> </div></pre>
      {/if}
      <textarea class="mono" class:overlay={highlightResult} bind:value={resultText} spellcheck="false" wrap="off"
        onscroll={e => syncScroll(e.target as HTMLTextAreaElement)}
        oninput={e => syncScroll(e.target as HTMLTextAreaElement)}
        onkeydown={e => {
          // Tab types a tab, as in an editor; after Escape it moves focus on instead, so the
          // keyboard is never stuck here (the convention of code editors).
          if (e.key === 'Escape') tabMoves = true
          else if (e.key === 'Tab' && !tabMoves && !e.shiftKey) {
            e.preventDefault()
            const t = e.target as HTMLTextAreaElement
            t.setRangeText('\t', t.selectionStart, t.selectionEnd, 'end')
            resultText = t.value
          } else if (e.key !== 'Tab') tabMoves = false
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveResult() }
        }}
        onblur={() => (tabMoves = false)}
        aria-label="Merged result. Tab inserts a tab; press Escape, then Tab, to leave the editor."></textarea>
      </div>
    </div>
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
                {#each chunk.lines.slice(0, i === 0 ? 0 : FOLD) as l, li}<div class="ln">{#if l}<Code text={l} {lang} state={stOf(`${i}:c:${li}`)} />{:else}{' '}{/if}</div>{/each}
                <button class="fold" onclick={() => (expanded = new Set([...expanded, i]))}>
                  <Icon name="more" size={12} />{chunk.lines.length - (i === 0 ? 0 : FOLD) - (i === file.chunks.length - 1 ? 0 : FOLD)} unchanged lines
                </button>
                {#each chunk.lines.slice(i === file.chunks.length - 1 ? chunk.lines.length : -FOLD) as l, li}<div class="ln">{#if l}<Code text={l} {lang} state={stOf(`${i}:c:${chunk.lines.length - FOLD + li}`)} />{:else}{' '}{/if}</div>{/each}
              {:else}
                {#each chunk.lines as l, li}<div class="ln">{#if l}<Code text={l} {lang} state={stOf(`${i}:c:${li}`)} />{:else}{' '}{/if}</div>{/each}
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
                  <span class="code mono">{#each chunk.ours as l, li}<span class="ln">{#if l}<Code text={l} {lang} state={stOf(`${i}:o:${li}`)} />{:else}{' '}{/if}</span>{:else}<span class="nothing">(no lines)</span>{/each}</span>
                </button>
                {#if showBase && file.hasBase}
                  <button class="side base" class:picked={r?.pick === 'base'} onclick={() => pick(i, 'base')}>
                    <span class="side-head"><span class="label">Base</span><span class="who">common ancestor</span><span class="use">Use base</span></span>
                    <span class="code mono">{#each chunk.base as l, li}<span class="ln">{#if l}<Code text={l} {lang} state={stOf(`${i}:b:${li}`)} />{:else}{' '}{/if}</span>{:else}<span class="nothing">(no lines)</span>{/each}</span>
                  </button>
                {/if}
                <button class="side theirs" class:picked={r?.pick === 'theirs'} onclick={() => pick(i, 'theirs')}>
                  <span class="side-head"><span class="label">Theirs</span><span class="who truncate">{file.theirsLabel}</span><span class="use">Use theirs</span></span>
                  <span class="code mono">{#each chunk.theirs as l, li}<span class="ln">{#if l}<Code text={l} {lang} state={stOf(`${i}:t:${li}`)} />{:else}{' '}{/if}</span>{:else}<span class="nothing">(no lines)</span>{/each}</span>
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
                  <div class="code mono">{#each linesFor(chunk, r) as l}<div class="ln">{#if l}<Code text={l} {lang} />{:else}{' '}{/if}</div>{:else}<span class="nothing">(empty)</span>{/each}</div>
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
  .segmented button:disabled { opacity: 0.4; }
  .resbar { display: flex; align-items: center; gap: 10px; padding: 6px 12px; border-bottom: 1px solid var(--border); font-size: 11.5px; flex-shrink: 0; }
  .resbar .dim { color: var(--text-faint); }
  .editor { flex: 1; min-height: 0; display: flex; }
  .gutter { width: 54px; flex-shrink: 0; overflow: hidden; padding: 8px 10px 8px 0; text-align: right; color: var(--text-dim); font-size: 12px; line-height: 19px; border-right: 1px solid var(--border); background: var(--panel-solid); }
  .code-wrap { flex: 1; min-width: 0; position: relative; }
  .editor textarea { position: absolute; inset: 0; width: 100%; height: 100%; resize: none; border: none; outline: none; padding: 8px 12px; margin: 0; background: transparent; color: #e5e7eb; font-size: 12px; line-height: 19px; tab-size: 4; white-space: pre; overflow: auto; }
  .editor textarea.overlay { color: transparent; caret-color: #fff; }
  .editor textarea.overlay::selection { background: rgba(74, 222, 128, 0.3); color: transparent; }
  .hl { position: absolute; inset: 0; margin: 0; padding: 8px 12px; overflow: hidden; pointer-events: none; color: #e5e7eb; font-size: 12px; line-height: 19px; tab-size: 4; white-space: pre; }
  .hl .ln { min-height: 19px; margin: 0 -12px; padding: 0 12px; }
  .hl .ln.ours { background: rgba(96, 165, 250, 0.08); }
  .hl .ln.base { background: rgba(156, 163, 175, 0.07); }
  .hl .ln.theirs { background: rgba(192, 132, 252, 0.08); }
  .hl .mk { font-weight: 700; }
  .hl .mk.start { color: var(--blue); background: rgba(96, 165, 250, 0.18); }
  .hl .mk.base { color: var(--text-muted); background: rgba(156, 163, 175, 0.15); }
  .hl .mk.mid { color: var(--amber); background: rgba(252, 211, 77, 0.12); }
  .hl .mk.end { color: var(--purple); background: rgba(192, 132, 252, 0.18); }

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
