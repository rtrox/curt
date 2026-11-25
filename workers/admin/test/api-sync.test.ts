import { decodeLink, linkKey } from '@curt/shared';
import { deletePendingSchema, linkSchema, resyncSchema } from '@curt/shared/schemas';
import type { Link } from '@curt/shared/schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { drainPending, MAX_KV_OPS, TOMBSTONE_SECONDS } from '../src/api/sync.ts';
import { admin, ana, background, ben, brokenKv, call, code, create, env, heldRetries, json, patch, reset, runRetries, withKv } from './api-helpers.ts';

beforeEach(reset);

const kv = async (l: { domain: string; slug: string }) => decodeLink(await env.LINKS.get(linkKey(l.domain, l.slug)));
const pendingDeletes = async () => (await env.DB.prepare('SELECT kv_key FROM kv_deletes ORDER BY kv_key').all<{ kv_key: string }>()).results.map((r) => r.kv_key);
const versions = async (id: string) => env.DB.prepare('SELECT version, kv_version FROM links WHERE id = ?').bind(id).first<{ version: number; kv_version: number }>();
const remove = (l: { id: string }, over = env) => call(ana, 'DELETE', `/links/${l.id}`, { env: over });

/** Makes every tombstone look this many seconds old. */
const age = (seconds: number) => env.DB.prepare('UPDATE kv_deletes SET requested_at = ?').bind(Math.floor(Date.now() / 1000) - seconds).run();
const ripen = () => age(TOMBSTONE_SECONDS);

/** Runs `action` once, on the first matching call. */
function once(action: () => Promise<unknown>) {
  let ran = false;
  return async () => { if (!ran) { ran = true; await action(); } };
}
async function seed(n: number, prefix = 'p') {
  await env.DB.batch(Array.from({ length: n }, (_, i) => env.DB.prepare(
    'INSERT INTO links (id, domain, slug, destination, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 5, 5)',
  ).bind(`${prefix}-${String(i).padStart(3, '0')}`, 'go.example', `${prefix}${i}`, 'https://example.com/', 'u-ana')));
}

describe('normal writes', () => {
  it('follow create, edit and delete', async () => {
    const l = await create(ana, { slug: 'trip' });
    expect(await kv(l)).toEqual({ id: l.id, destination: l.destination, version: 1, disabled: false, expiresAt: null });
    expect(await versions(l.id)).toEqual({ version: 1, kv_version: 1 });
    await patch(ana, l, 1, { destination: 'https://example.com/b', disabled: true });
    expect(await kv(l)).toMatchObject({ destination: 'https://example.com/b', version: 2, disabled: true });
    expect(await versions(l.id)).toEqual({ version: 2, kv_version: 2 });
    await remove(l);
    expect(await kv(l)).toBeNull();
    expect(await pendingDeletes()).toEqual([linkKey(l.domain, l.slug)]);
  });
});

describe('KV failures', () => {
  it('do not fail requests, and the drain finishes the work', async () => {
    const down = brokenKv();
    const l = await create(ana, { slug: 'trip' }, down);
    expect(await versions(l.id)).toEqual({ version: 1, kv_version: 0 });
    expect(await drainPending(env, 40)).toBe(1);
    expect(await kv(l)).toMatchObject({ version: 1 });

    expect((await patch(ana, l, 1, { destination: 'https://example.com/b' }, down)).status).toBe(200);
    expect(await kv(l)).toMatchObject({ version: 1 });
    expect(await drainPending(env, 40)).toBe(1);
    expect(await kv(l)).toMatchObject({ version: 2, destination: 'https://example.com/b' });
    expect(await versions(l.id)).toEqual({ version: 2, kv_version: 2 });

    expect((await remove(l, down)).status).toBe(202);
    expect(await pendingDeletes()).toEqual(['l:go.example:trip']);
    expect(await kv(l)).not.toBeNull();
    // Done now, although the row stays until it is old enough.
    expect(await drainPending(env, 40)).toBe(1);
    expect(await kv(l)).toBeNull();
    expect(await pendingDeletes()).toEqual(['l:go.example:trip']);
    await ripen();
    expect(await drainPending(env, 40)).toBe(1);
    expect(await pendingDeletes()).toEqual([]);
    expect(await drainPending(env, 40)).toBe(0);
  });
  it('leave the work pending while the drain also fails', async () => {
    const l = await create(ana, {}, brokenKv());
    expect(await drainPending(brokenKv(), 40)).toBe(0);
    expect(await versions(l.id)).toEqual({ version: 1, kv_version: 0 });
  });
  it('do not stop other keys in the same drain', async () => {
    await seed(3);
    const one = withKv({ put: (k) => { if (k.endsWith(':p1')) throw new Error('KV down'); } });
    expect(await drainPending(one, 40)).toBe(2);
    expect(await versions('p-001')).toEqual({ version: 1, kv_version: 0 });
    expect(await versions('p-002')).toEqual({ version: 1, kv_version: 1 });
  });
  it('D1 failing after the commit does not fail the request', async () => {
    const DB = Object.assign(Object.create(null), {
      prepare: (sql: string) => { if (sql.includes('LEFT JOIN links')) throw new Error('D1 down'); return env.DB.prepare(sql); },
      batch: (s: D1PreparedStatement[]) => env.DB.batch(s),
    }) as D1Database;
    const l = await create(ana, {}, { ...withKv({}), DB });
    expect(await versions(l.id)).toEqual({ version: 1, kv_version: 0 });
  });
});

