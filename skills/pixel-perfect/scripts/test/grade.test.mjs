// Synthetic-capture tests for grade.mjs. Every fixture is written to a temp folder.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { PNG, writePng } from '../lib/png.mjs';
import { diffRegions, gradeCaptures, gradeMotion, gradeReduced, geometryCheck, isPlateau, loopKeysBySection } from '../grade.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const GRADE_CLI = join(here, '..', 'grade.mjs');
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

function solid(w, h, [r, g, b]) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = 255;
  }
  return png;
}

function section(overrides = {}) {
  return {
    id: 'hero',
    box: { x: 0, y: 80, w: 200, h: 100 },
    png: '1440/sections/hero.png',
    fallback: [],
    masks: [],
    elements: [{ key: 't:hello', kind: 'text', tag: 'h1', box: { x: 10, y: 10, w: 80, h: 20 }, style: { fontSize: '24px' } }],
    ...overrides,
  };
}

function capture({ sections = [section()], states = [] } = {}) {
  return {
    version: 1,
    mode: 'original',
    url: 'https://example.com/',
    widths: {
      1440: {
        viewport: { width: 400, height: 300 },
        page: { png: '1440/page.png', w: 1440, h: 900 },
        sections,
        states,
        motion: [],
      },
    },
    geometry: {},
  };
}

// Write capture.json and a PNG for every section and state. Colour sets the pixels.
function writeCapture(dir, cap, colour) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'capture.json'), JSON.stringify(cap));
  for (const w of Object.values(cap.widths)) {
    for (const s of w.sections) {
      if (s.missing) continue;
      writePng(join(dir, s.png), solid(s.box.w, s.box.h, colour));
    }
    for (const st of w.states) {
      if (st.missing) continue;
      for (const p of [st.png, st.basePng]) {
        if (p) writePng(join(dir, p), solid(w.viewport.width, w.viewport.height, colour));
      }
    }
  }
}

// Build an original and a clone on disk. The temp folder is removed when the test ends.
function makeWorld(t, original, clone, { cloneColour = WHITE } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pp-grade-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const world = { root, origDir: join(root, 'original'), cloneDir: join(root, 'clone'), gradeDir: join(root, 'grade'), original, clone };
  writeCapture(world.origDir, original, WHITE);
  writeCapture(world.cloneDir, clone, cloneColour);
  return world;
}

function gradeOf(world, { round = 0, priorRounds = [], reduced = null } = {}) {
  return gradeCaptures({
    original: world.original,
    clone: world.clone,
    reduced,
    origDir: world.origDir,
    cloneDir: world.cloneDir,
    roundDir: join(world.gradeDir, `round-${round}`),
    round,
    priorRounds,
  });
}

const widthOf = (grade, sectionId, width = '1440') => grade.sections.find((s) => s.id === sectionId).widths[width];

// Motion fixtures: 31 samples. Hold, move up 10 px per sample, then rest at y 640.
const N = 31;
function moverTrack() {
  const track = [];
  for (let k = 0; k < N; k++) {
    if (k < 3) track.push([120, 700, 300, 32, 0]);
    else if (k <= 8) track.push([120, 700 - (k - 2) * 10, 300, 32, Math.min(1, 0.2 * (k - 2))]);
    else track.push([120, 640, 300, 32, 1]);
  }
  return track;
}
// Same start, but still moving until sample 14: the end comes 6 samples (300 ms) late.
function lateEndTrack() {
  const track = [];
  for (let k = 0; k < N; k++) {
    if (k < 3) track.push([120, 700, 300, 32, 0]);
    else if (k <= 14) track.push([120, 700 - (k - 2) * 10, 300, 32, Math.min(1, 0.2 * (k - 2))]);
    else track.push([120, 580, 300, 32, 1]);
  }
  return track;
}
const stillTrack = (y = 640) => Array.from({ length: N }, () => [120, y, 300, 32, 1]);
const motionEntry = (elements, extra = {}) => ({ id: 'scroll:features', kind: 'scroll', section: 'hero', stepMs: 50, samples: N, elements, ...extra });

