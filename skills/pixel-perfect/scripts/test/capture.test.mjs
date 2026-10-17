// Tests for capture.mjs and lib/autoplan.mjs. The integration groups run the real scripts in a
// headless Chromium against the fixture site in test/fixtures/site, served over local HTTP.
// Set PP_SKIP_INTEGRATION=1 to run only the unit tests.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { buildPlan, changedBox, geometryFor, liveTiles, slugId, validatePlan } from '../lib/autoplan.mjs';
import { httpUrl } from '../lib/io.mjs';
import { PNG } from '../lib/png.mjs';
import { startServer } from '../serve.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(here, '..');
const fixtureDir = join(here, 'fixtures', 'site');
const SKIP_INTEGRATION = process.env.PP_SKIP_INTEGRATION === '1';
const INTEGRATION_TIMEOUT = 900000;

// A solid white PNG, optionally painted by paint(x, y, rgba).
function makePng(width, height, paint = null) {
  const png = new PNG({ width, height });
  png.data.fill(255);
  if (paint) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = paint(x, y);
        if (!v) continue;
        const i = (y * width + x) * 4;
        png.data[i] = v[0];
        png.data[i + 1] = v[1];
        png.data[i + 2] = v[2];
      }
    }
  }
  return png;
}

// Run a script and return { code, json, stderr }. json is the last stdout line, parsed.
function runNode(script, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(scriptsDir, script), ...args], { cwd: scriptsDir, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
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

describe('unit: liveTiles', () => {
  test('one changed pixel gives one 32 px tile in page coordinates', () => {
    const a = makePng(96, 96);
    const b = makePng(96, 96, (x, y) => (x === 40 && y === 10 ? [0, 0, 0, 255] : null));
    assert.deepEqual(liveTiles(a, b), [{ x: 32, y: 0, w: 32, h: 32 }]);
  });

  test('changed tiles stacked vertically merge into one box', () => {
    const a = makePng(96, 96);
    const b = makePng(96, 96, (x, y) => (x < 32 && y < 64 ? [0, 0, 0, 255] : null));
    assert.deepEqual(liveTiles(a, b), [{ x: 0, y: 0, w: 32, h: 64 }]);
  });

  test('identical images give no boxes', () => {
    assert.deepEqual(liveTiles(makePng(64, 64), makePng(64, 64)), []);
  });
});

describe('unit: changedBox', () => {
  test('returns null for identical images', () => {
    assert.equal(changedBox(makePng(40, 40), makePng(40, 40)), null);
  });

  test('returns the bounding box of the changed pixels', () => {
    const a = makePng(40, 40);
    const b = makePng(40, 40, (x, y) => (x >= 10 && x <= 20 && y >= 5 && y <= 9 ? [0, 0, 0, 255] : null));
    assert.deepEqual(changedBox(a, b), { x: 10, y: 5, w: 11, h: 5 });
  });
});

describe('unit: plan helpers', () => {
  test('geometryFor adds both sides of each breakpoint and skips plan widths', () => {
    assert.deepEqual(
      geometryFor(
        [
          { kind: 'max', px: 767, count: 3 },
          { kind: 'min', px: 768, count: 1 },
        ],
        [1440, 390],
      ),
      [767, 768],
    );
    assert.deepEqual(geometryFor([{ kind: 'max', px: 1000, count: 1 }], [1000]), [1001]);
    assert.deepEqual(
      geometryFor(
        [
          { kind: 'max', px: 767.98, count: 2 },
          { kind: 'min', px: 992.5, count: 1 },
        ],
        [1440],
      ),
      [767, 768, 992, 993],
    );
  });

  test('slugId makes a plan-safe id', () => {
    assert.equal(slugId('Hero Section!'), 'hero-section');
    assert.equal(slugId(''), '');
  });

  test('buildPlan turns candidates into a valid plan with states and motion', () => {
    const candidates = [
      {
        tag: 'header',
        id: '',
        heading: '',
        selector: 'body > header',
        box: { x: 0, y: 0, w: 1440, h: 72 },
        cssLoopMs: 0,
        cssFinite: false,
        hover: null,
        click: { selector: 'body > header > button', visible: false },
      },
      {
        tag: 'section',
        id: 'hero',
        heading: 'Build pages',
        selector: '#hero',
        box: { x: 0, y: 72, w: 1440, h: 560 },
        cssLoopMs: 0,
        cssFinite: true,
        hover: '#hero > a',
        click: null,
      },
      {
        tag: 'section',
        id: '',
        heading: 'Trusted by',
        selector: 'main > section:nth-of-type(2)',
        box: { x: 0, y: 632, w: 1440, h: 180 },
        cssLoopMs: 2000,
        cssFinite: false,
        hover: null,
        click: null,
      },
    ];
    const plan = buildPlan({ url: 'http://x/', widths: [1440, 390], candidates, breakpoints: [{ kind: 'max', px: 767, count: 2 }] });
    assert.deepEqual(
      plan.sections.map((s) => s.id),
      ['header', 'hero', 'trusted-by'],
    );
    assert.deepEqual(plan.states.map((s) => [s.id, s.action, s.widths]), [
      ['header-open', 'click', [390]],
      ['hero-hover', 'hover', [1440]],
    ]);
    const motion = Object.fromEntries(plan.motion.map((m) => [m.id, m]));
    assert.equal(motion['load:hero'].kind, 'load');
    assert.equal(motion['hover:hero-hover'].state, 'hero-hover');
    assert.equal(motion['click:header-open'].state, 'header-open');
    assert.deepEqual(
      [motion['loop:trusted-by'].driver, motion['loop:trusted-by'].periodMs, motion['loop:trusted-by'].durationMs],
      ['css', 2000, 3000],
    );
    assert.deepEqual(plan.geometryWidths, [767, 768]);
    assert.deepEqual(validatePlan(plan), []);
  });

  test('validatePlan accepts the fixture plan and rejects bad ids and unknown sections', () => {
    const fixture = JSON.parse(readFileSync(join(fixtureDir, 'plan.json'), 'utf8'));
    assert.deepEqual(validatePlan(fixture), []);
    const errors = validatePlan({
      version: 1,
      widths: [1440],
      sections: [{ id: 'Bad Id', selector: 'x' }],
      states: [{ id: 'a', section: 'missing', action: 'hover', selector: 'x' }],
      motion: [{ id: 'hover:a', kind: 'hover', section: 'missing', state: 'nope' }],
    });
    assert.ok(errors.some((e) => e.includes('bad section id')));
    assert.ok(errors.some((e) => e.includes('unknown section missing')));
    assert.ok(errors.some((e) => e.includes('needs a known state')));
  });

  test('httpUrl keeps http and https URLs and rejects every other scheme', () => {
  assert.equal(httpUrl('https://example.com'), 'https://example.com/');
  assert.equal(httpUrl('http://127.0.0.1:3000/a?b=1'), 'http://127.0.0.1:3000/a?b=1');
  assert.throws(() => httpUrl('file:///etc/passwd'), /must be an http or https URL, got file:/);
  assert.throws(() => httpUrl('javascript:alert(1)'), /got javascript:/);
  assert.throws(() => httpUrl('example.com'), /Bad --url value/);
});

test('validatePlan rejects a plan with no sections', () => {
    const errors = validatePlan({ version: 1, widths: [1440], sections: [] });
    assert.ok(errors.some((e) => e.includes('sections must be a non-empty array')));
  });
});

describe('integration: auto plan', { skip: SKIP_INTEGRATION, timeout: INTEGRATION_TIMEOUT }, () => {
  let work;
  let server;
  before(async () => {
    work = mkdtempSync(join(tmpdir(), 'pp-capture-auto-'));
    server = await startServer({ dir: fixtureDir, port: 0 });
  });
  after(() => {
    server?.server.closeAllConnections?.();
    server?.server.close();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  test('builds, writes and uses an auto plan for the fixture', async () => {
    const planPath = join(work, 'plan.json');
    const out = join(work, 'original');
    const run = await runNode('capture.mjs', ['--url', `${server.url}original.html`, '--out', out, '--plan', planPath, '--widths', '1440,390']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.json.ok, true);
    assert.equal(run.json.planWritten, true);
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    assert.deepEqual(validatePlan(plan), []);
    assert.deepEqual(
      plan.sections.map((s) => s.id),
      ['header', 'hero', 'logos', 'ticker', 'features', 'faq', 'footer'],
    );
    const loopLogos = plan.motion.find((m) => m.id === 'loop:logos');
    assert.equal(loopLogos?.driver, 'css');
    assert.equal(loopLogos?.periodMs, 2000);
    assert.ok(plan.motion.find((m) => m.id === 'loop:ticker')?.driver === 'js', 'ticker is a JavaScript loop');
    const capture = JSON.parse(readFileSync(join(out, 'capture.json'), 'utf8'));
    for (const width of ['1440', '390']) {
      const missing = capture.widths[width].sections.filter((s) => s.missing).map((s) => s.id);
      assert.deepEqual(missing, [], `sections missing at ${width}`);
    }
  });
});

describe('integration: full capture, reduced motion and grade', { skip: SKIP_INTEGRATION, timeout: INTEGRATION_TIMEOUT }, () => {
  let work;
  let server;
  const planPath = join(fixtureDir, 'plan.json');
  const runs = {};
  before(async () => {
    work = mkdtempSync(join(tmpdir(), 'pp-capture-full-'));
    server = await startServer({ dir: fixtureDir, port: 0 });
    const url = (name) => `${server.url}${name}`;
    const widths = ['--widths', '1440,390'];
    runs.original = await runNode('capture.mjs', ['--url', url('original.html'), '--out', join(work, 'original'), '--plan', planPath, ...widths]);
    runs.clone = await runNode('capture.mjs', ['--url', url('clone-pass.html'), '--mode', 'clone', '--out', join(work, 'clone'), '--plan', planPath, ...widths]);
    runs.cloneFail = await runNode('capture.mjs', ['--url', url('clone-fail.html'), '--mode', 'clone', '--out', join(work, 'clone-fail'), '--plan', planPath, ...widths]);
    runs.reduced = await runNode('capture.mjs', ['--url', url('clone-pass.html'), '--mode', 'clone', '--out', join(work, 'clone-reduced'), '--plan', planPath, ...widths, '--reduced-motion']);
    runs.grade = await runNode('grade.mjs', ['--original', join(work, 'original'), '--clone', join(work, 'clone'), '--reduced', join(work, 'clone-reduced'), '--out', join(work, 'grade')]);
    runs.gradeFail = await runNode('grade.mjs', ['--original', join(work, 'original'), '--clone', join(work, 'clone-fail'), '--out', join(work, 'grade-fail')]);
  });
  after(() => {
    server?.server.closeAllConnections?.();
    server?.server.close();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  const readCapture = (name) => JSON.parse(readFileSync(join(work, name, 'capture.json'), 'utf8'));
  const readGrade = (run) => JSON.parse(readFileSync(run.json.grade, 'utf8'));

  test('original capture writes sections, PNGs, states and motion', () => {
    assert.equal(runs.original.code, 0, runs.original.stderr);
    assert.equal(runs.original.json.planWritten, false);
    const capture = readCapture('original');
    assert.equal(capture.mode, 'original');
    assert.equal(capture.reducedMotion, false);
    const desktop = capture.widths['1440'];
    assert.equal(desktop.viewport.width, 1440);
    assert.ok(existsSync(join(work, 'original', '1440', 'page.png')));
    for (const section of desktop.sections) {
      assert.equal(section.missing, undefined, `section ${section.id} missing`);
      assert.ok(existsSync(join(work, 'original', section.png)), `png for ${section.id}`);
      assert.ok(section.elements.length > 0, `elements for ${section.id}`);
    }
    const ticker = desktop.sections.find((s) => s.id === 'ticker');
    assert.ok(ticker.masks.some((m) => m.reason === 'live'), 'ticker has a live mask from the stability pass');
    const hover = desktop.states.find((s) => s.id === 'hero-cta-hover');
    assert.ok(hover && !hover.missing && hover.changed, 'hover state changes the viewport');
    const menu = capture.widths['390'].states.find((s) => s.id === 'nav-open');
    assert.ok(menu && !menu.missing && menu.changed, 'mobile menu state changes the viewport');
    const motionIds = desktop.motion.map((m) => m.id);
    assert.ok(motionIds.includes('loop:ticker') && motionIds.includes('loop:logos'));
    for (const m of [...desktop.motion, ...capture.widths['390'].motion]) {
      assert.equal(m.missing, undefined, `motion ${m.id} missing: ${m.notes ?? ''}`);
    }
    assert.ok(capture.widths['767'] === undefined, 'geometry widths are not screenshot widths');
    assert.ok(Object.keys(capture.geometry).includes('767'), 'geometry recorded for 767');
  });

  test('clone capture uses the clone attributes', () => {
    assert.equal(runs.clone.code, 0, runs.clone.stderr);
    const capture = readCapture('clone');
    assert.equal(capture.mode, 'clone');
    const sections = capture.widths['1440'].sections.map((s) => s.id);
    assert.deepEqual(sections, ['header', 'hero', 'logos', 'ticker', 'features', 'faq', 'footer']);
    assert.ok(capture.widths['390'].states.some((s) => s.id === 'nav-open' && !s.missing));
  });

  test('reduced-motion capture records motion traces only, with reduced motion emulated', () => {
    assert.equal(runs.reduced.code, 0, runs.reduced.stderr);
    const capture = readCapture('clone-reduced');
    assert.equal(capture.reducedMotion, true);
    for (const width of ['1440', '390']) {
      assert.deepEqual(capture.widths[width].sections, []);
      assert.deepEqual(capture.widths[width].states, []);
      assert.ok(capture.widths[width].motion.length > 0, `motion at ${width}`);
    }
    // The marquee is stopped under reduced motion, so its loop trace must not glide.
    const logos = capture.widths['1440'].motion.find((m) => m.id === 'loop:logos');
    const moving = logos.elements.filter((e) => e.track.filter(Boolean).some((s, i, a) => i > 0 && (s[0] !== a[0][0] || s[1] !== a[0][1])));
    assert.equal(moving.length, 0, 'logos marquee is still under reduced motion');
  });

  test('grade passes every fixture section for the matching clone', () => {
    assert.equal(runs.grade.code, 0, runs.grade.stderr);
    assert.equal(runs.grade.json.pass, true);
    const grade = readGrade(runs.grade);
    assert.deepEqual(grade.sections.filter((s) => !s.pass).map((s) => s.id), []);
    // At 390 px the stopped marquee leaves copies outside the viewport. They must not fail.
    const logos = grade.sections.find((s) => s.id === 'logos');
    assert.ok(logos.reduced.some((r) => r.width === 390 && r.pass));
  });

  test('grade fails with exit 2 for the clone with a 6 px smaller headline', () => {
    assert.equal(runs.cloneFail.code, 0, runs.cloneFail.stderr);
    assert.equal(runs.gradeFail.code, 2);
    assert.equal(runs.gradeFail.json.pass, false);
    assert.ok(runs.gradeFail.json.failed > 0);
    assert.ok(runs.gradeFail.json.fix.includes('hero'));
  });
});
