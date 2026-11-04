<script lang="ts">
  import Icon from '@/components/Icon.svelte'
  import type { RebaseAction, RebasePlan, RebaseStep } from '@shared/types'
  import { api, asError } from '@/lib/api'
  import { initials, relativeTime, shortSha, tone } from '@/lib/format'
  import { app } from '@/lib/state.svelte'
  import { messageAfterSquash } from '@/lib/squash'
  import { confirm, toast } from '@/lib/ui.svelte'

  interface Row {
    sha: string
    action: RebaseAction
    subject: string
    body: string
    author: string
    date: number
    /** A merge commit: recreated as is, never edited. */
    merge: boolean
    /** A structural line of git's --rebase-merges plan (label, reset, merge): fixed in place. */
    line?: string
    /** Edited message: for a reword, or for a commit absorbing squashes. */
    message?: string
    /** The user typed in that message: it is no longer rebuilt, only added to. */
    edited?: boolean
  }

  let last = app.rebaseTarget!
  const target = $derived(app.rebaseTarget ?? last)
  $effect(() => { if (app.rebaseTarget) last = app.rebaseTarget })
  let plan = $state.raw<RebasePlan | null>(null)
  let rows = $state<Row[]>([])
  let error = $state<string | null>(null)
  let selected = $state(0)
  let dragFrom = $state<number | null>(null)
  let dropAt = $state<number | null>(null)
  let running = $state(false)
  let listEl = $state<HTMLDivElement>()
  let planToken = 0

  $effect(() => {
    const repo = app.repo?.path
    const base = target.base
    if (!repo || !app.rebaseTarget) return
    // Only the latest request may fill the view: an older plan would come with another repo's commits.
    const t = ++planToken
    plan = null
    error = null
    api['git:rebasePlan'](repo, base)
      .catch(e => (base === 'HEAD~10' ? api['git:rebasePlan'](repo, null) : Promise.reject(e)))
      .then(p => {
        if (t !== planToken) return
        plan = p
        const row = (c: RebasePlan['commits'][number]): Row => ({ sha: c.sha, action: 'pick', subject: c.subject, body: c.body, author: c.author, date: c.date, merge: c.parents.length > 1 })
        rows = p.structure
          ? p.structure.map((it, k) => (it.kind === 'pick' ? row(p.commits.find(c => c.sha === it.sha)!) : { sha: `line-${k}`, action: 'pick', subject: it.text, body: '', author: '', date: 0, merge: false, line: it.text }))
          : p.commits.map(row)
        original = rows.map(r => r.sha).join(',')
        selected = Math.max(0, rows.map(r => !r.line).lastIndexOf(true))
      })
      .catch(e => { if (t === planToken) error = asError(e).message })
  })

  /** With merges in range, git's plan is followed: commits move and squash within their own stretch. */
  const mergeMode = $derived(!!plan?.structure)
  let original = ''

  /** Stretch index of each row: structural lines split the plan into independent parts. */
  const segOf = (list: Row[], i: number) => list.slice(0, i).filter(r => r.line).length

  const fullMessage = (r: Row) => (r.body ? `${r.subject}\n\n${r.body}` : r.subject)

  /** For each row, the index of the commit it ends up in (itself, or the one it is squashed into). */
  const owner = $derived.by(() => {
    const out: number[] = []
    let head = -1
    rows.forEach((r, i) => {
      if (r.line) { head = -1; return out.push(-1) }
      if (r.action === 'drop') return out.push(-1)
      if (r.action === 'squash' || r.action === 'fixup') return out.push(head)
      head = i
      out.push(i)
    })
    return out
  })

  const commitRows = $derived(rows.filter(r => !r.line))
  const invalid = $derived(
    !commitRows.some(r => r.action !== 'drop') ? 'Every commit is dropped.'
      : rows.some((r, i) => (r.action === 'squash' || r.action === 'fixup') && !r.line && owner[i] < 0)
        ? mergeMode ? 'A squashed commit needs a kept commit above it in the same part of the history.' : 'The first kept commit cannot be squashed: move it, or pick it.'
        : null,
  )
  const resulting = $derived(commitRows.filter(r => r.action === 'pick' || r.action === 'reword').length)
  const changed = $derived(!!plan && (rows.map(r => r.sha).join(',') !== original || commitRows.some(r => r.action !== 'pick' || r.message !== undefined)))

  /** Members squashed into row `i`. */
  const members = (i: number) => rows.filter((_, j) => j !== i && owner[j] === i)

  /** The messages squashed into row `i`, in order. */
  const squashedInto = (i: number) => members(i).filter(m => m.action === 'squash').map(fullMessage)

  /** What git would propose: the head message followed by every squashed message. */
  const defaultGroupMessage = (i: number) => messageAfterSquash({}, fullMessage(rows[i]), squashedInto(i), '')

  function setAction(i: number, action: RebaseAction) {
    if (rows[i].merge || rows[i].line) return
    rows[i].action = action
    if (action === 'reword' && rows[i].message === undefined) rows[i].message = fullMessage(rows[i])
    if (action === 'pick' && !members(i).some(m => m.action === 'squash')) {
      rows[i].message = undefined
      rows[i].edited = false
    }
    // A squash makes the receiving commit's message editable, prefilled like git does.
    if (action === 'squash') {
      const o = owner[i]
      if (o >= 0) rows[o].message = messageAfterSquash(rows[o], fullMessage(rows[o]), squashedInto(o), fullMessage(rows[i]))
    }
  }

  function move(from: number, to: number) {
    if (to < 0 || to >= rows.length || from === to || rows[from].line) return
    const next = [...rows]
    const [r] = next.splice(from, 1)
    next.splice(to, 0, r)
    // Labels, resets and merges stay put: a commit only moves within its stretch.
    if (segOf(next, to) !== segOf(rows, from)) return
    rows = next
    selected = to
  }

  function onKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement).tagName === 'TEXTAREA') return
    const keys: Record<string, RebaseAction> = { p: 'pick', r: 'reword', s: 'squash', f: 'fixup', d: 'drop' }
    if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); move(selected, selected - 1) }
    else if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); move(selected, selected + 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); selected = nextCommit(selected, -1) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); selected = nextCommit(selected, 1) }
    else if (keys[e.key.toLowerCase()] && !e.ctrlKey && !e.metaKey) { e.preventDefault(); setAction(selected, keys[e.key.toLowerCase()]) }
  }

  function nextCommit(from: number, dir: 1 | -1): number {
    for (let i = from + dir; i >= 0 && i < rows.length; i += dir) if (!rows[i].line) return i
    return from
  }

  function onDragStart(e: DragEvent, i: number) {
    if (rows[i].line) return e.preventDefault()
    dragFrom = i
    e.dataTransfer!.effectAllowed = 'move'
    e.dataTransfer!.setData('text/plain', String(i))
  }
  function onDragOver(e: DragEvent, i: number) {
    if (dragFrom === null) return
    e.preventDefault()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    dropAt = e.clientY < r.top + r.height / 2 ? i : i + 1
  }
  function onDrop(e: DragEvent) {
    e.preventDefault()
    if (dragFrom !== null && dropAt !== null) move(dragFrom, dropAt > dragFrom ? dropAt - 1 : dropAt)
    dragFrom = null
    dropAt = null
  }

  async function start() {
    if (!plan || invalid || !app.repo) return
    // The plan and the repo it was made for, whatever is in front once the dialog closes.
    const repo = app.repo.path
    const p = plan
    if (p.pushed) {
      const ok = await confirm({
        title: 'Rewrite pushed commits?',
        message: `${p.pushed} of these commits are already on the remote. After the rebase you will need to force push, and anyone who pulled them must reset.`,
        confirmLabel: 'Rebase anyway',
        danger: true,
      })
      if (!ok) return
    }
    const steps: RebaseStep[] = rows.map((r, i) => {
      if (r.line) return { sha: '', action: 'line', line: r.line }
      const hasSquash = members(i).some(m => m.action === 'squash')
      const message = r.action === 'reword' || ((r.action === 'pick') && hasSquash) ? r.message ?? defaultGroupMessage(i) : undefined
      return { sha: r.sha, action: r.action, message }
    })
    running = true
    const ok = await app.run('Rebasing', () => api['git:rebaseRun'](repo, p.base, steps, p.head).then(() => true))
    running = false
    if (ok) {
      toast('success', `History rewritten: ${commitRows.length} commits → ${resulting}.`, { label: 'Undo', run: () => { app.view = 'undo' } })
      app.closeTool()
      app.view = 'history'
    }
  }

  const ACTIONS: { a: RebaseAction; label: string; key: string; hint: string }[] = [
    { a: 'pick', label: 'Pick', key: 'P', hint: 'Keep the commit as is' },
    { a: 'reword', label: 'Reword', key: 'R', hint: 'Keep it, edit its message' },
    { a: 'squash', label: 'Squash', key: 'S', hint: 'Meld into the commit above, combine messages' },
    { a: 'fixup', label: 'Fixup', key: 'F', hint: 'Meld into the commit above, drop this message' },
    { a: 'drop', label: 'Drop', key: 'D', hint: 'Remove the commit' },
  ]
  const sel = $derived(rows[selected])
  // A squashed row edits the message of the commit it melds into.
  const editing = $derived.by(() => {
    if (!sel) return -1
    const i = sel.action === 'squash' || sel.action === 'fixup' ? owner[selected] : selected
    const r = rows[i]
    if (!r) return -1
    return r.action === 'reword' || (r.action === 'pick' && members(i).some(m => m.action === 'squash')) ? i : -1
  })
