<script lang="ts">
  import type { Link, LinkStats, UpdateLink } from '@curt/shared/schemas';
  import { onMount } from 'svelte';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';
  import CopyButton from '../components/CopyButton.svelte';
  import TagInput from '../components/TagInput.svelte';
  import Ticks from '../components/Ticks.svelte';
  import { announce } from '../lib/announce.svelte.ts';
  import { api, messageOf, RequestError } from '../lib/api.ts';
  import { changes, differences, draftOf, settle, type Draft, type Field } from '../lib/edit.ts';
  import { count, dateTimeLabel, destinationProblem, fillDays, fromLocalInput, linkState, plural, toLocalInput, withScheme } from '../lib/format.ts';
  import { list } from '../lib/links.svelte.ts';
  import { downloadPng, downloadSvg, svgUrl } from '../lib/qr.ts';
  import { actionOf, outcome, pendingAction, repeatOf, statusText } from '../lib/sync.ts';
  import { nav, router } from '../lib/router.svelte.ts';
  import { session } from '../lib/session.svelte.ts';

  let { id }: { id: string } = $props();

  let link = $state.raw<Link | null>(null);
  let loadError = $state('');
  let missing = $state(false);

  let destination = $state('');
  let tags = $state<string[]>([]);
  let expiry = $state('');
  let destinationBox = $state<HTMLInputElement>();
  let expiryBox = $state<HTMLInputElement>();
  let conflictBox = $state<HTMLElement>();
  let tagInput = $state<TagInput>();
  let destinationError = $state('');
  let expiryError = $state('');
  let error = $state('');
  let saved = $state('');
  let busy = $state(false);

  /** The newest version after a 412, and what the person was trying to do. */
  let conflict = $state.raw<{ newer: Link; attempt: UpdateLink } | null>(null);

  /** The change last sent from here, so a pending one can be repeated. */
  let lastChange = $state.raw<UpdateLink | null>(null);
  let retried = $state(false);
  /** Deleted on the server, but not yet everywhere. */
  let deletePending = $state(false);
  let deleteNote = $state('');
  let pendingTitle = $state<HTMLElement>();

  let stats = $state.raw<LinkStats | null>(null);
  let statsError = $state(false);
  let svg = $state('');
  let qrUrl = $state('');
  let qrError = $state('');
  let deleting = $state(false);

  const status = $derived(link ? linkState(link) : 'active');
  const draft = $derived<Draft>({ destination, tags, expiresAt: fromLocalInput(expiry) });
  const pending = $derived(link ? changes(draftOf(link), draft) : {});
  const dirty = $derived(Object.keys(pending).length > 0);
  const days = $derived(fillDays(stats?.days ?? [], 90));
  const syncPending = $derived(link?.syncPending === true);

  function fill(l: Link, d: Draft = draftOf(l)): void {
    destination = d.destination;
    tags = d.tags;
    expiry = toLocalInput(d.expiresAt);
    destinationError = expiryError = '';
  }

  async function load(): Promise<void> {
    loadError = '';
    missing = false;
    try {
      link = await api.link(id);
      fill(link);
      list.changed(link);
    } catch (e) {
      if (e instanceof RequestError && e.status === 404) missing = true;
      else loadError = messageOf(e);
      return;
    }
    void loadStats();
    void loadQr();
  }
  async function loadStats(): Promise<void> {
    statsError = false;
    try { stats = await api.stats(id); } catch { statsError = true; }
  }
  async function loadQr(): Promise<void> {
    qrError = '';
    try {
      svg = await api.qr(id);
      if (qrUrl) URL.revokeObjectURL(qrUrl);
      qrUrl = svgUrl(svg);
    } catch { qrError = 'The QR code could not be loaded.'; }
  }
  onMount(() => {
    void load();
    return () => { if (qrUrl) URL.revokeObjectURL(qrUrl); };
  });

  async function patch(change: UpdateLink, base: Link, again = false): Promise<void> {
    busy = true;
    error = saved = '';
    try {
      const next = await api.update(id, base.version, change);
      const form = settle(draftOf(link ?? base), $state.snapshot(draft), change, draftOf(next));
      link = next;
      fill(next, form);
      conflict = null;
      lastChange = change;
      retried = again;
      list.changed(next);
      const text = outcome(actionOf(change), next.syncPending === true, again);
      if (!next.syncPending) saved = text;
      announce(text);
    } catch (e) {
      if (e instanceof RequestError && e.status === 412) await showNewer(change);
      else if (e instanceof RequestError && e.status === 404) missing = true;
      else error = messageOf(e);
    } finally {
      busy = false;
    }
  }
  async function showNewer(attempt: UpdateLink): Promise<void> {
    try {
      conflict = { newer: await api.link(id), attempt };
      setTimeout(() => conflictBox?.focus(), 0);
    } catch (e) {
      if (e instanceof RequestError && e.status === 404) missing = true;
      else error = messageOf(e);
    }
  }

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (!link || busy) return;
    destinationError = destinationProblem(destination, [...session.hosts, location.hostname]) ?? '';
    if (destinationError) { destinationBox?.focus(); return; }
    if (tagInput && !tagInput.flush()) return;
    destination = withScheme(destination);
    const change = changes(draftOf(link), { destination, tags, expiresAt: fromLocalInput(expiry) });
    if (change.expiresAt && change.expiresAt * 1000 <= Date.now()) {
      expiryError = 'The expiry must be in the future. To stop the link now, disable it.';
      expiryBox?.focus();
      return;
    }
    expiryError = '';
    if (Object.keys(change).length === 0) { saved = 'There is nothing to save.'; announce(saved); return; }
    await patch(change, link);
  }

  function useNewer(): void {
    if (!conflict) return;
    link = conflict.newer;
    fill(link);
    list.changed(link);
    conflict = null;
    lastChange = null;
    retried = false;
    saved = '';
    announce('Showing the newer version.');
    destinationBox?.focus();
  }
  async function keepMine(): Promise<void> {
    if (!conflict) return;
    await patch(conflict.attempt, conflict.newer);
  }
  function setDisabled(disabled: boolean): void {
    if (link) void patch({ disabled }, link);
  }
  async function remove(): Promise<void> {
    let pending: boolean;
    try {
      pending = await api.remove(id);
    } catch (e) {
      if (!(e instanceof RequestError && e.status === 404)) throw e;
      // Someone else got there first, and whether their deletion has finished is unknown.
      list.removed(id);
      missing = true;
      return;
    }
    list.removed(id);
    const text = outcome('delete', pending);
    announce(text);
    if (!pending) { router.go('/'); return; }
    deletePending = true;
    deleteNote = text;
    setTimeout(() => pendingTitle?.focus(), 0);
  }
  async function removeAgain(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const pending = await api.remove(id);
      deleteNote = outcome('delete', pending, true);
      deletePending = pending;
      announce(deleteNote);
      if (!pending) router.go('/');
    } catch (e) {
      // A 404 only says the link itself is gone, not that its redirect copy is.
      deleteNote = e instanceof RequestError && e.status === 404
        ? 'The server could not repeat it and will finish on its own. The old link may keep working for up to an hour.'
        : `${messageOf(e)} The old link may keep working for up to an hour.`;
      announce(deleteNote);
    } finally {
      busy = false;
    }
  }
  async function png(): Promise<void> {
    if (!link) return;
    qrError = '';
    try { await downloadPng(svg, `${link.domain}-${link.slug}`); } catch { qrError = 'The PNG could not be made. The SVG still works.'; }
  }

  const fieldNames: Record<Field, string> = { destination: 'Destination', tags: 'Tags', expiresAt: 'Expiry', disabled: 'Status' };
  function value(l: Link, field: Field): string {
    if (field === 'destination') return l.destination;
    if (field === 'tags') return l.tags.join(', ') || 'none';
    if (field === 'expiresAt') return l.expiresAt === null ? 'never' : dateTimeLabel(l.expiresAt);
    return (l.disabled ? 'disabled' : 'enabled') + (l.syncPending ? ', not in effect yet' : '');
  }
  function mine(field: Field, attempt: UpdateLink): string | null {
    if (!(field in attempt) || !conflict) return null;
    return value({ ...conflict.newer, ...attempt } as Link, field);
  }
