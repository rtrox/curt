import type { PublicConfig } from '@curt/shared/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beginSignIn, finishSignIn } from '../src/lib/auth.ts';

const config: PublicConfig = {
  siteName: 'Links', accent: null,
  oidc: {
    mode: 'browser', issuer: 'https://id.example', clientId: 'curt', scope: 'openid groups',
    authorizationEndpoint: 'https://id.example/authorize', tokenEndpoint: 'https://id.example/token',
  },
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let store: Map<string, string>;
let order: string[];
let assigned: string;
let fetched: ReturnType<typeof vi.fn>;

beforeEach(() => {
  store = new Map();
  order = [];
  assigned = '';
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k),
  });
  vi.stubGlobal('location', { origin: 'https://app.go.example', search: '', assign: (u: string) => { assigned = u; } });
  vi.stubGlobal('history', { replaceState: (_s: unknown, _t: string, u: string) => order.push(`url ${u}`) });
  fetched = vi.fn(async (path: string) => {
    order.push(path);
    if (path === '/auth/begin') return json({ nonce: 'the-nonce' });
    if (path === '/auth/session') return json({ ok: true });
    return json({ id_token: 'a.b.c' });
  });
  vi.stubGlobal('fetch', fetched);
});
afterEach(() => { vi.unstubAllGlobals(); });

async function begun(returnTo = '/links/1'): Promise<string> {
  await beginSignIn(config, returnTo);
  const state = new URL(assigned).searchParams.get('state') ?? '';
  location.search = `?code=the-code&state=${state}`;
  order.length = 0;
  fetched.mockClear();
  return state;
}

describe('browser sign-in', () => {
  it('asks for a nonce and goes to the provider', async () => {
    await beginSignIn(config, '/');
    const q = new URL(assigned).searchParams;
    expect(q.get('nonce')).toBe('the-nonce');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('redirect_uri')).toBe('https://app.go.example/auth/callback');
    expect(assigned).not.toContain(JSON.parse(store.get('curt.signin') ?? '{}').verifier);
  });

  it('cleans the address before exchanging the code, posts a plain form, and keeps nothing', async () => {
    await begun();
    expect(await finishSignIn(config)).toBe('/links/1');
    expect(order).toEqual(['url /auth/callback', 'https://id.example/token', '/auth/session']);
    const [, init] = fetched.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toBeUndefined();
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error' });
    expect(Object.fromEntries(init.body as URLSearchParams)).toMatchObject({ grant_type: 'authorization_code', code: 'the-code', client_id: 'curt' });
    expect(fetched.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', body: '{"id_token":"a.b.c"}' });
    expect(store.size).toBe(0);
  });

  it('does not exchange anything when the state is wrong or already used', async () => {
    await begun();
    location.search = '?code=the-code&state=other';
    await expect(finishSignIn(config)).rejects.toMatchObject({ problem: 'bad_state' });
    await expect(finishSignIn(config)).rejects.toMatchObject({ problem: 'bad_state' });
    expect(fetched).not.toHaveBeenCalled();
  });

  it('names each problem', async () => {
    const cases: [string, () => Promise<Response>, string][] = [
      ['/auth/session', async () => json({ error: { code: 'not_allowed', message: 'x' } }, 403), 'not_allowed'],
      ['/auth/session', async () => json({ error: { code: 'groups_missing', message: 'x' } }, 403), 'groups_missing'],
      ['/auth/session', async () => json({ error: { code: 'signin_expired', message: 'x' } }, 400), 'expired'],
      ['/auth/session', async () => json({ error: { code: 'invalid_token', message: 'x' } }, 401), 'rejected'],
      ['https://id.example/token', async () => { throw new TypeError('failed'); }, 'unreachable'],
      ['https://id.example/token', async () => json({ error: 'invalid_grant' }, 400), 'expired'],
    ];
    for (const [path, answer, problem] of cases) {
      await begun();
      const usual = fetched.getMockImplementation();
      fetched.mockImplementation(async (p: string) => (p === path ? answer() : json({ id_token: 'a.b.c' })));
      await expect(finishSignIn(config)).rejects.toMatchObject({ problem });
      fetched.mockImplementation(usual!);
    }
  });

  it('stops before leaving when the provider does not answer, unless told to go on', async () => {
    fetched.mockImplementation(async (p: string) => {
      if (p === '/auth/begin') return json({ nonce: 'n' });
      throw new TypeError('failed');
    });
    await expect(beginSignIn(config, '/')).rejects.toMatchObject({ problem: 'unreachable' });
    expect(assigned).toBe('');
    await beginSignIn(config, '/', true);
    expect(assigned).toContain('https://id.example/authorize');
  });

  it('leaves everything to the server in server exchange', async () => {
    await beginSignIn({ ...config, oidc: { ...config.oidc, mode: 'server' } }, '/');
    expect(assigned).toBe('/auth/login');
    expect(fetched).not.toHaveBeenCalled();
  });
});
