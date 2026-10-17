// Report tests: grade synthetic captures, run report.mjs, check the files it writes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { PNG, writePng } from '../lib/png.mjs';
import { gradeCaptures } from '../grade.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPORT_CLI = join(here, '..', 'report.mjs');
const CUTOVER_LINE = 'Full-site migration from Brio is planned. Follow updates at brioui.com.';
const WHITE = [255, 255, 255];

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

const N = 31;
const moverTrack = () =>
  Array.from({ length: N }, (_, k) => {
    if (k < 3) return [120, 700, 300, 32, 0];
    if (k <= 8) return [120, 700 - (k - 2) * 10, 300, 32, Math.min(1, 0.2 * (k - 2))];
    return [120, 640, 300, 32, 1];
  });
const lateEndTrack = () =>
  Array.from({ length: N }, (_, k) => {
    if (k < 3) return [120, 700, 300, 32, 0];
    if (k <= 14) return [120, 700 - (k - 2) * 10, 300, 32, Math.min(1, 0.2 * (k - 2))];
    return [120, 580, 300, 32, 1];
  });

function capture({ shiftX = 10, motionTrack = null, motionKey = 't:fast setup' } = {}) {
  const sectionEls = [
    { key: 't:hello', kind: 'text', tag: 'h1', box: { x: 10, y: 10, w: 80, h: 20 }, style: {} },
    { key: 't:<b>bold</b>', kind: 'text', tag: 'p', box: { x: shiftX, y: 50, w: 120, h: 20 }, style: {} },
  ];
  const motion = motionTrack
    ? [
        {
          id: 'scroll:features',
          kind: 'scroll',
          section: 'hero',
          stepMs: 50,
          samples: N,
          scrollY: [1630],
          frames: {},
          elements: [{ key: motionKey, kind: 'text', tag: 'h3', track: motionTrack }],
        },
      ]
    : [];
  return {
    version: 1,
    mode: 'original',
    url: 'https://example.com/',
    widths: {
      1440: {
        viewport: { width: 400, height: 300 },
        page: { png: '1440/page.png', w: 1440, h: 900 },
        sections: [{ id: 'hero', box: { x: 0, y: 80, w: 200, h: 100 }, png: '1440/sections/hero.png', fallback: [], masks: [], elements: sectionEls }],
        states: [],
        motion,
      },
    },
    geometry: {},
  };
}

function writeCapture(dir, cap) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'capture.json'), JSON.stringify(cap));
  for (const w of Object.values(cap.widths)) {
    for (const s of w.sections) writePng(join(dir, s.png), solid(s.box.w, s.box.h, WHITE));
  }
}

