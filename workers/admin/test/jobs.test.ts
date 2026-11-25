import { env as rawEnv } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { drainPending } from '../src/api/sync.ts';
import { runMaintenance as run } from '../src/jobs/maintenance.ts';
import type { Env } from '../src/types.ts';

const env = rawEnv as unknown as Env;
const now = new Date('2026-11-25T23:07:00Z');
const drain = vi.fn<typeof drainPending>();
const runMaintenance = (e: Env, t: Date) => run(e, t, drain);

beforeEach(async () => {
  for (const k of (await env.LINKS.list()).keys) await env.LINKS.delete(k.name);
  await env.DB.batch([env.DB.prepare('DELETE FROM sessions'), env.DB.prepare('DELETE FROM users'),
    env.DB.prepare("INSERT INTO users (id, issuer, subject, created_at) VALUES ('u', 'i', 'u', 0)")]);
  drain.mockReset().mockResolvedValue(0);
});
afterEach(() => vi.restoreAllMocks());

const at = Math.floor(now.getTime() / 1000);
const addSession = (id: string, expires: number) => env.DB.prepare("INSERT INTO sessions VALUES (?1, 'u', ?2)").bind(id, expires).run();
const sessions = async () => (await env.DB.prepare('SELECT id_hash FROM sessions ORDER BY id_hash').all<{ id_hash: string }>()).results.map((r) => r.id_hash);

it('drains at most 40 pending items', async () => {
  await runMaintenance(env, now);
  expect(drain).toHaveBeenCalledExactlyOnceWith(env, 40);
});

it('creates different salts for today and tomorrow, 48 hours from the start of each day', async () => {
  const put = vi.fn(async () => {});
  const fake = { ...env, LINKS: { get: async () => null, put } } as unknown as Env;
  await runMaintenance(fake, now);
  const calls = put.mock.calls as unknown as [string, string, { expirationTtl: number }][];
  expect(calls.map((c) => c[0])).toEqual(['salt:2026-11-25', 'salt:2026-11-26']);
  for (const [, salt] of calls) {
    expect(salt).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(atob(salt.replace(/-/g, '+').replace(/_/g, '/'))).toHaveLength(32);
  }
  expect(calls[0]![1]).not.toBe(calls[1]![1]);
  const expiry = calls.map((c) => new Date(now.getTime() + c[2].expirationTtl * 1000).toISOString());
  expect(expiry).toEqual(['2026-11-27T00:00:00.000Z', '2026-11-28T00:00:00.000Z']);
});

it('never replaces a salt', async () => {
  await env.LINKS.put('salt:2026-11-25', 'existing');
  await runMaintenance(env, now);
  const tomorrow = await env.LINKS.get('salt:2026-11-26');
  await runMaintenance(env, now);
  expect(await env.LINKS.get('salt:2026-11-25')).toBe('existing');
  expect(tomorrow).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await env.LINKS.get('salt:2026-11-26')).toBe(tomorrow);
  await runMaintenance(env, new Date('2026-11-26T00:07:00Z'));
  expect(await env.LINKS.get('salt:2026-11-26')).toBe(tomorrow);
});

it('does not write a salt when it cannot tell whether one exists', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const put = vi.fn();
  await runMaintenance({ ...env, LINKS: { get: async () => { throw new Error('kv'); }, put } } as unknown as Env, now);
  expect(put).not.toHaveBeenCalled();
});

it('deletes only expired sessions', async () => {
  await addSession('old', at - 1);
  await addSession('edge', at);
  await addSession('live', at + 60);
  await runMaintenance(env, now);
  expect(await sessions()).toEqual(['live']);
});

it('deletes only expired nonces', async () => {
  await env.DB.prepare('DELETE FROM used_nonces').run();
  await env.DB.batch([['old', at - 1], ['edge', at], ['live', at + 60]].map(([id, exp]) =>
    env.DB.prepare('INSERT INTO used_nonces VALUES (?, ?)').bind(id, exp)));
  await runMaintenance(env, now);
  const left = await env.DB.prepare('SELECT nonce_hash FROM used_nonces').all();
  expect(left.results).toEqual([{ nonce_hash: 'live' }]);
});

it('keeps going after failures and logs only step names', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  drain.mockRejectedValue(new Error('secret detail'));
  await addSession('old', at - 1);
  const LINKS = { get: async (k: string) => { if (k.endsWith('25')) throw new Error('secret detail'); return null; }, put: vi.fn(async () => {}) };
  await runMaintenance({ ...env, LINKS } as unknown as Env, now);
  expect(LINKS.put).toHaveBeenCalledOnce();
  expect(await sessions()).toEqual([]);
  expect(log.mock.calls).toEqual([['maintenance step failed:', 'salt today'], ['maintenance step failed:', 'drain pending']]);
});

it('survives a broken database', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await runMaintenance({ ...env, DB: { prepare: () => { throw new Error('db'); } } } as unknown as Env, now);
  expect(log.mock.calls).toEqual([['maintenance step failed:', 'expired sessions'], ['maintenance step failed:', 'expired nonces']]);
  expect(drain).toHaveBeenCalledOnce();
});
