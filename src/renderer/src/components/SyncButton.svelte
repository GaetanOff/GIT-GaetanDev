<script lang="ts">
  import Icon from './Icon.svelte'
  import type { IconName } from '@/lib/icons'
  import { app } from '@/lib/state.svelte'
  import { confirm, menuAt, openDialog } from '@/lib/ui.svelte'

  let now = $state(Date.now())
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 30_000)
    return () => clearInterval(t)
  })

  const remote = $derived(app.status?.upstream?.split('/')[0] ?? app.refs.remotes[0]?.name ?? 'origin')
  const hasRemote = $derived(app.refs.remotes.length > 0)

  const action = $derived.by((): { icon: IconName; title: string; sub: string } => {
    const st = app.status
    if (!hasRemote) return { icon: 'cloud', title: 'Add a remote', sub: 'No remote configured' }
    if (st && !st.branch) return { icon: 'fetch', title: `Fetch ${remote}`, sub: fetchedLabel(now) }
    if (st && !st.upstream) return { icon: 'cloud', title: 'Publish branch', sub: `Push to ${remote} and track it` }
    if (st?.behind) return { icon: 'pull', title: `Pull ${remote}`, sub: fetchedLabel(now) }
    if (st?.ahead) return { icon: 'push', title: `Push ${remote}`, sub: fetchedLabel(now) }
    return { icon: 'fetch', title: `Fetch ${remote}`, sub: fetchedLabel(now) }
  })

  function fetchedLabel(t: number): string {
    if (!app.lastFetched) return 'Not fetched this session'
    const min = Math.round((t - app.lastFetched) / 60_000)
    return min < 1 ? 'Fetched just now' : `Fetched ${min} min ago`
  }

  const working = $derived(!!app.busy && /Fetch|Pull|Push|Publish/.test(app.busy))
  const progressText = $derived(
    app.progress ? `${app.progress.phase ?? app.progress.title}${app.progress.percent !== undefined ? ` ${app.progress.percent}%` : ''}` : app.busy ?? '',
  )

  function primary() {
    if (!hasRemote) return openDialog({ kind: 'remote' })
    app.sync()
  }

  function more(e: MouseEvent) {
    menuAt(e.currentTarget as HTMLElement, [
      { label: 'Fetch all remotes', icon: 'fetch', hint: 'Ctrl+Shift+F', disabled: !hasRemote, run: () => app.fetch() },
      { label: 'Pull', icon: 'pull', hint: 'Ctrl+Shift+L', disabled: !app.status?.upstream, run: () => app.pull() },
      { label: 'Push', icon: 'push', hint: 'Ctrl+Shift+U', disabled: !hasRemote || !app.status?.branch, run: () => app.push() },
      'sep',
      {
        label: 'Force push (with lease)…', icon: 'push', danger: true, disabled: !app.status?.upstream,
        run: async () => {
          const ok = await confirm({ title: 'Force push?', message: 'This overwrites the remote branch with your local one. It fails safely if someone else pushed in the meantime.', confirmLabel: 'Force push', danger: true })
          if (ok) app.push(true)
        },
      },
      { label: 'Add remote…', icon: 'cloud', run: () => openDialog({ kind: 'remote' }) },
    ])
  }
</script>

<div class="sync" class:working>
  <button class="main" onclick={primary} disabled={!!app.busy}>
    <span class="ico">
      {#if working}<span class="spinner"></span>{:else}<Icon name={action.icon} size={15} />{/if}
    </span>
    <span class="text">
      <span class="title">{working ? app.busy : action.title}</span>
      <span class="sub truncate">{working ? progressText : action.sub}</span>
    </span>
    {#if !working && app.status}
      {#if app.status.behind}<span class="count down" title="{app.status.behind} to pull"><Icon name="pull" size={11} stroke={2.5} />{app.status.behind}</span>{/if}
      {#if app.status.ahead}<span class="count up" title="{app.status.ahead} to push"><Icon name="push" size={11} stroke={2.5} />{app.status.ahead}</span>{/if}
    {/if}
  </button>
  <button class="caret" onclick={more} title="More sync actions" disabled={!!app.busy}>
    <Icon name="chevronDown" size={13} />
  </button>
  {#if working && app.progress?.percent !== undefined}
    <div class="bar" style="width:{app.progress.percent}%"></div>
  {/if}
</div>

<style>
  .sync { position: relative; display: flex; align-items: center; height: 36px; border-radius: var(--radius); margin-left: 2px; }
  .main {
    height: 100%; display: flex; align-items: center; gap: 9px; padding: 0 10px 0 9px; min-width: 190px; max-width: 280px;
    border: none; background: transparent; border-radius: var(--radius) 0 0 var(--radius); text-align: left; transition: background 120ms;
  }
  .caret { height: 100%; width: 22px; border: none; background: transparent; color: var(--text-dim); border-radius: 0 var(--radius) var(--radius) 0; }
  .main:not(:disabled):hover, .caret:not(:disabled):hover { background: var(--surface-2); color: #fff; }
  .main:disabled, .caret:disabled { cursor: default; }
  .ico { color: var(--text-faint); display: flex; width: 15px; justify-content: center; }
  .working .ico { color: var(--green); }
  .text { display: flex; flex-direction: column; min-width: 0; line-height: 1.15; flex: 1; }
  .title { font-size: 13px; font-weight: 600; color: #fff; white-space: nowrap; }
  .sub { font-size: 10.5px; color: var(--text-faint); }
  .count {
    display: inline-flex; align-items: center; gap: 2px; height: 18px; padding: 0 5px; border-radius: 5px;
    font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums;
  }
  .count.down { background: rgba(96, 165, 250, 0.18); color: #93c5fd; }
  .count.up { background: var(--green-soft); color: #86efac; }
  .bar { position: absolute; left: 6px; bottom: 1px; height: 2px; max-width: calc(100% - 12px); border-radius: 2px; background: var(--green); transition: width 200ms; }
</style>
