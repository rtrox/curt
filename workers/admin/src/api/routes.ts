import { isReservedSlug, isValidCustomSlug, normalizeSlug } from '@curt/shared';
import { availabilityQuery, createLinkSchema, listLinksQuery, updateLinkSchema } from '@curt/shared/schemas';
import type { deletePendingSchema, exportSchema, Me, PublicConfig, resyncSchema } from '@curt/shared/schemas';
import { Hono } from 'hono';
import type { Context } from 'hono';
import qrcode from 'qrcode-generator';
import type { z } from 'zod';
import { oidcScope } from '../auth/config.ts';
import { requireAuth } from '../auth/middleware.ts';
import { shortHosts } from '../lib/config.ts';
import { ApiError } from '../lib/errors.ts';
import type { AppEnv, Auth } from '../types.ts';
import {
  decodeListCursor, decodeResyncCursor, encodeListCursor, encodeResyncCursor, parse, readJson, requireFuture, requireVersion,
  resolveDestination, resolveDomain,
} from './input.ts';
import { createLink, deleteLink, getLink, getUser, listLinks, listTags, slugTaken, updateLink } from './store.ts';
import { resyncPage } from './sync.ts';
import type { Background } from './sync.ts';

const EXPORT_PAGE = 500;

/** Mounted at /api/v1. Owned by the API task. */
export const apiRoutes = new Hono<AppEnv>();

apiRoutes.use('*', async (c, next) => {
  await next();
  c.res.headers.set('cache-control', 'no-store');
});

function requireAdmin(auth: Auth | null): Auth {
  const a = requireAuth(auth);
  if (!a.isAdmin) throw new ApiError(403, 'forbidden', 'Only admins can do this.');
  return a;
}

/** Runs a write to its end even if the client disconnects, so that a change saved in D1 also reaches KV. */
function finish<T>(c: Context<AppEnv>, write: (background: Background) => Promise<T>): Promise<T> {
  const background: Background = (work) => c.executionCtx.waitUntil(work);
  const work = write(background);
  background(work.catch(() => undefined));
  return work;
}

apiRoutes.get('/config', (c) => {
  const e = c.env;
  const config: PublicConfig = {
    siteName: e.SITE_NAME,
    accent: e.ACCENT || null,
    oidc: {
      mode: e.OIDC_EXCHANGE, issuer: e.OIDC_ISSUER, clientId: e.OIDC_CLIENT_ID,
      authorizationEndpoint: e.OIDC_AUTHORIZATION_ENDPOINT, tokenEndpoint: e.OIDC_TOKEN_ENDPOINT, scope: oidcScope(e),
    },
  };
  return c.json(config);
});

apiRoutes.get('/me', async (c) => {
  const auth = requireAuth(c.var.auth);
  const user = await getUser(c.env, auth.userId);
  if (!user) throw new ApiError(401, 'unauthenticated', 'Sign in again.');
  const me: Me = { ...user, isAdmin: auth.isAdmin };
  return c.json(me);
});

apiRoutes.get('/domains', (c) => {
  requireAuth(c.var.auth);
  return c.json({ domains: shortHosts(c.env).map((host) => ({ host })) });
});

apiRoutes.get('/tags', async (c) => {
  const auth = requireAuth(c.var.auth);
  return c.json({ tags: await listTags(c.env, auth) });
});

apiRoutes.get('/links', async (c) => {
  const auth = requireAuth(c.var.auth);
  const { cursor, ...filter } = parse(listLinksQuery, c.req.query());
  if (filter.owner && !auth.isAdmin) throw new ApiError(403, 'forbidden', 'Only admins can filter by owner.');
  const { links, next } = await listLinks(c.env, auth, { ...filter, cursor: cursor ? decodeListCursor(cursor) : undefined });
  return c.json({ links, nextCursor: next && encodeListCursor(next) });
});

