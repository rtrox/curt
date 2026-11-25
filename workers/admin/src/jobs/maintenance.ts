import { saltKey } from '@curt/shared';
import { drainPending } from '../api/sync.ts';
import type { Env } from '../types.ts';

const DAY_MS = 86_400_000;
const SALT_LIFETIME_MS = 2 * DAY_MS;

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Creates the salt for the UTC day starting at `dayStart` unless one exists. Its 48 hours run from the start of
 *  that day, so it always outlives the day, however early it was created, and is gone one day later. */
async function ensureSalt(env: Env, dayStart: number, now: number): Promise<void> {
  const key = saltKey(new Date(dayStart).toISOString().slice(0, 10));
  if ((await env.LINKS.get(key)) !== null) return;
  const salt = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const expirationTtl = Math.ceil((dayStart + SALT_LIFETIME_MS - now) / 1000);
  await env.LINKS.put(key, salt, { expirationTtl });
}

/** Hourly job. Owned by the stats task. Steps are independent, and only step names are logged. */
export async function runMaintenance(env: Env, now: Date, drain: typeof drainPending = drainPending): Promise<void> {
  const time = now.getTime();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const steps: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
    ['salt today', () => ensureSalt(env, today, time)],
    ['salt tomorrow', () => ensureSalt(env, today + DAY_MS, time)],
    ['expired sessions', () => env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(Math.floor(time / 1000)).run()],
    ['expired nonces', () => env.DB.prepare('DELETE FROM used_nonces WHERE expires_at <= ?').bind(Math.floor(time / 1000)).run()],
    // Last, so a long backlog cannot use up the limits the cheap steps need.
    ['drain pending', () => drain(env, 40)],
  ];
  for (const [name, run] of steps) {
    try {
      await run();
    } catch {
      console.error('maintenance step failed:', name);
    }
  }
}
