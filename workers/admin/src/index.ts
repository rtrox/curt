import { Hono } from 'hono';
import { apiRoutes } from './api/routes.ts';
import { authenticate } from './auth/middleware.ts';
import { authRoutes } from './auth/routes.ts';
import { tokenRoutes } from './auth/tokens.ts';
import { userRoutes } from './auth/users.ts';
import { runMaintenance } from './jobs/maintenance.ts';
import { ApiError } from './lib/errors.ts';
import { dashboard } from './lib/pages.ts';
import { linkStatsRoutes, metricsRoutes } from './stats/routes.ts';
import type { AppEnv, Env } from './types.ts';

const app = new Hono<AppEnv>();

app.use('*', async (c, next) => {
  if (new URL(c.req.url).hostname !== c.env.ADMIN_HOST.toLowerCase()) return c.text('Not found', 404);
  await next();
  c.res.headers.set('x-content-type-options', 'nosniff');
  c.res.headers.set('referrer-policy', 'no-referrer');
  c.res.headers.set('strict-transport-security', 'max-age=31536000');
});
app.use('*', authenticate);

// Cookie-authenticated writes must come from our own pages.
app.use('*', async (c, next) => {
  const safe = ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
  if (!safe && c.var.auth?.via !== 'token' && c.req.header('origin') !== new URL(c.req.url).origin) {
    throw new ApiError(403, 'bad_origin', 'Request came from another site.');
  }
  await next();
});

app.route('/auth', authRoutes);
app.route('/metrics', metricsRoutes);
app.route('/api/v1/tokens', tokenRoutes);
app.route('/api/v1/users', userRoutes);
app.route('/api/v1/links', linkStatsRoutes);
app.route('/api/v1', apiRoutes);

app.all('/api/*', () => { throw new ApiError(404, 'not_found', 'No such endpoint.'); });
app.get('*', dashboard);

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
  console.error('unhandled', err instanceof Error ? err.message : 'unknown');
  return c.json({ error: { code: 'internal', message: 'Something went wrong.' } }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(event, env) { await runMaintenance(env, new Date(event.scheduledTime)); },
} satisfies ExportedHandler<Env>;
