import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: './src/index.ts',
      miniflare: {
        compatibilityDate: '2026-08-01',
        kvNamespaces: ['LINKS'],
        d1Databases: ['DB'],
        bindings: {
          DOMAINS: '[{"host":"go.example","root":"https://example.com"},{"host":"s.example","root":"https://example.com"}]',
          ADMIN_HOST: 'app.go.example', SITE_NAME: 'Links', ACCENT: '', OIDC_ISSUER: 'https://id.example', OIDC_CLIENT_ID: 'curt',
          OIDC_AUTHORIZATION_ENDPOINT: 'https://id.example/authorize', OIDC_TOKEN_ENDPOINT: 'https://id.example/api/oidc/token',
          OIDC_EXCHANGE: 'browser', OIDC_JWKS: '{"keys":[]}', ALLOWED_GROUP: 'links', ADMIN_GROUP: 'links-admin', METRICS_MAX_LINKS: '1000',
          ACCOUNT_ID: 'test-account', COOKIE_KEY: 'test-only-cookie-key-0123456789abcdef', AE_TOKEN: 'test-only',
          TEST_MIGRATIONS: await readD1Migrations(new URL('../../migrations', import.meta.url).pathname),
        },
      },
    })),
  ],
  test: { setupFiles: ['./test/setup.ts'] },
});
