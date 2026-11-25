<script lang="ts">
  import type { CreateLink, Link } from '@curt/shared/schemas';
  import { isReservedSlug, isValidCustomSlug, normalizeSlug } from '@curt/shared';
  import { tick } from 'svelte';
  import { announce } from '../lib/announce.svelte.ts';
  import { api, isAbort, messageOf, RequestError } from '../lib/api.ts';
  import { destinationProblem, fromLocalInput, toLocalInput, withScheme } from '../lib/format.ts';
  import { list } from '../lib/links.svelte.ts';
  import { nav } from '../lib/router.svelte.ts';
  import { session } from '../lib/session.svelte.ts';
  import { load, save } from '../lib/storage.ts';
  import CopyButton from './CopyButton.svelte';
  import TagInput from './TagInput.svelte';

  let box: HTMLInputElement;
  let slugBox = $state<HTMLInputElement>();
  let expiryBox = $state<HTMLInputElement>();
  let tagInput = $state<TagInput>();

  const remembered = load('domain');
  let domain = $state(remembered && session.hosts.includes(remembered) ? remembered : session.hosts[0] ?? '');
  let destination = $state('');
  let slug = $state('');
  let tags = $state<string[]>([]);
  let expiry = $state('');
  let open = $state({ slug: false, tags: false, expiry: false });
  let busy = $state(false);
  let error = $state('');
  let destinationBad = $state(false);
  let slugError = $state('');
  let expiryError = $state('');
  let result = $state.raw<Link | null>(null);
  let check = $state<{ state: 'idle' | 'checking' | 'free' | 'bad' | 'unknown'; text: string }>({ state: 'idle', text: '' });

  const SLUG_RULE = 'Use letters, digits, hyphens and underscores, starting and ending with a letter or digit.';
  const reasons = { taken: 'Already in use on this domain.', invalid: SLUG_RULE, reserved: 'This slug is reserved.' };

  $effect(() => {
    // A touch keyboard covering the page on every visit would be unwelcome.
    if (matchMedia('(pointer: fine)').matches) box.focus({ preventScroll: true });
  });

  $effect(() => {
    const [host, wanted] = [domain, normalizeSlug(slug)];
    slugError = '';
    if (!open.slug || !wanted) { check = { state: 'idle', text: '' }; return; }
    if (isReservedSlug(wanted)) { check = { state: 'bad', text: reasons.reserved }; return; }
    if (!isValidCustomSlug(wanted)) { check = { state: 'bad', text: reasons.invalid }; return; }
    check = { state: 'checking', text: 'Checking…' };
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const r = await api.availability(host, wanted, abort.signal);
        check = r.available ? { state: 'free', text: 'Available.' } : { state: 'bad', text: reasons[r.reason ?? 'taken'] };
      } catch (e) {
        if (isAbort(e) || abort.signal.aborted) return;
        check = { state: 'unknown', text: 'Could not check this slug. You can still try it.' };
      }
    }, 300);
    return () => { clearTimeout(timer); abort.abort(); };
  });

  async function toggle(which: 'slug' | 'tags' | 'expiry'): Promise<void> {
    open[which] = !open[which];
    if (!open[which]) {
      // A hidden field must not silently change the link.
      if (which === 'slug') slug = '';
      if (which === 'tags') tags = [];
      if (which === 'expiry') { expiry = ''; expiryError = ''; }
      return;
    }
    await tick();
    document.querySelector<HTMLInputElement>(`#opt-${which} input`)?.focus();
  }

  function fail(text: string, field: HTMLInputElement | undefined = box): void {
    error = text;
    destinationBad = field === box;
    field?.focus();
  }

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    error = '';
    slugError = '';
    expiryError = '';
    destinationBad = false;
    const problem = destinationProblem(destination, [...session.hosts, location.hostname]);
    if (problem) return fail(problem);
    if (open.tags && tagInput && !tagInput.flush()) return;
    if (check.state === 'bad') { slugBox?.focus(); return; }
    const expiresAt = fromLocalInput(expiry);
    if (expiresAt !== null && expiresAt * 1000 <= Date.now()) {
      expiryError = 'The expiry must be in the future.';
      expiryBox?.focus();
      return;
    }

    const body: CreateLink = { destination: withScheme(destination), domain };
    if (slug.trim()) body.slug = normalizeSlug(slug);
    if (tags.length) body.tags = [...tags];
    if (expiresAt !== null) body.expiresAt = expiresAt;
    busy = true;
    try {
      const link = await api.create(body);
      result = link;
      list.added(link);
      save('domain', domain);
      destination = '';
      slug = '';
      tags = [];
      expiry = '';
      open = { slug: false, tags: false, expiry: false };
      announce(`Created ${link.shortUrl}.`);
      await tick();
      box.focus();
    } catch (err) {
      if (err instanceof RequestError && ['slug_taken', 'reserved_slug', 'invalid_slug'].includes(err.code)) {
        slugError = err.message;
        slugBox?.focus();
      } else if (err instanceof RequestError && err.code === 'expiry_in_past') {
        expiryError = err.message;
        expiryBox?.focus();
      } else {
        fail(messageOf(err));
      }
    } finally {
      busy = false;
    }
  }
</script>

