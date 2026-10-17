// Grades a clone capture against the original capture and writes round-<n>/grade.json plus diff PNGs.
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pixelmatch from 'pixelmatch';
import { PNG, cropPng, paintBoxes, readPng, writePng } from './lib/png.mjs';
import { GATE, done, log, main, readJson, writeJson } from './lib/io.mjs';
import {
  jumpIndexes,
  lastBox,
  lastSample,
  pairNearest,
  sampleCount,
  touchesJump,
  traceEnd,
  traceMoves,
  traceStart,
} from './lib/match.mjs';

const DIFF_RED = [255, 0, 0];
const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;
const byId = (list) => new Map((list ?? []).map((item) => [item.id, item]));
const widthKeys = (capture) =>
  Object.keys(capture?.widths ?? {}).sort((a, b) => Number(a) - Number(b));
const normalizeStyle = (prop, value) => {
  if (value === null || value === undefined) return null;
  // Image URLs differ between the original and the clone by design; only the shape matters.
  if (prop === 'backgroundImage') return String(value).replace(/url\([^)]*\)/g, 'url()');
  return String(value);
};

function boxIntersects(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// Grow a box by `pad` on each side, then clip it to the viewport.
function cropBoxFor(changed, viewport, pad = 16) {
  const x0 = Math.max(0, changed.x - pad);
  const y0 = Math.max(0, changed.y - pad);
  const x1 = Math.min(viewport.width, changed.x + changed.w + pad);
  const y1 = Math.min(viewport.height, changed.y + changed.h + pad);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

// Mask painting shared by sections and states. Both crops get the same flat colour over the union of masks.
// Returns the mask coverage object, with the painted count and the mask reasons.
function paintMasks(cropA, cropB, boxes, reasons) {
  const total = cropA.width * cropA.height;
  const painted = paintBoxes(cropA, boxes);
  paintBoxes(cropB, boxes);
  const pct = round2((painted / total) * 100);
  const pass = pct <= GATE.maskCapPct;
  const masks = { pct, pass, sources: [...new Set(reasons)] };
  if (!pass) masks.reason = 'mask-cap';
  return { masks, painted };
}

// Pixel diff over two equal-size crops. Painted pixels are excluded from the denominator.
function pixelDiff(cropA, cropB, painted, outPath) {
  const { width: w, height: h } = cropA;
  const out = new PNG({ width: w, height: h });
  const diff = pixelmatch(cropA.data, cropB.data, out.data, w, h, {
    threshold: GATE.aaThreshold,
    includeAA: false,
    diffColor: DIFF_RED,
  });
  writePng(outPath, out);
  const unmasked = w * h - painted;
  return { diffPct: unmasked > 0 ? round2((diff / unmasked) * 100) : 0, diff: out };
}

// Diff regions: where the red pixels of a diff image sit. A diff pixel is exactly [255,0,0];
// anti-aliased pixels are yellow and do not count. Tiles with at least minPixels diff pixels are hot,
// and hot tiles that touch (diagonals too) form one group. Each region is the group's tile box,
// clipped to the image, with the diff pixel count of its tiles. Largest first, at most max.
export function diffRegions(png, { tile = 32, minPixels = 10, max = 5 } = {}) {
  const cols = Math.ceil(png.width / tile);
  const rows = Math.ceil(png.height / tile);
  const counts = new Uint32Array(cols * rows);
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      if (png.data[i] === DIFF_RED[0] && png.data[i + 1] === DIFF_RED[1] && png.data[i + 2] === DIFF_RED[2]) {
        counts[Math.floor(y / tile) * cols + Math.floor(x / tile)]++;
      }
    }
  }
  const hot = (t) => counts[t] >= minPixels;
  const seen = new Uint8Array(cols * rows);
  const regions = [];
  for (let start = 0; start < counts.length; start++) {
    if (seen[start] || !hot(start)) continue;
    let minR = Infinity;
    let maxR = -Infinity;
    let minC = Infinity;
    let maxC = -Infinity;
    let pixels = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const t = stack.pop();
      const r = Math.floor(t / cols);
      const c = t % cols;
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
      minC = Math.min(minC, c);
      maxC = Math.max(maxC, c);
      pixels += counts[t];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
          const n = nr * cols + nc;
          if (seen[n] || !hot(n)) continue;
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    const x = minC * tile;
    const y = minR * tile;
    const x1 = Math.min(png.width, (maxC + 1) * tile);
    const y1 = Math.min(png.height, (maxR + 1) * tile);
    regions.push({ box: { x, y, w: x1 - x, h: y1 - y }, pixels });
  }
  regions.sort((p, q) => q.pixels - p.pixels || p.box.y - q.box.y || p.box.x - q.box.x);
  return regions.slice(0, max);
}

