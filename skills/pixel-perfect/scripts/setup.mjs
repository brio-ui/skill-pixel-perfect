// Checks and installs what the Pixel Perfect scripts need: Node 20+, npm deps, Playwright's Chromium.
// Usage: node setup.mjs [--check]
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { done, log, main } from './lib/io.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const MIN_NODE_MAJOR = 20;

export function nodeMajor(version) {
  return Number(String(version).replace(/^v/, '').split('.')[0]);
}

// Names of dependencies that are missing or not at the version pinned in package.json.
export function missingDeps(scriptsDir = SCRIPTS_DIR) {
  const pkg = JSON.parse(readFileSync(join(scriptsDir, 'package.json'), 'utf8'));
  const missing = [];
  for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
    const manifest = join(scriptsDir, 'node_modules', name, 'package.json');
    if (!existsSync(manifest)) {
      missing.push(name);
      continue;
    }
    const installed = JSON.parse(readFileSync(manifest, 'utf8')).version;
    if (installed !== version) missing.push(name);
  }
  return missing;
}

// Playwright's Chromium is ready when the binary it would launch exists.
export async function chromiumReady(scriptsDir = SCRIPTS_DIR) {
  const entry = pathToFileURL(join(scriptsDir, 'node_modules', 'playwright', 'index.mjs')).href;
  const { chromium } = await import(entry);
  return existsSync(chromium.executablePath());
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    // stdout stays clean for the JSON line; child output goes to stderr.
    // Node refuses to spawn a .cmd file on Windows without a shell. The args here are fixed words.
    const shell = process.platform === 'win32' && /\.cmd$/i.test(command);
    const child = spawn(command, args, { cwd, stdio: ['ignore', 2, 2], shell });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`))));
  });
}

// npm ci, falling back to npm install when ci fails (for example, no lockfile).
export async function installDeps(scriptsDir = SCRIPTS_DIR, exec = run) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    log('installing deps with npm ci');
    await exec(npm, ['ci'], scriptsDir);
  } catch (err) {
    log(`npm ci failed (${err.message}); trying npm install`);
    await exec(npm, ['install'], scriptsDir);
  }
}

export async function installChromium(scriptsDir = SCRIPTS_DIR, exec = run) {
  log('installing Chromium for Playwright');
  await exec(process.execPath, [join(scriptsDir, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium'], scriptsDir);
}

// Core of setup. Probes and installers are injected so tests can run it with fakes.
// Returns { ok, node, installed, missing }. Installs nothing when check is true.
export async function runSetup({
  check = false,
  nodeVersion = process.version,
  scriptsDir = SCRIPTS_DIR,
  probe = {
    deps: () => missingDeps(scriptsDir),
    chromium: () => chromiumReady(scriptsDir),
  },
  install = {
    deps: () => installDeps(scriptsDir),
    chromium: () => installChromium(scriptsDir),
  },
} = {}) {
  if (nodeMajor(nodeVersion) < MIN_NODE_MAJOR) {
    throw new Error(`Node ${nodeVersion} is too old. Pixel Perfect needs Node ${MIN_NODE_MAJOR} or later.`);
  }

  const installed = [];
  const depsMissing = await probe.deps();
  // Without deps, Playwright is absent, so Chromium cannot be ready either.
  let chromiumOk = depsMissing.length === 0 ? await probe.chromium() : false;
  const missing = [];
  if (depsMissing.length) missing.push('deps');
  if (!chromiumOk) missing.push('chromium');

  if (check || missing.length === 0) {
    return { ok: missing.length === 0, node: nodeVersion, installed, missing };
  }

  if (depsMissing.length) {
    await install.deps();
    installed.push('deps');
    if ((await probe.deps()).length) throw new Error(`Dependencies still missing after install: ${(await probe.deps()).join(', ')}`);
    chromiumOk = await probe.chromium();
  }
  if (!chromiumOk) {
    await install.chromium();
    installed.push('chromium');
    if (!(await probe.chromium())) throw new Error('Chromium still missing after install.');
  }
  return { ok: true, node: nodeVersion, installed, missing: [] };
}

const isEntry = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isEntry) {
  await main(async () => {
    const { values } = parseArgs({ options: { check: { type: 'boolean', default: false } } });
    done(await runSetup({ check: values.check }));
  });
}