test('identical captures pass with score 100', (t) => {
  const w = makeWorld(t, capture(), capture());
  const grade = gradeOf(w);
  assert.equal(grade.pass, true);
  assert.equal(grade.score, 100);
  assert.equal(grade.sections[0].score, 100);
  assert.equal(grade.sections[0].next, 'done');
});

test('8 px element shift fails geometry and passes pixels', (t) => {
  const clone = capture({ sections: [section({ elements: [{ key: 't:hello', kind: 'text', tag: 'h1', box: { x: 18, y: 10, w: 80, h: 20 }, style: {} }] })] });
  const w = makeWorld(t, capture(), clone);
  const r = widthOf(gradeOf(w), 'hero');
  assert.equal(r.geometry.pass, false);
  assert.equal(r.geometry.failed.length, 1);
  assert.equal(r.pixel.pass, true);
  assert.equal(gradeOf(w).pass, false);
});

test('section 4 px taller fails size and skips the pixel diff', (t) => {
  const clone = capture({ sections: [section({ box: { x: 0, y: 80, w: 200, h: 104 } })] });
  const w = makeWorld(t, capture(), clone);
  const r = widthOf(gradeOf(w), 'hero');
  assert.equal(r.size.pass, false);
  assert.equal(r.pixel.skipped, 'size');
  assert.equal(gradeOf(w).sections[0].score, 0);
});

test('masks over 15 percent of the section fail with mask-cap', (t) => {
  // 200 x 20 = 4000 px of 20000 px is 20 percent.
  const orig = capture({ sections: [section({ masks: [{ box: { x: 0, y: 0, w: 200, h: 20 }, reason: 'live' }] })] });
  const w = makeWorld(t, orig, capture());
  const r = widthOf(gradeOf(w), 'hero');
  assert.equal(r.masks.pass, false);
  assert.equal(r.masks.reason, 'mask-cap');
  assert.equal(r.masks.pct, 20);
});

test('masks under the cap pass', (t) => {
  // 200 x 5 = 1000 px is 5 percent.
  const orig = capture({ sections: [section({ masks: [{ box: { x: 0, y: 0, w: 200, h: 5 }, reason: 'live' }] })] });
  const w = makeWorld(t, orig, capture());
  assert.equal(widthOf(gradeOf(w), 'hero').masks.pass, true);
});

test('state with no change in the original passes with a note, even with no clone state', (t) => {
  const st = { id: 'nav-open', section: 'hero', width: 1440, png: '1440/states/nav.png', basePng: '1440/states/base.png', changed: null, scrollY: 0, masks: [], elements: [] };
  const w = makeWorld(t, capture({ states: [st] }), capture());
  const grade = gradeOf(w);
  const state = grade.sections[0].states[0];
  assert.equal(state.pass, true);
  assert.equal(state.note, 'no visible change in the original');
  assert.ok(grade.notes.some((n) => n.includes('no visible change')));
});

test('state missing in the clone fails', (t) => {
  const st = { id: 'menu-open', section: 'hero', png: '1440/states/menu.png', basePng: '1440/states/menu-base.png', changed: { x: 10, y: 10, w: 50, h: 20 }, scrollY: 0, masks: [], elements: [] };
  const w = makeWorld(t, capture({ states: [st] }), capture({ states: [] }));
  const state = gradeOf(w).sections[0].states[0];
  assert.equal(state.pass, false);
  assert.equal(state.missing, true);
});

test('identical motion traces pass with no timing drift', () => {
  const entry = motionEntry([{ key: 't:fast setup', kind: 'text', tag: 'h3', track: moverTrack() }]);
  const clone = motionEntry([{ key: 't:fast setup', kind: 'text', tag: 'h3', track: moverTrack() }]);
  const r = gradeMotion(entry, clone, 1440);
  assert.equal(r.pass, true);
  assert.equal(r.startDeltaMs, 0);
  assert.equal(r.endDeltaMs, 0);
});

