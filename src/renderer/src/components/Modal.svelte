<script lang="ts">
  import type { Snippet } from 'svelte'
  import Icon from './Icon.svelte'
  import type { IconName } from '@/lib/icons'

  let { title, icon, tone = 'green', width = 460, onclose, onsubmit, children, footer }: {
    title: string
    icon?: IconName
    tone?: 'green' | 'red' | 'purple' | 'amber' | 'blue'
    width?: number
    onclose: () => void
    onsubmit?: () => void
    children: Snippet
    footer?: Snippet
  } = $props()

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onclose()
    }
  }

  function autofocus(el: HTMLElement) {
    const target = el.querySelector<HTMLElement>('[autofocus], input:not([type=checkbox]):not([disabled]), textarea, .btn-primary, .btn-danger')
    queueMicrotask(() => target?.focus())
  }
</script>

<div class="overlay" role="presentation" onpointerdown={e => e.target === e.currentTarget && onclose()} onkeydown={onKey}>
  <form
    class="dialog" style="max-width:{width}px" use:autofocus
    onsubmit={e => { e.preventDefault(); onsubmit?.() }}
  >
    <header>
      {#if icon}<span class="ico {tone}"><Icon name={icon} size={17} /></span>{/if}
      <h2>{title}</h2>
      <button type="button" class="icon-btn sm" onclick={onclose} aria-label="Close"><Icon name="x" size={14} /></button>
    </header>
    <div class="content">{@render children()}</div>
    {#if footer}<footer>{@render footer()}</footer>{/if}
  </form>
</div>

<style>
  /* The SSH Console modal: glass card over a blurred backdrop. */
  .overlay {
    position: fixed; inset: 0; z-index: 680; display: flex; align-items: flex-start; justify-content: center; padding: 12vh 16px 16px;
    background: rgba(3, 7, 18, 0.55); backdrop-filter: blur(6px); animation: fadeIn 140ms ease-out;
  }
  .dialog {
    width: 100%; max-height: 80vh; display: flex; flex-direction: column; border-radius: 20px;
    background: rgba(17, 24, 39, 0.95); backdrop-filter: blur(20px); border: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow: 0 30px 80px rgba(0, 0, 0, 0.55); animation: popIn 180ms var(--ease-pop);
  }
  header { display: flex; align-items: center; gap: 12px; padding: 18px 18px 0 20px; }
  h2 { flex: 1; margin: 0; font-size: 16px; font-weight: 700; color: #fff; }
  .ico { width: 34px; height: 34px; border-radius: 10px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .ico.green { background: var(--green-soft); color: var(--green); }
  .ico.red { background: var(--red-soft); color: var(--red); }
  .ico.purple { background: var(--purple-soft); color: var(--purple); }
  .ico.amber { background: var(--amber-soft); color: var(--amber); }
  .ico.blue { background: rgba(96, 165, 250, 0.16); color: var(--blue); }
  .content { padding: 14px 20px 4px; overflow-y: auto; color: var(--text-muted); font-size: 13px; }
  footer { display: flex; justify-content: flex-end; gap: 8px; padding: 16px 20px 18px; }
</style>
