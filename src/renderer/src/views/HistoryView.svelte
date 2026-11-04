<script lang="ts">
  import Icon from '@/components/Icon.svelte'
  import VirtualList from '@/components/VirtualList.svelte'
  import Resizer from '@/components/Resizer.svelte'
  import GraphCell from '@/components/GraphCell.svelte'
  import CommitDetail from '@/components/CommitDetail.svelte'
  import type { Commit } from '@shared/types'
  import { commitMenu, commitsMenu } from '@/lib/actions'
  import { initials, relativeTime, shortSha, tone } from '@/lib/format'
  import { app } from '@/lib/state.svelte'
  import { contextMenu, isMenuKey, menuAt } from '@/lib/ui.svelte'
  import type { SearchMode } from '@shared/types'
  import type { IconName } from '@/lib/icons'

  let list = $state<ReturnType<typeof VirtualList<Commit>>>()
  let width = $state(loadWidth())
  let searchTimer: ReturnType<typeof setTimeout> | null = null
  let searchInput = $state<HTMLInputElement>()
  let focused = $state(false)

  function loadWidth() {
    try { return +(localStorage.getItem('history-width') ?? 560) } catch { return 560 }
  }

  const lanes = $derived(Math.min(12, app.graph.reduce((m, r) => Math.max(m, r.width), 1)))
  const selectedIndex = $derived(app.commits.findIndex(c => c.sha === app.selectedCommit))
  const headSha = $derived(app.status?.head)

  // Refs moved while another view was shown: catch up now, keeping the depth and the selection.
  $effect(() => {
    if (app.historyStale) app.reloadHistory(true)
  })

  // Reveal a commit selected from elsewhere (a branch or tag click in the sidebar).
  $effect(() => {
    if (selectedIndex >= 0) list?.reveal(selectedIndex)
  })

  const MODES: { id: SearchMode; label: string; icon: IconName; hint: string; placeholder: string }[] = [
    { id: 'message', label: 'Commit messages', icon: 'search', hint: 'grep', placeholder: 'Search messages, or @author' },
    { id: 'author', label: 'Author', icon: 'user', hint: '@', placeholder: 'Author name or email' },
    { id: 'content', label: 'Code: added or removed text', icon: 'code', hint: '-S', placeholder: 'Text added or removed in a commit' },
    { id: 'regex', label: 'Code: diff matches a regex', icon: 'code', hint: '-G', placeholder: 'Regex matched by a changed line' },
  ]

  /** Extra commits picked with Ctrl/Shift-click, for cherry-picking or reverting several at once. */
  let picked = $state<Set<string>>(new Set())
  let anchor = -1
  $effect(() => {
    void app.commits
    picked = new Set()
  })

  function clickCommit(e: MouseEvent, c: Commit, i: number) {
    if (e.shiftKey && anchor >= 0) {
      const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)]
      picked = new Set(app.commits.slice(a, b + 1).map(x => x.sha))
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(picked.size ? picked : [app.selectedCommit ?? c.sha])
      if (next.has(c.sha)) next.delete(c.sha)
      else next.add(c.sha)
      picked = next
      anchor = i
    } else {
      picked = new Set()
      anchor = i
    }
    app.selectedCommit = c.sha
  }

  function commitContext(e: MouseEvent, c: Commit) {
    if (picked.size > 1 && picked.has(c.sha)) {
      // History order is newest first; actions get the same order.
      contextMenu(e, commitsMenu(app.commits.filter(x => picked.has(x.sha))))
      return
    }
    picked = new Set()
    app.selectedCommit = c.sha
    contextMenu(e, commitMenu(c))
  }

  function onSearch(e: Event) {
    app.historySearch = (e.target as HTMLInputElement).value
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => app.reloadHistory(), 250)
  }

  function setScope(scope: 'current' | 'all') {
    app.updateSettings({ historyScope: scope }).then(() => app.reloadHistory(true))
  }

  function onKey(e: KeyboardEvent) {
    const move = (i: number) => {
      const c = app.commits[Math.max(0, Math.min(app.commits.length - 1, i))]
      if (c) app.selectedCommit = c.sha
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(selectedIndex + 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(selectedIndex - 1) }
    else if (e.key === 'PageDown') { e.preventDefault(); move(selectedIndex + 20) }
    else if (e.key === 'PageUp') { e.preventDefault(); move(selectedIndex - 20) }
    else if (e.key === 'Home') { e.preventDefault(); move(0) }
    else if (e.key === 'End') { e.preventDefault(); move(app.commits.length - 1) }
    else if (isMenuKey(e) && selectedIndex >= 0) {
      // The context menu from the keyboard, under the selected commit.
      e.preventDefault()
      const el = (e.currentTarget as HTMLElement).querySelector<HTMLElement>('.commit.sel')
      const c = app.commits[selectedIndex]
      if (el) menuAt(el, picked.size > 1 && picked.has(c.sha) ? commitsMenu(app.commits.filter(x => picked.has(x.sha))) : commitMenu(c))
    }
  }

  function onWindowKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !e.shiftKey) {
      e.preventDefault()
      searchInput?.focus()
      searchInput?.select()
    }
  }

  /** Branch and tag labels, current branch first. */
  function labels(c: Commit) {
    return c.refs.map(r => {
      if (r.startsWith('HEAD→')) return { text: r.slice(5), kind: 'head' }
      if (r === 'HEAD') return { text: 'HEAD', kind: 'head' }
      if (r.startsWith('tag:')) return { text: r.slice(4), kind: 'tag' }
      if (r.startsWith('remote:')) return { text: r.slice(7), kind: 'remote' }
      return { text: r, kind: 'local' }
    }).sort((a, b) => Number(b.kind === 'head') - Number(a.kind === 'head'))
  }