const getLink = async (id: string, auth = ana) => linkSchema.parse(await json(await call(auth, 'GET', `/links/${id}`)));
const bodyOf = async (r: Response) => linkSchema.parse(await json(r));

describe('unconfirmed changes', () => {
  it('disable and delete say so while KV is failing, and recover', async () => {
    const down = brokenKv();
    const a = await create(ana);
    const b = await create(ana);
    expect(a).not.toHaveProperty('syncPending');

    const disabled = await patch(ana, a, 1, { disabled: true }, down);
    expect(disabled.status).toBe(200);
    expect(await bodyOf(disabled)).toMatchObject({ disabled: true, version: 2, syncPending: true });
    const deleted = await remove(b, down);
    expect(deleted.status).toBe(202);
    expect(deletePendingSchema.strict().parse(await json(deleted))).toEqual({ syncPending: true });
    expect(await kv(a)).toMatchObject({ disabled: false });
    expect(await kv(b)).not.toBeNull();

    // The retry fails as well.
    expect(heldRetries()).toEqual([1100, 1100]);
    await runRetries();
    expect(await kv(b)).not.toBeNull();

    expect(await drainPending(env, 40)).toBe(2);
    expect(await kv(a)).toMatchObject({ disabled: true });
    expect(await kv(b)).toBeNull();
    expect(await getLink(a.id)).not.toHaveProperty('syncPending');
  });
  it('are retried once in the background', async () => {
    let up = false;
    const flaky = withKv({ put: () => { if (!up) throw new Error('429'); }, delete: () => { if (!up) throw new Error('429'); } });
    const a = await create(ana);
    const b = await create(ana);
    await patch(ana, a, 1, { disabled: true }, flaky);
    await remove(b, flaky);
    up = true;
    await runRetries();
    expect(await kv(a)).toMatchObject({ disabled: true, version: 2 });
    expect(await kv(b)).toBeNull();
    expect(await versions(a.id)).toEqual({ version: 2, kv_version: 2 });
    expect(await drainPending(env, 40)).toBe(0);
    expect(heldRetries()).toEqual([]);
  });
  it('wait long enough for KV to accept another write to the same key', async () => {
    vi.mocked(scheduler.wait).mockRestore();
    const last = new Map<string, number>();
    const limited = withKv({ put: (k) => {
      if (Date.now() - (last.get(k) ?? 0) < 1000) throw new Error('429');
      last.set(k, Date.now());
    } });
    const l = await create(ana, {}, limited);
    expect(await bodyOf(await patch(ana, l, 1, { disabled: true }, limited))).toMatchObject({ syncPending: true });
    await Promise.all(background);
    expect(await kv(l)).toMatchObject({ disabled: true });
  });
  it('a retry applies the newest change, not the one it was started for', async () => {
    const l = await create(ana);
    let up = false;
    await patch(ana, l, 1, { disabled: true }, withKv({ put: () => { if (!up) throw new Error('429'); } }));
    await patch(ana, l, 2, { disabled: false, destination: 'https://example.com/new' });
    up = true;
    await runRetries();
    expect(await kv(l)).toMatchObject({ version: 3, disabled: false, destination: 'https://example.com/new' });
  });
  it('are not reported, or retried, when KV is confirmed', async () => {
    const l = await create(ana);
    expect(await bodyOf(await patch(ana, l, 1, { disabled: true }))).not.toHaveProperty('syncPending');
    expect((await remove(l)).status).toBe(204);
    expect(heldRetries()).toEqual([]);
  });
  it('stay visible when links are read again', async () => {
    const l = await create(ana, { slug: 'trip' }, brokenKv());
    expect(l.syncPending).toBe(true);
    expect((await getLink(l.id)).syncPending).toBe(true);
    const listed = async () => (await json<{ links: Link[] }>(await call(ana, 'GET', '/links'))).links[0]!;
    expect((await listed()).syncPending).toBe(true);
    await drainPending(env, 40);
    expect(await listed()).not.toHaveProperty('syncPending');
    expect(await getLink(l.id)).not.toHaveProperty('syncPending');
  });
  it('never put a link that is created disabled live', async () => {
    const values: string[] = [];
    const l = await create(ana, { disabled: true }, withKv({ put: (_, v) => { values.push(v); } }));
    expect(l.disabled).toBe(true);
    expect(values.map((v) => decodeLink(v)!.disabled)).toEqual([true]);
    const audit = await env.DB.prepare('SELECT detail FROM audit').first<{ detail: string }>();
    expect(audit!.detail).toBe('["destination","disabled"]');
  });
});

