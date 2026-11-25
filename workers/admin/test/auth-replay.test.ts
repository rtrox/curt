import { beforeEach, describe, expect, it, vi } from 'vitest';
import { begin, call, cookies, env, errorCode, goodClaims, newSubject, now, pair, post, SESSION, signedIn, signIn, signToken } from './auth-helpers.ts';

/** A sign-in whose cookie and token are kept for posting again. */
async function attempt(claims: Record<string, unknown> = {}) {
  const { nonce, cookie } = await begin();
  const sub = newSubject();
  const id_token = await signToken({ ...goodClaims(nonce), sub, groups: ['links', 'links-admin'], ...claims });
  return { sub: String(claims.sub ?? sub), nonce, send: () => post('/auth/session', { id_token }, { cookie }) };
}
const user = (sub: string) => env.DB.prepare('SELECT id, is_admin, (SELECT count(*) FROM sessions WHERE user_id = users.id) AS sessions FROM users WHERE subject = ?')
  .bind(sub).first<{ id: string; is_admin: number; sessions: number }>();
const nonces = async () => (await env.DB.prepare('SELECT nonce_hash, expires_at FROM used_nonces').all<{ nonce_hash: string; expires_at: number }>()).results;

async function expectUsed(res: Response) {
  expect(res.status).toBe(400);
  expect(await errorCode(res)).toBe('signin_expired');
  expect(cookies(res).has(SESSION)).toBe(false);
}

beforeEach(async () => { for (const t of ['audit', 'api_tokens', 'sessions', 'users', 'used_nonces']) await env.DB.prepare(`DELETE FROM ${t}`).run(); });

describe('replaying a kept cookie and token', () => {
  it('fails after success, without changing the person', async () => {
    const a = await attempt();
    const first = await a.send();
    expect(first.status).toBe(200);
    await expectUsed(await a.send());
    expect(await user(a.sub)).toMatchObject({ is_admin: 1, sessions: 1 });
    expect(await signedIn(pair(cookies(first).get(SESSION)))).toBe(true);
  });
  it('fails after logout', async () => {
    const a = await attempt();
    const cookie = pair(cookies(await a.send()).get(SESSION));
    await post('/auth/logout', {}, { cookie });
    await expectUsed(await a.send());
    expect(await user(a.sub)).toMatchObject({ sessions: 0 });
  });
  it('fails after a cutoff and admin stays cleared', async () => {
    const admin = await signIn({ groups: ['links', 'links-admin'] });
    const a = await attempt();
    expect((await a.send()).status).toBe(200);
    const id = (await user(a.sub))?.id;
    expect((await post(`/api/v1/users/${id}/cutoff`, {}, { cookie: admin.cookie })).status).toBe(200);
    await expectUsed(await a.send());
    expect(await user(a.sub)).toEqual({ id, is_admin: 0, sessions: 0 });
  });
  it('lets exactly one of several simultaneous posts through', async () => {
    const a = await attempt();
    const statuses = (await Promise.all(Array.from({ length: 8 }, a.send))).map((r) => r.status).sort();
    expect(statuses).toEqual([200, ...Array<number>(7).fill(400)]);
    expect(await user(a.sub)).toMatchObject({ sessions: 1 });
  });
  it('fails for a second token with the same nonce', async () => {
    const { nonce, cookie } = await begin();
    const send = async (sub: string) => post('/auth/session', { id_token: await signToken({ ...goodClaims(nonce), sub }) }, { cookie });
    expect((await send('one')).status).toBe(200);
    await expectUsed(await send('two'));
    expect(await user('two')).toBe(null);
  });
  it.each([['not_allowed', []], ['groups_missing', undefined]])('fails after %s', async (code, groups) => {
    const { nonce, cookie } = await begin();
    const send = async (g: unknown) => post('/auth/session', { id_token: await signToken({ ...goodClaims(nonce), groups: g }) }, { cookie });
    const res = await send(groups);
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe(code);
    await expectUsed(await send(groups));
    await expectUsed(await send(['links']));
    expect(await nonces()).toHaveLength(1);
  });
});

describe('the stored nonce', () => {
  it('is a hash, kept past the last moment the cookie or token could be accepted', async () => {
    const a = await attempt();
    await a.send();
    const [row, extra] = await nonces();
    expect(extra).toBe(undefined);
    expect(row?.nonce_hash).not.toContain(a.nonce);
    // Cookie: 10 minutes. Token: 10 minutes plus a minute of clock skew either way.
    expect(row?.expires_at).toBeGreaterThan(now() + 720);
  });
  it('outlives the attempt even at the edge', async () => {
    const a = await attempt({ iat: now() + 55, exp: now() + 99_999 });
    await a.send();
    const [row] = await nonces();
    await env.DB.prepare('DELETE FROM used_nonces').run();
    vi.useFakeTimers({ now: (row?.expires_at ?? 0) * 1000, toFake: ['Date'] });
    try {
      expect((await a.send()).status).toBe(400);
      expect(await user(a.sub)).toMatchObject({ sessions: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('refusal with not_allowed', () => {
  it('ends sessions and admin, keeps API tokens, and leaves others alone', async () => {
    const sub = newSubject();
    const one = await signIn({ sub, groups: ['links', 'links-admin'] });
    const two = await signIn({ sub, groups: ['links', 'links-admin'] });
    const other = await signIn();
    const { token } = await (await post('/api/v1/tokens', { name: 't', scope: 'links' }, { cookie: one.cookie })).json<{ token: string }>();
    expect((await signIn({ sub, groups: ['others'] })).res.status).toBe(403);
    expect(await user(sub)).toMatchObject({ is_admin: 0, sessions: 0 });
    for (const s of [one, two]) expect(await signedIn(s.cookie)).toBe(false);
    expect(await signedIn(other.cookie)).toBe(true);
    expect((await call('/api/v1/nope', { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
  });
  it('does not end sessions when the claim is only missing', async () => {
    const sub = newSubject();
    const s = await signIn({ sub, groups: ['links', 'links-admin'] });
    expect((await signIn({ sub, groups: undefined })).res.status).toBe(403);
    expect(await signedIn(s.cookie)).toBe(true);
    expect(await user(sub)).toMatchObject({ is_admin: 1 });
  });
  it('cannot be replayed against someone let back in', async () => {
    const a = await attempt({ groups: [] });
    expect((await a.send()).status).toBe(403);
    const back = await signIn({ sub: a.sub, groups: ['links', 'links-admin'] });
    await expectUsed(await a.send());
    expect(await signedIn(back.cookie)).toBe(true);
    expect(await user(a.sub)).toMatchObject({ is_admin: 1 });
  });
});
