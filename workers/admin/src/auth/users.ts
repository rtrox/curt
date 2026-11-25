import { Hono } from 'hono';
import { ApiError } from '../lib/errors.ts';
import type { AppEnv, Auth } from '../types.ts';
import { nowSeconds } from './crypto.ts';
import { requireSession } from './middleware.ts';

/** Mounted at /api/v1/users. Owned by the sign-in task. */
export const userRoutes = new Hono<AppEnv>();

function requireAdminSession(auth: Auth | null): Auth {
  const a = requireSession(auth);
  if (!a.isAdmin) throw new ApiError(403, 'forbidden', 'Only an admin may do this.');
  return a;
}

userRoutes.use('*', async (c, next) => {
  requireAdminSession(c.var.auth);
  await next();
  c.res.headers.set('cache-control', 'no-store');
});

userRoutes.get('/', async (c) => {
  const now = nowSeconds();
  const { results } = await c.env.DB.prepare(`SELECT u.id, u.name, u.email, u.is_admin,
      coalesce(s.n, 0) AS activeSessions, coalesce(t.n, 0) AS activeTokens
    FROM users u
    LEFT JOIN (SELECT user_id, count(*) AS n FROM sessions WHERE expires_at > ? GROUP BY user_id) s ON s.user_id = u.id
    LEFT JOIN (SELECT user_id, count(*) AS n FROM api_tokens
      WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) GROUP BY user_id) t ON t.user_id = u.id
    ORDER BY coalesce(u.name, u.email, u.id) COLLATE NOCASE, u.id`)
    .bind(now, now)
    .all<{ id: string; name: string | null; email: string | null; is_admin: number; activeSessions: number; activeTokens: number }>();
  return c.json({ users: results.map(({ is_admin, ...u }) => ({ ...u, isAdmin: is_admin === 1 })) });
});

/** Ends a person's access here at once, including sign-ins already under way. Whether a fresh sign-in works is decided in the provider. */
userRoutes.post('/:id/cutoff', async (c) => {
  const admin = requireAdminSession(c.var.auth);
  const target = c.req.param('id');
  if (target === admin.userId) throw new ApiError(409, 'cannot_cut_off_self', 'You cannot cut off your own access.');
  const db = c.env.DB;
  if (!(await db.prepare('SELECT 1 FROM users WHERE id = ?').bind(target).first())) throw new ApiError(404, 'not_found', 'No such person.');
  const now = nowSeconds();
  // cutoff_at never moves back, and uses the database's time too in case this batch was slow to start.
  const [sessions, tokens] = await db.batch([
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target),
    db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(now, target),
    db.prepare('UPDATE users SET is_admin = 0, cutoff_at = max(coalesce(cutoff_at, 0), ?, unixepoch()) WHERE id = ?').bind(now, target),
    db.prepare("INSERT INTO audit (id, at, user_id, action, link_id, detail) VALUES (?, ?, ?, 'user.cutoff', NULL, ?)")
      .bind(crypto.randomUUID(), now, admin.userId, target),
  ]);
  return c.json({ sessionsEnded: sessions?.meta.changes ?? 0, tokensRevoked: tokens?.meta.changes ?? 0 });
});