describe('client disconnects', () => {
  it.each(['create', 'update', 'delete'] as const)('%s is handed to waitUntil before KV answers', async (kind) => {
    const l = kind === 'create' ? null : await create(ana, { slug: 'trip' });
    background.length = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    let reached!: () => void;
    const atKv = new Promise<void>((r) => { reached = r; });
    const wait = async () => { reached(); await gate; };
    const slow = withKv({ put: wait, delete: wait });
    // Nobody waits for the response.
    void (kind === 'create' ? create(ana, { slug: 'trip' }, slow) : kind === 'update' ? patch(ana, l!, 1, { disabled: true }, slow) : remove(l!, slow));
    await atKv;
    expect(background.length).toBeGreaterThanOrEqual(2);
    open();
    await Promise.all(background);
    const after = await kv({ domain: 'go.example', slug: 'trip' });
    if (kind === 'delete') expect(after).toBeNull();
    else expect(after).toMatchObject({ disabled: kind === 'update' });
  });
  it('covers the D1 write too', async () => {
    background.length = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    let reached!: () => void;
    const atD1 = new Promise<void>((r) => { reached = r; });
    const DB = {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: async (st: D1PreparedStatement[]) => { reached(); await gate; return env.DB.batch(st); },
    } as unknown as D1Database;
    void create(ana, { slug: 'trip' }, { ...env, DB });
    await atD1;
    open();
    await background[0];
    expect(await env.LINKS.get('l:go.example:trip')).not.toBeNull();
  });
});

