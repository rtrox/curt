import { CLICK_BLOBS, CLICK_DATASET } from '@curt/shared';
import type { LinkStats } from '@curt/shared/schemas';
import type { Auth, Env } from '../types.ts';
import { isLinkId, queryAnalytics, sqlLinkIds, sqlTime, toNumber, toText } from './analytics.ts';
import { readCache, writeCache } from './cache.ts';

export const MAX_DAYS = 90;
export const MAX_IDS = 100;
const STATS_TTL = 300;
/** The free plan allows 50 cache calls and other subrequests per request. Grouping links into this many entries
 *  keeps the three calls per entry, plus the query, below that even for MAX_IDS links. */
const BUCKETS = 12;
const DAY_MS = 86_400_000;

/** Of `ids`, the ones that exist and the caller may see, sorted. */
export async function visibleLinks(env: Env, auth: Auth, ids: readonly string[]): Promise<string[]> {
  const valid = [...new Set(ids.filter(isLinkId))];
  if (valid.length === 0) return [];
  // One JSON parameter, because D1 allows only 100 bound parameters.
  const r = await env.DB.prepare(
    'SELECT id FROM links WHERE id IN (SELECT value FROM json_each(?1)) AND (?2 = 1 OR owner_id = ?3) ORDER BY id',
  ).bind(JSON.stringify(valid), auth.isAdmin ? 1 : 0, auth.userId).all<{ id: string }>();
  return r.results.map((x) => x.id).filter(isLinkId);
}

/** One link over the full range: only days with clicks, as [day number, clicks, bots, sampled]. */
interface LinkDays { at: number; days: [number, number, number, boolean][] }
type Bucket = Map<string, LinkDays>;

async function fetchDays(env: Env, ids: readonly string[], start: Date, at: number): Promise<Bucket> {
  const end = new Date(start.getTime() + MAX_DAYS * DAY_MS);
  const count = '_sample_interval * double1';
  const rows = await queryAnalytics(env,
    `SELECT index1 AS link_id, toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, SUM(${count}) AS clicks,`
    + ` sumIf(${count}, ${CLICK_BLOBS.bot} = '1') AS bots, MAX(_sample_interval) AS max_interval FROM ${CLICK_DATASET}`
    + ` WHERE timestamp >= ${sqlTime(start)} AND timestamp < ${sqlTime(end)} AND ${CLICK_BLOBS.outcome} = 'ok'`
    + ` AND index1 IN (${sqlLinkIds(ids)}) GROUP BY link_id, day`);

  // Links without clicks get an empty entry, so they are cached too.
  const found: Bucket = new Map(ids.map((id) => [id, { at, days: [] }]));
  const index = new Map(dayNames(start).map((d, i) => [d, i]));
  for (const r of rows) {
    const link = found.get(toText(r.link_id));
    const day = index.get(toText(r.day).slice(0, 10));
    if (!link || day === undefined) continue;
    link.days.push([day, toNumber(r.clicks), toNumber(r.bots), toNumber(r.max_interval) > 1]);
  }
  return found;
}

function dayNames(start: Date): string[] {
  return Array.from({ length: MAX_DAYS }, (_, i) => new Date(start.getTime() + i * DAY_MS).toISOString().slice(0, 10));
}

function bucketOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % BUCKETS;
}

/** Only entries that are still fresh. Each link has its own age, because writing one link renews the whole entry. */
async function readBucket(env: Env, start: Date, bucket: number, at: number): Promise<Bucket> {
  const raw = await readCache(env, ['link-days', start.toISOString(), String(bucket)]);
  const all = raw === null ? [] : JSON.parse(raw) as [string, LinkDays][];
  return new Map(all.filter(([, l]) => at - l.at < STATS_TTL * 1000));
}

async function addToBucket(env: Env, start: Date, bucket: number, at: number, fresh: Bucket): Promise<void> {
  // Read again, so links another request stored during the query are kept.
  const merged = new Map([...await readBucket(env, start, bucket, at), ...fresh]);
  await writeCache(env, ['link-days', start.toISOString(), String(bucket)], STATS_TTL, JSON.stringify([...merged]));
}

function summarize(link: LinkDays, names: readonly string[], days: number): LinkStats {
  const first = MAX_DAYS - days;
  const s: LinkStats = {
    total: 0, people: 0, bots: 0, sampled: false, days: names.slice(first).map((day) => ({ day, clicks: 0 })),
  };
  for (const [index, clicks, bots, sampled] of link.days) {
    const day = s.days[index - first];
    if (!day) continue;
    day.clicks += clicks;
    s.total += clicks;
    s.bots += bots;
    s.people += clicks - bots;
    s.sampled ||= sampled;
  }
  return s;
}

/** `ids` must come from visibleLinks for this caller, on every call: cached days are per link and shared between
 *  users, so that check is what protects them. Always reads the full range, so `days` never causes a query. */
export async function linkStats(env: Env, ids: readonly string[], now: Date, days: number): Promise<Record<string, LinkStats>> {
  if (ids.length === 0) return {};
  const at = now.getTime();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = new Date(today - (MAX_DAYS - 1) * DAY_MS);

  const buckets = [...new Set(ids.map(bucketOf))];
  const known: Bucket = new Map((await Promise.all(buckets.map((b) => readBucket(env, start, b, at)))).flatMap((b) => [...b]));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length > 0) {
    const fetched = await fetchDays(env, missing, start, at);
    for (const [id, link] of fetched) known.set(id, link);
    await Promise.all([...new Set(missing.map(bucketOf))].map((b) =>
      addToBucket(env, start, b, at, new Map([...fetched].filter(([id]) => bucketOf(id) === b)))));
  }
  const names = dayNames(start);
  return Object.fromEntries(ids.map((id) => [id, summarize(known.get(id) ?? { at, days: [] }, names, days)]));
}
