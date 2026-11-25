import { normalizeSlug, randomSlug } from '@curt/shared';
import type { Link, UpdateLink } from '@curt/shared/schemas';
import { ApiError } from '../lib/errors.ts';
import type { Auth, Env } from '../types.ts';
import type { ListCursor } from './input.ts';
import { nowSeconds } from './input.ts';
import { parseKey, syncAfterWrite } from './sync.ts';
import type { Background, Target } from './sync.ts';
import { forgetTags, readTags, writeTags } from './tagcache.ts';
import type { TagCount } from './tagcache.ts';

const RANDOM_SLUG_TRIES = 5;

interface LinkRow {
  id: string; domain: string; slug: string; destination: string; tags: string;
  owner_id: string; owner_name: string | null; disabled: number; expires_at: number | null;
  version: number; kv_version: number; created_at: number; updated_at: number;
}

const SELECT_LINK = `
  SELECT l.id, l.domain, l.slug, l.destination, l.owner_id, u.name AS owner_name, l.disabled, l.expires_at,
    l.version, l.kv_version, l.created_at, l.updated_at,
    (SELECT json_group_array(tag) FROM (SELECT tag FROM tags WHERE link_id = l.id ORDER BY tag)) AS tags
  FROM links l LEFT JOIN users u ON u.id = l.owner_id`;

function toLink(r: LinkRow, synced = r.kv_version >= r.version): Link {
  return {
    id: r.id, domain: r.domain, slug: r.slug, shortUrl: `https://${r.domain}/${r.slug}`, destination: r.destination,
    tags: JSON.parse(r.tags) as string[], disabled: r.disabled === 1, expiresAt: r.expires_at,
    owner: { id: r.owner_id, name: r.owner_name }, version: r.version, ...(synced ? {} : { syncPending: true }), createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const notFound = () => new ApiError(404, 'not_found', 'No such link.');

/** A condition that holds only for one link the caller may see, with its parameters. */
function oneLink(auth: Auth, id: string, alias = ''): { sql: string; params: unknown[] } {
  return auth.isAdmin
    ? { sql: `${alias}id = ?`, params: [id] }
    : { sql: `${alias}id = ? AND ${alias}owner_id = ?`, params: [id, auth.userId] };
}

function selectOne(env: Env, auth: Auth, id: string): D1PreparedStatement {
  const mine = oneLink(auth, id, 'l.');
  return env.DB.prepare(`${SELECT_LINK} WHERE ${mine.sql}`).bind(...mine.params);
}

export async function getLink(env: Env, auth: Auth, id: string): Promise<Link> {
  const row = await selectOne(env, auth, id).first<LinkRow>();
  if (!row) throw notFound();
  return toLink(row);
}

export interface ListFilter {
  q?: string | undefined;
  slug?: string | undefined;
  tag?: string | undefined;
  domain?: string | undefined;
  owner?: string | undefined;
  cursor?: ListCursor | undefined;
  limit: number;
}

/** Beyond this many distinct tags, scanning every tag row reads less than looking the distinct ones up by index. */
const FEW_TAGS = 1000;

/** A condition for links with a tag containing `q`, reading each tag row at most once. */
async function tagContains(env: Env, q: string): Promise<{ sql: string; param: string }> {
  const { results } = await env.DB.prepare(
    `WITH RECURSIVE d(tag) AS (
       SELECT min(tag) FROM tags UNION ALL SELECT (SELECT min(tag) FROM tags WHERE tag > d.tag) FROM d WHERE d.tag IS NOT NULL LIMIT ?
     ) SELECT tag FROM d WHERE tag IS NOT NULL`,
  ).bind(FEW_TAGS + 1).all<{ tag: string }>();
  if (results.length > FEW_TAGS) return { sql: 'l.id IN (SELECT link_id FROM tags WHERE instr(tag, ?) > 0)', param: q };
  const matching = results.map((r) => r.tag).filter((t) => t.includes(q));
  return { sql: 'l.id IN (SELECT link_id FROM tags WHERE tag IN (SELECT value FROM json_each(?)))', param: JSON.stringify(matching) };
}

export async function listLinks(env: Env, auth: Auth, f: ListFilter): Promise<{ links: Link[]; next: ListCursor | null }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, ...values: unknown[]) => { where.push(sql); params.push(...values); };

  const slug = f.slug === undefined ? '' : normalizeSlug(f.slug);
  // The plus keeps SQLite from walking all of an owner's links when the slug index finds the few that match.
  const owner = slug ? '+l.owner_id = ?' : 'l.owner_id = ?';
  if (!auth.isAdmin) add(owner, auth.userId);
  else if (f.owner) add(owner, f.owner);
  // Likewise, only a slug makes (domain, slug) the better index; otherwise it would sort a whole domain's links for one page.
  if (f.domain) add(slug ? 'l.domain = ?' : '+l.domain = ?', f.domain.trim().toLowerCase());
  if (slug) add('l.slug = ?', slug);
  const tag = f.tag?.trim().toLowerCase();
  if (tag) add('EXISTS (SELECT 1 FROM tags t WHERE t.link_id = l.id AND t.tag = ?)', tag);
  const q = f.q?.trim().toLowerCase();
  if (q) {
    // instr, not LIKE: D1 refuses LIKE patterns over 50 bytes, and instr takes % and _ literally.
    const tagged = await tagContains(env, q);
    add(`(instr(l.slug, ?) > 0 OR instr(lower(l.destination), ?) > 0 OR ${tagged.sql})`, q, q, tagged.param);
  }
  if (f.cursor) add('(l.created_at, l.id) < (?, ?)', f.cursor.createdAt, f.cursor.id);

  const { results } = await env.DB.prepare(
    `${SELECT_LINK}${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY l.created_at DESC, l.id DESC LIMIT ?`,
  ).bind(...params, f.limit + 1).all<LinkRow>();
  const page = results.slice(0, f.limit);
  const last = page.at(-1);
  return {
    links: page.map((r) => toLink(r)),
    next: results.length > f.limit && last ? { createdAt: last.created_at, id: last.id } : null,
  };
}

