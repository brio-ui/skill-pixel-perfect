// Tests for inspect.mjs. No browser: each test writes synthetic capture.json and grade.json files
// into a temp work folder and runs the CLI against it.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(here, '..');

// Run a script and return { code, json, stderr }. json is the last stdout line, parsed.
function runNode(script, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(scriptsDir, script), ...args], { cwd: scriptsDir, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      let json = null;
      try {
        json = JSON.parse(stdout.trim().split('\n').pop());
      } catch {
        json = null;
      }
      resolve({ code: error ? error.code : 0, json, stderr });
    });
  });
}

const capture = {
  version: 1,
  mode: 'original',
  widths: {
    1440: {
      viewport: { width: 1440, height: 900 },
      page: { height: 2000 },
      sections: [
        {
          id: 'hero',
          box: { x: 0, y: 900, w: 1440, h: 600 },
          png: 'hero-1440.png',
          masks: [{ box: { x: 0, y: 100, w: 1440, h: 40 }, reason: 'ticker' }],
          elements: [
            { key: 'h1', kind: 'text', tag: 'h1', box: { x: 40, y: 40, w: 600, h: 100 }, style: { fontSize: '56px', lineHeight: '60px', fontWeight: '700', color: 'rgb(0, 0, 0)' } },
            { key: 'p', kind: 'text', tag: 'p', box: { x: 40, y: 200, w: 500, h: 60 }, style: { fontSize: '18px', lineHeight: '28px', fontWeight: '400', color: 'rgb(70, 70, 70)' } },
          ],
        },
        { id: 'footer', missing: true },
      ],
      states: [],
      motion: [],
    },
    390: {
      viewport: { width: 390, height: 844 },
      page: { height: 3000 },
      sections: [{ id: 'hero', box: { x: 0, y: 600, w: 390, h: 700 }, png: 'hero-390.png', masks: [], elements: [] }],
      states: [],
      motion: [],
    },
  },
  geometry: {},
};

const failingGrade = (round) => ({
  version: 1,
  round,
  pass: false,
  score: 90,
  gate: {},
  summary: { sections: 1, passed: 0, failed: 1, fix: ['hero'], fallback: [], done: [] },
  sections: [
    {
      id: 'hero',
      pass: false,
      score: 90,
      failCount: 3,
      next: 'pixels',
      fallbacks: [],
      history: [],
      widths: {
        1440: {
          pass: false,
          size: { pass: true, original: { w: 1440, h: 820 }, clone: { w: 1440, h: 820 } },
          masks: { pct: 0, pass: true, sources: [] },
          pixel: { pass: false, diffPct: 2.69, diffPng: 'diff-1440.png', regions: [{ box: { x: 0, y: 0, w: 100, h: 100 }, pixels: 500 }] },
          geometry: { pass: true, checked: 2, failed: [], missing: [], extra: [] },
          hints: ['check h1 size'],
        },
        390: {
          pass: false,
          size: { pass: true, original: { w: 390, h: 700 }, clone: { w: 390, h: 700 } },
          masks: { pct: 18.2, pass: false, sources: ['ticker'], reason: 'mask-cap' },
          pixel: { pass: true, diffPct: 0, diffPng: 'diff-390.png' },
          geometry: {
            pass: false,
            checked: 2,
            failed: [{ key: 'h1', original: { x: 40, y: 40, w: 300, h: 50 }, clone: { x: 40, y: 40, w: 300, h: 59 }, delta: { x: 0, y: 0, w: 0, h: 9 } }],
            missing: [{ key: 'img' }],
            extra: [{ key: 'x' }],
          },
          hints: [],
        },
      },
      states: [{ id: 'nav-open', width: 390, section: 'hero', pass: false, diffPct: 2.1, geometryFailed: 0 }],
      geometryWidths: [],
      motion: [],
      reduced: [],
    },
  ],
  unassigned: [{ kind: 'layer', key: 'badge' }],
  notes: [],
});

