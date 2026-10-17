// Tests for round.mjs. The unit tests check failureLines, capFailures and scratchScore on synthetic
// grades. The build-failure test runs a failing build command. The integration group runs whole
// rounds against the fixture site in test/fixtures/site, served over local HTTP.
// Set PP_SKIP_INTEGRATION=1 to run only the unit tests.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { capFailures, failureLines, scratchScore } from '../round.mjs';
import { startServer } from '../serve.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(here, '..');
const fixtureDir = join(here, 'fixtures', 'site');
const SKIP_INTEGRATION = process.env.PP_SKIP_INTEGRATION === '1';
const INTEGRATION_TIMEOUT = 900000;

const plan = {
  url: 'http://127.0.0.1/original.html',
  sections: [{ id: 'header' }, { id: 'hero' }, { id: 'logos' }],
};

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

// One passing width result. Override fields and the pass flag is set to false by failing().
const okWidth = () => ({
  pass: true,
  size: { pass: true, original: { w: 1440, h: 800 }, clone: { w: 1440, h: 800 } },
  masks: { pct: 0, pass: true, sources: [] },
  pixel: { pass: true, diffPct: 0 },
  geometry: { pass: true, checked: 3, failed: [], missing: [], extra: [] },
  hints: [],
});
const failing = (over) => ({ ...okWidth(), ...over, pass: false });
const section = (id, widths, extra = {}) => ({
  id,
  pass: false,
  score: 0,
  widths,
  states: [],
  geometryWidths: [],
  motion: [],
  reduced: [],
  ...extra,
});
const gradeOf = (sections) => ({ pass: false, score: 0, sections });

