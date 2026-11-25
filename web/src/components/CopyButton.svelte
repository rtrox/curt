<script lang="ts">
  import { announce } from '../lib/announce.svelte.ts';

  let { text, label, what = 'link', compact = false }: { text: string; label?: string; what?: string; compact?: boolean } = $props();
  let state = $state<'idle' | 'copied' | 'failed'>('idle');
  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => () => clearTimeout(timer));

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      state = 'copied';
      announce(`Copied ${what}.`);
    } catch {
      state = 'failed';
      announce(`The ${what} could not be copied. Select it and copy it yourself.`);
    }
    clearTimeout(timer);
    timer = setTimeout(() => { state = 'idle'; }, 2000);
  }
</script>

<button class="btn" class:compact type="button" aria-label={label} onclick={copy}>
  <span class="sizer" aria-hidden="true">Copied</span>
  <span class="face">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Failed' : 'Copy'}</span>
</button>

<style>
  /* Both words share one cell, so the button does not change width. */
  .btn { display: inline-grid; }
  .sizer, .face { grid-area: 1 / 1; text-align: center; }
  .sizer { visibility: hidden; }
  .compact { padding: 0 10px; font-size: 14px; border-color: transparent; color: var(--mute); }
  .compact:hover { color: var(--ink); }
</style>
