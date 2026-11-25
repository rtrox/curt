/** Local and session storage can be blocked or full. Nothing here is needed for the page to work. */
export function load(key: string): string | null {
  try { return localStorage.getItem(`curt.${key}`); } catch { return null; }
}
export function save(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(`curt.${key}`);
    else localStorage.setItem(`curt.${key}`, value);
  } catch { /* not remembered */ }
}
