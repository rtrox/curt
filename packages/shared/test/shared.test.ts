import { describe, expect, it } from 'vitest';
import { checkDestination, decodeLink, encodeLink, isValidCustomSlug, linkKey, normalizeSlug, parseDomains, randomSlug, SLUG_ALPHABET, toDataPoint } from '../src/index.ts';
import { createLinkSchema, tagsSchema } from '../src/schemas.ts';

describe('slugs', () => {
  it('has 31 unambiguous characters', () => {
    expect(new Set(SLUG_ALPHABET).size).toBe(31);
    expect(SLUG_ALPHABET).not.toMatch(/[ilo01]/);
  });
  it('rejects biased bytes', () => {
    const bytes = [255, 248, 0, 30, 31, 247];
    expect(randomSlug(4, (b) => { b.forEach((_, i) => { b[i] = bytes[i % bytes.length]!; }); return b; }))
      .toBe(['2', 'z', '2', 'z'].join(''));
  });
  it('generates valid slugs', () => { for (let i = 0; i < 200; i++) expect(isValidCustomSlug(randomSlug())).toBe(true); });
  it('normalizes case', () => expect(normalizeSlug(' TrIp ')).toBe('trip'));
  it.each(['a', 'Trip', 'a-b_c', 'x'.repeat(64)])('accepts %s', (s) => expect(isValidCustomSlug(s)).toBe(true));
  it.each(['', '-a', 'a-', 'a/b', 'a b', 'é', 'x'.repeat(65), 'robots.txt', 'Favicon.ICO', '.well-known'])('rejects %s', (s) => expect(isValidCustomSlug(s)).toBe(false));
});
describe('destinations', () => {
  const own = ['go.example', 'app.go.example'];
  it('normalizes', () => expect(checkDestination('HTTPS://Example.com', own)).toEqual({ ok: true, url: 'https://example.com/' }));
  it.each([['nope', 'invalid_url'], ['javascript:alert(1)', 'bad_scheme'], ['data:text/html,x', 'bad_scheme'], ['https://u:p@example.com', 'has_credentials'], ['https://GO.example/x', 'own_domain'], ['https://go.example./x', 'own_domain'], ['https://example.com/' + 'a'.repeat(4100), 'too_long']])('rejects %s', (u, error) => expect(checkDestination(u, own)).toEqual({ ok: false, error }));
});
describe('kv', () => {
  it('round trips', () => {
    const l = { id: '1', destination: 'https://example.com/', version: 3, disabled: true, expiresAt: 9 };
    expect(decodeLink(encodeLink(l))).toEqual(l);
  });
  it.each([null, 'x', '{}', 'null', '[]'])('treats %s as missing', (r) => expect(decodeLink(r)).toBeNull());
  it('lowercases keys', () => expect(linkKey('GO.example', 'Trip')).toBe('l:go.example:trip'));
});
it('parses domains', () => {
  expect(parseDomains('[{"host":"GO.example","root":"https://example.com"}]')).toEqual([{ host: 'go.example', root: 'https://example.com/' }]);
  expect(() => parseDomains('[]')).toThrow();
  expect(() => parseDomains('[{"host":"a","root":"javascript:1"}]')).toThrow();
});
it('lays out clicks', () => expect(toDataPoint({ linkId: null, domain: 'd', slug: 's', outcome: 'not_found', referrer: '', country: 'NZ', device: 'mobile', bot: true, visitor: '' })).toEqual({ indexes: ['none'], blobs: ['d', 's', 'not_found', '', 'NZ', 'mobile', '1', ''], doubles: [1] }));
it('validates API input', () => {
  expect(createLinkSchema.safeParse({ destination: 'https://example.com', surprise: 1 }).success).toBe(false);
  expect(tagsSchema.parse(['Work', 'work '])).toEqual(['work']);
});
