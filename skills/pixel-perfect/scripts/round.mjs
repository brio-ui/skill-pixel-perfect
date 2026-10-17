#!/usr/bin/env node
// One fix round: build the clone, serve it, capture it, grade it, and list what still fails.
// Prints one JSON line. Exit 0 when the round passes, 2 when it fails, 1 on error.
//
//   node round.mjs [--work .pixel-perfect] [--build "npm run build"] [--no-build] [--dir out]
//     [--start "<cmd with {port}>"] [--url <url>] [--round <n>] [--timeout <ms>]
//     [--scratch [--widths 1440,768,390] [--skip states,motion,geometry]]
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { GATE, done, ensureDir, log, main, parseWidths, readJson } from './lib/io.mjs';
import { startServer } from './serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPTURE = join(HERE, 'capture.mjs');
const GRADE = join(HERE, 'grade.mjs');
const MAX_FAILURES = 60;
const BUILD_TAIL_LINES = 40;
const START_WAIT_MS = 60_000;
const STOP_WAIT_MS = 3_000;
const SKIP_TOKENS = ['states', 'motion', 'geometry'];

const numAsc = (a, b) => Number(a) - Number(b);
const round2 = (n) => Math.round(n * 100) / 100;
const sleep = (ms) => new Promise((resolveP) => setTimeout(resolveP, ms));
const trimSlash = (s) => s.replace(/\/+$/, '');

// Every failure as { text, check, width }. check is the --skip token that hides the line, or null.
function collect(grade, plan) {
  const order = (plan?.sections ?? []).map((s) => (typeof s === 'string' ? s : s.id));
  const rank = (id) => (order.includes(id) ? order.indexOf(id) : order.length);
  const items = [];
  const push = (text, check = null, width = null) => items.push({ text, check, width });

  for (const sec of [...grade.sections].sort((a, b) => rank(a.id) - rank(b.id))) {
    for (const w of Object.keys(sec.widths).sort(numAsc)) {
      const r = sec.widths[w];
      const at = `${sec.id} @${w}`;
      const width = Number(w);
      if (r.missing) {
        push(`${at}: missing`, null, width);
        continue;
      }
      if (r.pass) continue;
      const before = items.length;
      if (!r.size.pass) {
        push(`${at}: size ${r.size.clone.w}x${r.size.clone.h}, original ${r.size.original.w}x${r.size.original.h}`, null, width);
      }
      if (!r.masks.pass) push(`${at}: mask-cap ${r.masks.pct}%`, null, width);
      if (!r.pixel.skipped && !r.pixel.pass) push(`${at}: pixels ${r.pixel.diffPct}%`, null, width);
      if (!r.geometry.pass) {
        const extra = r.geometry.extra?.length ? `, ${r.geometry.extra.length} extra` : '';
        push(`${at}: geometry ${r.geometry.failed.length} failed, ${r.geometry.missing.length} missing${extra}`, null, width);
      }
      if (items.length === before) push(`${at}: failed`, null, width);
    }

    for (const st of sec.states) {
      const at = `${sec.id} @${st.width}`;
      if (st.missing) {
        push(`${at}: state ${st.id} missing`, 'states', st.width);
        continue;
      }
      if (st.pass) continue;
      const before = items.length;
      if (st.masks && !st.masks.pass) push(`${at}: state ${st.id} mask-cap ${st.masks.pct}%`, 'states', st.width);
      if (st.diffPct > GATE.pixelPct) push(`${at}: state ${st.id} ${st.diffPct}%`, 'states', st.width);
      if (st.geometryFailed > 0) push(`${at}: state ${st.id} ${st.geometryFailed} geometry failed`, 'states', st.width);
      if (items.length === before) push(`${at}: state ${st.id} failed`, 'states', st.width);
    }

    for (const g of sec.geometryWidths) {
      if (g.pass) continue;
      const missing = g.missing ? `, ${g.missing} missing` : '';
      push(`${sec.id} @${g.width}: geometry-width ${g.failed} failed${missing}`, 'geometry', g.width);
    }

    for (const m of sec.motion) {
      if (m.pass) continue;
      // Loop and scrub entries have no meaningful start or end, so only their per-sample deviation is judged.
      const timed = !m.id.startsWith('loop:') && !m.id.startsWith('scrub:');
      const parts = [];
      if (m.maxPx > GATE.motionPx) parts.push(`${m.maxPx}px`);
      if (m.maxOpacity > GATE.motionOpacity) parts.push(`opacity ${m.maxOpacity}`);
      if (timed) {
        for (const [label, v] of [['start', m.startDeltaMs], ['end', m.endDeltaMs]]) {
          if (v === null) parts.push(`${label} mismatch`);
          else if (v > GATE.motionMs) parts.push(`${label} +${v}ms`);
        }
      }
      if (m.unpaired) parts.push(`unpaired ${m.unpaired}`);
      if (m.nullMismatch) parts.push('null mismatch');
      if (!parts.length) parts.push('failed');
      push(`${sec.id} @${m.width}: motion ${m.id} ${parts.join(', ')}`, 'motion', m.width);
    }

    for (const r of sec.reduced) {
      if (r.pass) continue;
      const reasons = [...new Set((r.failed ?? []).map((f) => f.reason))];
      push(`${sec.id} @${r.width}: reduced ${r.id} ${reasons.join(', ') || 'failed'}`, 'motion', r.width);
    }
  }
  return items;
}