// Element geometry check. Pairs by key and nearest centre; every pair must be within GATE.boxPx.
export function geometryCheck(origEls, cloneEls) {
  const { pairs, unpairedA, unpairedB } = pairNearest(origEls, cloneEls, {
    keyOf: (e) => e.key,
    boxOf: (e) => e.box,
  });
  const failed = [];
  for (const [ia, ib] of pairs) {
    const o = origEls[ia].box;
    const c = cloneEls[ib].box;
    const delta = {
      x: round2(c.x - o.x),
      y: round2(c.y - o.y),
      w: round2(c.w - o.w),
      h: round2(c.h - o.h),
    };
    const worst = Math.max(Math.abs(delta.x), Math.abs(delta.y), Math.abs(delta.w), Math.abs(delta.h));
    if (worst > GATE.boxPx) {
      failed.push({ key: origEls[ia].key, original: o, clone: c, delta });
    }
  }
  const missing = unpairedA.map((i) => ({ key: origEls[i].key, original: origEls[i].box }));
  const extra = unpairedB.map((i) => ({ key: cloneEls[i].key, clone: cloneEls[i].box }));
  return {
    pass: failed.length === 0 && missing.length === 0,
    checked: origEls.length,
    failed,
    missing,
    extra,
  };
}

// Style differences for paired elements. Largest original element first, at most 12.
function styleHints(pairs, origEls, cloneEls, limit = 12) {
  const hints = [];
  for (const [ia, ib] of pairs) {
    const o = origEls[ia];
    const c = cloneEls[ib];
    const sa = o.style ?? {};
    const sb = c.style ?? {};
    for (const prop of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
      const va = sa[prop] ?? null;
      const vb = sb[prop] ?? null;
      if (normalizeStyle(prop, va) !== normalizeStyle(prop, vb)) {
        hints.push({ key: o.key, prop, original: va, clone: vb, area: o.box.w * o.box.h });
      }
    }
  }
  hints.sort((p, q) => q.area - p.area);
  return hints.slice(0, limit).map(({ area, ...hint }) => hint);
}

// One section at one width. Returns the width result, its score and its failing-check count.
function gradeSectionWidth(origSec, cloneSec, { origDir, cloneDir, diffDir, name }) {
  if (!cloneSec || cloneSec.missing) {
    return { result: { pass: false, missing: true }, score: 0, failCount: 1 };
  }

  const origPng = readPng(join(origDir, origSec.png));
  const clonePng = readPng(join(cloneDir, cloneSec.png));
  const common = {
    x: 0,
    y: 0,
    w: Math.min(origPng.width, clonePng.width),
    h: Math.min(origPng.height, clonePng.height),
  };
  const cropA = cropPng(origPng, common);
  const cropB = cropPng(clonePng, common);

  const size = {
    pass:
      Math.abs(origSec.box.w - cloneSec.box.w) <= GATE.heightPx &&
      Math.abs(origSec.box.h - cloneSec.box.h) <= GATE.heightPx,
    original: { w: origSec.box.w, h: origSec.box.h },
    clone: { w: cloneSec.box.w, h: cloneSec.box.h },
  };

  const maskBoxes = [...(origSec.masks ?? []), ...(cloneSec.masks ?? [])];
  const { masks, painted } = paintMasks(
    cropA,
    cropB,
    maskBoxes.map((m) => m.box),
    maskBoxes.map((m) => m.reason ?? 'mask'),
  );

  let pixel;
  if (!size.pass) {
    pixel = { pass: false, skipped: 'size' };
  } else {
    const diffPng = `diff/${name}.png`;
    const { diffPct, diff } = pixelDiff(cropA, cropB, painted, join(diffDir, `${name}.png`));
    pixel = { pass: diffPct <= GATE.pixelPct, diffPct, diffPng };
    if (!pixel.pass) pixel.regions = diffRegions(diff);
  }

  const geometry = geometryCheck(origSec.elements ?? [], cloneSec.elements ?? []);
  const origEls = origSec.elements ?? [];
  const cloneEls = cloneSec.elements ?? [];
  const { pairs } = pairNearest(origEls, cloneEls, { keyOf: (e) => e.key, boxOf: (e) => e.box });
  const hints = styleHints(pairs, origEls, cloneEls);

  const pass = size.pass && masks.pass && pixel.pass && geometry.pass;
  const failCount =
    (size.pass ? 0 : 1) +
    (masks.pass ? 0 : 1) +
    (pixel.skipped ? 0 : pixel.pass ? 0 : 1) +
    (geometry.pass ? 0 : 1);
  const score = pixel.skipped ? 0 : round2(100 - pixel.diffPct);
  return { result: { pass, size, masks, pixel, geometry, hints }, score, failCount };
}