describe('trying again', () => {
  const auditRows = async () => (await env.DB.prepare('SELECT count(*) AS n FROM audit').first<{ n: number }>())!.n;
  it('a repeated delete retries KV, for the owner and for admins only', async () => {
    const l = await create(ana, { slug: 'trip' });
    expect((await remove(l, brokenKv())).status).toBe(202);
    const audits = await auditRows();
    expect((await remove(l, brokenKv())).status).toBe(202);
    expect((await call(ben, 'DELETE', `/links/${l.id}`)).status).toBe(404);
    expect(await kv(l)).not.toBeNull();
    expect((await remove(l)).status).toBe(204);
    expect(await kv(l)).toBeNull();
    expect((await call(admin, 'DELETE', `/links/${l.id}`)).status).toBe(204);
    expect((await remove(l)).status).toBe(204);
    expect(await auditRows()).toBe(audits);
    expect((await call(ana, 'DELETE', '/links/never-existed')).status).toBe(404);
  });
  it('works for the owner after an admin deleted the link', async () => {
    const l = await create(ana);
    expect((await call(admin, 'DELETE', `/links/${l.id}`, { env: brokenKv() })).status).toBe(202);
    expect((await remove(l)).status).toBe(204);
    expect(await kv(l)).toBeNull();
  });
  it('a repeated delete never removes a recreated slug', async () => {
    const old = await create(ana, { slug: 'trip' });
    await remove(old, brokenKv());
    const fresh = await create(ben, { slug: 'trip', destination: 'https://example.com/fresh' });
    const watched = withKv({});
    expect((await remove(old, watched)).status).toBe(204);
    expect(watched.ops).toEqual(['put l:go.example:trip']);
    expect(await kv(old)).toMatchObject({ id: fresh.id });
    expect((await getLink(fresh.id, ben)).id).toBe(fresh.id);
    expect((await remove(fresh)).status).toBe(404);
  });
  it('a repeated delete does not shorten the tombstone', async () => {
    const l = await create(ana, { slug: 'trip' });
    await remove(l);
    await ripen();
    expect((await remove(l)).status).toBe(204);
    expect(await pendingDeletes()).toEqual(['l:go.example:trip']);
  });
  it.each([
    ['an empty change', {}], ['the same values', { disabled: true, tags: ['b', 'a'], destination: 'https://example.com/a', expiresAt: null }],
  ])('%s retries a pending write without a new version or audit row', async (_, body) => {
    const l = await create(ana, { tags: ['a', 'b'] });
    await patch(ana, l, 1, { disabled: true }, brokenKv());
    const audits = await auditRows();
    expect(await bodyOf(await patch(ana, l, 2, body, brokenKv()))).toMatchObject({ version: 2, syncPending: true });
    expect((await patch(ben, l, 2, body)).status).toBe(404);
    expect((await patch(ana, l, 1, body)).status).toBe(412);
    expect(await kv(l)).toMatchObject({ disabled: false });
    const again = await bodyOf(await patch(ana, l, 2, body));
    expect(again).toMatchObject({ version: 2, disabled: true });
    expect(again).not.toHaveProperty('syncPending');
    expect(await kv(l)).toMatchObject({ disabled: true, version: 2 });
    expect(await auditRows()).toBe(audits);
  });
  it('leaves KV alone when nothing is pending', async () => {
    const l = await create(ana);
    const watched = withKv({});
    expect((await patch(ana, l, 1, {}, watched)).status).toBe(200);
    expect(watched.ops).toEqual([]);
  });
});

describe('drain order', () => {
  const backlog = (n: number) => env.DB.prepare(
    `INSERT INTO links (id, domain, slug, destination, owner_id, created_at, updated_at)
     WITH RECURSIVE i(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM i WHERE n < ?)
     SELECT '0-' || printf('%05d', n), 'go.example', 'b' || n, 'https://example.com/', 'u-ana', 5, 5 + n FROM i`,
  ).bind(n).run();
  it('a disable and a delete among 3,000 pending links go in the first run', async () => {
    const a = await create(ana);
    const b = await create(ana);
    await backlog(3000);
    await env.DB.prepare("UPDATE links SET disabled = 1 WHERE id > '0-02000' AND id < '1'").run(); // Disabled from the start, as an import makes them.
    await patch(ana, a, 1, { disabled: true }, brokenKv());
    await remove(b, brokenKv());
    const watched = withKv({});
    expect(await drainPending(watched, 40)).toBe(40);
    expect(watched.ops.slice(0, 2).sort()).toEqual([`delete ${linkKey(b.domain, b.slug)}`, `put ${linkKey(a.domain, a.slug)}`].sort());
    expect(await kv(a)).toMatchObject({ disabled: true });
    expect(await kv(b)).toBeNull();
  });
  it('a delete whose Worker stopped before touching KV is urgent', async () => {
    const l = await create(ana);
    await backlog(50);
    const DB = {
      prepare: (sql: string) => { if (sql.includes('LEFT JOIN links')) throw new Error('stopped'); return env.DB.prepare(sql); },
      batch: (st: D1PreparedStatement[]) => env.DB.batch(st),
    } as unknown as D1Database;
    expect((await remove(l, { ...env, DB })).status).toBe(202);
    const watched = withKv({});
    expect(await drainPending(watched, 1)).toBe(1);
    expect(watched.ops).toEqual([`delete ${linkKey(l.domain, l.slug)}`]);
  });
  it('a disable goes ahead of old tombstones, and confirmed deletes do not count as urgent', async () => {
    const a = await create(ana);
    await env.DB.prepare(
      `INSERT INTO kv_deletes (kv_key, requested_at, confirmed)
       WITH RECURSIVE i(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM i WHERE n < 500) SELECT 'l:go.example:gone' || n, n, 1 FROM i`,
    ).run();
    await patch(ana, a, 1, { disabled: true }, brokenKv());
    const watched = withKv({});
    await drainPending(watched, 1);
    expect(watched.ops).toEqual([`put ${linkKey(a.domain, a.slug)}`]);
  });
  it('urgent work may use the whole run', async () => {
    await backlog(50);
    await env.DB.prepare('UPDATE links SET disabled = 1, version = 2').run();
    await env.DB.prepare("INSERT INTO kv_deletes (kv_key, requested_at, confirmed) VALUES ('l:go.example:gone', 1, 1)").run();
    const watched = withKv({});
    await drainPending(watched, 40);
    expect(watched.ops.filter((o) => o.startsWith('put'))).toHaveLength(40);
  });
  it('a confirmed delete whose recheck fails becomes urgent again', async () => {
    const l = await create(ana);
    await remove(l);
    const confirmed = async () => (await env.DB.prepare('SELECT confirmed FROM kv_deletes').first<{ confirmed: number }>())?.confirmed;
    expect(await confirmed()).toBe(1);
    await drainPending(brokenKv(), 40);
    expect(await confirmed()).toBe(0);
    await drainPending(env, 40);
    expect(await confirmed()).toBe(1);
  });
  it('then oldest change first, whatever the ID', async () => {
    await seed(5);
    await env.DB.prepare("UPDATE links SET updated_at = 100 - CAST(substr(id, 3) AS INTEGER)").run();
    const watched = withKv({});
    await drainPending(watched, 2);
    expect(watched.ops).toEqual(['put l:go.example:p4', 'put l:go.example:p3']);
  });
});

