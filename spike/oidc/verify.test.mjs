import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyIdToken } from './verify.mjs';

const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = { keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'k1' }] };
const now = Math.floor(Date.now() / 1000);
const good = { iss: 'https://id.example', aud: 'client', sub: 'u1', nonce: 'n1', iat: now, exp: now + 600 };
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (claims, { header = {}, key = pair.privateKey } = {}) => {
  const body = `${enc({ alg: 'RS256', kid: 'k1', ...header })}.${enc(claims)}`;
  return `${body}.${crypto.sign('sha256', Buffer.from(body), key).toString('base64url')}`;
};
const check = (t, o = {}) => verifyIdToken(t, { jwks, issuer: 'https://id.example', audience: 'client', nonce: 'n1', ...o });

test('accepts a valid token', () => assert.equal(check(sign(good)).sub, 'u1'));
for (const [name, token, opts, error] of [
  ['forged key', sign(good, { key: other.privateKey }), {}, /bad signature/],
  ['alg none', `${enc({ alg: 'none', kid: 'k1' })}.${enc(good)}.`, {}, /not allowed/],
  ['alg HS256', sign(good, { header: { alg: 'HS256' } }), {}, /not allowed/],
  ['unknown key id', sign(good, { header: { kid: 'k2' } }), {}, /no pinned key/],
  ['wrong issuer', sign({ ...good, iss: 'https://evil.example' }), {}, /wrong issuer/],
  ['wrong audience', sign({ ...good, aud: 'x' }), {}, /wrong audience/],
  ['expired', sign({ ...good, exp: now - 120 }), {}, /expired/],
  ['future', sign({ ...good, iat: now + 300 }), {}, /future/],
  ['wrong nonce', sign({ ...good, nonce: 'n2' }), {}, /wrong nonce/],
  ['missing nonce', sign({ ...good, nonce: undefined }), { nonce: undefined }, /wrong nonce/],
]) test(`rejects ${name}`, () => assert.throws(() => check(token, opts), error));
test('rejects a changed payload', () => {
  const [h, , s] = sign(good).split('.');
  assert.throws(() => check(`${h}.${enc({ ...good, groups: ['admin'] })}.${s}`), /bad signature/);
});
