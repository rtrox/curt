import { exportJWK, importJWK, UnsecuredJWT } from 'jose';
import { expect, it, describe, vi } from 'vitest';
import { begin, browserEnv, call, cookies, ec, ed, env, errorCode, goodClaims, newSubject, now, pair, post, PRE, rsa, serverEnv, SESSION, signedIn, signIn, signToken, stranger } from './auth-helpers.ts';

const isAdmin = async (sub: string) => (await env.DB.prepare('SELECT is_admin FROM users WHERE subject = ?').bind(sub).first<{ is_admin: number }>())?.is_admin;

describe('begin', () => {
  it('returns a nonce and a locked-down cookie', async () => {
    const res = await post('/auth/begin', {});
    expect((await res.json<{ nonce: string }>()).nonce).toMatch(/^[\w-]{43}$/);
    const line = cookies(res).get(PRE) ?? '';
    for (const part of ['HttpOnly', 'Secure', 'Path=/', 'SameSite=Strict', 'Max-Age=600']) expect(line).toContain(part);
    expect(line).not.toContain('Domain');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
  it('refuses another origin', async () => expect((await post('/auth/begin', {}, { origin: 'https://evil.example' })).status).toBe(403));
});

describe('session', () => {
  it('signs in without network access and stores only a hash', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const { res, cookie } = await signIn();
    expect(res.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    const line = cookies(res).get(SESSION) ?? '';
    for (const part of ['HttpOnly', 'Secure', 'Path=/', 'SameSite=Strict', 'Max-Age=604800']) expect(line).toContain(part);
    expect(cookies(res).get(PRE)).toContain('Max-Age=0');
    expect(await signedIn(cookie)).toBe(true);
    const value = cookie.split('=')[1] ?? '';
    const { results } = await env.DB.prepare('SELECT id_hash FROM sessions').all<{ id_hash: string }>();
    expect(results.some((r) => r.id_hash === value)).toBe(false);
  });

  it.each([['ES256', ec, 'ec'], ['EdDSA', ed, 'ed']] as const)('accepts %s', async (alg, keys, kid) => {
    const { nonce, cookie } = await begin();
    const token = await signToken(goodClaims(nonce), { alg, key: keys.privateKey, kid });
    expect((await post('/auth/session', { id_token: token }, { cookie })).status).toBe(200);
  });

  const bad: Array<[string, (nonce: string) => Promise<string> | string]> = [
    ['forged', (n) => signToken(goodClaims(n), { key: stranger.privateKey })],
    ['unknown key', (n) => signToken(goodClaims(n), { key: stranger.privateKey, kid: 'other' })],
    ['changed payload', async (n) => {
      const [h, , s] = (await signToken(goodClaims(n))).split('.');
      return `${h}.${btoa(JSON.stringify({ ...goodClaims(n), groups: ['links', 'links-admin'] })).replace(/=+$/, '')}.${s}`;
    }],
    ['alg none', (n) => new UnsecuredJWT(goodClaims(n)).encode()],
    ['alg HS256', (n) => hs256(n)],
    // Correctly signed with a pinned key, so only the algorithm allowlist stops these.
    ...['RS512', 'PS256'].map((alg): [string, (n: string) => Promise<string>] => [`alg ${alg}`, async (n) => {
      const key = await importJWK(await exportJWK(rsa.privateKey), alg);
      return signToken(goodClaims(n), { alg, key: key as CryptoKey });
    }]),
    ['expired', (n) => signToken({ ...goodClaims(n), iat: now() - 500, exp: now() - 120 })],
    ['issued in the future', (n) => signToken({ ...goodClaims(n), iat: now() + 300 })],
    ['issued long ago', (n) => signToken({ ...goodClaims(n), iat: now() - 7200, exp: now() + 600 })],
    ['missing expiry', (n) => signToken({ ...goodClaims(n), exp: undefined })],
    ['missing issued-at', (n) => signToken({ ...goodClaims(n), iat: undefined })],
    ['missing subject', (n) => signToken({ ...goodClaims(n), sub: undefined })],
    ['wrong issuer', (n) => signToken({ ...goodClaims(n), iss: 'https://evil.example' })],
    ['wrong audience', (n) => signToken({ ...goodClaims(n), aud: 'other' })],
    ['several audiences without azp', (n) => signToken({ ...goodClaims(n), aud: ['curt', 'other'] })],
    ['wrong azp', (n) => signToken({ ...goodClaims(n), aud: ['curt', 'other'], azp: 'other' })],
    ['wrong nonce', () => signToken(goodClaims('another-nonce'))],
    ['missing nonce', (n) => signToken({ ...goodClaims(n), nonce: undefined })],
    ['not a token', () => 'hello'],
  ];
  it.each(bad)('rejects %s', async (_name, make) => {
    const { nonce, cookie } = await begin();
    const res = await post('/auth/session', { id_token: await make(nonce) }, { cookie });
    expect(res.status).toBe(401);
    expect(cookies(res).has(SESSION)).toBe(false);
    // The attempt is used up even when it fails.
    expect(cookies(res).get(PRE)).toContain('Max-Age=0');
  });

  it('names the case where pinned keys are out of date', async () => {
    const { nonce, cookie } = await begin();
    const res = await post('/auth/session', { id_token: await signToken(goodClaims(nonce), { kid: 'rotated' }) }, { cookie });
    expect(await errorCode(res)).toBe('unknown_signing_key');
  });
  it('accepts several audiences with our azp', async () => {
    expect((await signIn({ aud: ['curt', 'other'], azp: 'curt' })).res.status).toBe(200);
  });

  it('rejects a replay once the cookie is cleared', async () => {
    const { nonce, cookie } = await begin();
    const id_token = await signToken(goodClaims(nonce));
    expect((await post('/auth/session', { id_token }, { cookie })).status).toBe(200);
    const res = await post('/auth/session', { id_token });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('signin_expired');
  });
  it('rejects a token against a later attempt', async () => {
    const first = await begin();
    const second = await begin();
    expect((await post('/auth/session', { id_token: await signToken(goodClaims(first.nonce)) }, { cookie: second.cookie })).status).toBe(401);
  });
  it('rejects tampered, expired and foreign-mode pre-auth cookies', async () => {
    const { nonce, cookie } = await begin();
    const id_token = await signToken(goodClaims(nonce));
    const [name, value] = cookie.split('=') as [string, string];
    const [payload, sig] = value.split('.') as [string, string];
    const forged = btoa(JSON.stringify({ nonce, exp: now() + 9999 })).replace(/=+$/, '');
    for (const v of [`${forged}.${sig}`, `${payload}.${sig.startsWith('A') ? 'B' : 'A'}${sig.slice(1)}`, payload, `${payload}.`, `${value}.x`, '']) {
      const res = await post('/auth/session', { id_token }, { cookie: `${name}=${v}` });
      expect(await errorCode(res)).toBe('signin_expired');
    }
    vi.useFakeTimers({ now: Date.now() + 601_000, toFake: ['Date'] });
    try {
      expect(await errorCode(await post('/auth/session', { id_token }, { cookie }))).toBe('signin_expired');
    } finally {
      vi.useRealTimers();
    }
    const login = await call('/auth/login', {}, serverEnv);
    expect(await errorCode(await post('/auth/session', { id_token }, { cookie: pair(cookies(login).get(PRE)) }))).toBe('signin_expired');
  });
  it('rejects bad bodies', async () => {
    for (const body of [null, {}, { id_token: 5 }]) {
      const { cookie } = await begin();
      expect((await post('/auth/session', body, { cookie })).status).toBe(400);
    }
    const { cookie } = await begin();
    expect((await post('/auth/session', { id_token: 'x'.repeat(70_000) }, { cookie })).status).toBe(413);
  });
  it('leaves the nonce unused when the token is not genuine, so the table cannot be filled', async () => {
    const count = async () => (await env.DB.prepare('SELECT count(*) AS n FROM used_nonces').first<{ n: number }>())?.n;
    const before = await count();
    const { nonce, cookie } = await begin();
    await post('/auth/session', { id_token: await signToken(goodClaims(nonce), { key: stranger.privateKey }) }, { cookie });
    expect(await count()).toBe(before);
  });
  it('replaces the session already in the browser', async () => {
    const first = await signIn();
    const { nonce, cookie } = await begin();
    const res = await post('/auth/session', { id_token: await signToken(goodClaims(nonce)) }, { cookie: `${cookie}; ${first.cookie}` });
    expect(res.status).toBe(200);
    expect(await signedIn(first.cookie)).toBe(false);
  });
  it('fails closed on broken configuration', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await post('/auth/begin', {}, {}, { ...browserEnv, COOKIE_KEY: 'short' })).status).toBe(500);
    expect((await post('/auth/begin', {}, {}, { ...browserEnv, OIDC_EXCHANGE: 'neither' as never })).status).toBe(500);
    expect((await signIn({}, { ...browserEnv, ALLOWED_GROUP: undefined as never })).res.status).toBe(500);
    expect((await signIn({}, { ...browserEnv, OIDC_JWKS: 'nope' })).res.status).toBe(500);
    quiet.mockRestore();
  });
});