test('end 300 ms late fails with endDeltaMs 300', () => {
  const entry = motionEntry([{ key: 't:fast setup', kind: 'text', tag: 'h3', track: moverTrack() }]);
  const clone = motionEntry([{ key: 't:fast setup', kind: 'text', tag: 'h3', track: lateEndTrack() }]);
  const r = gradeMotion(entry, clone, 1440);
  assert.equal(r.endDeltaMs, 300);
  assert.equal(r.pass, false);
});

test('unpaired moving element fails', () => {
  const entry = motionEntry([{ key: 't:fast setup', kind: 'text', tag: 'h3', track: moverTrack() }]);
  const clone = motionEntry([{ key: 't:other', kind: 'text', tag: 'h3', track: moverTrack() }]);
  const r = gradeMotion(entry, clone, 1440);
  assert.equal(r.pass, false);
  assert.ok(r.unpaired > 0);
});

test('no movers on either side passes with the note no motion', () => {
  const entry = motionEntry([{ key: 't:fast setup', kind: 'text', tag: 'h3', track: stillTrack() }]);
  const clone = motionEntry([{ key: 't:fast setup', kind: 'text', tag: 'h3', track: stillTrack() }]);
  const r = gradeMotion(entry, clone, 1440);
  assert.equal(r.pass, true);
  assert.equal(r.note, 'no motion');
});

test('reduced motion: a clone that still moves fails', () => {
  const entry = motionEntry([{ key: 't:fast setup', kind: 'text', tag: 'h3', track: moverTrack() }]);
  const moving = Array.from({ length: N }, (_, k) => [120, 700 - k * 5, 300, 32, 1]);
  const reduced = motionEntry([{ key: 't:fast setup', kind: 'text', tag: 'h3', track: moving }]);
  const r = gradeReduced(entry, reduced, 1440);
  assert.equal(r.pass, false);
  assert.equal(r.failed[0].reason, 'moved');
});

test('reduced motion: a clone that holds the right end state passes', () => {
  const entry = motionEntry([{ key: 't:fast setup', kind: 'text', tag: 'h3', track: moverTrack() }]);
  const reduced = motionEntry([{ key: 't:fast setup', kind: 'text', tag: 'h3', track: stillTrack() }]);
  assert.equal(gradeReduced(entry, reduced, 1440).pass, true);
});

test('reduced motion: one instant jump to the end state with an opacity fade passes', () => {
  const entry = motionEntry([{ key: 't:fast setup', kind: 'text', tag: 'h3', track: moverTrack() }]);
  const jump = Array.from({ length: N }, (_, k) => (k === 0 ? [120, 700, 300, 32, 0] : [120, 640, 300, 32, Math.min(1, k / 10)]));
  const reduced = motionEntry([{ key: 't:fast setup', kind: 'text', tag: 'h3', track: jump }]);
  assert.equal(gradeReduced(entry, reduced, 1440).pass, true);
});

test('reduced motion: a jump to the wrong end state fails with end-state', () => {
  const entry = motionEntry([{ key: 't:fast setup', kind: 'text', tag: 'h3', track: moverTrack() }]);
  const reduced = motionEntry([{ key: 't:fast setup', kind: 'text', tag: 'h3', track: stillTrack(700) }]);
  const r = gradeReduced(entry, reduced, 1440);
  assert.equal(r.pass, false);
  assert.equal(r.failed[0].reason, 'end-state');
});

test('reduced motion: loop entries check for gliding only', () => {
  const loop = { kind: 'loop', id: 'loop:logos' };
  const entry = motionEntry([{ key: 'm:img', kind: 'media', tag: 'img', track: moverTrack() }], loop);
  const stopped = motionEntry([{ key: 'm:img', kind: 'media', tag: 'img', track: stillTrack(900) }], loop);
  assert.equal(gradeReduced(entry, stopped, 1440).pass, true);
  const moving = Array.from({ length: N }, (_, k) => [120 + k * 4, 640, 300, 32, 1]);
  const gliding = motionEntry([{ key: 'm:img', kind: 'media', tag: 'img', track: moving }], loop);
  assert.equal(gradeReduced(entry, gliding, 1440).failed[0].reason, 'moved');
});