describe('unit: failureLines', () => {
  test('a passing grade gives no lines', () => {
    const g = gradeOf([section('hero', { 1440: okWidth() })]);
    g.sections[0].pass = true;
    assert.deepEqual(failureLines(g, plan), []);
  });

  test('missing width', () => {
    const g = gradeOf([section('hero', { 1440: { pass: false, missing: true } })]);
    assert.deepEqual(failureLines(g, plan), ['hero @1440: missing']);
  });

  test('size line puts clone first, pixels are not reported when size fails', () => {
    const g = gradeOf([
      section('hero', {
        1440: failing({
          size: { pass: false, original: { w: 1440, h: 812 }, clone: { w: 1440, h: 820 } },
          pixel: { pass: false, skipped: 'size' },
        }),
      }),
    ]);
    assert.deepEqual(failureLines(g, plan), ['hero @1440: size 1440x820, original 1440x812']);
  });

  test('mask cap', () => {
    const g = gradeOf([section('hero', { 1440: failing({ masks: { pct: 18.2, pass: false, sources: ['ticker'] } }) })]);
    assert.deepEqual(failureLines(g, plan), ['hero @1440: mask-cap 18.2%']);
  });

  test('pixel diff', () => {
    const g = gradeOf([section('hero', { 1440: failing({ pixel: { pass: false, diffPct: 2.69 } }) })]);
    assert.deepEqual(failureLines(g, plan), ['hero @1440: pixels 2.69%']);
  });

  test('geometry failed and missing', () => {
    const g = gradeOf([
      section('hero', { 1440: failing({ geometry: { pass: false, checked: 9, failed: [{}, {}, {}], missing: [{}], extra: [] } }) }),
    ]);
    assert.deepEqual(failureLines(g, plan), ['hero @1440: geometry 3 failed, 1 missing']);
  });

  test('geometry also names extra elements', () => {
    const g = gradeOf([
      section('hero', { 1440: failing({ geometry: { pass: false, checked: 9, failed: [], missing: [], extra: [{}, {}] } }) }),
    ]);
    assert.deepEqual(failureLines(g, plan), ['hero @1440: geometry 0 failed, 0 missing, 2 extra']);
  });

  test('state pixel, state missing, state geometry', () => {
    const state = (over) => ({ id: 'nav-open', width: 390, section: 'header', pass: false, ...over });
    const g = gradeOf([
      section('header', { 390: okWidth() }, {
        states: [
          state({ diffPct: 2.1, geometryFailed: 0, masks: { pct: 0, pass: true, sources: [] } }),
        ],
      }),
      section('hero', { 390: okWidth() }, { states: [{ id: 'nav-open', width: 390, section: 'header', pass: false, missing: true }] }),
      section('logos', { 390: okWidth() }, { states: [state({ diffPct: 0, geometryFailed: 2 })] }),
    ]);
    assert.deepEqual(failureLines(g, plan), [
      'header @390: state nav-open 2.1%',
      'hero @390: state nav-open missing',
      'logos @390: state nav-open 2 geometry failed',
    ]);
  });

  test('state mask cap', () => {
    const g = gradeOf([
      section('header', { 390: okWidth() }, {
        states: [{ id: 'nav-open', width: 390, section: 'header', pass: false, diffPct: 0, geometryFailed: 0, masks: { pct: 20, pass: false, sources: [] } }],
      }),
    ]);
    assert.deepEqual(failureLines(g, plan), ['header @390: state nav-open mask-cap 20%']);
  });

  test('geometry-width line', () => {
    const g = gradeOf([section('hero', { 767: okWidth() }, { geometryWidths: [{ width: 767, pass: false, failed: 4, missing: 0 }] })]);
    assert.deepEqual(failureLines(g, plan), ['hero @767: geometry-width 4 failed']);
  });

  test('motion load shows only the parts over the gate, with the sign on the end delta', () => {
    const g = gradeOf([
      section('hero', { 1440: okWidth() }, {
        motion: [{ id: 'load:hero', width: 1440, pass: false, maxPx: 14.2, maxOpacity: 0.31, startDeltaMs: 0, endDeltaMs: 300, unpaired: 0, nullMismatch: false }],
      }),
    ]);
    assert.deepEqual(failureLines(g, plan), ['hero @1440: motion load:hero 14.2px, opacity 0.31, end +300ms']);
  });

  test('motion unpaired', () => {
    const g = gradeOf([
      section('hero', { 1440: okWidth() }, {
        motion: [{ id: 'hover:cta', width: 1440, pass: false, maxPx: 0, maxOpacity: 0, startDeltaMs: 0, endDeltaMs: 0, unpaired: 2, nullMismatch: false }],
      }),
    ]);
    assert.deepEqual(failureLines(g, plan), ['hero @1440: motion hover:cta unpaired 2']);
  });

  test('loop motion skips start and end timing', () => {
    const g = gradeOf([
      section('logos', { 390: okWidth() }, {
        motion: [{ id: 'loop:logos', width: 390, pass: false, maxPx: 5, maxOpacity: 0, startDeltaMs: 0, endDeltaMs: 900, unpaired: 0, nullMismatch: false }],
      }),
    ]);
    assert.deepEqual(failureLines(g, plan), ['logos @390: motion loop:logos 5px']);
  });

  test('motion timing mismatch (null) is named', () => {
    const g = gradeOf([
      section('hero', { 1440: okWidth() }, {
        motion: [{ id: 'load:hero', width: 1440, pass: false, maxPx: 0, maxOpacity: 0, startDeltaMs: null, endDeltaMs: 0, unpaired: 0, nullMismatch: false }],
      }),
    ]);
    assert.deepEqual(failureLines(g, plan), ['hero @1440: motion load:hero start mismatch']);
  });

  test('reduced motion reasons are grouped per entry', () => {
    const g = gradeOf([
      section('logos', { 390: okWidth() }, {
        reduced: [{ id: 'loop:logos', width: 390, pass: false, failed: [{ key: 'a', reason: 'moved' }, { key: 'b', reason: 'moved' }] }],
      }),
    ]);
    assert.deepEqual(failureLines(g, plan), ['logos @390: reduced loop:logos moved']);
  });

  test('sections follow plan order', () => {
    const g = gradeOf([
      section('logos', { 1440: failing({ pixel: { pass: false, diffPct: 1 } }) }),
      section('header', { 1440: failing({ pixel: { pass: false, diffPct: 2 } }) }),
    ]);
    assert.deepEqual(failureLines(g, plan), ['header @1440: pixels 2%', 'logos @1440: pixels 1%']);
  });

  test('scratch filter keeps widths and drops skipped checks', () => {
    const g = gradeOf([
      section('hero', {
        1440: failing({ pixel: { pass: false, diffPct: 1.5 } }),
        390: failing({ masks: { pct: 20, pass: false, sources: [] } }),
      }, {
        states: [{ id: 'hover', width: 1440, section: 'hero', pass: false, diffPct: 3, geometryFailed: 0, masks: { pct: 0, pass: true, sources: [] } }],
        geometryWidths: [{ width: 767, pass: false, failed: 4, missing: 0 }],
        motion: [{ id: 'load:hero', width: 1440, pass: false, maxPx: 9, maxOpacity: 0, startDeltaMs: 0, endDeltaMs: 0, unpaired: 0, nullMismatch: false }],
      }),
    ]);
    assert.equal(failureLines(g, plan).length, 5);
    assert.deepEqual(
      failureLines(g, plan, { widths: [1440], skip: ['states', 'motion', 'geometry'] }),
      ['hero @1440: pixels 1.5%'],
    );
  });

  test('skip motion also hides reduced lines', () => {
    const g = gradeOf([
      section('logos', { 390: okWidth() }, {
        reduced: [{ id: 'loop:logos', width: 390, pass: false, failed: [{ key: 'a', reason: 'moved' }] }],
      }),
    ]);
    assert.deepEqual(failureLines(g, plan, { skip: ['motion'] }), []);
  });
});

