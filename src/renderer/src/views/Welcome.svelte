<script lang="ts">
  import Icon from '@/components/Icon.svelte'
  import { pickAndAddRepo, pickAndInitRepo } from '@/lib/commands'
  import { MOD, relativeTime, tone } from '@/lib/format'
  import { app } from '@/lib/state.svelte'
  import { openDialog, toast } from '@/lib/ui.svelte'

  const recent = $derived([...app.repos].sort((a, b) => b.lastOpened - a.lastOpened).slice(0, 8))

  async function open(id: string) {
    try { await app.openRepo(id) } catch (e) { toast('error', (e as { message: string }).message) }
  }
</script>

<div class="welcome">
  <div class="blob a"></div>
  <div class="blob b"></div>
  <div class="inner">
    <div class="hero">
      <div class="logo"><Icon name="branch" size={28} /></div>
      <p class="label">gaetandev.fr</p>
      <h1>GaetanDev Git</h1>
      <p class="tag">A fast, keyboard-first Git client for GitHub, GitLab, Azure DevOps, Bitbucket, Gitea and any other remote.</p>
    </div>

    <div class="actions">
      <button class="action" onclick={() => openDialog({ kind: 'clone' })}>
        <span class="ico green"><Icon name="download" size={20} /></span>
        <span class="t"><b>Clone a repository</b><span>From any URL, HTTPS or SSH</span></span>
        <kbd>{MOD}+Shift+O</kbd>
      </button>
      <button class="action" onclick={pickAndAddRepo}>
        <span class="ico blue"><Icon name="folder" size={20} /></span>
        <span class="t"><b>Add a local repository</b><span>Or drop a folder on this window</span></span>
        <kbd>{MOD}+O</kbd>
      </button>
      <button class="action" onclick={pickAndInitRepo}>
        <span class="ico purple"><Icon name="plus" size={20} /></span>
        <span class="t"><b>Create a new repository</b><span>git init in a folder of your choice</span></span>
      </button>
    </div>

    {#if recent.length}
      <div class="recent">
        <p class="label">Recent</p>
        {#each recent as r (r.id)}
          {@const t = tone(r.name)}
          <button class="repo" onclick={() => open(r.id)}>
            <span class="av" style="background:{t.bg};color:{t.fg}">{r.name.slice(0, 2).toUpperCase()}</span>
            <span class="grow"><b class="truncate">{r.name}</b><span class="truncate path">{r.path}</span></span>
            <span class="when">{relativeTime(Math.floor(r.lastOpened / 1000))}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .welcome { flex: 1; position: relative; overflow: auto; display: flex; justify-content: center; }
  /* The SSH Console background blobs, as a nod to the original design. */
  .blob { position: absolute; border-radius: 50%; filter: blur(70px); pointer-events: none; }
  .blob.a { width: 340px; height: 340px; background: #5eead4; opacity: 0.08; top: 6%; right: 8%; }
  .blob.b { width: 300px; height: 300px; background: #a3e635; opacity: 0.05; bottom: 4%; left: 6%; }
  .inner { position: relative; width: 100%; max-width: 620px; padding: 8vh 24px 40px; display: flex; flex-direction: column; gap: 28px; }
  .hero { text-align: center; display: flex; flex-direction: column; align-items: center; gap: 6px; }
  .logo { width: 56px; height: 56px; border-radius: var(--radius-xl); background: var(--green-soft); color: var(--green); display: flex; align-items: center; justify-content: center; margin-bottom: 8px; box-shadow: 0 0 0 1px rgba(74, 222, 128, 0.2), 0 12px 40px rgba(74, 222, 128, 0.12); }
  h1 { margin: 0; font-size: 28px; font-weight: 800; color: #fff; letter-spacing: -0.01em; }
  .tag { margin: 4px 0 0; color: var(--text-muted); font-size: 13.5px; max-width: 460px; }

  .actions { display: flex; flex-direction: column; gap: 8px; }
  .action {
    display: flex; align-items: center; gap: 14px; padding: 14px 16px; text-align: left;
    border-radius: var(--radius-xl); border: 1px solid var(--border); background: rgba(255, 255, 255, 0.04);
    backdrop-filter: blur(20px); transition: all 160ms;
  }
  .action:hover { background: rgba(255, 255, 255, 0.08); border-color: var(--border-strong); transform: translateY(-1px); }
  .ico { width: 42px; height: 42px; border-radius: var(--radius-lg); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .ico.green { background: var(--green-soft); color: var(--green); }
  .ico.blue { background: rgba(96, 165, 250, 0.16); color: var(--blue); }
  .ico.purple { background: var(--purple-soft); color: var(--purple); }
  .t { flex: 1; display: flex; flex-direction: column; gap: 2px; }
  .t b { color: #fff; font-size: 14px; }
  .t span { color: var(--text-faint); font-size: 12px; }

  .recent { display: flex; flex-direction: column; gap: 2px; }
  .recent .label { margin: 0 0 6px 4px; }
  .repo { display: flex; align-items: center; gap: 12px; padding: 8px 10px; border: none; border-radius: var(--radius-lg); background: transparent; text-align: left; }
  .repo:hover { background: var(--surface-2); }
  .av { width: 30px; height: 30px; border-radius: var(--radius); display: flex; align-items: center; justify-content: center; font-size: 10.5px; font-weight: 800; flex-shrink: 0; }
  .grow { display: flex; flex-direction: column; min-width: 0; }
  .grow b { color: #e5e7eb; font-weight: 600; }
  .path { font-size: 11px; color: var(--text-faint); }
  .when { font-size: 11px; color: var(--text-dim); }
</style>
