<script lang="ts">
  import Icon from './Icon.svelte'
  import { dismissToast, pauseToast, resumeToast, toasts } from '@/lib/ui.svelte'
</script>

<div class="toasts" aria-live="polite">
  {#each toasts as t (t.id)}
    <div class="toast {t.kind}" class:leaving={t.leaving} role={t.kind === 'error' ? 'alert' : 'status'}
      onpointerenter={() => pauseToast(t.id)} onpointerleave={() => resumeToast(t.id)}
      onfocusin={() => pauseToast(t.id)} onfocusout={() => resumeToast(t.id)}>
      <span class="ico"><Icon name={t.kind === 'success' ? 'check' : t.kind === 'error' ? 'alert' : 'info'} size={13} /></span>
      <div class="body">
        <div class="msg">{t.message}</div>
        {#if t.action}
          <button class="act" onclick={() => { t.action!.run(); dismissToast(t.id) }}>{t.action.label}</button>
        {/if}
      </div>
      <button class="close" onclick={() => dismissToast(t.id)} aria-label="Dismiss"><Icon name="x" size={13} /></button>
    </div>
  {/each}
</div>

<style>
  /* The SSH Console toasts. */
  .toasts { position: fixed; right: 14px; bottom: calc(var(--statusbar-h) + 12px); z-index: 600; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; pointer-events: none; }
  .toast {
    pointer-events: auto; display: flex; align-items: flex-start; gap: 10px; min-width: 260px; max-width: 420px; padding: 11px 12px;
    border-radius: 14px; background: rgba(15, 17, 23, 0.94); backdrop-filter: blur(16px); border: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45); color: #e5e7eb; font-size: 12.5px; line-height: 1.45;
    animation: toastIn 260ms var(--ease-pop);
  }
  .toast.leaving { animation: toastOut 200ms ease-in forwards; }
  .ico { width: 20px; height: 20px; border-radius: 6px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px; }
  .success .ico { background: rgba(74, 222, 128, 0.2); color: var(--green); }
  .error .ico { background: rgba(239, 68, 68, 0.2); color: var(--red); }
  .info .ico { background: rgba(96, 165, 250, 0.2); color: #93c5fd; }
  .body { flex: 1; min-width: 0; }
  .msg { white-space: pre-line; word-break: break-word; user-select: text; }
  .act { margin-top: 6px; padding: 0; border: none; background: none; color: var(--green); font-size: 11px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase; }
  .close { border: none; background: none; color: var(--text-faint); padding: 2px; border-radius: 6px; line-height: 0; }
  .close:hover { color: #fff; background: var(--surface-3); }
  @keyframes toastIn { from { opacity: 0; transform: translateY(12px) scale(0.98); } to { opacity: 1; transform: none; } }
  @keyframes toastOut { to { opacity: 0; transform: translateY(8px) scale(0.98); } }
</style>
