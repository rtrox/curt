<script lang="ts">
  import { onMount } from 'svelte';
  import CopyButton from '../components/CopyButton.svelte';
  import Spark from '../components/Spark.svelte';
  import Ticks from '../components/Ticks.svelte';
  import { announce } from '../lib/announce.svelte.ts';
  import { clicksText, dateLabel, fillDays, linkState, plural, shortDestination, sumDays } from '../lib/format.ts';
  import { list } from '../lib/links.svelte.ts';
  import { badgeText } from '../lib/sync.ts';
  import { nav } from '../lib/router.svelte.ts';
  import { session } from '../lib/session.svelte.ts';

  onMount(() => {
    if (list.status === 'idle' || list.status === 'error') void list.load();
    void list.loadTags();
    if (session.isAdmin) void list.loadOwners();
  });

  const shown = $derived(list.items.map((l) => list.stats.get(l.id)).filter((s) => s !== undefined));
  const days = $derived(fillDays(sumDays(shown.map((s) => s.days)), 30));
  const total = $derived(days.reduce((n, d) => n + d.clicks, 0));
  const sampled = $derived(shown.some((s) => s.sampled));
  const scope = $derived(list.cursor || list.filtered ? ` on the ${plural(list.items.length, 'link')} shown` : '');
  const several = $derived(session.hosts.length > 1);

  let timer: ReturnType<typeof setTimeout> | undefined;
  function search(value: string): void {
    list.filters.q = value;
    clearTimeout(timer);
    timer = setTimeout(reload, 250);
  }
  async function reload(): Promise<void> {
    clearTimeout(timer);
    await list.load();
    if (list.status === 'ready') announce(`${plural(list.items.length, 'link')}${list.cursor ? ' or more' : ''} found.`);
  }
  function choose(key: 'tag' | 'domain' | 'owner', value: string): void {
    list.filters[key] = value;
    void reload();
  }
  async function more(): Promise<void> {
    const before = list.items.length;
    await list.more();
    announce(`Loaded ${plural(list.items.length - before, 'more link', 'more links')}.`);
  }

  // The selected tag or owner stays in its menu even when nothing loaded mentions it.
  const tagChoices = $derived([...new Set([...list.tags.map((t) => t.tag), ...(list.filters.tag ? [list.filters.tag] : [])])].sort());
  const ownerChoices = $derived([...list.owners].filter(([id]) => id !== session.me?.id).sort((a, b) => a[1].localeCompare(b[1])));
  const blank = $derived(list.status === 'ready' && list.items.length === 0);
</script>

