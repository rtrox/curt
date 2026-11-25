import { describe, expect, it } from 'vitest';
import { authorizeUrl, base64url, challengeFor, randomToken, readCallback } from '../src/lib/pkce.ts';

describe('pkce', () => {
  it('matches the RFC 7636 appendix B example', async () => {
    expect(await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
  it('encodes without padding or URL-unsafe characters', () => {
    expect(base64url(new Uint8Array([251, 255, 254, 0]))).toBe('-__-AA');
  });
  it('makes verifiers of an allowed length and alphabet, all different', () => {
    const made = new Set(Array.from({ length: 200 }, () => randomToken()));
    expect(made.size).toBe(200);
    for (const t of made) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it('builds the authorization request and keeps existing parameters', () => {
    const u = new URL(authorizeUrl({
      endpoint: 'https://id.example/authorize?tenant=a', clientId: 'curt', scope: 'openid groups',
      redirectUri: 'https://app.go.example/auth/callback', state: 's', nonce: 'n', challenge: 'c',
    }));
    expect(Object.fromEntries(u.searchParams)).toEqual({
      tenant: 'a', response_type: 'code', client_id: 'curt', redirect_uri: 'https://app.go.example/auth/callback',
      scope: 'openid groups', state: 's', nonce: 'n', code_challenge: 'c', code_challenge_method: 'S256',
    });
  });
});

describe('callback', () => {
  const expected = { state: 'abc', issuer: 'https://id.example' };
  it('accepts a matching state', () => {
    expect(readCallback('?code=x&state=abc', expected)).toEqual({ ok: true, code: 'x' });
    expect(readCallback('?code=x&state=abc&iss=https%3A%2F%2Fid.example', expected)).toEqual({ ok: true, code: 'x' });
  });
  it('refuses a wrong, missing or unexpected state, even when the provider reports an error', () => {
    for (const s of ['?code=x&state=other', '?code=x', '', '?error=access_denied&state=other']) {
      expect(readCallback(s, expected)).toEqual({ ok: false, reason: 'bad_state' });
    }
    expect(readCallback('?code=x&state=abc', null)).toEqual({ ok: false, reason: 'bad_state' });
    expect(readCallback('?code=x&state=', { ...expected, state: '' })).toEqual({ ok: false, reason: 'bad_state' });
  });
  it('refuses an answer from another issuer', () => {
    expect(readCallback('?code=x&state=abc&iss=https%3A%2F%2Fevil.example', expected)).toEqual({ ok: false, reason: 'bad_state' });
  });
  it('reports provider errors and a missing code', () => {
    expect(readCallback('?error=access_denied&state=abc', expected)).toEqual({ ok: false, reason: 'provider_error', error: 'access_denied' });
    expect(readCallback('?state=abc', expected)).toEqual({ ok: false, reason: 'missing_code' });
  });
});