export async function slugTaken(env: Env, domain: string, slug: string): Promise<boolean> {
  return (await env.DB.prepare('SELECT 1 FROM links WHERE domain = ? AND slug = ?').bind(domain, slug).first()) !== null;
}

export interface NewLink {
  destination: string;
  domain: string;
  /** Null for a random one. */
  slug: string | null;
  tags: string[];
  disabled: boolean;
  expiresAt: number | null;
  /** Names of the fields the caller sent, for the audit record. */
  fields: string[];
}

export async function createLink(env: Env, auth: Auth, background: Background, link: NewLink): Promise<Link> {
  for (let i = 0; i < (link.slug === null ? RANDOM_SLUG_TRIES : 1); i++) {
    const slug = link.slug ?? randomSlug();
    const row = await insertLink(env, auth, link, slug);
    if (row) {
      const [synced] = await Promise.all([syncAfterWrite(env, background, link.domain, slug), forgetTags(env, auth)]);
      return toLink(row, synced);
    }
  }
  if (link.slug !== null) throw new ApiError(409, 'slug_taken', 'That slug is already in use on this domain.');
  throw new ApiError(503, 'no_free_slug', 'Could not find a free slug. Try again.');
}

/** Returns null when the slug is taken. */
async function insertLink(env: Env, auth: Auth, link: NewLink, slug: string): Promise<LinkRow | null> {
  const id = crypto.randomUUID();
  const now = nowSeconds();
  try {
    const results = await env.DB.batch<LinkRow>([
      env.DB.prepare(
        'INSERT INTO links (id, domain, slug, destination, owner_id, disabled, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(id, link.domain, slug, link.destination, auth.userId, link.disabled ? 1 : 0, link.expiresAt, now, now),
      env.DB.prepare('INSERT INTO tags (link_id, tag) SELECT ?, value FROM json_each(?)').bind(id, JSON.stringify(link.tags)),
      env.DB.prepare('INSERT INTO audit (id, at, user_id, action, link_id, detail) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), now, auth.userId, 'link.create', id, JSON.stringify(link.fields)),
      selectOne(env, auth, id),
    ]);
    return results.at(-1)!.results[0]!;
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE constraint failed: links.domain, links.slug')) return null;
    throw err;
  }
}

function sameValue(link: Link, field: string, value: unknown): boolean {
  const sorted = (v: unknown) => JSON.stringify(Array.isArray(v) ? [...v].sort() : v);
  return sorted(link[field as keyof Link]) === sorted(value);
}

/** Changes a link only if it is still at `version`. `current` is what the caller just read. */
export async function updateLink(
  env: Env, auth: Auth, background: Background, current: Link, version: number, change: UpdateLink,
): Promise<Link> {
  const id = current.id;
  const set: string[] = [];
  const values: unknown[] = [];
  const add = (column: string, value: unknown) => { set.push(`${column} = ?`); values.push(value); };
  if (change.destination !== undefined) add('destination', change.destination);
  if (change.expiresAt !== undefined) add('expires_at', change.expiresAt);
  if (change.disabled !== undefined) add('disabled', change.disabled ? 1 : 0);
  const fields = Object.entries(change).filter(([, v]) => v !== undefined).map(([k]) => k).sort();

  const stale = () => new ApiError(412, 'version_mismatch', 'The link has changed. Reload it and try again.');
  if (fields.every((f) => sameValue(current, f, change[f as keyof UpdateLink]))) {
    if (current.version !== version) throw stale();
    const { syncPending, ...link } = current;
    if (!syncPending) return link;
    // Nothing to save, but the last change has yet to reach KV: this is how "Try again" works.
    return (await syncAfterWrite(env, background, link.domain, link.slug)) ? link : current;
  }

  const now = nowSeconds();
  const auditId = crypto.randomUUID();
  const mine = oneLink(auth, id);
  // The audit row is inserted only if the version still matches; the rest of the batch applies only if it was.
  const applied = 'EXISTS (SELECT 1 FROM audit WHERE id = ?)';
  const statements = [
    env.DB.prepare(
      `INSERT INTO audit (id, at, user_id, action, link_id, detail) SELECT ?, ?, ?, 'link.update', id, ? FROM links WHERE ${mine.sql} AND version = ?`,
    ).bind(auditId, now, auth.userId, JSON.stringify(fields), ...mine.params, version),
    env.DB.prepare(`UPDATE links SET ${[...set, 'version = version + 1', 'updated_at = ?'].join(', ')} WHERE id = ? AND ${applied} RETURNING id`)
      .bind(...values, now, id, auditId),
  ];
  if (change.tags !== undefined) {
    statements.push(
      env.DB.prepare(`DELETE FROM tags WHERE link_id = ? AND ${applied}`).bind(id, auditId),
      env.DB.prepare(`INSERT INTO tags (link_id, tag) SELECT ?, value FROM json_each(?) WHERE ${applied}`)
        .bind(id, JSON.stringify(change.tags), auditId),
    );
  }
  const results = await env.DB.batch<LinkRow>([...statements, selectOne(env, auth, id)]);
  const row = results.at(-1)!.results[0];
  if (!row) throw notFound();
  if (results[1]!.results.length === 0) throw stale();
  const [synced] = await Promise.all([syncAfterWrite(env, background, row.domain, row.slug), forgetTags(env, auth)]);
  return toLink(row, synced);
}

/** Returns whether KV is known to match. Deleting again repeats the KV part, for as long as the tombstone is kept. */
export async function deleteLink(env: Env, auth: Auth, background: Background, id: string): Promise<boolean> {
  const now = nowSeconds();
  const mine = oneLink(auth, id);
  const results = await env.DB.batch<Target>([
    env.DB.prepare(`INSERT INTO audit (id, at, user_id, action, link_id) SELECT ?, ?, ?, 'link.delete', id FROM links WHERE ${mine.sql}`)
      .bind(crypto.randomUUID(), now, auth.userId, ...mine.params),
    env.DB.prepare(
      `INSERT INTO kv_deletes (kv_key, requested_at, link_id, owner_id)
       SELECT 'l:' || domain || ':' || slug, ?, id, owner_id FROM links WHERE ${mine.sql}
       ON CONFLICT (kv_key) DO UPDATE SET requested_at = excluded.requested_at, confirmed = 0, link_id = excluded.link_id, owner_id = excluded.owner_id`,
    ).bind(now, ...mine.params),
    env.DB.prepare(`DELETE FROM links WHERE ${mine.sql} RETURNING domain, slug`).bind(...mine.params),
  ]);
  const gone = results[2]!.results[0];
  if (gone) {
    const [synced] = await Promise.all([syncAfterWrite(env, background, gone.domain, gone.slug), forgetTags(env, auth)]);
    return synced;
  }
  const row = await env.DB.prepare(`SELECT kv_key FROM kv_deletes WHERE link_id = ?${auth.isAdmin ? '' : ' AND owner_id = ?'}`)
    .bind(...mine.params).first<{ kv_key: string }>();
  const target = row && parseKey(row.kv_key);
  if (!target) throw notFound();
  return syncAfterWrite(env, background, target.domain, target.slug);
}

/** Up to this many links, going from links to their tags reads fewer rows than going through every tag. */
const FEW_LINKS = 500;

export async function listTags(env: Env, auth: Auth): Promise<TagCount[]> {
  const kept = await readTags(env, auth);
  if (kept) return kept;
  let query: D1PreparedStatement;
  if (auth.isAdmin) {
    query = env.DB.prepare('SELECT tag, count(*) AS count FROM tags GROUP BY tag ORDER BY tag');
  } else {
    const own = await env.DB.prepare('SELECT count(*) AS n FROM (SELECT 1 FROM links WHERE owner_id = ? LIMIT ?)')
      .bind(auth.userId, FEW_LINKS + 1).first<{ n: number }>();
    // CROSS JOIN and the plus fix the order, so that links and tags are each read at most once.
    query = env.DB.prepare(own!.n <= FEW_LINKS
      ? 'SELECT t.tag, count(*) AS count FROM links l CROSS JOIN tags t ON t.link_id = l.id WHERE l.owner_id = ? GROUP BY t.tag ORDER BY t.tag'
      : 'SELECT tag, count(*) AS count FROM tags WHERE +link_id IN (SELECT id FROM links WHERE owner_id = ?) GROUP BY tag ORDER BY tag',
    ).bind(auth.userId);
  }
  const { results } = await query.all<TagCount>();
  await writeTags(env, auth, results);
  return results;
}

export async function getUser(env: Env, id: string): Promise<{ id: string; name: string | null; email: string | null } | null> {
  return env.DB.prepare('SELECT id, name, email FROM users WHERE id = ?').bind(id).first();
}