// Grade the two captures into <root>/grade/round-0, then run report.mjs on them.
function buildReport(t, { original, clone, crashedRound = false }) {
  const root = mkdtempSync(join(tmpdir(), 'pp-report-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origDir = join(root, 'original');
  const cloneDir = join(root, 'clone');
  const gradeDir = join(root, 'grade');
  const out = join(root, 'pixel-perfect-report');
  writeCapture(origDir, original);
  writeCapture(cloneDir, clone);

  const roundDir = join(gradeDir, 'round-0');
  const grade = gradeCaptures({ original, clone, reduced: null, origDir, cloneDir, roundDir, round: 0, priorRounds: [] });
  mkdirSync(roundDir, { recursive: true });
  writeFileSync(join(roundDir, 'grade.json'), JSON.stringify(grade, null, 2));
  // A later round folder with no grade.json, as a crashed grade run leaves it.
  if (crashedRound) mkdirSync(join(gradeDir, 'round-1'), { recursive: true });

  // Assets: one flagged font kit and one third-party script. Cutover file absent, so status is pending.
  const assetsPath = join(root, 'assets.json');
  writeFileSync(
    assetsPath,
    JSON.stringify({
      version: 1,
      url: 'https://example.com/',
      assets: [
        { url: 'https://use.typekit.net/abc.css', kind: 'font', status: 'remote', flag: true, license: { class: 'adobe-kit', flag: true, note: 'Add the new domain to the kit.' } },
      ],
      scripts: [{ host: 'www.googletagmanager.com', category: 'analytics', urls: ['https://www.googletagmanager.com/gtm.js'] }],
      notes: [],
    }),
  );

  const stdout = execFileSync(
    process.execPath,
    [REPORT_CLI, '--grade', gradeDir, '--original', origDir, '--clone', cloneDir, '--assets', assetsPath, '--cutover', join(root, 'no-cutover.json'), '--out', out],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return {
    out,
    summary: JSON.parse(stdout.trim().split('\n').pop()),
    report: JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')),
    html: readFileSync(join(out, 'index.html'), 'utf8'),
  };
}

test('report writes index.html, report.json, assets.json and img/', (t) => {
  const r = buildReport(t, { original: capture(), clone: capture({ shiftX: 18 }) });
  assert.equal(r.summary.ok, true);
  assert.equal(r.summary.round, 0);
  assert.ok(existsSync(join(r.out, 'index.html')));
  assert.ok(existsSync(join(r.out, 'report.json')));
  assert.ok(existsSync(join(r.out, 'assets.json')));
  assert.ok(existsSync(join(r.out, 'img')));
  assert.ok(readdirSync(join(r.out, 'img')).some((f) => f.endsWith('.png')), 'img/ holds diff PNGs');
});

test('static failure: staticPass false, motionPass true, pass false', (t) => {
  const r = buildReport(t, { original: capture(), clone: capture({ shiftX: 18 }) });
  assert.equal(r.report.staticPass, false);
  assert.equal(r.report.motionPass, true);
  assert.equal(r.report.pass, false);
  assert.equal(r.report.cutover.status, 'pending');
  assert.equal(r.report.url, 'https://example.com/');
});

test('identical captures pass static and motion', (t) => {
  const r = buildReport(t, { original: capture(), clone: capture() });
  assert.equal(r.report.staticPass, true);
  assert.equal(r.report.motionPass, true);
  assert.equal(r.report.pass, true);
  assert.equal(r.report.score, 100);
});

test('motion failure alone: staticPass true, motionPass false', (t) => {
  const r = buildReport(t, {
    original: capture({ motionTrack: moverTrack() }),
    clone: capture({ motionTrack: lateEndTrack() }),
  });
  assert.equal(r.report.staticPass, true);
  assert.equal(r.report.motionPass, false);
  assert.equal(r.report.pass, false);
});

test('HTML has no external requests and carries the cutover line', (t) => {
  const r = buildReport(t, { original: capture(), clone: capture({ shiftX: 18 }) });
  assert.equal(/<script\b/i.test(r.html), false, 'no script tag');
  assert.equal(/<link\b/i.test(r.html), false, 'no link tag');
  assert.equal(/\b(src|href)\s*=\s*["']?https?:/i.test(r.html), false, 'no http(s) src or href');
  assert.ok(r.html.includes(CUTOVER_LINE), 'exact cutover sentence');
});

test('site text is HTML-escaped', (t) => {
  const r = buildReport(t, { original: capture(), clone: capture({ shiftX: 18 }) });
  assert.ok(r.html.includes('&lt;b&gt;bold&lt;/b&gt;'), 'escaped key shown in geometry misses');
  assert.equal(r.html.includes('<b>bold</b>'), false, 'raw tag never reaches the page');
});

test('assets and third-party scripts appear with license flags', (t) => {
  const r = buildReport(t, { original: capture(), clone: capture() });
  assert.ok(r.html.includes('adobe-kit'));
  assert.ok(r.html.includes('www.googletagmanager.com'));
  assert.equal(r.report.assets.flagged, 1);
});

// Clone capture whose hero section was built with the given fallback.
function onFallback(cap, name) {
  for (const w of Object.values(cap.widths)) for (const sec of w.sections) sec.fallback = [name];
  return cap;
}

test('a section on a fallback counts toward static only when it passes', (t) => {
  const failing = buildReport(t, { original: capture(), clone: onFallback(capture({ shiftX: 18 }), 'image') });
  assert.equal(failing.report.staticPass, false);
  assert.deepEqual(failing.report.sections[0].fallbacksUsed, ['image']);
  const passing = buildReport(t, { original: capture(), clone: onFallback(capture(), 'image') });
  assert.equal(passing.report.staticPass, true);
});

test('a width whose pixel diff was skipped scores 0, not NaN', (t) => {
  const clone = capture();
  const sec = clone.widths[1440].sections[0];
  sec.box = { ...sec.box, h: 110 };
  const r = buildReport(t, { original: capture(), clone });
  assert.equal(r.html.includes('NaN'), false);
  assert.match(r.html, /<td class="fail">fail, 0<\/td>/);
});

test('a round folder without grade.json is ignored', (t) => {
  const r = buildReport(t, { original: capture(), clone: capture(), crashedRound: true });
  assert.equal(r.summary.ok, true);
  assert.equal(r.summary.round, 0);
});
