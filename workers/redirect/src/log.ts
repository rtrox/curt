/** Logs the error's name only, since a message could carry a key, a URL or a visitor address. */
export function logFailure(event: string, error: unknown): void {
  console.error(JSON.stringify({ event, error: error instanceof Error ? error.name : 'unknown' }));
}