// States: crop both state screenshots to the changed box, then run the same mask, pixel and geometry checks.
function gradeStates(origCap, cloneCap, width, { origDir, cloneDir, diffDir }) {
  const w = String(width);
  const out = [];
  const cloneStates = new Map((cloneCap.widths?.[w]?.states ?? []).map((s) => [s.id, s]));
  const viewport = origCap.widths[w].viewport;

  for (const st of origCap.widths[w].states ?? []) {
    const base = { id: st.id, width, section: st.section };
    if (st.missing) {
      out.push({ ...base, pass: true, note: 'state missing in the original, not checked' });
      continue;
    }
    if (!st.changed) {
      out.push({ ...base, pass: true, diffPct: 0, geometryFailed: 0, note: 'no visible change in the original' });
      continue;
    }
    const cs = cloneStates.get(st.id);
    if (!cs || cs.missing) {
      out.push({ ...base, pass: false, missing: true });
      continue;
    }

    const crop = cropBoxFor(st.changed, viewport);
    const origPng = cropPng(readPng(join(origDir, st.png)), crop);
    const clonePng = cropPng(readPng(join(cloneDir, cs.png)), crop);
    if (!origPng || !clonePng) {
      out.push({ ...base, pass: false, note: 'changed box is outside the screenshot' });
      continue;
    }
    const common = {
      x: 0,
      y: 0,
      w: Math.min(origPng.width, clonePng.width),
      h: Math.min(origPng.height, clonePng.height),
    };
    const cropA = cropPng(origPng, common);
    const cropB = cropPng(clonePng, common);

    // Masks are viewport-relative; move them into crop coordinates.
    const toCrop = (m) => ({ ...m.box, x: m.box.x - crop.x, y: m.box.y - crop.y });
    const maskList = [...(st.masks ?? []), ...(cs.masks ?? [])];
    const { masks, painted } = paintMasks(
      cropA,
      cropB,
      maskList.map(toCrop),
      maskList.map((m) => m.reason ?? 'mask'),
    );
    const name = `state-${st.id}-${w}`;
    const { diffPct, diff } = pixelDiff(cropA, cropB, painted, join(diffDir, `${name}.png`));
    const pixelPass = diffPct <= GATE.pixelPct;

    const inCrop = (el) => boxIntersects(el.box, crop);
    const geometry = geometryCheck((st.elements ?? []).filter(inCrop), (cs.elements ?? []).filter(inCrop));
    const geometryFailed = geometry.failed.length + geometry.missing.length;

    // Region boxes are relative to cropBox, which is in viewport coordinates.
    out.push({
      ...base,
      pass: masks.pass && pixelPass && geometryFailed === 0,
      diffPct,
      geometryFailed,
      diffPng: `diff/${name}.png`,
      masks,
      cropBox: crop,
      ...(pixelPass ? {} : { regions: diffRegions(diff) }),
    });
  }
  return out;
}

function geometryWidthResult(origSec, cloneSec, width) {
  if (!cloneSec || cloneSec.missing) {
    const missing = (origSec.elements ?? []).length;
    return { width, pass: false, failed: 0, missing };
  }
  const g = geometryCheck(origSec.elements ?? [], cloneSec.elements ?? []);
  return { width, pass: g.pass, failed: g.failed.length, missing: g.missing.length };
}

// Loop entries are compared after a time shift, because the clone's loop may run at another phase.
const LOOP_SHIFT_STEP = 0.25; // shift search step, in samples
const JUMP_MATCH = 1.5; // jumps in both tracks this close (in samples) are excused
const EPS = 1e-9;