describe('races', () => {
  it('an edit during a slow write ends with the newer value', async () => {
    const l = await create(ana);
    const slow = withKv({ put: once(() => patch(ana, l, 2, { destination: 'https://example.com/newer' })) });
    await patch(ana, l, 1, { destination: 'https://example.com/older' }, slow);
    expect(slow.ops).toHaveLength(2);
    expect(await kv(l)).toMatchObject({ version: 3, destination: 'https://example.com/newer' });
    expect(await versions(l.id)).toEqual({ version: 3, kv_version: 3 });
  });
  it('a slow write that cannot be corrected stays pending', async () => {
    const l = await create(ana);
    let puts = 0;
    const slow = withKv({ put: async () => {
      if (puts++ > 0) throw new Error('KV down');
      await patch(ana, l, 2, { destination: 'https://example.com/newer' });
    } });
    await patch(ana, l, 1, { destination: 'https://example.com/older' }, slow);
    expect(await kv(l)).toMatchObject({ version: 2 });
    expect(await versions(l.id)).toEqual({ version: 3, kv_version: 0 });
    await drainPending(env, 40);
    expect(await kv(l)).toMatchObject({ version: 3 });
  });
  it('stops after three attempts and leaves the rest pending', async () => {
    const l = await create(ana);
    let v = 2;
    const busy = withKv({ put: async () => { await env.DB.prepare('UPDATE links SET version = ?').bind(++v).run(); } });
    expect((await patch(ana, l, 1, { disabled: true }, busy)).status).toBe(200);
    expect(busy.ops).toHaveLength(3);
    expect(await versions(l.id)).toEqual({ version: 5, kv_version: 0 });
  });
  it('a delete during a slow write does not leave the link in KV', async () => {
    const l = await create(ana);
    const slow = withKv({ put: once(() => remove(l)) });
    await patch(ana, l, 1, { disabled: true }, slow);
    expect(await kv(l)).toBeNull();
  });
  it('a delete during a slow write is remembered when KV then fails', async () => {
    const l = await create(ana, { slug: 'trip' });
    const slow = withKv({ put: once(() => remove(l)), delete: () => { throw new Error('KV down'); } });
    await patch(ana, l, 1, { disabled: true }, slow);
    expect(await pendingDeletes()).toEqual(['l:go.example:trip']);
    await drainPending(env, 40);
    expect(await kv(l)).toBeNull();
  });
});

