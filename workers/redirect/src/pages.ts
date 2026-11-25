type Page = 'not_found' | 'disabled' | 'expired' | 'unavailable';

const PAGES: Record<Page, { status: number; title: string; text: string }> = {
  not_found: { status: 404, title: 'Link not found', text: 'There is no link at this address. Check that it was typed in full.' },
  disabled: { status: 410, title: 'Link turned off', text: 'The owner of this link has turned it off.' },
  expired: { status: 410, title: 'Link expired', text: 'This link was set to stop working and no longer leads anywhere.' },
  unavailable: { status: 503, title: 'Temporarily unavailable', text: 'This link could not be looked up. Try again in a few seconds.' },
};

const RETRY_AFTER_SECONDS = '10';

const STYLE =
  ':root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1b1a;--muted:#5c5a57;--line:#d6d3cf}' +
  '@media(prefers-color-scheme:dark){:root{--bg:#161514;--fg:#f2f0ed;--muted:#aaa6a0;--line:#3a3835}}' +
  '*{box-sizing:border-box}' +
  'body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}' +
  'main{max-width:26rem;border-top:1px solid var(--line);padding-top:20px}' +
  'p{margin:0;color:var(--muted)}' +
  'h1{margin:0 0 8px;font-size:1.5rem;line-height:1.2;font-weight:600}';

// SHA-256 of STYLE. A test recomputes it, so a style change cannot silently break the policy.
const STYLE_HASH = 'Qb5IiiwqwERnYajkI12KSFM1fyUrmqBbnZBbvfZv2YA=';

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'private, no-store',
  'Content-Security-Policy': `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex',
};

/** Fixed text only: nothing from the request reaches the page. */
export function errorPage(page: Page): Response {
  const { status, title, text } = PAGES[page];
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${title}</title><style>${STYLE}</style></head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;
  const headers = new Headers(PAGE_HEADERS);
  if (page === 'unavailable') headers.set('Retry-After', RETRY_AFTER_SECONDS);
  return new Response(html, { status, headers });
}

export function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'private, no-store' } });
}