describe('unit: capFailures', () => {
  test('caps at 60 and counts the rest in more', () => {
    const lines = Array.from({ length: 70 }, (_, i) => `line ${i}`);
    const { failures, more } = capFailures(lines);
    assert.equal(failures.length, 60);
    assert.equal(failures[0], 'line 0');
    assert.equal(more, 10);
  });

  test('no cap needed', () => {
    assert.deepEqual(capFailures(['a', 'b']), { failures: ['a', 'b'], more: 0 });
  });
});

describe('unit: scratchScore', () => {
  test('mean of 100 minus diffPct, with missing and skipped entries as 0', () => {
    const g = gradeOf([
      section('hero', {
        1440: failing({ pixel: { pass: false, diffPct: 2 } }),
        390: failing({ pixel: { pass: false, skipped: 'size' } }),
      }),
      section('logos', {
        1440: failing({ pixel: { pass: true, diffPct: 0 } }),
        390: { pass: false, missing: true },
      }),
    ]);
    // (98 + 0 + 100 + 0) / 4
    assert.equal(scratchScore(g), 49.5);
    assert.equal(scratchScore(g, { widths: [1440] }), 99);
  });
});

describe('unit: build failure', () => {
  test('a missing capture.json fails before any build runs', async () => {
    const work = mkdtempSync(join(tmpdir(), 'pp-round-empty-'));
    try {
      const res = await runNode('round.mjs', ['--work', work, '--build', 'false']);
      assert.equal(res.code, 1);
      assert.match(res.json.error, /Run capture\.mjs first/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test('a failing build exits 1, names the build, shows the log tail', async () => {
    const work = mkdtempSync(join(tmpdir(), 'pp-round-build-'));
    try {
      mkdirSync(join(work, 'original'), { recursive: true });
      writeFileSync(join(work, 'plan.json'), JSON.stringify(plan));
      writeFileSync(join(work, 'original', 'capture.json'), '{}');
      const res = await runNode('round.mjs', ['--work', work, '--build', `node -e "console.log('x'); process.exit(3)"`]);
      assert.equal(res.code, 1);
      assert.match(res.json.error, /Build failed \(exit 3\)/);
      assert.match(res.stderr, /^x$/m);
      assert.ok(existsSync(join(work, 'build.log')));
      assert.match(readFileSync(join(work, 'build.log'), 'utf8'), /x/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test('--widths and --skip without --scratch fail before any build runs', async () => {
    const work = mkdtempSync(join(tmpdir(), 'pp-round-flags-'));
    try {
      mkdirSync(join(work, 'original'), { recursive: true });
      writeFileSync(join(work, 'plan.json'), JSON.stringify(plan));
      writeFileSync(join(work, 'original', 'capture.json'), '{}');
      for (const extra of [['--widths', '1440'], ['--skip', 'motion']]) {
        const res = await runNode('round.mjs', ['--work', work, '--build', `node -e "process.exit(3)"`, ...extra]);
        assert.equal(res.code, 1);
        assert.match(res.json.error, /only work with --scratch/);
        assert.equal(existsSync(join(work, 'build.log')), false);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('unit: start command cleanup', { skip: process.platform === 'win32' }, () => {
  test('SIGTERM while waiting on --start stops the start command and prints a JSON error', async () => {
    const work = mkdtempSync(join(tmpdir(), 'pp-round-signal-'));
    const pidFile = join(work, 'start.pid');
    try {
      mkdirSync(join(work, 'original'), { recursive: true });
      writeFileSync(join(work, 'plan.json'), JSON.stringify(plan));
      writeFileSync(join(work, 'original', 'capture.json'), '{}');
      // The start command never listens, so round.mjs keeps waiting until the signal.
      const start = `"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)" "${pidFile}"`;
      const child = spawn(process.execPath, [join(scriptsDir, 'round.mjs'), '--work', work, '--no-build', '--start', start], {
        cwd: scriptsDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d));
      const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
      const deadline = Date.now() + 15000;
      while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      assert.ok(existsSync(pidFile), 'start command wrote its pid');
      const pid = Number(readFileSync(pidFile, 'utf8'));
      child.kill('SIGTERM');
      assert.equal(await exited, 1);
      assert.match(JSON.parse(stdout.trim().split('\n').pop()).error, /Stopped by SIGTERM/);
      let alive = true;
      for (let i = 0; i < 20 && alive; i++) {
        try {
          process.kill(pid, 0);
          await new Promise((r) => setTimeout(r, 100));
        } catch {
          alive = false;
        }
      }
      assert.equal(alive, false, 'start command is gone');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('integration: round.mjs on the fixture site', { skip: SKIP_INTEGRATION, timeout: INTEGRATION_TIMEOUT }, () => {
  let site;
  let work;
  let passDir;
  let failDir;

  before(async () => {
    work = mkdtempSync(join(tmpdir(), 'pp-round-int-'));
    copyFileSync(join(fixtureDir, 'plan.json'), join(work, 'plan.json'));
    site = await startServer({ dir: fixtureDir, port: 0 });
    const cap = await runNode('capture.mjs', [
      '--mode', 'original',
      '--url', `${site.url}original.html`,
      '--out', join(work, 'original'),
      '--plan', join(work, 'plan.json'),
      '--widths', '1440,390',
    ]);
    assert.equal(cap.code, 0, cap.stderr);

    passDir = mkdtempSync(join(tmpdir(), 'pp-round-pass-'));
    copyFileSync(join(fixtureDir, 'clone-pass.html'), join(passDir, 'original.html'));
    failDir = mkdtempSync(join(tmpdir(), 'pp-round-fail-'));
    copyFileSync(join(fixtureDir, 'clone-fail.html'), join(failDir, 'original.html'));
  });

  after(async () => {
    await new Promise((resolve) => {
      site?.server.closeAllConnections?.();
      site ? site.server.close(() => resolve()) : resolve();
    });
    for (const dir of [work, passDir, failDir]) if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('a clone that matches the original passes round 0', async () => {
    const res = await runNode('round.mjs', ['--work', work, '--no-build', '--dir', passDir]);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.pass, true);
    assert.equal(res.json.round, 0);
    assert.ok(existsSync(join(work, 'grade', 'round-0', 'grade.json')));
    assert.ok(existsSync(join(work, 'clone-reduced')));
  });

  test('scratch round grades under scratch/ only', async () => {
    const res = await runNode('round.mjs', [
      '--work', work, '--no-build', '--dir', passDir, '--scratch', '--widths', '1440', '--skip', 'states,motion,geometry',
    ]);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.scratch, true);
    assert.equal(res.json.pass, true);
    assert.equal(typeof res.json.score, 'number');
    assert.ok(existsSync(join(work, 'scratch', 'grade', 'round-0', 'grade.json')));
    assert.equal(existsSync(join(work, 'grade', 'round-1')), false);
  });

  test('a clone with a smaller hero heading fails with exit 2 and names the hero', async () => {
    const res = await runNode('round.mjs', ['--work', work, '--no-build', '--dir', failDir]);
    assert.equal(res.code, 2, res.stderr);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.pass, false);
    assert.ok(
      res.json.failures.some((line) => line.startsWith('hero @')),
      JSON.stringify(res.json.failures),
    );
  });
});
