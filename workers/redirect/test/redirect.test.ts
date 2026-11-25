import { expect, describe, it, vi, beforeEach } from 'vitest';
import { linkKey } from '@curt/shared';
import { brokenD1, brokenKv, d1Put, kvPut, now, setup } from './helpers.ts';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const location = (r: Response) => r.headers.get('Location');

describe('redirects', () => {
  it('redirects from KV without touching D1', async () => {
    await kvPut('go.example', 'kvhit');
    const t = setup();
    const r = await t.send('https://go.example/kvhit');
    expect(r.status).toBe(302);
    expect(location(r)).toBe('https://example.com/kv');
    expect(r.headers.get('Cache-Control')).toBe('private, no-store');
    expect(t.calls.d1).toBe(0);
  });

  it('matches any case, a trailing slash and percent-encoding, and drops the query', async () => {
    await kvPut('go.example', 'mixed', { destination: 'https://example.com/x?a=1' });
    const t = setup();
    for (const url of ['https://go.example/MiXeD', 'https://GO.EXAMPLE/mixed/', 'https://go.example/%6Dixed', 'https://go.example/mixed?b=2&c=3', 'https://go.example./mixed']) {
      const r = await t.send(url);
      expect([r.status, location(r)], url).toEqual([302, 'https://example.com/x?a=1']);
    }
  });

  it('keeps the same slug apart on different domains', async () => {
    await kvPut('go.example', 'both', { destination: 'https://example.com/go' });
    await kvPut('s.example', 'both', { destination: 'https://example.com/s' });
    const t = setup();
    expect(location(await t.send('https://go.example/both'))).toBe('https://example.com/go');
    expect(location(await t.send('https://s.example/both'))).toBe('https://example.com/s');
  });

  it('redirects a bare domain to its own root page', async () => {
    const t = setup();
    const a = await t.send('https://go.example/');
    const b = await t.send('https://s.example');
    expect([a.status, location(a)]).toEqual([302, 'https://example.com/home']);
    expect(location(b)).toBe('https://example.com/s');
    expect(a.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('answers HEAD like GET without a body', async () => {
    await kvPut('go.example', 'head');
    const t = setup();
    const r = await t.send('https://go.example/head', { method: 'HEAD' });
    expect([r.status, location(r)]).toEqual([302, 'https://example.com/kv']);
    const missing = await t.send('https://go.example/head-missing', { method: 'HEAD' });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('');
  });

  it('refuses other methods', async () => {
    const t = setup();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const r = await t.send('https://go.example/x', { method });
      expect([r.status, r.headers.get('Allow')]).toEqual([405, 'GET, HEAD']);
    }
    expect(t.calls.kvGet).toEqual([]);
  });

  it('returns 404 for a host that is not configured', async () => {
    const t = setup();
    for (const host of ['other.example', 'sub.go.example', 'app.go.example']) {
      expect((await t.send(`https://${host}/`)).status).toBe(404);
    }
    expect(t.calls.kvGet).toEqual([]);
    expect(t.points).toEqual([]);
  });

  it('never forwards a destination that is not http or https', async () => {
    await kvPut('go.example', 'js', { destination: 'javascript:alert(1)' });
    await d1Put('go.example', 'js2', { destination: 'not a url' });
    const t = setup();
    for (const slug of ['js', 'js2']) expect((await t.send(`https://go.example/${slug}`)).status).toBe(404);
  });
});

describe('malformed and reserved paths', () => {
  it('returns 404 without throwing or reading storage', async () => {
    const t = setup();
    const paths = ['%', '%E0%A4%A', '%00', '%2F', '%2e%2e%2fetc', 'a/b', '/', '/abc', 'caf%C3%A9', '-x', 'a'.repeat(3000), '%F0%9F%98%80', '<script>'];
    for (const path of paths) expect((await t.send(`https://go.example/${path}`)).status, path).toBe(404);
    expect(t.calls.kvGet).toEqual([]);
    expect(t.calls.d1).toBe(0);
  });

  it('serves reserved paths without reading storage', async () => {
    const t = setup({ VISITOR_MODE: 'hash' });
    const robots = await t.send('https://go.example/robots.txt');
    expect(robots.status).toBe(200);
    expect(await robots.text()).toBe('User-agent: *\nDisallow: /\n');
    expect((await t.send('https://go.example/ROBOTS.TXT')).status).toBe(200);
    expect((await t.send('https://go.example/favicon.ico')).status).toBe(204);
    for (const path of ['.well-known', '.well-known/', '.well-known/security.txt', '.WELL-KNOWN/a/b', '%2Ewell-known/x']) {
      expect((await t.send(`https://go.example/${path}`)).status, path).toBe(404);
    }
    expect(t.calls.kvGet).toEqual([]);
    expect(t.calls.d1).toBe(0);
    expect(t.points).toEqual([]);
  });
});

describe('storage fallbacks', () => {
  it('reads D1 from the primary on a KV miss, and never writes KV', async () => {
    await d1Put('go.example', 'd1only');
    const t = setup();
    const r = await t.send('https://go.example/D1only');
    expect([r.status, location(r)]).toEqual([302, 'https://example.com/d1']);
    expect(t.calls.sessions).toEqual(['first-primary']);
    expect(t.calls.kvPut).toBe(0);
    expect(await t.real.LINKS.get(linkKey('go.example', 'd1only'))).toBeNull();
  });

  it('looks up D1 by domain as well as slug', async () => {
    await d1Put('s.example', 'scoped');
    const t = setup();
    expect((await t.send('https://go.example/scoped')).status).toBe(404);
    expect((await t.send('https://s.example/scoped')).status).toBe(302);
  });

  it('works without D1 sessions', async () => {
    await d1Put('go.example', 'nosession');
    const { real } = setup();
    const DB = { prepare: (sql: string) => real.DB.prepare(sql) } as unknown as D1Database;
    expect((await setup({ DB }).send('https://go.example/nosession')).status).toBe(302);
  });

  it('serves a link created after its slug was cached as missing', async () => {
    const t = setup();
    expect((await t.send('https://go.example/later')).status).toBe(404);
    await d1Put('go.example', 'later');
    expect((await t.send('https://go.example/later')).status).toBe(302);
  });

  it('falls back to D1 when KV throws or holds a corrupt value', async () => {
    await d1Put('go.example', 'kvdown');
    expect((await setup({ LINKS: brokenKv }).send('https://go.example/kvdown')).status).toBe(302);
    const t = setup();
    await t.real.LINKS.put(linkKey('go.example', 'kvdown'), '{broken');
    expect((await t.send('https://go.example/kvdown')).status).toBe(302);
  });

  it('still serves KV hits when D1 is down', async () => {
    await kvPut('go.example', 'd1down');
    expect((await setup({ DB: brokenD1 }).send('https://go.example/d1down')).status).toBe(302);
  });

  it('returns 503 with Retry-After when D1 fails, with KV missing or failing', async () => {
    for (const overrides of [{ DB: brokenD1 }, { DB: brokenD1, LINKS: brokenKv }]) {
      const t = setup(overrides);
      const r = await t.send('https://go.example/nowhere');
      expect(r.status).toBe(503);
      expect(Number(r.headers.get('Retry-After'))).toBeGreaterThan(0);
      expect(r.headers.get('Cache-Control')).toBe('private, no-store');
      expect(t.points).toEqual([]);
    }
  });
});

describe('disabled and expired links', () => {
  it('returns 410 from KV and from D1', async () => {
    const past = now() - 5;
    await kvPut('go.example', 'kv-off', { disabled: true });
    await kvPut('go.example', 'kv-old', { expiresAt: past });
    await d1Put('go.example', 'd1-off', { disabled: true });
    await d1Put('go.example', 'd1-old', { expiresAt: past });
    const t = setup();
    for (const slug of ['kv-off', 'kv-old', 'd1-off', 'd1-old']) {
      const r = await t.send(`https://go.example/${slug}`);
      expect([r.status, location(r)], slug).toEqual([410, null]);
      expect(r.headers.get('Cache-Control')).toBe('private, no-store');
    }
    expect(t.points.map((p) => p.blobs[2])).toEqual(['disabled', 'expired', 'disabled', 'expired']);
  });

  it('applies expiry to a stale KV copy at the exact second', async () => {
    const expiresAt = now() + 100;
    await kvPut('go.example', 'timed', { expiresAt });
    const t = setup();
    vi.useFakeTimers({ toFake: ['Date'], now: expiresAt * 1000 - 1 });
    try {
      expect((await t.send('https://go.example/timed')).status).toBe(302);
      vi.setSystemTime(expiresAt * 1000);
      expect((await t.send('https://go.example/timed')).status).toBe(410);
      expect(t.calls.d1).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('error pages', () => {
  it('are self-contained, themed and never echo the slug', async () => {
    await kvPut('go.example', 'zzgone', { disabled: true });
    const t = setup();
    for (const path of ['zzmissing', 'zzgone', '%3Cscript%3Ezz%3C/script%3E', 'zzmissing?zzquery']) {
      const r = await t.send(`https://go.example/${path}`);
      const html = await r.text();
      expect(html).not.toContain('zz');
      expect(html).not.toContain('<script');
      expect(html).not.toMatch(/src=|href=|url\(|@import/);
      expect(html).toContain('prefers-color-scheme:dark');
      expect(html).toContain('color-scheme:light dark');
      expect(r.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
      expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
    }
  });

  it('allow exactly their own style in the policy', async () => {
    const r = await setup().send('https://go.example/policy');
    const style = /<style>(.*)<\/style>/s.exec(await r.text())?.[1] ?? '';
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(style)));
    const csp = r.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain(`style-src 'sha256-${btoa(String.fromCharCode(...digest))}'`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('unsafe');
  });
});
