import { checkDestination, type DestinationError } from '@curt/shared';
import type { LinkStats } from '@curt/shared/schemas';

export interface Day { day: string; clicks: number }

const number = new Intl.NumberFormat('en');
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

export const count = (n: number): string => number.format(Math.round(n));
export const shortCount = (n: number): string => (n < 10_000 ? count(n) : compact.format(n));
export const plural = (n: number, one: string, many = `${one}s`): string => `${count(n)} ${Math.round(n) === 1 ? one : many}`;

/** Sampled counts are estimates, so they are marked as such. */
export function clicksText(s: Pick<LinkStats, 'total' | 'sampled'>): string {
  return (s.sampled ? '~' : '') + shortCount(s.total);
}

/** The last n UTC days ending today, with missing days as zero. */
export function fillDays(days: readonly Day[], n: number, now: Date = new Date()): Day[] {
  const known = new Map(days.map((d) => [d.day, d.clicks]));
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: n }, (_, i) => {
    const day = new Date(end - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    return { day, clicks: known.get(day) ?? 0 };
  });
}

/** Adds several daily series together. */
export function sumDays(series: readonly (readonly Day[])[]): Day[] {
  const total = new Map<string, number>();
  for (const s of series) for (const d of s) total.set(d.day, (total.get(d.day) ?? 0) + d.clicks);
  return [...total].map(([day, clicks]) => ({ day, clicks })).sort((a, b) => a.day.localeCompare(b.day));
}

const dayFormat = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', timeZone: 'UTC' });
export const dayLabel = (day: string): string => dayFormat.format(new Date(`${day}T00:00:00Z`));

const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });
const dateTimeFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });
export const dateLabel = (unix: number): string => dateFormat.format(new Date(unix * 1000));
export const dateTimeLabel = (unix: number): string => dateTimeFormat.format(new Date(unix * 1000));

/** Unix seconds to the value of a datetime-local input, in the viewer's time zone. */
export function toLocalInput(unix: number | null): string {
  if (unix === null) return '';
  const d = new Date(unix * 1000);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
export function fromLocalInput(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** Destination without the parts that carry no information in a list. */
export function shortDestination(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
}

/** "example.com/a" becomes "https://example.com/a". Anything with a scheme is left for validation. */
export function withScheme(input: string): string {
  const s = input.trim();
  const hostAndPort = /^[^/:]+\.[^/:]+:\d/.test(s);
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !hostAndPort) return s;
  return s.includes('.') ? `https://${s.replace(/^\/\//, '')}` : s;
}

const DESTINATION_MESSAGES: Record<DestinationError, string> = {
  invalid_url: 'That does not look like a web address.',
  bad_scheme: 'Only http and https links can be shortened.',
  has_credentials: 'Links that contain a user name or password are not allowed.',
  own_domain: 'That link already points at one of your short domains.',
  too_long: 'That link is too long. The limit is 4,096 characters.',
};

/** Null when valid, otherwise a message for the person typing. The server repeats every check. */
export function destinationProblem(input: string, ownHosts: readonly string[]): string | null {
  const value = withScheme(input);
  if (!value) return 'Paste a link first.';
  const result = checkDestination(value, ownHosts);
  return result.ok ? null : DESTINATION_MESSAGES[result.error];
}

/** Splits typed tags and normalizes them the way the server does. */
export function parseTags(text: string): { tags: string[]; bad: string[] } {
  const tags: string[] = [];
  const bad: string[] = [];
  for (const part of text.split(',')) {
    const t = part.trim().toLowerCase();
    if (!t) continue;
    if (t.length <= 32 && /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(t)) tags.push(t);
    else bad.push(t);
  }
  return { tags: [...new Set(tags)], bad };
}

export type LinkState = 'active' | 'disabled' | 'expired';
export function linkState(l: { disabled: boolean; expiresAt: number | null }, nowMs = Date.now()): LinkState {
  if (l.disabled) return 'disabled';
  return l.expiresAt !== null && l.expiresAt * 1000 <= nowMs ? 'expired' : 'active';
}

/** "go.example" splits into "go" and ".example" so the second part can take the accent colour. */
export function splitName(name: string): [string, string] {
  const i = name.indexOf('.', 1);
  return i === -1 || /\s/.test(name) ? [name, ''] : [name.slice(0, i), name.slice(i)];
}