// Jumps of one pair that the other track also makes within JUMP_MATCH samples once the clone is
// shifted by delta, plus jumps within JUMP_MATCH samples of the compared window's edges, where the
// partner jump can fall outside the trace. jumps: { a, b } index lists of the original and clone.
function matchJumps({ a, b }, delta, lo, hi) {
  const near = (x, list) => list.some((y) => Math.abs(x - y) <= JUMP_MATCH);
  const atEdge = (x) => x <= lo + JUMP_MATCH || x >= hi - JUMP_MATCH;
  const bInA = b.map((j) => j - delta);
  return {
    a: new Set(a.filter((i) => near(i, bInA) || atEdge(i))),
    b: new Set(b.filter((j) => near(j - delta, a) || atEdge(j - delta))),
  };
}

// Per-sample comparison of paired tracks. Original sample k is compared with the clone at k + delta
// (interpolated when delta is fractional). jumps: per-pair jump lists for loop entries, or null.
// A sample with a box on one side only counts as a null mismatch.
function compareTracks(pairs, n, delta, jumps) {
  const lo = Math.max(0, Math.ceil(-delta - EPS));
  const hi = Math.min(n - 1, Math.floor(n - 1 - delta + EPS));
  let maxPx = 0;
  let maxOpacity = 0;
  let worst = null;
  let nulls = 0;
  let excused = 0;
  pairs.forEach(({ key, ta, tb }, p) => {
    const matched = jumps ? matchJumps(jumps[p], delta, lo, hi) : null;
    for (let k = lo; k <= hi; k++) {
      const u = k + delta;
      if (matched && (touchesJump(k, matched.a) || touchesJump(u, matched.b))) {
        excused++;
        continue;
      }
      const a = ta[k] ?? null;
      const i0 = Math.floor(u + EPS);
      const f = u - i0;
      const b0 = tb[i0] ?? null;
      const b1 = f < EPS ? b0 : (tb[i0 + 1] ?? null);
      const bMissing = !b0 || !b1;
      if (!a && bMissing) continue;
      if (!a || bMissing) {
        nulls++;
        continue;
      }
      let px = 0;
      for (let j = 0; j < 4; j++) px = Math.max(px, Math.abs(a[j] - (b0[j] + (b1[j] - b0[j]) * f)));
      if (px > maxPx) {
        maxPx = px;
        worst = { key, sample: k };
      }
      maxOpacity = Math.max(maxOpacity, Math.abs(a[4] - (b0[4] + (b1[4] - b0[4]) * f)));
    }
  });
  return { maxPx, maxOpacity, worst, nulls, excused };
}

// Loop entries: the shift (in samples, up to half the trace either way) that fits best.
// Score: null mismatches first, then the larger of maxPx and maxOpacity against the gate.
// Shifts are tried nearest to zero first, so ties keep the smaller shift.
function bestShift(pairs, n) {
  const cap = Math.max(2, Math.floor(n / 5)); // a track that jumps more often than this gets no excuses
  const jumps = pairs.map(({ ta, tb }) => {
    const a = jumpIndexes(ta, n);
    const b = jumpIndexes(tb, n);
    return { a: a.length > cap ? [] : a, b: b.length > cap ? [] : b };
  });
  const steps = Math.round(Math.floor((n - 1) / 2) / LOOP_SHIFT_STEP);
  let best = null;
  for (let i = 0; i <= 2 * steps; i++) {
    const delta = (i % 2 ? (i + 1) / 2 : -i / 2) * LOOP_SHIFT_STEP;
    const result = compareTracks(pairs, n, delta, jumps);
    const score = result.nulls * 1000 + Math.max(result.maxPx / GATE.motionPx, result.maxOpacity / GATE.motionOpacity);
    if (!best || score < best.score - EPS) best = { ...result, delta, score };
  }
  return best;
}

// Keys of elements that move in a loop entry, per section, from every capture in lists.
// Other motion entries of the same section leave these keys out, so a loop that keeps running
// during a reveal or hover trace is graded once, by its own loop entry.
export function loopKeysBySection(lists) {
  const out = new Map();
  for (const list of lists) {
    for (const m of list ?? []) {
      if (m.kind !== 'loop' || m.missing) continue;
      const n = sampleCount(m);
      const keys = out.get(m.section) ?? new Set();
      for (const e of m.elements ?? []) if (traceMoves(e.track, n)) keys.add(e.key);
      out.set(m.section, keys);
    }
  }
  return out;
}