test('reduced motion: a stopped loop may leave copies outside the viewport', () => {
  const loop = { kind: 'loop', id: 'loop:logos' };
  const copy = (dx) => ({ key: 'm:img', kind: 'media', tag: 'img', track: moverTrack().map((s) => [s[0] + dx, ...s.slice(1)]) });
  const entry = motionEntry([copy(0), copy(400)], loop);
  const offscreen = Array.from({ length: N }, () => null);
  const still = { key: 'm:img', kind: 'media', tag: 'img', track: stillTrack(900) };
  const hidden = { key: 'm:img', kind: 'media', tag: 'img', track: offscreen };
  assert.equal(gradeReduced(entry, motionEntry([still, hidden], loop), 1440).pass, true);

  const none = gradeReduced(entry, motionEntry([hidden, { ...hidden }], loop), 1440);
  assert.equal(none.pass, false);
  assert.equal(none.failed[0].reason, 'missing');

  // A copy that glides fails even when it cannot pair.
  const moving = Array.from({ length: N }, (_, k) => [900 + k * 4, 640, 300, 32, 1]);
  const extra = { key: 'm:img', kind: 'media', tag: 'img', track: moving };
  const r = gradeReduced(entry, motionEntry([still, { ...still }, extra], loop), 1440);
  assert.equal(r.pass, false);
  assert.deepEqual(r.failed, [{ key: 'm:img', reason: 'moved' }]);
});

test('reduced motion: scrub entries pass with a note', () => {
  const entry = motionEntry([{ key: 'm:img', kind: 'media', tag: 'img', track: moverTrack() }], { kind: 'scrub', id: 'scrub:hero', stepMs: null });
  const r = gradeReduced(entry, null, 1440);
  assert.equal(r.pass, true);
  assert.equal(r.note, 'scrub entries are not checked under reduced motion');
});

test('motion results report a null mismatch', () => {
  const entry = motionEntry([{ key: 't:fast setup', kind: 'text', tag: 'h3', track: moverTrack() }]);
  const gap = moverTrack().map((s, k) => (k === 5 ? null : s));
  const clone = motionEntry([{ key: 't:fast setup', kind: 'text', tag: 'h3', track: gap }]);
  const r = gradeMotion(entry, clone, 1440);
  assert.equal(r.pass, false);
  assert.equal(r.nullMismatch, true);
});

// Loop fixtures: 61 samples of a sawtooth that moves right `slope` px per sample and returns to its
// start every `period` samples. shift moves the trace in time: positive shows each frame earlier.
const LOOP_N = 61;
const wrap = (x, p) => ((x % p) + p) % p;
const sawTrack = ({ shift = 0, slope = 5, period = 40, length = LOOP_N } = {}) =>
  Array.from({ length }, (_, k) => [wrap(k + shift, period) * slope, 0, 100, 20, 1]);
const loopEntry = (track, extra = {}) =>
  motionEntry([{ key: 'm:logo', kind: 'media', tag: 'img', track }], { id: 'loop:logos', kind: 'loop', samples: LOOP_N, ...extra });

test('loop: identical traces pass with shiftMs 0', () => {
  const r = gradeMotion(loopEntry(sawTrack()), loopEntry(sawTrack()), 1440);
  assert.equal(r.pass, true);
  assert.equal(r.shiftMs, 0);
  assert.equal(r.maxPx, 0);
});

test('loop: a clone 10 samples out of phase passes with shiftMs -500', () => {
  const r = gradeMotion(loopEntry(sawTrack()), loopEntry(sawTrack({ shift: 10 })), 1440);
  assert.equal(r.pass, true);
  assert.equal(r.shiftMs, -500);
  assert.equal(r.maxPx, 0);
  assert.equal(r.excused, 2); // the samples on either side of the wrap
});

