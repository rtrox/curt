import type { Context } from 'hono';
import { ApiError } from '../lib/errors.ts';
import type { AppEnv, Env } from '../types.ts';
import { PREAUTH_SECONDS, readSessionCookie, SESSION_SECONDS, setSessionCookie } from './cookies.ts';
import { nowSeconds, randomToken, sha256 } from './crypto.ts';
import { TOKEN_ACCEPTED_SECONDS, type IdClaims } from './idtoken.ts';

export const attemptExpired = () => new ApiError(400, 'signin_expired', 'This sign-in attempt has expired or was already used. Start again.');

/** null when the claim is absent or unusable. */
function readGroups(claims: IdClaims): string[] | null {
  const raw = claims.groups;
  if (typeof raw === 'string') return [raw];
  if (!Array.isArray(raw)) return null;
  return raw.filter((g): g is string => typeof g === 'string');
}

type Decision = { allowed: true; isAdmin: boolean } | { allowed: false; code: 'groups_missing' | 'not_allowed'; message: string };

/** Decides from verified claims whether this person may sign in, and whether as an admin. */
function authorize(env: Env, claims: IdClaims): Decision {
  // Only an explicit empty string opens sign-in to everyone the provider lets through.
  if (typeof env.ALLOWED_GROUP !== 'string') throw new Error('ALLOWED_GROUP is not set');
  const groups = readGroups(claims);
  if (env.ALLOWED_GROUP !== '') {
    if (groups === null) {
      return { allowed: false, code: 'groups_missing', message: 'The sign-in provider did not send a groups claim in the ID token, so access cannot be checked. Enable the groups scope for this client, or leave ALLOWED_GROUP empty and restrict access in the provider.' };
    }
    if (!groups.includes(env.ALLOWED_GROUP)) {
      return { allowed: false, code: 'not_allowed', message: 'Your account is not in the group that may use this site.' };
    }
  }
  const adminSubjects = (env.ADMIN_SUBJECTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const inAdminGroup = Boolean(env.ADMIN_GROUP) && (groups?.includes(env.ADMIN_GROUP) ?? false);
  return { allowed: true, isAdmin: inAdminGroup || adminSubjects.includes(claims.sub) };
}

// Past this, neither the pre-auth cookie nor a token for this nonce can still be accepted. The minute covers slow requests.
const NONCE_KEPT_SECONDS = Math.max(PREAUTH_SECONDS, TOKEN_ACCEPTED_SECONDS) + 60;

/** Runs the statements only if this sign-in attempt has not been used before, as one transaction with marking it used. */
async function useAttempt(env: Env, claims: IdClaims, now: number, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  const mark = env.DB.prepare('INSERT INTO used_nonces (nonce_hash, expires_at) VALUES (?, ?)').bind(await sha256(claims.nonce), now + NONCE_KEPT_SECONDS);
  try {
    return (await env.DB.batch([mark, ...statements])).slice(1);
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE constraint failed: used_nonces.nonce_hash')) throw attemptExpired();
    throw err;
  }
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null);

/** Creates or updates the user and starts a session. Call only with verified claims.
 *  `begunAt` is our own record of when the attempt began. The token answers a nonce made then, so it cannot be older.
 *  Comparing that with the cutoff needs no trust in the provider's clock. The token's own issued-at must pass as well. */
export async function startSession(c: Context<AppEnv>, claims: IdClaims, begunAt: number): Promise<void> {
  const decision = authorize(c.env, claims);
  const now = nowSeconds();
  const db = c.env.DB;
  if (!decision.allowed) {
    // Someone removed from the group loses their sessions and admin now. API tokens are left to the admin cutoff.
    await useAttempt(c.env, claims, now, decision.code !== 'not_allowed' ? [] : [
      db.prepare('UPDATE users SET is_admin = 0 WHERE issuer = ? AND subject = ?').bind(c.env.OIDC_ISSUER, claims.sub),
      db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE issuer = ? AND subject = ?)').bind(c.env.OIDC_ISSUER, claims.sub),
    ]);
    throw new ApiError(403, decision.code, decision.message);
  }
  const session = randomToken();
  const sessionHash = await sha256(session);
  const previous = readSessionCookie(c);
  // Seconds are compared with <=, so anything begun in the same second as a cutoff is refused.
  const startedAt = Math.min(begunAt, Math.floor(claims.iat));
  const statements = [
    db.prepare(`INSERT INTO users (id, issuer, subject, name, email, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (issuer, subject) DO UPDATE SET name = excluded.name, email = excluded.email, is_admin = excluded.is_admin
      WHERE users.cutoff_at IS NULL OR users.cutoff_at < ?`)
      .bind(crypto.randomUUID(), c.env.OIDC_ISSUER, claims.sub, text(claims.name) ?? text(claims.preferred_username), text(claims.email), decision.isAdmin ? 1 : 0, now, startedAt),
    db.prepare('INSERT INTO sessions (id_hash, user_id, expires_at) SELECT ?, id, ? FROM users WHERE issuer = ? AND subject = ? AND (cutoff_at IS NULL OR cutoff_at < ?)')
      .bind(sessionHash, now + SESSION_SECONDS, c.env.OIDC_ISSUER, claims.sub, startedAt),
  ];
  if (previous) {
    statements.push(db.prepare('DELETE FROM sessions WHERE id_hash = ? AND EXISTS (SELECT 1 FROM sessions WHERE id_hash = ?)').bind(await sha256(previous), sessionHash));
  }
  const [, inserted] = await useAttempt(c.env, claims, now, statements);
  if (inserted?.meta.changes !== 1) {
    throw new ApiError(403, 'signin_before_cutoff', 'An admin ended your access after this sign-in began. Start again if you should still have access.');
  }
  setSessionCookie(c, session);
}
