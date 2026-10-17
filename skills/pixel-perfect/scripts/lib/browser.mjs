// Browser helpers shared by capture, assets and extract.
// Every page gets a fresh context: no cookies, logins, extensions or service workers reach it.
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { FROZEN_TIME, log, viewportFor } from './io.mjs';

export const FROZEN_MS = Date.parse(FROZEN_TIME);
// Fake time while a page with a paused clock loads. Load-time scripts all read this value.
export const PAUSED_LOAD_MS = FROZEN_MS + 1000;

// Clock mode per page: 'natural' | 'paused' | false. Read by advance().
const clockMode = new WeakMap();

export class BlockedError extends Error {
  constructor(detail) {
    super(
      `Bot protection blocked the capture (${detail}). Stop and ask the user to allowlist this capture ` +
        'or save the page as HTML. Do not try to get past the challenge.',
    );
    this.name = 'BlockedError';
  }
}

export async function launch() {
  return chromium.launch({
    headless: true,
    args: ['--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none', '--disable-lcd-text'],
  });
}

// A desktop Chrome user agent at every width, so servers never switch to an m-dot site.
export function desktopUserAgent(browser) {
  const major = String(browser.version()).split('.')[0] || '140';
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export function contextOptions(browser, { width, reducedMotion = false } = {}) {
  return {
    viewport: viewportFor(width),
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    userAgent: desktopUserAgent(browser),
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
    serviceWorkers: 'block',
  };
}

// Open url in a fresh context and wait until the network is quiet.
//   clock: 'natural' installs the fake clock at FROZEN_TIME, lets time flow during load, then pauses it.
//          'paused' pauses the fake clock before the first page script runs (motion traces).
//          false uses real time (assets, extract).
//   freezeTimeline: sets the document timeline playback rate to 0 before navigation, so CSS
//          animations, transitions and Web Animations stay at their start until code seeks them.
//   beforeGoto: optional async (page, context) callback that runs before navigation, for
//          listeners such as page.on('response').
//   prepare: optional async (context) callback that runs before the page is created, for
//          example to dismiss a consent banner in a throwaway page so its cookie is set.
export async function openPage(
  browser,
  { url, width, reducedMotion = false, clock = 'natural', freezeTimeline = false, timeout = 60000, beforeGoto, prepare },
) {
  const context = await browser.newContext(contextOptions(browser, { width, reducedMotion }));
  let page;
  try {
    if (prepare) await prepare(context);
    page = await context.newPage();
    if (clock) {
      await page.clock.install({ time: FROZEN_MS });
      if (clock === 'paused') await page.clock.pauseAt(PAUSED_LOAD_MS);
    }
    clockMode.set(page, clock);
    if (freezeTimeline) await setTimelineRate(page, 0);
    if (beforeGoto) await beforeGoto(page, context);
    const response = await page.goto(url, { waitUntil: 'load', timeout });
    await assertNotBlocked(page, response);
    await waitForNetworkIdle(page);
    if (clock === 'natural') {
      const now = await page.evaluate(() => Date.now());
      await page.clock.pauseAt(now + 1000);
      clockMode.set(page, 'paused');
    }
    return { context, page, response };
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }
}

// Playback rate of every document timeline in the page (0 freezes CSS and Web Animations).
// The CDP session is kept on the page so the setting survives navigation.
export async function setTimelineRate(page, rate) {
  let cdp = page.__ppCdp;
  if (!cdp) {
    cdp = await page.context().newCDPSession(page);
    await cdp.send('Animation.enable');
    page.__ppCdp = cdp;
  }
  await cdp.send('Animation.setPlaybackRate', { playbackRate: rate });
  return cdp;
}

const CHALLENGE_HTML =
  /cf-chl|challenge-platform|cf_chl_opt|_Incapsula_Resource|px-captcha|captcha-delivery\.com|geo\.captcha|Checking your browser/i;
const CHALLENGE_TITLE = /^(just a moment|attention required|access denied|please wait|verifying you are human)/i;

export async function assertNotBlocked(page, response) {
  if (!response) return; // file:// URLs and same-document navigations have no response
  const status = response.status();
  const title = await page.title().catch(() => '');
  const html = status >= 400 || CHALLENGE_TITLE.test(title) ? await page.content().catch(() => '') : '';
  if (CHALLENGE_TITLE.test(title) || ([403, 429, 503].includes(status) && CHALLENGE_HTML.test(html))) {
    throw new BlockedError(`HTTP ${status}, title "${title}"`);
  }
  if (status >= 400) throw new Error(`HTTP ${status} for ${response.url()}`);
}

export async function waitForNetworkIdle(page, timeout = 15000) {
  await page.waitForLoadState('networkidle', { timeout }).catch(() => {
    log(`network did not go idle within ${timeout} ms; continuing`);
  });
}

// Move page time forward. Fake clock: fire timers and animation frames for ms. Real time: wait.
export async function advance(page, ms) {
  if (clockMode.get(page) === 'paused') await page.clock.runFor(ms);
  else await page.waitForTimeout(ms);
}

export function isClockPaused(page) {
  return clockMode.get(page) === 'paused';
}

export async function scrollToY(page, y) {
  await page.evaluate((top) => window.scrollTo({ top, left: 0, behavior: 'instant' }), Math.max(0, Math.round(y)));
}

const REJECT =
  /^(reject|reject all|reject all cookies|decline|decline all|deny|deny all|refuse|refuse all|only necessary|only essential|necessary only|essential only|use necessary cookies only|only necessary cookies)$/i;
const ACCEPT =
  /^(accept|accept all|accept cookies|accept all cookies|allow|allow all|allow cookies|allow all cookies|i agree|agree|got it|ok|okay|close|dismiss)$/i;
const BANNER =
  /cookie|consent|gdpr|ccpa|cmp|privacy|onetrust|cookiebot|didomi|usercentrics|termly|iubenda|osano|klaro|cky-|cc-window/i;

// Close a cookie or consent banner. Prefers reject over accept so fewer third-party widgets load.
// Returns the clicked label, or null when no banner button was found.
export async function closeConsent(page) {
  const label = await page.evaluate(
    ({ reject, accept, banner }) => {
      const R = new RegExp(reject, 'i');
      const A = new RegExp(accept, 'i');
      const B = new RegExp(banner, 'i');
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const inBanner = (el) => {
        for (let n = el; n && n !== document.body; n = n.parentElement) {
          const cls = typeof n.className === 'string' ? n.className : (n.className?.baseVal ?? '');
          const tag = `${n.id} ${cls} ${n.getAttribute('aria-label') ?? ''}`;
          if (B.test(tag)) return true;
          const pos = getComputedStyle(n).position;
          if ((pos === 'fixed' || pos === 'sticky') && /cookie/i.test((n.innerText || '').slice(0, 3000))) return true;
        }
        return false;
      };
      const text = (el) =>
        (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      const buttons = [
        ...document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'),
      ].filter((el) => visible(el) && inBanner(el));
      const pick = buttons.find((b) => R.test(text(b))) ?? buttons.find((b) => A.test(text(b)));
      if (!pick) return null;
      pick.setAttribute('data-pp-consent', '1');
      return text(pick);
    },
    { reject: REJECT.source, accept: ACCEPT.source, banner: BANNER.source },
  );
  if (!label) return null;
  await page.click('[data-pp-consent="1"]', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(600);
  await advance(page, 1000);
  return label;
}

// Scroll to the bottom in steps so lazy images load and scroll reveals fire, then back to the top.
export async function autoScroll(page, { stepRatio = 0.8, maxSteps = 60, waitMs = 150, runMs = 250 } = {}) {
  const vh = page.viewportSize().height;
  let y = 0;
  for (let i = 0; i < maxSteps; i++) {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    if (y + vh >= height) break;
    y += Math.round(vh * stepRatio);
    await scrollToY(page, y);
    await page.waitForTimeout(waitMs);
    await advance(page, runMs);
  }
  await waitForNetworkIdle(page, 10000);
  await waitForImages(page);
  await scrollToY(page, 0);
  await page.waitForTimeout(waitMs);
  await advance(page, runMs);
}

// Wait (real time) until every image has loaded or failed, up to timeout ms.
export async function waitForImages(page, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const pending = await page.evaluate(() => [...document.images].filter((img) => !img.complete).length);
    if (!pending) return 0;
    await sleep(200);
  }
  return page.evaluate(() => [...document.images].filter((img) => !img.complete).length);
}

export async function waitForFonts(page, timeout = 10000) {
  await Promise.race([page.evaluate(() => document.fonts.ready.then(() => true)), sleep(timeout)]);
}

// Bring the page to a still frame: finish finite animations, hold or cancel infinite ones,
// pause videos on their first frame and drop focus. Returns counts for the capture notes.
// Scroll-driven animations are left alone: their state follows the scroll position, not time.
export async function settle(page, { keepInfinite = false } = {}) {
  const counts = await page.evaluate((keep) => {
    let finished = 0;
    let held = 0;
    for (const a of document.getAnimations()) {
      if (a.timeline !== document.timeline) continue;
      // Paused animations stay where their script put them (scroll-linked effects set the time).
      if (a.playState === 'paused') continue;
      const timing = a.effect?.getComputedTiming?.();
      const infinite = !timing || timing.endTime === Infinity;
      if (infinite) {
        if (keep) continue;
        a.cancel();
        held++;
      } else {
        try {
          a.finish();
          finished++;
        } catch {
          a.cancel();
          held++;
        }
      }
    }
    for (const v of document.querySelectorAll('video')) {
      try {
        v.pause();
        v.currentTime = 0;
      } catch {}
    }
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur?.();
    return { finished, held };
  }, keepInfinite);
  await page.waitForTimeout(100);
  return counts;
}
