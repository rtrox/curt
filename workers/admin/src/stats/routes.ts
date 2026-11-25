import { Hono } from 'hono';
import { requireAuth } from '../auth/middleware.ts';
import { ApiError } from '../lib/errors.ts';
import type { AppEnv } from '../types.ts';
import { AnalyticsError } from './analytics.ts';
import { linkStats, MAX_DAYS, MAX_IDS, visibleLinks } from './links.ts';
import { cachedMetrics } from './metrics.ts';

/** Any failure to read click data is a 503. Zeros would look like a counter reset. */
async function orUnavailable<T>(what: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    console.error(what, e instanceof AnalyticsError ? e.message : 'unexpected error');
    throw new ApiError(503, 'stats_unavailable', 'Click data is not available right now.');
  }
}

function parseDays(raw: string | undefined): number {
  if (raw === undefined) return MAX_DAYS;
  const n = /^\d{1,3}$/.test(raw) ? Number(raw) : 0;
  if (n < 1 || n > MAX_DAYS) throw new ApiError(400, 'invalid_days', `days must be between 1 and ${MAX_DAYS}.`);
  return n;
}

/** Mounted at /api/v1/links, ahead of apiRoutes: GET /stats?ids= and GET /:id/stats. Owned by the stats task. */
export const linkStatsRoutes = new Hono<AppEnv>();

linkStatsRoutes.get('/stats', async (c) => {
  const auth = requireAuth(c.var.auth);
  const ids = (c.req.query('ids') ?? '').split(',').filter((id) => id !== '');
  if (ids.length === 0) throw new ApiError(400, 'invalid_ids', 'Send ids as a comma-separated list.');
  if (ids.length > MAX_IDS) throw new ApiError(400, 'too_many_ids', `Ask for at most ${MAX_IDS} links at a time.`);
  const days = parseDays(c.req.query('days'));
  const visible = await visibleLinks(c.env, auth, ids);
  const stats = await orUnavailable('link stats failed', () => linkStats(c.env, visible, new Date(), days));
  c.header('cache-control', 'private, no-store');
  return c.json({ stats });
});

linkStatsRoutes.get('/:id/stats', async (c) => {
  const auth = requireAuth(c.var.auth);
  const days = parseDays(c.req.query('days'));
  const visible = await visibleLinks(c.env, auth, [c.req.param('id')]);
  const id = visible[0];
  if (id === undefined) throw new ApiError(404, 'not_found', 'No such link.');
  const stats = await orUnavailable('link stats failed', () => linkStats(c.env, visible, new Date(), days));
  c.header('cache-control', 'private, no-store');
  return c.json(stats[id]);
});

/** Mounted at /metrics. Owned by the stats task. */
export const metricsRoutes = new Hono<AppEnv>();

metricsRoutes.get('/', async (c) => {
  const auth = requireAuth(c.var.auth, 'metrics:read');
  // Lists every link's slug, so membership alone is not enough.
  if (!auth.isAdmin) throw new ApiError(403, 'forbidden', 'Only admins can read metrics.');
  const body = await orUnavailable('metrics failed', () => cachedMetrics(c.env, new Date()));
  return c.body(body, 200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
});
