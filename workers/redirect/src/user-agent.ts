import type { Device } from '@curt/shared';

const MAX_LENGTH = 512;

// Crawlers, link previewers, HTTP libraries and headless browsers. "Cubot" is a phone maker.
const BOT = new RegExp(
  [
    '(?<!cu)bot', 'crawl', 'spider', 'slurp', 'preview', 'scanner', 'headless', 'lighthouse', 'monitor', 'uptime', 'pingdom',
    'facebookexternalhit', 'facebookcatalog', 'meta-external', 'whatsapp/', 'embedly', 'feedfetcher', 'mediapartners',
    'inspectiontool', 'ia_archiver', 'google-read-aloud', 'phantomjs', 'puppeteer', 'playwright', 'selenium',
    'curl/', 'wget', 'httpie', 'python', 'java/', 'okhttp', 'go-http-client', 'libwww', 'httpclient', 'axios', 'node-fetch',
    'undici', '^node', 'postman', 'insomnia', 'ruby', 'perl', 'php/', 'guzzle', 'scrapy',
  ].join('|'),
);
const TV = /\btv\b|smart-?tv|hbbtv|crkey|web0s|appletv|googletv/;
const TABLET = /ipad|tablet(?! pc)|playbook|\bsilk\/|kindle|android(?!.*mobile)/;
const MOBILE = /mobi|iphone|ipod|android|windows phone/;
const DESKTOP = /windows nt|macintosh|x11|linux|cros/;

function deviceOf(ua: string): Device {
  if (TV.test(ua)) return 'other';
  if (TABLET.test(ua)) return 'tablet';
  if (MOBILE.test(ua)) return 'mobile';
  return DESKTOP.test(ua) ? 'desktop' : 'other';
}

/** A browser always sends a User-Agent, so a missing one counts as a bot. */
export function classifyUserAgent(userAgent: string): { device: Device; bot: boolean } {
  const ua = userAgent.slice(0, MAX_LENGTH).toLowerCase();
  return { device: deviceOf(ua), bot: ua.trim() === '' || BOT.test(ua) };
}
