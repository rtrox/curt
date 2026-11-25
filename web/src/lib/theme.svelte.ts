import { accentVars, parseHex } from './color.ts';
import { load, save } from './storage.ts';

export type Theme = 'system' | 'light' | 'dark';

function initial(): Theme {
  const t = load('theme');
  return t === 'light' || t === 'dark' ? t : 'system';
}

class ThemeState {
  #choice = $state<Theme>(initial());
  get choice(): Theme { return this.#choice; }
  set choice(t: Theme) {
    this.#choice = t;
    save('theme', t === 'system' ? null : t);
    this.apply();
  }

  apply(): void {
    const root = document.documentElement;
    if (this.#choice === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', this.#choice);
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      const own = meta.media.includes('dark') ? 'dark' : 'light';
      meta.content = (this.#choice === 'system' ? own : this.#choice) === 'dark' ? '#0C1218' : '#ECEFF1';
    }
  }
}
export const theme = new ThemeState();

/** Applies the configured accent, adjusted so it stays readable in both themes, and remembers it for the next load. */
export function applyAccent(configured: string | null): void {
  const hex = parseHex(configured);
  const vars = hex ? accentVars(hex) : null;
  const style = document.documentElement.style;
  for (const key of ['accent-l', 'on-l', 'accent-d', 'on-d'] as const) {
    if (vars) style.setProperty(`--${key}`, vars[key]);
    else style.removeProperty(`--${key}`);
  }
  save('accent', vars ? JSON.stringify(vars) : null);
}
