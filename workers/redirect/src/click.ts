import { toDataPoint } from '@curt/shared';
import type { Click } from '@curt/shared';
import type { Env } from './index.ts';
import { logFailure } from './log.ts';
import { classifyUserAgent } from './user-agent.ts';
import { visitorId } from './visitor.ts';

/** Host of the referring page. Path, query and credentials are dropped. */
export function referrerHost(referer: string | null): string {
  if (!referer) return '';
  try {
    return new URL(referer).hostname.toLowerCase().slice(0, 253);
  } catch {
    return '';
  }
}

/** Never rejects: a click that cannot be recorded must not affect the visitor. */
export async function recordClick(
  request: Request,
  env: Env,
  link: Pick<Click, 'linkId' | 'domain' | 'slug' | 'outcome'>,
): Promise<void> {
  try {
    const country = request.cf?.country;
    const visitor = await visitorId(request, env);
    env.CLICKS.writeDataPoint(
      toDataPoint({
        ...link,
        ...classifyUserAgent(request.headers.get('User-Agent') ?? ''),
        referrer: referrerHost(request.headers.get('Referer')),
        country: typeof country === 'string' ? country : '',
        visitor,
      }),
    );
  } catch (error) {
    logFailure('click_write_failed', error);
  }
}