describe('delete then recreate', () => {
  it('a pending delete does not remove the new entry', async () => {
    const old = await create(ana, { slug: 'trip' });
    await remove(old, brokenKv());
    const fresh = await create(ben, { slug: 'trip', destination: 'https://example.com/fresh' });
    for (const seconds of [0, TOMBSTONE_SECONDS]) {
      expect(await pendingDeletes()).toEqual(['l:go.example:trip']);
      await age(seconds);
      const watched = withKv({});
      await drainPending(watched, 40);
      expect(watched.ops).toEqual(['put l:go.example:trip']);
      expect(await kv(fresh)).toMatchObject({ id: fresh.id });
    }
    expect(await pendingDeletes()).toEqual([]);
  });
  it('replaces the old entry even when the new write fails at first', async () => {
    const old = await create(ana, { slug: 'trip' });
    await remove(old, brokenKv());
    const fresh = await create(ben, { slug: 'trip' }, brokenKv());
    expect(await kv(old)).toMatchObject({ id: old.id });
    await drainPending(env, 40);
    expect(await kv(fresh)).toMatchObject({ id: fresh.id });
  });
  it.each(['drain', 'request'])('a recreate in the middle of a delete by the %s is restored', async (by) => {
    const old = await create(ana, { slug: 'trip' });
    let fresh: Link | undefined;
    const slow = withKv({ delete: once(async () => { fresh = await create(ben, { slug: 'trip' }); }) });
    if (by === 'drain') {
      await remove(old, brokenKv());
      await drainPending(slow, 40);
    } else {
      await remove(old, slow);
    }
    expect(slow.ops).toEqual(['delete l:go.example:trip', 'put l:go.example:trip']);
    expect(await kv(old)).toMatchObject({ id: fresh!.id });
    expect(await versions(fresh!.id)).toEqual({ version: 1, kv_version: 1 });
  });
});

describe('tombstones', () => {
  /** The old value lands in KV after the delete, and the Worker that wrote it never gets to check. */
  async function crash() {
    const l = await create(ana, { slug: 'trip' });
    const stale = (await env.LINKS.get(linkKey(l.domain, l.slug)))!;
    expect((await remove(l)).status).toBe(204);
    return { l, latePut: () => env.LINKS.put('l:go.example:trip', stale) };
  }
  it('clean up a late write whose Worker died', async () => {
    const { l, latePut } = await crash();
    await latePut();
    await ripen();
    expect(await drainPending(env, 40)).toBe(1);
    expect(await kv(l)).toBeNull();
    expect(await pendingDeletes()).toEqual([]);
  });
  it('outlast drains that run before the late write', async () => {
    const { l, latePut } = await crash();
    await age(TOMBSTONE_SECONDS - 30);
    expect(await drainPending(env, 40)).toBe(0);
    await latePut();
    expect(await pendingDeletes()).toEqual(['l:go.example:trip']);
    await ripen();
    await drainPending(env, 40);
    expect(await kv(l)).toBeNull();
  });
  it('stay when the second delete fails', async () => {
    const { l, latePut } = await crash();
    await latePut();
    await ripen();
    expect(await drainPending(brokenKv(), 40)).toBe(0);
    expect(await pendingDeletes()).toEqual(['l:go.example:trip']);
    await drainPending(env, 40);
    expect(await kv(l)).toBeNull();
  });
  it('restore a recreated slug that a late write overwrote', async () => {
    const { l, latePut } = await crash();
    const fresh = await create(ben, { slug: 'trip', destination: 'https://example.com/fresh' });
    await latePut();
    expect(await kv(l)).toMatchObject({ id: l.id });
    await ripen();
    const watched = withKv({});
    expect(await drainPending(watched, 40)).toBe(1);
    expect(watched.ops).toEqual(['put l:go.example:trip']);
    expect(await kv(l)).toMatchObject({ id: fresh.id, destination: 'https://example.com/fresh' });
    expect(await pendingDeletes()).toEqual([]);
  });
  it('start again when the slug is deleted again', async () => {
    await crash();
    await ripen();
    const fresh = await create(ana, { slug: 'trip' });
    await remove(fresh);
    expect(await drainPending(env, 40)).toBe(0);
    expect(await pendingDeletes()).toEqual(['l:go.example:trip']);
  });
  it('do not starve writes, nor writes them', async () => {
    const tombstones = (n: number) => env.DB.batch(Array.from({ length: n }, (_, i) => env.DB.prepare('INSERT INTO kv_deletes (kv_key, requested_at, confirmed) VALUES (?, 1, 1)').bind(`l:go.example:gone${i}`)));
    await seed(50);
    await tombstones(100);
    const first = withKv({});
    expect(await drainPending(first, 40)).toBe(40);
    const kinds = (ops: string[]) => [ops.filter((o) => o.startsWith('put')).length, ops.filter((o) => o.startsWith('delete')).length];
    expect(kinds(first.ops)).toEqual([30, 10]);
    const second = withKv({});
    await drainPending(second, 40);
    expect(kinds(second.ops)).toEqual([20, 20]);
    const third = withKv({});
    await drainPending(third, 40);
    expect(kinds(third.ops)).toEqual([0, 40]);
    expect(await drainPending(env, 40)).toBe(30);
    expect(await pendingDeletes()).toEqual([]);
    await seed(1, 'q');
    await tombstones(5);
    const single = withKv({});
    await drainPending(single, 1);
    expect(single.ops).toEqual(['put l:go.example:q0']);
  });
});

