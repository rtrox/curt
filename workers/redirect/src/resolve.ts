import { decodeLink, linkKey } from '@curt/shared';
import type { KvLink } from '@curt/shared';
import type { Env } from './index.ts';
import { logFailure } from './log.ts';

export type LinkResult = { status: 'found'; link: KvLink } | { status: 'missing' } | { status: 'unavailable' };

interface LinkRow {
  id: string;
  destination: string;
  version: number;
  disabled: number;
  expires_at: number | null;
}

/** Only an http or https URL may become a Location header, whatever the stores contain. */
function withSafeDestination(link: KvLink | null): KvLink | null {
  if (!link) return null;
  try {
    const url = new URL(link.destination);
    return url.protocol === 'http:' || url.protocol === 'https:' ? { ...link, destination: url.href } : null;
  } catch {
    return null;
  }
}

async function fromKv(env: Env, domain: string, slug: string): Promise<KvLink | null> {
  try {
    return withSafeDestination(decodeLink(await env.LINKS.get(linkKey(domain, slug))));
  } catch (error) {
    logFailure('kv_read_failed', error);
    return null;
  }
}

async function fromD1(env: Env, domain: string, slug: string): Promise<KvLink | null> {
  // Reading the primary is what lets a link work the moment it is created.
  const db = typeof env.DB.withSession === 'function' ? env.DB.withSession('first-primary') : env.DB;
  const row = await db
    .prepare('SELECT id, destination, version, disabled, expires_at FROM links WHERE domain = ?1 AND slug = ?2')
    .bind(domain, slug)
    .first<LinkRow>();
  if (!row) return null;
  return withSafeDestination({
    id: row.id,
    destination: row.destination,
    version: row.version,
    disabled: row.disabled !== 0,
    expiresAt: row.expires_at,
  });
}

/** This Worker never writes link entries to KV: a late write could overwrite a newer edit. */
export async function findLink(env: Env, domain: string, slug: string): Promise<LinkResult> {
  const cached = await fromKv(env, domain, slug);
  if (cached) return { status: 'found', link: cached };
  try {
    const link = await fromD1(env, domain, slug);
    return link ? { status: 'found', link } : { status: 'missing' };
  } catch (error) {
    logFailure('d1_read_failed', error);
    return { status: 'unavailable' };
  }
}
