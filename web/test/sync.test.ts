import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api.ts';
import { actionOf, badgeText, outcome, pendingAction, repeatOf, statusText, type Action } from '../src/lib/sync.ts';

const ACTIONS: Action[] = ['edit', 'disable', 'enable', 'delete'];
const CLAIM = /\b(disabled|deleted|enabled)\b/i;

describe('pending changes', () => {
  it('never claims the result, and always says it is saved and for how long the old one may last', () => {
    for (const action of ACTIONS) for (const retried of [false, true]) {
      const text = outcome(action, true, retried);
      expect(text).not.toMatch(CLAIM);
      expect(text).toMatch(/saved/);
      expect(text).toMatch(/for up to an hour/);
    }
    for (const action of ['edit', 'disable', 'delete'] as const) expect(outcome(action, true)).toContain('old link may keep working');
    expect(outcome('edit', true, true)).toMatch(/^Trying again did not finish it\./);
  });
  it('states the result once it is done, without the warning', () => {
    expect(outcome('disable', false)).toMatch(/^Disabled\./);
    expect(outcome('enable', false)).toMatch(/^Enabled\./);
    expect(outcome('delete', false, true)).toBe('Deleted.');
    for (const action of ACTIONS) expect(outcome(action, false)).not.toMatch(/hour/);
  });
  it('never shows a bare disabled or expired status', () => {
    for (const state of ['disabled', 'expired'] as const) {
      expect(statusText(state, true)).toMatch(/may keep working for up to an hour/);
      expect(badgeText(state, true)).toMatch(/may still work/);
      expect(badgeText(state, false)).toBe(state);
    }
    expect(statusText('disabled', false)).toBe('Disabled');
    expect(statusText('active', true)).toMatch(/not in effect/);
    expect(badgeText('active', true)).toBe('change pending');
    expect(badgeText('active', false)).toBeNull();
  });
  it('names the action and repeats the same change', () => {
    expect([actionOf({ tags: [] }), actionOf({ disabled: true }), actionOf({ disabled: false })]).toEqual(['edit', 'disable', 'enable']);
    const change = { destination: 'https://example.com/' };
    expect(repeatOf({ disabled: true }, change)).toBe(change);
    expect(pendingAction({ disabled: true }, change)).toBe('edit');
  });
  it('repeats the current status when the original change is unknown', () => {
    expect(repeatOf({ disabled: true }, null)).toEqual({ disabled: true });
    expect(pendingAction({ disabled: true }, null)).toBe('disable');
    expect(pendingAction({ disabled: false }, null)).toBe('edit');
  });
});

describe('delete answers', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it('tells finished from pending', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response('{"syncPending":true}', { status: 202 }));
    expect(await api.remove('a')).toBe(false);
    expect(await api.remove('a')).toBe(true);
  });
});
