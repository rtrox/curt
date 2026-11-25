import type { Env } from '../types.ts';

const TIMEOUT_MS = 8_000;
const LINK_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type Row = Record<string, unknown>;

/** Messages are fixed text: they never contain the token, the query or the response. */
export class AnalyticsError extends Error {}

export function isLinkId(id: string): boolean {
  return LINK_ID.test(id);
}

/** A SQL list of quoted link IDs. Refuses anything that is not a plain ID. */
export function sqlLinkIds(ids: readonly string[]): string {
  if (ids.length === 0 || !ids.every(isLinkId)) throw new AnalyticsError('invalid link id');
  return ids.map((id) => `'${id}'`).join(', ');
}

/** A SQL datetime, UTC, whole seconds. */
export function sqlTime(d: Date): string {
  return `toDateTime('${d.toISOString().slice(0, 19).replace('T', ' ')}')`;
}

/** Analytics Engine may send numbers as strings. Anything else is an error, never a silent zero. */
export function toNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new AnalyticsError('unexpected value in result');
  return n;
}

export function toText(v: unknown): string {
  if (typeof v !== 'string') throw new AnalyticsError('unexpected value in result');
  return v;
}

/** `sql` must be built only from constants and the helpers above. */
export async function queryAnalytics(env: Env, sql: string): Promise<Row[]> {
  const url = env.AE_SQL_URL || `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.ACCOUNT_ID)}/analytics_engine/sql`;
  let status: number;
  let body: unknown;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.AE_TOKEN}`, 'content-type': 'text/plain' },
      body: `${sql} FORMAT JSON`,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = res.status;
    body = res.ok ? await res.json() : await res.body?.cancel();
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'TimeoutError';
    throw new AnalyticsError(timedOut ? 'request timed out' : 'request failed');
  }
  if (status !== 200) throw new AnalyticsError(`request returned status ${status}`);
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new AnalyticsError('unexpected response');
  return data as Row[];
}