describe('inspect.mjs', () => {
  let work;

  before(() => {
    work = mkdtempSync(join(tmpdir(), 'pp-inspect-'));
    mkdirSync(join(work, 'original'), { recursive: true });
    writeFileSync(join(work, 'original', 'capture.json'), JSON.stringify(capture));
    for (const round of [0, 1, 2]) {
      mkdirSync(join(work, 'grade', `round-${round}`), { recursive: true });
      writeFileSync(join(work, 'grade', `round-${round}`, 'grade.json'), JSON.stringify(failingGrade(round)));
    }
  });

  after(() => {
    rmSync(work, { recursive: true, force: true });
  });

  test('overview lists each section box per width, missing where absent', async () => {
    const res = await runNode('inspect.mjs', ['--work', work]);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.ok, true);
    assert.deepEqual(res.json.widths, [390, 1440]);
    const hero = res.json.sections.find((s) => s.id === 'hero');
    assert.deepEqual(hero.boxes, {
      1440: { x: 0, y: 900, w: 1440, h: 600 },
      390: { x: 0, y: 600, w: 390, h: 700 },
    });
    const footer = res.json.sections.find((s) => s.id === 'footer');
    assert.deepEqual(footer.boxes, { 1440: 'missing', 390: 'missing' });
  });

  test('--section dumps elements with the fixed columns and font as size/line-height', async () => {
    const res = await runNode('inspect.mjs', ['--work', work, '--section', 'hero']);
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(res.json.columns, ['key', 'tag', 'x', 'y', 'w', 'h', 'font', 'weight', 'color']);
    const w1440 = res.json.widths[1440];
    assert.deepEqual(w1440.box, { x: 0, y: 900, w: 1440, h: 600 });
    assert.deepEqual(w1440.masks, [{ box: { x: 0, y: 100, w: 1440, h: 40 }, reason: 'ticker' }]);
    assert.deepEqual(w1440.elements, [
      ['h1', 'h1', 40, 40, 600, 100, '56px/60px', '700', 'rgb(0, 0, 0)'],
      ['p', 'p', 40, 200, 500, 60, '18px/28px', '400', 'rgb(70, 70, 70)'],
    ]);
    assert.deepEqual(res.json.widths[390].elements, []);
  });

  test('--section for a section missing at a width reports missing there', async () => {
    const res = await runNode('inspect.mjs', ['--work', work, '--section', 'footer']);
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(res.json.widths[1440], { missing: true });
  });

  test('unknown --section exits 1 and lists the known ids', async () => {
    const res = await runNode('inspect.mjs', ['--work', work, '--section', 'nope']);
    assert.equal(res.code, 1);
    assert.equal(res.json.ok, false);
    assert.match(res.json.error, /Unknown section id: nope\. Known ids: hero, footer/);
  });

  test('--grade uses the highest round and digests each failing width', async () => {
    const res = await runNode('inspect.mjs', ['--work', work, '--grade']);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.round, 2);
    assert.equal(res.json.pass, false);
    assert.equal(res.json.score, 90);
    assert.deepEqual(res.json.unassigned, [{ kind: 'layer', key: 'badge' }]);

    const hero = res.json.sections[0];
    assert.equal(hero.id, 'hero');
    assert.equal(hero.next, 'pixels');
    assert.deepEqual(hero.states, [{ id: 'nav-open', width: 390, section: 'hero', pass: false, diffPct: 2.1, geometryFailed: 0 }]);
    assert.deepEqual(hero.widths.map((w) => w.width), [390, 1440]);

    const w1440 = hero.widths.find((w) => w.width === 1440);
    assert.equal(w1440.width, 1440);
    assert.equal(w1440.size, 'original 1440x820 against clone 1440x820');
    assert.equal(w1440.mask, undefined);
    assert.equal(w1440.geometry, undefined);
    assert.deepEqual(w1440.pixel, {
      diffPct: 2.69,
      regions: [{ box: { x: 0, y: 0, w: 100, h: 100 }, pixels: 500, keys: ['h1'] }],
    });
    assert.deepEqual(w1440.hints, ['check h1 size']);

    const w390 = hero.widths.find((w) => w.width === 390);
    assert.equal(w390.width, 390);
    assert.equal(w390.size, 'original 390x700 against clone 390x700');
    assert.deepEqual(w390.mask, { pct: 18.2, reason: 'mask-cap' });
    assert.deepEqual(w390.geometry, {
      failedCount: 1,
      failed: [{ key: 'h1', delta: { x: 0, y: 0, w: 0, h: 9 } }],
      missingCount: 1,
      missing: ['img'],
      extraCount: 1,
      extra: ['x'],
    });
  });

  test('--round picks that round', async () => {
    const res = await runNode('inspect.mjs', ['--work', work, '--grade', '--round', '1']);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.round, 1);
  });

  test('--grade --section returns just that section', async () => {
    const res = await runNode('inspect.mjs', ['--work', work, '--grade', '--section', 'hero']);
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(res.json.sections.map((s) => s.id), ['hero']);
  });

  test('missing round exits 1 and names the file and the step that creates it', async () => {
    const res = await runNode('inspect.mjs', ['--work', work, '--grade', '--round', '9']);
    assert.equal(res.code, 1);
    assert.match(res.json.error, /round-9[\\/]grade\.json/);
    assert.match(res.json.error, /round\.mjs or grade\.mjs/);
  });

  test('missing capture.json exits 1 and says to run capture.mjs', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'pp-inspect-empty-'));
    try {
      const res = await runNode('inspect.mjs', ['--work', empty]);
      assert.equal(res.code, 1);
      assert.match(res.json.error, /original[\\/]capture\.json/);
      assert.match(res.json.error, /capture\.mjs/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test('--grade with no grade folder exits 1', async () => {
    const noGrade = mkdtempSync(join(tmpdir(), 'pp-inspect-nograde-'));
    try {
      mkdirSync(join(noGrade, 'original'), { recursive: true });
      writeFileSync(join(noGrade, 'original', 'capture.json'), JSON.stringify(capture));
      const res = await runNode('inspect.mjs', ['--work', noGrade, '--grade']);
      assert.equal(res.code, 1);
      assert.match(res.json.error, /No round-<n> folder/);
    } finally {
      rmSync(noGrade, { recursive: true, force: true });
    }
  });
});
