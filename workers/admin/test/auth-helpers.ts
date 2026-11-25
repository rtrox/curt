import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env as testEnv } from 'cloudflare:workers';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import worker from '../src/index.ts';
import type { Env } from '../src/types.ts';

export const ORIGIN = 'https://app.go.example';
export const env = testEnv as unknown as Env;

export const rsa = await generateKeyPair('RS256', { extractable: true });
export const ec = await generateKeyPair('ES256', { extractable: true });
export const ed = await generateKeyPair('EdDSA', { extractable: true });
export const stranger = await generateKeyPair('RS256', { extractable: true });

const publicJwk = async (key: CryptoKey, kid: string): Promise<JWK> => ({ ...(await exportJWK(key)), kid, use: 'sig' });
export const jwks = { keys: [await publicJwk(rsa.publicKey, 'rsa'), await publicJwk(ec.publicKey, 'ec'), await publicJwk(ed.publicKey, 'ed')] };

export const browserEnv: Env = { ...env, OIDC_EXCHANGE: 'browser', OIDC_JWKS: JSON.stringify(jwks) };
export const serverEnv: Env = { ...env, OIDC_EXCHANGE: 'server', OIDC_JWKS: '{"keys":[]}' };

export async function call(path: string, init: RequestInit = {}, e: Env = browserEnv): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== 'GET' && !headers.has('origin')) headers.set('origin', ORIGIN);
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers, redirect: 'manual' }) as never, e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
export const post = (path: string, body: unknown, headers: Record<string, string> = {}, e: Env = browserEnv) =>
  call(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } }, e);

/** Set-Cookie lines by cookie name. */
export function cookies(res: Response): Map<string, string> {
  return new Map(res.headers.getSetCookie().map((line) => [line.slice(0, line.indexOf('=')), line]));
}
export const pair = (line: string | undefined) => (line ?? '').split(';')[0] ?? '';
export const PRE = '__Host-curt_preauth';
export const SESSION = '__Host-curt_session';

export const now = () => Math.floor(Date.now() / 1000);
let counter = 0;
export const newSubject = () => `subject-${++counter}-${crypto.randomUUID()}`;

export const goodClaims = (nonce: string) => ({
  iss: 'https://id.example', aud: 'curt' as string | string[], sub: newSubject(), nonce, iat: now(), exp: now() + 600, groups: ['links'] as unknown,
});

export function signToken(claims: Record<string, unknown>, opts: { key?: CryptoKey; alg?: string; kid?: string } = {}): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'rsa' }).sign(opts.key ?? rsa.privateKey);
}

export async function begin(e: Env = browserEnv): Promise<{ nonce: string; cookie: string }> {
  const res = await post('/auth/begin', {}, {}, e);
  const { nonce } = await res.json<{ nonce: string }>();
  return { nonce, cookie: pair(cookies(res).get(PRE)) };
}

/** A whole browser-mode sign-in. */
export async function signIn(claims: Record<string, unknown> = {}, e: Env = browserEnv): Promise<{ res: Response; cookie: string }> {
  const { nonce, cookie } = await begin(e);
  const res = await post('/auth/session', { id_token: await signToken({ ...goodClaims(nonce), ...claims }) }, { cookie }, e);
  return { res, cookie: pair(cookies(res).get(SESSION)) };
}

export async function errorCode(res: Response): Promise<string> {
  return (await res.json<{ error: { code: string } }>()).error.code;
}
export const signedIn = async (cookie: string) => (await call('/api/v1/tokens', { headers: { cookie } })).status === 200;
