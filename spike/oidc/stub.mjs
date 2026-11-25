// Stub provider for testing the spike itself. Local only.
import http from 'node:http';
import crypto from 'node:crypto';
const port = 8788, issuer = `http://localhost:${port}`, codes = new Map();
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
http.createServer((req, res) => {
  const u = new URL(req.url, issuer);
  const send = (c, o) => { res.writeHead(c, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/.well-known/openid-configuration') return send(200, { issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/api/oidc/token', jwks_uri: issuer + '/.well-known/jwks.json' });
  if (u.pathname === '/.well-known/jwks.json') return send(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 's1' }] });
  if (u.pathname === '/authorize') {
    const code = crypto.randomUUID(); codes.set(code, Object.fromEntries(u.searchParams));
    res.writeHead(302, { location: u.searchParams.get('redirect_uri') + '?' + new URLSearchParams({ code, state: u.searchParams.get('state') }) }); return res.end();
  }
  if (u.pathname === '/api/oidc/token') {
    let b = ''; req.on('data', (d) => b += d); req.on('end', () => {
      const p = new URLSearchParams(b), r = codes.get(p.get('code')); codes.delete(p.get('code'));
      const ch = crypto.createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url');
      if (!r || ch !== r.code_challenge) return send(400, { error: 'invalid_grant' });
      const now = Math.floor(Date.now() / 1000);
      const body = enc({ alg: 'RS256', kid: 's1' }) + '.' + enc({ iss: issuer, aud: r.client_id, sub: 'u1', nonce: r.nonce, iat: now, exp: now + 600, groups: ['links'] });
      send(200, { id_token: body + '.' + crypto.sign('sha256', Buffer.from(body), privateKey).toString('base64url') });
    }); return;
  }
  send(404, {});
}).listen(port, '127.0.0.1', () => console.log('stub on ' + issuer));
