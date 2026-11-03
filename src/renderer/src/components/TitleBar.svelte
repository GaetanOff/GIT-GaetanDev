<script lang="ts">
  import Icon from './Icon.svelte'
  import RepoMenu from './RepoMenu.svelte'
  import BranchMenu from './BranchMenu.svelte'
  import SyncButton from './SyncButton.svelte'
  import { app } from '@/lib/state.svelte'
  import { openDialog, openPalette, overlays } from '@/lib/ui.svelte'
  import { MOD } from '@/lib/format'

  const mac = $derived(app.platform === 'darwin')
  const branchLabel = $derived(
    app.status ? app.status.branch ?? `Detached at ${app.status.head?.slice(0, 7) ?? '?'}` : '…',
  )
</script>

<header class="titlebar" class:mac>
  <div class="brand" title="GaetanDev Git">
    <Icon name="branch" size={16} />
  </div>

  <div class="slot">
    <button class="tb-btn" class:open={overlays.repoMenu} onclick={() => (overlays.repoMenu = !overlays.repoMenu)}>
      <Icon name="repo" size={15} class="tb-icon" />
      <span class="tb-text">
        <span class="tb-label">Repository</span>
        <span class="tb-value truncate">{app.repo?.name ?? 'Choose a repository'}</span>
      </span>
      <Icon name="chevronDown" size={13} class="tb-caret" />
    </button>
    <RepoMenu bind:open={overlays.repoMenu} />
  </div>

  {#if app.repo}
    <div class="slot">
      <button class="tb-btn" class:open={overlays.branchMenu} onclick={() => (overlays.branchMenu = !overlays.branchMenu)}>
        <Icon name="branch" size={15} class="tb-icon" />
        <span class="tb-text">
          <span class="tb-label">Current branch</span>
          <span class="tb-value truncate" class:detached={app.status && !app.status.branch}>{branchLabel}</span>
        </span>
        <Icon name="chevronDown" size={13} class="tb-caret" />
      </button>
      <BranchMenu bind:open={overlays.branchMenu} />
    </div>

    <SyncButton />
  {/if}

  <div class="drag-space"></div>

  <button class="search" onclick={() => openPalette('all')}>
    <Icon name="search" size={14} />
    <span>Search or run a command</span>
    <span class="keys"><kbd>{MOD}</kbd><kbd>K</kbd></span>
  </button>
  <button class="icon-btn settings" title="Settings" onclick={() => openDialog({ kind: 'settings' })}>
    <Icon name="cog" size={16} />
  </button>
  <div class="controls-space"></div>
</header>

<style>
  .titlebar {
    height: var(--titlebar-h); flex-shrink: 0; display: flex; align-items: center; gap: 2px; padding-left: 10px;
    border-bottom: 1px solid var(--border); background: rgba(6, 10, 15, 0.55);
    -webkit-app-region: drag; position: relative; z-index: 50;
  }
  .titlebar.mac { padding-left: 80px; }
  .titlebar > :not(.drag-space):not(.brand) { -webkit-app-region: no-drag; }

  .brand {
    width: 28px; height: 28px; border-radius: var(--radius); margin-right: 6px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center; background: var(--green-soft); color: var(--green);
  }
  .slot { position: relative; height: 100%; display: flex; align-items: center; }

  .tb-btn {
    height: 36px; display: flex; align-items: center; gap: 9px; padding: 0 10px 0 9px; min-width: 150px; max-width: 260px;
    border: none; border-radius: var(--radius); background: transparent; text-align: left; transition: background 120ms;
  }
  .tb-btn:hover, .tb-btn.open { background: var(--surface-2); }
  .tb-btn :global(.tb-icon) { color: var(--text-faint); }
  .tb-btn :global(.tb-caret) { color: var(--text-dim); margin-left: auto; }
  .tb-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.15; }
  .tb-label { font-size: 9.5px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-faint); }
  .tb-value { font-size: 13px; font-weight: 600; color: #fff; }
  .tb-value.detached { color: var(--amber); }

  .drag-space { flex: 1; height: 100%; }

  .search {
    display: flex; align-items: center; gap: 8px; height: 28px; width: 260px; padding: 0 6px 0 10px;
    border-radius: var(--radius); border: 1px solid var(--border); background: var(--surface-1); color: var(--text-faint);
    font-size: 12px; transition: all 120ms;
  }
  .search:hover { background: var(--surface-2); color: var(--text-muted); border-color: var(--border-strong); }
  .search .keys { margin-left: auto; display: flex; gap: 3px; }
  .settings { margin-left: 4px; }
  .controls-space { width: 140px; flex-shrink: 0; height: 100%; -webkit-app-region: drag !important; }
  .mac .controls-space { width: 8px; }
</style>
