<script lang="ts">
  import { tick } from 'svelte';
  import { announce } from '../lib/announce.svelte.ts';
  import { parseTags } from '../lib/format.ts';
  import { list } from '../lib/links.svelte.ts';

  let { tags = $bindable(), label = 'Tags' }: { tags: string[]; label?: string } = $props();
  const id = $props.id();
  let draft = $state('');
  let error = $state('');
  let input: HTMLInputElement;
  const choices = $derived(list.tags.map((t) => t.tag).filter((t) => !tags.includes(t)).slice(0, 100));

  /** Turns whatever is typed into tags. Returns false if some of it is not usable. */
  export function flush(): boolean {
    const { tags: added, bad } = parseTags(draft);
    const next = [...new Set([...tags, ...added])];
    draft = bad.join(', ');
    error = '';
    if (bad.length) error = 'Tags are up to 32 letters, digits, spaces, hyphens or underscores, and start with a letter or digit.';
    else if (next.length > 20) error = 'A link can have up to 20 tags.';
    const kept = next.slice(0, 20);
    if (kept.length !== tags.length) {
      announce(`Added ${kept.filter((t) => !tags.includes(t)).join(', ')}.`);
      tags = kept;
    }
    return !error;
  }
  async function remove(tag: string): Promise<void> {
    tags = tags.filter((t) => t !== tag);
    error = '';
    announce(`Removed ${tag}.`);
    await tick();
    input.focus();
  }
  function onkeydown(e: KeyboardEvent): void {
    if ((e.key === 'Enter' || e.key === ',') && draft.trim()) {
      e.preventDefault();
      flush();
    } else if (e.key === 'Backspace' && !draft && tags.length) {
      void remove(tags[tags.length - 1] ?? '');
    }
  }
</script>

<div class="field">
  <label for="{id}-tag">{label}</label>
  <div class="box">
    {#each tags as t (t)}
      <span class="tag mono">{t}<button type="button" aria-label="Remove tag {t}" onclick={() => remove(t)}><span aria-hidden="true">×</span></button></span>
    {/each}
    <input
      id="{id}-tag" class="input" bind:this={input} bind:value={draft} {onkeydown} list="{id}-list" autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="done"
      aria-invalid={error ? 'true' : undefined} aria-describedby="{id}-hint" onblur={() => draft.trim() && flush()}
    >
  </div>
  <datalist id="{id}-list">{#each choices as t (t)}<option value={t}></option>{/each}</datalist>
  {#if error}<p class="error" id="{id}-hint" role="alert">{error}</p>
  {:else}<p class="hint" id="{id}-hint">Press Enter or a comma to add each tag.</p>{/if}
</div>

<style>
  .box { display: flex; flex-wrap: wrap; gap: 8px; }
  .box .input { flex: 1 1 160px; width: auto; }
  .tag { display: inline-flex; align-items: center; min-height: 44px; padding-left: 12px; border: 1px solid var(--line); border-radius: 4px; background: var(--panel); font-size: 14px; overflow-wrap: anywhere; }
  .tag button { width: 44px; height: 44px; flex: none; border: 0; border-radius: 4px; background: transparent; color: var(--mute); font-size: 18px; }
  .tag button:hover { color: var(--ink); }
</style>