</script>

<svelte:window onkeydown={onWindowKey} />

<div class="history">
  <section class="left" style="width:{width}px">
    <div class="head">
      <div class="search">
        <button class="mode" title="Search in…" onclick={e => menuAt(e.currentTarget as HTMLElement, MODES.map(m => ({
          label: m.label, icon: m.icon, hint: m.hint, run: () => { app.historySearchMode = m.id; if (app.historySearch) app.reloadHistory() },
        })))}>
          <Icon name={MODES.find(m => m.id === app.historySearchMode)!.icon} size={13} />
          <Icon name="chevronDown" size={10} />
        </button>
        <input bind:this={searchInput} value={app.historySearch} oninput={onSearch} placeholder={MODES.find(m => m.id === app.historySearchMode)!.placeholder} spellcheck="false" />
        {#if app.historySearch}
          <button class="icon-btn sm" onclick={() => { app.historySearch = ''; app.reloadHistory() }}><Icon name="x" size={12} /></button>
        {/if}
      </div>
      <div class="segmented">
        <button class:on={app.settings.historyScope === 'current'} onclick={() => setScope('current')}>Current</button>
        <button class:on={app.settings.historyScope === 'all'} onclick={() => setScope('all')}>All</button>
      </div>
    </div>

    {#if !app.commits.length}
      <div class="empty">
        {#if app.historyLoading}<span class="spinner"></span>{:else}
          <div class="empty-icon"><Icon name="history" size={24} /></div>
          <h3>{app.historySearch ? 'No matching commits' : 'No commits yet'}</h3>
          <p>{app.historySearch ? 'Try another word, or @name to filter by author.' : 'Your first commit will appear here.'}</p>
        {/if}
      </div>
    {:else}
      <div class="list-wrap" class:focused role="listbox" tabindex="0" aria-label="Commits" onkeydown={onKey}
        aria-activedescendant={selectedIndex >= 0 ? `commit-${selectedIndex}` : undefined}
        onfocus={() => (focused = true)} onblur={() => (focused = false)}>
        <VirtualList bind:this={list} items={app.commits} rowHeight={28} class="commits" onEnd={() => app.loadMoreHistory()}>
          {#snippet row(c: Commit, i: number)}
            {@const g = app.graph[i]}
            {@const t = tone(c.author)}
            <div
              id="commit-{i}" class="commit" class:sel={c.sha === app.selectedCommit} class:picked={picked.size > 1 && picked.has(c.sha)} role="option" aria-selected={c.sha === app.selectedCommit} tabindex="-1"
              onclick={e => clickCommit(e, c, i)} onkeydown={() => undefined}
              oncontextmenu={e => commitContext(e, c)}
            >
              {#if g}<div class="g" style="width:{lanes * 14 + 4}px"><GraphCell row={g} {lanes} head={c.sha === headSha} /></div>{/if}
              <span class="subject truncate">
                {#each labels(c) as l}
                  <span class="ref {l.kind}">{#if l.kind === 'tag'}<Icon name="tag" size={10} />{:else if l.kind === 'remote'}<Icon name="cloud" size={10} />{/if}{l.text}</span>
                {/each}
                <span class="msg">{c.subject}</span>
              </span>
              <span class="author" title="{c.author} <{c.email}>">
                <span class="av" style="background:{t.bg};color:{t.fg}">{initials(c.author)}</span>
                <span class="truncate">{c.author}</span>
              </span>
              <span class="date">{relativeTime(c.date)}</span>
              <span class="sha mono">{shortSha(c.sha)}</span>
            </div>
          {/snippet}
        </VirtualList>
      </div>
    {/if}
  </section>

  <Resizer value={width} min={380} max={1100} onchange={v => (width = v)} oncommit={v => { try { localStorage.setItem('history-width', String(v)) } catch { /* ignore */ } }} />

  <section class="right">
    {#if app.selectedCommit}
      <CommitDetail sha={app.selectedCommit} />
    {:else}
      <div class="empty"><div class="empty-icon"><Icon name="commit" size={24} /></div><h3>Select a commit</h3></div>
    {/if}
  </section>
</div>

<style>
  .history { flex: 1; display: flex; min-height: 0; }
  .left { flex-shrink: 0; display: flex; flex-direction: column; min-height: 0; min-width: 0; border-right: 1px solid var(--border); }
  .right { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .head { display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 8px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
  .search {
    flex: 1; display: flex; align-items: center; gap: 6px; height: 26px; padding: 0 4px 0 9px; border-radius: var(--radius);
    background: var(--surface-1); border: 1px solid var(--border); color: var(--text-faint);
  }
  .search:focus-within { border-color: var(--green-ring); }
  .mode { display: flex; align-items: center; gap: 2px; height: 20px; padding: 0 3px; margin-left: -4px; border: none; border-radius: 4px; background: none; color: var(--text-faint); }
  .mode:hover { background: var(--surface-3); color: #fff; }
  .search input { flex: 1; min-width: 0; border: none; outline: none; background: transparent; color: #fff; font-size: 12px; }
  .search input::placeholder { color: var(--text-dim); }

  .list-wrap { flex: 1; min-height: 0; display: flex; }
  .list-wrap :global(.commits) { flex: 1; }
  .commit { display: flex; align-items: center; gap: 8px; height: 28px; padding-right: 10px; padding-left: 4px; }
  .commit:hover { background: var(--surface-1); }
  .commit.sel { background: var(--surface-3); }
  .commit.picked { background: rgba(192, 132, 252, 0.12); box-shadow: inset 2px 0 0 var(--purple); }
  .focused .commit.sel { background: rgba(74, 222, 128, 0.13); box-shadow: inset 2px 0 0 var(--green); }
  .g { flex-shrink: 0; overflow: hidden; }
  .subject { flex: 1; display: flex; align-items: center; gap: 5px; }
  .msg { overflow: hidden; text-overflow: ellipsis; color: #dfe3e8; }
  .sel .msg { color: #fff; }
  .ref {
    display: inline-flex; align-items: center; gap: 3px; height: 17px; padding: 0 5px; border-radius: 4px; flex-shrink: 0;
    font-size: 10.5px; font-weight: 700; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .ref.head { background: var(--green); color: #04130a; }
  .ref.local { background: var(--green-soft); color: #86efac; }
  .ref.remote { background: rgba(96, 165, 250, 0.16); color: #93c5fd; }
  .ref.tag { background: var(--amber-soft); color: #fde68a; }
  .author { display: flex; align-items: center; gap: 6px; width: 130px; flex-shrink: 0; font-size: 12px; color: var(--text-muted); }
  .av { width: 18px; height: 18px; border-radius: 5px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 8px; font-weight: 800; }
  .date { width: 74px; flex-shrink: 0; text-align: right; font-size: 11.5px; color: var(--text-faint); }
  .sha { width: 56px; flex-shrink: 0; text-align: right; font-size: 11px; color: var(--text-dim); }
  @container (max-width: 520px) { .author { display: none; } }
  .left { container-type: inline-size; }
</style>
