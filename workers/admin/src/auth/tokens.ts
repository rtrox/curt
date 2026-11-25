import { createTokenSchema, type ApiToken } from '@curt/shared/schemas';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { ApiError } from '../lib/errors.ts';
import type { AppEnv } from '../types.ts';
import { readSessionCookie } from './cookies.ts';
import { nowSeconds, sha256 } from './crypto.ts';
import { requireSession } from './middleware.ts';
import { newApiToken } from './token-format.ts';

/** Mounted at /api/v1/tokens. Owned by the sign-in task. */
export const tokenRoutes = new Hono<AppEnv>();

tokenRoutes.use('*', async (c, next) => {
  requireSession(c.var.auth);
  await next();
  c.res.headers.set('cache-control', 'no-store');
});

tokenRoutes.get('/', async (c) => {
  const { userId } = requireSession(c.var.auth);
  const { results } = await c.env.DB.prepare(`SELECT id, name, scope, expires_at AS expiresAt, last_used_day AS lastUsedDay
    FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY rowid DESC`).bind(userId).all<ApiToken>();
  return c.json({ tokens: results });
});

const tooLarge = () => { throw new ApiError(413, 'too_large', 'The request is too large.'); };

tokenRoutes.post('/', bodyLimit({ maxSize: 4096, onError: tooLarge }), async (c) => {
  const auth = requireSession(c.var.auth);
  const parsed = createTokenSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError(400, 'invalid_request', 'Give the token a name of up to 64 characters, a scope, and optionally an expiry.');
  const { name, scope } = parsed.data;
  const expiresAt = parsed.data.expiresAt ?? null;
  if (expiresAt !== null && expiresAt <= nowSeconds()) throw new ApiError(400, 'invalid_request', 'The expiry must be in the future.');
  if (scope === 'metrics:read' && !auth.isAdmin) throw new ApiError(403, 'forbidden', 'Only an admin may create a metrics token, because metrics name every link.');
  const id = crypto.randomUUID();
  const token = newApiToken();
  // The session is checked again inside the insert, so a cutoff that lands mid-request cannot leave a new token behind.
  const { meta } = await c.env.DB.prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, scope, expires_at)
    SELECT ?, s.user_id, ?, ?, ?, ? FROM sessions s WHERE s.id_hash = ? AND s.user_id = ?`)
    .bind(id, name, await sha256(token), scope, expiresAt, await sha256(readSessionCookie(c) ?? ''), auth.userId).run();
  if (meta.changes === 0) throw new ApiError(401, 'unauthenticated', 'Sign in to do this.');
  return c.json({ id, name, scope, expiresAt, lastUsedDay: null, token }, 201);
});

tokenRoutes.delete('/:id', async (c) => {
  const { userId } = requireSession(c.var.auth);
  const { meta } = await c.env.DB.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .bind(nowSeconds(), c.req.param('id'), userId).run();
  if (meta.changes === 0) throw new ApiError(404, 'not_found', 'No such token.');
  return c.body(null, 204);
});
