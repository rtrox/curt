import type { Link, UpdateLink } from '@curt/shared/schemas';

export interface Draft { destination: string; tags: string[]; expiresAt: number | null }
export const draftOf = (l: Link): Draft => ({ destination: l.destination, tags: [...l.tags], expiresAt: l.expiresAt });

export type Field = 'destination' | 'tags' | 'expiresAt' | 'disabled';

const sameTags = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/** Only what the person changed, so an edit to one field never undoes someone else's edit to another. */
export function changes(base: Draft, draft: Draft): UpdateLink {
  const out: UpdateLink = {};
  if (draft.destination !== base.destination) out.destination = draft.destination;
  if (!sameTags(draft.tags, base.tags)) out.tags = draft.tags;
  // The input has minute precision, so an untouched expiry with seconds must not count as a change.
  const minute = (t: number | null) => (t === null ? null : Math.floor(t / 60));
  if (minute(draft.expiresAt) !== minute(base.expiresAt)) out.expiresAt = draft.expiresAt;
  return out;
}

/** What another editor changed between the version the person started from and the newest one. */
export function differences(base: Link, newer: Link): Field[] {
  const out: Field[] = Object.keys(changes(draftOf(base), draftOf(newer))) as Field[];
  if (base.disabled !== newer.disabled) out.push('disabled');
  return out;
}

/** The form after a save: edits that were not part of it stay, and everything else follows what the server now holds. */
export function settle(base: Draft, draft: Draft, sent: UpdateLink, saved: Draft): Draft {
  const { destination, tags, expiresAt } = changes(base, draft);
  return {
    destination: destination === undefined || destination === sent.destination ? saved.destination : destination,
    tags: tags === undefined || (sent.tags && sameTags(tags, sent.tags)) ? saved.tags : tags,
    expiresAt: expiresAt === undefined || expiresAt === sent.expiresAt ? saved.expiresAt : expiresAt,
  };
}
