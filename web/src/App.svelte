<script lang="ts">
  import { tick } from 'svelte';
  import Shell from './components/Shell.svelte';
  import { announcer } from './lib/announce.svelte.ts';
  import { finishSignIn, SignInError } from './lib/auth.ts';
  import { list } from './lib/links.svelte.ts';
  import { router } from './lib/router.svelte.ts';
  import { session } from './lib/session.svelte.ts';
  import Home from './pages/Home.svelte';
  import LinkDetail from './pages/LinkDetail.svelte';
  import PasteBox from './components/PasteBox.svelte';
  import People from './pages/People.svelte';
  import SignIn from './pages/SignIn.svelte';
  import Tokens from './pages/Tokens.svelte';

  let finishing = $state(false);

  async function start(): Promise<void> {
    if (!(await session.loadConfig()) || !session.config) return;
    if (router.route.page === 'callback') {
      finishing = true;
      try {
        const next = await finishSignIn(session.config);
        router.go(next, true);
      } catch (e) {
        session.problem = e instanceof SignInError ? e.problem : 'rejected';
        session.problemDetail = e instanceof SignInError && e.message !== e.problem ? e.message : '';
        router.go('/', true);
        session.status = 'signed-out';
        return;
      } finally {
        finishing = false;
      }
    }
    await session.loadUser();
  }
  void start();

  // Nothing from one account may stay on screen for the next.
  $effect(() => { if (session.status === 'signed-out') list.reset(); });

  const titles = { home: '', tokens: 'API tokens', people: 'People', callback: 'Signing in', missing: 'Page not found', link: 'Link' };
  $effect(() => {
    const page = router.route.page === 'people' && !session.isAdmin ? 'missing' : router.route.page;
    const t = session.status === 'ready' ? titles[page] : '';
    document.title = t ? `${t} · ${session.siteName}` : session.siteName;
  });

  $effect(() => {
    const { route, moved } = router;
    if (!moved || route.page === 'home' || session.status !== 'ready') return;
    void tick().then(() => document.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true }));
  });
</script>

<div class="sr-only" aria-live="polite" aria-atomic="true">{announcer.text}</div>

{#if session.status === 'failed'}
  <Shell>
    <div class="stack" role="alert">
      <h1 tabindex="-1">The page could not load</h1>
      <p class="mute">{session.error}</p>
      <div><button class="btn" type="button" onclick={() => void start()}>Try again</button></div>
    </div>
  </Shell>
{:else if session.status === 'loading'}
  <Shell>
    <p class="mute" role="status">{finishing ? 'Signing in…' : 'Loading…'}</p>
  </Shell>
{:else if session.status === 'signed-out'}
  <Shell><SignIn /></Shell>
{:else if router.route.page === 'home'}
  <Shell nav>
    {#snippet lead()}<PasteBox />{/snippet}
    <Home />
  </Shell>
{:else}
  <Shell nav>
    {#if router.route.page === 'tokens'}
      <Tokens />
    {:else if router.route.page === 'people' && session.isAdmin}
      <People />
    {:else if router.route.page === 'link'}
      {#key router.route.id}<LinkDetail id={router.route.id} />{/key}
    {:else}
      <div class="stack">
        <h1 tabindex="-1">Page not found</h1>
        <p class="mute">There is nothing at this address.</p>
      </div>
    {/if}
  </Shell>
{/if}
