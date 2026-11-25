import { env as rawEnv } from 'cloudflare:workers';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { linkStatsSchema, manyStatsSchema, type LinkStats } from '@curt/shared/schemas';
import { ApiError } from '../src/lib/errors.ts';
import { linkStatsRoutes } from '../src/stats/routes.ts';
import type { AppEnv, Auth, Env } from '../src/types.ts';

const base = rawEnv as unknown as Env;
const alice: Auth = { userId: 'alice', isAdmin: false, via: 'session', scopes: ['links', 'metrics:read'] };
const bob: Auth = { ...alice, userId: 'bob' };
const admin: Auth = { ...alice, userId: 'boss', isAdmin: true };
let n = 0;
let env: Env;
let sql: string[];

function get(path: string, auth: Auth | null, e: Env = env): Promise<Response> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => { c.set('auth', auth); await next(); });
  app.route('/api/v1/links', linkStatsRoutes);
  app.onError((err, c) => err instanceof ApiError ? c.json({ error: { code: err.code, message: err.message } }, err.status) : c.json({}, 500));
  return Promise.resolve(app.request(`/api/v1/links${path}`, {}, e));
}
function mockAe(rows: unknown[]) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
    sql.push(String(init?.body));
    return Response.json({ data: rows });
  });
}
const row = (link_id: string, day: string, clicks: unknown, bots: unknown = 0, max_interval: unknown = 1) =>
  ({ link_id, day: `${day} 00:00:00`, clicks, bots, max_interval });
const one = async (r: Response): Promise<LinkStats> => linkStatsSchema.parse(await r.json());

beforeAll(async () => {
  await base.DB.batch(['alice', 'bob', 'boss'].map((u) =>
    base.DB.prepare("INSERT INTO users (id, issuer, subject, created_at) VALUES (?1, 'i', ?1, 0)").bind(u)));
  await base.DB.batch([['a1', 'alice'], ['a2', 'alice'], ['b1', 'bob']].map(([id, owner]) =>
    base.DB.prepare("INSERT INTO links (id, domain, slug, destination, owner_id, created_at, updated_at) VALUES (?1, 'go.example', ?1, 'https://example.com/', ?2, 0, 0)").bind(id, owner)));
  const bulk = Array.from({ length: 100 }, (_, i) => `bulk-${i}`);
  await base.DB.batch(bulk.map((id) =>
    base.DB.prepare("INSERT INTO links (id, domain, slug, destination, owner_id, created_at, updated_at) VALUES (?1, 's.example', ?1, 'https://example.com/', 'alice', 0, 0)").bind(id)));
});
beforeEach(() => {
  env = { ...base, ADMIN_HOST: `s${++n}.example.com` };
  sql = [];
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-25T23:59:00Z') });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('GET /links/:id/stats', () => {
  it('fills 90 UTC days and splits people from bots', async () => {
    mockAe([row('a1', '2026-11-25', '5', '2'), row('a1', '2026-08-28', 1), row('a1', '2026-08-27', 99), row('b1', '2026-11-25', 99)]);
    const s = await one(await get('/a1/stats', alice));
    expect(s.days).toHaveLength(90);
    expect(s.days[0]).toEqual({ day: '2026-08-28', clicks: 1 });
    expect(s.days[1]).toEqual({ day: '2026-08-29', clicks: 0 });
    expect(s.days[89]).toEqual({ day: '2026-11-25', clicks: 5 });
    expect(s).toMatchObject({ total: 6, people: 4, bots: 2, sampled: false });
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain("blob3 = 'ok'");
    expect(sql[0]).toContain("index1 IN ('a1')");
    expect(sql[0]).toContain("timestamp >= toDateTime('2026-08-28 00:00:00') AND timestamp < toDateTime('2026-11-26 00:00:00')");
    expect(sql[0]).toContain('SUM(_sample_interval * double1)');
  });
  it('reports sampling', async () => {
    mockAe([row('a1', '2026-11-25', 40, 0, '10')]);
    expect((await one(await get('/a1/stats', alice))).sampled).toBe(true);
  });
  it('accepts 1 to 90 days', async () => {
    mockAe([]);
    expect((await one(await get('/a1/stats?days=7', alice))).days.map((d) => d.day)).toEqual(
      ['19', '20', '21', '22', '23', '24', '25'].map((d) => `2026-11-${d}`));
    for (const bad of ['0', '91', '-1', 'x', '1.5', '']) expect((await get(`/a1/stats?days=${bad}`, alice)).status).toBe(400);
  });
  it('hides links of others, missing links and bad IDs behind the same 404, without a query', async () => {
    const f = mockAe([]);
    const bodies = [];
    for (const id of ['b1', 'nope', "a1'%20OR%201=1--", 'a1%0A']) {
      const r = await get(`/${id}/stats`, alice);
      expect(r.status).toBe(404);
      bodies.push(await r.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(f).not.toHaveBeenCalled();
  });
  it('lets admins see every link and requires the links scope', async () => {
    mockAe([]);
    expect((await get('/b1/stats', admin)).status).toBe(200);
    expect((await get('/a1/stats', null)).status).toBe(401);
    expect((await get('/a1/stats', { ...alice, scopes: ['metrics:read'] })).status).toBe(403);
  });
  it('returns 503 and caches nothing when Analytics Engine fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('down'); });
    const r = await get('/a1/stats', alice);
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: { code: 'stats_unavailable' } });
    vi.restoreAllMocks();
    mockAe([row('a1', '2026-11-25', 1)]);
    expect((await one(await get('/a1/stats', alice))).total).toBe(1);
  });
});

