import type { Link, LinkStats } from '@curt/shared/schemas';
import { SvelteMap } from 'svelte/reactivity';
import { api, isAbort, messageOf, type ListFilters } from './api.ts';

const STATS_BATCH = 50;
const NO_FILTERS: ListFilters = { q: '', tag: '', domain: '', owner: '' };

/** Links loaded so far. Kept outside the page so going back to the list does not reload it. */
class LinkList {
  items = $state.raw<Link[]>([]);
  cursor = $state<string | null>(null);
  status = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
  error = $state('');
  loadingMore = $state(false);
  moreError = $state('');
  filters = $state<ListFilters>({ ...NO_FILTERS });
  stats = new SvelteMap<string, LinkStats>();
  statsFailed = $state(false);
  statsPending = $state(false);
  tags = $state.raw<{ tag: string; count: number }[]>([]);
  owners = new SvelteMap<string, string>();
  #abort: AbortController | null = null;

  filtered = $derived(Object.values(this.filters).some((v) => v.trim() !== ''));

  reset(): void {
    this.#abort?.abort();
    this.items = [];
    this.cursor = null;
    this.status = 'idle';
    this.filters = { ...NO_FILTERS };
    this.stats.clear();
    this.owners.clear();
    this.tags = [];
  }

  clearFilters(): void {
    this.filters = { ...NO_FILTERS };
    void this.load();
  }

  async load(): Promise<void> {
    this.#abort?.abort();
    const abort = this.#abort = new AbortController();
    this.status = 'loading';
    this.moreError = '';
    this.loadingMore = false;
    try {
      const page = await api.links({ ...this.filters }, null, abort.signal);
      this.items = page.links;
      this.cursor = page.nextCursor;
      this.status = 'ready';
      this.#learn(page.links);
      void this.#loadStats(page.links);
    } catch (e) {
      if (isAbort(e) || abort.signal.aborted) return;
      this.error = messageOf(e);
      this.status = 'error';
    }
  }

  async more(): Promise<void> {
    if (!this.cursor || this.loadingMore || this.status !== 'ready') return;
    const signal = this.#abort?.signal;
    this.loadingMore = true;
    this.moreError = '';
    try {
      const page = await api.links({ ...this.filters }, this.cursor, signal);
      const known = new Set(this.items.map((l) => l.id));
      this.items = [...this.items, ...page.links.filter((l) => !known.has(l.id))];
      this.cursor = page.nextCursor;
      this.#learn(page.links);
      void this.#loadStats(page.links);
    } catch (e) {
      if (signal?.aborted || isAbort(e)) return;
      this.moreError = messageOf(e);
    }
    this.loadingMore = false;
  }

  async loadTags(): Promise<void> {
    try { this.tags = (await api.tags()).tags; } catch { /* the filter simply offers fewer choices */ }
  }

  /** Admins can filter by anyone, not only by owners already on screen. */
  async loadOwners(): Promise<void> {
    try {
      for (const u of (await api.users()).users) this.owners.set(u.id, u.name ?? u.email ?? 'Unnamed');
    } catch { /* owners of loaded links are still offered */ }
  }

  async #loadStats(links: readonly Link[]): Promise<void> {
    const ids = links.map((l) => l.id).filter((id) => !this.stats.has(id));
    this.statsFailed = false;
    this.statsPending = ids.length > 0;
    for (let i = 0; i < ids.length; i += STATS_BATCH) {
      try {
        const { stats } = await api.manyStats(ids.slice(i, i + STATS_BATCH));
        for (const [id, s] of Object.entries(stats)) this.stats.set(id, s);
      } catch {
        this.statsFailed = true;
      }
    }
    this.statsPending = false;
  }

  #learn(links: readonly Link[]): void {
    for (const l of links) if (!this.owners.has(l.owner.id)) this.owners.set(l.owner.id, l.owner.name ?? 'Unnamed');
  }

  added(link: Link): void {
    this.#learn([link]);
    this.stats.set(link.id, { total: 0, people: 0, bots: 0, sampled: false, days: [] });
    // With a filter on, only the server knows whether the new link belongs in the list.
    if (this.filtered) void this.load();
    else this.items = [link, ...this.items.filter((l) => l.id !== link.id)];
    if (link.tags.length) void this.loadTags();
  }
  changed(link: Link): void {
    this.items = this.items.map((l) => (l.id === link.id ? link : l));
    void this.loadTags();
  }
  removed(id: string): void {
    this.items = this.items.filter((l) => l.id !== id);
    this.stats.delete(id);
    void this.loadTags();
  }
}
export const list = new LinkList();