// Motion trace check for one entry at one width. ignoreKeys: element keys to leave out (from
// loopKeysBySection for non-loop entries).
// Loop entries are compared at the time shift that fits best, reported as shiftMs (positive: the
// clone shows each frame that much later than the original). Jumps that both tracks make, such as
// a marquee that returns to its start, are excused within JUMP_MATCH samples. Their start and end
// timing is reported but not checked.
export function gradeMotion(origEntry, cloneEntry, width, { ignoreKeys = null } = {}) {
  const base = { id: origEntry.id, width };
  if (origEntry.missing) return { ...base, pass: true, note: 'motion entry missing in the original, not checked' };
  if (!cloneEntry || cloneEntry.missing) return { ...base, pass: false, missing: true };

  const loop = origEntry.kind === 'loop';
  const step = origEntry.stepMs ?? GATE.motionStepMs;
  const n = Math.min(sampleCount(origEntry), sampleCount(cloneEntry));
  const keep = (e) => !ignoreKeys?.has(e.key);
  const elementsA = origEntry.elements.filter(keep);
  const elementsB = cloneEntry.elements.filter(keep);
  const moversA = elementsA.filter((e) => traceMoves(e.track, n));
  const moversB = elementsB.filter((e) => traceMoves(e.track, n));
  if (!moversA.length && !moversB.length) {
    return { ...base, pass: true, note: 'no motion', maxPx: 0, maxOpacity: 0, startDeltaMs: 0, endDeltaMs: 0, worst: null, unpaired: 0 };
  }

  const pairing = pairNearest(moversA, moversB, { keyOf: (e) => e.key, boxOf: (e) => lastBox(e.track, n) });
  const pairs = pairing.pairs.map(([ia, ib]) => ({ key: moversA[ia].key, ta: moversA[ia].track, tb: moversB[ib].track }));
  const cmp = loop ? bestShift(pairs, n) : compareTracks(pairs, n, 0, null);

  const unpaired = pairing.unpairedA.length + pairing.unpairedB.length;
  const delta = (a, b) => {
    if (a === null && b === null) return 0;
    if (a === null || b === null) return null;
    return Math.abs(a - b) * step;
  };
  const startDeltaMs = delta(traceStart(elementsA, n), traceStart(elementsB, n));
  const endDeltaMs = delta(traceEnd(elementsA, n), traceEnd(elementsB, n));

  // loop and scrub have no meaningful start or end, so only their per-sample deviation is checked.
  const timingChecked = !loop && origEntry.kind !== 'scrub';
  const timingOk =
    !timingChecked ||
    ((startDeltaMs ?? Infinity) <= GATE.motionMs && (endDeltaMs ?? Infinity) <= GATE.motionMs);

  const nullMismatch = cmp.nulls > 0;
  const pass =
    unpaired === 0 &&
    !nullMismatch &&
    cmp.maxPx <= GATE.motionPx &&
    cmp.maxOpacity <= GATE.motionOpacity &&
    timingOk;
  const result = {
    ...base,
    pass,
    maxPx: round2(cmp.maxPx),
    maxOpacity: round3(cmp.maxOpacity),
    startDeltaMs,
    endDeltaMs,
    worst: cmp.worst,
    unpaired,
    nullMismatch,
  };
  if (loop) {
    result.shiftMs = Math.round(cmp.delta * step) || 0;
    if (cmp.excused > 0) result.excused = cmp.excused;
  }
  return result;
}

// True when two samples' boxes are within GATE.motionPx on x, y, w and h.
const boxNear = (a, b) => [0, 1, 2, 3].every((j) => Math.abs(a[j] - b[j]) <= GATE.motionPx);

// True when a track glides: no single jump explains it. Samples up to the jump stay within
// GATE.motionPx of the first sample, and samples after it within GATE.motionPx of the last one.
// Samples with no box are skipped. Opacity is ignored.
export function glides(track) {
  const boxes = track.filter(Boolean);
  if (boxes.length < 3) return false;
  const first = boxes[0];
  const last = boxes[boxes.length - 1];
  let i = 0;
  while (i < boxes.length && boxNear(boxes[i], first)) i++;
  return boxes.slice(i).some((s) => !boxNear(s, last));
}

