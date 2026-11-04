<script lang="ts">
  import { onMount } from 'svelte'
  import { COMMANDS, eventKeys, isTyping } from '@/lib/commands'
  import { asError } from '@/lib/api'
  import { app } from '@/lib/state.svelte'
  import { menu, overlayOpen } from '@/lib/ui.svelte'
  import TitleBar from '@/components/TitleBar.svelte'
  import TabBar from '@/components/TabBar.svelte'
  import Sidebar from '@/components/Sidebar.svelte'
  import StatusBar from '@/components/StatusBar.svelte'
  import Palette from '@/components/Palette.svelte'
  import Dialogs from '@/components/Dialogs.svelte'
  import ContextMenu from '@/components/ContextMenu.svelte'
  import Toasts from '@/components/Toasts.svelte'
  import Welcome from '@/views/Welcome.svelte'
  import ChangesView from '@/views/ChangesView.svelte'
  import HistoryView from '@/views/HistoryView.svelte'
  import StashView from '@/views/StashView.svelte'
  import FileView from '@/views/FileView.svelte'
  import RebaseView from '@/views/RebaseView.svelte'
  import UndoView from '@/views/UndoView.svelte'
  import CompareView from '@/views/CompareView.svelte'
  import Resizer from '@/components/Resizer.svelte'

  let dragOver = $state(false)

  onMount(() => {
    app.init().catch(e => (app.bootError = asError(e).message))
  })

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (menu.open) return (menu.open = false)
      return
    }
    if (overlayOpen()) return
    const keys = eventKeys(e)
    const cmd = COMMANDS.find(c => c.keys === keys && (!c.when || c.when()) && !(c.notWhileTyping && isTyping()))
    if (!cmd) return
    e.preventDefault()
    cmd.run()
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    dragOver = false
    const file = e.dataTransfer?.files[0]
    if (file) app.addRepo(window.gdg.pathForFile(file))
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="shell"
  role="application"
  ondragover={e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); dragOver = true } }}
  ondragleave={e => { if (!e.relatedTarget) dragOver = false }}
  ondrop={onDrop}
>
  <TitleBar />
  {#if app.ready}<TabBar />{/if}
  {#if !app.ready}
    {#if app.bootError}
      <div class="boot failed"><b>GaetanDev Git could not start</b><span>{app.bootError}</span><button class="btn btn-secondary" onclick={() => location.reload()}>Try again</button></div>
    {:else}
      <div class="boot"><span class="spinner"></span></div>
    {/if}
  {:else if app.repo}
    <div class="body">
      <div class="sidebar-wrap" style="width:{app.settings.sidebarWidth}px">
        <Sidebar />
      </div>
      <Resizer
        value={app.settings.sidebarWidth} min={200} max={420}
        onchange={v => (app.settings.sidebarWidth = v)}
        oncommit={v => app.updateSettings({ sidebarWidth: v })}
      />
      <main class="main">
        {#if app.view === 'changes'}
          <ChangesView />
        {:else if app.view === 'history'}
          <HistoryView />
        {:else if app.view === 'file' && app.fileTarget}
          <FileView />
        {:else if app.view === 'rebase' && app.rebaseTarget}
          <RebaseView />
        {:else if app.view === 'compare' && app.compareTarget}
          <CompareView />
        {:else if app.view === 'undo'}
          <UndoView />
        {:else}
          <StashView />
        {/if}
      </main>
    </div>
  {:else}
    <Welcome />
  {/if}
  <StatusBar />

  {#if dragOver}
    <div class="drop">
      <div class="drop-card">Drop a folder to add it as a repository</div>
    </div>
  {/if}
</div>

<Palette />
<Dialogs />
<ContextMenu />
<Toasts />

<style>
  .shell { display: flex; flex-direction: column; height: 100%; position: relative; }
  .boot { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--green); }
  .boot.failed { flex-direction: column; gap: 10px; color: var(--text-muted); text-align: center; padding: 24px; user-select: text; }
  .boot.failed b { color: #fecaca; font-size: 15px; }
  .body { flex: 1; display: flex; min-height: 0; }
  .sidebar-wrap { flex-shrink: 0; min-width: 0; display: flex; }
  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--panel); border-left: 1px solid var(--border); }
  .drop {
    position: absolute; inset: 0; z-index: 500; display: flex; align-items: center; justify-content: center;
    background: rgba(3, 7, 18, 0.6); backdrop-filter: blur(4px); animation: fadeIn 120ms;
  }
  .drop-card {
    padding: 28px 40px; border-radius: var(--radius-xl); border: 2px dashed var(--green-ring);
    background: rgba(74, 222, 128, 0.08); color: #bbf7d0; font-weight: 700; font-size: 14px;
  }
</style>
