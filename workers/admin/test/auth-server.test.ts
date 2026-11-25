import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types.ts';
import { call, cookies, env, goodClaims, jwks, newSubject, pair, PRE, rsa, serverEnv, SESSION, signedIn, signToken, stranger } from './auth-helpers.ts';

interface Mock {
  token?: (params: URLSearchParams, headers: Headers) => Promise<Response> | Response;
  discovery?: Record<string, unknown>;
  jwksUri?: string;
}
const requests: Array<{ url: string; init: RequestInit | undefined }> = [];

function mockProvider(m: Mock = {}) {
  requests.length = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    requests.push({ url, init: init as RequestInit });
    if (url === 'https://id.example/.well-known/openid-configuration') {
      return Response.json({ issuer: 'https://id.example', jwks_uri: m.jwksUri ?? 'https://id.example/jwks', token_endpoint: 'http://internal.example/token', ...m.discovery });
    }
    if (url === 'https://id.example/jwks') return Response.json(jwks);
    if (url === serverEnv.OIDC_TOKEN_ENDPOINT && m.token) return m.token(new URLSearchParams(String(init?.body)), new Headers(init?.headers));
    throw new Error('unexpected request');
  });
}
afterEach(() => vi.restoreAllMocks());

async function login(e: Env = serverEnv) {
  const res = await call('/auth/login', {}, e);
  const url = new URL(res.headers.get('location') ?? '');
  return { res, url, q: url.searchParams, line: cookies(res).get(PRE) ?? '', cookie: pair(cookies(res).get(PRE)) };
}
const callback = (params: Record<string, string>, cookie: string, e: Env = serverEnv) =>
  call(`/auth/callback?${new URLSearchParams(params)}`, { headers: { cookie } }, e);
const tokenFor = (nonce: string, over: Record<string, unknown> = {}, key?: CryptoKey) => async () =>
  Response.json({ id_token: await signToken({ ...goodClaims(nonce), ...over }, key ? { key } : {}), access_token: 'unused' });

describe('login', () => {
  it('redirects with PKCE and a Lax cookie', async () => {
    const { res, url, q, line } = await login();
    expect(res.status).toBe(302);
    expect(url.origin + url.pathname).toBe('https://id.example/authorize');
    expect(q.get('redirect_uri')).toBe('https://app.go.example/auth/callback');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('scope')).toBe('openid profile email groups');
    for (const part of ['HttpOnly', 'Secure', 'Path=/', 'SameSite=Lax', 'Max-Age=600']) expect(line).toContain(part);
  });
  it('asks for groups only when they are used', async () => {
    expect((await login({ ...serverEnv, ALLOWED_GROUP: '', ADMIN_GROUP: '' })).q.get('scope')).toBe('openid profile email');
  });
});