// Reduced-motion check: the clone must end where the original ends without gliding there.
// One instant jump is allowed (a library that sets the end state on its first frame), and opacity
// may change. Loop entries have no end state, so only the glide rule applies to them, and a
// stopped loop may leave copies outside the viewport: they fail only when no mover pairs at all,
// and every clone element with a mover's key must hold still. Scrub entries are not checked:
// sticky and scroll-linked layout move with the scroll even with no animation.
// ignoreKeys: element keys to leave out, as in gradeMotion.
export function gradeReduced(origEntry, reducedEntry, width, { ignoreKeys = null } = {}) {
  const base = { id: origEntry.id, width };
  if (origEntry.missing) return { ...base, pass: true, failed: [], note: 'motion entry missing in the original, not checked' };
  if (origEntry.kind === 'scrub') return { ...base, pass: true, failed: [], note: 'scrub entries are not checked under reduced motion' };
  if (!reducedEntry || reducedEntry.missing) {
    return { ...base, pass: false, failed: [{ key: null, reason: 'missing-trace' }] };
  }

  const n = Math.min(sampleCount(origEntry), sampleCount(reducedEntry));
  const movers = origEntry.elements.filter((e) => !ignoreKeys?.has(e.key) && traceMoves(e.track, n));
  const pairing = pairNearest(movers, reducedEntry.elements, {
    keyOf: (e) => e.key,
    boxOf: (e) => lastBox(e.track, n),
  });

  if (origEntry.kind === 'loop') {
    const failed = [];
    if (movers.length && !pairing.pairs.length) failed.push({ key: movers[0].key, reason: 'missing' });
    const moverKeys = new Set(movers.map((e) => e.key));
    const glided = new Set();
    for (const el of reducedEntry.elements) {
      if (!moverKeys.has(el.key) || glided.has(el.key) || !glides(el.track.slice(0, n))) continue;
      glided.add(el.key);
      failed.push({ key: el.key, reason: 'moved' });
    }
    return { ...base, pass: failed.length === 0, failed };
  }

  const failed = pairing.unpairedA.map((i) => ({ key: movers[i].key, reason: 'missing' }));
  for (const [ia, ib] of pairing.pairs) {
    const orig = movers[ia];
    const clone = reducedEntry.elements[ib];
    if (glides(clone.track.slice(0, n))) {
      failed.push({ key: orig.key, reason: 'moved' });
      continue;
    }
    if (origEntry.kind === 'loop') continue;
    const endClone = lastSample(clone.track, n);
    const endOrig = lastSample(orig.track, n);
    const endOk =
      endClone &&
      endOrig &&
      boxNear(endClone, endOrig) &&
      Math.abs(endClone[4] - endOrig[4]) <= GATE.motionOpacity;
    if (!endOk) failed.push({ key: orig.key, reason: 'end-state' });
  }
  return { ...base, pass: failed.length === 0, failed };
}

// Plateau rule: the last GATE.plateauRounds rounds are each flat against the round before them.
// rounds: [{ round, sections: Map(id -> { score, failCount }) }] in ascending order, current round last.
export function isPlateau(rounds, id, plateauRounds = GATE.plateauRounds) {
  const need = plateauRounds + 1;
  if (rounds.length < need) return false;
  const recent = rounds.slice(-need);
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1];
    const cur = recent[i];
    if (cur.round !== prev.round + 1) return false;
    const p = prev.sections.get(id);
    const c = cur.sections.get(id);
    if (!p || !c || p.score === null || c.score === null) return false;
    const flat = c.score - p.score < GATE.plateauPoints && c.failCount >= p.failCount;
    if (!flat) return false;
  }
  return true;
}

function failCountOf(sec) {
  let n = 0;
  for (const r of Object.values(sec.widths)) {
    if (r.missing) {
      n++;
      continue;
    }
    if (!r.size.pass) n++;
    if (!r.masks.pass) n++;
    if (!r.pixel.skipped && !r.pixel.pass) n++;
    if (!r.geometry.pass) n++;
  }
  n += sec.states.filter((s) => !s.pass).length;
  n += sec.geometryWidths.filter((g) => !g.pass).length;
  n += sec.motion.filter((m) => !m.pass).length;
  n += sec.reduced.filter((r) => !r.pass).length;
  return n;
}

