import { randomToken } from './crypto.ts';

export const TOKEN_PATTERN = /^curt_[A-Za-z0-9_-]{43}$/;

/** The fixed prefix lets secret scanners recognise a leaked token. */
export function newApiToken(): string {
  return `curt_${randomToken()}`;
}