<form class="stack" novalidate onsubmit={submit}>
  <h1 tabindex="-1"><label for="destination">Paste a long link</label></h1>
  <div class="main">
    <input
      id="destination" class="mono" type="text" inputmode="url" placeholder="https://" autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="go"
      bind:this={box} bind:value={destination} aria-invalid={destinationBad ? 'true' : undefined} aria-describedby="destination-error"
      oninput={() => { if (error) { error = ''; destinationBad = false; } }}
    >
    <button class="btn primary" type="submit" aria-disabled={busy}>{busy ? 'Working…' : 'Shorten'}</button>
  </div>
  <div id="destination-error" role="alert">{#if error}<p class="error">{error}</p>{/if}</div>

  <div class="row options">
    {#if session.hosts.length > 1}
      <label>
        <span class="sr-only">Domain</span>
        <select class="select mono" bind:value={domain} onchange={() => save('domain', domain)}>
          {#each session.hosts as h (h)}<option value={h}>{h}</option>{/each}
        </select>
      </label>
    {/if}
    <button class="btn chip mono" type="button" aria-expanded={open.slug} aria-controls="opt-slug" onclick={() => toggle('slug')}>custom slug</button>
    <button class="btn chip mono" type="button" aria-expanded={open.tags} aria-controls="opt-tags" onclick={() => toggle('tags')}>tags</button>
    <button class="btn chip mono" type="button" aria-expanded={open.expiry} aria-controls="opt-expiry" onclick={() => toggle('expiry')}>expiry</button>
  </div>

  <div id="opt-slug" hidden={!open.slug}>
    {#if open.slug}
      <div class="field">
        <label for="slug">Custom slug</label>
        <div class="slug mono" class:bad={check.state === 'bad' || slugError}>
          <span class="mute">{domain}/</span>
          <input id="slug" type="text" maxlength="64" autocomplete="off" autocapitalize="none" spellcheck="false"
            bind:this={slugBox} bind:value={slug} aria-invalid={check.state === 'bad' || slugError ? 'true' : undefined} aria-describedby="slug-status">
        </div>
        <p id="slug-status" class={check.state === 'bad' || slugError ? 'error' : 'hint'} aria-live="polite">{slugError || check.text || 'Leave empty for a random slug. Capital letters make no difference.'}</p>
      </div>
    {/if}
  </div>
  <div id="opt-tags" hidden={!open.tags}>
    {#if open.tags}<TagInput bind:this={tagInput} bind:tags />{/if}
  </div>
  <div id="opt-expiry" hidden={!open.expiry}>
    {#if open.expiry}
      <div class="field when">
        <label for="expiry">Stops working on</label>
        <input id="expiry" class="input mono" type="datetime-local" bind:this={expiryBox} bind:value={expiry} min={toLocalInput(Math.floor(Date.now() / 1000))}
          aria-invalid={expiryError ? 'true' : undefined} aria-describedby="expiry-status">
        <p id="expiry-status" class={expiryError ? 'error' : 'hint'}>{expiryError || 'In your time zone. Leave empty for no expiry.'}</p>
      </div>
    {/if}
  </div>

  {#if result}
    <div class="result" role="group" aria-label="New link">
      <div class="text">
        <a class="mono" href={result.shortUrl} target="_blank" rel="noreferrer">{result.domain}/{result.slug}</a>
        <p class="hint">{result.destination}</p>
      </div>
      <div class="row">
        <CopyButton text={result.shortUrl} label="Copy {result.shortUrl}" />
        <a class="btn" href="/links/{encodeURIComponent(result.id)}" use:nav>Details</a>
      </div>
    </div>
  {/if}
</form>

<style>
  .main { display: flex; flex-wrap: wrap; gap: 8px; }
  .main input {
    flex: 1 1 320px; min-width: 0; min-height: 60px; padding: 0 18px; border: 2px solid var(--ink); border-radius: 4px;
    background: var(--panel); font-size: 18px;
  }
  .main input[aria-invalid='true'] { border-color: var(--danger); }
  .main .btn { min-height: 60px; min-width: 144px; padding: 0 32px; font-size: 18px; }
  #destination-error:empty { margin-top: -12px; }
  .options .select { width: auto; max-width: 100%; background-color: transparent; font-size: 14px; color: var(--mute); }
  .slug { display: flex; align-items: center; min-height: 44px; border: 1px solid var(--edge); border-radius: 4px; background: var(--panel); font-size: 15px; }
  .slug:hover { border-color: var(--ink); }
  .slug:focus-within { outline: 2px solid var(--ink); outline-offset: 2px; }
  .slug.bad { border-color: var(--danger); }
  .slug span { padding-left: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .slug input { flex: 1 1 8ch; min-width: 8ch; min-height: 42px; padding: 0 14px 0 2px; border: 0; background: transparent; font-size: 16px; outline: none; }
  .when { max-width: 320px; }
  .result { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 24px; padding: 16px 0 16px 16px; border-left: 4px solid var(--accent); }
  .result .text { flex: 1 1 260px; min-width: 0; }
  .result .text a { display: inline-flex; align-items: center; min-height: 44px; font-size: 22px; font-weight: 500; color: var(--accent); overflow-wrap: anywhere; }
  .result p { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (max-width: 640px) {
    .main .btn { flex: 1 1 100%; }
    .options .btn { flex: 1 1 auto; }
    .options label { flex: 1 1 100%; }
    .options .select { width: 100%; }
    .when { max-width: none; }
  }
</style>