// Failure lines for a grade. widths keeps only those widths; skip hides the states, motion (also
// reduced) and geometry (geometry-width lines only) checks.
export function failureLines(grade, plan, { widths, skip = [] } = {}) {
  const hidden = new Set(skip);
  const only = widths?.length ? new Set(widths.map(Number)) : null;
  return collect(grade, plan)
    .filter((it) => (!only || only.has(it.width)) && !(it.check && hidden.has(it.check)))
    .map((it) => it.text);
}

export function capFailures(lines, max = MAX_FAILURES) {
  return { failures: lines.slice(0, max), more: Math.max(0, lines.length - max) };
}

// Mean of (100 - diffPct) over every section x captured width. Missing or skipped entries score 0.
export function scratchScore(grade, { widths } = {}) {
  const only = widths?.length ? new Set(widths.map(Number)) : null;
  const all = [...new Set(grade.sections.flatMap((s) => Object.keys(s.widths).map(Number)))].sort(numAsc);
  const useWidths = all.filter((w) => !only || only.has(w));
  const values = [];
  for (const sec of grade.sections) {
    for (const w of useWidths) {
      const r = sec.widths[w];
      values.push(!r || r.missing || !r.pixel || r.pixel.skipped ? 0 : 100 - r.pixel.diffPct);
    }
  }
  if (!values.length) return 0;
  return round2(values.reduce((a, b) => a + b, 0) / values.length);
}

function lastJson(text) {
  const lines = text.trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // not a JSON line, keep looking upward
    }
  }
  return null;
}

// Runs a child script with the same node binary. Child stderr is forwarded as it arrives.
function runChild(script, args) {
  return new Promise((resolveP, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.once('error', reject);
    child.once('close', (code) => resolveP({ code, stdout }));
  });
}

async function capture(args) {
  const res = await runChild(CAPTURE, args);
  if (res.code !== 0) throw new Error(`capture failed (exit ${res.code}): ${lastJson(res.stdout)?.error ?? 'see stderr above'}`);
}

async function build(cmd, work) {
  const logPath = join(work, 'build.log');
  const fd = openSync(logPath, 'w');
  log(`build: ${cmd}`);
  const code = await new Promise((resolveP, reject) => {
    const child = spawn(cmd, {
      shell: true,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    });
    child.once('error', reject);
    child.once('close', (c) => resolveP(c ?? 1));
  }).finally(() => closeSync(fd));
  if (code !== 0) {
    const tail = readFileSync(logPath, 'utf8').replace(/\n+$/, '').split('\n').slice(-BUILD_TAIL_LINES).join('\n');
    process.stderr.write(`${tail}\n`);
    throw new Error(`Build failed (exit ${code}). The last ${BUILD_TAIL_LINES} lines are above. Full log: ${logPath}`);
  }
}