describe('groups', () => {
  it('refuses people outside the group', async () => {
    const { res } = await signIn({ groups: ['others', 'linksx'] });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('not_allowed');
    expect(cookies(res).has(SESSION)).toBe(false);
  });
  it('explains a missing claim', async () => {
    const { res } = await signIn({ groups: undefined });
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('groups_missing');
    expect(body.error.message).toContain('ALLOWED_GROUP');
  });
  it('does not let an admin group stand in for the allowed group', async () => {
    expect((await signIn({ groups: ['links-admin'] })).res.status).toBe(403);
  });
  it('grants and withdraws admin at each sign-in', async () => {
    const sub = newSubject();
    await signIn({ sub, groups: ['links', 'links-admin'] });
    expect(await isAdmin(sub)).toBe(1);
    await signIn({ sub, groups: ['links'] });
    expect(await isAdmin(sub)).toBe(0);
  });
  it('withdraws admin from someone who is refused', async () => {
    const sub = newSubject();
    await signIn({ sub, groups: ['links', 'links-admin'] });
    await signIn({ sub, groups: ['others'] });
    expect(await isAdmin(sub)).toBe(0);
  });
  it('relies on the provider when ALLOWED_GROUP is empty, with admins by subject', async () => {
    const sub = newSubject();
    const e = { ...browserEnv, ALLOWED_GROUP: '', ADMIN_GROUP: '', ADMIN_SUBJECTS: `x, ${sub} ` };
    expect((await signIn({ sub, groups: undefined }, e)).res.status).toBe(200);
    expect(await isAdmin(sub)).toBe(1);
    const other = newSubject();
    await signIn({ sub: other, groups: [''] }, e);
    expect(await isAdmin(other)).toBe(0);
  });
});

