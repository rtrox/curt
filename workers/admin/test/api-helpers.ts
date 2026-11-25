import { env as rawEnv } from 'cloudflare:workers';
import type { Link } from '@curt/shared/schemas';
import { Hono } from 'hono';
import { vi } from 'vitest';
import { apiRoutes } from '../src/api/routes.ts';
import { forgetTags } from '../src/api/tagcache.ts';
import { ApiError } from '../src/lib/errors.ts';
import type { AppEnv, Auth, Env } from '../src/types.ts';

export const env = rawEnv as unknown as Env;

const person = (userId: string, isAdmin = false, over: Partial<Auth> = {}): Auth => ({
  userId, isAdmin, via: 'session', scopes: ['links', 'metrics:read'], ...over,
});
export const ana = person('u-ana');
export const ben = person('u-ben');
export const admin = person('u-admin', true);
export const metricsOnly = person('u-ana', false, { via: 'token', scopes: ['metrics:read'] });

/** Everything given to waitUntil since the last reset. */
export const background: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { background.push(p); }, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

/** KV retries wait until a test lets them run, so they cannot leak into the next test. */
let held: { ms: number; run: () => void }[] = [];
export const heldRetries = () => held.map((h) => h.ms);
export async function runRetries(): Promise<void> {
  const now = held;
  held = [];
  for (const h of now) h.run();
  await Promise.all(background);
}

/** Mounts the API behind a stand-in for the real sign-in middleware. */
export async function call(auth: Auth | null, method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; env?: Env } = {}): Promise<Response> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => { c.set('auth', auth); await next(); });
  app.route('/api/v1', apiRoutes);
  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
    return c.json({ error: { code: 'internal', message: String(err) } }, 500);
  });
  return app.request(`/api/v1${path}`, {
    method,
    headers: { ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }), ...opts.headers },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  }, opts.env ?? env, ctx);
}

export const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => r.json() as Promise<T>;
export const code = async (r: Response): Promise<string> => (await json<{ error: { code: string } }>(r)).error.code;

export async function create(auth: Auth, body: Record<string, unknown> = {}, over?: Env): Promise<Link> {
  const r = await call(auth, 'POST', '/links', { body: { destination: 'https://example.com/a', ...body }, ...(over ? { env: over } : {}) });
  if (r.status !== 201) throw new Error(`create failed: ${r.status} ${await r.text()}`);
  return json<Link>(r);
}
export const patch = (auth: Auth, l: { id: string }, version: number | string, body: unknown, over?: Env) =>
  call(auth, 'PATCH', `/links/${l.id}`, { body, headers: { 'if-match': String(version) }, ...(over ? { env: over } : {}) });

export async function reset(): Promise<void> {
  held = [];
  background.length = 0;
  vi.spyOn(scheduler, 'wait').mockImplementation((ms) => new Promise<void>((run) => { held.push({ ms, run }); }));
  await Promise.all([ana, ben, admin].map((u) => forgetTags(env, u)));
  await env.DB.batch(['tags', 'links', 'kv_deletes', 'audit', 'users'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  const insert = env.DB.prepare('INSERT INTO users (id, issuer, subject, name, email, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, 1)');
  await env.DB.batch([
    insert.bind('u-ana', 'https://id.example', 's1', 'Ana', 'ana@example.com', 0),
    insert.bind('u-ben', 'https://id.example', 's2', 'Ben', 'ben@example.com', 0),
    insert.bind('u-admin', 'https://id.example', 's3', 'Admin', null, 1),
  ]);
  const { keys } = await env.LINKS.list();
  await Promise.all(keys.map((k) => env.LINKS.delete(k.name)));
}

export interface KvHooks {
  put?: (key: string, value: string) => Promise<void> | void;
  delete?: (key: string) => Promise<void> | void;
}
/** An environment whose KV runs a hook before each real operation. A hook that throws makes the operation fail. */
export function withKv(hooks: KvHooks): Env & { ops: string[] } {
  const ops: string[] = [];
  const LINKS = {
    get: (k: string) => env.LINKS.get(k),
    put: async (k: string, v: string) => { ops.push(`put ${k}`); await hooks.put?.(k, v); await env.LINKS.put(k, v); },
    delete: async (k: string) => { ops.push(`delete ${k}`); await hooks.delete?.(k); await env.LINKS.delete(k); },
  } as unknown as KVNamespace;
  return { ...env, LINKS, ops };
}
const fail = () => { throw new Error('KV down'); };
export const brokenKv = () => withKv({ put: fail, delete: fail });

/** An environment that adds up the D1 rows read and collects query plans. */
export function measured(): Env & { rows: () => number; plans: string[] } {
  let rows = 0;
  const plans: string[] = [];
  const DB = { prepare: (sql: string) => {
    const run = async <T>(params: unknown[]) => {
      plans.push(...(await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<{ detail: string }>()).results.map((x) => x.detail));
      const r = await env.DB.prepare(sql).bind(...params).all<T>();
      rows += r.meta.rows_read;
      return r;
    };
    const bound = (...params: unknown[]) => ({ all: () => run(params), first: async () => (await run(params)).results[0] ?? null });
    return { bind: bound, ...bound() };
  } } as unknown as D1Database;
  return { ...env, DB, plans, rows: () => rows };
}
