import { createdTokenSchema, tokenSchema } from '@curt/shared/schemas';
import { beforeAll, describe, expect, it } from 'vitest';
import { publicSigningKeys } from '../scripts/public-keys.mjs';
import { requireAuth, requireSession } from '../src/auth/middleware.ts';
import { call, env, errorCode, jwks, newSubject, now, post, rsa, signedIn, signIn } from './auth-helpers.ts';
import { exportJWK } from 'jose';

let member = '';
let admin = '';
const adminSub = newSubject();
beforeAll(async () => {
  member = (await signIn()).cookie;
  admin = (await signIn({ sub: adminSub, groups: ['links', 'links-admin'] })).cookie;
});

async function create(cookie: string, body: Record<string, unknown> = {}) {
  const res = await post('/api/v1/tokens', { name: 'laptop', scope: 'links', ...body }, { cookie });
  expect(res.status).toBe(201);
  return createdTokenSchema.parse(await res.json());
}
const bearer = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
/** 404 from an unknown endpoint means the token was accepted. */
const probe = async (headers: Record<string, string>) => (await call('/api/v1/nope', { headers })).status;
const lastUsed = async (id: string) => (await env.DB.prepare('SELECT last_used_day AS d FROM api_tokens WHERE id = ?').bind(id).first<{ d: string | null }>())?.d;

describe('managing tokens', () => {
  it('shows a token once and stores its hash', async () => {
    const t = await create(member);
    expect(t.token).toMatch(/^curt_[\w-]{43}$/);
    const listed = (await (await call('/api/v1/tokens', { headers: { cookie: member } })).json<{ tokens: unknown[] }>()).tokens;
    expect(listed.map((x) => tokenSchema.strict().parse(x).id)).toContain(t.id);
    expect(JSON.stringify(listed)).not.toContain(t.token);
    const row = await env.DB.prepare('SELECT * FROM api_tokens WHERE id = ?').bind(t.id).first();
    expect(JSON.stringify(row)).not.toContain(t.token.slice(5));
  });
  it('needs a session', async () => {
    expect((await call('/api/v1/tokens')).status).toBe(401);
    const t = await create(admin);
    const m = await create(admin, { scope: 'metrics:read' });
    for (const x of [t, m]) {
      const res = await call('/api/v1/tokens', { headers: bearer(x.token) });
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe('session_required');
      // The cookie does not rescue it: the bearer token takes precedence.
      expect((await post('/api/v1/tokens', { name: 'x', scope: 'links' }, bearer(x.token, { cookie: admin }))).status).toBe(403);
      expect((await call(`/api/v1/tokens/${x.id}`, { method: 'DELETE', headers: bearer(x.token) })).status).toBe(403);
    }
  });
  it('validates input', async () => {
    for (const body of [{}, { name: '' }, { name: 'x', scope: 'root' }, { name: 'x', scope: 'links', extra: 1 }, { name: 'x', scope: 'links', expiresAt: now() - 1 }]) {
      expect((await post('/api/v1/tokens', body, { cookie: member })).status).toBe(400);
    }
    expect((await post('/api/v1/tokens', { name: 'x', scope: 'links' }, { cookie: member, origin: 'https://evil.example' })).status).toBe(403);
  });
  it('keeps metrics tokens to admins', async () => {
    const res = await post('/api/v1/tokens', { name: 'prom', scope: 'metrics:read' }, { cookie: member });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('forbidden');
  });
  it("hides other people's tokens", async () => {
    const t = await create(member);
    expect(await (await call('/api/v1/tokens', { headers: { cookie: admin } })).text()).not.toContain(t.id);
    expect((await call(`/api/v1/tokens/${t.id}`, { method: 'DELETE', headers: { cookie: admin } })).status).toBe(404);
    expect(await probe(bearer(t.token))).toBe(404);
  });
});