function fallbackTypesOf(sec) {
  const types = new Set();
  for (const r of Object.values(sec.widths)) {
    if (r.missing) types.add('css-port');
    else if (!r.pass) {
      if (!r.size.pass || !r.masks.pass || (!r.pixel.skipped && !r.pixel.pass) || !r.geometry.pass) types.add('css-port');
    }
  }
  if (sec.states.some((s) => !s.pass) || sec.geometryWidths.some((g) => !g.pass)) types.add('css-port');
  if (sec.motion.some((m) => !m.pass) || sec.reduced.some((r) => !r.pass)) types.add('motion-trace');
  return ['css-port', 'motion-trace'].filter((t) => types.has(t));
}

// Build the grade object from two loaded captures. Pure apart from reading and writing PNGs.
export function gradeCaptures({ original, clone, reduced = null, origDir, cloneDir, roundDir, round, priorRounds = [] }) {
  const diffDir = join(roundDir, 'diff');
  const ctx = { origDir, cloneDir, diffDir };
  const widths = widthKeys(original);
  const notes = [];
  const sections = new Map();
  const ensure = (id) => {
    if (!sections.has(id)) {
      sections.set(id, { id, widths: {}, scores: [], states: [], geometryWidths: [], motion: [], reduced: [] });
    }
    return sections.get(id);
  };

  for (const w of widths) {
    const cloneSecs = byId(clone.widths?.[w]?.sections);
    for (const o of original.widths[w].sections ?? []) {
      const sec = ensure(o.id);
      if (o.missing) {
        notes.push(`section ${o.id} missing in the original at ${w}px, width skipped`);
        continue;
      }
      const res = gradeSectionWidth(o, cloneSecs.get(o.id), { ...ctx, name: `${o.id}-${w}` });
      sec.widths[w] = res.result;
      sec.scores.push(res.score);
    }
  }

  for (const w of widths) {
    for (const st of gradeStates(original, clone, Number(w), ctx)) {
      if (st.note) notes.push(`state ${st.id} at ${w}px: ${st.note}`);
      const sec = sections.get(st.section);
      if (sec) sec.states.push(st);
    }
  }

  for (const w of Object.keys(original.geometry ?? {})) {
    const cloneGeo = byId(clone.geometry?.[w]?.sections);
    for (const o of original.geometry[w].sections ?? []) {
      const sec = sections.get(o.id);
      if (!sec || o.missing) continue;
      sec.geometryWidths.push(geometryWidthResult(o, cloneGeo.get(o.id), Number(w)));
    }
  }

  for (const w of widths) {
    const origMotion = original.widths[w].motion ?? [];
    const cloneMotion = clone.widths?.[w]?.motion ?? [];
    const reducedMotion = reduced?.widths?.[w]?.motion ?? [];
    const loopKeys = loopKeysBySection([origMotion, cloneMotion]);
    for (const oe of origMotion) {
      const sec = sections.get(oe.section);
      if (!sec) continue;
      if (oe.missing) notes.push(`motion ${oe.id} missing in the original at ${w}px, skipped`);
      const ignoreKeys = oe.kind === 'loop' ? null : (loopKeys.get(oe.section) ?? null);
      sec.motion.push(gradeMotion(oe, cloneMotion.find((m) => m.id === oe.id), Number(w), { ignoreKeys }));
      if (reduced) {
        sec.reduced.push(gradeReduced(oe, reducedMotion.find((m) => m.id === oe.id), Number(w), { ignoreKeys }));
      }
    }
  }

  // Clone sections, states and motion entries with no home in the original.
  const originalIds = new Set(sections.keys());
  const unassigned = [];
  const seen = new Set();
  const addUnassigned = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    unassigned.push({ type: 'section', id });
  };
  for (const w of widthKeys(clone)) {
    for (const s of clone.widths[w].sections ?? []) if (!originalIds.has(s.id)) addUnassigned(s.id);
    for (const s of clone.widths[w].states ?? []) if (!originalIds.has(s.section)) addUnassigned(s.section);
    for (const m of clone.widths[w].motion ?? []) if (!originalIds.has(m.section)) addUnassigned(m.section);
  }

  const out = [];
  for (const sec of sections.values()) {
    const failCount = failCountOf(sec);
    const scored = sec.scores.filter((s) => typeof s === 'number');
    const score = scored.length ? round2(scored.reduce((a, b) => a + b, 0) / scored.length) : null;
    const pass =
      Object.values(sec.widths).every((r) => r.pass) &&
      sec.states.every((s) => s.pass) &&
      sec.geometryWidths.every((g) => g.pass) &&
      sec.motion.every((m) => m.pass) &&
      sec.reduced.every((r) => r.pass);
    out.push({ ...sec, score, failCount, pass });
  }

  // Round history for the plateau check: this round plus every earlier one on disk.
  const currentRound = { round, sections: new Map(out.map((s) => [s.id, { score: s.score, failCount: s.failCount }])) };
  const rounds = [...priorRounds, currentRound].sort((a, b) => a.round - b.round);

  const finished = out.map((sec) => {
    const history = rounds
      .map((r) => r.sections.get(sec.id)?.score)
      .filter((s) => typeof s === 'number');
    let next = 'done';
    let fallbacks = [];
    if (!sec.pass) {
      const plateau = isPlateau(rounds, sec.id);
      if (round >= GATE.maxFixRounds || plateau) {
        next = 'fallback';
        fallbacks = fallbackTypesOf(sec);
      } else {
        next = 'fix';
      }
    }
    const { scores, ...rest } = sec;
    return { ...rest, next, fallbacks, history };
  });

  const passed = finished.filter((s) => s.pass).length;
  const scoredSections = finished.map((s) => s.score).filter((s) => typeof s === 'number');
  const score = scoredSections.length
    ? round2(scoredSections.reduce((a, b) => a + b, 0) / scoredSections.length)
    : null;
  return {
    version: 1,
    round,
    pass: finished.length > 0 && passed === finished.length,
    score,
    gate: { ...GATE },
    summary: {
      sections: finished.length,
      passed,
      failed: finished.length - passed,
      fix: finished.filter((s) => s.next === 'fix').map((s) => s.id),
      fallback: finished.filter((s) => s.next === 'fallback').map((s) => s.id),
      done: finished.filter((s) => s.next === 'done').map((s) => s.id),
    },
    sections: finished,
    unassigned,
    notes,
  };
}

