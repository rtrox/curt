<script lang="ts">
  import type { ApiToken } from '@curt/shared/schemas';
  import { onMount, tick } from 'svelte';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';
  import CopyButton from '../components/CopyButton.svelte';
  import { announce } from '../lib/announce.svelte.ts';
  import { api, messageOf, RequestError } from '../lib/api.ts';
  import { dateLabel, dayLabel } from '../lib/format.ts';
  import { session } from '../lib/session.svelte.ts';

  let tokens = $state.raw<ApiToken[] | null>(null);
  let loadError = $state('');
  let name = $state('');
  let scope = $state<ApiToken['scope']>('links');
  let life = $state('90');
  let nameError = $state('');
  let error = $state('');
  let busy = $state(false);
  let created = $state.raw<{ name: string; token: string } | null>(null);
  let revoking = $state.raw<ApiToken | null>(null);
  let nameBox = $state<HTMLInputElement>();
  let createdBox = $state<HTMLElement>();

  const scopes = { links: 'Links', 'metrics:read': 'Metrics, read only' };

  async function load(): Promise<void> {
    loadError = '';
    try { tokens = (await api.tokens()).tokens; } catch (e) { loadError = messageOf(e); }
  }
  onMount(() => { void load(); });

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    error = nameError = '';
    if (!name.trim()) {
      nameError = 'Give the token a name, such as the computer it is for.';
      nameBox?.focus();
      return;
    }
    busy = true;
    try {
      const expiresAt = life ? Math.floor(Date.now() / 1000) + Number(life) * 86_400 : null;
      const { token, ...rest } = await api.createToken({ name: name.trim(), scope, expiresAt });
      created = { name: rest.name, token };
      tokens = [rest, ...(tokens ?? [])];
      name = '';
      announce('Token created. Copy it now.');
      await tick();
      createdBox?.focus();
    } catch (err) {
      error = messageOf(err);
    }
    busy = false;
  }
  async function revoke(): Promise<void> {
    const target = revoking;
    if (!target) return;
    try {
      await api.revokeToken(target.id);
    } catch (e) {
      if (!(e instanceof RequestError && e.status === 404)) throw e;
    }
    tokens = (tokens ?? []).filter((t) => t.id !== target.id);
    announce(`Revoked ${target.name}.`);
  }
  const expired = (t: ApiToken) => t.expiresAt !== null && t.expiresAt * 1000 <= Date.now();
</script>

<div class="stack">
  <h1 tabindex="-1">API tokens</h1>
  <p class="mute">Tokens let the command-line tool and scripts use your account.</p>
</div>

<form class="new" novalidate onsubmit={submit}>
  <div class="field name">
    <label for="token-name">Name</label>
    <input id="token-name" class="input" type="text" maxlength="64" autocomplete="off" bind:this={nameBox} bind:value={name}
      aria-invalid={nameError ? 'true' : undefined} aria-describedby="token-name-error">
  </div>
  {#if session.isAdmin}
    <div class="field">
      <label for="token-scope">Allows</label>
      <select id="token-scope" class="select" bind:value={scope}>
        <option value="links">{scopes.links}</option>
        <option value="metrics:read">{scopes['metrics:read']}</option>
      </select>
    </div>
  {/if}
  <div class="field">
    <label for="token-life">Expires</label>
    <select id="token-life" class="select" bind:value={life}>
      <option value="">Never</option>
      <option value="30">In 30 days</option>
      <option value="90">In 90 days</option>
      <option value="365">In a year</option>
    </select>
  </div>
  <button class="btn primary" type="submit" aria-disabled={busy}>Create token</button>
  <p class="error wide" id="token-name-error" role="alert">{nameError || error}</p>
</form>

{#if created}
  <div class="created stack" role="group" aria-label="New token" tabindex="-1" bind:this={createdBox}>
    <p>Copy the token for <strong>{created.name}</strong> now. It is not shown again.</p>
    <code class="mono">{created.token}</code>
    <div class="row">
      <CopyButton text={created.token} label="Copy token" what="token" />
      <button class="btn" type="button" onclick={() => { created = null; nameBox?.focus(); }}>Done</button>
    </div>
  </div>
{/if}

<section aria-labelledby="tokens-title">
  <h2 id="tokens-title" class="sr-only">Your tokens</h2>
  {#if loadError}
    <div class="stack" role="alert">
      <p class="error">{loadError}</p>
      <div><button class="btn" type="button" onclick={load}>Try again</button></div>
    </div>
  {:else if tokens === null}
    <p class="mute" role="status">Loading tokens…</p>
  {:else if tokens.length === 0}
    <p class="note mute">No tokens yet.</p>
  {:else}
    <ul>
      {#each tokens as t (t.id)}
        <li>
          <div class="what">
            <p class="label">{t.name}</p>
            <p class="hint">
              {scopes[t.scope]} · {t.expiresAt === null ? 'never expires' : expired(t) ? `expired ${dateLabel(t.expiresAt)}` : `expires ${dateLabel(t.expiresAt)}`} · {t.lastUsedDay ? `last used ${dayLabel(t.lastUsedDay)}` : 'never used'}
            </p>
          </div>
          <button class="btn" type="button" aria-label="Revoke {t.name}" onclick={() => { revoking = t; }}>Revoke</button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

{#if revoking}
  <ConfirmDialog title="Revoke this token?" action="Revoke" onconfirm={revoke} onclose={() => { revoking = null; }}>
    <p>Anything using <strong>{revoking.name}</strong> stops working at once. This cannot be undone.</p>
  </ConfirmDialog>
{/if}

<style>
  .new { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px; }
  .new .field { flex: 0 1 180px; }
  .new .name { flex: 1 1 240px; }
  .wide { flex: 1 1 100%; }
  .wide:empty { display: none; }
  .created { padding: 8px 0 8px 16px; border-left: 4px solid var(--accent); }
  .created:focus { outline: none; }
  code { padding: 12px 14px; border: 1px solid var(--line); border-radius: 4px; background: var(--panel); font-size: 15px; overflow-wrap: anywhere; user-select: all; }
  li { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; padding: 12px 0; border-top: 1px solid var(--line); }
  li:last-child { border-bottom: 1px solid var(--line); }
  .what { flex: 1 1 220px; min-width: 0; overflow-wrap: anywhere; }
  .note { padding: 24px 0; border-top: 1px solid var(--line); }
  @media (max-width: 640px) {
    .new .field, .new .name, .new .btn { flex: 1 1 100%; }
  }
</style>
