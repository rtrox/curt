// Reduces a provider's JWKS to the public signing keys curt accepts.
// Fields are copied from a fixed list, so private key fields can never get through.
const FIELDS = { RSA: ['n', 'e'], EC: ['crv', 'x', 'y'], OKP: ['crv', 'x'] };
const ALGORITHM = { RSA: 'RS256', EC: 'ES256', OKP: 'EdDSA' };
const CURVE = { EC: 'P-256', OKP: 'Ed25519' };

export function publicSigningKeys(jwks) {
  if (!Array.isArray(jwks?.keys)) throw new Error('The document has no keys array');
  const keys = [];
  for (const key of jwks.keys) {
    if (!Object.hasOwn(FIELDS, key?.kty)) continue;
    if (key.use !== undefined && key.use !== 'sig') continue;
    if (key.alg !== undefined && key.alg !== ALGORITHM[key.kty]) continue;
    if (CURVE[key.kty] !== undefined && key.crv !== CURVE[key.kty]) continue;
    const fields = FIELDS[key.kty];
    if (!fields.every((f) => typeof key[f] === 'string')) continue;
    const out = { kty: key.kty };
    if (typeof key.kid === 'string') out.kid = key.kid;
    out.use = 'sig';
    out.alg = ALGORITHM[key.kty];
    for (const f of fields) out[f] = key[f];
    keys.push(out);
  }
  if (keys.length === 0) throw new Error('No usable RS256, ES256 or EdDSA signing key found');
  return { keys };
}
