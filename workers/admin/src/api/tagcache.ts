import type { Auth, Env } from '../types.ts';

/** Counting tags reads every one of the caller's tag rows, so the answer is kept briefly in the local data centre. */
const CACHE_NAME = 'curt-tags';
const TTL_SECONDS = 60;

export interface TagCount { tag: string; count: number }

// Being admin is part of the key, so losing it does not leave an all-links answer behind.
const keyFor = (env: Env, auth: Auth) =>
  `https://${env.ADMIN_HOST}/.cache/tags/${auth.isAdmin ? 'all' : 'own'}/${encodeURIComponent(auth.userId)}`;

/** Callers must authorise the request first. Cache failures count as misses. */
export async function readTags(env: Env, auth: Auth): Promise<TagCount[] | null> {
  try {
    const hit = await (await caches.open(CACHE_NAME)).match(keyFor(env, auth));
    return hit ? await hit.json<TagCount[]>() : null;
  } catch {
    return null;
  }
}

export async function writeTags(env: Env, auth: Auth, tags: TagCount[]): Promise<void> {
  try {
    const entry = new Response(JSON.stringify(tags), { headers: { 'cache-control': `max-age=${TTL_SECONDS}` } });
    await (await caches.open(CACHE_NAME)).put(keyFor(env, auth), entry);
  } catch {
    // The answer is still good; it just is not cached.
  }
}

/** Lets people see their own change at once. Others see it when their entry expires. */
export async function forgetTags(env: Env, auth: Auth): Promise<void> {
  try {
    await (await caches.open(CACHE_NAME)).delete(keyFor(env, auth));
  } catch {
    // It expires soon anyway.
  }
}
