import { SLUG_ALPHABET } from '@curt/shared';
import { availabilitySchema, domainsSchema, exportSchema, linkSchema, listLinksSchema, meSchema, publicConfigSchema, tagListSchema } from '@curt/shared/schemas';
import type { Link } from '@curt/shared/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { admin, ana, ben, call, code, create, env, json, measured, metricsOnly, patch, reset } from './api-helpers.ts';

beforeEach(reset);
afterEach(() => { vi.restoreAllMocks(); });

type Page = { links: Link[]; nextCursor: string | null };
const list = async (auth: typeof ana, query = '') => listLinksSchema.parse(await json(await call(auth, 'GET', `/links${query}`)));
const count = async (sql: string) => (await env.DB.prepare(sql).first<{ n: number }>())!.n;
const soon = () => Math.floor(Date.now() / 1000) + 3600;

describe('access', () => {
  it.each([
    ['GET', '/me'], ['GET', '/domains'], ['GET', '/tags'], ['GET', '/links'], ['POST', '/links'], ['GET', '/links/availability?slug=a'],
    ['GET', '/links/x'], ['PATCH', '/links/x'], ['DELETE', '/links/x'], ['GET', '/links/x/qr'], ['GET', '/export'], ['POST', '/admin/resync'],
  ])('%s %s needs sign-in and the links scope', async (method, path) => {
    const body = method === 'POST' || method === 'PATCH' ? { body: {} } : {};
    expect((await call(null, method, path, body)).status).toBe(401);
    expect((await call(metricsOnly, method, path, body)).status).toBe(403);
  });
  it('serves public config without sign-in', async () => {
    const r = await call(null, 'GET', '/config');
    expect(r.status).toBe(200);
    const body = publicConfigSchema.strict().parse(await json(r));
    expect(body).toMatchObject({ siteName: 'Links', accent: null, oidc: { mode: 'browser', clientId: 'curt' } });
    expect(JSON.stringify(body)).not.toMatch(/cookie-key|test-only/);
  });
  it.each([
    ['links', 'links-admin', 'openid profile email groups'], ['links', '', 'openid profile email groups'],
    ['', 'links-admin', 'openid profile email groups'], ['', '', 'openid profile email'],
  ])('asks for groups only when a group is configured (allowed %j, admin %j)', async (ALLOWED_GROUP, ADMIN_GROUP, scope) => {
    const r = await call(null, 'GET', '/config', { env: { ...env, ALLOWED_GROUP, ADMIN_GROUP } });
    expect(publicConfigSchema.parse(await json(r)).oidc.scope).toBe(scope);
  });
  it('is not cached', async () => expect((await call(ana, 'GET', '/me')).headers.get('cache-control')).toBe('no-store'));
});

describe('ownership', () => {
  it('hides other people’s links', async () => {
    const l = await create(ana, { tags: ['secret'] });
    for (const [method, path, opts] of [
      ['GET', `/links/${l.id}`, {}], ['GET', `/links/${l.id}/qr`, {}], ['DELETE', `/links/${l.id}`, {}],
      ['PATCH', `/links/${l.id}`, { body: { disabled: true }, headers: { 'if-match': '1' } }],
      ['PATCH', `/links/${l.id}`, { body: { expiresAt: 5 }, headers: { 'if-match': '1' } }],
      ['PATCH', `/links/${l.id}`, { body: {}, headers: { 'if-match': '1' } }],
      ['PATCH', `/links/${l.id}`, { body: { tags: ['x'] }, headers: { 'if-match': '9' } }],
    ] as const) expect((await call(ben, method, path, opts)).status, `${method} ${path}`).toBe(404);
    expect((await list(ben)).links).toEqual([]);
    expect((await list(ben, '?tag=secret')).links).toEqual([]);
    expect(await json(await call(ben, 'GET', '/tags'))).toEqual({ tags: [] });
    expect((await json<Page>(await call(ben, 'GET', '/export'))).links).toEqual([]);
    expect(await json(await call(ana, 'GET', `/links/${l.id}`))).toEqual(l);
    expect(await count("SELECT count(*) AS n FROM audit WHERE action <> 'link.create'")).toBe(0);
    expect(await count('SELECT count(*) AS n FROM kv_deletes')).toBe(0);
  });
  it('lets admins see and change everything, and filter by owner', async () => {
    const a = await create(ana);
    await create(ben);
    expect((await list(admin)).links).toHaveLength(2);
    expect((await list(admin, '?owner=u-ana')).links.map((l) => l.id)).toEqual([a.id]);
    expect((await patch(admin, a, 1, { disabled: true })).status).toBe(200);
    expect((await json<Link>(await call(ana, 'GET', `/links/${a.id}`))).owner).toEqual({ id: 'u-ana', name: 'Ana' });
    expect((await call(admin, 'DELETE', `/links/${a.id}`)).status).toBe(204);
  });
  it('refuses the owner filter to members', async () => {
    expect((await call(ana, 'GET', '/links?owner=u-ben')).status).toBe(403);
  });
});

