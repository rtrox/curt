import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saltKey } from '@curt/shared';
import { referrerHost } from '../src/click.ts';
import { brokenKv, d1Put, kvPut, setup } from './helpers.ts';

const IP = '192.0.2.7';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const headers = { 'CF-Connecting-IP': IP, 'User-Agent': UA };
const visitor = (t: ReturnType<typeof setup>) => t.points.map((p) => p.blobs[7]);

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('click points', () => {
  it('records every field', async () => {
    await kvPut('go.example', 'full', { id: 'link-1' });
    const t = setup();
    await t.send('https://go.example/FULL', {
      headers: { ...headers, Referer: 'https://user:pw@News.example.com:8443/path?q=secret' },
      cf: { country: 'NL' } as IncomingRequestCfProperties,
    });
    expect(t.points).toEqual([
      { indexes: ['link-1'], blobs: ['go.example', 'full', 'ok', 'news.example.com', 'NL', 'desktop', '0', ''], doubles: [1] },
    ]);
  });

  it('records root, unknown, malformed and D1-served requests', async () => {
    await d1Put('go.example', 'fromd1', { id: 'link-2' });
    const t = setup();
    for (const path of ['', 'unknown1', '%', 'fromd1']) await t.send(`https://go.example/${path}`, { headers });
    expect(t.points.map((p) => [p.indexes[0], p.blobs[1], p.blobs[2]])).toEqual([
      ['none', '', 'root'],
      ['none', 'unknown1', 'not_found'],
      ['none', '', 'not_found'],
      ['link-2', 'fromd1', 'ok'],
    ]);
    expect(t.points[0]?.blobs[4]).toBe('');
  });

  it('keeps working when analytics throws or is missing', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await kvPut('go.example', 'aefail');
    const CLICKS = { writeDataPoint: () => { throw new Error(`boom ${IP}`); } } as unknown as AnalyticsEngineDataset;
    for (const broken of [CLICKS, undefined as unknown as AnalyticsEngineDataset]) {
      const r = await setup({ CLICKS: broken }).send('https://go.example/aefail', { headers });
      expect([r.status, r.headers.get('Location')]).toEqual([302, 'https://example.com/kv']);
    }
    const logged = JSON.stringify(logSpy.mock.calls);
    expect(logged).toContain('click_write_failed');
    expect(logged).not.toContain(IP);
  });

  it('reduces the referrer to a host', () => {
    expect(referrerHost(null)).toBe('');
    expect(referrerHost('nonsense')).toBe('');
    expect(referrerHost('about:blank')).toBe('');
    expect(referrerHost('https://EXAMPLE.com/a?b#c')).toBe('example.com');
  });
});

/** Each test uses its own day, because the salt stays in isolate memory for a day. */
async function onDay(day: string, salt: string | null): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(`${day}T12:00:00Z`) });
  if (salt !== null) await setup().real.LINKS.put(saltKey(day), salt);
}

describe('visitor', () => {
  it('is empty when off, and reads no salt', async () => {
    const t = setup({ VISITOR_MODE: 'off' });
    await t.send('https://go.example/', { headers });
    expect(visitor(t)).toEqual(['']);
    expect(t.calls.kvGet).toEqual([]);
  });

  it('is the address when full', async () => {
    const t = setup({ VISITOR_MODE: 'full' });
    await t.send('https://go.example/', { headers });
    await t.send('https://go.example/');
    expect(visitor(t)).toEqual([IP, '']);
  });

  it('is a keyed hash of address and User-Agent, stable within a day', async () => {
    await onDay('2030-01-01', 'salt-a');
    const t = setup({ VISITOR_MODE: 'hash' });
    await t.send('https://go.example/', { headers });
    await t.send('https://go.example/', { headers });
    await t.send('https://go.example/', { headers: { ...headers, 'User-Agent': 'other' } });
    await t.send('https://go.example/', { headers: { ...headers, 'CF-Connecting-IP': '192.0.2.8' } });
    const [a, b, c, d] = visitor(t);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('salt-a'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${IP}\n${UA}`)));
    expect(a).toBe([...mac.subarray(0, 16)].map((x) => x.toString(16).padStart(2, '0')).join(''));
    expect(b).toBe(a);
    expect(new Set([a, c, d]).size).toBe(3);
    expect(t.calls.kvGet.filter((k) => k.startsWith('salt:'))).toEqual(['salt:2030-01-01']);
  });

  it('changes with the UTC day', async () => {
    const t = setup({ VISITOR_MODE: 'hash' });
    await onDay('2030-02-01', 'salt-b');
    await t.send('https://go.example/', { headers });
    await onDay('2030-02-02', 'salt-c');
    await t.send('https://go.example/', { headers });
    const [a, b] = visitor(t);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it('is empty with no salt, and picks the salt up later without reading KV each time', async () => {
    await onDay('2030-03-01', null);
    const t = setup({ VISITOR_MODE: 'hash' });
    await t.send('https://go.example/', { headers });
    await t.send('https://go.example/', { headers });
    expect(t.calls.kvGet).toEqual(['salt:2030-03-01']);
    await t.real.LINKS.put(saltKey('2030-03-01'), 'salt-d');
    vi.setSystemTime(Date.now() + 60_000);
    await t.send('https://go.example/', { headers });
    expect(visitor(t).map((v) => v !== '')).toEqual([false, false, true]);
  });

  it('still records the click when the salt cannot be read', async () => {
    await onDay('2030-04-01', null);
    const t = setup({ VISITOR_MODE: 'hash', LINKS: brokenKv });
    const r = await t.send('https://go.example/', { headers });
    expect(r.status).toBe(302);
    expect(visitor(t)).toEqual(['']);
  });

  it('does not delay the response on a slow salt read', async () => {
    await onDay('2030-05-01', null);
    let release: (v: null) => void = () => {};
    const LINKS = { get: () => new Promise<null>((r) => (release = r)) } as unknown as KVNamespace;
    const t = setup({ VISITOR_MODE: 'hash', LINKS });
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) } as unknown as ExecutionContext;
    const { default: worker } = await import('../src/index.ts');
    const request = new Request('https://go.example/', { headers }) as Request<unknown, IncomingRequestCfProperties>;
    const r = await worker.fetch(request, t.env, ctx);
    expect(r.status).toBe(302);
    expect(t.points).toEqual([]);
    release(null);
    await Promise.all(pending);
    expect(t.points).toHaveLength(1);
  });
});
