import { base64url } from 'jose';

const utf8 = new TextEncoder();

/** 256 random bits, 43 base64url characters. */
export function randomToken(): string {
  return base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256(text: string): Promise<string> {
  return base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(text))));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('COOKIE_KEY must be at least 32 characters');
  return crypto.subtle.importKey('raw', utf8.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** `purpose` keeps a value signed for one use from being accepted for another. */
export async function sign(secret: string, purpose: string, payload: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), utf8.encode(`${purpose}:${payload}`));
  return base64url.encode(new Uint8Array(mac));
}

export async function verifySignature(secret: string, purpose: string, payload: string, signature: string): Promise<boolean> {
  const key = await hmacKey(secret);
  let mac: Uint8Array;
  try {
    mac = base64url.decode(signature);
  } catch {
    return false;
  }
  return crypto.subtle.verify('HMAC', key, mac, utf8.encode(`${purpose}:${payload}`));
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
