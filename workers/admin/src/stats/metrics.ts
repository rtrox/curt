import { CLICK_BLOBS, CLICK_DATASET, type Outcome } from '@curt/shared';
import { shortHosts } from '../lib/config.ts';
import type { Env } from '../types.ts';
import { queryAnalytics, sqlTime, toNumber, toText } from './analytics.ts';
import { cached } from './cache.ts';

const B = CLICK_BLOBS;
const COUNT = '_sample_interval * double1';
const OUTCOMES: readonly Outcome[] = ['ok', 'not_found', 'disabled', 'expired', 'root'];
const METRICS_TTL = 60;
/** Counting links reads every index row. At one scrape every two minutes, 10,000 links would
 *  pass D1's free daily row reads, so this gauge is refreshed less often than the counters. */
const LINK_COUNT_TTL = 900;

export function maxLinks(raw: string): number {
  return /^\d{1,9}$/.test(raw) ? Math.min(Number(raw), 10_000) : 1_000;
}

export function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

interface Sample { labels: Record<string, string>; value: number }

function family(name: string, type: 'counter' | 'gauge', help: string, samples: readonly Sample[]): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
  for (const s of samples) {
    const labels = Object.entries(s.labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',');
    lines.push(`${name}${labels ? `{${labels}}` : ''} ${s.value}`);
  }
  return lines.join('\n') + '\n';
}

function splitByBot(labels: Record<string, string>, clicks: number, bots: number): Sample[] {
  // Both series always exist, so the first click of either kind is seen by increase().
  return [
    { labels: { ...labels, bot: '0' }, value: Math.max(0, clicks - bots) },
    { labels: { ...labels, bot: '1' }, value: bots },
  ];
}

async function linkCounts(env: Env): Promise<Record<string, number>> {
  const json = await cached(env, ['link-counts'], LINK_COUNT_TTL, async () => {
    const r = await env.DB.prepare('SELECT domain, count(*) AS n FROM links GROUP BY domain').all<{ domain: string; n: number }>();
    return JSON.stringify(Object.fromEntries(r.results.map((x) => [x.domain, x.n])));
  });
  return JSON.parse(json) as Record<string, number>;
}

export async function renderMetrics(env: Env, now: Date): Promise<string> {
  const since = sqlTime(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  const cap = maxLinks(env.METRICS_MAX_LINKS);
  const measures = `SUM(${COUNT}) AS clicks, sumIf(${COUNT}, ${B.bot} = '1') AS bots, MAX(_sample_interval) AS max_interval`;

  // A link never changes domain, so distinct links on "ok" rows add up across domains.
  const totalsSql = `SELECT ${B.domain} AS domain, ${B.outcome} AS outcome, ${measures}, count(DISTINCT index1) AS links`
    + ` FROM ${CLICK_DATASET} WHERE timestamp >= ${since} GROUP BY domain, outcome`;
  const linksSql = `SELECT index1 AS link_id, ${B.domain} AS domain, ${B.slug} AS slug, ${measures}`
    + ` FROM ${CLICK_DATASET} WHERE timestamp >= ${since} AND ${B.outcome} = 'ok'`
    + ` GROUP BY link_id, domain, slug ORDER BY clicks DESC LIMIT ${cap}`;

  const [totalRows, linkRows, counts] = await Promise.all([
    queryAnalytics(env, totalsSql),
    cap > 0 ? queryAnalytics(env, linksSql) : [],
    linkCounts(env),
  ]);

  const hosts = shortHosts(env);
  const totals = new Map<string, { domain: string; outcome: string; clicks: number; bots: number }>();
  for (const domain of hosts) {
    for (const outcome of OUTCOMES) totals.set(JSON.stringify([domain, outcome]), { domain, outcome, clicks: 0, bots: 0 });
  }
  let sampled = false;
  let linksClicked = 0;
  for (const r of totalRows) {
    const domain = toText(r.domain);
    const outcome = toText(r.outcome);
    totals.set(JSON.stringify([domain, outcome]), { domain, outcome, clicks: toNumber(r.clicks), bots: toNumber(r.bots) });
    sampled ||= toNumber(r.max_interval) > 1;
    if (outcome === 'ok') linksClicked += toNumber(r.links);
  }
  const perLink: Sample[] = [];
  for (const r of linkRows.slice(0, cap)) {
    const labels = { domain: toText(r.domain), slug: toText(r.slug), link_id: toText(r.link_id) };
    perLink.push(...splitByBot(labels, toNumber(r.clicks), toNumber(r.bots)));
    sampled ||= toNumber(r.max_interval) > 1;
  }
  // Below the cap nothing was left out, even if a click landed between the two queries.
  const omitted = linkRows.length < cap ? 0 : Math.max(0, linksClicked - Math.min(linkRows.length, cap));

  for (const h of hosts) counts[h] ??= 0;
  return [
    family('curt_clicks_total', 'counter', 'Requests since the start of the UTC month, by outcome.',
      [...totals.values()].flatMap((t) => splitByBot({ domain: t.domain, outcome: t.outcome }, t.clicks, t.bots))),
    family('curt_link_clicks_total', 'counter', 'Successful redirects per link since the start of the UTC month, most clicked links only.', perLink),
    family('curt_links_omitted', 'gauge', 'Links with clicks this month that are left out by the cap.', [{ labels: {}, value: omitted }]),
    family('curt_metrics_sampled', 'gauge', '1 if any source row was sampled, so values are estimates.', [{ labels: {}, value: sampled ? 1 : 0 }]),
    family('curt_links', 'gauge', 'Links stored, refreshed at most every 15 minutes.',
      Object.entries(counts).map(([domain, value]) => ({ labels: { domain }, value }))),
  ].join('');
}

export function cachedMetrics(env: Env, now: Date): Promise<string> {
  return cached(env, ['metrics'], METRICS_TTL, () => renderMetrics(env, now));
}
