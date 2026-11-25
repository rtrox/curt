import type { PublicConfig } from '@curt/shared/schemas';
import { api, RequestError } from './api.ts';
import { authorizeUrl, challengeFor, randomToken, readCallback } from './pkce.ts';

const KEY = 'curt.signin';
interface Pending { verifier: string; state: string; returnTo: string }

export type SignInProblem =
  | 'not_allowed' | 'groups_missing' | 'unreachable' | 'cancelled' | 'bad_state'
  | 'rejected' | 'expired' | 'network' | 'storage' | 'provider';
export class SignInError extends Error {
  readonly problem: SignInProblem;
  constructor(problem: SignInProblem, detail = '') {
    super(detail || problem);
    this.problem = problem;
  }
}

const redirectUri = () => `${location.origin}/auth/callback`;

/** Only paths on this site, never another host. */
export function safeReturn(path: string | null | undefined): string {
  return path && /^\/(?![/\\])/.test(path) && !path.startsWith('/auth/') ? path : '/';
}

/** Resolves when anything at all answers. Without this an unreachable provider is only a browser error page. */
async function providerAnswers(config: PublicConfig): Promise<boolean> {
  try {
    await fetch(config.oidc.tokenEndpoint, {
      mode: 'no-cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(6000),
    });
    return true;
  } catch { return false; }
}

export async function beginSignIn(config: PublicConfig, returnTo: string, skipCheck = false): Promise<void> {
  if (config.oidc.mode === 'server') {
    location.assign('/auth/login');
    return;
  }
  if (!skipCheck && !(await providerAnswers(config))) throw new SignInError('unreachable');
  let nonce: string;
  try {
    nonce = (await api.authBegin()).nonce;
  } catch (e) {
    throw new SignInError('network', e instanceof Error ? e.message : '');
  }
  const pending: Pending = { verifier: randomToken(), state: randomToken(), returnTo: safeReturn(returnTo) };
  try {
    sessionStorage.setItem(KEY, JSON.stringify(pending));
  } catch { throw new SignInError('storage'); }
  location.assign(authorizeUrl({
    endpoint: config.oidc.authorizationEndpoint, clientId: config.oidc.clientId, scope: config.oidc.scope,
    redirectUri: redirectUri(), state: pending.state, nonce, challenge: await challengeFor(pending.verifier),
  }));
}

function takePending(): Pending | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    const p = raw ? JSON.parse(raw) as Partial<Pending> : null;
    return p?.verifier && p.state ? { verifier: p.verifier, state: p.state, returnTo: safeReturn(p.returnTo) } : null;
  } catch { return null; }
}

/** Finishes a browser exchange and returns where to go next. The ID token never leaves this function except to our server. */
export async function finishSignIn(config: PublicConfig): Promise<string> {
  const search = location.search;
  const pending = takePending();
  history.replaceState(null, '', '/auth/callback');

  const result = readCallback(search, pending && { state: pending.state, issuer: config.oidc.issuer });
  if (!pending || !result.ok) {
    if (!result.ok && result.reason === 'provider_error') {
      throw new SignInError(result.error === 'access_denied' ? 'cancelled' : 'provider', result.error);
    }
    throw new SignInError('bad_state');
  }

  let res: Response;
  try {
    // A form body and no extra headers keep this a simple cross-origin request.
    res = await fetch(config.oidc.tokenEndpoint, {
      method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: result.code, redirect_uri: redirectUri(),
        client_id: config.oidc.clientId, code_verifier: pending.verifier,
      }),
    });
  } catch { throw new SignInError('unreachable'); }
  const token = await res.json().catch(() => null) as { id_token?: unknown } | null;
  if (!res.ok || typeof token?.id_token !== 'string') throw new SignInError('expired');

  try {
    await api.authSession(token.id_token);
  } catch (e) {
    if (e instanceof RequestError && (e.code === 'not_allowed' || e.code === 'groups_missing')) throw new SignInError(e.code);
    if (e instanceof RequestError && e.code === 'signin_expired') throw new SignInError('expired');
    if (e instanceof RequestError && e.status === 0) throw new SignInError('network', e.message);
    throw new SignInError('rejected', e instanceof Error ? e.message : '');
  }
  return pending.returnTo;
}