</script>

<div class="rb">
  <div class="bar">
    <button class="icon-btn" title="Back" onclick={() => app.closeTool()} disabled={running}><Icon name="arrowLeft" size={15} /></button>
    <Icon name="edit" size={15} class="bi" />
    <span class="title">Edit history</span>
    <span class="sub truncate">{target.label}</span>
    <span class="grow"></span>
    <span class="keys"><kbd>P</kbd><kbd>R</kbd><kbd>S</kbd><kbd>F</kbd><kbd>D</kbd> actions · <kbd>Alt</kbd><kbd>↑↓</kbd> move · or drag</span>
  </div>

  {#if error}
    <div class="empty"><h3>Cannot edit this history</h3><p>{error}</p></div>
  {:else if !plan}
    <div class="empty"><span class="spinner"></span></div>
  {:else if !plan.commits.length}
    <div class="empty"><div class="empty-icon"><Icon name="check" size={24} /></div><h3>Nothing to rewrite</h3><p>There are no commits after this point on the current branch.</p></div>
  {:else}
    <div class="body">
      <div class="list" bind:this={listEl} role="listbox" tabindex="0" aria-label="Commits to rewrite" onkeydown={onKey}>
        <div class="legend label">Oldest first · replayed top to bottom on {plan.base ? shortSha(plan.base) : 'the root'}</div>
        {#if mergeMode}<div class="mnote"><Icon name="merge" size={13} />Merges are kept: git's label, reset and merge steps stay in place. Commits can be reordered, squashed and dropped within their own part.</div>{/if}
        {#each rows as r, i (r.sha)}
          {@const t = tone(r.author)}
          {@const squashed = r.action === 'squash' || r.action === 'fixup'}
          {#if dropAt === i}<div class="drop-line"></div>{/if}
          {#if r.line}
            <div class="struct" class:branch={r.line.startsWith('#')} class:merge={r.line.startsWith('merge')}>
              <Icon name={r.line.startsWith('merge') ? 'merge' : r.line.startsWith('#') ? 'branch' : r.line.startsWith('reset') ? 'undo' : 'tag'} size={12} />
              <span class="mono truncate">{r.line.startsWith('#') ? r.line.slice(2) : r.line.replace(/ # .*$/, '')}</span>
              {#if r.line.includes(' # ') && !r.line.startsWith('#')}<span class="dim truncate">{r.line.replace(/^.* # /, '')}</span>{/if}
            </div>
          {:else}
          <div
            class="row {r.action}" class:sel={i === selected} class:squashed class:dragging={dragFrom === i}
            draggable="true" role="option" aria-selected={i === selected} tabindex="-1"
            ondragstart={e => onDragStart(e, i)} ondragover={e => onDragOver(e, i)} ondrop={onDrop} ondragend={() => { dragFrom = null; dropAt = null }}
            onclick={() => { selected = i; listEl?.focus() }} onkeydown={() => undefined}
          >
            <span class="grip" title="Drag to reorder"><Icon name="list" size={13} /></span>
            {#if r.merge}
              <span class="mergebadge"><Icon name="merge" size={12} />Merge · kept</span>
            {:else}
            <div class="actions">
              {#each ACTIONS as a}
                <button class="act {a.a}" class:on={r.action === a.a} title="{a.hint} ({a.key})" onclick={e => { e.stopPropagation(); selected = i; setAction(i, a.a) }}>{a.label}</button>
              {/each}
            </div>
            {/if}
            <span class="subject truncate">
              {#if squashed}<Icon name="merge" size={12} class="into" />{/if}
              {r.action === 'reword' || (r.message !== undefined && !squashed) ? (r.message ?? r.subject).split('\n')[0] : r.subject}
            </span>
            <span class="av" style="background:{t.bg};color:{t.fg}" title={r.author}>{initials(r.author)}</span>
            <span class="date">{relativeTime(r.date)}</span>
            <span class="sha mono">{shortSha(r.sha)}</span>
          </div>
          {/if}
        {/each}
        {#if dropAt === rows.length}<div class="drop-line"></div>{/if}
      </div>

      <aside class="side">
        {#if editing >= 0 && rows[editing]}
          <div class="label">{rows[editing].action === 'reword' ? 'New message' : `Message of the combined commit (${members(editing).length + 1} commits)`}</div>
          <textarea class="input msg" bind:value={rows[editing].message} oninput={() => editing !== null && (rows[editing].edited = true)} spellcheck="true"></textarea>
          <p class="hint">The first line is the summary. Lines starting with # are removed.</p>
        {:else if sel}
          <div class="label">Selected commit</div>
          <p class="subj">{sel.subject}</p>
          {#if sel.body}<pre class="cbody">{sel.body}</pre>{/if}
          <p class="hint">Choose <b>Reword</b> to edit this message, or <b>Squash</b> a commit below into it to write a combined message.</p>
        {/if}

        <div class="summary">
          <div class="srow"><span>Commits</span><b>{commitRows.length} → {resulting}</b></div>
          <div class="srow"><span>Dropped</span><b>{commitRows.filter(r => r.action === 'drop').length}</b></div>
          <div class="srow"><span>Squashed</span><b>{commitRows.filter(r => r.action === 'squash' || r.action === 'fixup').length}</b></div>
          {#if plan.pushed}<div class="warn"><Icon name="alert" size={13} />{plan.pushed} already pushed: a force push will be needed.</div>{/if}
          {#if invalid}<div class="err">{invalid}</div>{/if}
          <p class="hint">Local changes are stashed and restored automatically. If a commit conflicts, resolve it in Changes and continue. Undo history can bring the old commits back.</p>
          <button class="btn btn-primary lg block" disabled={!!invalid || !changed || running} onclick={start}>
            {#if running}<span class="spinner"></span>{:else}<Icon name="check" size={14} />{/if}Rewrite history
          </button>
        </div>
      </aside>
    </div>
  {/if}
</div>

<style>
  .rb { flex: 1; min-height: 0; display: flex; flex-direction: column; outline: none; }
  .bar { display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 10px 0 6px; border-bottom: 1px solid var(--border); flex-shrink: 0; background: rgba(6, 10, 15, 0.3); }
  .bar :global(.bi) { color: var(--purple); }
  .title { font-weight: 700; color: #fff; }
  .sub { color: var(--text-faint); font-size: 12px; }
  .keys { font-size: 11px; color: var(--text-faint); display: flex; align-items: center; gap: 3px; }
  .body { flex: 1; min-height: 0; display: flex; }
  .list { flex: 1; min-width: 0; overflow-y: auto; padding: 8px 10px 24px; outline: none; }
  .legend { padding: 4px 6px 8px; }
  .row {
    display: flex; align-items: center; gap: 10px; height: 38px; padding: 0 10px 0 6px; margin-bottom: 3px;
    border-radius: var(--radius); border: 1px solid var(--border); background: var(--surface-1); cursor: default;
  }
  .row:hover { background: var(--surface-2); }
  .row.sel { border-color: var(--green-ring); background: rgba(74, 222, 128, 0.06); }
  .list:focus .row.sel { box-shadow: 0 0 0 1px var(--green-ring); }
  .row.dragging { opacity: 0.4; }
  .row.squashed { margin-left: 28px; }
  .row.drop .subject, .row.drop .sha { text-decoration: line-through; color: var(--text-dim); }
  .row.drop { background: rgba(239, 68, 68, 0.04); }
  .drop-line { height: 2px; margin: -2px 0 1px; border-radius: 1px; background: var(--green); }
  .grip { color: var(--text-dim); cursor: grab; display: flex; }
  .struct { display: flex; align-items: center; gap: 8px; height: 24px; margin: 4px 0 4px 4px; padding: 0 10px; border-left: 2px solid var(--border-strong); color: var(--text-faint); font-size: 11.5px; }
  .struct.merge { border-color: var(--purple); color: #d8b4fe; }
  .struct.branch { border-color: transparent; padding-left: 0; margin-top: 12px; color: var(--text-muted); font-weight: 700; }
  .struct .dim { color: var(--text-dim); }
  .mnote { display: flex; align-items: center; gap: 8px; margin: 0 2px 8px; padding: 8px 10px; border-radius: var(--radius); background: var(--purple-soft); color: #e9d5ff; font-size: 12px; }
  .mergebadge { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px; border-radius: var(--radius-sm); background: var(--purple-soft); color: #d8b4fe; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; flex-shrink: 0; }
  .actions { display: flex; gap: 1px; padding: 2px; border-radius: var(--radius-sm); background: var(--surface-2); flex-shrink: 0; }
  .act { height: 22px; padding: 0 7px; border: none; border-radius: 4px; background: transparent; color: var(--text-faint); font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
  .act:hover { color: #fff; }
  .act.on.pick { background: var(--surface-4); color: #fff; }
  .act.on.reword { background: rgba(96, 165, 250, 0.25); color: #bfdbfe; }
  .act.on.squash, .act.on.fixup { background: var(--purple-soft); color: #e9d5ff; }
  .act.on.drop { background: var(--red-soft); color: #fecaca; }
  .subject { flex: 1; display: flex; align-items: center; gap: 6px; color: #e5e7eb; }
  .subject :global(.into) { color: var(--purple); transform: scaleY(-1); }
  .av { width: 20px; height: 20px; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 8.5px; font-weight: 800; flex-shrink: 0; }
  .date { width: 70px; text-align: right; font-size: 11.5px; color: var(--text-faint); flex-shrink: 0; }
  .sha { width: 56px; text-align: right; font-size: 11px; color: var(--text-dim); flex-shrink: 0; }

  .side { width: 360px; flex-shrink: 0; border-left: 1px solid var(--border); padding: 14px; display: flex; flex-direction: column; gap: 8px; overflow-y: auto; }
  .msg { min-height: 160px; flex-shrink: 0; font-family: var(--font-mono); font-size: 12px; resize: vertical; }
  .subj { margin: 0; color: #fff; font-weight: 600; }
  .cbody { margin: 0; white-space: pre-wrap; font-family: var(--font-sans); font-size: 12px; color: var(--text-muted); }
  .hint { margin: 0; font-size: 11.5px; color: var(--text-faint); }
  .hint b { color: var(--text-muted); }
  .summary { margin-top: auto; display: flex; flex-direction: column; gap: 8px; padding-top: 12px; border-top: 1px solid var(--border); }
  .srow { display: flex; justify-content: space-between; font-size: 12.5px; color: var(--text-muted); }
  .srow b { color: #fff; font-variant-numeric: tabular-nums; }
  .warn { display: flex; gap: 6px; align-items: center; padding: 7px 9px; border-radius: var(--radius); background: var(--amber-soft); color: #fde68a; font-size: 12px; }
  .err { padding: 7px 9px; border-radius: var(--radius); background: var(--red-soft); color: #fecaca; font-size: 12px; }
</style>