describe('using tokens', () => {
  it('stops after revocation', async () => {
    const t = await create(member);
    expect(await probe(bearer(t.token))).toBe(404);
    const del = () => call(`/api/v1/tokens/${t.id}`, { method: 'DELETE', headers: { cookie: member } });
    expect((await del()).status).toBe(204);
    expect((await del()).status).toBe(404);
    expect(await probe(bearer(t.token))).toBe(401);
    expect(await (await call('/api/v1/tokens', { headers: { cookie: member } })).text()).not.toContain(t.id);
  });
  it('stops at expiry', async () => {
    const t = await create(member, { expiresAt: now() + 1000 });
    expect(await probe(bearer(t.token))).toBe(404);
    await env.DB.prepare('UPDATE api_tokens SET expires_at = ? WHERE id = ?').bind(now(), t.id).run();
    expect(await probe(bearer(t.token))).toBe(401);
  });
  it('does not fall back to the cookie', async () => {
    const t = await create(member);
    for (const authorization of ['Bearer', 'Bearer ', 'bearer nope', `Bearer ${t.token}x`, `Bearer curt_${'A'.repeat(43)}`, `Bearer ${t.token}, Bearer ${t.token}`]) {
      const res = await call('/api/v1/nope', { headers: { authorization, cookie: member } });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
    }
    expect(await probe({ authorization: 'Basic eDp5', cookie: member })).toBe(404);
    expect(await signedIn(member)).toBe(true);
  });
  it('records the day of use at most daily', async () => {
    const t = await create(member);
    expect(await lastUsed(t.id)).toBe(null);
    await probe(bearer(t.token));
    const today = new Date().toISOString().slice(0, 10);
    expect(await lastUsed(t.id)).toBe(today);
    // A second use on the same day must not write again.
    await env.DB.exec(`CREATE TRIGGER no_write BEFORE UPDATE OF last_used_day ON api_tokens WHEN OLD.id = '${t.id}' BEGIN SELECT RAISE(FAIL, 'second write'); END`);
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => errors.push(a);
    await probe(bearer(t.token));
    console.error = original;
    await env.DB.exec('DROP TRIGGER no_write');
    expect(errors).toEqual([]);
    await env.DB.prepare("UPDATE api_tokens SET last_used_day = '2020-01-01' WHERE id = ?").bind(t.id).run();
    await probe(bearer(t.token));
    expect(await lastUsed(t.id)).toBe(today);
  });
  it('lets a token write without an Origin', async () => {
    const t = await create(member);
    const res = await call('/api/v1/nope', { method: 'POST', headers: bearer(t.token, { origin: 'https://other.example' }) });
    expect(res.status).toBe(404);
  });
  it("refuses a demoted admin's metrics token", async () => {
    const sub = newSubject();
    const { cookie } = await signIn({ sub, groups: ['links', 'links-admin'] });
    const m = await create(cookie, { scope: 'metrics:read' });
    const l = await create(cookie);
    expect(await probe(bearer(m.token))).toBe(404);
    await signIn({ sub, groups: ['links'] });
    const res = await call('/metrics', { headers: bearer(m.token) });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('forbidden');
    expect(await probe(bearer(l.token))).toBe(404);
    // Promoted again, it works again.
    await signIn({ sub, groups: ['links', 'links-admin'] });
    expect(await probe(bearer(m.token))).toBe(404);
  });
});

describe('guards', () => {
  const token = (scope: 'links' | 'metrics:read') => ({ userId: 'u', isAdmin: true, via: 'token' as const, scopes: [scope] });
  it('enforces scopes', () => {
    expect(() => requireAuth(null)).toThrow('Sign in or send');
    expect(requireAuth(token('links')).userId).toBe('u');
    expect(() => requireAuth(token('metrics:read'))).toThrow('lacks the required scope');
    expect(() => requireAuth(token('links'), 'metrics:read')).toThrow('lacks the required scope');
    expect(() => requireSession(token('links'))).toThrow('Sign in');
  });
  it("keeps metrics from a member's session", () => {
    expect(() => requireAuth({ userId: 'u', isAdmin: false, via: 'session', scopes: ['links'] }, 'metrics:read')).toThrow('Only an admin');
  });
});

describe('pinning keys', () => {
  it('drops private and unusable keys', async () => {
    const secret = { ...(await exportJWK(rsa.privateKey)), kid: 'p', alg: 'RS256' };
    const out = publicSigningKeys({ keys: [secret, ...jwks.keys, { kty: 'oct', k: 'c2VjcmV0' }, { ...jwks.keys[0], use: 'enc' }, { ...jwks.keys[0], alg: 'PS256' }, { kty: 'OKP', crv: 'X25519', x: 'a' }, null] });
    expect(out.keys.map((k) => k.kid)).toEqual(['p', 'rsa', 'ec', 'ed']);
    for (const k of out.keys) for (const f of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']) expect(k).not.toHaveProperty(f);
  });
  it('refuses an empty result', () => {
    expect(() => publicSigningKeys({ keys: [] })).toThrow();
    expect(() => publicSigningKeys({})).toThrow();
  });
});