test('loop: a 16 ms lag passes at the nearest quarter-sample shift', () => {
  // With no shift every sample is 3.2 px off. A quarter sample later leaves 0.7 px.
  const orig = loopEntry(sawTrack({ slope: 10 }));
  const clone = loopEntry(sawTrack({ slope: 10, shift: -0.32 }));
  const r = gradeMotion(orig, clone, 1440);
  assert.equal(r.pass, true);
  assert.equal(r.shiftMs, 13);
  assert.equal(r.maxPx, 0.7);
});

test('loop: a loop at another speed fails', () => {
  const r = gradeMotion(loopEntry(sawTrack()), loopEntry(sawTrack({ slope: 4, period: 50 })), 1440);
  assert.equal(r.pass, false);
  assert.ok(r.maxPx > 2);
});

test('loop: a one-sample glitch in the clone fails', () => {
  const glitch = sawTrack().map((s, k) => (k === 20 ? [s[0] + 50, ...s.slice(1)] : s));
  const r = gradeMotion(loopEntry(sawTrack()), loopEntry(glitch), 1440);
  assert.equal(r.pass, false);
  assert.ok(r.maxPx > 2);
});

test('phase-shifted loops fail when the entry is not a loop, with no shiftMs', () => {
  const scroll = { kind: 'scroll', id: 'scroll:logos' };
  const r = gradeMotion(loopEntry(sawTrack(), scroll), loopEntry(sawTrack({ shift: 10 }), scroll), 1440);
  assert.equal(r.pass, false);
  assert.equal('shiftMs' in r, false);
});

test('loop: a marquee item that leaves and comes back passes with a sub-sample lag', () => {
  // The original item has no box on samples 20-39. The clone runs 16 ms later and has none on 21-40.
  const item = (lag, from, to) =>
    Array.from({ length: LOOP_N }, (_, k) => (k >= from && k <= to ? null : [100 + 5 * (k - lag), 0, 100, 20, 1]));
  const r = gradeMotion(loopEntry(item(0, 20, 39)), loopEntry(item(0.32, 21, 40)), 1440);
  assert.equal(r.pass, true);
  assert.equal(r.nullMismatch, false);
  assert.equal(r.shiftMs, 13);
});

test('loopKeysBySection takes moving keys from the loop entries of every capture', () => {
  const origLoop = loopEntry(sawTrack());
  origLoop.elements.push({ key: 't:caption', kind: 'text', tag: 'p', track: Array.from({ length: LOOP_N }, () => [0, 0, 100, 20, 1]) });
  const cloneLoop = motionEntry([{ key: 'm:badge', kind: 'media', tag: 'img', track: sawTrack() }], { id: 'loop:logos', kind: 'loop', samples: LOOP_N });
  const reveal = motionEntry([{ key: 't:fast setup', kind: 'text', tag: 'h3', track: moverTrack() }]);
  const missing = { ...loopEntry(sawTrack()), section: 'footer', missing: true };
  const keys = loopKeysBySection([[origLoop, reveal, missing], [cloneLoop]]);
  assert.deepEqual([...keys.get('hero')].sort(), ['m:badge', 'm:logo']);
  assert.equal(keys.has('footer'), false);
});

test('ignoreKeys leaves a running loop out of reveal and reduced-motion grading', () => {
  const logo = (shift) => ({ key: 'm:logo', kind: 'media', tag: 'img', track: sawTrack({ shift, length: N }) });
  const reveal = (track = moverTrack()) => ({ key: 't:fast setup', kind: 'text', tag: 'h3', track });
  const orig = motionEntry([logo(0), reveal()]);
  const clone = motionEntry([logo(10), reveal()]);
  const ignoreKeys = loopKeysBySection([[loopEntry(sawTrack())]]).get('hero');
  assert.equal(gradeMotion(orig, clone, 1440).pass, false);
  assert.equal(gradeMotion(orig, clone, 1440, { ignoreKeys }).pass, true);
  const reduced = motionEntry([logo(0), reveal(stillTrack())]);
  assert.equal(gradeReduced(orig, reduced, 1440).pass, false);
  assert.equal(gradeReduced(orig, reduced, 1440, { ignoreKeys }).pass, true);
});

