import { env, exports } from 'cloudflare:workers';
import { expect, it } from 'vitest';

const call = (path: string, init?: RequestInit, host = 'app.go.example') => (exports as unknown as { default: Fetcher }).default.fetch(new Request(`https://${host}${path}`, init));

it('applies migrations', async () => {
  const r = await (env as unknown as { DB: D1Database }).DB.prepare('SELECT count(*) AS n FROM links').first<{ n: number }>();
  expect(r?.n).toBe(0);
});
it('only answers on the admin host', async () => expect((await call('/api/v1/nope', {}, 'go.example')).status).toBe(404));
it('returns JSON errors', async () => {
  const r = await call('/api/v1/nope');
  expect(r.status).toBe(404);
  expect(await r.json()).toEqual({ error: { code: 'not_found', message: 'No such endpoint.' } });
  expect(r.headers.get('x-content-type-options')).toBe('nosniff');
});
it('rejects cross-site writes', async () => {
  const r = await call('/api/v1/links', { method: 'POST', headers: { origin: 'https://evil.example' } });
  expect(r.status).toBe(403);
});
