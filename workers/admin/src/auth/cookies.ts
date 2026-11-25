import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { base64url } from 'jose';
import type { AppEnv } from '../types.ts';
import { exchangeMode } from './config.ts';
import { nowSeconds, sign, verifySignature } from './crypto.ts';

export const SESSION_COOKIE = '__Host-curt_session';
export const PREAUTH_COOKIE = '__Host-curt_preauth';
export const SESSION_SECONDS = 7 * 24 * 60 * 60;
export const PREAUTH_SECONDS = 10 * 60;

type C = Context<AppEnv>;
const base = { path: '/', secure: true, httpOnly: true } as const;

export function readSessionCookie(c: C): string | null {
  const value = getCookie(c, SESSION_COOKIE);
  return value !== undefined && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
export function setSessionCookie(c: C, value: string): void {
  setCookie(c, SESSION_COOKIE, value, { ...base, sameSite: 'Strict', maxAge: SESSION_SECONDS });
}
export function clearSessionCookie(c: C): void {
  deleteCookie(c, SESSION_COOKIE, { ...base, sameSite: 'Strict' });
}

/** What a sign-in attempt must remember. Server exchange also keeps the state and PKCE verifier. */
export interface PreAuth {
  nonce: string;
  state?: string;
  verifier?: string;
}
/** `begunAt` is when the attempt began by our own clock, in Unix seconds. */
export type StoredPreAuth = PreAuth & { begunAt: number };

// The provider's redirect is cross-site, so in server exchange a Strict cookie would not arrive with it.
const preAuthSameSite = (c: C) => (exchangeMode(c.env) === 'server' ? 'Lax' : 'Strict');
const preAuthPurpose = (c: C) => `preauth-${exchangeMode(c.env)}`;

export async function setPreAuthCookie(c: C, value: PreAuth): Promise<void> {
  const payload = base64url.encode(JSON.stringify({ ...value, begunAt: nowSeconds() }));
  const signature = await sign(c.env.COOKIE_KEY, preAuthPurpose(c), payload);
  setCookie(c, PREAUTH_COOKIE, `${payload}.${signature}`, { ...base, sameSite: preAuthSameSite(c), maxAge: PREAUTH_SECONDS });
}

/** Reads the cookie and clears it, whether or not the sign-in then succeeds. */
export async function takePreAuthCookie(c: C): Promise<StoredPreAuth | null> {
  const raw = getCookie(c, PREAUTH_COOKIE);
  if (raw === undefined) return null;
  deleteCookie(c, PREAUTH_COOKIE, { ...base, sameSite: preAuthSameSite(c) });
  const [payload, signature, extra] = raw.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  if (!(await verifySignature(c.env.COOKIE_KEY, preAuthPurpose(c), payload, signature))) return null;
  const value = JSON.parse(new TextDecoder().decode(base64url.decode(payload))) as Partial<StoredPreAuth>;
  if (typeof value.nonce !== 'string' || !Number.isSafeInteger(value.begunAt)) return null;
  const stored = value as StoredPreAuth;
  return stored.begunAt + PREAUTH_SECONDS > nowSeconds() ? stored : null;
}