</script>

<a class="textlink small back" href="/" use:nav>All links</a>

{#if deletePending && link}
  <div class="pending panel stack">
    <h1 tabindex="-1" bind:this={pendingTitle}>Deletion not finished</h1>
    <p class="mono">{link.domain}/{link.slug}</p>
    <p>{deleteNote}</p>
    <div class="row"><button class="btn" type="button" aria-disabled={busy} onclick={removeAgain}>Try again</button></div>
  </div>
{:else if missing}
  <div class="stack">
    <h1 tabindex="-1">Link not found</h1>
    <p class="mute">It may have been deleted, or it belongs to someone else. If it was just deleted, the short link can keep working for a while.</p>
  </div>
{:else if loadError}
  <div class="stack" role="alert">
    <h1 tabindex="-1">The link could not load</h1>
    <p class="error">{loadError}</p>
    <div><button class="btn" type="button" onclick={load}>Try again</button></div>
  </div>
{:else if !link}
  <h1 class="sr-only" tabindex="-1">Link</h1>
  <p class="mute" role="status">Loading link…</p>
{:else}
  <div class="head">
    <div class="title">
      <h1 tabindex="-1" class="mono"><span>{link.domain}</span>/{link.slug}</h1>
      <p class="hint">
        {statusText(status, syncPending)}{#if status === 'expired' && link.expiresAt !== null}&nbsp;on {dateTimeLabel(link.expiresAt)}{/if}
        · created {dateTimeLabel(link.createdAt)}{#if session.isAdmin}&nbsp;by {link.owner.name ?? 'an unnamed account'}{/if}
      </p>
    </div>
    <div class="row">
      <CopyButton text={link.shortUrl} label="Copy {link.shortUrl}" />
      <a class="btn" href={link.shortUrl} target="_blank" rel="noreferrer">Open</a>
    </div>
  </div>

  {#if syncPending && !conflict}
    <div class="pending panel stack">
      <h2>Change not in effect yet</h2>
      <p>{outcome(pendingAction(link, lastChange), true, retried)}</p>
      <div class="row"><button class="btn" type="button" aria-disabled={busy} onclick={() => { if (link && !busy) void patch(repeatOf(link, lastChange), link, true); }}>Try again</button></div>
    </div>
  {/if}

  {#if conflict}
    <div class="conflict panel stack" role="group" aria-labelledby="conflict-title" aria-describedby="conflict-text" tabindex="-1" bind:this={conflictBox}>
      <h2 id="conflict-title">This link changed while you were editing</h2>
      <p id="conflict-text">A newer version was saved on {dateTimeLabel(conflict.newer.updatedAt)}. Nothing of yours has been saved yet.</p>
      <dl>
        {#each [...new Set([...differences(link, conflict.newer), ...Object.keys(conflict.attempt)])] as field (field)}
          {@const f = field as Field}
          {@const my = mine(f, conflict.attempt)}
          <div>
            <dt class="label">{fieldNames[f]}</dt>
            <dd><span class="mute">Newer version:</span> {value(conflict.newer, f)}</dd>
            {#if my !== null}<dd><span class="mute">Yours:</span> {my}</dd>{/if}
          </div>
        {/each}
      </dl>
      <div class="row">
        <button class="btn" type="button" disabled={busy} onclick={useNewer}>Use the newer version</button>
        <button class="btn" type="button" disabled={busy} onclick={keepMine}>Save mine over it</button>
      </div>
    </div>
  {/if}

  <section class="panel" aria-label="Clicks">
    {#if statsError}
      <div class="row between"><p class="mono mute small">Click counts are not available right now. The link still works.</p>
        <button class="btn" type="button" onclick={loadStats}>Try again</button></div>
    {:else if !stats}
      <p class="mono mute small" role="status">Loading clicks…</p>
    {:else}
      <Ticks {days} sampled={stats.sampled} label="Clicks, last 90 days" summary="{stats.sampled ? 'About ' : ''}{plural(stats.total, 'click')}" />
      <p class="split hint">{count(stats.people)} from people, {count(stats.bots)} from bots{stats.sampled ? '. These are estimates from a sample.' : '.'}</p>
    {/if}
  </section>

  <div class="columns">
    <form class="stack edit" novalidate onsubmit={submit}>
      <h2>Edit</h2>
      <div class="field">
        <label for="edit-destination">Destination</label>
        <input id="edit-destination" class="input mono" type="text" inputmode="url" autocomplete="off" autocapitalize="none" spellcheck="false"
          bind:this={destinationBox} bind:value={destination} aria-invalid={destinationError ? 'true' : undefined} aria-describedby="edit-destination-error">
        <p class="error" id="edit-destination-error" role="alert">{destinationError}</p>
      </div>
      <TagInput bind:this={tagInput} bind:tags />
      <div class="field">
        <label for="edit-expiry">Stops working on</label>
        <div class="row nowrap">
          <input id="edit-expiry" class="input mono" type="datetime-local" bind:this={expiryBox} bind:value={expiry}
            aria-invalid={expiryError ? 'true' : undefined} aria-describedby="edit-expiry-hint">
          {#if expiry}<button class="btn" type="button" aria-label="Clear expiry" onclick={() => { expiry = ''; expiryBox?.focus(); }}>Clear</button>{/if}
        </div>
        <p class={expiryError ? 'error' : 'hint'} id="edit-expiry-hint">{expiryError || 'In your time zone. Leave empty for no expiry.'}</p>
      </div>
      <div class="row">
        <button class="btn primary" type="submit" aria-disabled={busy}>Save</button>
        {#if dirty}<button class="btn" type="button" disabled={busy} onclick={() => link && fill(link)}>Undo changes</button>{/if}
        <span class="hint">{dirty ? 'Not saved yet.' : saved}</span>
      </div>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </form>

    <div class="side">
      <section class="stack" aria-labelledby="qr-title">
        <h2 id="qr-title">QR code</h2>
        {#if qrUrl}<img class="qr" src={qrUrl} width="200" height="200" alt="QR code for {link.shortUrl}">
        {:else if !qrError}<p class="mute" role="status">Loading QR code…</p>{/if}
        {#if qrError}<p class="error" role="alert">{qrError}</p>{/if}
        {#if svg}
          <div class="row">
            <button class="btn" type="button" aria-label="Download QR code as SVG" onclick={() => link && downloadSvg(svg, `${link.domain}-${link.slug}`)}>SVG</button>
            <button class="btn" type="button" aria-label="Download QR code as PNG" onclick={png}>PNG</button>
          </div>
        {:else if qrError}<div><button class="btn" type="button" onclick={loadQr}>Try again</button></div>{/if}
      </section>

      <section class="stack" aria-labelledby="status-title">
        <h2 id="status-title">Status</h2>
        <p class="hint">{link.disabled && syncPending ? 'This link is set to disabled, but it may keep working for up to an hour.' : link.disabled ? 'This link is disabled. Visitors see a page saying it is no longer available.' : 'Disabling stops the link and keeps its slug and statistics. Deleting is permanent.'}</p>
        <div class="row">
          <button class="btn" type="button" disabled={busy} onclick={() => link && setDisabled(!link.disabled)}>{link.disabled ? 'Enable' : 'Disable'}</button>
          <button class="btn danger" type="button" disabled={busy} onclick={() => { deleting = true; }}>Delete</button>
        </div>
      </section>
    </div>
  </div>

  {#if deleting}
    <ConfirmDialog title="Delete this link?" action="Delete" onconfirm={remove} onclose={() => { deleting = false; }}>
      <p><span class="mono">{link.domain}/{link.slug}</span> will stop working. This cannot be undone, and someone else may then use the slug.</p>
    </ConfirmDialog>
  {/if}
{/if}

<style>
  .back { align-self: flex-start; margin-bottom: -32px; color: var(--mute); }
  .head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 24px; }
  .title { flex: 1 1 280px; min-width: 0; }
  h1.mono { font-size: 28px; font-weight: 500; color: var(--accent); overflow-wrap: anywhere; letter-spacing: -0.02em; }
  h1 span { color: var(--mute); font-weight: 400; }
  .title .hint { margin-top: 4px; }
  .split { margin-top: 12px; }
  .between { justify-content: space-between; }
  .nowrap { flex-wrap: nowrap; }
  .columns { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 40px 64px; }
  .side { display: flex; flex-direction: column; gap: 40px; }
  .edit { gap: 20px; }
  .edit .primary { min-width: 120px; }
  .qr { display: block; width: 200px; height: 200px; border: 1px solid var(--line); border-radius: 4px; background: #fff; }
  .conflict, .pending { border-color: var(--danger); }
  .conflict dl { display: flex; flex-direction: column; gap: 12px; }
  .conflict dd { overflow-wrap: anywhere; }
  .error:empty { display: none; }
  @media (max-width: 720px) {
    .columns { grid-template-columns: minmax(0, 1fr); }
    .back { margin-bottom: -24px; }
    h1.mono { font-size: 24px; }
  }
</style>