describe('create', () => {
  it('makes a random slug on the first domain', async () => {
    const l = linkSchema.parse(await create(ana));
    expect(l.slug).toMatch(new RegExp(`^[${SLUG_ALPHABET}]{6}$`));
    expect(l).toMatchObject({ domain: 'go.example', shortUrl: `https://go.example/${l.slug}`, version: 1, disabled: false, expiresAt: null, tags: [], owner: { id: 'u-ana', name: 'Ana' } });
  });
  it('accepts every field, normalized', async () => {
    const expiresAt = soon();
    const l = await create(ana, { destination: ' HTTPS://Example.com ', domain: 'S.example', slug: 'Trip', tags: ['Work', 'a', 'work '], expiresAt });
    expect(l).toMatchObject({ domain: 's.example', slug: 'trip', destination: 'https://example.com/', tags: ['a', 'work'], expiresAt });
    const audit = await env.DB.prepare('SELECT user_id, action, link_id, detail FROM audit').all();
    expect(audit.results).toEqual([{ user_id: 'u-ana', action: 'link.create', link_id: l.id, detail: '["destination","domain","expiresAt","slug","tags"]' }]);
  });
  it.each([
    [{ domain: 'other.example' }, 'unknown_domain'], [{ domain: '' }, 'unknown_domain'],
    [{ destination: 'nope' }, 'invalid_url'], [{ destination: 'javascript:alert(1)' }, 'bad_scheme'],
    [{ destination: 'https://u:p@example.com' }, 'has_credentials'],
    [{ destination: 'https://s.example/x' }, 'own_domain'], [{ destination: 'https://app.go.example' }, 'own_domain'],
    [{ slug: 'a/b' }, 'invalid_slug'], [{ slug: '' }, 'invalid_slug'], [{ slug: 'Robots.txt' }, 'reserved_slug'],
    [{ expiresAt: 5 }, 'expiry_in_past'], [{ surprise: 1 }, 'invalid_request'], [{ tags: ['<b>'] }, 'invalid_request'],
  ])('rejects %j', async (body, expected) => {
    const r = await call(ana, 'POST', '/links', { body: { destination: 'https://example.com', ...body } });
    expect(r.status).toBe(400);
    expect(await code(r)).toBe(expected);
    expect(await count('SELECT count(*) AS n FROM links')).toBe(0);
  });
  it('rejects a body that is not JSON', async () => {
    const r = await call(ana, 'POST', '/links');
    expect([r.status, await code(r)]).toEqual([400, 'invalid_request']);
  });
  it('reports a taken slug, in any case and whoever owns it, and leaves nothing behind', async () => {
    await create(ana, { slug: 'trip' });
    const r = await call(ben, 'POST', '/links', { body: { destination: 'https://example.com', slug: 'TRIP', tags: ['x'] } });
    expect([r.status, await code(r)]).toEqual([409, 'slug_taken']);
    expect(await count('SELECT count(*) AS n FROM audit')).toBe(1);
    expect(await count('SELECT count(*) AS n FROM tags')).toBe(0);
    expect((await create(ben, { slug: 'trip', domain: 's.example' })).slug).toBe('trip');
  });
  it('lets exactly one of two simultaneous creates win', async () => {
    const rs = await Promise.all([ana, ben].map((u) => call(u, 'POST', '/links', { body: { destination: 'https://example.com', slug: 'trip' } })));
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  function forceSlugs(bytes: number[]) {
    let n = 0;
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((b) => {
      (b as Uint8Array).fill(bytes[Math.min(n++, bytes.length - 1)]!);
      return b;
    });
    return () => n;
  }
  it('retries a random slug that is taken', async () => {
    await create(ana, { slug: '222222' });
    const calls = forceSlugs([0, 0, 1]);
    expect((await create(ana)).slug).toBe('333333');
    expect(calls()).toBe(3);
  });
  it('gives up after five tries', async () => {
    await create(ana, { slug: '222222' });
    const calls = forceSlugs([0]);
    const r = await call(ana, 'POST', '/links', { body: { destination: 'https://example.com' } });
    expect([r.status, await code(r), calls()]).toEqual([503, 'no_free_slug', 5]);
  });
});

describe('update', () => {
  it('changes fields, replaces tags as a set and records field names only', async () => {
    const l = await create(ana, { tags: ['old', 'keep'] });
    const expiresAt = soon();
    const r = await patch(ana, l, 1, { destination: 'https://example.com/private', tags: ['keep', 'new'], disabled: true, expiresAt });
    expect(r.status).toBe(200);
    const updated = linkSchema.parse(await json(r));
    expect(updated).toMatchObject({ destination: 'https://example.com/private', tags: ['keep', 'new'], disabled: true, expiresAt, version: 2 });
    expect(await json(await call(ana, 'GET', `/links/${l.id}`))).toEqual(updated);
    const audit = await env.DB.prepare("SELECT detail FROM audit WHERE action = 'link.update'").all();
    expect(audit.results).toEqual([{ detail: '["destination","disabled","expiresAt","tags"]' }]);
  });
  it('leaves out what was not sent, and clears with null and []', async () => {
    const expiresAt = soon();
    const l = await create(ana, { tags: ['a'], expiresAt });
    expect(await json(await patch(ana, l, 1, { disabled: true }))).toMatchObject({ tags: ['a'], expiresAt, destination: l.destination });
    expect(await json(await patch(ana, l, '"2"', { tags: [], expiresAt: null }))).toMatchObject({ tags: [], expiresAt: null, version: 3 });
  });
  it('bumps the version for a tags-only change', async () => {
    const l = await create(ana);
    expect(await json(await patch(ana, l, 1, { tags: ['a'] }))).toMatchObject({ tags: ['a'], version: 2 });
  });
  it('requires If-Match', async () => {
    const l = await create(ana);
    const r = await call(ana, 'PATCH', `/links/${l.id}`, { body: { disabled: true } });
    expect([r.status, await code(r)]).toEqual([428, 'version_required']);
    for (const bad of ['*', 'abc', '"1', '-1']) expect((await patch(ana, l, bad, { disabled: true })).status).toBe(400);
  });
  it('rejects a stale version without touching anything', async () => {
    const l = await create(ana, { tags: ['a'] });
    await patch(ana, l, 1, { disabled: true });
    const before = await json(await call(ana, 'GET', `/links/${l.id}`));
    for (const v of [1, 3]) {
      const r = await patch(ana, l, v, { tags: ['b'], destination: 'https://example.com/z' });
      expect([r.status, await code(r)]).toEqual([412, 'version_mismatch']);
    }
    expect(await json(await call(ana, 'GET', `/links/${l.id}`))).toEqual(before);
    expect(await count("SELECT count(*) AS n FROM audit WHERE action = 'link.update'")).toBe(1);
  });
  it('lets exactly one of several simultaneous edits win', async () => {
    const l = await create(ana, { tags: ['start'] });
    const rs = await Promise.all([1, 2, 3, 4].map((n) => patch(ana, l, 1, { tags: [`t${n}`], destination: `https://example.com/${n}` })));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 412, 412, 412]);
    const n = rs.findIndex((r) => r.status === 200) + 1;
    expect(await json(await call(ana, 'GET', `/links/${l.id}`))).toMatchObject({ version: 2, tags: [`t${n}`], destination: `https://example.com/${n}` });
    expect(await count("SELECT count(*) AS n FROM audit WHERE action = 'link.update'")).toBe(1);
  });
  it('treats an empty change as a read that still checks the version', async () => {
    const l = await create(ana);
    expect(await json(await patch(ana, l, 1, {}))).toEqual(l);
    expect((await patch(ana, l, 2, {})).status).toBe(412);
  });
  it('checks new values', async () => {
    const l = await create(ana);
    expect(await code(await patch(ana, l, 1, { destination: 'https://go.example/x' }))).toBe('own_domain');
    expect(await code(await patch(ana, l, 1, { expiresAt: 5 }))).toBe('expiry_in_past');
    expect(await code(await patch(ana, l, 1, { slug: 'new' }))).toBe('invalid_request');
  });
  it('accepts the unchanged expiry of an expired link', async () => {
    const l = await create(ana);
    await env.DB.prepare('UPDATE links SET expires_at = 5').run();
    expect((await patch(ana, l, 1, { expiresAt: 5, tags: ['a'] })).status).toBe(200);
    expect((await patch(ana, l, 2, { expiresAt: 6 })).status).toBe(400);
  });
});

