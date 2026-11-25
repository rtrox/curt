import { z } from 'zod';

/** API contract. All under /api/v1. Times are Unix seconds. */
export const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

const tag = z.string().trim().toLowerCase().min(1).max(32).regex(/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u);
export const tagsSchema = z.array(tag).max(20).transform((t) => [...new Set(t)]);

export const linkSchema = z.object({
  id: z.string(),
  domain: z.string(),
  slug: z.string(),
  shortUrl: z.string(),
  destination: z.string(),
  tags: z.array(z.string()),
  disabled: z.boolean(),
  expiresAt: z.number().int().nullable(),
  owner: z.object({ id: z.string(), name: z.string().nullable() }),
  version: z.number().int(),
  /** True when the redirect copy could not be updated yet, so the old behaviour may continue. */
  syncPending: z.boolean().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export const createLinkSchema = z.strictObject({
  destination: z.string().min(1).max(4096),
  domain: z.string().optional(),
  slug: z.string().max(64).optional(),
  disabled: z.boolean().optional(),
  tags: tagsSchema.optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
});
export const updateLinkSchema = z.strictObject({
  destination: z.string().min(1).max(4096).optional(),
  tags: tagsSchema.optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
  disabled: z.boolean().optional(),
});
export const listLinksQuery = z.object({
  q: z.string().max(200).optional(),
  /** Exact match, any case. */
  slug: z.string().max(64).optional(),
  tag: z.string().max(32).optional(),
  domain: z.string().optional(),
  owner: z.string().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const listLinksSchema = z.object({ links: z.array(linkSchema), nextCursor: z.string().nullable() });
/** DELETE /links/{id}: 204 when done everywhere it can be, else 202 with this body. */
export const deletePendingSchema = z.object({ syncPending: z.literal(true) });
export const availabilitySchema = z.object({
  available: z.boolean(),
  reason: z.enum(['taken', 'invalid', 'reserved']).nullable(),
});
/** GET /links/{id}/stats and, for many links, GET /links/stats?ids=a,b */
export const linkStatsSchema = z.object({
  total: z.number(),
  people: z.number(),
  bots: z.number(),
  sampled: z.boolean(),
  days: z.array(z.object({ day: z.string(), clicks: z.number() })),
});
export const manyStatsSchema = z.object({ stats: z.record(z.string(), linkStatsSchema) });

export const tokenScope = z.enum(['links', 'metrics:read']);
export const tokenSchema = z.object({
  id: z.string(), name: z.string(), scope: tokenScope,
  expiresAt: z.number().int().nullable(), lastUsedDay: z.string().nullable(),
});
export const createTokenSchema = z.strictObject({
  name: z.string().trim().min(1).max(64), scope: tokenScope,
  expiresAt: z.number().int().positive().nullable().optional(),
});
export const createdTokenSchema = tokenSchema.extend({ token: z.string() });
export const meSchema = z.object({
  id: z.string(), name: z.string().nullable(), email: z.string().nullable(), isAdmin: z.boolean(),
});
/** GET /users, admins only, signed-in session only. */
export const userListSchema = z.object({
  users: z.array(z.object({
    id: z.string(), name: z.string().nullable(), email: z.string().nullable(), isAdmin: z.boolean(),
    activeSessions: z.number().int(), activeTokens: z.number().int(),
  })),
});
/** POST /users/{id}/cutoff, admins only, signed-in session only. */
export const cutoffSchema = z.object({ sessionsEnded: z.number().int(), tokensRevoked: z.number().int() });
export const domainsSchema = z.object({ domains: z.array(z.object({ host: z.string() })) });
export const tagListSchema = z.object({ tags: z.array(z.object({ tag: z.string(), count: z.number() })) });
export const availabilityQuery = z.object({ slug: z.string().max(64), domain: z.string().optional() });
/** GET /export returns at most 500 links; follow nextCursor. */
export const exportSchema = z.object({ links: z.array(linkSchema), nextCursor: z.string().nullable() });
/** POST /admin/resync?cursor= */
export const resyncSchema = z.object({ synced: z.number(), failed: z.number(), nextCursor: z.string().nullable() });
/** GET /config, no sign-in needed. */
export const publicConfigSchema = z.object({
  siteName: z.string(),
  accent: z.string().nullable(),
  oidc: z.object({
    mode: z.enum(['browser', 'server']), issuer: z.string(), clientId: z.string(),
    authorizationEndpoint: z.string(), tokenEndpoint: z.string(), scope: z.string(),
  }),
});

export type Link = z.infer<typeof linkSchema>;
export type CreateLink = z.infer<typeof createLinkSchema>;
export type UpdateLink = z.infer<typeof updateLinkSchema>;
export type LinkStats = z.infer<typeof linkStatsSchema>;
export type ApiToken = z.infer<typeof tokenSchema>;
export type Me = z.infer<typeof meSchema>;
export type PublicConfig = z.infer<typeof publicConfigSchema>;
