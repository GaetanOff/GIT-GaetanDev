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

  /** The keyboard moves it too, as a window splitter: the arrows by 16 px (64 with Shift), Home and End to the ends. */
  function key(e: KeyboardEvent) {
    const step = e.shiftKey ? 64 : 16
    const sign = invert ? -1 : 1
    const next = e.key === 'ArrowLeft' ? value - step * sign : e.key === 'ArrowRight' ? value + step * sign : e.key === 'Home' ? min : e.key === 'End' ? max : null
    if (next === null) return
    e.preventDefault()
    const v = Math.round(Math.min(max, Math.max(min, next)))
    onchange(v)
    oncommit?.(v)
  }
</script>

<div
  class="resizer" class:dragging role="separator" aria-orientation="vertical" tabindex="0"
  aria-valuenow={value} aria-valuemin={min} aria-valuemax={max} onpointerdown={start} onkeydown={key}
></div>
