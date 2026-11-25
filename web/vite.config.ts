import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import { mockApi } from './dev/mock.ts';
import { themeBoot } from './dev/theme-boot.ts';

export default defineConfig({
  plugins: [svelte(), themeBoot(), mockApi()],
  build: {
    // The policy allows fonts and scripts from 'self' only, so nothing may become a data: URL.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    reportCompressedSize: true,
  },
});
