import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env as testEnv } from 'cloudflare:workers';
import { encodeLink, linkKey } from '@curt/shared';
import type { KvLink } from '@curt/shared';
import worker from '../src/index.ts';
import type { Env } from '../src/index.ts';

export const DOMAINS = '[{"host":"go.example","root":"https://example.com/home"},{"host":"s.example","root":"https://example.com/s"}]';

export interface Point {
  indexes: string[];
  blobs: string[];
  doubles: number[];
}

/** Real KV and D1, with every KV and D1 call counted and clicks captured. */
export function setup(overrides: Partial<Env> = {}) {
  const real = testEnv as unknown as Env;
  const points: Point[] = [];
  const calls = { kvGet: [] as string[], kvPut: 0, d1: 0, sessions: [] as unknown[] };
  const LINKS = {
    get: (key: string) => (calls.kvGet.push(key), real.LINKS.get(key)),
    put: async () => void calls.kvPut++,
    delete: async () => void calls.kvPut++,
  } as unknown as KVNamespace;
  const DB = {
    withSession: (mode: string) => (calls.d1++, calls.sessions.push(mode), real.DB.withSession(mode)),
    prepare: (sql: string) => (calls.d1++, real.DB.prepare(sql)),
  } as unknown as D1Database;
  const CLICKS = { writeDataPoint: (p: Point) => void points.push(p) } as unknown as AnalyticsEngineDataset;
  const env: Env = { LINKS, DB, CLICKS, DOMAINS, VISITOR_MODE: 'off', ...overrides };
  const send = async (url: string, init: RequestInit<IncomingRequestCfProperties> = {}) => {
    const ctx = createExecutionContext();
    const request = new Request(url, init) as Request<unknown, IncomingRequestCfProperties>;
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  };
  return { real, env, points, calls, send };
}

export function kvPut(domain: string, slug: string, link: Partial<KvLink> = {}): Promise<void> {
  const value = { id: `id-${slug}`, destination: 'https://example.com/kv', version: 1, disabled: false, expiresAt: null, ...link };
  return (testEnv as unknown as Env).LINKS.put(linkKey(domain, slug), encodeLink(value));
}

export async function d1Put(domain: string, slug: string, link: Partial<KvLink> = {}): Promise<void> {
  const db = (testEnv as unknown as Env).DB;
  await db.prepare("INSERT OR IGNORE INTO users (id, issuer, subject, created_at) VALUES ('u', 'https://id.example', 's', 0)").run();
  await db
    .prepare('INSERT INTO links (id, domain, slug, destination, owner_id, disabled, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)')
    .bind(link.id ?? `d1-${domain}-${slug}`, domain, slug, link.destination ?? 'https://example.com/d1', 'u', link.disabled ? 1 : 0, link.expiresAt ?? null)
    .run();
}

export const now = () => Math.floor(Date.now() / 1000);

export const failing = (name: string) =>
  new Proxy({}, { get: () => () => { throw new Error(`${name} failed`); } });

export const brokenKv = failing('KV') as KVNamespace;
export const brokenD1 = failing('D1') as D1Database;
