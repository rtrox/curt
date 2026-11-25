import type { Link } from '@curt/shared/schemas';
import { describe, expect, it } from 'vitest';
import { changes, differences, draftOf, settle } from '../src/lib/edit.ts';

const link: Link = {
  id: '1', domain: 'go.example', slug: 'a', shortUrl: 'https://go.example/a', destination: 'https://example.com/', tags: ['x', 'y'],
  disabled: false, expiresAt: 1_800_000_030, owner: { id: 'u', name: null }, version: 1, createdAt: 1, updatedAt: 1,
};

describe('changes', () => {
  it('sends nothing for an untouched form, whatever the tag order or expiry seconds', () => {
    expect(changes(draftOf(link), { destination: link.destination, tags: ['y', 'x'], expiresAt: 1_800_000_000 })).toEqual({});
  });
  it('sends only the fields that differ', () => {
    expect(changes(draftOf(link), { ...draftOf(link), expiresAt: null })).toEqual({ expiresAt: null });
    expect(changes(draftOf(link), { ...draftOf(link), tags: [] })).toEqual({ tags: [] });
  });
});

describe('newer versions', () => {
  it('lists what someone else changed', () => {
    expect(differences(link, { ...link, destination: 'https://example.org/', disabled: true })).toEqual(['destination', 'disabled']);
  });
  it('keeps unsaved edits and follows the server for the rest', () => {
    const newer = { destination: 'https://example.org/', tags: ['z'], expiresAt: 5 };
    expect(settle(draftOf(link), { ...draftOf(link), tags: ['mine'] }, { disabled: true }, newer)).toEqual({ ...newer, tags: ['mine'] });
    expect(settle(draftOf(link), { ...draftOf(link), expiresAt: null }, { disabled: true }, newer)).toEqual({ ...newer, expiresAt: null });
  });
  it('takes the saved form of what was sent, unless it was edited again since', () => {
    const sent = { destination: 'https://example.net' };
    const saved = { ...draftOf(link), destination: 'https://example.net/' };
    expect(settle(draftOf(link), { ...draftOf(link), ...sent }, sent, saved)).toEqual(saved);
    expect(settle(draftOf(link), { ...draftOf(link), destination: 'https://later.example' }, sent, saved).destination).toBe('https://later.example');
  });
});
