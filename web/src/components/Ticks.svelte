<script lang="ts">
  import { dayLabel, plural, type Day } from '../lib/format.ts';

  let { days, label, summary, sampled = false }: { days: Day[]; label: string; summary: string; sampled?: boolean } = $props();

  const max = $derived(Math.max(0, ...days.map((d) => d.clicks)));
  const peak = $derived(max > 0 ? days.findIndex((d) => d.clicks === max) : -1);
  let active = $state<number | null>(null);
  let last = $state<number | null>(null);
  const shown = $derived(active === null ? null : days[active]);

  const text = (d: Day) => `${dayLabel(d.day)}: ${sampled ? 'about ' : ''}${plural(d.clicks, 'click')}`;

  function pick(i: number | null): void {
    active = i === null ? null : Math.max(0, Math.min(days.length - 1, i));
    if (active !== null) last = active;
  }
  function fromPointer(e: PointerEvent): void {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    pick(Math.floor(((e.clientX - box.left) / box.width) * days.length));
  }
  function onkeydown(e: KeyboardEvent): void {
    const at = active ?? last ?? days.length - 1;
    const to = { ArrowLeft: at - 1, ArrowDown: at - 1, ArrowRight: at + 1, ArrowUp: at + 1, Home: 0, End: days.length - 1, PageUp: at + 7, PageDown: at - 7 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    pick(to);
  }
  const at = $derived(active ?? last ?? (peak === -1 ? days.length - 1 : peak));
</script>

<figure>
  <figcaption class="mono">
    <span>{label}</span>
    <span class="now">{shown ? text(shown) : summary}</span>
  </figcaption>
  <div
    class="ticks" role="slider" tabindex="0" aria-label="{label}. Use the arrow keys to read each day."
    aria-valuemin={0} aria-valuemax={days.length - 1} aria-valuenow={at} aria-valuetext={days[at] ? text(days[at]) : ''}
    onpointermove={fromPointer} onpointerdown={fromPointer} onpointerleave={() => pick(null)}
    onfocus={() => pick(at)} onblur={() => pick(null)} {onkeydown}
    style:--n={days.length}
  >
    {#each days as d, i (d.day)}
      <span class:peak={i === peak} class:active={i === active} class:none={d.clicks === 0}
        style:height={d.clicks === 0 ? '3px' : `calc(6px + ${((d.clicks / max) * 100).toFixed(2)}% - ${((d.clicks / max) * 6).toFixed(2)}px)`}></span>
    {/each}
  </div>
  <div class="axis mono" aria-hidden="true">
    <span>{days[0] ? dayLabel(days[0].day) : ''}</span>
    <span>Today</span>
  </div>
</figure>

<style>
  figure { display: flex; flex-direction: column; gap: 10px; }
  figcaption, .axis { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 16px; font-size: 13px; color: var(--mute); }
  .now { color: var(--ink); }
  .ticks { display: flex; align-items: flex-end; gap: clamp(1px, calc(18% / var(--n)), 6px); height: 72px; border-bottom: 1px solid var(--line); cursor: crosshair; touch-action: pan-y; }
  .ticks span { flex: 1 1 0; min-width: 0; background: var(--mute); }
  .ticks .none { background: var(--edge); }
  .ticks .peak { background: var(--accent); }
  .ticks .active { background: var(--ink); }
</style>
