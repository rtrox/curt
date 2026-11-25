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
        analyticsEngineDatasets: { CLICKS: { dataset: 'curt_clicks' } },
        bindings: { DOMAINS: '[{"host":"go.example","root":"https://example.com"}]', VISITOR_MODE: 'hash', TEST_MIGRATIONS: await readD1Migrations(new URL('../../migrations', import.meta.url).pathname) },
      },
    })),
  ],
  test: { setupFiles: ['./test/setup.ts'] },
});
