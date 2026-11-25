import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

const source = new URL('../src/theme-boot.js', import.meta.url);

/** Emits src/theme-boot.js as a hashed classic script. Vite only bundles module scripts, which run too late. */
export function themeBoot(): Plugin {
  let serving = false;
  const code = () => readFileSync(source, 'utf8');
  const fileName = () => `assets/theme-${createHash('sha256').update(code()).digest('hex').slice(0, 8)}.js`;
  return {
    name: 'theme-boot',
    configResolved(config) { serving = config.command === 'serve'; },
    configureServer(server) {
      server.middlewares.use('/assets/theme.js', (_req, res) => {
        res.setHeader('content-type', 'text/javascript');
        res.end(code());
      });
    },
    generateBundle() { this.emitFile({ type: 'asset', fileName: fileName(), source: code() }); },
    transformIndexHtml() {
      const src = serving ? '/assets/theme.js' : `/${fileName()}`;
      return [{ tag: 'script', attrs: { src }, injectTo: 'head-prepend' }];
    },
  };
}
