import { describe, expect, it } from 'vitest';
import {
  clicksText, destinationProblem, fillDays, fromLocalInput, linkState, parseTags, plural, shortCount, shortDestination,
  splitName, sumDays, toLocalInput, withScheme,
} from '../src/lib/format.ts';

describe('numbers', () => {
  it('formats counts', () => {
    expect(shortCount(9999)).toBe('9,999');
    expect(shortCount(12_345)).toBe('12.3K');
    expect(plural(1, 'click')).toBe('1 click');
    expect(plural(1200, 'click')).toBe('1,200 clicks');
  });
  it('marks sampled counts', () => {
    expect(clicksText({ total: 48, sampled: false })).toBe('48');
    expect(clicksText({ total: 48, sampled: true })).toBe('~48');
  });
});

describe('days', () => {
  const now = new Date('2026-03-02T23:30:00Z');
  it('fills gaps and ends today in UTC', () => {
    expect(fillDays([{ day: '2026-03-01', clicks: 4 }, { day: '2025-01-01', clicks: 9 }], 3, now)).toEqual([
      { day: '2026-02-28', clicks: 0 }, { day: '2026-03-01', clicks: 4 }, { day: '2026-03-02', clicks: 0 },
    ]);
  });
  it('adds series', () => {
    expect(sumDays([[{ day: 'b', clicks: 1 }], [{ day: 'a', clicks: 2 }, { day: 'b', clicks: 3 }]])).toEqual([
      { day: 'a', clicks: 2 }, { day: 'b', clicks: 4 },
    ]);
  });
});

describe('dates', () => {
  it('round-trips the expiry input to the minute', () => {
    const t = 1_800_000_000;
    expect(fromLocalInput(toLocalInput(t))).toBe(Math.floor(t / 60) * 60);
    expect(toLocalInput(null)).toBe('');
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('nonsense')).toBeNull();
  });
  it('reports link state', () => {
    expect(linkState({ disabled: false, expiresAt: null })).toBe('active');
    expect(linkState({ disabled: true, expiresAt: 1 })).toBe('disabled');
    expect(linkState({ disabled: false, expiresAt: 100 }, 100_000)).toBe('expired');
    expect(linkState({ disabled: false, expiresAt: 101 }, 100_000)).toBe('active');
  });
});

describe('destinations', () => {
  it('adds a scheme only when there is none', () => {
    expect(withScheme(' example.com/a ')).toBe('https://example.com/a');
    expect(withScheme('example.com:8080/a')).toBe('https://example.com:8080/a');
    expect(withScheme('//example.com/a')).toBe('https://example.com/a');
    expect(withScheme('http://example.com')).toBe('http://example.com');
    expect(withScheme('mailto:a@example.com')).toBe('mailto:a@example.com');
    expect(withScheme('javascript:alert.call(1)')).toBe('javascript:alert.call(1)');
    expect(withScheme('hello')).toBe('hello');
  });
  it('explains problems', () => {
    const own = ['go.example'];
    expect(destinationProblem('example.com/a', own)).toBeNull();
    expect(destinationProblem('', own)).toMatch(/Paste/);
    expect(destinationProblem('hello', own)).toMatch(/web address/);
    expect(destinationProblem('javascript:alert(1)', own)).toMatch(/http/);
    expect(destinationProblem('https://a:b@example.com', own)).toMatch(/password/);
    expect(destinationProblem('GO.example/x', own)).toMatch(/short domains/);
    expect(destinationProblem(`https://example.com/${'a'.repeat(4100)}`, own)).toMatch(/too long/);
  });
  it('shortens for lists', () => {
    expect(shortDestination('https://www.example.com/a/')).toBe('example.com/a');
  });
});

describe('tags', () => {
  it('normalizes, splits and drops repeats', () => {
    expect(parseTags(' Home, garden,HOME ,')).toEqual({ tags: ['home', 'garden'], bad: [] });
  });
  it('separates unusable ones', () => {
    expect(parseTags(`ok, -no, ${'a'.repeat(33)}`)).toEqual({ tags: ['ok'], bad: ['-no', 'a'.repeat(33)] });
  });
});

describe('names', () => {
  it('splits a host name but not a title', () => {
    expect(splitName('go.example')).toEqual(['go', '.example']);
    expect(splitName('Links')).toEqual(['Links', '']);
    expect(splitName('Acme Inc. links')).toEqual(['Acme Inc. links', '']);
  });
});