{#if !(blank && !list.filtered) && list.status !== 'error'}
  <section class="panel" aria-label="Clicks">
    {#if list.statsFailed && shown.length === 0}
      <p class="mono mute small">Click counts are not available right now. Your links still work.</p>
    {:else}
      <Ticks {days} {sampled} label="Clicks, last 30 days" summary={list.statsPending || list.status === 'loading' ? 'Loading…' : `${sampled ? 'About ' : ''}${plural(total, 'click')}${scope}`} />
    {/if}
  </section>
{/if}

<section class="links" aria-labelledby="links-title">
  <h2 id="links-title" class="sr-only">Links</h2>

  {#if !(blank && !list.filtered)}
    <div class="filters" role="search">
      <label class="q"><span class="sr-only">Search slug, destination or tag</span>
        <input class="input" type="search" placeholder="Search" autocomplete="off" spellcheck="false" maxlength="200" value={list.filters.q} oninput={(e) => search(e.currentTarget.value)}>
      </label>
      <label><span class="sr-only">Tag</span>
        <select class="select" value={list.filters.tag} onchange={(e) => choose('tag', e.currentTarget.value)}>
          <option value="">All tags</option>
          {#each tagChoices as t (t)}<option value={t}>{t}</option>{/each}
        </select>
      </label>
      {#if several}
        <label><span class="sr-only">Domain</span>
          <select class="select" value={list.filters.domain} onchange={(e) => choose('domain', e.currentTarget.value)}>
            <option value="">All domains</option>
            {#each session.hosts as h (h)}<option value={h}>{h}</option>{/each}
          </select>
        </label>
      {/if}
      {#if session.isAdmin}
        <label><span class="sr-only">Owner</span>
          <select class="select" value={list.filters.owner} onchange={(e) => choose('owner', e.currentTarget.value)}>
            <option value="">All owners</option>
            <option value={session.me?.id}>Only mine</option>
            {#each ownerChoices as [id, name] (id)}<option value={id}>{name}</option>{/each}
          </select>
        </label>
      {/if}
    </div>
  {/if}

  {#if list.status === 'error'}
    <div class="stack note" role="alert">
      <p class="error">{list.error}</p>
      <div><button class="btn" type="button" onclick={() => list.load()}>Try again</button></div>
    </div>
  {:else if blank && list.filtered}
    <div class="stack note">
      <p>No links match.</p>
      <div><button class="btn" type="button" onclick={() => list.clearFilters()}>Clear search and filters</button></div>
    </div>
  {:else if blank}
    <p class="note mute">No links yet. Paste an address above to make the first one.</p>
  {:else if list.items.length === 0}
    <p class="note mute" role="status">Loading links…</p>
  {:else}
    <!-- Explicit roles keep the table semantics when the narrow layout turns rows into grids. -->
    <!-- svelte-ignore a11y_no_redundant_roles -->
    <table role="table" aria-busy={list.status === 'loading'} class:owned={session.isAdmin}>
      <thead role="rowgroup">
        <tr role="row">
          <th scope="col" role="columnheader">Slug</th>
          <th scope="col" role="columnheader">Destination</th>
          <th scope="col" role="columnheader">Tags</th>
          {#if session.isAdmin}<th scope="col" role="columnheader">Owner</th>{/if}
          <th scope="col" role="columnheader" class="trend">30 days</th>
          <th scope="col" role="columnheader" class="num">Clicks</th>
          <th scope="col" role="columnheader"><span class="sr-only">Copy</span></th>
        </tr>
      </thead>
      <tbody role="rowgroup">
        {#each list.items as l (l.id)}
          {@const s = list.stats.get(l.id)}
          {@const state = linkState(l)}
          {@const badge = badgeText(state, l.syncPending === true)}
          <tr role="row" class:off={state !== 'active'}>
            <td role="cell" class="slug">
              <a class="mono" href="/links/{encodeURIComponent(l.id)}" use:nav>{#if several}<span class="host">{l.domain}</span>{/if}/{l.slug}</a>
              {#if badge}<span class="badge mono">{badge}</span>{/if}
              {#if state === 'active' && l.expiresAt !== null}<span class="badge mono">until {dateLabel(l.expiresAt)}</span>{/if}
            </td>
            <td role="cell" class="dest"><a href={l.destination} target="_blank" rel="noreferrer" title={l.destination}>{shortDestination(l.destination)}</a></td>
            <td role="cell" class="tags mute">
              {#each l.tags as t (t)}<button type="button" aria-label="Show links tagged {t}" onclick={() => choose('tag', t)}>{t}</button>{/each}
            </td>
            {#if session.isAdmin}
              <td role="cell" class="owner mute">{l.owner.name ?? 'Unnamed'}</td>
            {/if}
            <td role="cell" class="trend">{#if s}<Spark days={fillDays(s.days, 30)} />{/if}</td>
            <td role="cell" class="num mono">
              {#if s}<span title={s.sampled ? 'Estimated from a sample. Last three months.' : 'Last three months'}>{clicksText(s)}</span><span class="sr-only"> clicks</span>
              {:else}<span class="mute" aria-hidden="true">–</span><span class="sr-only">{list.statsFailed ? 'not available' : 'loading'}</span>{/if}
            </td>
            <td role="cell" class="copy"><CopyButton compact text={l.shortUrl} label="Copy {l.shortUrl}" /></td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if list.statsFailed && shown.length > 0}<p class="hint">Some click counts are not available right now.</p>{/if}
    {#if list.moreError}<p class="error" role="alert">{list.moreError}</p>{/if}
    {#if list.cursor}
      <div><button class="btn" type="button" disabled={list.loadingMore || list.status === 'loading'} onclick={more}>{list.loadingMore ? 'Loading…' : 'Load more'}</button></div>
    {/if}
  {/if}
</section>

<style>
  .links { display: flex; flex-direction: column; gap: 16px; }
  .filters { display: flex; flex-wrap: wrap; gap: 8px; }
  .filters label { flex: 0 1 180px; }
  .filters .q { flex: 1 1 240px; }
  .filters .select { background-color: transparent; font-size: 15px; }
  .filters .input { background: transparent; }
  .note { padding: 24px 0; border-top: 1px solid var(--line); }

  table { width: 100%; border-collapse: collapse; text-align: left; table-layout: fixed; }
  th { padding: 8px 16px 8px 0; font: 400 13px/1.4 var(--mono); color: var(--mute); }
  th:nth-child(1) { width: 24%; }
  .owned th:nth-child(1) { width: 20%; }
  th:nth-child(3) { width: 14%; }
  .owned th:nth-child(4) { width: 12%; }
  th.trend { width: 106px; }
  th.num { width: 64px; }
  th:last-child { width: 70px; padding: 0; }
  tbody tr { border-top: 1px solid var(--line); font-size: 15px; }
  tbody tr:last-child { border-bottom: 1px solid var(--line); }
  td { padding: 4px 16px 4px 0; vertical-align: middle; overflow-wrap: anywhere; }
  .num { text-align: right; padding-right: 8px; }
  .slug a { display: inline-block; padding: 11px 0; font-weight: 500; color: var(--accent); text-decoration: none; }
  .slug a:hover, .dest a:hover { text-decoration: underline; }
  .host { color: var(--mute); font-weight: 400; }
  .badge { display: inline-block; margin: 0 0 6px; padding: 1px 6px; border: 1px solid var(--edge); border-radius: 4px; font-size: 12px; color: var(--mute); overflow-wrap: normal; }
  .off .slug a, .off .dest a { color: var(--mute); }
  .dest a { display: block; padding: 11px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-decoration: none; }
  .tags button { min-width: 44px; min-height: 44px; padding: 0 10px 0 0; border: 0; background: transparent; font-size: 15px; color: var(--mute); text-align: left; }
  .tags button:hover { color: var(--ink); text-decoration: underline; text-underline-offset: 3px; }
  .copy { padding-right: 0; text-align: right; }

  @media (max-width: 640px) {
    .filters label { flex: 1 1 120px; }
    .filters .q { flex: 1 1 100%; }
  }
  @media (max-width: 860px) {
    table, tbody { display: block; }
    thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
    tbody tr {
      display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; column-gap: 12px; padding: 8px 0;
      grid-template-areas: 'slug num copy' 'dest dest dest' 'tags tags trend';
    }
    .owned tbody tr { grid-template-areas: 'slug num copy' 'dest dest dest' 'owner owner trend' 'tags tags tags'; }
    td { padding: 0; }
    .slug { grid-area: slug; }
    .dest { grid-area: dest; min-width: 0; }
    .tags { grid-area: tags; }
    .owner { grid-area: owner; }
    .trend { grid-area: trend; justify-self: end; }
    .num { grid-area: num; padding: 0; }
    .copy { grid-area: copy; }
  }
</style>
