export interface DomainConfig {
  host: string;
  /** Where the bare domain redirects. */
  root: string;
}

/** Parses the DOMAINS variable. Throws on bad configuration so a broken deploy fails loudly. */
export function parseDomains(raw: string): DomainConfig[] {
  const list: unknown = JSON.parse(raw);
  if (!Array.isArray(list) || list.length === 0) throw new Error('DOMAINS must be a non-empty array');
  return list.map((d: unknown) => {
    const o = d as Record<string, unknown>;
    if (typeof o?.host !== 'string' || typeof o.root !== 'string') throw new Error('DOMAINS entries need host and root');
    const root = new URL(o.root);
    if (root.protocol !== 'http:' && root.protocol !== 'https:') throw new Error('DOMAINS root must be http or https');
    return { host: o.host.toLowerCase(), root: root.href };
  });
}
