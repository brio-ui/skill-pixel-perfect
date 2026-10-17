// Motion traces. Each trace opens a fresh page with the fake clock paused and the document
// timeline frozen, prepares it for the entry's kind, then steps it and samples the section.
// Time-based kinds step GATE.motionStepMs at a time; scrub steps through scroll positions.
// capture.mjs calls traceMotion() once per plan motion entry and width. motion.md has the steps.
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { PAUSED_LOAD_MS, advance, closeConsent, openPage, scrollToY, settle } from './browser.mjs';
import { findSections, installCollector } from './collect.mjs';
import { GATE, ensureDir, fileSlug, log } from './io.mjs';

export const MOTION_DURATION_MS = Object.freeze({ load: 2000, scroll: 1500, hover: 600, click: 800, loop: 3000 });
export const SCRUB_STEPS = 12;
export const MOVE_PX = 0.5; // a sample this far from the first one (any of x, y, w, h) counts as movement
export const MOVE_OPACITY = 0.01;
export const MAX_MOVERS = 150;
export const MAX_REDUCED = 300;

const PREP_MS = 3000; // fake time that runs before every kind except load
const SCROLL_REVEAL_AT = 0.75; // scroll traces put the section top this far down the viewport
const SCRUB_RUN_MS = 1000; // fake time after each scrub position, so smoothed scroll effects catch up
const START_WAIT_MS = 300; // real time before step 0, for observers and input events
const STEP_WAIT_MS = 20; // real time after each step, so the page renders a frame
const SCROLL_WAIT_MS = 150; // real time after a scroll before the mouse moves; Chrome can drop hover right after a scroll
const HOVER_WAIT_MS = 1000; // real time to wait for :hover after the mouse arrives

export function motionSamples(entry) {
  if (entry.kind === 'scrub') return Math.max(2, entry.steps ?? SCRUB_STEPS);
  const durationMs = entry.durationMs ?? MOTION_DURATION_MS[entry.kind] ?? 1500;
  return Math.round(durationMs / GATE.motionStepMs) + 1;
}

// Scroll so the element's center sits mid-viewport when part of it is outside the viewport.
// Returns its viewport box, or null when it has none.
async function intoView(page, handle) {
  const box = await handle.boundingBox();
  if (!box) return null;
  const { height } = page.viewportSize();
  if (box.y >= 0 && box.y + box.height <= height) return box;
  await page.evaluate((dy) => window.scrollBy({ top: dy, left: 0, behavior: 'instant' }), box.y + box.height / 2 - height / 2);
  await sleep(SCROLL_WAIT_MS);
  return handle.boundingBox();
}

async function waitForHover(handle, ms) {
  const end = Date.now() + ms;
  do {
    if (await handle.evaluate((el) => el.matches(':hover')).catch(() => false)) return true;
    await sleep(25);
  } while (Date.now() < end);
  return false;
}

// Move the mouse to the element's center and wait (real time) until it matches :hover.
// A second small move covers the case where Chrome drops the first one.
async function hoverOver(page, handle, box) {
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  if (await waitForHover(handle, HOVER_WAIT_MS / 2)) return true;
  await page.mouse.move(x + Math.min(1, box.width / 4), y);
  await page.mouse.move(x, y);
  return waitForHover(handle, HOVER_WAIT_MS);
}

// Run a state trigger. Hover moves the mouse to the trigger's center and waits until it matches
// :hover. Click does the same, then clicks, so the hover and click effects start together.
// Focus calls focus(). Scrolls the trigger into view first when it is outside the viewport.
// Returns { ok: true } or { ok: false, reason }. Shared with the state capture in capture.mjs.
export async function runTrigger(page, { action, selector }) {
  if (!['hover', 'click', 'focus'].includes(action)) throw new Error(`Unknown trigger action: ${action}`);
  const handle = await page.$(selector).catch(() => null);
  if (!handle) return { ok: false, reason: `trigger not found: ${selector}` };
  if (action === 'focus') {
    await handle.evaluate((el) => el.focus());
    return { ok: true };
  }
  const box = await intoView(page, handle);
  if (!box) return { ok: false, reason: `trigger has no box: ${selector}` };
  if (!(await hoverOver(page, handle, box))) return { ok: false, reason: `hover did not reach the trigger (covered?): ${selector}` };
  if (action === 'click') await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  return { ok: true };
}

