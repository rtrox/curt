import type { Context, MiddlewareHandler } from 'hono';
import { ApiError } from '../lib/errors.ts';
import type { AppEnv, Auth } from '../types.ts';
import { readSessionCookie } from './cookies.ts';
import { nowSeconds, sha256 } from './crypto.ts';
import { TOKEN_PATTERN } from './token-format.ts';

type C = Context<AppEnv>;

/** CONTRACT (owned by the sign-in task): resolves a session cookie or bearer token into c.var.auth, or null. */
export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('auth', null);
  const header = c.req.header('authorization');
  // A bearer token takes precedence, and a bad one never falls back to the cookie.
  const isBearer = header !== undefined && /^bearer(\s|$)/i.test(header);
  c.set('auth', isBearer ? await fromToken(c, header.slice(6).trim()) : await fromSession(c));
  await next();
};

async function fromSession(c: C): Promise<Auth | null> {
  const id = readSessionCookie(c);
  if (!id) return null;
  const row = await c.env.DB.prepare('SELECT u.id, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND s.expires_at > ?')
    .bind(await sha256(id), nowSeconds()).first<{ id: string; is_admin: number }>();
  if (!row) return null;
  const isAdmin = row.is_admin === 1;
  // Metrics name every link, so a member's session does not carry that scope.
  return { userId: row.id, isAdmin, via: 'session', scopes: isAdmin ? ['links', 'metrics:read'] : ['links'] };
}

async function fromToken(c: C, token: string): Promise<Auth> {
  const row = TOKEN_PATTERN.test(token)
    ? await c.env.DB.prepare(`SELECT t.id, t.scope, t.last_used_day, u.id AS user_id, u.is_admin FROM api_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > ?)`)
      .bind(await sha256(token), nowSeconds())
      .first<{ id: string; scope: string; last_used_day: string | null; user_id: string; is_admin: number }>()
    : null;
  if (!row || (row.scope !== 'links' && row.scope !== 'metrics:read')) {
    c.header('www-authenticate', 'Bearer');
    throw new ApiError(401, 'invalid_token', 'This API token is not valid.');
  }
  const isAdmin = row.is_admin === 1;
  if (row.scope === 'metrics:read' && !isAdmin) throw new ApiError(403, 'forbidden', 'The owner of this token is no longer an admin.');

  const today = new Date().toISOString().slice(0, 10);
  if (row.last_used_day !== today) {
    c.executionCtx.waitUntil(
      c.env.DB.prepare('UPDATE api_tokens SET last_used_day = ? WHERE id = ?').bind(today, row.id).run()
        .catch(() => console.error('could not record token use')),
    );
  }
  return { userId: row.user_id, isAdmin, via: 'token', scopes: [row.scope] };
}

export function requireAuth(auth: Auth | null, scope: 'links' | 'metrics:read' = 'links'): Auth {
  if (!auth) throw new ApiError(401, 'unauthenticated', 'Sign in or send an API token.');
  if (!auth.scopes.includes(scope)) throw new ApiError(403, 'forbidden', auth.via === 'token' ? 'This token lacks the required scope.' : 'Only an admin may do this.');
  return auth;
}

/** For actions an API token may not perform, such as managing tokens. */
export function requireSession(auth: Auth | null): Auth {
  if (!auth) throw new ApiError(401, 'unauthenticated', 'Sign in to do this.');
  if (auth.via !== 'session') throw new ApiError(403, 'session_required', 'Sign in to do this.');
  return auth;
}
