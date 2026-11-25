import { isReservedSlug, isValidCustomSlug, normalizeSlug, parseDomains } from '@curt/shared';
import type { DomainConfig, Outcome } from '@curt/shared';
import { recordClick } from './click.ts';
import { errorPage, redirect } from './pages.ts';
import { findLink } from './resolve.ts';

export interface Env {
  LINKS: KVNamespace;
  DB: D1Database;
  CLICKS: AnalyticsEngineDataset;
  /** JSON array, see parseDomains. */
  DOMAINS: string;
  VISITOR_MODE: 'off' | 'hash' | 'full';
}

interface Decision {
  response: Response;
  outcome: Outcome;
  linkId: string | null;
  slug: string;
}

let parsed: { raw: string; domains: DomainConfig[] } | null = null;

function findDomain(raw: string, hostname: string): DomainConfig | undefined {
  if (parsed?.raw !== raw) parsed = { raw, domains: parseDomains(raw) };
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return parsed.domains.find((d) => d.host === host);
}

/** The decoded path without its slashes, or null when the percent-encoding is malformed. */
function decodePath(pathname: string): string | null {
  try {
    return normalizeSlug(decodeURIComponent(pathname.slice(1)).replace(/\/$/, ''));
  } catch {
    return null;
  }
}

function reservedResponse(path: string): Response | null {
  const name = path.startsWith('.well-known/') ? '.well-known' : path;
  if (!isReservedSlug(name)) return null;
  if (name === 'robots.txt') {
    return new Response('User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  if (name === 'favicon.ico') return new Response(null, { status: 204 });
  return errorPage('not_found');
}

async function resolveSlug(env: Env, domain: string, path: string | null): Promise<Decision | Response> {
  // No stored slug can fail this check, so oversized or malformed paths never cost a KV or D1 read.
  if (path === null || !isValidCustomSlug(path)) {
    return { response: errorPage('not_found'), outcome: 'not_found', linkId: null, slug: '' };
  }
  const result = await findLink(env, domain, path);
  if (result.status === 'unavailable') return errorPage('unavailable');
  if (result.status === 'missing') {
    return { response: errorPage('not_found'), outcome: 'not_found', linkId: null, slug: path };
  }
  const { link } = result;
  const found = { linkId: link.id, slug: path };
  if (link.disabled) return { ...found, response: errorPage('disabled'), outcome: 'disabled' };
  if (link.expiresAt !== null && link.expiresAt * 1000 <= Date.now()) {
    return { ...found, response: errorPage('expired'), outcome: 'expired' };
  }
  return { ...found, response: redirect(link.destination), outcome: 'ok' };
}

async function decide(env: Env, domain: DomainConfig, pathname: string): Promise<Decision | Response> {
  if (pathname === '/') return { response: redirect(domain.root), outcome: 'root', linkId: null, slug: '' };
  const path = decodePath(pathname);
  const reserved = path === null ? null : reservedResponse(path);
  return reserved ?? (await resolveSlug(env, domain.host, path));
}

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const domain = findDomain(env.DOMAINS, url.hostname);
  if (!domain) return errorPage('not_found');

  const decision = await decide(env, domain, url.pathname);
  if (decision instanceof Response) return decision;

  // A click is recorded only when there is an outcome to record: not for reserved paths or outages.
  const { response, ...click } = decision;
  ctx.waitUntil(recordClick(request, env, { ...click, domain: domain.host }));
  return response;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'private, no-store' } });
    }
    const response = await handle(request, env, ctx);
    return request.method === 'HEAD' ? new Response(null, response) : response;
  },
} satisfies ExportedHandler<Env>;
