/** Analytics Engine layout. index1 = link id or 'none'; double1 = 1; blobs in this order. */
export const CLICK_DATASET = 'curt_clicks';
export const CLICK_BLOBS = {
  domain: 'blob1', slug: 'blob2', outcome: 'blob3', referrer: 'blob4',
  country: 'blob5', device: 'blob6', bot: 'blob7', visitor: 'blob8',
} as const;

export type Outcome = 'ok' | 'not_found' | 'disabled' | 'expired' | 'root';
export type Device = 'desktop' | 'mobile' | 'tablet' | 'other';

export interface Click {
  linkId: string | null;
  domain: string;
  slug: string;
  outcome: Outcome;
  referrer: string;
  country: string;
  device: Device;
  bot: boolean;
  visitor: string;
}

export function toDataPoint(c: Click): { indexes: [string]; blobs: string[]; doubles: [number] } {
  return {
    indexes: [c.linkId ?? 'none'],
    blobs: [c.domain, c.slug, c.outcome, c.referrer, c.country, c.device, c.bot ? '1' : '0', c.visitor],
    doubles: [1],
  };
}