// Round folders that already exist in the grade folder, ascending.
function existingRounds(outDir) {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir)
    .map((name) => /^round-(\d+)$/.exec(name))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

// Earlier rounds for the plateau check. A folder without grade.json (a crashed run) is skipped.
function priorRoundsFor(outDir, round) {
  return existingRounds(outDir)
    .filter((k) => k < round && existsSync(join(outDir, `round-${k}`, 'grade.json')))
    .map((k) => {
      const file = readJson(join(outDir, `round-${k}`, 'grade.json'));
      return { round: k, sections: new Map(file.sections.map((s) => [s.id, { score: s.score, failCount: s.failCount }])) };
    });
}

function isEntryPoint() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function run() {
  const { values } = parseArgs({
    options: {
      original: { type: 'string' },
      clone: { type: 'string' },
      reduced: { type: 'string' },
      out: { type: 'string', default: '.pixel-perfect/grade' },
      round: { type: 'string' },
    },
  });
  if (!values.original || !values.clone) throw new Error('--original and --clone are required');

  const existing = existingRounds(values.out);
  let round;
  if (values.round !== undefined) {
    round = Number(values.round);
    if (!Number.isInteger(round) || round < 0) throw new Error(`Bad --round value: ${values.round}`);
  } else {
    round = existing.length ? existing[existing.length - 1] + 1 : 0;
  }

  log(`grading round ${round}`);
  const original = readJson(join(values.original, 'capture.json'));
  const clone = readJson(join(values.clone, 'capture.json'));
  const reduced = values.reduced ? readJson(join(values.reduced, 'capture.json')) : null;
  const roundDir = join(values.out, `round-${round}`);
  const grade = gradeCaptures({
    original,
    clone,
    reduced,
    origDir: values.original,
    cloneDir: values.clone,
    roundDir,
    round,
    priorRounds: priorRoundsFor(values.out, round),
  });
  writeJson(join(roundDir, 'grade.json'), grade);

  done(
    {
      ok: true,
      round,
      pass: grade.pass,
      score: grade.score,
      passed: grade.summary.passed,
      failed: grade.summary.failed,
      grade: join(roundDir, 'grade.json'),
      fix: grade.summary.fix,
      fallback: grade.summary.fallback,
    },
    grade.pass ? 0 : 2,
  );
}

if (isEntryPoint()) main(run);
