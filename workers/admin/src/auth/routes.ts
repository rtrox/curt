import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';
import { ApiError } from '../lib/errors.ts';
import { dashboard } from '../lib/pages.ts';
import type { AppEnv } from '../types.ts';
import { exchangeMode, oidcScope, redirectUri } from './config.ts';
import { clearSessionCookie, readSessionCookie, setPreAuthCookie, takePreAuthCookie } from './cookies.ts';
import { randomToken, sha256 } from './crypto.ts';
import { pinnedKeys, verifyIdToken } from './idtoken.ts';
import { continuePage, signInErrorPage } from './pages.ts';
import { discover, exchangeCode, fetchKeys, ProviderError } from './provider.ts';
import { attemptExpired, startSession } from './signin.ts';

/** Mounted at /auth. Owned by the sign-in task. */
export const authRoutes = new Hono<AppEnv>();

authRoutes.use('*', async (c, next) => {
  await next();
  c.res.headers.set('cache-control', 'no-store');
});

const onlyIn = (mode: 'browser' | 'server') => createMiddleware<AppEnv>(async (c, next) => {
  if (exchangeMode(c.env) !== mode) throw new ApiError(404, 'not_found', 'No such endpoint.');
  await next();
});

const tooLarge = () => { throw new ApiError(413, 'too_large', 'The request is too large.'); };

authRoutes.post('/begin', onlyIn('browser'), async (c) => {
  const nonce = randomToken();
  await setPreAuthCookie(c, { nonce });
  return c.json({ nonce });
});

authRoutes.post('/session', onlyIn('browser'), bodyLimit({ maxSize: 65_536, onError: tooLarge }), async (c) => {
  const preAuth = await takePreAuthCookie(c);
  if (!preAuth) throw attemptExpired();
  const body: unknown = await c.req.json().catch(() => null);
  const token = (body as { id_token?: unknown } | null)?.id_token;
  if (typeof token !== 'string') throw new ApiError(400, 'invalid_request', 'Send the ID token as id_token.');
  await startSession(c, await verifyIdToken(c.env, token, pinnedKeys(c.env), preAuth.nonce), preAuth.begunAt);
  return c.json({ ok: true });
});

authRoutes.post('/logout', async (c) => {
  const session = readSessionCookie(c);
  if (session) await c.env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(await sha256(session)).run();
  clearSessionCookie(c);
  return c.json({ ok: true });
});

authRoutes.get('/login', onlyIn('server'), async (c) => {
  const nonce = randomToken();
  const state = randomToken();
  const verifier = randomToken();
  const url = new URL(c.env.OIDC_AUTHORIZATION_ENDPOINT);
  const params = {
    response_type: 'code', client_id: c.env.OIDC_CLIENT_ID, redirect_uri: redirectUri(c.env), scope: oidcScope(c.env),
    state, nonce, code_challenge: await sha256(verifier), code_challenge_method: 'S256',
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  await setPreAuthCookie(c, { nonce, state, verifier });
  return c.redirect(url.href, 302);
});

authRoutes.get('/callback', async (c) => {
  // In browser exchange the dashboard finishes the sign-in itself.
  if (exchangeMode(c.env) === 'browser') return dashboard(c);

  const query = new URL(c.req.url).searchParams;
  const preAuth = await takePreAuthCookie(c);
  if (!preAuth?.state || !preAuth.verifier || query.get('state') !== preAuth.state) return signInErrorPage(c, 400, attemptExpired().message);
  // RFC 9207: a response that names its issuer must name ours.
  const issuer = query.get('iss');
  if (issuer !== null && issuer !== c.env.OIDC_ISSUER) return signInErrorPage(c, 400, 'The answer came from a different sign-in provider.');
  const error = query.get('error');
  if (error !== null) return signInErrorPage(c, 403, error === 'access_denied' ? 'The sign-in provider refused access, or you cancelled.' : 'The sign-in provider reported a problem.');
  const code = query.get('code');
  if (!code) return signInErrorPage(c, 400, 'The sign-in provider did not send a code.');

  try {
    const discovery = await discover(c.env);
    const token = await exchangeCode(c.env, discovery, code, preAuth.verifier);
    await startSession(c, await verifyIdToken(c.env, token, await fetchKeys(discovery), preAuth.nonce), preAuth.begunAt);
  } catch (err) {
    if (err instanceof ApiError) return signInErrorPage(c, err.status, err.message);
    if (!(err instanceof ProviderError)) throw err;
    console.error('sign-in provider', err.message);
    return signInErrorPage(c, 502, 'The sign-in provider could not be reached or gave an unexpected answer. Try again shortly.');
  }
  return continuePage(c);
});
