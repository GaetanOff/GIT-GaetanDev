<script lang="ts">
  import { ICONS, type IconName } from '@/lib/icons'

  let { name, size = 16, stroke = 2, class: cls = '' }: { name: IconName; size?: number; stroke?: number; class?: string } = $props()
</script>

<svg class={cls} width={size} height={size} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true" style="flex-shrink:0">
  <path stroke-linecap="round" stroke-linejoin="round" stroke-width={name === 'more' ? 3 : stroke} d={ICONS[name]} />
</svg>
