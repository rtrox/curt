import { env as rawEnv } from 'cloudflare:workers';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/errors.ts';
import { AnalyticsError, queryAnalytics, sqlLinkIds, sqlTime, toNumber } from '../src/stats/analytics.ts';
import { escapeLabel, maxLinks } from '../src/stats/metrics.ts';
import { metricsRoutes } from '../src/stats/routes.ts';
import type { AppEnv, Auth, Env } from '../src/types.ts';

const base = rawEnv as unknown as Env;
const metricsAuth: Auth = { userId: 'u1', isAdmin: true, via: 'token', scopes: ['metrics:read'] };
let n = 0;
let env: Env;
let sql: string[];

/** Each call gets its own host, so cached output never crosses tests. */
const freshEnv = (over: Partial<Env> = {}): Env => ({ ...base, ADMIN_HOST: `m${++n}.example.com`, ...over });
function get(e: Env, auth: Auth | null = metricsAuth): Promise<Response> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => { c.set('auth', auth); await next(); });
  app.route('/metrics', metricsRoutes);
  app.onError((err, c) => c.json({ error: err.message }, err instanceof ApiError ? err.status : 500));
  return Promise.resolve(app.request('/metrics', {}, e));
}
function mockAe(totals: unknown[], links: unknown[]) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const q = String(init?.body);
    sql.push(q);
    return Response.json({ data: q.includes('AS slug') ? links : totals });
  });
}

beforeEach(() => {
  env = freshEnv();
  sql = [];
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-25T10:00:00Z') });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('analytics client', () => {
  it('posts SQL with the token and asks for JSON', async () => {
    const f = mockAe([{ a: 1 }], []);
    expect(await queryAnalytics(env, 'SELECT 1')).toEqual([{ a: 1 }]);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/test-account/analytics_engine/sql');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('SELECT 1 FORMAT JSON');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-only');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.redirect).toBe('manual');
  });
  it.each<[string, () => Promise<Response>, string]>([
    ['status', async () => new Response('bad token test-only', { status: 403 }), 'request returned status 403'],
    ['redirect', async () => new Response(null, { status: 302, headers: { location: 'https://evil.example' } }), 'request returned status 302'],
    ['network', async () => { throw new Error('connect failed with test-only'); }, 'request failed'],
    ['timeout', async () => { throw new DOMException('test-only', 'TimeoutError'); }, 'request timed out'],
    ['not JSON', async () => new Response('<html>test-only'), 'request failed'],
    ['no data', async () => Response.json({ errors: ['test-only'] }), 'unexpected response'],
    ['null', async () => Response.json(null), 'unexpected response'],
  ])('reports %s failures without the token', async (_name, impl, message) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(impl);
    const e = await queryAnalytics(env, 'SELECT 1').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AnalyticsError);
    expect((e as Error).message).toBe(message);
    expect(String((e as Error).stack)).not.toContain('test-only');
    expect((e as Error).cause).toBeUndefined();
  });
  it('refuses IDs that are not plain', () => {
    expect(sqlLinkIds(['a', 'B-_9'])).toBe("'a', 'B-_9'");
    for (const bad of ["a'", 'a b', '', 'a\n', 'a'.repeat(65), 'a\\', 'é']) expect(() => sqlLinkIds(['ok', bad])).toThrow(AnalyticsError);
    expect(() => sqlLinkIds([])).toThrow();
  });
  it('reads numbers and numeric strings only', () => {
    expect(toNumber('12')).toBe(12);
    expect(toNumber(3.5)).toBe(3.5);
    for (const bad of ['', ' ', 'x', null, undefined, NaN, {}]) expect(() => toNumber(bad)).toThrow(AnalyticsError);
    expect(sqlTime(new Date('2026-11-01T00:00:00Z'))).toBe("toDateTime('2026-11-01 00:00:00')");
  });
});

