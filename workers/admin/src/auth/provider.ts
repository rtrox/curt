import type { JSONWebKeySet } from 'jose';
import type { Env } from '../types.ts';
import { redirectUri } from './config.ts';

/** Server exchange only. Errors carry fixed text, never provider output, which may hold tokens. */
export class ProviderError extends Error {}

const TIMEOUT_MS = 10_000;

interface Discovery {
  jwksUri: string;
  authMethods: string[];
}

function httpsUrl(value: unknown, what: string): string {
  if (typeof value !== 'string' || !URL.canParse(value) || new URL(value).protocol !== 'https:') throw new ProviderError(`${what} is not an https URL`);
  return value;
}

async function fetchJson(url: string, what: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    // Redirects are not followed: they could carry the code and client secret elsewhere.
    res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ProviderError(`${what} could not be reached`);
  }
  if (res.status !== 200) throw new ProviderError(`${what} answered ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ProviderError(`${what} did not return JSON`);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ProviderError(`${what} returned unexpected JSON`);
  return body as Record<string, unknown>;
}

export async function discover(env: Env): Promise<Discovery> {
  httpsUrl(env.OIDC_ISSUER, 'OIDC_ISSUER');
  const doc = await fetchJson(`${env.OIDC_ISSUER.replace(/\/$/, '')}/.well-known/openid-configuration`, 'Discovery');
  if (doc.issuer !== env.OIDC_ISSUER) throw new ProviderError('Discovery names a different issuer');
  const methods = doc.token_endpoint_auth_methods_supported;
  return {
    jwksUri: httpsUrl(doc.jwks_uri, 'jwks_uri'),
    authMethods: Array.isArray(methods) ? methods.filter((m): m is string => typeof m === 'string') : [],
  };
}

export async function fetchKeys(discovery: Discovery): Promise<JSONWebKeySet> {
  const doc = await fetchJson(discovery.jwksUri, 'JWKS');
  if (!Array.isArray(doc.keys)) throw new ProviderError('JWKS has no keys');
  return doc as unknown as JSONWebKeySet;
}

/** RFC 6749 section 2.3.1 form-encodes both parts before joining them. */
const formEncode = (s: string) => new URLSearchParams([['', s]]).toString().slice(1);

/** Returns the raw ID token, not yet verified. */
export async function exchangeCode(env: Env, discovery: Discovery, code: string, verifier: string): Promise<string> {
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(env), code_verifier: verifier });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  const secret = env.OIDC_CLIENT_SECRET;
  const postOnly = discovery.authMethods.includes('client_secret_post') && !discovery.authMethods.includes('client_secret_basic');
  if (secret && !postOnly) {
    headers.authorization = `Basic ${btoa(`${formEncode(env.OIDC_CLIENT_ID)}:${formEncode(secret)}`)}`;
  } else {
    form.set('client_id', env.OIDC_CLIENT_ID);
    if (secret) form.set('client_secret', secret);
  }
  // The configured endpoint wins over discovery, which some providers fill with an internal address.
  const body = await fetchJson(httpsUrl(env.OIDC_TOKEN_ENDPOINT, 'OIDC_TOKEN_ENDPOINT'), 'Token endpoint', { method: 'POST', headers, body: form.toString() });
  if (typeof body.id_token !== 'string' || body.id_token.length > 65_536) throw new ProviderError('Token endpoint returned no ID token');
  return body.id_token;
}
