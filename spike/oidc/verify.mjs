// Verifies an OIDC ID token against pinned public keys. No network access.
import crypto from 'node:crypto';

const ALGS = {
  RS256: { hash: 'sha256', kty: 'RSA' },
  ES256: { hash: 'sha256', kty: 'EC', dsaEncoding: 'ieee-p1363' },
  EdDSA: { hash: null, kty: 'OKP' },
};
const b64 = (s) => Buffer.from(s, 'base64url');

export function verifyIdToken(token, { jwks, issuer, audience, nonce, now = Date.now() / 1000, skew = 60 }) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('not a JWT');
  const header = JSON.parse(b64(parts[0]));
  const alg = ALGS[header.alg];
  if (!alg) throw new Error(`algorithm not allowed: ${header.alg}`);
  const jwk = jwks.keys.find((k) => k.kid === header.kid && k.kty === alg.kty);
  if (!jwk) throw new Error('no pinned key matches the token');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify(alg.hash, Buffer.from(`${parts[0]}.${parts[1]}`),
    alg.dsaEncoding ? { key, dsaEncoding: alg.dsaEncoding } : key, b64(parts[2]));
  if (!ok) throw new Error('bad signature');
  const c = JSON.parse(b64(parts[1]));
  if (c.iss !== issuer) throw new Error('wrong issuer');
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(audience)) throw new Error('wrong audience');
  if (aud.length > 1 && c.azp !== audience) throw new Error('wrong azp');
  if (typeof c.exp !== 'number' || c.exp < now - skew) throw new Error('expired');
  if (typeof c.iat !== 'number' || c.iat > now + skew) throw new Error('issued in the future');
  if (!nonce || c.nonce !== nonce) throw new Error('wrong nonce');
  return c;
}
