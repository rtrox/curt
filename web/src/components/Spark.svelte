<script lang="ts">
  import type { Day } from '../lib/format.ts';

  let { days }: { days: Day[] } = $props();
  const max = $derived(Math.max(1, ...days.map((d) => d.clicks)));
</script>

<svg viewBox="0 0 90 24" width="90" height="24" aria-hidden="true">
  {#each days as d, i (d.day)}
    {@const h = d.clicks === 0 ? 1 : Math.max(3, (d.clicks / max) * 24)}
    <rect x={i * (90 / days.length)} y={24 - h} width={(90 / days.length) * 0.66} height={h} class:none={d.clicks === 0} />
  {/each}
</svg>

<style>
  svg { display: block; }
  rect { fill: var(--mute); }
  .none { fill: var(--edge); }
</style>
