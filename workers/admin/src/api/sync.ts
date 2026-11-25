import { encodeLink, linkKey } from '@curt/shared';
import type { Env } from '../types.ts';

/** The free plan limits subrequests, so no single call does more KV operations than this. */
export const MAX_KV_OPS = 40;
const ROUNDS = 3;
/** KV takes one write per second per key, so a failed write is worth one more try after that. */
export const RETRY_DELAY_MS = 1100;
/**
 * A kv_deletes row outlives the delete it asks for. If a Worker writes an old value late and dies before it can
 * check, the row makes a later drain look at that key again. Far longer than any request can hold a write back.
 *
 * Until `confirmed`, the row is a link that may still redirect, and is urgent. Afterwards it is only a tombstone.
 */
export const TOMBSTONE_SECONDS = 600;
/** Share of a drain kept for rechecking tombstones when there are more ordinary writes than it can do. */
const TOMBSTONE_SHARE = 1 / 4;

export interface Target { domain: string; slug: string }

/** What D1 says about a key right now. `id` is null when no link owns it. */
interface State extends Target {
  id: string | null;
  destination: string | null;
  version: number | null;
  disabled: number | null;
  expires_at: number | null;
}

// Lists go to D1 as one JSON parameter: it caps bound parameters per statement and statements per request.
// Results keep the order of the list, so the most urgent come first.
async function readState(env: Env, targets: readonly Target[]): Promise<State[]> {
  const { results } = await env.DB.prepare(
    `SELECT j.domain, j.slug, l.id, l.destination, l.version, l.disabled, l.expires_at
     FROM (SELECT key, json_extract(value, '$.domain') AS domain, json_extract(value, '$.slug') AS slug FROM json_each(?1)) j
     LEFT JOIN links l ON l.domain = j.domain AND l.slug = j.slug ORDER BY j.key`,
  ).bind(JSON.stringify(targets.map(({ domain, slug }) => ({ domain, slug })))).all<State>();
  return results;
}

async function writeKv(env: Env, s: State): Promise<void> {
  const key = linkKey(s.domain, s.slug);
  if (s.id === null) {
    await env.LINKS.delete(key);
    return;
  }
  await env.LINKS.put(key, encodeLink({
    id: s.id, destination: s.destination!, version: s.version!, disabled: s.disabled === 1, expiresAt: s.expires_at,
  }));
}

const json = (states: readonly State[]) =>
  JSON.stringify(states.map(({ domain, slug, id, version }) => ({ key: linkKey(domain, slug), domain, slug, id, version })));

// The keys in ?1 that D1 still describes the same way.
const UNCHANGED_KEYS = `
  SELECT json_extract(j.value, '$.key') FROM json_each(?1) j
  LEFT JOIN links l ON l.domain = json_extract(j.value, '$.domain') AND l.slug = json_extract(j.value, '$.slug')
  WHERE l.id IS json_extract(j.value, '$.id') AND l.version IS json_extract(j.value, '$.version')`;

/**
 * Records that KV now matches, and drops tombstones requested at or before `dropBefore`.
 * Each statement rechecks D1, so a change made since the last read stays pending.
 */
async function markDone(env: Env, states: readonly State[], dropBefore: number): Promise<void> {
  if (states.length === 0) return;
  const param = json(states);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE links SET kv_version = j.version
       FROM (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.version') AS version FROM json_each(?1)) AS j
       WHERE links.id = j.id AND links.version = j.version`,
    ).bind(param),
    env.DB.prepare(`DELETE FROM kv_deletes WHERE requested_at <= ?2 AND kv_key IN (${UNCHANGED_KEYS})`).bind(param, dropBefore),
    env.DB.prepare(`UPDATE kv_deletes SET confirmed = 1 WHERE confirmed = 0 AND kv_key IN (${UNCHANGED_KEYS})`).bind(param),
  ]);
}

/** Leaves work for drainPending. Needed because another request may already have marked the key as done. */
async function markPending(env: Env, states: readonly State[]): Promise<void> {
  if (states.length === 0) return;
  const param = json(states);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE links SET kv_version = 0 WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?1)) AND kv_version <> 0`,
    ).bind(param),
    env.DB.prepare(
      `INSERT INTO kv_deletes (kv_key, requested_at)
       SELECT json_extract(value, '$.key'), ?2 FROM json_each(?1) WHERE json_extract(value, '$.id') IS NULL
       ON CONFLICT (kv_key) DO UPDATE SET confirmed = 0`,
    ).bind(param, Math.floor(Date.now() / 1000)),
  ]);
}

/**
 * Makes KV match D1 for each key: write or delete, read D1 again, and repeat for keys that moved meanwhile.
 * The second read is what keeps a slow write from leaving an older edit, or a deleted link, in KV.
 * Returns the keys known to match.
 */
