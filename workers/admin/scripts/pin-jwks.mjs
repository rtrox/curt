#!/usr/bin/env node
// Prints the value for OIDC_JWKS: the provider's public signing keys as one line of JSON.
//   node scripts/pin-jwks.mjs https://id.example
import { publicSigningKeys } from './public-keys.mjs';

function allowed(value, what) {
  if (!URL.canParse(String(value))) throw new Error(`${what} is not a URL`);
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error(`${what} must use https`);
  return url.href;
}

async function getJson(url, what) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`);
  return res.json();
}

try {
  const issuer = process.argv[2];
  if (!issuer || process.argv.length > 3) throw new Error('Usage: node scripts/pin-jwks.mjs <issuer URL>');
  allowed(issuer, 'The issuer');
  const discovery = await getJson(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, 'Discovery');
  if (String(discovery.issuer).replace(/\/$/, '') !== issuer.replace(/\/$/, '')) throw new Error('The discovery document names a different issuer');
  if (discovery.issuer !== issuer) console.error(`Set OIDC_ISSUER to exactly ${JSON.stringify(discovery.issuer)}`);
  const result = publicSigningKeys(await getJson(allowed(discovery.jwks_uri, 'jwks_uri'), 'JWKS'));
  console.error(`Found ${result.keys.length} public key(s). Set OIDC_JWKS to:`);
  console.log(JSON.stringify(result));
} catch (err) {
  console.error(err instanceof Error ? err.message : 'Failed');
  process.exit(1);
}
