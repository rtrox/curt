<script lang="ts">
  import type { Snippet } from 'svelte';
  import { announce } from '../lib/announce.svelte.ts';
  import { messageOf } from '../lib/api.ts';
  import { splitName } from '../lib/format.ts';
  import { nav as link, router } from '../lib/router.svelte.ts';
  import { session } from '../lib/session.svelte.ts';
  import { theme, type Theme } from '../lib/theme.svelte.ts';

  let { nav = false, lead, children }: { nav?: boolean; lead?: Snippet; children: Snippet } = $props();

  const name = $derived(splitName(session.siteName));
  const page = $derived(router.route.page);
  let leaving = $state(false);
  let error = $state('');

  async function signOut(): Promise<void> {
    leaving = true;
    error = '';
    try {
      await session.signOut();
      router.go('/', true);
      announce('Signed out.');
    } catch (e) {
      error = messageOf(e);
    }
    leaving = false;
  }
</script>

<!-- The paste box comes before the navigation in the document so it is the first control reached by keyboard. -->
<div class="page">
  <header class="mark">
    {#if page === 'home' || !nav}
      <span class="name">{name[0]}<span>{name[1]}</span></span>
    {:else}
      <a class="name" href="/" use:link>{name[0]}<span>{name[1]}</span></a>
    {/if}
  </header>

  {#if lead}<section class="lead" aria-label="Shorten a link">{@render lead()}</section>{/if}

  <nav class="tools" aria-label="Main">
    {#if nav}
      <span class="links">
        <a href="/" use:link aria-current={page === 'home' ? 'page' : undefined}>Links</a>
        <a href="/tokens" use:link aria-current={page === 'tokens' ? 'page' : undefined}>API tokens</a>
        {#if session.isAdmin}<a href="/people" use:link aria-current={page === 'people' ? 'page' : undefined}>People</a>{/if}
      </span>
    {/if}
    <label class="theme">
      <span class="sr-only">Theme</span>
      <select class="select" value={theme.choice} onchange={(e) => { theme.choice = e.currentTarget.value as Theme; }}>
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
    {#if nav}
      <button class="btn out" type="button" disabled={leaving} onclick={signOut}>Sign out</button>
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </nav>

  <main class="body">{@render children()}</main>

  {#if nav && session.me}
    <footer class="mute small">Signed in as {session.me.name ?? session.me.email ?? 'an unnamed account'}{session.isAdmin ? ', admin' : ''}</footer>
  {/if}
</div>

<style>
  .page {
    max-width: calc(1040px + 2 * var(--gutter)); min-height: 100dvh; margin: 0 auto; padding: 32px var(--gutter) 32px;
    display: grid; grid-template-columns: 1fr auto; grid-template-rows: auto auto 1fr auto; column-gap: 16px;
    grid-template-areas: 'mark tools' 'lead lead' 'body body' 'foot foot';
  }
  .mark { grid-area: mark; align-self: center; min-width: 0; }
  .lead { grid-area: lead; margin-top: 40px; min-width: 0; }
  .body { grid-area: body; margin-top: 40px; min-width: 0; display: flex; flex-direction: column; gap: 40px; }
  .tools { grid-area: tools; display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; }
  footer { grid-area: foot; margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--line); }
  .name { display: inline-flex; align-items: center; min-height: 44px; font-size: 28px; font-weight: 700; letter-spacing: -0.03em; line-height: 1.1; text-decoration: none; overflow-wrap: anywhere; }
  .name span { color: var(--accent); }
  .links { display: flex; gap: 4px; }
  .links a { display: inline-flex; align-items: center; min-height: 44px; padding: 0 12px; font-size: 15px; color: var(--mute); text-decoration: none; }
  .links a:hover { color: var(--ink); }
  .links a[aria-current] { color: var(--ink); box-shadow: inset 0 -2px var(--accent); }
  .theme .select { width: auto; background-color: transparent; font-size: 15px; }
  .out { font-size: 15px; }
  @media (max-width: 720px) {
    .page {
      padding-top: 16px; grid-template-columns: 1fr auto; grid-template-rows: auto auto auto auto 1fr auto;
      grid-template-areas: 'mark theme' 'links out' 'fail fail' 'lead lead' 'body body' 'foot foot';
    }
    .lead, .body { margin-top: 24px; }
    .body { gap: 32px; }
    /* The theme control sits beside the name, so the admin links fit on one line. */
    .tools { display: contents; }
    .links { grid-area: links; flex-wrap: wrap; gap: 0 20px; }
    .links a { padding: 0; min-width: 44px; justify-content: center; }
    .theme { grid-area: theme; }
    .theme .select { padding-left: 10px; border-color: transparent; }
    .out { grid-area: out; justify-self: end; padding: 0; min-width: 44px; border-color: transparent; color: var(--mute); }
    .tools .error { grid-area: fail; }
  }
</style>
