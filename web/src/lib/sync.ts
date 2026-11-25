import type { Link, UpdateLink } from '@curt/shared/schemas';
import type { LinkState } from './format.ts';

export type Action = 'edit' | 'disable' | 'enable' | 'delete';

export function actionOf(change: UpdateLink): Action {
  if (change.disabled === undefined) return 'edit';
  return change.disabled ? 'disable' : 'enable';
}

const DONE: Record<Action, string> = { edit: 'Saved.', disable: 'Disabled.', enable: 'Enabled.', delete: 'Deleted.' };
const PENDING: Record<Action, string> = {
  edit: 'Your change is saved, but the old link may keep working for up to an hour.',
  disable: 'Your change is saved, but the link is not off yet. The old link may keep working for up to an hour.',
  enable: 'Your change is saved, but the link is not back yet. Visitors may be told it is unavailable for up to an hour.',
  delete: 'Your change is saved, but the link is not gone yet. The old link may keep working for up to an hour.',
};

/** What to say after a change. While it is pending, nothing here claims the change has taken effect. */
export function outcome(action: Action, pending: boolean, retried = false): string {
  if (pending) return (retried ? 'Trying again did not finish it. ' : '') + PENDING[action];
  return action === 'delete' ? DONE.delete : `${DONE[action]} It can take about a minute to reach everyone.`;
}

/** What a person sees on arriving at a link whose last change, made by anyone, has not taken effect. */
export function pendingAction(link: Pick<Link, 'disabled'>, last: UpdateLink | null): Action {
  return last ? actionOf(last) : link.disabled ? 'disable' : 'edit';
}

/** Any saved change rewrites the whole redirect copy, so repeating the status is enough when the original is unknown. */
export function repeatOf(link: Pick<Link, 'disabled'>, last: UpdateLink | null): UpdateLink {
  return last ?? { disabled: link.disabled };
}

export function statusText(state: LinkState, pending: boolean): string {
  const word = { active: 'Active', disabled: 'Disabled', expired: 'Expired' }[state];
  if (!pending) return word;
  return state === 'active' ? 'Active, last change not in effect yet' : `${word}, but it may keep working for up to an hour`;
}

/** Short form for the list. Null when there is nothing to point out. */
export function badgeText(state: LinkState, pending: boolean): string | null {
  if (state === 'active') return pending ? 'change pending' : null;
  return pending ? `${state}, may still work` : state;
}