describe('GET /links/stats', () => {
  it('returns owned links, including quiet ones, and omits the rest', async () => {
    mockAe([row('a1', '2026-11-25', 3)]);
    const { stats } = manyStatsSchema.parse(await (await get("/stats?ids=a1,a2,b1,nope,a1,x'y", alice)).json());
    expect(Object.keys(stats).sort()).toEqual(['a1', 'a2']);
    expect(stats.a1?.total).toBe(3);
    expect(stats.a2?.total).toBe(0);
    expect(stats.a2?.days).toHaveLength(90);
    expect(sql[0]).toContain("IN ('a1', 'a2')");
  });
  it('answers without a query when nothing is visible', async () => {
    const f = mockAe([]);
    expect(await (await get('/stats?ids=b1', alice)).json()).toEqual({ stats: {} });
    expect(f).not.toHaveBeenCalled();
  });
  it('allows 100 IDs and no more', async () => {
    mockAe([]);
    const ids = Array.from({ length: 100 }, (_, i) => `bulk-${i}`);
    const r = manyStatsSchema.parse(await (await get(`/stats?ids=${ids.join(',')}&days=1`, alice)).json());
    expect(Object.keys(r.stats)).toHaveLength(100);
    expect((await get(`/stats?ids=${[...ids, 'a1'].join(',')}`, alice)).status).toBe(400);
    expect((await get('/stats?ids=', alice)).status).toBe(400);
    expect((await get('/stats', alice)).status).toBe(400);
  });
  it('shows admins everything', async () => {
    mockAe([]);
    expect(Object.keys(((await (await get('/stats?ids=a1,b1', admin)).json()) as { stats: object }).stats).sort()).toEqual(['a1', 'b1']);
  });
});

