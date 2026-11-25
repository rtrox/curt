/** Colour maths for the accent. The palette itself lives in app.css; test/contrast.test.ts checks the two agree. */
export interface Surface { bg: string; panel: string }
export const SURFACES: { light: Surface; dark: Surface } = {
  light: { bg: '#ECEFF1', panel: '#FFFFFF' },
  dark: { bg: '#0C1218', panel: '#131C24' },
};

export type AccentVars = Record<'accent-l' | 'on-l' | 'accent-d' | 'on-d', string>;

/** Accepts #rgb and #rrggbb, returns lowercase #rrggbb, or null for anything else. */
export function parseHex(input: string | null | undefined): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((input ?? '').trim());
  if (!m?.[1]) return null;
  const h = m[1].toLowerCase();
  return '#' + (h.length === 3 ? [...h].map((c) => c + c).join('') : h);
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = rgb(hex).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function fromHsl(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/** Keeps hue and saturation, and moves lightness only as far as needed to be readable on every surface. */
export function readableOn(color: string, surfaces: readonly string[], min = 4.5): string {
  const ok = (c: string) => surfaces.every((s) => contrast(c, s) >= min);
  if (ok(color)) return color;
  const [h, s, l] = toHsl(color);
  const darker = luminance(surfaces[0] ?? '#ffffff') > 0.18;
  for (let i = 1; i <= 100; i++) {
    const c = fromHsl(h, s, darker ? Math.max(0, l - i / 100) : Math.min(1, l + i / 100));
    if (ok(c)) return c;
  }
  return darker ? '#000000' : '#ffffff';
}

/** Black or white, whichever is easier to read on the colour. One of them always reaches 4.5:1. */
export function textOn(color: string): string {
  return contrast('#ffffff', color) >= contrast('#000000', color) ? '#ffffff' : '#000000';
}

export function accentVars(accent: string): AccentVars {
  const l = readableOn(accent, [SURFACES.light.bg, SURFACES.light.panel]);
  const d = readableOn(accent, [SURFACES.dark.bg, SURFACES.dark.panel]);
  return { 'accent-l': l, 'on-l': textOn(l), 'accent-d': d, 'on-d': textOn(d) };
}
