// Unit tests for the motion-trace helpers in lib/match.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jumpIndexes, loopPeriod, sampleAt, snapIndexes, touchesJump } from '../lib/match.mjs';

const wrap = (x, p) => ((x % p) + p) % p;
// A sawtooth: moves right `slope` px per sample and returns to its start every `period` samples.
const saw = ({ period = 40, slope = 5, length = 61 } = {}) =>
  Array.from({ length }, (_, k) => [wrap(k, period) * slope, 0, 100, 20, 1]);

test('snapIndexes finds the sample where a sawtooth returns to its start', () => {
  assert.deepEqual(snapIndexes(saw(), 61), [40]);
});

test('snapIndexes finds an opacity jump and ignores steady motion', () => {
  const fade = Array.from({ length: 20 }, (_, k) => [k * 2, 0, 100, 20, k < 10 ? 1 : 0]);
  assert.deepEqual(snapIndexes(fade, 20), [10]);
  const glide = Array.from({ length: 20 }, (_, k) => [k * 6, 0, 100, 20, 1]);
  assert.deepEqual(snapIndexes(glide, 20), []);
});

test('jumpIndexes adds the samples where the element disappears or comes back', () => {
  const track = saw().map((s, k) => (k >= 20 && k <= 29 ? null : s));
  assert.deepEqual(snapIndexes(track, 61), [40]);
  assert.deepEqual(jumpIndexes(track, 61), [20, 30, 40]);
});

test('touchesJump checks the samples a position reads', () => {
  const jumps = new Set([3]); // between samples 2 and 3
  assert.equal(touchesJump(1, jumps), false);
  assert.equal(touchesJump(2, jumps), true);
  assert.equal(touchesJump(3, jumps), true);
  assert.equal(touchesJump(4, jumps), false);
  assert.equal(touchesJump(0.5, jumps), false);
  assert.equal(touchesJump(1.5, jumps), true);
  assert.equal(touchesJump(3.5, jumps), true);
  assert.equal(touchesJump(2, new Set()), false);
});

test('sampleAt interpolates between neighbours and returns null next to a missing box', () => {
  const track = [[0, 0, 10, 10, 0], [10, 20, 10, 10, 1], null];
  assert.deepEqual(sampleAt(track, 0.5), [5, 10, 10, 10, 0.5]);
  assert.deepEqual(sampleAt(track, 1), [10, 20, 10, 10, 1]);
  assert.equal(sampleAt(track, 1.5), null);
});

test('loopPeriod finds whole-sample periods of position and opacity loops', () => {
  assert.equal(loopPeriod(saw(), 61), 40);
  const pulse = Array.from({ length: 61 }, (_, k) => [0, 0, 100, 20, 0.5 + 0.5 * Math.sin((2 * Math.PI * k) / 20)]);
  assert.equal(loopPeriod(pulse, 61), 20);
});

test('loopPeriod refines a period that falls between samples', () => {
  assert.equal(loopPeriod(saw({ period: 37.5, slope: 2 }), 61), 37.5);
});

test('loopPeriod returns null for motion that never repeats, a missing box or a tiny loop', () => {
  const drift = Array.from({ length: 61 }, (_, k) => [3 * k, 0, 100, 20, 1]);
  assert.equal(loopPeriod(drift, 61), null);
  const gap = saw().map((s, k) => (k === 10 ? null : s));
  assert.equal(loopPeriod(gap, 61), null);
  const tiny = Array.from({ length: 61 }, (_, k) => [Math.sin((2 * Math.PI * k) / 20), 0, 100, 20, 1]);
  assert.equal(loopPeriod(tiny, 61), null);
});
