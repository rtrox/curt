import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { accentVars, contrast, parseHex, readableOn, SURFACES, textOn } from '../src/lib/color.ts';

const css = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');

/** Reads the tokens as the browser would see them with no custom accent. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector}`);
  const block = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(?:var\([^,]+,\s*)?(#[0-9A-Fa-f]{6})/g)].map((m) => [m[1], m[2]]));
}
const light = tokens(':root');
const darkAuto = tokens(":root:not([data-theme='light'])");
const dark = tokens(":root[data-theme='dark']");

describe('palette', () => {
  it('has the same dark colours for the system and the manual setting', () => {
    expect(darkAuto).toEqual(dark);
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
  });
  it('matches the surfaces used for accent maths', () => {
    expect({ bg: light.bg, panel: light.panel }).toEqual(SURFACES.light);
    expect({ bg: dark.bg, panel: dark.panel }).toEqual(SURFACES.dark);
  });

  for (const [name, t] of [['light', light], ['dark', dark]] as const) {
    for (const surface of ['bg', 'panel']) {
      for (const text of ['ink', 'mute', 'accent', 'danger']) {
        it(`${name}: ${text} text on ${surface} is at least 4.5:1`, () => {
          expect(contrast(t[text] ?? '', t[surface] ?? '')).toBeGreaterThanOrEqual(4.5);
        });
      }
      it(`${name}: control borders on ${surface} are at least 3:1`, () => {
        expect(contrast(t.edge ?? '', t[surface] ?? '')).toBeGreaterThanOrEqual(3);
      });
    }
    it(`${name}: text on filled buttons and selections is at least 4.5:1`, () => {
      expect(contrast(t['on-accent'] ?? '', t.accent ?? '')).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['on-danger'] ?? '', t.danger ?? '')).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('custom accents', () => {
  it('reads hex colours and rejects everything else', () => {
    expect(parseHex('#ABC')).toBe('#aabbcc');
    expect(parseHex('a93700')).toBe('#a93700');
    for (const bad of ['', null, undefined, 'red', '#12', '#12345', 'url(x)', '#a93700;']) expect(parseHex(bad)).toBeNull();
  });
  it('agrees with known ratios', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });
  it('leaves a readable colour alone', () => {
    expect(readableOn('#a93700', ['#eceff1', '#ffffff'])).toBe('#a93700');
  });
  it('stays readable in both themes for any colour', () => {
    const steps = [0, 51, 102, 153, 204, 255];
    for (const r of steps) for (const g of steps) for (const b of steps) {
      const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
      const v = accentVars(hex);
      for (const s of Object.values(SURFACES.light)) expect(contrast(v['accent-l'], s)).toBeGreaterThanOrEqual(4.5);
      for (const s of Object.values(SURFACES.dark)) expect(contrast(v['accent-d'], s)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(v['on-l'], v['accent-l'])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(v['on-d'], v['accent-d'])).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('always finds text for a fill', () => {
    for (let i = 0; i < 256; i++) {
      const grey = '#' + i.toString(16).padStart(2, '0').repeat(3);
      expect(contrast(textOn(grey), grey)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
