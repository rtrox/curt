import { parseDomains } from '@curt/shared';
import type { Env } from '../types.ts';

export function shortHosts(env: Env): string[] {
  return parseDomains(env.DOMAINS).map((d) => d.host);
}
/** Hosts a destination may not point at. */
export function ownHosts(env: Env): string[] {
  return [...shortHosts(env), env.ADMIN_HOST.toLowerCase()];
}
