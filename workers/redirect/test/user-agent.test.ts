import { expect, it } from 'vitest';
import { classifyUserAgent } from '../src/user-agent.ts';

const W = 'Mozilla/5.0';
it.each([
  [`${W} (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36`, 'desktop', false],
  [`${W} (Macintosh; Intel Mac OS X 10_15_7) Version/19.0 Safari/605.1.15`, 'desktop', false],
  [`${W} (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0`, 'desktop', false],
  [`${W} (X11; CrOS x86_64 14541.0.0) Chrome/140.0 Safari/537.36`, 'desktop', false],
  [`${W} (Windows NT 6.1; Tablet PC 2.0; Trident/7.0)`, 'desktop', false],
  [`${W} (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1`, 'mobile', false],
  [`${W} (Linux; Android 15; Pixel 9) Chrome/140.0 Mobile Safari/537.36`, 'mobile', false],
  [`${W} (Linux; Android 12; CUBOT X50) Chrome/140.0 Mobile Safari/537.36`, 'mobile', false],
  [`${W} (iPad; CPU OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1`, 'tablet', false],
  [`${W} (Linux; Android 14; SM-X710) Chrome/140.0 Safari/537.36`, 'tablet', false],
  [`${W} (SMART-TV; Linux; Tizen 8.0) TV Safari/537.36`, 'other', false],
  [`${W} (compatible; Googlebot/2.1; +http://www.google.com/bot.html)`, 'other', true],
  [`${W} (Linux; Android 6.0.1) Chrome/140.0 Mobile Safari/537.36 (compatible; Googlebot/2.1)`, 'mobile', true],
  [`${W} (X11; Linux x86_64) HeadlessChrome/140.0 Safari/537.36`, 'desktop', true],
  ['facebookexternalhit/1.1', 'other', true],
  ['Slackbot-LinkExpanding 1.0', 'other', true],
  ['WhatsApp/2.24 A', 'other', true],
  ['curl/8.9.1', 'other', true],
  ['python-requests/2.32', 'other', true],
  ['Go-http-client/2.0', 'other', true],
  ['', 'other', true],
])('%s', (ua, device, bot) => {
  expect(classifyUserAgent(ua)).toEqual({ device, bot });
});

it('handles very long input', () => {
  expect(classifyUserAgent('android'.repeat(100_000)).bot).toBe(false);
});
