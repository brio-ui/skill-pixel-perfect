// Turns one motion trace from the original capture into keyframes for the Motion library (TS or JSON).
import { realpathSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { GATE, done, ensureDir, log, main, readJson } from './lib/io.mjs';
import { firstChangeIndex, lastChangeIndex, loopPeriod, sampleAt, snapIndexes, traceMoves } from './lib/match.mjs';

// Drop-off tolerances for samples that a straight line predicts. Scale is a ratio, so it uses the opacity tolerance.
const LINE_PX = 0.25;
const LINE_OPACITY = 0.005;
// Loop jumps become instant steps: an extra point this many samples after the sample before the
// jump (1 ms at 50 ms steps).
const JUMP_AT = 0.02;
const EPS = 1e-9;

const quote = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function num(n, digits) {
  return Number(n.toFixed(digits));
}

// Find the entry at one width. Default is 1440 when it has the entry, otherwise the first width that does.
// An entry the capture could not trace has `missing: true` and no elements, so it is never picked.
export function pickMotion(capture, id, requestedWidth) {
  const widths = Object.keys(capture.widths ?? {});
  const find = (w) => (capture.widths[w]?.motion ?? []).find((m) => m.id === id);
  const traced = (w) => Boolean(find(w) && !find(w).missing);
  if (requestedWidth !== undefined && requestedWidth !== null) {
    const w = String(requestedWidth);
    const entry = find(w);
    if (!entry) throw new Error(`No motion entry ${id} at ${w}px`);
    if (entry.missing) throw new Error(`Motion entry ${id} at ${w}px was not traced. The capture notes say why.`);
    return { width: w, entry };
  }
  const first = widths.includes('1440') && traced('1440') ? '1440' : widths.find(traced);
  if (!first) {
    if (widths.some(find)) throw new Error(`Motion entry ${id} was not traced at any width. The capture notes say why.`);
    throw new Error(`No motion entry ${id} in any width`);
  }
  return { width: first, entry: find(first) };
}

const clampSample = (s) => [s[0], s[1], Math.max(0, s[2]), Math.max(0, s[3]), Math.min(1, Math.max(0, s[4]))];

// Value just after the jump at j (between samples j - 1 and j), JUMP_AT samples after sample j - 1,
// on the line through samples j and j + 1. Sample j itself when j + 1 is missing or jumps too.
function jumpValue(track, j, jumps, n) {
  const v = track[j];
  const next = j + 1 < n && !jumps.has(j + 1) ? track[j + 1] : null;
  if (!next) return [...v];
  return clampSample(v.map((x, i) => x - (next[i] - x) * (1 - JUMP_AT)));
}

// Value at the end of one cycle. When the loop wraps right there (a jump at the end), the value
// comes from the samples before the jump, carried on to the end.
function cycleEnd(track, end, jumps) {
  const f = Math.floor(end + EPS);
  const frac = end - f;
  const wraps = frac < EPS ? jumps.has(f) : jumps.has(f + 1);
  if (!wraps) return sampleAt(track, end);
  const a = frac < EPS ? f - 1 : f; // last sample before the jump
  const t = frac < EPS ? 1 : frac; // samples from a to the end
  const prev = a >= 1 && !jumps.has(a) ? track[a - 1] : null;
  if (!prev) return [...track[a]];
  return clampSample(track[a].map((x, i) => x + (x - prev[i]) * t));
}

// Points for one loop element: one cycle when the track repeats (loopPeriod), else the whole trace.
// Each jump inside it gets an extra point JUMP_AT samples after the sample before the jump.
function loopPoints(track, n) {
  const period = loopPeriod(track, n);
  const jumps = new Set(snapIndexes(track, n));
  const end = period ?? n - 1;
  const last = Math.floor(end + EPS);
  const points = [];
  for (let k = 0; k <= last; k++) points.push({ k, v: track[k] });
  if (period !== null) {
    const point = { k: end, v: cycleEnd(track, end, jumps) };
    if (end - last < EPS) points[points.length - 1] = point;
    else points.push(point);
  }
  for (const j of jumps) {
    if (j > last || (period !== null && j >= end - EPS)) continue;
    points.push({ k: j - 1 + JUMP_AT, v: jumpValue(track, j, jumps, n) });
  }
  points.sort((p, q) => p.k - q.k);
  return { points, end, period };
}

// Build the keyframe data for one motion entry. Pure: no file access.
// Loop elements cover one cycle (periodMs) when the trace shows the track repeating, else the whole
// trace with periodMs null. Their jumps, such as a marquee returning to its start, become instant steps.
export function buildKeyframes(entry) {
  const step = entry.stepMs ?? GATE.motionStepMs;
  const n = Number.isInteger(entry.samples)
    ? entry.samples
    : Math.max(0, ...entry.elements.map((el) => el.track.length));
  const loop = entry.kind === 'loop';
  const whole = entry.kind === 'scrub';
  const elements = [];
  const skipped = [];
  let minS = Infinity;
  let maxE = -Infinity;

  for (const el of entry.elements) {
    const track = el.track.slice(0, n);
    if (track.some((s) => !s)) {
      skipped.push(el.key);
      continue;
    }
    if (!traceMoves(track, n)) continue;

    let s = 0;
    let e;
    let period = null;
    let points;
    if (loop) {
      ({ points, end: e, period } = loopPoints(track, n));
    } else {
      s = whole ? 0 : Math.max(0, firstChangeIndex(track, n) - 1);
      // A slow drift never changes enough between two samples, so it runs to the end of the trace.
      e = whole ? n - 1 : Math.max(lastChangeIndex(track, n) ?? n - 1, s);
      points = [];
      for (let k = s; k <= e; k++) points.push({ k, v: track[k] });
    }
    const fin = points[points.length - 1].v;
    const finCx = fin[0] + fin[2] / 2;
    const finCy = fin[1] + fin[3] / 2;

    // Values relative to the final box, measured at the centre.
    const samples = [];
    for (const { k, v: t } of points) {
      samples.push({
        k,
        x: t[0] + t[2] / 2 - finCx,
        y: t[1] + t[3] / 2 - finCy,
        sx: fin[2] ? t[2] / fin[2] : null,
        sy: fin[3] ? t[3] / fin[3] : null,
        op: t[4],
      });
    }

    // Keep a sample only when the line between its kept neighbour and the next sample misses it.
    const kept = [0];
    for (let i = 1; i < samples.length - 1; i++) {
      const prev = samples[kept[kept.length - 1]];
      const cur = samples[i];
      const next = samples[i + 1];
      const f = (cur.k - prev.k) / (next.k - prev.k);
      const lerp = (a, b) => a + (b - a) * f;
      const predicted =
        Math.abs(lerp(prev.x, next.x) - cur.x) <= LINE_PX &&
        Math.abs(lerp(prev.y, next.y) - cur.y) <= LINE_PX &&
        (cur.sx === null || Math.abs(lerp(prev.sx, next.sx) - cur.sx) <= LINE_OPACITY) &&
        (cur.sy === null || Math.abs(lerp(prev.sy, next.sy) - cur.sy) <= LINE_OPACITY) &&
        Math.abs(lerp(prev.op, next.op) - cur.op) <= LINE_OPACITY;
      if (!predicted) kept.push(i);
    }
    kept.push(samples.length - 1);
    const ks = kept.map((i) => samples[i]);
    const span = e - s;

    const props = {};
    const pick = (name, values, digits) => {
      const rounded = values.map((v) => num(v, digits));
      if (new Set(rounded).size > 1) props[name] = rounded;
    };
    pick('x', ks.map((p) => p.x), 2);
    pick('y', ks.map((p) => p.y), 2);
    if (fin[2]) pick('scaleX', ks.map((p) => p.sx), 4);
    if (fin[3]) pick('scaleY', ks.map((p) => p.sy), 4);
    pick('opacity', ks.map((p) => p.op), 3);

    const item = { key: el.key };
    if (entry.kind !== 'scrub') {
      item.delay = num((s * step) / 1000, 3);
      item.duration = num((span * step) / 1000, 3);
    }
    if (loop) item.periodMs = period === null ? null : Math.round(period * step);
    item.times = ks.map((p) => num((p.k - s) / span, 4));
    Object.assign(item, props);
    elements.push(item);

    minS = Math.min(minS, s);
    maxE = Math.max(maxE, e);
  }

  const durationMs = elements.length ? Math.round((maxE - minS) * step) : 0;
  const scrollY = entry.kind === 'scrub' && entry.scrollY?.length
    ? [num(entry.scrollY[0], 2), num(entry.scrollY[entry.scrollY.length - 1], 2)]
    : null;
  return { elements, skipped, durationMs, step, scrollY };
}

function tsValue(v) {
  if (typeof v === 'string') return quote(v);
  if (Array.isArray(v)) return `[${v.map(tsValue).join(', ')}]`;
  if (v === Infinity) return 'Infinity';
  return String(v);
}

function tsElement(item) {
  const parts = [`key: ${quote(item.key)}`];
  if ('delay' in item) parts.push(`delay: ${item.delay}`, `duration: ${item.duration}`);
  if ('periodMs' in item) parts.push(`periodMs: ${item.periodMs}`);
  if (typeof item.periodMs === 'number') parts.push('repeat: Infinity');
  parts.push(`times: ${tsValue(item.times)}`);
  for (const prop of ['x', 'y', 'scaleX', 'scaleY', 'opacity']) {
    if (prop in item) parts.push(`${prop}: ${tsValue(item[prop])}`);
  }
  return `    { ${parts.join(', ')} },`;
}

// Write the TS module or the JSON file. Returns the text written.
export function renderKeyframes(built, { id, kind, width, format }) {
  if (format === 'json') {
    const data = {
      id,
      kind,
      width: Number(width),
      stepMs: built.step,
      ...(built.scrollY ? { scrollY: built.scrollY } : {}),
      // The JSON format has no repeat field. Loop elements with a periodMs repeat; periodMs null
      // means the trace never showed a full cycle.
      elements: built.elements,
    };
    return `${JSON.stringify(data, null, 2)}\n`;
  }
  const lines = [
    `// Generated by pixel-perfect keyframes.mjs from the original's motion trace (${id}, ${width} px).`,
    'export type MotionTraceElement = {',
    '  key: string;',
    '  delay?: number;',
    '  duration?: number;',
    '  periodMs?: number | null;',
    '  repeat?: number;',
    '  times: number[];',
    '  x?: number[];',
    '  y?: number[];',
    '  scaleX?: number[];',
    '  scaleY?: number[];',
    '  opacity?: number[];',
    '};',
    'export type MotionTrace = {',
    "  id: string;",
    "  kind: 'load' | 'scroll' | 'hover' | 'click' | 'loop' | 'scrub';",
    '  width: number;',
    '  stepMs: number;',
    '  scrollY?: number[];',
    '  elements: MotionTraceElement[];',
    '};',
    'export const trace: MotionTrace = {',
    `  id: ${quote(id)},`,
    `  kind: ${quote(kind)},`,
    `  width: ${Number(width)},`,
    `  stepMs: ${built.step},`,
  ];
  if (built.scrollY) lines.push(`  scrollY: ${tsValue(built.scrollY)},`);
  lines.push('  elements: [');
  for (const item of built.elements) lines.push(tsElement(item));
  lines.push('  ],', '};', 'export default trace;', '');
  return lines.join('\n');
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
      capture: { type: 'string' },
      motion: { type: 'string' },
      width: { type: 'string' },
      out: { type: 'string' },
      format: { type: 'string' },
    },
  });
  if (!values.capture || !values.motion || !values.out) {
    throw new Error('--capture, --motion and --out are required');
  }
  const format = values.format ?? (values.out.endsWith('.json') ? 'json' : 'ts');
  if (format !== 'ts' && format !== 'json') throw new Error(`Bad --format value: ${format}`);
  const requested = values.width === undefined ? undefined : Number(values.width);
  if (requested !== undefined && !Number.isInteger(requested)) throw new Error(`Bad --width value: ${values.width}`);

  log(`reading motion ${values.motion}`);
  const capture = readJson(`${values.capture}/capture.json`);
  const { width, entry } = pickMotion(capture, values.motion, requested);
  const built = buildKeyframes(entry);
  ensureDir(dirname(values.out));
  writeFileSync(values.out, renderKeyframes(built, { id: entry.id, kind: entry.kind, width, format }));

  done({
    ok: true,
    out: values.out,
    elements: built.elements.length,
    durationMs: built.durationMs,
    skipped: built.skipped,
  });
}

if (isEntryPoint()) main(run);
