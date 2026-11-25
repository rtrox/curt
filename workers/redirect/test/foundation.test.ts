import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

it('applies migrations', async () => {
  const r = await (env as unknown as { DB: D1Database }).DB.prepare('SELECT count(*) AS n FROM links').first<{ n: number }>();
  expect(r?.n).toBe(0);
});
