import type { Env } from '../types.ts';

export function exchangeMode(env: Env): 'browser' | 'server' {
  if (env.OIDC_EXCHANGE !== 'browser' && env.OIDC_EXCHANGE !== 'server') throw new Error('OIDC_EXCHANGE must be browser or server');
  return env.OIDC_EXCHANGE;
}

/** Some providers reject unknown scopes, so groups is requested only when a group setting needs it. */
export function oidcScope(env: Env): string {
  return env.ALLOWED_GROUP || env.ADMIN_GROUP ? 'openid profile email groups' : 'openid profile email';
}

export function redirectUri(env: Env): string {
  return `https://${env.ADMIN_HOST}/auth/callback`;
}
