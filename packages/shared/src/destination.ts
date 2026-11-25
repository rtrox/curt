export type DestinationError = 'invalid_url' | 'bad_scheme' | 'has_credentials' | 'own_domain' | 'too_long';

/** Returns the normalized URL, or an error code. `ownHosts` are short domains and the admin host. */
export function checkDestination(
  input: string,
  ownHosts: readonly string[],
): { ok: true; url: string } | { ok: false; error: DestinationError } {
  if (input.length > 4096) return { ok: false, error: 'too_long' };
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, error: 'invalid_url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: 'bad_scheme' };
  if (url.username || url.password) return { ok: false, error: 'has_credentials' };
  const host = url.hostname.replace(/\.$/, '').toLowerCase();
  if (ownHosts.some((h) => h.toLowerCase() === host)) return { ok: false, error: 'own_domain' };
  return { ok: true, url: url.href };
}
