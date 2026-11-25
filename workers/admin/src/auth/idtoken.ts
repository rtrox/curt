import { createLocalJWKSet, errors, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';
import { ApiError } from '../lib/errors.ts';
import type { Env } from '../types.ts';

const ALGORITHMS = ['RS256', 'ES256', 'EdDSA'];
const CLOCK_SKEW_SECONDS = 60;
const MAX_AGE_SECONDS = 10 * 60;
/** An accepted token may be dated up to one skew ahead and is taken until one skew past its maximum age. */
export const TOKEN_ACCEPTED_SECONDS = MAX_AGE_SECONDS + 2 * CLOCK_SKEW_SECONDS;

export type IdClaims = JWTPayload & { sub: string; nonce: string; iat: number };

export function pinnedKeys(env: Env): JSONWebKeySet {
  try {
    return JSON.parse(env.OIDC_JWKS) as JSONWebKeySet;
  } catch {
    throw new Error('OIDC_JWKS is not valid JSON');
  }
}

const rejected = (message: string) => new ApiError(401, 'invalid_token', message);

/** Verifies signature, algorithm, issuer, audience, azp, expiry, issued-at and nonce. Makes no network calls. */
export async function verifyIdToken(env: Env, token: string, keys: JSONWebKeySet, nonce: string): Promise<IdClaims> {
  let getKey: ReturnType<typeof createLocalJWKSet>;
  try {
    getKey = createLocalJWKSet(keys);
  } catch {
    throw new Error('The signing key set is not valid');
  }
  let claims: JWTPayload;
  try {
    claims = (await jwtVerify(token, getKey, {
      algorithms: ALGORITHMS,
      issuer: env.OIDC_ISSUER,
      audience: env.OIDC_CLIENT_ID,
      requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
      clockTolerance: CLOCK_SKEW_SECONDS,
      maxTokenAge: MAX_AGE_SECONDS,
    })).payload;
  } catch (err) {
    if (!(err instanceof errors.JOSEError)) throw new Error('The signing key set could not be used');
    const claim = 'claim' in err && typeof err.claim === 'string' ? err.claim : '';
    console.warn('sign-in token rejected', err.code, claim);
    if (err instanceof errors.JWKSNoMatchingKey) {
      throw new ApiError(401, 'unknown_signing_key', 'The sign-in provider used a key this site does not know. If its keys were rotated, the pinned keys need updating.');
    }
    if (err instanceof errors.JWTExpired) throw rejected('The sign-in token has expired. Try again.');
    throw rejected('The sign-in token was not accepted.');
  }
  if (typeof claims.sub !== 'string' || claims.sub === '' || claims.sub.length > 255) throw rejected('The sign-in token was not accepted.');
  const several = Array.isArray(claims.aud) && claims.aud.length > 1;
  if ((several || claims.azp !== undefined) && claims.azp !== env.OIDC_CLIENT_ID) throw rejected('The sign-in token was issued to another application.');
  if (!nonce || claims.nonce !== nonce) throw rejected('The sign-in token does not belong to this sign-in attempt.');
  return claims as IdClaims;
}