describe('metrics', () => {
  it('needs the metrics:read scope and does not query without it', async () => {
    const f = mockAe([], []);
    expect((await get(env, null)).status).toBe(401);
    expect((await get(env, { ...metricsAuth, scopes: ['links'] })).status).toBe(403);
    expect(f).not.toHaveBeenCalled();
  });

  it('renders totals, links and gauges', async () => {
    await base.DB.prepare("INSERT INTO users (id, issuer, subject, created_at) VALUES ('mu', 'i', 'mu', 0)").run();
    await base.DB.prepare("INSERT INTO links (id, domain, slug, destination, owner_id, created_at, updated_at) VALUES ('ml', 'go.example', 'abc', 'https://example.com/', 'mu', 0, 0)").run();
    const f = mockAe(
      [{ domain: 'go.example', outcome: 'ok', clicks: '10', bots: '3', max_interval: '1', links: '1' },
        { domain: 'old.example', outcome: 'root', clicks: 2, bots: 0, max_interval: 1, links: 1 }],
      [{ link_id: 'ml', domain: 'go.example', slug: 'abc', clicks: '10', bots: 3, max_interval: 1 }],
    );
    const res = await get(env);
    expect(res.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    const text = await res.text();
    const lines = text.split('\n');
    for (const l of [
      'curt_clicks_total{domain="go.example",outcome="ok",bot="0"} 7',
      'curt_clicks_total{domain="go.example",outcome="ok",bot="1"} 3',
      'curt_clicks_total{domain="go.example",outcome="expired",bot="0"} 0',
      'curt_clicks_total{domain="s.example",outcome="ok",bot="1"} 0',
      'curt_clicks_total{domain="old.example",outcome="root",bot="0"} 2',
      'curt_link_clicks_total{domain="go.example",slug="abc",link_id="ml",bot="0"} 7',
      'curt_link_clicks_total{domain="go.example",slug="abc",link_id="ml",bot="1"} 3',
      'curt_links_omitted 0', 'curt_metrics_sampled 0',
      'curt_links{domain="go.example"} 1', 'curt_links{domain="s.example"} 0',
    ]) expect(lines).toContain(l);
    for (const m of ['curt_clicks_total', 'curt_link_clicks_total', 'curt_links_omitted', 'curt_metrics_sampled', 'curt_links']) {
      expect(text.match(new RegExp(`^# HELP ${m} `, 'gm'))).toHaveLength(1);
      expect(text.match(new RegExp(`^# TYPE ${m} (counter|gauge)$`, 'gm'))).toHaveLength(1);
    }
    expect(text.endsWith('\n')).toBe(true);
    const series = lines.filter((l) => l && !l.startsWith('#')).map((l) => l.slice(0, l.lastIndexOf(' ')));
    expect(new Set(series).size).toBe(series.length);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('counts weighted clicks from the start of the UTC month and caps only links', async () => {
    mockAe([], []);
    await get(freshEnv({ METRICS_MAX_LINKS: '7' }));
    const links = sql.find((q) => q.includes('AS slug'))!;
    const totals = sql.find((q) => !q.includes('AS slug'))!;
    for (const q of sql) {
      expect(q).toContain('SUM(_sample_interval * double1)');
      expect(q).toContain("timestamp >= toDateTime('2026-11-01 00:00:00')");
    }
    expect(links).toContain('ORDER BY clicks DESC LIMIT 7');
    expect(totals).not.toContain('LIMIT');
  });

  it('keeps at most the cap and counts what it leaves out', async () => {
    const totals = [
      { domain: 'go.example', outcome: 'ok', clicks: 50, bots: 0, max_interval: 1, links: 4 },
      { domain: 's.example', outcome: 'ok', clicks: 9, bots: 0, max_interval: 1, links: '3' },
      { domain: 's.example', outcome: 'not_found', clicks: 5, bots: 0, max_interval: 1, links: 1 },
    ];
    const rows = ['a', 'b', 'c'].map((id, i) => ({ link_id: id, domain: 'go.example', slug: id, clicks: 9 - i, bots: 0, max_interval: 1 }));
    mockAe(totals, rows);
    const text = await (await get(freshEnv({ METRICS_MAX_LINKS: '2' }))).text();
    expect(text).toContain('curt_links_omitted 5\n');
    expect(text).not.toContain('link_id="c"');
    expect(text).toContain('curt_clicks_total{domain="go.example",outcome="ok",bot="0"} 50\n');
    expect(text).toContain('curt_clicks_total{domain="s.example",outcome="ok",bot="0"} 9\n');
  });

  it('with a cap of zero skips the link query', async () => {
    const f = mockAe([{ domain: 'go.example', outcome: 'ok', clicks: 5, bots: 0, max_interval: 1, links: 2 }], []);
    const text = await (await get(freshEnv({ METRICS_MAX_LINKS: '0' }))).text();
    expect(f).toHaveBeenCalledTimes(1);
    expect(text).toContain('curt_links_omitted 2\n');
  });

  it('reports sampling from either query', async () => {
    mockAe([], [{ link_id: 'a', domain: 'go.example', slug: 'a', clicks: 20, bots: 0, max_interval: '10' }]);
    expect(await (await get(env)).text()).toContain('curt_metrics_sampled 1\n');
    vi.restoreAllMocks();
    mockAe([{ domain: 'go.example', outcome: 'root', clicks: 20, bots: 0, max_interval: 2, links: 1 }], []);
    expect(await (await get(freshEnv())).text()).toContain('curt_metrics_sampled 1\n');
  });

  it('escapes label values', async () => {
    expect(escapeLabel('a\\b"c\nd')).toBe('a\\\\b\\"c\\nd');
    mockAe([], [{ link_id: 'a', domain: 'go.example', slug: 'x"}\n\\evil 1', clicks: 1, bots: 0, max_interval: 1 }]);
    expect(await (await get(env)).text()).toContain('slug="x\\"}\\n\\\\evil 1",link_id="a",bot="0"} 1\n');
  });

  it('parses the cap', () => {
    expect([maxLinks('5'), maxLinks('0'), maxLinks('x'), maxLinks(''), maxLinks('-1'), maxLinks('99999')]).toEqual([5, 0, 1000, 1000, 1000, 10000]);
  });

  it('returns 503, uncached, when Analytics Engine fails, and logs no token', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('test-only', { status: 500 }));
    const res = await get(env);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('curt_clicks_total');
    expect(JSON.stringify(log.mock.calls)).not.toContain('test-only');
    vi.restoreAllMocks();
    mockAe([], []);
    expect((await get(env)).status).toBe(200);
  });

  it('returns 503 when one query fails or a value is malformed', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) =>
      String(init?.body).includes('AS slug') ? new Response('', { status: 429 }) : Response.json({ data: [] }));
    expect((await get(env)).status).toBe(503);
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockAe([{ domain: 'go.example', outcome: 'ok', clicks: null, bots: 0, max_interval: 1, links: 1 }], []);
    expect((await get(freshEnv())).status).toBe(503);
  });

  it('serves repeat scrapes from the cache for 60 seconds, after checking access', async () => {
    const put = vi.spyOn(Cache.prototype, 'put');
    const f = mockAe([], []);
    const first = await (await get(env)).text();
    expect(await (await get(env)).text()).toBe(first);
    expect(f).toHaveBeenCalledTimes(2);
    expect((await get(env, null)).status).toBe(401);
    expect(put.mock.calls.map(([, r]) => r.headers.get('cache-control')).sort()).toEqual(['max-age=60', 'max-age=900']);
  });
});

describe('metrics access', () => {
  it('refuses a member, by session or by token, without querying', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    for (const via of ['session', 'token'] as const) {
      const r = await get(freshEnv(), { userId: 'u2', isAdmin: false, via, scopes: ['links', 'metrics:read'] });
      expect(r.status).toBe(403);
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
