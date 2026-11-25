import type { Context } from 'hono';
import { html } from 'hono/html';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '../types.ts';

type C = Context<AppEnv>;

const CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function page(c: C, status: ContentfulStatusCode, title: string, body: unknown, head: unknown = ''): Response | Promise<Response> {
  c.header('content-security-policy', CSP);
  // hono's html tag escapes every interpolated string.
  return c.html(html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">${head}
<title>${title} · ${c.env.SITE_NAME}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:20vh auto 0;padding:0 1rem}</style></head>
<body><h1>${title}</h1>${body}</body></html>`, status);
}

/** A redirect from the callback would still count as cross-site, so the new Strict cookie would not be sent.
 *  A navigation that starts from this page is same-site. */
export function continuePage(c: C) {
  return page(c, 200, 'Signed in', html`<p><a href="/">Continue</a></p>`, html`<meta http-equiv="refresh" content="0;url=/">`);
}

/** `message` is our own text. Nothing the provider sent is passed here. */
export function signInErrorPage(c: C, status: ContentfulStatusCode, message: string) {
  return page(c, status, 'Sign-in did not work', html`<p>${message}</p><p><a href="/auth/login">Try again</a></p>`);
}
