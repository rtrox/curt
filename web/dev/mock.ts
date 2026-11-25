import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Link, LinkStats, Me, PublicConfig } from '@curt/shared/schemas';
import { isReservedSlug, isValidCustomSlug, normalizeSlug, randomSlug } from '@curt/shared';
import type { Connect, Plugin } from 'vite';

/**
 * A stand-in for the admin Worker and the sign-in provider, for `vite` and `vite preview` only.
 * Open /__mock to switch between the states below. Nothing here is part of a build.
 */
const SCENARIOS = {
  normal: 'Signed in as a member, one domain',
  admin: 'Signed in as an admin, two domains',
  empty: 'No links yet',
  'signed-out': 'Not signed in',
  'signed-out-server': 'Not signed in, server exchange',
  'not-allowed': 'Sign-in: account not in the group',
  'groups-missing': 'Sign-in: no groups claim',
  unreachable: 'Sign-in: provider cannot be reached',
  'code-expired': 'Sign-in: provider rejects the code',
  'stats-down': 'Click counts unavailable',
  sampled: 'Click counts are estimates',
  'list-error': 'Link list fails',
  'config-error': 'Configuration fails',
  slow: 'Every answer takes two seconds',
  'sync-pending': 'Changes are saved but not in effect until tried again',
  'sync-stuck': 'Changes are saved but never take effect',
  conflict: 'Every save meets a newer version',
  accent: 'Custom accent: pale yellow',
  'accent-blue': 'Custom accent: dark blue',
} as const;
type Scenario = keyof typeof SCENARIOS;

const MEMBER: Me = { id: 'u1', name: 'Sample Member', email: 'member@example.com', isAdmin: false };
const ADMIN: Me = { id: 'u2', name: 'Sample Admin', email: 'admin@example.com', isAdmin: true };
interface Person { id: string; name: string | null; email: string | null; isAdmin: boolean; activeSessions: number; activeTokens: number }
const now = () => Math.floor(Date.now() / 1000);

interface Token { id: string; name: string; scope: 'links' | 'metrics:read'; expiresAt: number | null; lastUsedDay: string | null }

class Failure extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

class World {
  scenario: Scenario = 'normal';
  signedIn = true;
  links: Link[] = [];
  tokens: Token[] = [];
  people: Person[] = [];
  /** Deleted links whose redirect copy is still there. */
  deleting = new Set<string>();
  constructor(s: Scenario = 'normal') { this.set(s); }

  get hosts(): string[] { return this.scenario === 'admin' ? ['go.example', 's.example'] : ['go.example']; }
  get me(): Me { return this.scenario === 'admin' ? ADMIN : MEMBER; }

  set(s: Scenario): void {
    this.scenario = s;
    this.deleting.clear();
    this.signedIn = !['signed-out', 'signed-out-server', 'not-allowed', 'groups-missing', 'unreachable', 'code-expired'].includes(s);
    const day = 86_400;
    const base: [string, string, string[], Partial<Link>?][] = [
      ['k3x9qa', 'https://example.com/guides/sourdough-starter', ['recipes']],
      ['garden', 'https://example.com/plans/raised-beds', ['home', 'garden']],
      ['p7rmzt', 'https://example.org/talks/edge-caching', ['work']],
      ['trip', 'https://example.net/itinerary/coast-drive', ['travel'], { expiresAt: now() + 20 * day }],
      ['old-menu', 'https://example.com/menu/2025', ['recipes'], { expiresAt: now() - 3 * day }],
      ['draft', 'https://example.org/a/very/long/path/that/keeps/going/for/quite/a/while/so-that-it-has-to-be-cut?with=query&and=more', [], { disabled: true }],
    ];
    for (let i = 0; i < 118; i++) base.push([`${'abcdefghjk'[i % 10]}${'mnpqrstuvw'[(i * 7) % 10]}${(i + 222).toString(36)}x`, `https://example.com/articles/${1000 + i}`, i % 3 ? [] : ['reading']]);
    this.links = s === 'empty' ? [] : base.map(([slug, destination, tags, extra], i) => {
      const mine = s !== 'admin' || i % 3 === 0;
      const domain = this.hosts[i % this.hosts.length] ?? 'go.example';
      return {
        id: randomUUID(), domain, slug, shortUrl: `https://${domain}/${slug}`, destination, tags, disabled: false, expiresAt: null,
        owner: mine ? { id: this.me.id, name: this.me.name } : { id: 'u1', name: MEMBER.name },
        version: 1, createdAt: now() - i * day - 4000, updatedAt: now() - i * day - 4000, ...extra,
      };
    });
    this.people = [
      { ...ADMIN, activeSessions: 1, activeTokens: 2 }, { ...MEMBER, activeSessions: 2, activeTokens: 1 },
      { id: 'u3', name: null, email: 'unnamed@example.com', isAdmin: true, activeSessions: 0, activeTokens: 0 },
    ];
    this.tokens = s === 'empty' ? [] : [
      { id: 't1', name: 'Laptop command line', scope: 'links', expiresAt: null, lastUsedDay: new Date().toISOString().slice(0, 10) },
      { id: 't2', name: 'Old script', scope: 'links', expiresAt: now() - 5 * day, lastUsedDay: null },
    ];
  }

