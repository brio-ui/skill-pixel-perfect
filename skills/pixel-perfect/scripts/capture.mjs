#!/usr/bin/env node
// Capture a page (the original or the clone) into one folder: sections, elements, masks,
// states, motion traces and geometry. Contract: references/scripts.md, section "capture.mjs".
//
//   node capture.mjs --url <url> --out <dir> [--plan .pixel-perfect/plan.json] [--mode original|clone]
//                    [--widths 1440,768,390] [--skip states,motion,stability,geometry]
//                    [--reduced-motion] [--timeout 60000]
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildPlan, changedBox, detectPage, intersectBox, liveTiles, prepareStatic, validatePlan } from './lib/autoplan.mjs';
import { advance, launch, openPage, scrollToY, settle } from './lib/browser.mjs';
import { cloneSectionIds, collectElements, collectMasks, findSections } from './lib/collect.mjs';
import { DEFAULT_WIDTHS, FROZEN_TIME, done, ensureDir, fileSlug, httpUrl, log, main, parseWidths, readJson, viewportFor, writeJson } from './lib/io.mjs';
import { PNG, cropPng, readPng, writePng } from './lib/png.mjs';
import { runTrigger, traceMotion } from './lib/trace.mjs';

const MODES = ['original', 'clone'];
const SKIPS = ['states', 'motion', 'stability', 'geometry'];

main(async () => {
  // Parsed inside main() so a bad flag also ends as a JSON error line.
  const { values } = parseArgs({
    options: {
      url: { type: 'string' },
      out: { type: 'string' },
      plan: { type: 'string' },
      mode: { type: 'string', default: 'original' },
      widths: { type: 'string' },
      skip: { type: 'string', default: '' },
      'reduced-motion': { type: 'boolean', default: false },
      timeout: { type: 'string', default: '60000' },
    },
    strict: true,
  });
  if (!values.url || !values.out) {
    throw new Error('Usage: capture.mjs --url <url> --out <dir> [--plan file] [--mode original|clone]');
  }
  const url = httpUrl(values.url);
  if (!MODES.includes(values.mode)) throw new Error(`Bad --mode: ${values.mode}`);
  const skip = new Set(String(values.skip).split(',').map((s) => s.trim()).filter(Boolean));
  for (const s of skip) if (!SKIPS.includes(s)) throw new Error(`Bad --skip value: ${s}`);
  const timeout = Number(values.timeout);
  if (!Number.isInteger(timeout) || timeout <= 0) throw new Error(`Bad --timeout: ${values.timeout}`);

  const out = resolve(values.out);
  const planPath = resolve(values.plan ?? '.pixel-perfect/plan.json');
  const requested = values.widths ? parseWidths(values.widths) : null;
  const reducedMotion = values['reduced-motion'];
  const browser = await launch();
  try {
    let plan;
    let planWritten = false;
    if (existsSync(planPath)) {
      plan = readJson(planPath);
    } else if (values.mode === 'clone') {
      throw new Error(`Plan not found: ${planPath}. Capture the original first.`);
    } else {
      log('no plan file, building an auto plan');
      plan = await autoPlan(browser, { url, widths: requested ?? [...DEFAULT_WIDTHS], timeout });
      writeJson(planPath, plan);
      planWritten = true;
    }
    const problems = validatePlan(plan);
    if (problems.length) throw new Error(`Bad plan ${planPath}: ${problems.slice(0, 5).join('; ')}`);

    const widths = requested ?? plan.widths;
    const ctx = { browser, url, mode: values.mode, plan, out, timeout, skip, reducedMotion, notes: [], planPath };
    const capture = {
      version: 1,
      mode: values.mode,
      url,
      frozenTime: FROZEN_TIME,
      reducedMotion,
      capturedAt: new Date().toISOString(),
      widths: {},
      geometry: {},
      notes: ctx.notes,
    };
    for (const width of widths) {
      log(`width ${width}`);
      capture.widths[width] = reducedMotion ? await reducedWidth(ctx, width) : await captureWidth(ctx, width);
    }
    if (!reducedMotion && !skip.has('geometry')) capture.geometry = await captureGeometry(ctx, widths);

    writeJson(join(out, 'capture.json'), capture);
    const first = capture.widths[widths[0]];
    const count = (key, pred) => Object.values(capture.widths).reduce((n, w) => n + (w[key] ?? []).filter(pred).length, 0);
    done({
      ok: true,
      out,
      plan: planPath,
      planWritten,
      widths,
      sections: (first?.sections ?? []).filter((s) => !s.missing).length,
      states: count('states', (s) => !s.missing),
      motion: count('motion', (m) => !m.missing),
      notes: ctx.notes.length,
    });
  } finally {
    await browser.close().catch(() => {});
  }
});