describe('callback', () => {
  it('exchanges the code and continues from a same-origin page', async () => {
    const { q, cookie } = await login();
    mockProvider({
      token: async (p, h) => {
        expect(p.get('client_id')).toBe('curt');
        expect(h.has('authorization')).toBe(false);
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(p.get('code_verifier') ?? '')));
        expect(btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')).toBe(q.get('code_challenge'));
        return tokenFor(q.get('nonce') ?? '')();
      },
    });
    const res = await callback({ code: 'c', state: q.get('state') ?? '', iss: 'https://id.example' }, cookie);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('content="0;url=/"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(cookies(res).get(SESSION)).toContain('SameSite=Strict');
    expect(cookies(res).get(PRE)).toContain('Max-Age=0');
    expect(await signedIn(pair(cookies(res).get(SESSION)))).toBe(true);
    // The internal token endpoint in discovery is ignored, and redirects are never followed.
    expect(requests.map((r) => r.url)).not.toContain('http://internal.example/token');
    expect(requests.every((r) => r.init?.redirect === 'manual')).toBe(true);
  });
  it.each([[undefined, 'basic'], [['client_secret_post'], 'post']])('sends a client secret (%s)', async (methods, kind) => {
    const e = { ...serverEnv, OIDC_CLIENT_SECRET: 'test secret+' };
    const { q, cookie } = await login(e);
    mockProvider({
      discovery: methods ? { token_endpoint_auth_methods_supported: methods } : {},
      token: async (p, h) => {
        if (kind === 'basic') expect(h.get('authorization')).toBe(`Basic ${btoa('curt:test+secret%2B')}`);
        else expect(p.get('client_secret')).toBe('test secret+');
        return tokenFor(q.get('nonce') ?? '')();
      },
    });
    expect((await callback({ code: 'c', state: q.get('state') ?? '' }, cookie, e)).status).toBe(200);
  });

  it('rejects a missing cookie, wrong state, tampered cookie and wrong issuer without calling the provider', async () => {
    mockProvider();
    const { q, cookie } = await login();
    const state = q.get('state') ?? '';
    for (const [params, c] of [
      [{ code: 'c', state }, ''],
      [{ code: 'c', state: 'x' }, cookie],
      [{ code: 'c' }, cookie],
      [{ code: 'c', state }, `${cookie}x`],
      [{ code: 'c', state, iss: 'https://evil.example' }, cookie],
      [{ state }, cookie],
    ] as Array<[Record<string, string>, string]>) {
      const res = await callback(params, c);
      expect(res.status).toBe(400);
      expect(cookies(res).has(SESSION)).toBe(false);
    }
    expect(requests).toEqual([]);
  });
  it('never reflects provider input', async () => {
    mockProvider();
    for (const error of ['access_denied', '<script>alert(1)</script>']) {
      const { q, cookie } = await login();
      const res = await callback({ error, error_description: '<img src=x>', state: q.get('state') ?? '' }, cookie);
      const body = await res.text();
      expect(res.status).toBe(403);
      for (const s of ['<script', '<img', 'alert(1)', 'access_denied']) expect(body).not.toContain(s);
    }
  });
  it('escapes the site name', async () => {
    const res = await callback({}, '', { ...serverEnv, SITE_NAME: '<b>x</b>' });
    expect(await res.text()).toContain('&lt;b&gt;');
  });

  const failures: Array<[string, (nonce: string) => Mock, number]> = [
    ['forged token', (n) => ({ token: tokenFor(n, {}, stranger.privateKey) }), 401],
    ['wrong nonce', () => ({ token: tokenFor('other') }), 401],
    ['wrong audience', (n) => ({ token: tokenFor(n, { aud: 'other' }) }), 401],
    ['outside the group', (n) => ({ token: tokenFor(n, { groups: [] }) }), 403],
    ['missing groups', (n) => ({ token: tokenFor(n, { groups: undefined }) }), 403],
    ['token endpoint error', () => ({ token: () => Response.json({ error: 'invalid_grant' }, { status: 400 }) }), 502],
    ['token endpoint redirect', () => ({ token: () => new Response(null, { status: 307, headers: { location: 'https://evil.example' } }) }), 502],
    ['not JSON', () => ({ token: () => new Response('<html>') }), 502],
    ['no ID token', () => ({ token: () => Response.json({}) }), 502],
    ['unreachable', () => ({}), 502],
    ['discovery for another issuer', (n) => ({ discovery: { issuer: 'https://evil.example' }, token: tokenFor(n) }), 502],
    ['plain http keys', (n) => ({ jwksUri: 'http://id.example/jwks', token: tokenFor(n) }), 502],
  ];
  it.each(failures)('fails: %s', async (_name, make, status) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { q, cookie } = await login();
    mockProvider(make(q.get('nonce') ?? ''));
    const res = await callback({ code: 'secret-code', state: q.get('state') ?? '' }, cookie);
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(cookies(res).has(SESSION)).toBe(false);
    expect(cookies(res).get(PRE)).toContain('Max-Age=0');
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-code');
  });
  it('rejects the same cookie and token a second time', async () => {
    const { q, cookie } = await login();
    const claims = { sub: newSubject() };
    mockProvider({ token: tokenFor(q.get('nonce') ?? '', { ...claims, groups: ['links', 'links-admin'] }) });
    const params = { code: 'c', state: q.get('state') ?? '' };
    expect((await callback(params, cookie)).status).toBe(200);
    await env.DB.prepare('UPDATE users SET is_admin = 0 WHERE subject = ?').bind(claims.sub).run();
    const res = await callback(params, cookie);
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(cookies(res).has(SESSION)).toBe(false);
    expect(await env.DB.prepare('SELECT is_admin, (SELECT count(*) FROM sessions WHERE user_id = users.id) AS n FROM users WHERE subject = ?').bind(claims.sub).first()).toEqual({ is_admin: 0, n: 1 });
  });
  it('consumes the attempt when sign-in is refused', async () => {
    const { q, cookie } = await login();
    const params = { code: 'c', state: q.get('state') ?? '' };
    mockProvider({ token: tokenFor(q.get('nonce') ?? '', { groups: [] }) });
    expect((await callback(params, cookie)).status).toBe(403);
    vi.restoreAllMocks();
    mockProvider({ token: tokenFor(q.get('nonce') ?? '') });
    expect((await callback(params, cookie)).status).toBe(400);
  });
  it('rejects a replayed callback once the cookie is cleared', async () => {
    const { q, cookie } = await login();
    mockProvider({ token: tokenFor(q.get('nonce') ?? '', {}, rsa.privateKey) });
    const params = { code: 'c', state: q.get('state') ?? '' };
    expect((await callback(params, cookie)).status).toBe(200);
    expect((await callback(params, '')).status).toBe(400);
  });
});
