import { createdTokenSchema, cutoffSchema, userListSchema } from '@curt/shared/schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browserEnv, call, env, errorCode, newSubject, now, post, signIn } from './auth-helpers.ts';

interface Person { id: string; sub: string; cookie: string }
async function person(admin = false, over: Record<string, unknown> = {}): Promise<Person> {
  const sub = newSubject();
  const { cookie } = await signIn({ sub, groups: admin ? ['links', 'links-admin'] : ['links'], ...over });
  const row = await env.DB.prepare('SELECT id FROM users WHERE subject = ?').bind(sub).first<{ id: string }>();
  return { id: row?.id ?? '', sub, cookie };
}
async function token(p: Person, scope: 'links' | 'metrics:read' = 'links') {
  const res = await post('/api/v1/tokens', { name: 't', scope }, { cookie: p.cookie });
  expect(res.status).toBe(201);
  return createdTokenSchema.parse(await res.json());
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const cutoff = (id: string, headers: Record<string, string>) => post(`/api/v1/users/${id}/cutoff`, {}, headers);
const sessionStatus = async (cookie: string) => (await call('/api/v1/tokens', { headers: { cookie } })).status;
/** 404 from an unknown endpoint means the token was accepted. */
const tokenStatus = async (t: string) => (await call('/api/v1/nope', { headers: bearer(t) })).status;
const all = async (sql: string, ...v: unknown[]) => (await env.DB.prepare(sql).bind(...v).all()).results;
const isAdmin = async (id: string) => (await all('SELECT is_admin FROM users WHERE id = ?', id))[0]?.is_admin;
const audit = () => all("SELECT user_id, link_id, detail, at FROM audit WHERE action = 'user.cutoff'");

let admin: Person;
let target: Person;
beforeEach(async () => {
  for (const t of ['audit', 'links', 'api_tokens', 'sessions', 'users']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  admin = await person(true);
  target = await person();
});

describe('listing people', () => {
  it('counts only active sessions and tokens', async () => {
    await signIn({ sub: target.sub, name: 'Example Person', email: 'person@example.com' });
    await token(target);
    const expired = await token(target);
    const revoked = await token(target);
    await env.DB.prepare('UPDATE api_tokens SET expires_at = ? WHERE id = ?').bind(now(), expired.id).run();
    await env.DB.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ?').bind(now(), revoked.id).run();
    await env.DB.prepare("INSERT INTO sessions (id_hash, user_id, expires_at) VALUES ('old', ?, ?)").bind(target.id, now()).run();
    const res = await call('/api/v1/users', { headers: { cookie: admin.cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { users } = userListSchema.parse(await res.json());
    expect(users).toHaveLength(2);
    expect(users.find((u) => u.id === target.id)).toEqual({ id: target.id, name: 'Example Person', email: 'person@example.com', isAdmin: false, activeSessions: 2, activeTokens: 1 });
    expect(users.find((u) => u.id === admin.id)).toMatchObject({ isAdmin: true, activeSessions: 1, activeTokens: 0 });
  });
});

describe('who may do it', () => {
  it('refuses members, tokens and anonymous callers, changing nothing', async () => {
    const other = await person();
    const links = await token(admin);
    const metrics = await token(admin, 'metrics:read');
    const attempts: Array<[Record<string, string>, number, string]> = [
      [{}, 401, 'unauthenticated'],
      [{ cookie: other.cookie }, 403, 'forbidden'],
      [bearer(links.token), 403, 'session_required'],
      [bearer(metrics.token), 403, 'session_required'],
      [{ ...bearer(links.token), cookie: admin.cookie }, 403, 'session_required'],
    ];
    for (const [headers, status, code] of attempts) {
      for (const res of [await cutoff(target.id, headers), await call('/api/v1/users', { headers })]) {
        expect(res.status).toBe(status);
        expect(await errorCode(res)).toBe(code);
      }
    }
    expect(await sessionStatus(target.cookie)).toBe(200);
    expect(await audit()).toEqual([]);
  });
  it('refuses yourself', async () => {
    const res = await cutoff(admin.id, { cookie: admin.cookie });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('cannot_cut_off_self');
    expect(await sessionStatus(admin.cookie)).toBe(200);
    expect(await isAdmin(admin.id)).toBe(1);
    expect(await audit()).toEqual([]);
  });
  it('answers 404 for an unknown ID', async () => {
    const res = await cutoff(crypto.randomUUID(), { cookie: admin.cookie });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('not_found');
    expect(await audit()).toEqual([]);
  });
  it('enforces the Origin', async () => {
    const res = await cutoff(target.id, { cookie: admin.cookie, origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('bad_origin');
    expect(await sessionStatus(target.cookie)).toBe(200);
  });
});

describe('cutoff', () => {
  it('ends every session and token at once and clears admin, for that person only', async () => {
    const victim = await person(true);
    const second = (await signIn({ sub: victim.sub, groups: ['links', 'links-admin'] })).cookie;
    const tokens = [await token(victim), await token(victim, 'metrics:read')];
    const bystander = await person(true);
    const bystanderToken = await token(bystander);
    const adminToken = await token(admin);
    expect(await sessionStatus(victim.cookie)).toBe(200);
    for (const t of tokens) expect(await tokenStatus(t.token)).toBe(404);

    const res = await cutoff(victim.id, { cookie: admin.cookie });
    expect(res.status).toBe(200);
    expect(cutoffSchema.strict().parse(await res.json())).toEqual({ sessionsEnded: 2, tokensRevoked: 2 });

    for (const cookie of [victim.cookie, second]) expect(await sessionStatus(cookie)).toBe(401);
    for (const t of tokens) expect(await tokenStatus(t.token)).toBe(401);
    expect(await isAdmin(victim.id)).toBe(0);
    for (const p of [admin, bystander, target]) expect(await sessionStatus(p.cookie)).toBe(200);
    for (const t of [bystanderToken, adminToken]) expect(await tokenStatus(t.token)).toBe(404);
    expect(await isAdmin(bystander.id)).toBe(1);
    expect(await isAdmin(admin.id)).toBe(1);
  });
  it('leaves links alone', async () => {
    await env.DB.prepare("INSERT INTO links (id, domain, slug, destination, owner_id, created_at, updated_at) VALUES ('l1', 'go.example', 'abc', 'https://example.com', ?, 1, 1)").bind(target.id).run();
    const before = await all('SELECT * FROM links');
    await cutoff(target.id, { cookie: admin.cookie });
    expect(await all('SELECT * FROM links')).toEqual(before);
  });
  it('writes an audit row naming only the target', async () => {
    await cutoff(target.id, { cookie: admin.cookie });
    const rows = await audit();
    expect(rows).toEqual([{ user_id: admin.id, link_id: null, detail: target.id, at: expect.any(Number) }]);
    expect(Math.abs(Number(rows[0]?.at) - now())).toBeLessThan(5);
  });
  it('is harmless to repeat and keeps the original revocation time', async () => {
    const t = await token(target);
    await cutoff(target.id, { cookie: admin.cookie });
    await env.DB.prepare('UPDATE api_tokens SET revoked_at = 5 WHERE id = ?').bind(t.id).run();
    const res = await cutoff(target.id, { cookie: admin.cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionsEnded: 0, tokensRevoked: 0 });
    expect(await all('SELECT revoked_at FROM api_tokens WHERE id = ?', t.id)).toEqual([{ revoked_at: 5 }]);
  });
  it('changes nothing when part of the batch fails', async () => {
    const t = await token(target);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    await env.DB.exec("CREATE TRIGGER no_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(FAIL, 'no'); END");
    expect((await cutoff(target.id, { cookie: admin.cookie })).status).toBe(500);
    await env.DB.exec('DROP TRIGGER no_audit');
    quiet.mockRestore();
    expect(await sessionStatus(target.cookie)).toBe(200);
    expect(await tokenStatus(t.token)).toBe(404);
  });
  it('does not let a request already in flight leave a new token behind', async () => {
    // Cuts the person off after they were authenticated but before the token is inserted.
    const DB = {
      prepare: (sql: string) => {
        const stmt = env.DB.prepare(sql);
        if (!sql.startsWith('INSERT INTO api_tokens')) return stmt;
        return { bind: (...v: unknown[]) => ({ run: async () => { await cutoff(target.id, { cookie: admin.cookie }); return stmt.bind(...v).run(); } }) };
      },
      batch: env.DB.batch.bind(env.DB),
    } as unknown as D1Database;
    const res = await post('/api/v1/tokens', { name: 't', scope: 'links' }, { cookie: target.cookie }, { ...browserEnv, DB });
    expect(res.status).toBe(401);
    expect(await all('SELECT id FROM api_tokens WHERE user_id = ?', target.id)).toEqual([]);
  });
  it('records the time for that person only and moves it forward, never back', async () => {
    const at = async (id: string) => Number((await all('SELECT cutoff_at FROM users WHERE id = ?', id))[0]?.cutoff_at);
    await cutoff(target.id, { cookie: admin.cookie });
    expect(Math.abs((await at(target.id)) - now())).toBeLessThan(5);
    expect(await all('SELECT id FROM users WHERE cutoff_at IS NOT NULL')).toEqual([{ id: target.id }]);
    await env.DB.prepare('UPDATE users SET cutoff_at = 5 WHERE id = ?').bind(target.id).run();
    await cutoff(target.id, { cookie: admin.cookie });
    expect(Math.abs((await at(target.id)) - now())).toBeLessThan(5);
    const later = now() + 1000;
    await env.DB.prepare('UPDATE users SET cutoff_at = ? WHERE id = ?').bind(later, target.id).run();
    await cutoff(target.id, { cookie: admin.cookie });
    expect(await at(target.id)).toBe(later);
  });
});