// Real-time wait until the images in the viewport have loaded, up to timeout ms.
export async function waitForVisibleImages(page, timeout = 5000) {
  await installCollector(page);
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (!(await page.evaluate(() => globalThis.__ppLib.pendingVisibleImages()))) return;
    await sleep(100);
  }
}

// Open url once in a throwaway page of the same context and close its consent banner,
// so the trace page loads with the consent cookie already set and no banner on top.
async function dismissConsent(context, url, timeout) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'load', timeout });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await closeConsent(page);
  } catch (err) {
    log(`consent pre-visit failed: ${err.message}`);
  } finally {
    await page.close().catch(() => {});
  }
}

// Screenshot of the visible part of box (document coordinates); the whole viewport when box is
// null or out of view.
async function saveFrame(page, file, box) {
  const { width, height } = page.viewportSize();
  let clip;
  if (box) {
    const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
    const left = Math.max(0, Math.round(box.x - scroll.x));
    const top = Math.max(0, Math.round(box.y - scroll.y));
    const right = Math.min(width, Math.round(box.x - scroll.x + box.w));
    const bottom = Math.min(height, Math.round(box.y - scroll.y + box.h));
    if (right - left >= 1 && bottom - top >= 1) clip = { x: left, y: top, width: right - left, height: bottom - top };
  }
  ensureDir(dirname(file));
  await page.screenshot({ path: file, clip });
}

async function sectionBox(page, selector) {
  const [section] = await findSections(page, [{ id: 'trace', selector }]);
  return section.found ? section.box : null;
}

function moves(track) {
  const first = track[0];
  return track.some((s) => {
    if ((s === null) !== (first === null)) return true;
    if (s === null) return false;
    for (let j = 0; j < 4; j++) if (Math.abs(s[j] - first[j]) > MOVE_PX) return true;
    return Math.abs(s[4] - first[4]) > MOVE_OPACITY;
  });
}

const visibleAtSomeSample = (track) => track.some((s) => s !== null && s[4] >= 0.01);

// Normal traces keep elements that move. Reduced traces keep every element, visible ones first
// when the cap is reached, so grade.mjs can check end states.
export function keepElements(all, reducedMotion) {
  if (!reducedMotion) return all.filter((e) => moves(e.track)).slice(0, MAX_MOVERS);
  if (all.length <= MAX_REDUCED) return all;
  const ranked = all.map((e, i) => ({ e, i, rank: visibleAtSomeSample(e.track) ? 0 : 1 }));
  ranked.sort((a, b) => a.rank - b.rank || a.i - b.i);
  return ranked
    .slice(0, MAX_REDUCED)
    .sort((a, b) => a.i - b.i)
    .map((r) => r.e);
}

