// Runs everything locally: a stub sign-in provider, a stub stats service and both Workers.
// Nothing leaves this machine. Dashboard: http://localhost:8790  Short links: http://127.0.0.1:8791
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const state = path.join(root, '.wrangler', 'dev-state');
const ISSUER = 'http://localhost:8788';
const PEOPLE = {
  admin: { sub: 'admin-1', name: 'Alex Admin', email: 'alex@example.com', groups: ['links', 'links-admin'] },
  member: { sub: 'member-1', name: 'Morgan Member', email: 'morgan@example.com', groups: ['links'] },
  outsider: { sub: 'outsider-1', name: 'Odd Outsider', email: 'odd@example.com', groups: [] },
};

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'dev', use: 'sig', alg: 'RS256' }] };
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const codes = new Map();

const readBody = (req) => new Promise((ok) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => ok(b)); });
http.createServer(async (req, res) => {
  const u = new URL(req.url, ISSUER);
  const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/.well-known/openid-configuration') return send(200, { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/.well-known/jwks.json` });
  if (u.pathname === '/.well-known/jwks.json') return send(200, jwks);
  if (u.pathname === '/authorize') {
    const who = u.searchParams.get('as');
    if (!who) {
      const links = Object.keys(PEOPLE).map((k) => `<p><a href="/authorize?${new URLSearchParams({ ...Object.fromEntries(u.searchParams), as: k })}">Sign in as ${k}</a></p>`).join('');
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><title>Stub provider</title><h1>Stub provider</h1>${links}`);
    }
    const code = crypto.randomUUID();
    codes.set(code, { ...Object.fromEntries(u.searchParams), person: PEOPLE[who] });
    res.writeHead(302, { location: `${u.searchParams.get('redirect_uri')}?${new URLSearchParams({ code, state: u.searchParams.get('state') })}` });
    return res.end();
  }
  if (u.pathname === '/token' && req.method === 'POST') {
    const p = new URLSearchParams(await readBody(req));
    const r = codes.get(p.get('code'));
    codes.delete(p.get('code'));
    const challenge = crypto.createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url');
    if (!r || challenge !== r.code_challenge) return send(400, { error: 'invalid_grant' });
    const now = Math.floor(Date.now() / 1000);
    const body = `${enc({ alg: 'RS256', kid: 'dev' })}.${enc({ iss: ISSUER, aud: r.client_id, nonce: r.nonce, iat: now, exp: now + 600, ...r.person })}`;
    return send(200, { id_token: `${body}.${crypto.sign('sha256', Buffer.from(body), privateKey).toString('base64url')}`, token_type: 'Bearer' });
  }
  send(u.pathname === '/token' ? 405 : 404, {});
}).listen(8788, '127.0.0.1');

// Stands in for the Analytics Engine SQL API. Has no data.
http.createServer(async (req, res) => { await readBody(req); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); }).listen(8789, '127.0.0.1');

const vars = {
  DOMAINS: JSON.stringify([{ host: '127.0.0.1', root: 'https://example.com' }, { host: 's.example', root: 'https://example.com' }]),
  ADMIN_HOST: 'localhost', OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: 'curt-dev',
  OIDC_AUTHORIZATION_ENDPOINT: `${ISSUER}/authorize`, OIDC_TOKEN_ENDPOINT: `${ISSUER}/token`,
  OIDC_JWKS: JSON.stringify(jwks), COOKIE_KEY: crypto.randomBytes(32).toString('base64url'),
  AE_TOKEN: 'dev', ACCOUNT_ID: 'dev', AE_SQL_URL: 'http://127.0.0.1:8789/',
};
const write = (w) => fs.writeFileSync(path.join(root, 'workers', w, '.dev.vars'), Object.entries(vars).map(([k, v]) => `${k}='${v}'`).join('\n') + '\n', { mode: 0o600 });
write('admin');
write('redirect');

const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_CF_FETCH_ENABLED: 'false', CI: '1' };
const wrangler = path.join(root, 'node_modules', '.bin', 'wrangler');
const migrated = spawnSync(wrangler, ['d1', 'migrations', 'apply', 'curt', '--local', '--persist-to', state], { cwd: path.join(root, 'workers/admin'), env, stdio: 'inherit' });
if (migrated.status !== 0) process.exit(1);
const children = [['admin', 8790, 8792, 'localhost'], ['redirect', 8791, 8793, '127.0.0.1']].map(([w, port, inspector, ip]) =>
  spawn(wrangler, ['dev', '--local', '--port', String(port), '--inspector-port', String(inspector), '--ip', ip, '--persist-to', state, '--show-interactive-dev-session=false'], { cwd: path.join(root, 'workers', w), env, stdio: 'inherit' }));
const stop = () => { children.forEach((c) => c.kill()); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