  visible(): Link[] { return this.me.isAdmin ? this.links : this.links.filter((l) => l.owner.id === this.me.id); }
  find(id: string): Link {
    const l = this.visible().find((x) => x.id === id);
    if (!l) throw new Failure(404, 'not_found', 'No such link.');
    return l;
  }
}

function seeded(text: string): () => number {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822507) + 0x6d2b79f5 | 0; return ((h ^ (h >>> 13)) >>> 0) / 4294967296; };
}
function statsFor(l: Link, sampled: boolean): LinkStats {
  const r = seeded(l.slug);
  const size = l.slug === 'k3x9qa' ? 9 : l.slug === 'garden' ? 5 : r() * 2;
  const days = Array.from({ length: 90 }, (_, i) => {
    const day = new Date(Date.now() - (89 - i) * 86_400_000).toISOString().slice(0, 10);
    const wave = 1 + Math.sin(i / 3.5) * 0.6;
    return { day, clicks: l.disabled ? 0 : Math.max(0, Math.round((r() * size - 0.4) * wave)) };
  });
  const total = days.reduce((n, d) => n + d.clicks, 0);
  const bots = Math.round(total * 0.14);
  return { total, people: total - bots, bots, sampled, days };
}

function qrLike(text: string): string {
  const r = seeded(text);
  let d = '';
  for (let y = 0; y < 25; y++) for (let x = 0; x < 25; x++) {
    const corner = (x < 7 && y < 7) || (x > 17 && y < 7) || (x < 7 && y > 17);
    const cx = x > 17 ? x - 18 : x;
    const cy = y > 17 ? y - 18 : y;
    const ring = cx === 0 || cy === 0 || cx === 6 || cy === 6 || (cx > 1 && cx < 5 && cy > 1 && cy < 5);
    if (corner ? ring : r() > 0.52) d += `M${x * 8 + 32},${y * 8 + 32}h8v8h-8z`;
  }
  return `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 264 264" preserveAspectRatio="xMinYMin meet"><rect width="100%" height="100%" fill="white"/><path d="${d}" fill="black"/></svg>`;
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) raw += String(chunk);
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { throw new Failure(400, 'invalid_request', 'The request body must be JSON.'); }
}

