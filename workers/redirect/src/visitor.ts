import { saltKey } from '@curt/shared';
import type { Env } from './index.ts';
import { logFailure } from './log.ts';

const HASH_BYTES = 16;
/** A missing salt is retried, but not by every request. */
const MISSING_SALT_RETRY_MS = 60_000;

/** Holds one day at most, so yesterday's key is dropped when the day changes. */
let cache: { day: string; key: CryptoKey | null; checkedAt: number } | null = null;

async function hashKey(env: Env, now: number): Promise<CryptoKey | null> {
  const day = new Date(now).toISOString().slice(0, 10);
  if (cache?.day === day && (cache.key || now - cache.checkedAt < MISSING_SALT_RETRY_MS)) return cache.key;
  const salt = await env.LINKS.get(saltKey(day));
  const key = salt
    ? await crypto.subtle.importKey('raw', new TextEncoder().encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    : null;
  cache = { day, key, checkedAt: now };
  return key;
}

/** What to store for the visitor: nothing, a keyed hash that changes daily, or the address. */
export async function visitorId(request: Request, env: Env): Promise<string> {
  const ip = request.headers.get('CF-Connecting-IP') ?? '';
  if (!ip) return '';
  if (env.VISITOR_MODE === 'full') return ip;
  if (env.VISITOR_MODE !== 'hash') return '';
  try {
    const key = await hashKey(env, Date.now());
    if (!key) return '';
    const input = new TextEncoder().encode(`${ip}\n${request.headers.get('User-Agent') ?? ''}`);
    const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, input));
    return Array.from(digest.subarray(0, HASH_BYTES), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch (error) {
    logFailure('visitor_hash_failed', error);
    return '';
  }
}
