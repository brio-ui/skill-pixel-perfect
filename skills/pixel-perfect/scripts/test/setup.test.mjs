import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { installDeps, missingDeps, nodeMajor, runSetup } from '../setup.mjs';

const SCRIPTS = dirname(dirname(fileURLToPath(import.meta.url)));
const execFileAsync = promisify(execFile);

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'pp-setup-'));
}

test('nodeMajor reads the major number from a version string', () => {
  assert.equal(nodeMajor('v18.19.0'), 18);
  assert.equal(nodeMajor('v20.0.0'), 20);
  assert.equal(nodeMajor('24.1.0'), 24);
});

test('runSetup refuses Node below 20 before probing anything', async () => {
  const probe = {
    deps: () => assert.fail('probe.deps must not run on old Node'),
    chromium: () => assert.fail('probe.chromium must not run on old Node'),
  };
  await assert.rejects(runSetup({ nodeVersion: 'v18.20.0', probe }), /too old.*Node 20/);
});

test('runSetup check mode reports missing parts and installs nothing', async () => {
  const calls = [];
  const result = await runSetup({
    check: true,
    nodeVersion: 'v24.0.0',
    probe: {
      deps: async () => ['playwright'],
      chromium: async () => false,
    },
    install: {
      deps: async () => calls.push('install.deps'),
      chromium: async () => calls.push('install.chromium'),
    },
  });
  assert.deepEqual(result, { ok: false, node: 'v24.0.0', installed: [], missing: ['deps', 'chromium'] });
  assert.deepEqual(calls, []);
});

test('runSetup installs deps, then chromium, when both are missing', async () => {
  const calls = [];
  let depsProbes = 0;
  let chromiumProbes = 0;
  const result = await runSetup({
    nodeVersion: 'v24.0.0',
    probe: {
      deps: async () => (depsProbes++ === 0 ? ['playwright'] : []),
      chromium: async () => chromiumProbes++ > 0,
    },
    install: {
      deps: async () => calls.push('install.deps'),
      chromium: async () => calls.push('install.chromium'),
    },
  });
  assert.deepEqual(calls, ['install.deps', 'install.chromium']);
  assert.deepEqual(result, { ok: true, node: 'v24.0.0', installed: ['deps', 'chromium'], missing: [] });
});

test('runSetup installs only chromium when deps are present', async () => {
  const calls = [];
  let chromiumProbes = 0;
  const result = await runSetup({
    nodeVersion: 'v24.0.0',
    probe: {
      deps: async () => [],
      chromium: async () => chromiumProbes++ > 0,
    },
    install: {
      deps: async () => calls.push('install.deps'),
      chromium: async () => calls.push('install.chromium'),
    },
  });
  assert.deepEqual(calls, ['install.chromium']);
  assert.deepEqual(result, { ok: true, node: 'v24.0.0', installed: ['chromium'], missing: [] });
});

test('runSetup throws when chromium is still missing after install', async () => {
  await assert.rejects(
    runSetup({
      nodeVersion: 'v24.0.0',
      probe: { deps: async () => [], chromium: async () => false },
      install: { deps: async () => {}, chromium: async () => {} },
    }),
    /Chromium still missing/,
  );
});

test('missingDeps flags absent and mismatched packages', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { a: '1.0.0', b: '2.0.0', c: '3.0.0' } }));
    mkdirSync(join(dir, 'node_modules', 'a'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'a', 'package.json'), JSON.stringify({ version: '1.0.0' }));
    mkdirSync(join(dir, 'node_modules', 'c'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'c', 'package.json'), JSON.stringify({ version: '3.0.1' }));
    assert.deepEqual(missingDeps(dir), ['b', 'c']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installDeps falls back from npm ci to npm install', async () => {
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, args]);
    if (args[0] === 'ci') throw new Error('no lockfile');
  };
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  await installDeps('/unused', exec);
  assert.deepEqual(calls, [
    [npm, ['ci']],
    [npm, ['install']],
  ]);
});

test('installDeps stops after npm ci when it works', async () => {
  const calls = [];
  await installDeps('/unused', async (command, args) => calls.push(args));
  assert.deepEqual(calls, [['ci']]);
});

test('--check CLI prints one JSON line with ok true and no missing parts', async () => {
  const { stdout } = await execFileAsync(process.execPath, [join(SCRIPTS, 'setup.mjs'), '--check'], {
    cwd: tempDir(),
    timeout: 60000,
  });
  const result = JSON.parse(stdout.trim().split('\n').pop());
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.installed, []);
  assert.equal(nodeMajor(result.node) >= 20, true);
});
