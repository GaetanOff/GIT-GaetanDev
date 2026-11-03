<script lang="ts">
  import type { Snippet } from 'svelte'
  import Icon from './Icon.svelte'
  import type { Branch } from '@shared/types'
  import type { IconName } from '@/lib/icons'
  import { branchMenu, dropBranch, stashMenu, tagMenu } from '@/lib/actions'
  import type { Submodule, Worktree } from '@shared/types'
  import { api } from '@/lib/api'
  import { relativeTime } from '@/lib/format'
  import { app } from '@/lib/state.svelte'
  import { confirm, contextMenu, openDialog } from '@/lib/ui.svelte'

  let filter = $state('')
  let collapsed = $state<Record<string, boolean>>(loadCollapsed())

  function loadCollapsed(): Record<string, boolean> {
    try { return JSON.parse(localStorage.getItem('sidebar-collapsed') ?? '{"tags":true}') } catch { return { tags: true } }
  }
  function toggle(key: string) {
    collapsed[key] = !collapsed[key]
    try { localStorage.setItem('sidebar-collapsed', JSON.stringify(collapsed)) } catch { /* ignore */ }
  }

  const f = $derived(filter.trim().toLowerCase())
  const match = (s: string) => !f || s.toLowerCase().includes(f)

  interface Group { prefix: string; branches: Branch[] }
  /** "feature/login" and "feature/signup" share a "feature" folder. */
  function grouped(list: Branch[], strip = ''): { loose: Branch[]; groups: Group[] } {
    const loose: Branch[] = []
    const map = new Map<string, Branch[]>()
    for (const b of list) {
      const name = strip ? b.name.slice(strip.length) : b.name
      const i = name.indexOf('/')
      if (i < 0) loose.push(b)
      else {
        const prefix = name.slice(0, i)
        map.set(prefix, [...(map.get(prefix) ?? []), b])
      }
    }
    const groups = [...map.entries()].map(([prefix, branches]) => ({ prefix, branches })).sort((a, b) => a.prefix.localeCompare(b.prefix))
    return { loose: loose.sort(byCurrentThenName), groups }
  }
  const byCurrentThenName = (a: Branch, b: Branch) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name)

  const locals = $derived(grouped(app.localBranches.filter(b => match(b.name))))
  const remotes = $derived(app.refs.remotes.map(r => ({
    remote: r,
    tree: grouped(app.remoteBranches.filter(b => b.remoteName === r.name && match(b.name)), `${r.name}/`),
  })))
  const tags = $derived(app.refs.tags.filter(t => match(t.name)))
  const stashes = $derived(app.refs.stashes.filter(s => match(s.message)))
  const changeCount = $derived(app.files.length)

  function showBranch(b: Branch) {
    app.view = 'history'
    app.selectedCommit = b.sha
  }

  async function removeRemote(name: string) {
    const repo = app.repo!.path
    const ok = await confirm({ title: `Remove remote “${name}”?`, message: 'Its remote-tracking branches are deleted locally. Nothing changes on the server.', confirmLabel: 'Remove', danger: true })
    if (ok) await app.run('Removing remote', () => api['git:removeRemote'](repo, name))
  }

  /* Drag a branch onto another to merge or rebase. */
  let dragBranch = $state<string | null>(null)
  let dropTarget = $state<string | null>(null)

  const sep = $derived(app.platform === 'win32' ? '\\' : '/')
  const subPath = (s: Submodule) => `${app.repo!.path}${sep}${s.path.replace(/\//g, sep)}`
  const SUB_STATE: Record<Submodule['state'], { label: string; cls: string }> = {
    ok: { label: '', cls: '' },
    uninitialized: { label: 'not cloned', cls: 'amber' },
    modified: { label: 'moved', cls: 'blue' },
    conflict: { label: 'conflict', cls: 'red' },
  }

  function submoduleMenu(e: MouseEvent, s: Submodule) {
    contextMenu(e, [
      { label: s.state === 'uninitialized' ? 'Clone (init & update)' : 'Update to recorded commit', icon: 'download', run: () => app.run(`Updating ${s.path}`, () => api['git:submoduleUpdate'](app.repo!.path, s.path)) },
      { label: 'Open as repository', icon: 'repo', disabled: s.state === 'uninitialized', run: () => app.addRepo(subPath(s)) },
      { label: 'Show in Explorer', icon: 'folder', run: () => api['shell:reveal'](app.repo!.path, s.path) },
      'sep',
      { label: 'Copy URL', icon: 'copy', disabled: !s.url, run: () => app.copy(s.url, 'URL copied') },
    ])
  }

  function worktreeMenu(e: MouseEvent, w: Worktree) {
    contextMenu(e, [
      { label: 'Open as repository', icon: 'repo', disabled: w.current, run: () => app.addRepo(w.path) },
      { label: 'Show in Explorer', icon: 'folder', run: () => api['shell:reveal'](w.path) },
      { label: 'Open in terminal', icon: 'terminal', run: () => api['shell:terminal'](w.path) },
      'sep',
      { label: 'Remove worktree…', icon: 'trash', danger: true, disabled: w.current || w.bare, run: async () => {
        const repo = app.repo!.path
        const ok = await confirm({ title: 'Remove this worktree?', message: `The folder ${w.path} is deleted. Its branch ${w.branch ?? ''} stays.`, confirmLabel: 'Remove', danger: true })
        if (!ok) return
        try {
          await api['git:worktreeRemove'](repo, w.path, false)
        } catch (err) {
          const force = await confirm({ title: 'Worktree has changes', message: `${(err as { message: string }).message}\n\nRemove it anyway and lose them?`, confirmLabel: 'Remove anyway', danger: true })
          if (force) await app.run('Removing worktree', () => api['git:worktreeRemove'](repo, w.path, true))
        }
        await app.refreshRefs()
      } },
    ])
  }

  const providerIcon = (kind?: string): IconName => (kind === 'github' || kind === 'gitlab' || kind === 'azure' || kind === 'bitbucket' ? 'cloud' : 'globe')