describe('session lifetime', () => {
  it('ends at its expiry and is not extended by use', async () => {
    const { cookie } = await signIn();
    const read = () => env.DB.prepare('SELECT max(expires_at) AS e FROM sessions').first<{ e: number }>();
    const before = await read();
    expect(await signedIn(cookie)).toBe(true);
    expect(await read()).toEqual(before);
    await env.DB.prepare('UPDATE sessions SET expires_at = ?').bind(now()).run();
    expect(await signedIn(cookie)).toBe(false);
  });
  it('lasts seven days', async () => {
    await env.DB.prepare('DELETE FROM sessions').run();
    await signIn();
    const row = await env.DB.prepare('SELECT expires_at AS e FROM sessions').first<{ e: number }>();
    expect(Math.abs((row?.e ?? 0) - now() - 604_800)).toBeLessThan(5);
  });
  it('rejects altered cookies', async () => {
    const { cookie } = await signIn();
    expect(await signedIn(`${cookie.slice(0, -2)}${cookie.endsWith('AA') ? 'BB' : 'AA'}`)).toBe(false);
    expect(await signedIn(`${SESSION}=x`)).toBe(false);
  });
  it('logs out', async () => {
    const { cookie } = await signIn();
    const res = await post('/auth/logout', {}, { cookie });
    expect(res.status).toBe(200);
    expect(cookies(res).get(SESSION)).toContain('Max-Age=0');
    expect(await signedIn(cookie)).toBe(false);
  });
  it('refuses cross-site logout and writes', async () => {
    const { cookie } = await signIn();
    expect((await post('/auth/logout', {}, { cookie, origin: 'https://evil.example' })).status).toBe(403);
    expect(await signedIn(cookie)).toBe(true);
  });
});

it('hides the other mode', async () => {
  expect((await call('/auth/login')).status).toBe(404);
  expect((await post('/auth/begin', {}, {}, serverEnv)).status).toBe(404);
  expect((await post('/auth/session', {}, {}, serverEnv)).status).toBe(404);
});
it('serves the dashboard at the callback', async () => {
  const ASSETS = { fetch: async () => new Response('<p>shell</p>', { headers: { 'content-type': 'text/html' } }) } as unknown as Fetcher;
  const res = await call('/auth/callback?code=x&state=y', {}, { ...browserEnv, ASSETS });
  expect(await res.text()).toBe('<p>shell</p>');
  expect(res.headers.get('content-security-policy')).toContain('https://id.example');
});

async function hs256(nonce: string): Promise<string> {
  // The classic confusion attack: HMAC keyed with public key material.
  const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const body = `${enc({ alg: 'HS256', kid: 'rsa' })}.${enc(goodClaims(nonce))}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(browserEnv.OIDC_JWKS), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return `${body}.${btoa(String.fromCharCode(...mac)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}
