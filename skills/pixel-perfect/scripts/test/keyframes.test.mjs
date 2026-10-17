// Synthetic motion-trace tests for keyframes.mjs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildKeyframes, pickMotion, renderKeyframes } from '../keyframes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const KEYFRAMES_CLI = join(here, '..', 'keyframes.mjs');

// Six samples. The element holds, moves from sample 2 to 4, then rests.
// Final box centre is (270, 716). Values relative to that centre come out as y 24, 12, 6, 0.
const fadeTrack = [
  [120, 724, 300, 32, 0],
  [120, 724, 300, 32, 0],
  [120, 712, 300, 32, 0.5],
  [120, 706, 300, 32, 0.8],
  [120, 700, 300, 32, 1],
  [120, 700, 300, 32, 1],
];
const fadeEntry = (extra = {}) => ({
  id: 'scroll:features',
  kind: 'scroll',
  section: 'features',
  stepMs: 50,
  samples: 6,
  elements: [{ key: 't:fast setup', kind: 'text', tag: 'h3', track: fadeTrack }],
  ...extra,
});

test('fade-up values: delay, duration, times, y and opacity', () => {
  const built = buildKeyframes(fadeEntry());
  assert.equal(built.elements.length, 1);
  const el = built.elements[0];
  assert.equal(el.key, 't:fast setup');
  assert.equal(el.delay, 0.05);
  assert.equal(el.duration, 0.15);
  assert.deepEqual(el.times, [0, 0.3333, 0.6667, 1]);
  assert.deepEqual(el.y, [24, 12, 6, 0]);
  assert.deepEqual(el.opacity, [0, 0.5, 0.8, 1]);
  assert.equal('x' in el, false, 'x never changes, so it is left out');
  assert.equal('scaleX' in el, false, 'scale never changes, so it is left out');
  assert.equal(built.durationMs, 150);
});

// Loop traces: 61 samples (3 s). A sawtooth slides 5 px per sample and wraps every 40 samples (2 s).
const sawTrack = (phase = 0, length = 61) =>
  Array.from({ length }, (_, k) => [((k + phase) % 40) * 5, 0, 100, 20, 1]);
const loopEntry = (track, extra = {}) => ({
  id: 'loop:logos',
  kind: 'loop',
  section: 'logos',
  stepMs: 50,
  samples: track.length,
  elements: [{ key: 'i:logo', kind: 'image', tag: 'img', track }],
  ...extra,
});

test('a loop that repeats gives one cycle with periodMs, and repeat Infinity in TS only', () => {
  const built = buildKeyframes(loopEntry(sawTrack()));
  const el = built.elements[0];
  assert.equal(el.delay, 0);
  assert.equal(el.duration, 2);
  assert.equal(el.periodMs, 2000);
  // The wrap sits at the end of the cycle, so the cycle runs to 200 px (carried on from before
  // the jump) and repeat starts it again from 0.
  assert.deepEqual(el.x, [-200, 0]);
  assert.deepEqual(el.times, [0, 1]);
  assert.equal(built.durationMs, 2000);
  const ts = renderKeyframes(built, { id: 'loop:logos', kind: 'loop', width: 1440, format: 'ts' });
  assert.match(ts, /periodMs: 2000, repeat: Infinity/);
  const json = renderKeyframes(built, { id: 'loop:logos', kind: 'loop', width: 1440, format: 'json' });
  assert.equal(json.includes('repeat'), false);
  assert.equal(JSON.parse(json).elements[0].periodMs, 2000);
});

test('a jump inside the cycle becomes an instant step 1 ms after the sample before it', () => {
  const built = buildKeyframes(loopEntry(sawTrack(20)));
  const el = built.elements[0];
  assert.equal(el.periodMs, 2000);
  // Sample 19 is at 195 px and sample 20 back at 0. The extra point at 19.02 sits on the line
  // through samples 20 and 21, so the slide continues from there. Values are relative to the end (100 px).
  assert.deepEqual(el.times, [0, 0.475, 0.4755, 1]);
  assert.deepEqual(el.x, [0, 95, -104.9, 0]);
});

test('a loop with no full cycle in the trace keeps the whole trace and gets no repeat', () => {
  const slide = Array.from({ length: 61 }, (_, k) => [k * 3, 0, 100, 20, 1]);
  const built = buildKeyframes(loopEntry(slide));
  const el = built.elements[0];
  assert.equal(el.periodMs, null);
  assert.equal(el.delay, 0);
  assert.equal(el.duration, 3);
  assert.deepEqual(el.x, [-180, 0]);
  const ts = renderKeyframes(built, { id: 'loop:logos', kind: 'loop', width: 1440, format: 'ts' });
  assert.match(ts, /periodMs: null/);
  assert.equal(ts.includes('repeat: Infinity'), false);
});

test('jump steps are only added to loop entries', () => {
  const built = buildKeyframes(loopEntry(sawTrack(20), { kind: 'load' }));
  const el = built.elements[0];
  assert.equal('periodMs' in el, false);
  assert.equal(el.times.some((t) => Math.abs(t * 60 - 19.02) < 1e-3), false);
});