</script>

<aside class="sidebar">
  <nav class="nav">
    <button class="nav-item" class:on={app.view === 'changes'} onclick={() => (app.view = 'changes')}>
      <Icon name="changes" size={15} />
      <span class="grow">Changes</span>
      {#if changeCount}<span class="count" class:conflict={app.conflicted.length}>{changeCount}</span>{/if}
    </button>
    <button class="nav-item" class:on={app.view === 'history'} onclick={() => (app.view = 'history')}>
      <Icon name="history" size={15} />
      <span class="grow">History</span>
    </button>
    <button class="nav-item" class:on={app.view === 'undo'} onclick={() => (app.view = 'undo')}>
      <Icon name="undo" size={15} />
      <span class="grow">Undo history</span>
    </button>
  </nav>

  <div class="filter">
    <Icon name="search" size={13} />
    <input bind:value={filter} placeholder="Filter branches, tags, stashes" spellcheck="false" />
    {#if filter}<button class="icon-btn sm" onclick={() => (filter = '')}><Icon name="x" size={12} /></button>{/if}
  </div>

  <div class="refs">
    {#snippet branchRow(b: Branch, label: string, depth: number)}
      <button
        class="ref" class:current={b.current} class:droptarget={dropTarget === b.name} style="padding-left:{10 + depth * 14}px"
        title="{b.name}{b.subject ? `\n${b.subject}` : ''}\n{relativeTime(b.date)}\nDrag onto another branch to merge or rebase"
        onclick={() => showBranch(b)} ondblclick={() => !b.current && app.checkout(b.name)}
        oncontextmenu={e => contextMenu(e, branchMenu(b))}
        draggable="true"
        ondragstart={e => { dragBranch = b.name; e.dataTransfer!.effectAllowed = 'move'; e.dataTransfer!.setData('text/plain', b.name) }}
        ondragend={() => { dragBranch = null; dropTarget = null }}
        ondragover={e => { if (dragBranch && !b.remote && dragBranch !== b.name) { e.preventDefault(); dropTarget = b.name } }}
        ondragleave={() => { if (dropTarget === b.name) dropTarget = null }}
        ondrop={e => { e.preventDefault(); const d = dragBranch; dragBranch = null; dropTarget = null; if (d && !b.remote) dropBranch(d, b.name) }}
      >
        {#if b.current}<span class="dot"></span>{:else}<Icon name="branch" size={13} class="ri" />{/if}
        <span class="grow truncate">{label}</span>
        {#if b.gone}<span class="badge red" title="Upstream branch was deleted">gone</span>{/if}
        {#if b.behind}<span class="ab down">↓{b.behind}</span>{/if}
        {#if b.ahead}<span class="ab up">↑{b.ahead}</span>{/if}
      </button>
    {/snippet}

    {#snippet tree(t: { loose: Branch[]; groups: Group[] }, strip: string, key: string, depth: number)}
      {#each t.groups as g (g.prefix)}
        {@const gk = `${key}/${g.prefix}`}
        <button class="ref folder" style="padding-left:{10 + depth * 14}px" onclick={() => toggle(gk)}>
          <Icon name={collapsed[gk] ? 'chevronRight' : 'chevronDown'} size={11} class="caret" />
          <Icon name="folder" size={13} class="ri" />
          <span class="grow truncate">{g.prefix}</span>
          <span class="n">{g.branches.length}</span>
        </button>
        {#if !collapsed[gk] || f}
          {#each g.branches as b (b.fullRef)}
            {@render branchRow(b, b.name.slice(strip.length + g.prefix.length + 1), depth + 1)}
          {/each}
        {/if}
      {/each}
      {#each t.loose as b (b.fullRef)}{@render branchRow(b, b.name.slice(strip.length), depth)}{/each}
    {/snippet}

    {#snippet section(key: string, title: string, count: number, actions?: Snippet)}
      <div class="section-head">
        <button class="section-btn" onclick={() => toggle(key)}>
          <Icon name={collapsed[key] && !f ? 'chevronRight' : 'chevronDown'} size={11} />
          <span class="label">{title}</span>
          <span class="n">{count}</span>
        </button>
        {@render actions?.()}
      </div>
    {/snippet}

    {#snippet addBranch()}
      <button class="icon-btn sm" title="New branch" onclick={() => openDialog({ kind: 'branch' })}><Icon name="plus" size={13} /></button>
    {/snippet}
    {@render section('local', 'Branches', app.localBranches.length, addBranch)}
    {#if !collapsed.local || f}
      {@render tree(locals, '', 'local', 0)}
      {#if !app.localBranches.length}<div class="muted">No commits yet</div>{/if}
    {/if}

    {#snippet addRemote()}
      <button class="icon-btn sm" title="Add remote" onclick={() => openDialog({ kind: 'remote' })}><Icon name="plus" size={13} /></button>
    {/snippet}
    {@render section('remotes', 'Remotes', app.refs.remotes.length, addRemote)}
    {#if !collapsed.remotes || f}
      {#each remotes as { remote, tree: t } (remote.name)}
        {@const rk = `remote:${remote.name}`}
        <button
          class="ref folder" onclick={() => toggle(rk)}
          title={remote.fetchUrl}
          oncontextmenu={e => contextMenu(e, [
            ...(remote.provider ? [{ label: `Open on ${remote.provider.label}`, icon: 'globe' as const, run: () => api['shell:openUrl'](remote.provider!.web) }] : []),
            { label: 'Copy URL', icon: 'copy', run: () => app.copy(remote.fetchUrl, 'URL copied') },
            'sep',
            { label: 'Remove remote…', icon: 'trash', danger: true, run: () => removeRemote(remote.name) },
          ])}
        >
          <Icon name={collapsed[rk] ? 'chevronRight' : 'chevronDown'} size={11} class="caret" />
          <Icon name={providerIcon(remote.provider?.kind)} size={13} class="ri" />
          <span class="grow truncate">{remote.name}</span>
          {#if remote.provider}<span class="prov">{remote.provider.label}</span>{/if}
        </button>
        {#if !collapsed[rk] || f}{@render tree(t, `${remote.name}/`, rk, 1)}{/if}
      {/each}
      {#if !app.refs.remotes.length}<div class="muted">No remote. Add one to push.</div>{/if}
    {/if}

    {@render section('tags', 'Tags', app.refs.tags.length)}
    {#if !collapsed.tags || f}
      {#each tags as t (t.name)}
        <button class="ref" style="padding-left:10px" title={t.subject}
          onclick={() => { app.view = 'history'; app.selectedCommit = t.sha }}
          oncontextmenu={e => contextMenu(e, tagMenu(t))}>
          <Icon name="tag" size={13} class="ri" />
          <span class="grow truncate">{t.name}</span>
        </button>
      {/each}
    {/if}

    {@render section('stashes', 'Stashes', app.refs.stashes.length)}
    {#if !collapsed.stashes || f}
      {#each stashes as s (s.sha)}
        <button class="ref" class:sel={app.view === 'stash' && app.selectedStash === s.index} style="padding-left:10px"
          title="{s.message}\non {s.branch}, {relativeTime(s.date)}"
          onclick={() => { app.selectedStash = s.index; app.view = 'stash' }}
          oncontextmenu={e => contextMenu(e, stashMenu(s))}>
          <Icon name="stash" size={13} class="ri" />
          <span class="grow truncate">{s.message}</span>
          <span class="when">{relativeTime(s.date)}</span>
        </button>
      {/each}
      {#if !app.refs.stashes.length}<div class="muted">Nothing stashed</div>{/if}
    {/if}

    {#if app.refs.submodules.length}
      {#snippet updateAll()}
        <button class="icon-btn sm" title="Init & update all submodules" onclick={() => app.run('Updating submodules', () => api['git:submoduleUpdate'](app.repo!.path, null))}><Icon name="download" size={13} /></button>
      {/snippet}
      {@render section('submodules', 'Submodules', app.refs.submodules.length, updateAll)}
      {#if !collapsed.submodules || f}
        {#each app.refs.submodules.filter(s => match(s.path)) as sm (sm.path)}
          {@const st = SUB_STATE[sm.state]}
          <button class="ref" style="padding-left:10px" title="{sm.path}\n{sm.url}\n{sm.sha.slice(0, 10)} {sm.describe}"
            ondblclick={() => sm.state !== 'uninitialized' && app.addRepo(subPath(sm))}
            oncontextmenu={e => submoduleMenu(e, sm)} onclick={e => submoduleMenu(e, sm)}>
            <Icon name="repo" size={13} class="ri" />
            <span class="grow truncate">{sm.path}</span>
            {#if st.label}<span class="badge {st.cls}">{st.label}</span>{/if}
          </button>
        {/each}
      {/if}
    {/if}

    {#if app.refs.worktrees.length > 1 || app.localBranches.length}
      {#snippet addWorktree()}
        <button class="icon-btn sm" title="New worktree" onclick={() => openDialog({ kind: 'worktree' })}><Icon name="plus" size={13} /></button>
      {/snippet}
      {@render section('worktrees', 'Worktrees', app.refs.worktrees.length, addWorktree)}
      {#if !collapsed.worktrees || f}
        {#each app.refs.worktrees as w (w.path)}
          <button class="ref" class:current={w.current} style="padding-left:10px" title={w.path}
            ondblclick={() => !w.current && app.addRepo(w.path)} oncontextmenu={e => worktreeMenu(e, w)}>
            {#if w.current}<span class="dot"></span>{:else}<Icon name="tree" size={13} class="ri" />{/if}
            <span class="grow truncate">{w.branch ?? (w.bare ? 'bare' : `detached ${w.head.slice(0, 7)}`)}</span>
            {#if w.locked}<span class="badge">locked</span>{/if}
            {#if w.prunable}<span class="badge amber">missing</span>{/if}
            <span class="when truncate wt">{w.path.split(/[\\/]/).pop()}</span>
          </button>
        {/each}
      {/if}
    {/if}
  </div>
</aside>

<style>
  .sidebar { flex: 1; min-width: 0; display: flex; flex-direction: column; background: rgba(6, 10, 15, 0.35); }
  .nav { display: flex; flex-direction: column; gap: 2px; padding: 8px 8px 6px; }
  .nav-item {
    display: flex; align-items: center; gap: 10px; height: 32px; padding: 0 10px; border-radius: var(--radius);
    border: 1px solid transparent; background: transparent; color: var(--text-muted); font-weight: 500; text-align: left;
    transition: background 120ms, color 120ms;
  }
  .nav-item:hover { background: var(--surface-2); color: #fff; }
  .nav-item.on { background: var(--surface-3); border-color: var(--border); color: #fff; }
  .nav-item.on :global(svg) { color: var(--green); }
  .count {
    min-width: 20px; height: 18px; padding: 0 6px; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center;
    background: var(--green-soft); color: #86efac; font-size: 10.5px; font-weight: 800; font-variant-numeric: tabular-nums;
  }
  .count.conflict { background: var(--red-soft); color: #fca5a5; }

  .filter {
    display: flex; align-items: center; gap: 6px; margin: 2px 8px 6px; height: 28px; padding: 0 4px 0 9px;
    border-radius: var(--radius); background: var(--surface-1); border: 1px solid var(--border); color: var(--text-faint);
  }
  .filter:focus-within { border-color: var(--green-ring); }
  .filter input { flex: 1; min-width: 0; border: none; outline: none; background: transparent; color: #fff; font-size: 12px; }
  .filter input::placeholder { color: var(--text-dim); }

  .refs { flex: 1; overflow-y: auto; padding: 0 6px 12px; }
  .section-head { display: flex; align-items: center; margin-top: 8px; padding-right: 2px; }
  .section-btn { flex: 1; display: flex; align-items: center; gap: 6px; height: 26px; padding: 0 6px; border: none; background: none; color: var(--text-faint); }
  .section-btn:hover .label { color: var(--text-muted); }
  .n { font-size: 10.5px; color: var(--text-dim); font-variant-numeric: tabular-nums; }

  .ref {
    width: 100%; display: flex; align-items: center; gap: 7px; height: 26px; padding-right: 8px;
    border: none; border-radius: var(--radius-sm); background: transparent; color: #c9cdd3; font-size: 12.5px; text-align: left;
  }
  .ref:hover { background: var(--surface-2); color: #fff; }
  .ref.sel { background: var(--surface-3); color: #fff; }
  .ref.current { color: #fff; font-weight: 600; }
  .ref :global(.ri) { color: var(--text-faint); }
  .ref :global(.caret) { color: var(--text-dim); margin-left: -4px; }
  .ref.folder { color: var(--text-muted); }
  .dot { width: 13px; display: flex; justify-content: center; }
  .dot::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--green); box-shadow: 0 0 0 3px var(--green-soft); }
  .ab { font-size: 10.5px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .ab.down { color: #93c5fd; }
  .ab.up { color: #86efac; }
  .prov { font-size: 10px; color: var(--text-dim); }
  .when { font-size: 10.5px; color: var(--text-dim); flex-shrink: 0; }
  .muted { padding: 3px 12px 3px 28px; font-size: 11.5px; color: var(--text-dim); }
  .ref.droptarget { background: var(--green-soft); box-shadow: inset 0 0 0 1px var(--green-ring); color: #fff; }
  .wt { max-width: 90px; }
</style>