function freePort() {
  return new Promise((resolveP, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolveP(port));
    });
  });
}

// Runs the --start command in its own process group. Returns a stop function that kills the group.
async function startCommand(cmd, port, work) {
  const logPath = join(work, 'start.log');
  const fd = openSync(logPath, 'w');
  const child = spawn(cmd.replaceAll('{port}', String(port)), {
    shell: true,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, PORT: String(port), NEXT_TELEMETRY_DISABLED: '1' },
  });
  closeSync(fd);
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  const killGroup = (sig) => {
    if (process.platform === 'win32') {
      // Windows has no process groups. taskkill /T ends the shell and everything it started.
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return;
    }
    try {
      process.kill(-child.pid, sig);
    } catch {
      // group already gone
    }
  };
  // The group does not get the terminal's Ctrl-C, so stop it before this script exits on a signal.
  const onSignal = (sig) => {
    killGroup('SIGKILL');
    process.stdout.write(`${JSON.stringify({ ok: false, error: `Stopped by ${sig}` })}\n`);
    process.exit(1);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const stop = async () => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (!exited) {
      killGroup('SIGTERM');
      await Promise.race([new Promise((resolveP) => child.once('exit', resolveP)), sleep(STOP_WAIT_MS)]);
    }
    killGroup('SIGKILL');
  };

  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + START_WAIT_MS;
  while (!exited && Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      log(`start: answered on port ${port}`);
      return stop;
    } catch {
      await sleep(500);
    }
  }
  await stop();
  const reason = exited
    ? `Start command exited before answering on port ${port}.`
    : `Start command did not answer on port ${port} within 60 s.`;
  throw new Error(`${reason} Output: ${logPath}`);
}

// Returns the base URL to capture from, and a close function for whatever served it.
async function serveTarget(values, work) {
  if (values.url) return { base: trimSlash(values.url), close: async () => {} };
  if (values.start) {
    const port = await freePort();
    const stop = await startCommand(values.start, port, work);
    return { base: `http://127.0.0.1:${port}`, close: stop };
  }
  const dir = resolve(values.dir);
  if (!existsSync(dir)) {
    throw new Error(`Missing ${dir}. Build first, or pass --dir <folder> or --start "<cmd with {port}>".`);
  }
  const { server, url } = await startServer({ dir, port: 0 });
  return {
    base: trimSlash(url),
    close: () =>
      new Promise((resolveP) => {
        server.closeAllConnections?.();
        server.close(() => resolveP());
      }),
  };
}

function parseIntFlag(value, flag, min) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new Error(`Bad ${flag} value: ${value}`);
  return n;
}

