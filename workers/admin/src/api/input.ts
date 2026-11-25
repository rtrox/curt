import { checkDestination } from '@curt/shared';
import type { DestinationError } from '@curt/shared';
import type { Context } from 'hono';
import type { z } from 'zod';
import { ownHosts, shortHosts } from '../lib/config.ts';
import { ApiError } from '../lib/errors.ts';
import type { AppEnv, Env } from '../types.ts';

export const nowSeconds = () => Math.floor(Date.now() / 1000);

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const path = issue?.path.join('.');
  throw new ApiError(400, 'invalid_request', `${path ? `${path}: ` : ''}${issue?.message ?? 'Invalid request.'}`);
}

export async function readJson(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError(400, 'invalid_request', 'The request body must be JSON.');
  }
}

export function resolveDomain(env: Env, domain: string | undefined): string {
  const hosts = shortHosts(env);
  if (domain === undefined) return hosts[0]!;
  const host = domain.trim().toLowerCase();
  if (!hosts.includes(host)) throw new ApiError(400, 'unknown_domain', 'That domain is not configured.');
  return host;
}

const DESTINATION_MESSAGES: Record<DestinationError, string> = {
  invalid_url: 'The destination is not a valid URL.',
  bad_scheme: 'The destination must start with http:// or https://.',
  has_credentials: 'The destination must not contain a user name or password.',
  own_domain: 'The destination must not be one of the short domains.',
  too_long: 'The destination is too long.',
};

export function resolveDestination(env: Env, input: string): string {
  const r = checkDestination(input, ownHosts(env));
  if (!r.ok) throw new ApiError(400, r.error, DESTINATION_MESSAGES[r.error]);
  return r.url;
}

export function requireFuture(expiresAt: number | null | undefined): void {
  if (typeof expiresAt === 'number' && expiresAt <= nowSeconds()) {
    throw new ApiError(400, 'expiry_in_past', 'The expiry must be in the future.');
  }
}

/** If-Match holds the version, bare or quoted like an ETag. */
export function requireVersion(header: string | undefined): number {
  if (header === undefined || header.trim() === '') {
    throw new ApiError(428, 'version_required', 'Send If-Match with the version you are changing.');
  }
  const m = /^(?:"(\d{1,15})"|(\d{1,15}))$/.exec(header.trim());
  if (!m) throw new ApiError(400, 'invalid_request', 'If-Match must be a version number.');
  return Number(m[1] ?? m[2]);
}

const b64url = (s: string) => btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

export interface ListCursor { createdAt: number; id: string }

export const encodeListCursor = (c: ListCursor) => b64url(`l:${c.createdAt}:${c.id}`);
export const encodeResyncCursor = (id: string) => b64url(`r:${id}`);

function decode(cursor: string, pattern: RegExp): RegExpExecArray {
  let m: RegExpExecArray | null = null;
  try {
    if (/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) m = pattern.exec(atob(cursor.replaceAll('-', '+').replaceAll('_', '/')));
  } catch {
    // Not base64; reported below.
  }
  if (!m) throw new ApiError(400, 'invalid_cursor', 'That cursor is not valid.');
  return m;
}

export function decodeListCursor(cursor: string): ListCursor {
  const m = decode(cursor, /^l:(\d{1,12}):([\w-]{1,64})$/);
  return { createdAt: Number(m[1]), id: m[2]! };
}

export function decodeResyncCursor(cursor: string): string {
  return decode(cursor, /^r:([\w-]{1,64})$/)[1]!;
}