// Trace one motion entry at one width.
//   entry: plan motion entry { id, kind, section, state?, durationMs?, steps?, periodMs?, driver? }
//          periodMs (loop entries) is the longest CSS iteration the plan found; prep rounds to it.
//   sectionSelector: selector of the section root on this side
//   trigger: { action, selector } for hover and click entries
//   outDir: capture folder; frames go to <outDir>/<width>/motion/<slug>/
//   consent: close the consent banner in a throwaway page first (the static capture found one)
// Returns the motion record for capture.json. Notes are pushed to notes.
export async function traceMotion(
  browser,
  { url, width, entry, sectionSelector, trigger = null, outDir, reducedMotion = false, consent = false, timeout = 60000, notes = [] },
) {
  const { kind } = entry;
  const base = { id: entry.id, kind, section: entry.section };
  if (entry.state) base.state = entry.state;
  const missing = (why) => {
    notes.push(`Motion ${entry.id} at ${width}: ${why}`);
    return { ...base, missing: true };
  };
  if ((kind === 'hover' || kind === 'click') && !trigger) return missing('no trigger');

  const scrub = kind === 'scrub';
  const stepMs = GATE.motionStepMs;
  const samples = motionSamples(entry);
  const slug = fileSlug(entry.id);

  const { context, page } = await openPage(browser, {
    url,
    width,
    reducedMotion,
    clock: 'paused',
    freezeTimeline: true,
    timeout,
    prepare: consent ? (ctx) => dismissConsent(ctx, url, timeout) : undefined,
  });
  try {
    const vh = page.viewportSize().height;
    let positions = null;
    if (kind !== 'load') {
      // Hover, click and loop traces scroll first, so scroll reveals in view finish during prep.
      if (kind === 'hover' || kind === 'click' || kind === 'loop') {
        const box = await sectionBox(page, sectionSelector);
        if (!box) return missing('section not found');
        await scrollToY(page, box.y);
        const handle = trigger ? await page.$(trigger.selector).catch(() => null) : null;
        if (handle) await intoView(page, handle);
        await sleep(START_WAIT_MS);
      }
      // Loop prep runs a whole number of periods when the period is known, so step 0 sits at the
      // start of a cycle for loops that began at load. traceStep's catch-up seek keeps CSS loops
      // in phase with JavaScript loops either way.
      const period = entry.periodMs ?? entry.durationMs ?? MOTION_DURATION_MS.loop;
      await advance(page, kind === 'loop' && period > 0 ? Math.ceil(PREP_MS / period) * period : PREP_MS);
      await settle(page, { keepInfinite: kind === 'loop' });
      if (kind === 'scroll' || scrub) {
        const box = await sectionBox(page, sectionSelector);
        if (!box) return missing('section not found');
        if (kind === 'scroll') await scrollToY(page, box.y - SCROLL_REVEAL_AT * vh);
        else {
          const maxY = await page.evaluate(() => Math.max(0, document.documentElement.scrollHeight - window.innerHeight));
          const clamp = (y) => Math.min(maxY, Math.max(0, Math.round(y)));
          const from = clamp(box.y - vh);
          const to = clamp(box.y + box.h);
          positions = Array.from({ length: samples }, (_, i) => clamp(from + ((to - from) * i) / (samples - 1)));
        }
      }
      await waitForVisibleImages(page);
    }

    await installCollector(page);
    const present = await page.evaluate((selector) => globalThis.__ppLib.traceStart({ selector }), sectionSelector);
    if (!present && kind !== 'load') return missing('section not found');
    if (trigger) {
      const result = await runTrigger(page, trigger);
      if (!result.ok) return missing(result.reason);
    }
    await sleep(START_WAIT_MS);

    // Fake time since the page loaded, for the catch-up seek of CSS loops.
    const loopOffsetMs = kind === 'loop' ? (await page.evaluate(() => Date.now())) - PAUSED_LOAD_MS : 0;
    const mid = Math.floor((samples - 1) / 2);
    const frameAt = { 0: 0, 50: mid, 100: samples - 1 };
    const frames = {};
    const meta = [];
    const tracks = [];
    const scrollYs = [];
    let found = false;
    for (let k = 0; k < samples; k++) {
      if (scrub) {
        await scrollToY(page, positions[k]);
        await sleep(100);
        await advance(page, SCRUB_RUN_MS);
      }
      const step = await page.evaluate((o) => globalThis.__ppLib.traceStep(o), {
        k,
        stepMs,
        seek: !scrub,
        finish: scrub,
        loops: kind === 'loop',
        loopOffsetMs,
      });
      found ||= step.found;
      for (const item of step.added) {
        meta.push(item);
        tracks.push(new Array(k).fill(null));
      }
      step.boxes.forEach((b, i) => tracks[i].push(b));
      scrollYs.push(Math.round(step.scrollY));
      for (const [label, at] of Object.entries(frameAt)) {
        if (at !== k) continue;
        const rel = `${width}/motion/${slug}/f${label}.png`;
        await saveFrame(page, join(outDir, rel), step.rootBox);
        frames[label] = rel;
      }
      if (!scrub && k < samples - 1) {
        await advance(page, stepMs);
        await sleep(STEP_WAIT_MS);
      }
    }
    if (!found) return missing('section not found during the trace');

    const all = meta.map((m, i) => ({ ...m, track: tracks[i] }));
    const elements = keepElements(all, reducedMotion);
    if (!reducedMotion && all.filter((e) => moves(e.track)).length > MAX_MOVERS) {
      notes.push(`Motion ${entry.id} at ${width}: more than ${MAX_MOVERS} moving elements; kept the first ${MAX_MOVERS}`);
    }
    return {
      ...base,
      stepMs: scrub ? null : stepMs,
      samples,
      scrollY: scrub ? scrollYs : [scrollYs[0]],
      frames,
      elements,
    };
  } catch (err) {
    log(err?.stack ?? String(err));
    return missing(`trace failed: ${err?.message ?? err}`);
  } finally {
    await context.close().catch(() => {});
  }
}