describe('cache', () => {
  const queried = () => sql.map((q) => [...q.slice(q.indexOf('index1 IN')).matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((v) => v !== '1'));

  it('answers days=1 to 90 for one link with one 90-day query, sliced correctly', async () => {
    const f = mockAe([row('a1', '2026-11-25', 5, 2), row('a1', '2026-11-20', 7, 1), row('a1', '2026-08-28', 100, 100, 10)]);
    for (let days = 1; days <= 90; days++) {
      const s = await one(await get(`/a1/stats?days=${days}`, alice));
      expect(s.days).toHaveLength(days);
      expect(s.days.at(-1)).toEqual({ day: '2026-11-25', clicks: 5 });
      expect(s.total).toBe(days < 6 ? 5 : days < 90 ? 12 : 112);
      expect(s.bots).toBe(days < 6 ? 2 : days < 90 ? 3 : 103);
      expect(s.people).toBe(days < 6 ? 3 : 9);
      expect(s.sampled).toBe(days === 90);
    }
    expect(f).toHaveBeenCalledTimes(1);
    expect(sql[0]).toContain("timestamp >= toDateTime('2026-08-28 00:00:00')");
  });
  it('queries only the links that are new', async () => {
    mockAe([row('a1', '2026-11-25', 3), row('a2', '2026-11-25', 4), row('bulk-1', '2026-11-25', 5)]);
    await get('/stats?ids=a1,a2&days=3', alice);
    const r = manyStatsSchema.parse(await (await get('/stats?ids=bulk-1,a2,bulk-0', alice)).json());
    expect(queried()).toEqual([['a1', 'a2'], ['bulk-0', 'bulk-1']]);
    expect(r.stats.a2?.total).toBe(4);
    expect(r.stats['bulk-1']?.total).toBe(5);
    expect(r.stats['bulk-0']?.total).toBe(0);
    // Any other combination or order, and quiet links, come from the cache.
    for (const ids of ['a2,a1', 'bulk-0', 'bulk-0,a1', 'bulk-1,bulk-0,a2,a1']) expect((await get(`/stats?ids=${ids}`, alice)).status).toBe(200);
    await get('/a1/stats', alice);
    expect(sql).toHaveLength(2);
  });
  it('keeps every link when many share an entry, within the free plan call limit', async () => {
    const match = vi.spyOn(Cache.prototype, 'match');
    const put = vi.spyOn(Cache.prototype, 'put');
    mockAe([]);
    const ids = Array.from({ length: 100 }, (_, i) => `bulk-${i}`);
    for (let i = 0; i < 20; i++) await get(`/${ids[i]}/stats`, alice);
    match.mockClear();
    put.mockClear();
    sql = [];
    await get(`/stats?ids=${ids.join(',')}`, alice);
    expect(queried()[0]).toHaveLength(80);
    expect(match.mock.calls.length + put.mock.calls.length + sql.length).toBeLessThan(45);
    for (const [, r] of put.mock.calls) expect(r.headers.get('cache-control')).toBe('max-age=300');
    await get(`/stats?ids=${ids.join(',')}&days=1`, alice);
    expect(sql).toHaveLength(1);
  });
  it('refreshes each link five minutes after it was read, even if its entry was written later', async () => {
    mockAe([]);
    vi.setSystemTime(new Date('2026-11-25T10:00:00Z'));
    await get('/a1/stats', alice);
    vi.setSystemTime(new Date('2026-11-25T10:04:00Z'));
    for (let i = 0; i < 24; i++) await get(`/bulk-${i}/stats`, alice);
    sql = [];
    vi.setSystemTime(new Date('2026-11-25T10:04:59Z'));
    await get('/a1/stats', alice);
    expect(sql).toHaveLength(0);
    vi.setSystemTime(new Date('2026-11-25T10:05:00Z'));
    await get('/a1/stats', alice);
    await get('/bulk-1/stats', alice);
    expect(queried()).toEqual([['a1']]);
  });
  it('starts again on a new UTC day', async () => {
    mockAe([]);
    await get('/a1/stats', alice);
    vi.setSystemTime(new Date('2026-11-26T00:00:30Z'));
    expect((await one(await get('/a1/stats', alice))).days.at(-1)?.day).toBe('2026-11-26');
    expect(sql).toHaveLength(2);
  });
  it('shares cached links only with people who may see them', async () => {
    const f = mockAe([row('a1', '2026-11-25', 3), row('b1', '2026-11-25', 8)]);
    await get('/stats?ids=a1,b1', admin);
    expect(f).toHaveBeenCalledTimes(1);
    expect((await get('/a1/stats', bob)).status).toBe(404);
    expect((await get('/a1/stats', null)).status).toBe(401);
    expect((await get('/a1/stats', { ...alice, scopes: ['metrics:read'] })).status).toBe(403);
    const b = manyStatsSchema.parse(await (await get('/stats?ids=a1,b1', bob)).json());
    expect(Object.keys(b.stats)).toEqual(['b1']);
    expect((await one(await get('/a1/stats', alice))).total).toBe(3);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('checks ownership again on a cached answer', async () => {
    mockAe([]);
    await base.DB.prepare("INSERT INTO links (id, domain, slug, destination, owner_id, created_at, updated_at) VALUES ('gone', 'go.example', 'gone', 'https://example.com/', 'alice', 0, 0)").run();
    expect((await get('/gone/stats', alice)).status).toBe(200);
    await base.DB.prepare("UPDATE links SET owner_id = 'bob' WHERE id = 'gone'").run();
    expect((await get('/gone/stats', alice)).status).toBe(404);
    expect((await get('/gone/stats', bob)).status).toBe(200);
    await base.DB.prepare("DELETE FROM links WHERE id = 'gone'").run();
    expect((await get('/gone/stats', bob)).status).toBe(404);
  });
});
