<script lang="ts">
  import Icon from './Icon.svelte'
  import { app } from '@/lib/state.svelte'
  import { openDialog } from '@/lib/ui.svelte'

  const st = $derived(app.status)
</script>

<footer class="status">
  {#if app.repo && st}
    <span class="item"><Icon name="branch" size={12} />{st.branch ?? `detached ${st.head?.slice(0, 7) ?? ''}`}</span>
    {#if st.upstream}
      <span class="item dim"><Icon name="cloud" size={12} />{st.upstream}</span>
      {#if st.ahead || st.behind}<span class="item"><span class="up">↑{st.ahead}</span><span class="down">↓{st.behind}</span></span>{/if}
    {:else if st.branch}
      <span class="item dim">not published</span>
    {/if}
    {#if st.operation}<span class="item warn"><Icon name="alert" size={12} />{st.operation} in progress</span>{/if}
    {#if app.provider}<span class="item dim">{app.provider.label}</span>{/if}
  {/if}
  <span class="grow"></span>
  {#if app.busy}
    <span class="item busy"><span class="spinner"></span>{app.progress?.phase ?? app.busy}{app.progress?.percent !== undefined ? ` ${app.progress.percent}%` : ''}</span>
  {/if}
  <button class="item link" onclick={() => openDialog({ kind: 'shortcuts' })} title="Keyboard shortcuts"><Icon name="command" size={12} />Shortcuts</button>
  <span class="item dim">v{app.version}</span>
</footer>

<style>
  .status {
    height: var(--statusbar-h); flex-shrink: 0; display: flex; align-items: center; gap: 2px; padding: 0 8px;
    border-top: 1px solid var(--border); background: rgba(6, 10, 15, 0.7); font-size: 11px; color: var(--text-muted);
  }
  .item { display: inline-flex; align-items: center; gap: 5px; padding: 0 7px; height: 100%; white-space: nowrap; }
  .dim { color: var(--text-faint); }
  .up { color: #86efac; font-weight: 700; margin-right: 4px; }
  .down { color: #93c5fd; font-weight: 700; }
  .warn { color: var(--amber); text-transform: capitalize; }
  .busy { color: var(--green); }
  .busy .spinner { width: 10px; height: 10px; border-width: 1.5px; }
  .link { border: none; background: none; color: var(--text-faint); font-size: 11px; }
  .link:hover { color: #fff; background: var(--surface-2); }
</style>
