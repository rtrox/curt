import { base64url } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sign } from '../src/auth/crypto.ts';
import type { Env } from '../src/types.ts';
import { begin, browserEnv, call, cookies, env, errorCode, goodClaims, jwks, newSubject, now, pair, post, PRE, serverEnv, SESSION, signedIn, signIn, signToken } from './auth-helpers.ts';

type Mode = 'browser' | 'server';
const GROUPS = ['links', 'links-admin'];

/** Starts a sign-in. The token is made when finish is called, unless `issue` made it earlier. */
async function start(mode: Mode, sub: string, over: Record<string, unknown> = {}) {
  if (mode === 'browser') {
    const { nonce, cookie } = await begin();
    const issue = () => signToken({ ...goodClaims(nonce), sub, groups: GROUPS, ...over });
    return { issue, finish: async (id_token: string, e: Env = browserEnv, extra = '') => post('/auth/session', { id_token }, { cookie: cookie + extra }, e) };
  }
  const res = await call('/auth/login', {}, serverEnv);
  const q = new URL(res.headers.get('location') ?? '').searchParams;
  const cookie = pair(cookies(res).get(PRE));
  const issue = () => signToken({ ...goodClaims(q.get('nonce') ?? ''), sub, groups: GROUPS, ...over });
  return {
    issue,
    finish: async (id_token: string, e: Env = browserEnv, extra = '') => {
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith('/openid-configuration')) return Response.json({ issuer: 'https://id.example', jwks_uri: 'https://id.example/jwks' });
        if (url.endsWith('/jwks')) return Response.json(jwks);
        if (url === serverEnv.OIDC_TOKEN_ENDPOINT) return Response.json({ id_token });
        throw new Error('unexpected request');
      });
      try {
        return await call(`/auth/callback?${new URLSearchParams({ code: 'c', state: q.get('state') ?? '' })}`, { headers: { cookie: cookie + extra } }, { ...serverEnv, DB: e.DB });
      } finally {
        spy.mockRestore();
      }
    },
  };
}

const user = (sub: string) => env.DB.prepare('SELECT id, name, is_admin, (SELECT count(*) FROM sessions WHERE user_id = users.id) AS sessions FROM users WHERE subject = ?')
  .bind(sub).first<{ id: string; name: string | null; is_admin: number; sessions: number }>();

const REAL = Math.floor(Date.now() / 1000);
/** Moves the Worker's clock. The database keeps real time, so cutoffs below are written explicitly. */
const at = (seconds: number) => vi.useFakeTimers({ now: (REAL + seconds) * 1000, toFake: ['Date'] });

let adminCookie = '';
let sub = '';
let id = '';
async function cutoff(seconds = 0) {
  expect((await post(`/api/v1/users/${id}/cutoff`, {}, { cookie: adminCookie })).status).toBe(200);
  await env.DB.prepare('UPDATE users SET cutoff_at = ? WHERE id = ?').bind(REAL + seconds, id).run();
}
async function expectRefused(res: Response, mode: Mode) {
  expect(res.status).toBe(403);
  if (mode === 'browser') expect(await errorCode(res)).toBe('signin_before_cutoff');
  else {
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('ended your access');
  }
  expect(cookies(res).has(SESSION)).toBe(false);
  expect(cookies(res).get(PRE)).toContain('Max-Age=0');
  expect(await user(sub)).toMatchObject({ is_admin: 0, sessions: 0, name: null });
}

