import type { Env } from '../types.ts';

/** A named cache is separate from the HTTP cache, so entries are only reachable from this code.
 *  Callers must authorise the request before reading. Cache failures count as misses. */
const CACHE_NAME = 'curt-stats';

async function cacheKey(env: Env, parts: readonly string[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `https://${env.ADMIN_HOST}/.cache/${hex}`;
}

export async function readCache(env: Env, parts: readonly string[]): Promise<string | null> {
  try {
    const hit = await (await caches.open(CACHE_NAME)).match(await cacheKey(env, parts));
    return hit ? await hit.text() : null;
  } catch {
    return null;
  }
}

export async function writeCache(env: Env, parts: readonly string[], ttlSeconds: number, value: string): Promise<void> {
  try {
    const entry = new Response(value, { headers: { 'cache-control': `max-age=${ttlSeconds}` } });
    await (await caches.open(CACHE_NAME)).put(await cacheKey(env, parts), entry);
  } catch {
    // The value is still good; it just is not cached.
  }
}

export async function cached(
  env: Env,
  parts: readonly string[],
  ttlSeconds: number,
  make: () => Promise<string>,
): Promise<string> {
  const hit = await readCache(env, parts);
  if (hit !== null) return hit;
  const value = await make();
  await writeCache(env, parts, ttlSeconds, value);
  return value;
}
