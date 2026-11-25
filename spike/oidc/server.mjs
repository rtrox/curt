// Local test of browser-side code exchange. Binds to 127.0.0.1 only.
//   ISSUER=https://id.example CLIENT_ID=... node server.mjs pin     saves the provider's public keys
//   ISSUER=https://id.example CLIENT_ID=... node server.mjs         serves http://localhost:8787
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { verifyIdToken } from './verify.mjs';

const { ISSUER, CLIENT_ID, PORT = '8787' } = process.env;
if (!ISSUER || !CLIENT_ID) { console.error('Set ISSUER and CLIENT_ID'); process.exit(1); }
const issuer = ISSUER.replace(/\/$/, '');
const keyFile = new URL('./jwks.json', import.meta.url);

if (process.argv[2] === 'pin') {
  const res = await fetch(`${issuer}/.well-known/jwks.json`);
  if (!res.ok) { console.error(`Could not read keys: HTTP ${res.status}`); process.exit(1); }
  const jwks = await res.json();
  fs.writeFileSync(keyFile, JSON.stringify(jwks, null, 2));
  console.log(`Pinned ${jwks.keys.length} public key(s)`);
  process.exit(0);
}
if (!fs.existsSync(keyFile)) { console.error('Run the pin step first'); process.exit(1); }
const jwks = JSON.parse(fs.readFileSync(keyFile));
const page = fs.readFileSync(new URL('./page.html', import.meta.url), 'utf8')
  .replace('__CONFIG__', JSON.stringify({ issuer, clientId: CLIENT_ID }).replace(/</g, '\\u003c'));
const nonces = new Map();

const json = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/callback')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(page);
  }
  if (req.method === 'POST' && req.headers.origin !== `http://localhost:${PORT}`) return json(res, 403, { error: 'bad origin' });
  if (req.method === 'POST' && url.pathname === '/auth/begin') {
    const id = crypto.randomUUID(); const nonce = crypto.randomBytes(16).toString('base64url');
    nonces.set(id, { nonce, until: Date.now() + 600_000 });
    return json(res, 200, { nonce }, { 'set-cookie': `pre=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=600` });
  }
  if (req.method === 'POST' && url.pathname === '/auth/session') {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      const id = /(?:^|; )pre=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      const entry = nonces.get(id); nonces.delete(id);
      if (!entry || entry.until < Date.now()) return json(res, 400, { error: 'no valid nonce cookie' });
      const opts = { jwks, issuer, audience: CLIENT_ID, nonce: entry.nonce };
      try {
        const token = JSON.parse(body).id_token;
        const claims = verifyIdToken(token, opts);
        let tamperedRejected = false;
        try { const [h, p, s] = token.split('.'); verifyIdToken(`${h}.${p.slice(0, -2)}AA.${s}`, opts); } catch { tamperedRejected = true; }
        json(res, 200, { claims: Object.keys(claims).sort(), groupsInIdToken: Array.isArray(claims.groups), groupCount: claims.groups?.length ?? 0, tamperedRejected });
      } catch (e) { json(res, 401, { error: e.message }); }
    });
    return;
  }
  json(res, 404, { error: 'not found' });
}).listen(Number(PORT), '127.0.0.1', () => console.log(`Open http://localhost:${PORT}`));
