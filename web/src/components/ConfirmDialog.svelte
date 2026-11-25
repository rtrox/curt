<script lang="ts">
  import type { Snippet } from 'svelte';
  import { messageOf } from '../lib/api.ts';

  let { title, action, onconfirm, onclose, children }: {
    title: string; action: string; onconfirm: () => Promise<void>; onclose: () => void; children: Snippet;
  } = $props();
  const id = $props.id();
  let dialog = $state<HTMLDialogElement>();
  let busy = $state(false);
  let error = $state('');

  $effect(() => { dialog?.showModal(); });

  async function confirm(): Promise<void> {
    busy = true;
    error = '';
    try {
      await onconfirm();
      dialog?.close();
    } catch (e) {
      error = messageOf(e);
    }
    busy = false;
  }
</script>

<dialog bind:this={dialog} aria-labelledby="{id}-title" onclose={onclose}>
  <div class="stack">
    <h2 id="{id}-title">{title}</h2>
    {@render children()}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <div class="row end">
      <button class="btn" type="button" onclick={() => dialog?.close()}>Cancel</button>
      <button class="btn danger solid" type="button" disabled={busy} onclick={confirm}>{action}</button>
    </div>
  </div>
</dialog>

<style>
  .end { justify-content: flex-end; margin-top: 8px; }
</style>
