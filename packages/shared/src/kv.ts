export interface KvLink {
  id: string;
  destination: string;
  version: number;
  disabled: boolean;
  /** Unix seconds, or null for never. */
  expiresAt: number | null;
}

export function linkKey(domain: string, slug: string): string {
  return `l:${domain.toLowerCase()}:${slug.toLowerCase()}`;
}

export function saltKey(utcDay: string): string {
  return `salt:${utcDay}`;
}

export function encodeLink(l: KvLink): string {
  return JSON.stringify({ i: l.id, u: l.destination, v: l.version, d: l.disabled ? 1 : 0, e: l.expiresAt });
}

export function decodeLink(raw: string | null): KvLink | null {
  if (raw === null) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (typeof o.i !== 'string' || typeof o.u !== 'string' || typeof o.v !== 'number') return null;
    return { id: o.i, destination: o.u, version: o.v, disabled: o.d === 1, expiresAt: typeof o.e === 'number' ? o.e : null };
  } catch {
    return null;
  }
}
