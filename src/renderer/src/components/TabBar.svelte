<script lang="ts">
  import Icon from './Icon.svelte'
  import { api } from '@/lib/api'
  import { tone } from '@/lib/format'
  import { app } from '@/lib/state.svelte'
  import { contextMenu, overlays, toast } from '@/lib/ui.svelte'

  let dragging = $state<string | null>(null)
  let dropIndex = $state<number | null>(null)

  const tabs = $derived(app.tabs.map(id => app.repos.find(r => r.id === id)).filter(r => !!r))

  function open(id: string) {
    if (id !== app.repo?.id) app.openRepo(id).catch(e => toast('error', e.message))
  }

  function menu(e: MouseEvent, id: string, path: string) {
    contextMenu(e, [
      { label: 'Close tab', icon: 'x', hint: 'Ctrl+W', run: () => app.closeTab(id) },
      { label: 'Close other tabs', icon: 'x', disabled: app.tabs.length < 2, run: async () => {
        if (app.repo?.id !== id) await app.openRepo(id)
        for (const t of app.tabs.filter(t => t !== id)) await app.closeTab(t)
      } },
      'sep',
      { label: 'Show in Explorer', icon: 'folder', run: () => api['shell:reveal'](path) },
      { label: 'Open in terminal', icon: 'terminal', run: () => api['shell:terminal'](path).catch(e => toast('error', e.message)) },
    ])
  }

  function onDragOver(e: DragEvent, i: number) {
    if (!dragging) return
    e.preventDefault()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    dropIndex = e.clientX < r.left + r.width / 2 ? i : i + 1
  }
  function onDrop() {
    if (dragging && dropIndex !== null) {
      const from = app.tabs.indexOf(dragging)
      app.moveTab(dragging, dropIndex > from ? dropIndex - 1 : dropIndex)
    }
    dragging = null
    dropIndex = null
  }
</script>

{#if tabs.length}
  <div class="tabbar" role="tablist" aria-label="Open repositories">
    {#each tabs as r, i (r.id)}
      {@const t = tone(r.name)}
      {@const active = r.id === app.repo?.id}
      {#if dropIndex === i}<span class="drop"></span>{/if}
      <div
        class="tab" class:active role="tab" aria-selected={active} tabindex="0" title={r.path}
        draggable="true"
        ondragstart={e => { dragging = r.id; e.dataTransfer!.effectAllowed = 'move'; e.dataTransfer!.setData('text/plain', r.id) }}
        ondragover={e => onDragOver(e, i)} ondrop={onDrop} ondragend={() => { dragging = null; dropIndex = null }}
        onclick={() => open(r.id)}
        onauxclick={e => { if (e.button === 1) { e.preventDefault(); app.closeTab(r.id) } }}
        onkeydown={e => { if (e.key === 'Enter') open(r.id) }}
        oncontextmenu={e => menu(e, r.id, r.path)}
      >
        <span class="dot" style="background:{t.fg}"></span>
        <span class="name truncate">{r.name}</span>
        {#if active && app.status?.branch}<span class="branch truncate">{app.status.branch}</span>{/if}
        {#if active && app.files.length}<span class="count">{app.files.length}</span>{/if}
        <button class="close" title="Close tab (Ctrl+W)" onclick={e => { e.stopPropagation(); app.closeTab(r.id) }}><Icon name="x" size={11} /></button>
      </div>
    {/each}
    {#if dropIndex === tabs.length}<span class="drop"></span>{/if}
    <button class="add" title="Open another repository (Ctrl+T)" onclick={() => (overlays.repoMenu = true)}><Icon name="plus" size={13} /></button>
  </div>
{/if}

<style>
  .tabbar {
    display: flex; align-items: stretch; gap: 2px; height: 32px; padding: 0 8px; flex-shrink: 0; overflow-x: auto; overflow-y: hidden;
    border-bottom: 1px solid var(--border); background: rgba(6, 10, 15, 0.45); scrollbar-width: none;
  }
  .tabbar::-webkit-scrollbar { display: none; }
  .tab {
    display: flex; align-items: center; gap: 7px; max-width: 260px; min-width: 120px; padding: 0 6px 0 10px; margin-top: 4px;
    border-radius: var(--radius) var(--radius) 0 0; border: 1px solid transparent; border-bottom: none;
    color: var(--text-muted); font-size: 12px; cursor: default; position: relative; outline: none;
  }
  .tab:hover { background: var(--surface-1); color: #fff; }
  .tab.active { background: var(--panel-solid); border-color: var(--border); color: #fff; }
  .tab.active::after { content: ''; position: absolute; left: 8px; right: 8px; top: -1px; height: 2px; border-radius: 2px; background: var(--green); }
  .tab:focus-visible { box-shadow: inset 0 0 0 1px var(--green-ring); }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; opacity: 0.8; }
  .name { font-weight: 600; flex-shrink: 1; }
  .branch { color: var(--text-faint); font-size: 11px; flex-shrink: 2; }
  .count { min-width: 16px; height: 15px; padding: 0 4px; border-radius: 8px; background: var(--green-soft); color: #86efac; font-size: 9.5px; font-weight: 800; display: flex; align-items: center; justify-content: center; }
  .close { margin-left: auto; width: 18px; height: 18px; border: none; border-radius: 4px; background: none; color: var(--text-dim); display: flex; align-items: center; justify-content: center; opacity: 0; flex-shrink: 0; }
  .tab:hover .close, .tab.active .close { opacity: 1; }
  .close:hover { background: var(--surface-3); color: #fff; }
  .add { width: 26px; margin: 5px 0 1px 2px; border: none; border-radius: var(--radius-sm); background: none; color: var(--text-faint); display: flex; align-items: center; justify-content: center; }
  .add:hover { background: var(--surface-2); color: #fff; }
  .drop { width: 2px; margin: 6px -1px 2px; border-radius: 1px; background: var(--green); flex-shrink: 0; }
</style>