test('TS output carries the delay and duration in seconds', () => {
  const built = buildKeyframes(fadeEntry());
  const ts = renderKeyframes(built, { id: 'scroll:features', kind: 'scroll', width: 1440, format: 'ts' });
  assert.match(ts, /export const trace: MotionTrace = \{/);
  assert.match(ts, /delay: 0\.05, duration: 0\.15/);
  assert.match(ts, /export default trace;/);
});

test('scrub entries have no delay or duration, and scrollY gives the first and last positions', () => {
  const built = buildKeyframes(fadeEntry({ kind: 'scrub', scrollY: [0, 800, 1630] }));
  const el = built.elements[0];
  assert.equal('delay' in el, false);
  assert.equal('duration' in el, false);
  assert.equal(el.times[0], 0);
  assert.equal(el.times[el.times.length - 1], 1);
  assert.deepEqual(built.scrollY, [0, 1630]);
  const json = JSON.parse(renderKeyframes(built, { id: 'scroll:features', kind: 'scrub', width: 1440, format: 'json' }));
  assert.deepEqual(json.scrollY, [0, 1630]);
});

test('elements with a missing box are skipped and listed', () => {
  const holed = [
    [120, 724, 300, 32, 0],
    null,
    [120, 712, 300, 32, 0.5],
    [120, 706, 300, 32, 0.8],
    [120, 700, 300, 32, 1],
    [120, 700, 300, 32, 1],
  ];
  const entry = fadeEntry({
    elements: [
      { key: 't:fast setup', kind: 'text', tag: 'h3', track: fadeTrack },
      { key: 't:holed', kind: 'text', tag: 'p', track: holed },
    ],
  });
  const built = buildKeyframes(entry);
  assert.deepEqual(built.skipped, ['t:holed']);
  assert.deepEqual(built.elements.map((e) => e.key), ['t:fast setup']);
});

test('elements that never move are left out', () => {
  const still = Array.from({ length: 6 }, () => [0, 0, 100, 20, 1]);
  const built = buildKeyframes(fadeEntry({ elements: [{ key: 't:still', kind: 'text', tag: 'p', track: still }] }));
  assert.equal(built.elements.length, 0);
  assert.equal(built.durationMs, 0);
});

test('pickMotion prefers 1440 and errors when the entry is missing at the requested width', () => {
  const capture = {
    widths: {
      390: { motion: [{ id: 'scroll:features' }] },
      1440: { motion: [{ id: 'scroll:features' }] },
    },
  };
  assert.equal(pickMotion(capture, 'scroll:features').width, '1440');
  assert.equal(pickMotion(capture, 'scroll:features', 390).width, '390');
  assert.throws(() => pickMotion(capture, 'scroll:features', 768), /No motion entry scroll:features at 768px/);
  assert.throws(() => pickMotion(capture, 'nope'), /No motion entry nope in any width/);
});

test('pickMotion skips entries the capture could not trace', () => {
  const capture = {
    widths: {
      390: { motion: [{ id: 'scroll:features', elements: [] }] },
      1440: { motion: [{ id: 'scroll:features', missing: true }] },
    },
  };
  assert.equal(pickMotion(capture, 'scroll:features').width, '390');
  assert.throws(() => pickMotion(capture, 'scroll:features', 1440), /scroll:features at 1440px was not traced/);
  const none = { widths: { 1440: { motion: [{ id: 'scroll:features', missing: true }] } } };
  assert.throws(() => pickMotion(none, 'scroll:features'), /was not traced at any width/);
});

test('a slow drift with no big step between samples runs to the end of the trace', () => {
  const drift = Array.from({ length: 6 }, (_, k) => [120, 700 + k * 0.4, 300, 32, 1]);
  const built = buildKeyframes(fadeEntry({ elements: [{ key: 't:drift', kind: 'text', tag: 'p', track: drift }] }));
  assert.equal(built.elements.length, 1);
  assert.equal(built.durationMs, 200);
});

test('CLI writes the JSON file and prints one summary line', () => {
  const root = mkdtempSync(join(tmpdir(), 'pp-kf-'));
  try {
    const capDir = join(root, 'original');
    mkdirSync(capDir, { recursive: true });
    const capture = { widths: { 1440: { motion: [fadeEntry()] } } };
    writeFileSync(join(capDir, 'capture.json'), JSON.stringify(capture));
    const out = join(root, 'motion', 'scroll-features.json');
    const stdout = execFileSync(
      process.execPath,
      [KEYFRAMES_CLI, '--capture', capDir, '--motion', 'scroll:features', '--out', out],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const summary = JSON.parse(stdout.trim());
    assert.equal(summary.ok, true);
    assert.equal(summary.elements, 1);
    assert.equal(summary.durationMs, 150);
    const written = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(written.elements[0].delay, 0.05);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
