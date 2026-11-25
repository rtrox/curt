export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** RFC 7636 S256. */
export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export interface AuthorizeInput {
  endpoint: string; clientId: string; scope: string; redirectUri: string;
  state: string; nonce: string; challenge: string;
}

export function authorizeUrl(i: AuthorizeInput): string {
  const url = new URL(i.endpoint);
  const params = {
    response_type: 'code', client_id: i.clientId, redirect_uri: i.redirectUri, scope: i.scope,
    state: i.state, nonce: i.nonce, code_challenge: i.challenge, code_challenge_method: 'S256',
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.href;
}

export type CallbackResult =
  | { ok: true; code: string }
  | { ok: false; reason: 'provider_error'; error: string }
  | { ok: false; reason: 'bad_state' | 'missing_code' };

/** Checks what the provider sent back. State is compared before anything else in the response is used. */
export function readCallback(search: string, expected: { state: string; issuer: string } | null): CallbackResult {
  const q = new URLSearchParams(search);
  if (!expected || !expected.state || q.get('state') !== expected.state) return { ok: false, reason: 'bad_state' };
  // RFC 9207: not every provider sends iss, but a wrong one means the answer came from elsewhere.
  const iss = q.get('iss');
  if (iss !== null && iss.replace(/\/$/, '') !== expected.issuer.replace(/\/$/, '')) return { ok: false, reason: 'bad_state' };
  const error = q.get('error');
  if (error) return { ok: false, reason: 'provider_error', error };
  const code = q.get('code');
  return code ? { ok: true, code } : { ok: false, reason: 'missing_code' };
}