async function reconcile(env: Env, targets: readonly Target[], maxOps: number, dropBefore = 0): Promise<string[]> {
  let opsLeft = Math.min(maxOps, MAX_KV_OPS);
  const done: string[] = [];
  let todo = targets.length > 0 ? await readState(env, targets) : [];
  for (let round = 0; round < ROUNDS && todo.length > 0 && opsLeft > 0; round++) {
    const now = todo.slice(0, opsLeft);
    opsLeft -= now.length;
    const outcomes = await Promise.allSettled(now.map((s) => writeKv(env, s)));
    const after = new Map((await readState(env, now)).map((s) => [linkKey(s.domain, s.slug), s]));

    const settled: State[] = [];
    const unsettled: State[] = [];
    const moved: State[] = [];
    now.forEach((before, i) => {
      const current = after.get(linkKey(before.domain, before.slug))!;
      const ok = outcomes[i]!.status === 'fulfilled';
      const same = current.id === before.id && current.version === before.version;
      if (ok && same) settled.push(current);
      else unsettled.push(current);
      if (ok && !same) moved.push(current);
    });
    await markPending(env, unsettled);
    await markDone(env, settled, dropBefore);
    done.push(...settled.map((s) => linkKey(s.domain, s.slug)));
    todo = moved;
  }
  return done;
}

async function tryReconcile(env: Env, target: Target): Promise<boolean> {
  try {
    return (await reconcile(env, [target], ROUNDS)).length === 1;
  } catch (err) {
    console.error('kv sync deferred', err instanceof Error ? err.message : 'unknown');
    return false;
  }
}

/** Keeps work going after the response, or after the client has gone: ExecutionContext.waitUntil. */
export type Background = (work: Promise<unknown>) => void;

/**
 * Copies one link's current state to KV after a write, with a retry in the background.
 * Never throws: the change is already saved in D1. Returns whether KV is known to match.
 */
export function syncAfterWrite(env: Env, background: Background, domain: string, slug: string): Promise<boolean> {
  const target = { domain, slug };
  const first = tryReconcile(env, target);
  background(first.then(async (confirmed) => {
    if (confirmed) return;
    await scheduler.wait(RETRY_DELAY_MS);
    await tryReconcile(env, target);
  }));
  return first;
}

/** The slug never contains a colon, so the last one separates it from the domain. */
export function parseKey(key: string): Target | null {
  const at = key.lastIndexOf(':');
  return key.startsWith('l:') && at > 2 && at < key.length - 1 ? { domain: key.slice(2, at), slug: key.slice(at + 1) } : null;
}

/**
 * Work that changes what visitors get, most urgent first: links that were switched off or deleted and may still
 * redirect, then links created switched off, then everything else; oldest change first within each.
 */
const PENDING = `
  SELECT 'l:' || domain || ':' || slug AS kv_key,
    CASE WHEN disabled = 0 THEN 2 WHEN version = 1 THEN 1 ELSE 0 END AS rank, updated_at AS at
  FROM links WHERE kv_version < version
  UNION ALL SELECT kv_key, 0, requested_at FROM kv_deletes WHERE confirmed = 0
  ORDER BY rank, at, kv_key LIMIT ?1`;

/** CONTRACT (owned by the API task, called by the hourly job).
 *  Finishes pending KV writes and deletes, at most `limit`. Returns how many were done.
 *  A recent kv_deletes row is acted on but stays, and is not counted. */
export async function drainPending(env: Env, limit: number): Promise<number> {
  const cap = Math.min(Math.floor(limit), MAX_KV_OPS);
  if (!(cap > 0)) return 0;
  const dropBefore = Math.floor(Date.now() / 1000) - TOMBSTONE_SECONDS;
  const pending = (await env.DB.prepare(PENDING).bind(cap).all<{ kv_key: string; rank: number; at: number }>()).results;
  const tombstones = (await env.DB.prepare('SELECT kv_key, requested_at AS at FROM kv_deletes WHERE confirmed = 1 ORDER BY requested_at LIMIT ?1')
    .bind(cap).all<{ kv_key: string; at: number }>()).results;

  const urgent = pending.filter((p) => p.rank < 2).length;
  const reserved = Math.min(tombstones.length, Math.floor(cap * TOMBSTONE_SHARE), cap - urgent);
  const targets = new Map<string, Target>();
  const recent = new Set<string>();
  const take = (kv_key: string, max: number, staysBehind: boolean) => {
    const target = parseKey(kv_key);
    if (!target || targets.has(kv_key) || targets.size >= max) return;
    targets.set(kv_key, target);
    if (staysBehind) recent.add(kv_key);
  };
  for (const p of pending) take(p.kv_key, cap - reserved, false);
  for (const t of tombstones) take(t.kv_key, cap, t.at > dropBefore);
  const done = await reconcile(env, [...targets.values()], cap, dropBefore);
  return done.filter((key) => !recent.has(key)).length;
}

/** Rewrites one page of KV entries, in link ID order. Failures are left pending for the hourly job. */
export async function resyncPage(env: Env, afterId: string): Promise<{ synced: number; failed: number; lastId: string | null }> {
  const { results } = await env.DB.prepare('SELECT id, domain, slug FROM links WHERE id > ?1 ORDER BY id LIMIT ?2')
    .bind(afterId, MAX_KV_OPS).all<Target & { id: string }>();
  const synced = (await reconcile(env, results, MAX_KV_OPS)).length;
  return { synced, failed: results.length - synced, lastId: results.length === MAX_KV_OPS ? results.at(-1)!.id : null };
}