// Auto plan: one detection load at the widest of 1440 or the largest width. Finds the sections,
// hover and click targets, CSS and JavaScript loops, and @media breakpoints.
async function autoPlan(browser, { url, widths, timeout }) {
  const width = widths.includes(1440) ? 1440 : Math.max(...widths);
  const planNotes = [];
  const { context, page } = await openPage(browser, { url, width, timeout });
  try {
    const info = await detectPage(page);
    const { consent } = await prepareStatic(page);
    if (consent) planNotes.push(`Closed consent banner: ${consent}`);
    const shotA = PNG.sync.read(await page.screenshot({ fullPage: true }));
    await advance(page, 2350);
    await settle(page);
    const shotB = PNG.sync.read(await page.screenshot({ fullPage: true }));
    const live = liveTiles(shotA, shotB);
    return buildPlan({ url, widths, candidates: info.candidates, breakpoints: info.breakpoints, live, notes: planNotes });
  } finally {
    await context.close().catch(() => {});
  }
}

// Section list for a capture: plan sections with their selectors for this mode.
// Clone mode also adds clone sections the plan does not name, so grade can report them.
async function sectionEntries(ctx, page) {
  const list = ctx.plan.sections.map((s) => ({ id: s.id, selector: selectorFor(ctx, s.id) }));
  if (ctx.mode === 'clone') {
    for (const id of await cloneSectionIds(page)) {
      if (!list.some((e) => e.id === id)) list.push({ id, selector: `[data-pp-section="${id}"]` });
    }
  }
  return list;
}

function selectorFor(ctx, id) {
  const section = ctx.plan.sections.find((s) => s.id === id);
  if (!section) return null;
  return ctx.mode === 'clone' ? `[data-pp-section="${id}"]` : section.selector;
}

function triggerFor(ctx, state) {
  return { action: state.action, selector: ctx.mode === 'clone' ? `[data-pp-trigger~="${state.id}"]` : state.selector };
}

function maskSourcesFor(ctx) {
  if (ctx.mode === 'clone') return [{ selector: '[data-pp-mask]', reason: 'mask' }];
  return ctx.plan.masks.map((m) => ({ selector: m.selector, reason: m.reason }));
}

function motionWidthsFor(plan, entry) {
  let widths = entry.widths ?? plan.widths;
  if ((entry.kind === 'hover' || entry.kind === 'click') && entry.state) {
    const state = plan.states.find((s) => s.id === entry.state);
    if (state) widths = widths.filter((w) => (state.widths ?? plan.widths).includes(w));
  }
  return widths;
}

// Static capture at one width: a settled page, sections, elements, masks, and the stability pass.
async function captureWidth(ctx, width) {
  const { browser, url, timeout, skip, notes } = ctx;
  const dir = join(ctx.out, String(width));
  ensureDir(join(dir, 'sections'));
  const viewport = viewportFor(width);
  const record = { viewport, page: null, sections: [], states: [], motion: [] };
  let consent = null;
  let live = [];

  const { context, page } = await openPage(browser, { url, width, timeout });
  try {
    ({ consent } = await prepareStatic(page));
    if (consent) notes.push(`Closed consent banner at ${width}: ${consent}`);
    const entries = await sectionEntries(ctx, page);
    const found = await findSections(page, entries);
    await page.screenshot({ path: join(dir, 'page.png'), fullPage: true });
    const pagePng = readPng(join(dir, 'page.png'));
    record.page = { png: `${width}/page.png`, w: pagePng.width, h: pagePng.height };

    const maskSources = maskSourcesFor(ctx);
    for (const f of found) {
      if (!f.found) {
        record.sections.push({ id: f.id, missing: true });
        notes.push(`Section ${f.id} not found at ${width}`);
        continue;
      }
      const crop = cropPng(pagePng, f.box);
      if (!crop) {
        record.sections.push({ id: f.id, missing: true });
        notes.push(`Section ${f.id} has no area at ${width}`);
        continue;
      }
      const pngRel = `${width}/sections/${fileSlug(f.id)}.png`;
      writePng(join(ctx.out, pngRel), crop);
      const origin = { x: f.box.x, y: f.box.y };
      const elements = (await collectElements(page, { selector: selectorFor(ctx, f.id) ?? entries.find((e) => e.id === f.id).selector, origin })) ?? [];
      const masks = await collectMasks(page, { extra: maskSources, clip: f.box, origin });
      record.sections.push({ id: f.id, box: f.box, png: pngRel, fallback: f.fallback ?? [], masks, elements });
    }

    if (ctx.mode === 'original' && !skip.has('stability')) {
      await advance(page, 2350);
      await settle(page);
      const stable = PNG.sync.read(await page.screenshot({ fullPage: true }));
      live = liveTiles(pagePng, stable);
      for (const section of record.sections) {
        if (section.missing) continue;
        for (const box of live) {
          const hit = intersectBox(box, section.box);
          if (hit) section.masks.push({ box: { x: hit.x - section.box.x, y: hit.y - section.box.y, w: hit.w, h: hit.h }, reason: 'live' });
        }
      }
    }
  } finally {
    await context.close().catch(() => {});
  }

  if (!skip.has('states')) {
    for (const state of ctx.plan.states) {
      if (!(state.widths ?? ctx.plan.widths).includes(width)) continue;
      record.states.push(await captureState(ctx, state, width, { live, maskSources: maskSourcesFor(ctx) }));
    }
  }
  if (!skip.has('motion')) {
    record.motion = await captureMotion(ctx, width, consent !== null);
  }
  return record;
}

