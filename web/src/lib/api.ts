import type {
  ApiToken, CreateLink, cutoffSchema, Link, LinkStats, Me, PublicConfig, UpdateLink, userListSchema,
} from '@curt/shared/schemas';

export type Person = (typeof userListSchema)['_output']['users'][number];
export type Cutoff = (typeof cutoffSchema)['_output'];

export class RequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let onSignedOut: () => void = () => {};
export function whenSignedOut(fn: () => void): void { onSignedOut = fn; }

interface Options { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal | undefined }

async function send(path: string, o: Options = {}): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json', ...o.headers };
  const init: RequestInit = { method: o.method ?? 'GET', headers, credentials: 'same-origin' };
  if (o.signal) init.signal = o.signal;
  if (o.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(o.body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new RequestError(0, 'network', 'The server could not be reached. Check your connection and try again.');
  }
  if (res.ok) return res;
  const body = await res.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
  const error = new RequestError(
    res.status,
    body?.error?.code ?? 'unknown',
    body?.error?.message ?? (res.status === 429 ? 'Too many requests. Wait a moment and try again.' : 'Something went wrong. Try again.'),
  );
  if (res.status === 401 && path.startsWith('/api/')) onSignedOut();
  throw error;
}

async function json<T>(path: string, o?: Options): Promise<T> {
  const res = await send(path, o);
  return await res.json() as T;
}

export interface ListFilters { q: string; tag: string; domain: string; owner: string }
const enc = encodeURIComponent;

function query(params: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const api = {
  config: () => json<PublicConfig>('/api/v1/config'),
  me: () => json<Me>('/api/v1/me'),
  domains: () => json<{ domains: { host: string }[] }>('/api/v1/domains'),
  tags: () => json<{ tags: { tag: string; count: number }[] }>('/api/v1/tags'),

  links: (f: ListFilters, cursor: string | null, signal?: AbortSignal) =>
    json<{ links: Link[]; nextCursor: string | null }>(`/api/v1/links${query({ ...f, q: f.q.trim(), cursor })}`, { signal }),
  link: (id: string) => json<Link>(`/api/v1/links/${enc(id)}`),
  create: (body: CreateLink) => json<Link>('/api/v1/links', { method: 'POST', body }),
  update: (id: string, version: number, body: UpdateLink) =>
    json<Link>(`/api/v1/links/${enc(id)}`, { method: 'PATCH', body, headers: { 'if-match': String(version) } }),
  /** True when the link is deleted but its redirect copy could not be removed yet. */
  remove: async (id: string): Promise<boolean> => (await send(`/api/v1/links/${enc(id)}`, { method: 'DELETE' })).status === 202,
  availability: (domain: string, slug: string, signal?: AbortSignal) =>
    json<{ available: boolean; reason: 'taken' | 'invalid' | 'reserved' | null }>(
      `/api/v1/links/availability${query({ domain, slug })}`, { signal }),
  qr: async (id: string): Promise<string> => (await send(`/api/v1/links/${enc(id)}/qr`)).text(),
  stats: (id: string) => json<LinkStats>(`/api/v1/links/${enc(id)}/stats`),
  manyStats: (ids: readonly string[]) =>
    json<{ stats: Record<string, LinkStats> }>(`/api/v1/links/stats${query({ ids: ids.join(',') })}`),

  tokens: () => json<{ tokens: ApiToken[] }>('/api/v1/tokens'),
  createToken: (body: { name: string; scope: ApiToken['scope']; expiresAt: number | null }) =>
    json<ApiToken & { token: string }>('/api/v1/tokens', { method: 'POST', body }),
  revokeToken: async (id: string): Promise<void> => { await send(`/api/v1/tokens/${enc(id)}`, { method: 'DELETE' }); },

  users: () => json<{ users: Person[] }>('/api/v1/users'),
  cutOff: (id: string) => json<Cutoff>(`/api/v1/users/${enc(id)}/cutoff`, { method: 'POST' }),

  authBegin: () => json<{ nonce: string }>('/auth/begin', { method: 'POST' }),
  authSession: async (idToken: string): Promise<void> => {
    await send('/auth/session', { method: 'POST', body: { id_token: idToken } });
  },
  signOut: async (): Promise<void> => { await send('/auth/logout', { method: 'POST' }); },
};

export function messageOf(e: unknown): string {
  return e instanceof RequestError ? e.message : 'Something went wrong. Try again.';
}
export const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError';
