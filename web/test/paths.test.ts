import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The router reads the address when it loads, so a minimal one has to exist first.
beforeAll(() => {
  vi.stubGlobal('location', { pathname: '/', origin: 'https://app.go.example' });
  vi.stubGlobal('addEventListener', () => {});
  return () => { vi.unstubAllGlobals(); };
});

describe('paths', () => {
  it('only returns to pages on this site', async () => {
    const { safeReturn } = await import('../src/lib/auth.ts');
    expect(safeReturn('/links/1')).toBe('/links/1');
    for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', '', null, undefined, '/auth/callback']) expect(safeReturn(bad)).toBe('/');
  });
  it('recognizes routes', async () => {
    const { parsePath } = await import('../src/lib/router.svelte.ts');
    expect(parsePath('/')).toEqual({ page: 'home' });
    expect(parsePath('/people')).toEqual({ page: 'people' });
    expect(parsePath('/links/a%2Fb')).toEqual({ page: 'link', id: 'a/b' });
    expect(parsePath('/links/%')).toEqual({ page: 'missing' });
    expect(parsePath('/nope')).toEqual({ page: 'missing' });
  });
});

describe('api client', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it('sends the version when editing and reads error bodies', async () => {
    const fetched = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'version_mismatch', message: 'Changed.' } }), { status: 412 }));
    const { api } = await import('../src/lib/api.ts');
    await expect(api.update('a', 3, { disabled: true })).rejects.toMatchObject({ status: 412, code: 'version_mismatch', message: 'Changed.' });
    const [path, init] = fetched.mock.calls[0] ?? [];
    expect(path).toBe('/api/v1/links/a');
    expect(init).toMatchObject({ method: 'PATCH', body: '{"disabled":true}', headers: { 'if-match': '3' } });
  });
  it('tells a lost connection from a refusal, and reports an ended session', async () => {
    const { api, whenSignedOut } = await import('../src/lib/api.ts');
    const ended = vi.fn();
    whenSignedOut(ended);
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('failed')).mockResolvedValueOnce(new Response('no', { status: 401 }));
    await expect(api.me()).rejects.toMatchObject({ status: 0, code: 'network' });
    expect(ended).not.toHaveBeenCalled();
    await expect(api.me()).rejects.toMatchObject({ status: 401 });
    expect(ended).toHaveBeenCalledOnce();
  });
});
