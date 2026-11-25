export interface Env {
  DB: D1Database;
  LINKS: KVNamespace;
  ASSETS: Fetcher;
  DOMAINS: string;
  ADMIN_HOST: string;
  SITE_NAME: string;
  ACCENT: string;
  OIDC_ISSUER: string;
  OIDC_CLIENT_ID: string;
  OIDC_AUTHORIZATION_ENDPOINT: string;
  OIDC_TOKEN_ENDPOINT: string;
  OIDC_EXCHANGE: 'browser' | 'server';
  /** Pinned public keys as a JWKS document. Used in browser exchange. */
  OIDC_JWKS: string;
  OIDC_CLIENT_SECRET?: string;
  ALLOWED_GROUP: string;
  ADMIN_GROUP: string;
  /** Optional comma-separated subject IDs that are admins, for providers that send no groups claim. */
  ADMIN_SUBJECTS?: string;
  METRICS_MAX_LINKS: string;
  ACCOUNT_ID: string;
  COOKIE_KEY: string;
  AE_TOKEN: string;
  /** Optional, for local development only: sends stats queries to a stub instead of Cloudflare. */
  AE_SQL_URL?: string;
}

/** Set by auth/middleware.ts. */
export interface Auth {
  userId: string;
  isAdmin: boolean;
  via: 'session' | 'token';
  /** Admin sessions have both scopes; member sessions have `links`. */
  scopes: ReadonlyArray<'links' | 'metrics:read'>;
}

export interface AppEnv {
  Bindings: Env;
  Variables: { auth: Auth | null };
}
