<script lang="ts">
  let { value, min, max, onchange, oncommit, invert = false }: {
    value: number
    min: number
    max: number
    /** Live updates while dragging. */
    onchange: (v: number) => void
    /** Once, on release: the place to persist. */
    oncommit?: (v: number) => void
    invert?: boolean
  } = $props()
  let dragging = $state(false)

  function start(e: PointerEvent) {
    const startX = e.clientX
    const startValue = value
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    dragging = true
    let latest = startValue
    const move = (ev: PointerEvent) => {
      const delta = (ev.clientX - startX) * (invert ? -1 : 1)
      latest = Math.round(Math.min(max, Math.max(min, startValue + delta)))
      onchange(latest)
    }
    const up = () => {
      dragging = false
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      if (latest !== startValue) oncommit?.(latest)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }
</script>

<div class="resizer" class:dragging role="separator" aria-orientation="vertical" onpointerdown={start}></div>