test('geometryCheck pairs by key and reports the missing original element', () => {
  const orig = [{ key: 't:a', box: { x: 0, y: 0, w: 10, h: 10 } }];
  const check = geometryCheck(orig, []);
  assert.equal(check.pass, false);
  assert.equal(check.missing.length, 1);
});

test('--round auto-increments from the highest round folder', (t) => {
  const w = makeWorld(t, capture(), capture());
  const run = () =>
    JSON.parse(
      execFileSync(process.execPath, [GRADE_CLI, '--original', w.origDir, '--clone', w.cloneDir, '--out', w.gradeDir], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim().split('\n').pop(),
    );
  assert.equal(run().round, 0);
  assert.equal(run().round, 1);
});

test('isPlateau: three flat rounds in a row', () => {
  const flat = (round) => ({ round, sections: new Map([['hero', { score: 0, failCount: 1 }]]) });
  assert.equal(isPlateau([flat(0), flat(1), flat(2)], 'hero'), true);
  assert.equal(isPlateau([flat(0), flat(1)], 'hero'), false);
});

test('plateau over three flat rounds gives fallback with its type', (t) => {
  const flat = (round) => ({ round, sections: new Map([['hero', { score: 0, failCount: 1 }]]) });
  const w = makeWorld(t, capture(), capture(), { cloneColour: BLACK });
  const grade = gradeOf(w, { round: 2, priorRounds: [flat(0), flat(1)] });
  assert.equal(grade.sections[0].next, 'fallback');
  assert.deepEqual(grade.sections[0].fallbacks, ['css-port']);
});

test('round 3 failing section gives fallback', (t) => {
  const w = makeWorld(t, capture(), capture(), { cloneColour: BLACK });
  const sec = gradeOf(w, { round: 3 }).sections[0];
  assert.equal(sec.next, 'fallback');
  assert.ok(sec.fallbacks.includes('css-port'));
});

test('round 1 failing section gives fix, not fallback', (t) => {
  const w = makeWorld(t, capture(), capture(), { cloneColour: BLACK });
  assert.equal(gradeOf(w, { round: 1 }).sections[0].next, 'fix');
});

// Diff image for diffRegions: background is black, then the listed [x, y, rgb] pixels are painted.
function diffImage(width, height, paints) {
  const png = new PNG({ width, height });
  for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
  for (const [x, y, [r, g, b]] of paints) {
    const i = (y * width + x) * 4;
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
  }
  return png;
}

// A solid square of red pixels, size x size, with its top-left corner at (x, y).
function redBlock(x, y, size) {
  const out = [];
  for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) out.push([x + dx, y + dy, [255, 0, 0]]);
  return out;
}

test('diffRegions: two separate blobs give two regions with their tile boxes', () => {
  const png = diffImage(256, 128, [...redBlock(0, 0, 4), ...redBlock(160, 64, 4)]);
  assert.deepEqual(diffRegions(png), [
    { box: { x: 0, y: 0, w: 32, h: 32 }, pixels: 16 },
    { box: { x: 160, y: 64, w: 32, h: 32 }, pixels: 16 },
  ]);
});

test('diffRegions: hot tiles that touch edge to edge merge', () => {
  const png = diffImage(128, 64, [...redBlock(10, 10, 4), ...redBlock(40, 10, 4)]);
  assert.deepEqual(diffRegions(png), [{ box: { x: 0, y: 0, w: 64, h: 32 }, pixels: 32 }]);
});

