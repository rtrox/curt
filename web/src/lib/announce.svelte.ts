/** Text for the polite live region in App.svelte. */
export const announcer = $state({ text: '' });
export function announce(text: string): void {
  announcer.text = '';
  // A separate update makes screen readers repeat identical messages.
  setTimeout(() => { announcer.text = text; }, 50);
}