async function run() {
  const { values } = parseArgs({
    options: {
      work: { type: 'string', default: '.pixel-perfect' },
      build: { type: 'string', default: 'npm run build' },
      'no-build': { type: 'boolean', default: false },
      dir: { type: 'string', default: 'out' },
      start: { type: 'string' },
      url: { type: 'string' },
      round: { type: 'string' },
      widths: { type: 'string' },
      skip: { type: 'string' },
      timeout: { type: 'string' },
      scratch: { type: 'boolean', default: false },
    },
    strict: true,
  });

  const work = resolve(values.work);
  const planPath = join(work, 'plan.json');
  const origDir = join(work, 'original');
  for (const p of [planPath, join(origDir, 'capture.json')]) {
    if (!existsSync(p)) throw new Error(`Missing ${p}. Run capture.mjs first.`);
  }
  if (values.url && values.start) throw new Error('Use --url or --start, not both.');

  const round = values.round === undefined ? undefined : parseIntFlag(values.round, '--round', 0);
  const widths = values.widths === undefined ? undefined : parseWidths(values.widths);
  const timeout = values.timeout === undefined ? undefined : parseIntFlag(values.timeout, '--timeout', 1);
  const skip = values.skip === undefined ? [] : values.skip.split(',').map((s) => s.trim()).filter(Boolean);
  for (const token of skip) {
    if (!SKIP_TOKENS.includes(token)) throw new Error(`Bad --skip token: ${token}. Use ${SKIP_TOKENS.join(', ')}.`);
  }
  // An official round with fewer widths or checks would only use up one of the fix rounds.
  if (!values.scratch && (widths || skip.length)) {
    throw new Error('--widths and --skip only work with --scratch. An official round captures every width and check.');
  }

  const plan = readJson(planPath);
  if (!plan.url) throw new Error(`No url in ${planPath}.`);
  const scratch = values.scratch;
  const scratchDir = join(work, 'scratch');
  const cloneDir = scratch ? join(scratchDir, 'clone') : join(work, 'clone');
  const reducedDir = join(work, 'clone-reduced');
  const gradeRoot = scratch ? join(scratchDir, 'grade') : join(work, 'grade');
  const reduce = !scratch; // scratch rounds skip the reduced-motion capture
  const captureExtra = [
    ...(widths ? ['--widths', values.widths] : []),
    ...(skip.length ? ['--skip', skip.join(',')] : []),
    ...(timeout !== undefined ? ['--timeout', String(timeout)] : []),
  ];

  ensureDir(work);
  if (!values['no-build']) await build(values.build, work);

  const { base, close } = await serveTarget(values, work);
  try {
    const cloneUrl = `${base}${new URL(plan.url).pathname}`;
    ensureDir(scratch ? scratchDir : work);
    log(`capture clone: ${cloneUrl}`);
    await capture(['--mode', 'clone', '--url', cloneUrl, '--out', cloneDir, '--plan', planPath, ...captureExtra]);
    if (reduce) {
      log('capture clone with reduced motion');
      await capture([
        '--mode', 'clone', '--url', cloneUrl, '--out', reducedDir, '--plan', planPath, '--reduced-motion', ...captureExtra,
      ]);
    }
  } finally {
    await close();
  }

  if (scratch) rmSync(gradeRoot, { recursive: true, force: true });
  const gradeArgs = ['--original', origDir, '--clone', cloneDir, '--out', gradeRoot];
  if (reduce) gradeArgs.push('--reduced', reducedDir);
  if (scratch) gradeArgs.push('--round', '0');
  else if (round !== undefined) gradeArgs.push('--round', String(round));
  const gradeRun = await runChild(GRADE, gradeArgs);
  if (gradeRun.code !== 0 && gradeRun.code !== 2) {
    throw new Error(`grade failed (exit ${gradeRun.code}): ${lastJson(gradeRun.stdout)?.error ?? 'see stderr above'}`);
  }
  const result = lastJson(gradeRun.stdout);
  if (!result?.grade) throw new Error('grade printed no result line. See stderr above.');
  const grade = readJson(result.grade);

  if (scratch) {
    const lines = failureLines(grade, plan, { widths, skip });
    const pass = lines.length === 0;
    const { failures, more } = capFailures(lines);
    done(
      { ok: true, scratch: true, pass, score: scratchScore(grade, { widths }), grade: result.grade, failures, more },
      pass ? 0 : 2,
    );
    return;
  }

  const { failures, more } = capFailures(failureLines(grade, plan));
  done(
    {
      ok: true,
      round: result.round,
      pass: result.pass,
      score: result.score,
      passed: result.passed,
      failed: result.failed,
      grade: result.grade,
      fix: result.fix,
      fallback: result.fallback,
      failures,
      more,
    },
    result.pass ? 0 : 2,
  );
}

function isEntryPoint() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) main(run);