test('diffRegions: hot tiles that touch only at a corner merge, a gap keeps them apart', () => {
  // Tile (0,0) and tile (1,1) are hot and touch at a corner: one region.
  const corner = diffImage(128, 128, [...redBlock(0, 0, 10), ...redBlock(32, 32, 10)]);
  assert.deepEqual(diffRegions(corner), [{ box: { x: 0, y: 0, w: 64, h: 64 }, pixels: 200 }]);
  // Tile (0,0) and tile (2,2) leave a gap tile between them: two regions.
  const gap = diffImage(128, 128, [...redBlock(0, 0, 10), ...redBlock(64, 64, 10)]);
  assert.equal(diffRegions(gap).length, 2);
});

test('diffRegions: a tile with 9 red pixels is ignored, 10 counts', () => {
  const nine = diffImage(64, 32, redBlock(0, 0, 3).slice(0, 9));
  assert.deepEqual(diffRegions(nine), []);
  const ten = diffImage(64, 32, [...redBlock(0, 0, 3), [3, 0, [255, 0, 0]]]);
  assert.deepEqual(diffRegions(ten), [{ box: { x: 0, y: 0, w: 32, h: 32 }, pixels: 10 }]);
});

test('diffRegions: yellow anti-aliased pixels are ignored', () => {
  const yellow = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) yellow.push([x, y, [255, 255, 0]]);
  assert.deepEqual(diffRegions(diffImage(64, 64, yellow)), []);
});

test('diffRegions: seven blobs keep the five largest', () => {
  // Blob i has 10 + i red pixels in its own tile. Tiles sit two columns apart, so no two touch.
  const paints = [];
  for (let i = 0; i < 7; i++) {
    for (let k = 0; k < 10 + i; k++) paints.push([i * 64 + k, 0, [255, 0, 0]]);
  }
  const regions = diffRegions(diffImage(448, 32, paints));
  assert.deepEqual(
    regions.map((r) => r.pixels),
    [16, 15, 14, 13, 12],
  );
  assert.deepEqual(regions[0].box, { x: 384, y: 0, w: 32, h: 32 });
});

test('diffRegions: a box at the image edge is clipped to the image', () => {
  // 50x40 image: the last tile column and row are partial.
  const png = diffImage(50, 40, redBlock(40, 35, 5));
  assert.deepEqual(diffRegions(png), [{ box: { x: 32, y: 32, w: 18, h: 8 }, pixels: 25 }]);
});

test('a failing section width carries regions, a passing one does not', (t) => {
  const passing = makeWorld(t, capture(), capture());
  assert.equal('regions' in widthOf(gradeOf(passing), 'hero').pixel, false);

  const failing = makeWorld(t, capture(), capture(), { cloneColour: BLACK });
  const pixel = widthOf(gradeOf(failing), 'hero').pixel;
  assert.equal(pixel.pass, false);
  // The whole 200x100 section differs, so every tile is hot and one region covers it.
  assert.deepEqual(pixel.regions, [{ box: { x: 0, y: 0, w: 200, h: 100 }, pixels: 20000 }]);
});

test('a failing state records cropBox and regions in viewport coordinates', (t) => {
  const state = {
    id: 'nav',
    section: 'hero',
    png: '1440/states/nav.png',
    basePng: '1440/states/nav-base.png',
    changed: { x: 50, y: 40, w: 60, h: 30 },
    scrollY: 0,
    masks: [],
    elements: [],
  };
  const original = capture({ states: [state] });
  const clone = capture({ states: [state] });
  const w = makeWorld(t, original, clone, { cloneColour: BLACK });
  const st = gradeOf(w).sections[0].states[0];
  // changed grown by 16 px and clipped to the 400x300 viewport.
  assert.deepEqual(st.cropBox, { x: 34, y: 24, w: 92, h: 62 });
  assert.equal(st.pass, false);
  assert.deepEqual(st.regions, [{ box: { x: 0, y: 0, w: 92, h: 62 }, pixels: 92 * 62 }]);
});