function handler(world: World): Connect.NextHandleFunction {
  const configFor = (origin: string): PublicConfig => {
    const s = world.scenario;
    return {
      siteName: 'go.example',
      accent: s === 'accent' ? '#FFE9A8' : s === 'accent-blue' ? '#12206B' : null,
      oidc: {
        mode: s === 'signed-out-server' ? 'server' : 'browser', issuer: `${origin}/__provider`, clientId: 'mock',
        authorizationEndpoint: `${origin}/__provider/authorize`,
        // Port 9 is never listening, so the browser fails as it would for a private host.
        tokenEndpoint: s === 'unreachable' ? 'http://127.0.0.1:9/token' : `${origin}/__provider/token`,
        scope: 'openid profile email groups',
      },
    };
  };

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<unknown> {
    const { scenario: s } = world;
    const path = url.pathname.slice('/api/v1'.length);
    const q = url.searchParams;
    if (path === '/config') {
      if (s === 'config-error') throw new Failure(500, 'internal', 'Something went wrong.');
      return configFor(url.origin);
    }
    if (!world.signedIn) throw new Failure(401, 'unauthenticated', 'Sign in or send an API token.');
    if (path === '/me') return world.me;
    if (path === '/domains') return { domains: world.hosts.map((host) => ({ host })) };
    if (path === '/tags') {
      const n = new Map<string, number>();
      for (const l of world.visible()) for (const t of l.tags) n.set(t, (n.get(t) ?? 0) + 1);
      return { tags: [...n].map(([tag, count]) => ({ tag, count })).sort((a, b) => a.tag.localeCompare(b.tag)) };
    }
    if (path === '/links/availability') {
      const slug = normalizeSlug(q.get('slug') ?? '');
      const reason = isReservedSlug(slug) ? 'reserved' : !isValidCustomSlug(slug) ? 'invalid'
        : world.links.some((l) => l.domain === (q.get('domain') ?? 'go.example') && l.slug === slug) ? 'taken' : null;
      return { available: reason === null, reason };
    }
    if (path === '/links/stats') {
      if (s === 'stats-down') throw new Failure(503, 'stats_unavailable', 'Click data is not available right now.');
      const ids = (q.get('ids') ?? '').split(',');
      return { stats: Object.fromEntries(world.visible().filter((l) => ids.includes(l.id)).map((l) => [l.id, statsFor(l, s === 'sampled')])) };
    }
    if (path === '/links' && req.method === 'GET') {
      if (s === 'list-error') throw new Failure(500, 'internal', 'Something went wrong.');
      const text = (q.get('q') ?? '').toLowerCase();
      const all = world.visible().filter((l) =>
        (!text || l.slug.includes(text) || l.destination.toLowerCase().includes(text) || l.tags.some((t) => t.includes(text)))
        && (!q.get('tag') || l.tags.includes(q.get('tag') ?? '')) && (!q.get('domain') || l.domain === q.get('domain'))
        && (!q.get('owner') || l.owner.id === q.get('owner')));
      const from = Number(q.get('cursor') ?? 0);
      return { links: all.slice(from, from + 50), nextCursor: all.length > from + 50 ? String(from + 50) : null };
    }
    if (path === '/links' && req.method === 'POST') {
      const b = await bodyOf(req);
      const domain = typeof b.domain === 'string' ? b.domain : 'go.example';
      const slug = typeof b.slug === 'string' ? normalizeSlug(b.slug) : randomSlug();
      if (world.links.some((l) => l.domain === domain && l.slug === slug)) throw new Failure(409, 'slug_taken', 'That slug is already in use on this domain.');
      const l: Link = {
        id: randomUUID(), domain, slug, shortUrl: `https://${domain}/${slug}`, destination: new URL(String(b.destination)).href,
        tags: (b.tags as string[] | undefined) ?? [], disabled: false, expiresAt: (b.expiresAt as number | undefined) ?? null,
        owner: { id: world.me.id, name: world.me.name }, version: 1, createdAt: now(), updatedAt: now(),
      };
      world.links.unshift(l);
      res.statusCode = 201;
      return l;
    }
    const m = /^\/links\/([^/]+)(\/qr|\/stats)?$/.exec(path);
    if (m?.[1] && !m[2] && req.method === 'DELETE' && world.deleting.has(m[1])) {
      if (s === 'sync-stuck') { res.statusCode = 202; return { syncPending: true }; }
      world.deleting.delete(m[1]);
      res.statusCode = 204;
      res.end();
      return undefined;
    }
    if (m?.[1]) {
      const l = world.find(decodeURIComponent(m[1]));
      if (m[2] === '/qr') {
        res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
        res.end(qrLike(l.shortUrl));
        return undefined;
      }
      if (m[2] === '/stats') {
        if (s === 'stats-down') throw new Failure(503, 'stats_unavailable', 'Click data is not available right now.');
        return statsFor(l, s === 'sampled');
      }
      if (req.method === 'DELETE') {
        world.links = world.links.filter((x) => x !== l);
        if (s === 'sync-pending' || s === 'sync-stuck') {
          world.deleting.add(l.id);
          res.statusCode = 202;
          return { syncPending: true };
        }
        res.statusCode = 204;
        res.end();
        return undefined;
      }
      if (req.method === 'PATCH') {
        const b = await bodyOf(req);
        if (s === 'conflict' && l.version === 1) Object.assign(l, { version: 2, destination: 'https://example.org/changed-elsewhere', tags: [...l.tags, 'elsewhere'], updatedAt: now() });
        if (Number(req.headers['if-match']) !== l.version) throw new Failure(412, 'version_mismatch', 'The link has changed. Reload it and try again.');
        Object.assign(l, b, { version: l.version + 1, updatedAt: now() });
        // The repeat of a pending change goes through in one state and never in the other.
        if (s === 'sync-stuck' || (s === 'sync-pending' && !l.syncPending)) l.syncPending = true;
        else delete l.syncPending;
      }
      return l;
    }
    if (path === '/tokens' && req.method === 'POST') {
      const b = await bodyOf(req);
      const t: Token = { id: randomUUID(), name: String(b.name), scope: b.scope as Token['scope'], expiresAt: (b.expiresAt as number | null) ?? null, lastUsedDay: null };
      world.tokens.unshift(t);
      res.statusCode = 201;
      return { ...t, token: `mock_${randomBytes(32).toString('base64url')}` };
    }
    if (path === '/tokens') return { tokens: world.tokens };
    const t = /^\/tokens\/([^/]+)$/.exec(path);
    if (t && req.method === 'DELETE') {
      world.tokens = world.tokens.filter((x) => x.id !== t[1]);
      res.statusCode = 204;
      res.end();
      return undefined;
    }
    if (path === '/users' || path.startsWith('/users/')) {
      if (!world.me.isAdmin) throw new Failure(403, 'forbidden', 'Only admins can do this.');
      if (path === '/users') return { users: world.people };
      const target = world.people.find((p) => path === `/users/${p.id}/cutoff`);
      if (target && req.method === 'POST') {
        if (target.id === world.me.id) throw new Failure(409, 'cannot_cut_off_self', 'You cannot cut off yourself.');
        const answer = { sessionsEnded: target.activeSessions, tokensRevoked: target.activeTokens };
        Object.assign(target, { isAdmin: false, activeSessions: 0, activeTokens: 0 });
        return answer;
      }
    }
    throw new Failure(404, 'not_found', 'No such endpoint.');
  }

  async function auth(req: IncomingMessage, res: ServerResponse, url: URL): Promise<unknown> {
    if (url.pathname === '/auth/begin' && req.method === 'POST') return { nonce: randomBytes(16).toString('base64url') };
    if (url.pathname === '/auth/session' && req.method === 'POST') {
      await bodyOf(req);
      if (world.scenario === 'not-allowed') throw new Failure(403, 'not_allowed', 'Your account is not in the group that may use this site.');
      if (world.scenario === 'groups-missing') throw new Failure(403, 'groups_missing', 'The sign-in provider did not send a groups claim.');
      world.signedIn = true;
      return { ok: true };
    }
    if (url.pathname === '/auth/logout' && req.method === 'POST') { world.signedIn = false; return { ok: true }; }
    if (url.pathname === '/auth/login') {
      world.signedIn = true;
      res.statusCode = 302;
      res.setHeader('location', '/');
      res.end();
      return undefined;
    }
    throw new Failure(404, 'not_found', 'No such endpoint.');
  }

  return (req, res, next) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const done = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/__mock') {
      const wanted = url.searchParams.get('s');
      if (wanted && wanted in SCENARIOS) {
        world.set(wanted as Scenario);
        res.statusCode = 302;
        res.setHeader('location', url.searchParams.get('to') ?? '/');
        return void res.end();
      }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return void res.end(`<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>Mock states</title><h1>Mock states</h1><p>Now: ${world.scenario}</p><ul>${
        Object.entries(SCENARIOS).map(([k, v]) => `<li><a href="/__mock?s=${k}">${v}</a>`).join('')}</ul>`);
    }
    if (url.pathname === '/__provider/authorize') {
      const back = new URL(url.searchParams.get('redirect_uri') ?? '/', url.origin);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      back.searchParams.set('code', 'mock-code');
      res.statusCode = 302;
      res.setHeader('location', back.href);
      return void res.end();
    }
    if (url.pathname === '/__provider/token') {
      if (req.method !== 'POST') return done(405, { error: 'invalid_request' });
      if (world.scenario === 'code-expired') return done(400, { error: 'invalid_grant' });
      return done(200, { id_token: 'mock.id.token', token_type: 'Bearer' });
    }

    const isApi = url.pathname.startsWith('/api/');
    const isAuth = url.pathname.startsWith('/auth/') && url.pathname !== '/auth/callback';
    if (!isApi && !isAuth) {
      // The same policy as workers/admin/src/lib/pages.ts, so a build that breaks it fails here first.
      if (process.env.MOCK_CSP) {
        res.setHeader('content-security-policy', [
          "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self'",
          `connect-src 'self' ${new URL(configFor(url.origin).oidc.tokenEndpoint).origin}`, "form-action 'self'", "base-uri 'none'", "frame-ancestors 'none'",
        ].join('; '));
      }
      return next();
    }
    const run = async () => {
      if (world.scenario === 'slow') await new Promise((r) => setTimeout(r, 2000));
      try {
        const body = await (isApi ? api(req, res, url) : auth(req, res, url));
        if (body !== undefined) done(res.statusCode, body);
      } catch (e) {
        if (e instanceof Failure) done(e.status, { error: { code: e.code, message: e.message } });
        else done(500, { error: { code: 'internal', message: 'Something went wrong.' } });
      }
    };
    void run();
  };
}

export function mockApi(): Plugin {
  const world = new World();
  return {
    name: 'mock-api',
    apply: 'serve',
    configureServer(server) { server.middlewares.use(handler(world)); },
    configurePreviewServer(server) { server.middlewares.use(handler(world)); },
  };
}