describe('delete', () => {
  it('removes the link and its tags, records it and frees the slug', async () => {
    const l = await create(ana, { slug: 'trip', tags: ['a'] });
    expect((await call(ana, 'DELETE', `/links/${l.id}`)).status).toBe(204);
    expect((await call(ana, 'GET', `/links/${l.id}`)).status).toBe(404);
    expect((await call(ben, 'DELETE', `/links/${l.id}`)).status).toBe(404);
    expect(await count('SELECT count(*) AS n FROM tags')).toBe(0);
    expect(await count("SELECT count(*) AS n FROM audit WHERE action = 'link.delete' AND detail IS NULL")).toBe(1);
    const again = await create(ben, { slug: 'trip' });
    expect(again.id).not.toBe(l.id);
  });
});

describe('list and search', () => {
  it('pages through everything once, newest first, even within one second', async () => {
    for (let i = 0; i < 7; i++) await create(ana, { slug: `s${i}` });
    await env.DB.prepare("UPDATE links SET created_at = CASE WHEN slug < 's4' THEN 100 ELSE 200 END").run();
    const seen: Link[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Page = await list(ana, `?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...page.links);
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(4);
    expect(new Set(seen.map((l) => l.id)).size).toBe(7);
    expect(seen.map((l) => l.createdAt)).toEqual([200, 200, 200, 100, 100, 100, 100]);
  });
  it('has no next page when the last one is exactly full', async () => {
    await create(ana); await create(ana);
    expect((await list(ana, '?limit=2')).nextCursor).toBeNull();
  });
  it.each(['%21', 'AAAA', 'bDox', btoa("l:1:x' OR 1=1--").replaceAll('=', ''), btoa('r:abc').replaceAll('=', '')])('rejects cursor %s', async (cursor) => {
    const r = await call(ana, 'GET', `/links?cursor=${encodeURIComponent(decodeURIComponent(cursor))}`);
    expect([r.status, await code(r)]).toEqual([400, 'invalid_cursor']);
  });
  it.each(['limit=0', 'limit=101', 'limit=x', `q=${'x'.repeat(201)}`])('rejects %s', async (q) => {
    expect((await call(ana, 'GET', `/links?${q}`)).status).toBe(400);
  });
  it('a member’s cursor never reaches other people’s links', async () => {
    await create(ana); await create(ben); await create(ana);
    const first = await list(admin, '?limit=1');
    expect((await list(ben, `?cursor=${first.nextCursor}`)).links.every((l) => l.owner.id === 'u-ben')).toBe(true);
  });
  it('finds by slug, destination and tag, ignoring case', async () => {
    await create(ana, { slug: 'alpha' });
    await create(ana, { slug: 'b1', destination: 'https://example.com/Alphabet' });
    await create(ana, { slug: 'c1', tags: ['alphas'] });
    await create(ana, { slug: 'd1' });
    expect((await list(ana, '?q=ALPHA')).links.map((l) => l.slug).sort()).toEqual(['alpha', 'b1', 'c1']);
    expect((await list(ana, '?q=%20')).links).toHaveLength(4);
  });
  it('takes %, _ and backslash literally', async () => {
    await create(ana, { slug: 'a_b' });
    await create(ana, { slug: 'axb', destination: 'https://example.com/50%25' });
    await create(ana, { slug: 'plain' });
    const slugs = async (q: string) => (await list(ana, `?q=${encodeURIComponent(q)}`)).links.map((l) => l.slug);
    expect(await slugs('a_b')).toEqual(['a_b']);
    expect(await slugs('%')).toEqual(['axb']);
    expect(await slugs('\\')).toEqual([]);
    expect(await slugs("' OR 1=1 --")).toEqual([]);
  });
  it('accepts a search as long as the schema allows', async () => {
    const path = 'p'.repeat(170);
    await create(ana, { destination: `https://example.com/${path}` });
    expect((await list(ana, `?q=${path}`)).links).toHaveLength(1);
  });
  it('filters by exact slug, in any case, within ownership and domain', async () => {
    const a = await create(ana, { slug: 'trip' });
    const b = await create(ben, { slug: 'trip', domain: 's.example' });
    await create(ana, { slug: 'trip-2', tags: ['trip'], destination: 'https://example.com/trip' });
    const found = async (auth: typeof ana, query: string) => (await list(auth, `?${query}`)).links.map((l) => l.id).sort();
    expect(await found(ana, 'slug=TRIP')).toEqual([a.id]);
    expect(await found(ana, 'slug=trip&domain=go.example')).toEqual([a.id]);
    expect(await found(ana, 'slug=trip&domain=s.example')).toEqual([]);
    expect(await found(admin, 'slug=trip')).toEqual([a.id, b.id].sort());
    expect(await found(admin, 'slug=trip&domain=S.example')).toEqual([b.id]);
    expect(await found(admin, 'slug=trip&owner=u-ana')).toEqual([a.id]);
    expect(await found(ana, 'slug=tri')).toEqual([]);
    expect(await found(ana, 'slug=tri_')).toEqual([]);
    expect(await found(ana, 'slug=trip&q=nothing')).toEqual([]);
  });
  it.each([['member', ana], ['admin', admin]])('looks up slugs by index for a %s', async (_, auth) => {
    for (const [query, index] of [
      ['slug=trip&domain=go.example', /SEARCH l USING INDEX \S+ \(domain=\? AND slug=\?\)/],
      ['slug=trip', /SEARCH l USING INDEX links_slug \(slug=\?\)/],
      ...(auth.isAdmin ? [['slug=trip&owner=u-ana', /SEARCH l USING INDEX links_slug \(slug=\?\)/] as const] : []),
    ] as const) {
      const e = measured();
      expect((await call(auth, 'GET', `/links?${query}`, { env: e })).status).toBe(200);
      expect(e.plans.join('\n'), query).toMatch(index);
    }
  });
  it('filters by tag and domain', async () => {
    const a = await create(ana, { tags: ['work'] });
    const b = await create(ana, { tags: ['work', 'workshop'], domain: 's.example' });
    expect((await list(ana, '?tag=Workshop')).links.map((l) => l.id)).toEqual([b.id]);
    expect((await list(ana, '?tag=work&domain=GO.example')).links.map((l) => l.id)).toEqual([a.id]);
    expect((await list(ana, '?domain=none.example')).links).toEqual([]);
  });
});

describe('lookups', () => {
  it('checks availability', async () => {
    await create(ana, { slug: 'trip' });
    const check = async (q: string) => availabilitySchema.parse(await json(await call(ben, 'GET', `/links/availability?${q}`)));
    expect(await check('slug=free')).toEqual({ available: true, reason: null });
    expect(await check('slug=TRIP')).toEqual({ available: false, reason: 'taken' });
    expect(await check('slug=trip&domain=s.example')).toEqual({ available: true, reason: null });
    expect(await check('slug=robots.txt')).toEqual({ available: false, reason: 'reserved' });
    expect(await check('slug=a/b')).toEqual({ available: false, reason: 'invalid' });
    expect(await check('slug=')).toEqual({ available: false, reason: 'invalid' });
    expect((await call(ben, 'GET', '/links/availability')).status).toBe(400);
    expect((await call(ben, 'GET', `/links/availability?slug=${'x'.repeat(65)}`)).status).toBe(400);
    expect((await call(ben, 'GET', '/links/availability?slug=a&domain=x.example')).status).toBe(400);
  });
  it('returns me, domains and tags', async () => {
    expect(meSchema.strict().parse(await json(await call(ana, 'GET', '/me')))).toEqual({ id: 'u-ana', name: 'Ana', email: 'ana@example.com', isAdmin: false });
    expect(domainsSchema.parse(await json(await call(ana, 'GET', '/domains')))).toEqual({ domains: [{ host: 'go.example' }, { host: 's.example' }] });
    await create(ana, { tags: ['b', 'a'] });
    await create(ana, { tags: ['b'] });
    await create(ben, { tags: ['b'] });
    expect(tagListSchema.parse(await json(await call(ana, 'GET', '/tags')))).toEqual({ tags: [{ tag: 'a', count: 1 }, { tag: 'b', count: 2 }] });
    expect(await json(await call(admin, 'GET', '/tags'))).toEqual({ tags: [{ tag: 'a', count: 1 }, { tag: 'b', count: 3 }] });
  });
  it('draws a QR code', async () => {
    const l = await create(ana);
    const r = await call(ana, 'GET', `/links/${l.id}/qr`);
    expect(r.headers.get('content-type')).toContain('image/svg+xml');
    const svg = await r.text();
    expect(svg).toMatch(/^<svg [^>]*viewBox/);
    expect(svg).toContain('<path');
    expect(svg).not.toContain('<script');
  });
  const seed = async (n: number) => env.DB.prepare(
    `INSERT INTO links (id, domain, slug, destination, owner_id, created_at, updated_at)
     WITH RECURSIVE i(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM i WHERE n < ?)
     SELECT 'id-' || n, 'go.example', 'x' || n, 'https://example.com/', 'u-ana', 5, 5 FROM i`,
  ).bind(n).run();
  it('exports at most 500 links at a time, members their own and admins all', async () => {
    await seed(1201);
    await create(ben);
    const everything = async (auth: typeof ana) => {
      const sizes: number[] = [];
      const ids = new Set<string>();
      let cursor: string | null = null;
      do {
        const r = await call(auth, 'GET', `/export${cursor ? `?cursor=${cursor}` : ''}`);
        expect(r.headers.get('cache-control')).toBe('no-store');
        const page: Page = exportSchema.strict().parse(await json(r));
        sizes.push(page.links.length);
        page.links.forEach((l) => ids.add(l.id));
        cursor = page.nextCursor;
      } while (cursor && sizes.length < 9);
      return [sizes, ids.size];
    };
    expect(await everything(ana)).toEqual([[500, 500, 201], 1201]);
    expect(await everything(admin)).toEqual([[500, 500, 202], 1202]);
    expect(await everything(ben)).toEqual([[1], 1]);
  });
  it('exports nothing as an empty list', async () => {
    expect(await json(await call(ana, 'GET', '/export'))).toEqual({ links: [], nextCursor: null });
  });
  it('exports exactly 500 without a cursor', async () => {
    await seed(500);
    const page = await json<Page>(await call(ana, 'GET', '/export'));
    expect([page.links.length, page.nextCursor]).toEqual([500, null]);
  });
});

describe('reading cost at 10,000 links with two tags each', () => {
  const cost = async (auth: typeof ana, path: string) => {
    const e = measured();
    const r = await call(auth, 'GET', path, { env: e });
    expect(r.status).toBe(200);
    await r.text();
    return e.rows();
  };
  beforeEach(async () => {
    await env.DB.prepare(
      `INSERT INTO links (id, domain, slug, destination, owner_id, created_at, updated_at, kv_version)
       WITH RECURSIVE i(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM i WHERE n < 10000)
       SELECT 'id-' || printf('%05d', n), 'go.example', 'x' || n, 'https://example.com/' || n, 'u-ana', n, n, 1 FROM i`,
    ).run();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO tags SELECT id, 'tag' || (rowid % 50) FROM links"),
      env.DB.prepare("INSERT INTO tags SELECT id, 'other' || (rowid % 30) FROM links"),
    ]);
  });
  it.each([['member', ana], ['admin', admin]])('is bounded for a %s', async (_, auth) => {
    expect(await cost(auth, '/links?q=nomatch')).toBeLessThan(10_500);
    expect(await cost(auth, '/links?slug=x5')).toBeLessThan(20);
    expect(await cost(auth, '/links?slug=nomatch')).toBeLessThan(20);
    expect(await cost(auth, '/tags')).toBeLessThan(auth.isAdmin ? 20_100 : 30_600);
    expect(await cost(auth, '/tags')).toBe(0);
    expect(await cost(auth, '/links?domain=go.example')).toBeLessThan(300);
    expect(await cost(auth, '/links?domain=none.example')).toBeLessThan(10_100);
  });
  it.each([['member', ana], ['admin', admin]])('searches stay bounded for a %s when every tag is different', async (_, auth) => {
    await env.DB.prepare("UPDATE tags SET tag = 't' || rowid").run();
    expect(await cost(auth, '/links?q=nomatch')).toBeLessThan(34_000);
    expect((await list(auth, '?q=t19999')).links).toHaveLength(1);
  });
  it('is small for a member with few links', async () => {
    await create(ben, { tags: ['a', 'b'] });
    expect(await cost(ben, '/tags')).toBeLessThan(30);
  });
  it('counts the same whichever way it reads', async () => {
    expect(await json(await call(ana, 'GET', '/tags'))).toEqual(await json(await call(admin, 'GET', '/tags')));
  });
});

describe('tag cache', () => {
  const tags = async (auth: typeof ana) => (await json<{ tags: { tag: string }[] }>(await call(auth, 'GET', '/tags'))).tags.map((t) => t.tag);
  it('shows people their own changes at once', async () => {
    const l = await create(ana, { tags: ['a'] });
    expect(await tags(ana)).toEqual(['a']);
    await patch(ana, l, 1, { tags: ['b'] });
    expect(await tags(ana)).toEqual(['b']);
    const m = await create(ana, { tags: ['c'] });
    expect(await tags(ana)).toEqual(['b', 'c']);
    await call(ana, 'DELETE', `/links/${m.id}`);
    expect(await tags(ana)).toEqual(['b']);
  });
  it('is kept apart by person and by role', async () => {
    await create(ana, { tags: ['a'] });
    expect(await tags(admin)).toEqual(['a']);
    expect(await tags(ben)).toEqual([]);
    expect(await tags({ ...admin, isAdmin: false })).toEqual([]);
  });
});
