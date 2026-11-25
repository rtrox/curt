import type { Context } from 'hono';
import type { AppEnv } from '../types.ts';

/** Serves the dashboard shell with security headers that depend on this deployment. */
export async function dashboard(c: Context<AppEnv>): Promise<Response> {
  if (!c.env.ASSETS) return c.text('Dashboard is not built', 503);
  const res = await c.env.ASSETS.fetch(new Request(new URL('/', c.req.url)));
  const out = new Response(res.body, res);
  const connect = ["'self'"];
  if (c.env.OIDC_EXCHANGE === 'browser') connect.push(new URL(c.env.OIDC_TOKEN_ENDPOINT).origin);
  out.headers.set('content-security-policy', [
    "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self'",
    `connect-src ${connect.join(' ')}`, "form-action 'self'", "base-uri 'none'", "frame-ancestors 'none'",
  ].join('; '));
  out.headers.set('cache-control', 'no-cache');
  return out;
}