// One state at one width: base screenshot, trigger, settle, state screenshot, changed box, masks and elements.
async function captureState(ctx, state, width, { live, maskSources }) {
  const { browser, url, timeout, notes } = ctx;
  const id = fileSlug(state.id);
  const dir = join(ctx.out, String(width), 'states');
  ensureDir(dir);
  const pngRel = `${width}/states/${id}.png`;
  const baseRel = `${width}/states/${id}-base.png`;
  const missing = (why) => {
    notes.push(`State ${state.id} at ${width}: ${why}`);
    return { id: state.id, section: state.section, missing: true };
  };
  const sectionSelector = selectorFor(ctx, state.section);
  if (!sectionSelector) return missing('section not found');

  const { context, page } = await openPage(browser, { url, width, timeout });
  try {
    await prepareStatic(page);
    const [found] = await findSections(page, [{ id: state.section, selector: sectionSelector }]);
    if (!found?.found) return missing('section not found');
    await scrollToY(page, found.box.y);
    await page.screenshot({ path: join(ctx.out, baseRel) });

    const result = await runTrigger(page, triggerFor(ctx, state));
    if (!result.ok) return missing(result.reason);
    await advance(page, 1000);
    await settle(page);
    const scrollY = await page.evaluate(() => window.scrollY);
    await page.screenshot({ path: join(ctx.out, pngRel) });

    const basePng = readPng(join(ctx.out, baseRel));
    const statePng = readPng(join(ctx.out, pngRel));
    const changed = changedBox(basePng, statePng);
    const clip = { x: 0, y: scrollY, w: viewportFor(width).width, h: viewportFor(width).height };
    const origin = { x: 0, y: scrollY };
    const masks = await collectMasks(page, { extra: maskSources, clip, origin });
    for (const box of live) {
      const hit = intersectBox(box, clip);
      if (hit) masks.push({ box: { x: hit.x, y: hit.y - scrollY, w: hit.w, h: hit.h }, reason: 'live' });
    }
    const elements = (await collectElements(page, { selector: null, origin, includeRoot: false, clip })) ?? [];
    return { id: state.id, section: state.section, png: pngRel, basePng: baseRel, changed, scrollY, masks, elements };
  } finally {
    await context.close().catch(() => {});
  }
}

// Motion traces at one width. Each entry opens its own page inside traceMotion.
async function captureMotion(ctx, width, consent) {
  const { plan, notes } = ctx;
  const out = [];
  for (const entry of plan.motion) {
    if (!motionWidthsFor(plan, entry).includes(width)) continue;
    const sectionSelector = selectorFor(ctx, entry.section);
    if (!sectionSelector) {
      notes.push(`Motion ${entry.id} at ${width}: section not found`);
      out.push({ id: entry.id, kind: entry.kind, section: entry.section, missing: true });
      continue;
    }
    const state = entry.state ? plan.states.find((s) => s.id === entry.state) : null;
    const trigger = state ? triggerFor(ctx, state) : null;
    out.push(
      await traceMotion(ctx.browser, {
        url: ctx.url,
        width,
        entry,
        sectionSelector,
        trigger,
        outDir: ctx.out,
        reducedMotion: ctx.reducedMotion,
        consent,
        timeout: ctx.timeout,
        notes,
      }),
    );
  }
  return out;
}

// Reduced-motion capture: motion traces only, with prefers-reduced-motion emulated.
async function reducedWidth(ctx, width) {
  ensureDir(join(ctx.out, String(width)));
  const motion = await captureMotion(ctx, width, true);
  return { viewport: viewportFor(width), sections: [], states: [], motion };
}

// Geometry widths: the base page is resized to each one, settled, and measured. No screenshots.
async function captureGeometry(ctx, widths) {
  const geometryWidths = ctx.plan.geometryWidths ?? [];
  if (!geometryWidths.length) return {};
  const base = ctx.plan.widths.includes(1440) ? 1440 : Math.max(...ctx.plan.widths);
  const result = {};
  const { context, page } = await openPage(ctx.browser, { url: ctx.url, width: base, timeout: ctx.timeout });
  try {
    await prepareStatic(page);
    const entries = await sectionEntries(ctx, page);
    for (const gw of geometryWidths) {
      await page.setViewportSize(viewportFor(gw));
      await advance(page, 1000);
      await settle(page);
      const sections = [];
      for (const f of await findSections(page, entries)) {
        if (!f.found) {
          sections.push({ id: f.id, missing: true });
          continue;
        }
        const origin = { x: f.box.x, y: f.box.y };
        const selector = entries.find((e) => e.id === f.id).selector;
        sections.push({ id: f.id, box: f.box, elements: (await collectElements(page, { selector, origin })) ?? [] });
      }
      result[gw] = { sections };
    }
  } finally {
    await context.close().catch(() => {});
  }
  return result;
}
