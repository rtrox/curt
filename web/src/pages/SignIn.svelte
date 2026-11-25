<script lang="ts">
  import { beginSignIn, SignInError, type SignInProblem } from '../lib/auth.ts';
  import { router } from '../lib/router.svelte.ts';
  import { session } from '../lib/session.svelte.ts';

  let busy = $state(false);
  const server = $derived(session.config?.oidc.mode === 'server');
  const problem = $derived(session.problem);

  const messages: Record<SignInProblem | 'ended', { title: string; text: string }> = {
    ended: { title: 'Your session has ended', text: 'Sign in again to continue.' },
    not_allowed: { title: 'This account does not have access', text: 'You signed in, but your account is not in the group that may use this site. Ask an administrator to add you, then sign in again.' },
    groups_missing: { title: 'Your groups were not sent', text: 'The sign-in provider did not include your groups, so access could not be checked. An administrator needs to allow the groups scope for this application in the provider.' },
    unreachable: { title: 'The sign-in provider could not be reached', text: 'It may only be available on the home network. Connect to the home network or VPN, then try again. If your browser asks to allow access to devices on your local network, allow it.' },
    cancelled: { title: 'Sign-in was cancelled', text: 'The sign-in provider refused access, or you stopped before finishing.' },
    bad_state: { title: 'This sign-in could not be matched', text: 'It was started in another tab or has already been used. Start again here.' },
    expired: { title: 'This sign-in attempt has expired', text: 'It took too long or was already used. Start again.' },
    rejected: { title: 'Sign-in did not work', text: 'The server did not accept the answer from the sign-in provider.' },
    network: { title: 'The server could not be reached', text: 'Check your connection and try again.' },
    storage: { title: 'Sign-in needs session storage', text: 'Your browser is blocking storage for this site. Allow it and try again.' },
    provider: { title: 'The sign-in provider reported a problem', text: 'Try again. If it keeps happening, ask an administrator.' },
  };

  async function go(skipCheck = false): Promise<void> {
    if (!session.config || busy) return;
    busy = true;
    session.problem = null;
    session.problemDetail = '';
    try {
      await beginSignIn(session.config, router.route.page === 'callback' ? '/' : location.pathname, skipCheck);
      // The page is being replaced. Re-enable the button in case the person comes straight back.
      setTimeout(() => { busy = false; }, 8000);
    } catch (e) {
      session.problem = e instanceof SignInError ? e.problem : 'rejected';
      busy = false;
    }
  }
</script>

<div class="signin">
  <div role="alert">
    {#if problem}
      <div class="problem stack">
        <h2>{messages[problem].title}</h2>
        <p>{messages[problem].text}</p>
        {#if problem === 'rejected' && session.problemDetail}<p class="mute small">{session.problemDetail}</p>{/if}
      </div>
    {/if}
  </div>
  <div class="stack">
    <h1 tabindex="-1">Sign in</h1>
    <p class="mute">Sign in to create and manage short links. Links that already exist work without signing in.</p>
    <div class="row">
      <button class="btn primary" type="button" aria-disabled={busy} onclick={() => go()}>{busy ? 'Opening…' : problem && problem !== 'ended' ? 'Try again' : 'Sign in'}</button>
      {#if problem === 'unreachable' && !server}
        <button class="btn" type="button" disabled={busy} onclick={() => go(true)}>Continue anyway</button>
      {/if}
    </div>
    {#if server}<p class="hint">If the next page does not load, check that you can reach the sign-in provider.</p>{/if}
  </div>
</div>

<style>
  .signin { display: flex; flex-direction: column; gap: 32px; max-width: 560px; padding-top: 4vh; }
  .problem { padding: 4px 0 4px 16px; border-left: 4px solid var(--danger); }
  .primary { min-height: 60px; min-width: 144px; padding: 0 32px; font-size: 18px; }
  h1 { font-size: 28px; font-weight: 700; letter-spacing: -0.03em; }
</style>
