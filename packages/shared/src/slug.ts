/** Lowercase letters and digits with i, l, o, 0 and 1 removed. 31 characters. */
export const SLUG_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
export const RANDOM_SLUG_LENGTH = 6;
export const RESERVED_SLUGS: readonly string[] = ['.well-known', 'robots.txt', 'favicon.ico'];

const CUSTOM = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

export function normalizeSlug(input: string): string {
  return input.trim().toLowerCase();
}

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.includes(normalizeSlug(slug));
}

/** Expects any case; validates the normalized form. */
export function isValidCustomSlug(input: string): boolean {
  const slug = normalizeSlug(input);
  return CUSTOM.test(slug) && !isReservedSlug(slug);
}

export function randomSlug(
  length = RANDOM_SLUG_LENGTH,
  fill: (b: Uint8Array<ArrayBuffer>) => Uint8Array = (b) => crypto.getRandomValues(b),
): string {
  const n = SLUG_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = '';
  while (out.length < length) {
    for (const byte of fill(new Uint8Array(length * 2))) {
      if (byte < limit && out.length < length) out += SLUG_ALPHABET[byte % n];
    }
  }
  return out;
}
