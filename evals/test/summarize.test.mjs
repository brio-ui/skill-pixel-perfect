// Launch-bar tests for evals/summarize.mjs. Each case builds a results folder in a temp dir.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { median, summarize } from '../summarize.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SUMMARIZE_CLI = join(here, '..', 'summarize.mjs');

// sites: [{ staticPass, motionPass, minutes, report: true|false }]
function makeResults(t, sites) {
  const root = mkdtempSync(join(tmpdir(), 'pp-eval-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  sites.forEach((s, i) => {
    const folder = join(root, `site-${String(i + 1).padStart(2, '0')}`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'run.json'), JSON.stringify({ site: `site-${i + 1}`, agent: 'claude-code', model: 'claude-opus-5-5', minutes: s.minutes, tokens: { input: 1, output: 1 } }));
    if (s.report !== false) {
      writeFileSync(join(folder, 'report.json'), JSON.stringify({ url: 'https://example.com/', pass: s.staticPass && s.motionPass, staticPass: s.staticPass, motionPass: s.motionPass }));
    }
  });
  return root;
}

function runSummarize(dir) {
  try {
    const stdout = execFileSync(process.execPath, [SUMMARIZE_CLI, dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out: JSON.parse(stdout.trim().split('\n').pop()) };
  } catch (err) {
    return { code: err.status, out: JSON.parse(err.stdout.trim().split('\n').pop()) };
  }
}

const site = (over = {}) => ({ staticPass: true, motionPass: true, minutes: 38.5, ...over });

test('median handles odd and even counts and empty input', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
});

test('launch bar met: exit 0, barMet true, summary files written', (t) => {
  const sites = [
    ...Array.from({ length: 11 }, () => site()),
    site({ staticPass: false, motionPass: true }),
  ];
  // 11 pass static (one of 12 fails), 12 pass motion, median 38.5 minutes.
  const dir = makeResults(t, sites);
  const r = runSummarize(dir);
  assert.equal(r.code, 0);
  assert.equal(r.out.barMet, true);
  assert.equal(r.out.pages, 12);
  assert.equal(r.out.staticPass, 11);
  assert.equal(r.out.motionPass, 12);
  assert.equal(r.out.medianMinutes, 38.5);
  assert.ok(existsSync(join(dir, 'summary.json')));
  assert.match(readFileSync(join(dir, 'summary.md'), 'utf8'), /Launch bar: met/);
});

test('launch bar not met: exit 2, barMet false', (t) => {
  // Only 9 pass static; the bar needs 10.
  const sites = [
    ...Array.from({ length: 9 }, () => site()),
    ...Array.from({ length: 3 }, () => site({ staticPass: false })),
  ];
  const dir = makeResults(t, sites);
  const r = runSummarize(dir);
  assert.equal(r.code, 2);
  assert.equal(r.out.barMet, false);
  assert.equal(r.out.staticPass, 9);
  assert.match(readFileSync(join(dir, 'summary.md'), 'utf8'), /Launch bar: not met/);
});

test('motion under 8 of 12 fails the bar even with static met', (t) => {
  const sites = [
    ...Array.from({ length: 10 }, () => site({ motionPass: false })),
    ...Array.from({ length: 2 }, () => site()),
  ];
  const r = runSummarize(makeResults(t, sites));
  assert.equal(r.code, 2);
  assert.equal(r.out.motionPass, 2);
});

test('slow median (45 minutes or more) fails the bar', (t) => {
  const r = runSummarize(makeResults(t, Array.from({ length: 12 }, () => site({ minutes: 45 }))));
  assert.equal(r.code, 2);
  assert.equal(r.out.barMet, false);
});

test('a site with no report counts as failing both gates', () => {
  const sites = [
    ...Array.from({ length: 11 }, (_, i) => ({ site: `s${i}`, run: { minutes: 38.5 }, report: { staticPass: true, motionPass: true } })),
    { site: 'missing', run: { minutes: 38.5 }, report: null },
  ];
  const summary = summarize(sites);
  assert.equal(summary.pages, 12);
  assert.equal(summary.staticPass, 11);
  assert.equal(summary.motionPass, 11);
  // The bar needs 10 of 12 static, so 11 still meets it. The missing site is not counted as a pass.
  assert.equal(summary.barMet, true);
  assert.ok(summary.notes.some((n) => n.includes('no report.json')));
});

test('page count other than 12 cannot meet the bar', () => {
  const sites = Array.from({ length: 11 }, (_, i) => ({ site: `s${i}`, run: { minutes: 10 }, report: { staticPass: true, motionPass: true } }));
  const summary = summarize(sites);
  assert.equal(summary.barMet, false);
  assert.ok(summary.notes.some((n) => n.includes('expected 12 pages')));
});
