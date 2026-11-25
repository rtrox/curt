<script lang="ts">
  import { onMount } from 'svelte';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';
  import { announce } from '../lib/announce.svelte.ts';
  import { api, messageOf, type Person } from '../lib/api.ts';
  import { plural } from '../lib/format.ts';
  import { session } from '../lib/session.svelte.ts';

  let people = $state.raw<Person[] | null>(null);
  let loadError = $state('');
  let target = $state.raw<Person | null>(null);
  let done = $state('');

  const nameOf = (p: Person) => p.name ?? p.email ?? 'Unnamed account';

  async function load(): Promise<void> {
    loadError = '';
    try { people = (await api.users()).users; } catch (e) { loadError = messageOf(e); }
  }
  onMount(() => { void load(); });

  async function cutOff(): Promise<void> {
    const person = target;
    if (!person) return;
    const r = await api.cutOff(person.id);
    people = (people ?? []).map((p) => (p.id === person.id ? { ...p, isAdmin: false, activeSessions: 0, activeTokens: 0 } : p));
    done = `${nameOf(person)} was cut off: ${plural(r.sessionsEnded, 'session')} ended, ${plural(r.tokensRevoked, 'API token')} revoked.`;
    announce(done);
  }
</script>

<div class="stack">
  <h1 tabindex="-1">People</h1>
  <p class="mute">Everyone who has signed in, with the sessions and API tokens that work now.</p>
</div>

{#if done}<p class="done">{done}</p>{/if}

<section aria-labelledby="people-title">
  <h2 id="people-title" class="sr-only">List of people</h2>
  {#if loadError}
    <div class="stack" role="alert">
      <p class="error">{loadError}</p>
      <div><button class="btn" type="button" onclick={load}>Try again</button></div>
    </div>
  {:else if people === null}
    <p class="mute" role="status">Loading people…</p>
  {:else if people.length === 0}
    <p class="note mute">Nobody has signed in yet.</p>
  {:else}
    <ul>
      {#each people as p (p.id)}
        <li>
          <div class="what">
            <p class="label">{nameOf(p)}{#if p.id === session.me?.id}<span class="mute">&nbsp;(you)</span>{/if}</p>
            {#if p.name && p.email}<p class="hint">{p.email}</p>{/if}
            <p class="hint">{p.isAdmin ? 'Admin' : 'Member'} · {plural(p.activeSessions, 'active session')} · {plural(p.activeTokens, 'active API token')}</p>
          </div>
          {#if p.id !== session.me?.id}
            <button class="btn danger" type="button" aria-label="Cut off {nameOf(p)}" onclick={() => { done = ''; target = p; }}>Cut off</button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

{#if target}
  <ConfirmDialog title="Cut off {nameOf(target)}?" action="Cut off" onconfirm={cutOff} onclose={() => { target = null; }}>
    <ul class="effects">
      <li>They are signed out everywhere.</li>
      <li>Their API tokens stop working.</li>
      {#if target.isAdmin}<li>They are no longer an admin here until they next sign in.</li>{/if}
      <li>Their links keep working.</li>
    </ul>
    <p>This does not stop them from signing in again. Do that in the sign-in provider.</p>
  </ConfirmDialog>
{/if}

<style>
  section li { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; padding: 12px 0; border-top: 1px solid var(--line); }
  section li:last-child { border-bottom: 1px solid var(--line); }
  .what { flex: 1 1 220px; min-width: 0; overflow-wrap: anywhere; }
  .note { padding: 24px 0; border-top: 1px solid var(--line); }
  .done { padding: 8px 0 8px 16px; border-left: 4px solid var(--accent); }
  .effects { display: flex; flex-direction: column; gap: 4px; padding-left: 20px; list-style: disc; }
</style>