beforeEach(async () => {
  for (const t of ['audit', 'api_tokens', 'sessions', 'users', 'used_nonces']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  at(0);
  adminCookie = (await signIn({ groups: GROUPS })).cookie;
  sub = newSubject();
  await signIn({ sub, groups: GROUPS });
  id = (await user(sub))?.id ?? '';
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe.each(['browser', 'server'] as const)('sign-in around a cutoff, %s exchange', (mode) => {
  it.each([['in the same second', 0, 0], ['seconds later', 5, 5], ['minutes later', 5, 400]])('refuses a token obtained earlier and first used %s', async (_name, cut, used) => {
    const attempt = await start(mode, sub, { name: 'Changed' });
    const token = await attempt.issue();
    at(cut);
    await cutoff(cut);
    at(used);
    await expectRefused(await attempt.finish(token), mode);
  });
  it.each([30, 60])('refuses an earlier token from a provider clock %i seconds ahead, for its whole life', async (ahead) => {
    const attempt = await start(mode, sub, { iat: REAL + ahead, exp: REAL + 9999 });
    const token = await attempt.issue();
    await cutoff();
    for (const later of [1, ahead + 1, 599]) {
      at(later);
      await env.DB.prepare('DELETE FROM used_nonces').run();
      await expectRefused(await attempt.finish(token), mode);
    }
  });
  it('refuses an attempt begun earlier even when its token is newer', async () => {
    const attempt = await start(mode, sub, { iat: REAL + 20 });
    at(5);
    await cutoff(5);
    at(20);
    await expectRefused(await attempt.finish(await attempt.issue()), mode);
  });
  it.each([0, 0.9])('refuses a token whose own time is at the cutoff (plus %f), in a later attempt', async (fraction) => {
    await cutoff();
    at(2);
    const attempt = await start(mode, sub, { iat: REAL + fraction });
    await expectRefused(await attempt.finish(await attempt.issue()), mode);
  });
  it('accepts a fresh sign-in from the next second', async () => {
    await cutoff();
    at(1);
    const attempt = await start(mode, sub);
    const res = await attempt.finish(await attempt.issue());
    expect(res.status).toBe(200);
    expect(await signedIn(pair(cookies(res).get(SESSION)))).toBe(true);
    expect(await user(sub)).toMatchObject({ is_admin: 1, sessions: 1 });
  });
  it('accepts a fresh sign-in from a provider clock running ahead', async () => {
    await cutoff();
    at(1);
    const attempt = await start(mode, sub, { iat: REAL + 50 });
    expect((await attempt.finish(await attempt.issue())).status).toBe(200);
  });
  it('lets a cutoff that lands mid-sign-in win', async () => {
    const attempt = await start(mode, sub);
    const token = await attempt.issue();
    at(1);
    let cut = false;
    const DB = {
      prepare: env.DB.prepare.bind(env.DB),
      // Everything has been verified by the time the batch is sent.
      batch: async (s: D1PreparedStatement[]) => { cut = true; await cutoff(1); return env.DB.batch(s); },
    } as unknown as D1Database;
    const res = await attempt.finish(token, { ...browserEnv, DB });
    expect(cut).toBe(true);
    await expectRefused(res, mode);
  });
  it('ends a sign-in that finished just before', async () => {
    at(1);
    const attempt = await start(mode, sub);
    const res = await attempt.finish(await attempt.issue());
    await cutoff(1);
    expect(await signedIn(pair(cookies(res).get(SESSION)))).toBe(false);
    expect(await user(sub)).toMatchObject({ is_admin: 0, sessions: 0 });
  });
  it('refuses sign-ins begun between two cutoffs', async () => {
    await cutoff();
    at(2);
    const attempt = await start(mode, sub);
    const token = await attempt.issue();
    at(4);
    await cutoff(4);
    await expectRefused(await attempt.finish(token), mode);
  });
  it('consumes the attempt and keeps the session already in the browser', async () => {
    const attempt = await start(mode, sub);
    const token = await attempt.issue();
    await cutoff();
    await expectRefused(await attempt.finish(token, browserEnv, `; ${adminCookie}`), mode);
    expect(await signedIn(adminCookie)).toBe(true);
    expect((await attempt.finish(token)).status).toBe(400);
  });
  it('does not affect other people', async () => {
    const other = newSubject();
    const attempt = await start(mode, other);
    const token = await attempt.issue();
    await cutoff();
    expect((await attempt.finish(token)).status).toBe(200);
  });
});

it('uses the time of the cutoff itself', async () => {
  vi.useRealTimers();
  const attempt = await start('browser', sub);
  const token = await attempt.issue();
  expect((await post(`/api/v1/users/${id}/cutoff`, {}, { cookie: adminCookie })).status).toBe(200);
  const res = await attempt.finish(token);
  expect(await errorCode(res)).toBe('signin_before_cutoff');
});
it('refuses a signed cookie without a start time', async () => {
  for (const extra of [{}, { begunAt: 'x' }, { begunAt: null }, { begunAt: now() + 0.5 }]) {
    const payload = base64url.encode(JSON.stringify({ nonce: 'n', exp: now() + 600, ...extra }));
    const value = `${payload}.${await sign(env.COOKIE_KEY, 'preauth-browser', payload)}`;
    const res = await post('/auth/session', { id_token: await signToken(goodClaims('n')) }, { cookie: `${PRE}=${value}` });
    expect(await errorCode(res)).toBe('signin_expired');
  }
});