apiRoutes.post('/links', async (c) => {
  const auth = requireAuth(c.var.auth);
  const body = parse(createLinkSchema, await readJson(c));
  const domain = resolveDomain(c.env, body.domain);
  const destination = resolveDestination(c.env, body.destination);
  requireFuture(body.expiresAt);
  const slug = body.slug === undefined ? null : normalizeSlug(body.slug);
  if (slug !== null) {
    if (isReservedSlug(slug)) throw new ApiError(400, 'reserved_slug', 'That slug is reserved.');
    if (!isValidCustomSlug(slug)) {
      throw new ApiError(400, 'invalid_slug', 'Use letters, digits, hyphens and underscores, starting and ending with a letter or digit.');
    }
  }
  const link = await finish(c, (background) => createLink(c.env, auth, background, {
    destination, domain, slug, tags: body.tags ?? [], disabled: body.disabled ?? false, expiresAt: body.expiresAt ?? null, fields: Object.keys(body).sort(),
  }));
  return c.json(link, 201);
});

apiRoutes.get('/links/availability', async (c) => {
  requireAuth(c.var.auth);
  const query = parse(availabilityQuery, c.req.query());
  const domain = resolveDomain(c.env, query.domain || undefined);
  const slug = normalizeSlug(query.slug);
  const reason = isReservedSlug(slug) ? 'reserved'
    : !isValidCustomSlug(slug) ? 'invalid'
    : await slugTaken(c.env, domain, slug) ? 'taken'
    : null;
  return c.json({ available: reason === null, reason });
});

apiRoutes.get('/links/:id', async (c) => {
  const auth = requireAuth(c.var.auth);
  return c.json(await getLink(c.env, auth, c.req.param('id')));
});

apiRoutes.patch('/links/:id', async (c) => {
  const auth = requireAuth(c.var.auth);
  const id = c.req.param('id');
  const version = requireVersion(c.req.header('if-match'));
  const change = parse(updateLinkSchema, await readJson(c));
  if (change.destination !== undefined) change.destination = resolveDestination(c.env, change.destination);
  const current = await getLink(c.env, auth, id);
  // A form may send back the expiry of a link that has already expired; only a new value has to be in the future.
  if (change.expiresAt !== current.expiresAt) requireFuture(change.expiresAt);
  return c.json(await finish(c, (background) => updateLink(c.env, auth, background, current, version, change)));
});

apiRoutes.delete('/links/:id', async (c) => {
  const auth = requireAuth(c.var.auth);
  const id = c.req.param('id');
  if (await finish(c, (background) => deleteLink(c.env, auth, background, id))) return c.body(null, 204);
  const body: z.infer<typeof deletePendingSchema> = { syncPending: true };
  return c.json(body, 202);
});

apiRoutes.get('/links/:id/qr', async (c) => {
  const auth = requireAuth(c.var.auth);
  const link = await getLink(c.env, auth, c.req.param('id'));
  const qr = qrcode(0, 'M');
  qr.addData(link.shortUrl);
  qr.make();
  return c.body(qr.createSvgTag({ cellSize: 8, margin: 32, scalable: true }), 200, {
    'content-type': 'image/svg+xml; charset=utf-8',
    'content-security-policy': "default-src 'none'",
  });
});

// Paged, because a large export in one response goes over the free plan's CPU limit.
apiRoutes.get('/export', async (c) => {
  const auth = requireAuth(c.var.auth);
  const cursor = c.req.query('cursor');
  const { links, next } = await listLinks(c.env, auth, { limit: EXPORT_PAGE, cursor: cursor ? decodeListCursor(cursor) : undefined });
  const body: z.infer<typeof exportSchema> = { links, nextCursor: next && encodeListCursor(next) };
  return c.json(body);
});

apiRoutes.post('/admin/resync', async (c) => {
  requireAdmin(c.var.auth);
  const cursor = c.req.query('cursor');
  const { synced, failed, lastId } = await resyncPage(c.env, cursor ? decodeResyncCursor(cursor) : '');
  const body: z.infer<typeof resyncSchema> = { synced, failed, nextCursor: lastId === null ? null : encodeResyncCursor(lastId) };
  return c.json(body);
});