describe('limits', () => {
  it('drains at most what was asked, and never more than the cap', async () => {
    await seed(MAX_KV_OPS + 10);
    const a = withKv({});
    expect(await drainPending(a, 5)).toBe(5);
    expect(a.ops).toHaveLength(5);
    const b = withKv({});
    expect(await drainPending(b, 1000)).toBe(MAX_KV_OPS);
    expect(b.ops).toHaveLength(MAX_KV_OPS);
    expect(await drainPending(env, 1000)).toBe(5);
    for (const n of [0, -1, NaN]) expect(await drainPending(env, n)).toBe(0);
  });
  it('counts retries and deletes against the cap', async () => {
    await seed(30);
    await env.DB.batch(Array.from({ length: 30 }, (_, i) => env.DB.prepare('INSERT INTO kv_deletes (kv_key, requested_at, confirmed) VALUES (?, 1, 1)').bind(`l:go.example:gone${i}`)));
    // Every write finds its link changed afterwards, so all of them want to be retried.
    const busy = withKv({ put: async (k) => { await env.DB.prepare("UPDATE links SET version = version + 1 WHERE 'l:go.example:' || slug = ?").bind(k).run(); } });
    await drainPending(busy, 1000);
    expect(busy.ops).toHaveLength(MAX_KV_OPS);
  });
  it('resyncs in bounded pages until the cursor runs out', async () => {
    await seed(MAX_KV_OPS * 2 + 1);
    await env.DB.prepare('UPDATE links SET kv_version = version').run();
    let cursor: string | null = null;
    const pages: number[] = [];
    do {
      const watched = withKv({});
      const r: ReturnType<typeof resyncSchema.parse> =
        resyncSchema.strict().parse(await json(await call(admin, 'POST', `/admin/resync${cursor ? `?cursor=${cursor}` : ''}`, { env: watched })));
      expect(watched.ops.length).toBeLessThanOrEqual(MAX_KV_OPS);
      expect(r.failed).toBe(0);
      pages.push(r.synced);
      cursor = r.nextCursor;
    } while (cursor && pages.length < 9);
    expect(pages).toEqual([MAX_KV_OPS, MAX_KV_OPS, 1]);
    expect((await env.LINKS.list()).keys).toHaveLength(MAX_KV_OPS * 2 + 1);
  });
  it('resync failures are reported and left pending', async () => {
    await seed(2);
    await env.DB.prepare('UPDATE links SET kv_version = version').run();
    expect(await json(await call(admin, 'POST', '/admin/resync', { env: brokenKv() }))).toEqual({ synced: 0, failed: 2, nextCursor: null });
    expect(await drainPending(env, 40)).toBe(2);
  });
  it('resync is for admins and validates its cursor', async () => {
    expect((await call(ana, 'POST', '/admin/resync')).status).toBe(403);
    const r = await call(admin, 'POST', `/admin/resync?cursor=${btoa('l:1:x').replaceAll('=', '')}`);
    expect([r.status, await code(r)]).toEqual([400, 'invalid_cursor']);
  });
});
