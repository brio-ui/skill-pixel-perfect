// Reads one eval results folder and checks the launch bar.
// Usage: node evals/summarize.mjs evals/results/<date>
import { existsSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { done, log, main, readJson } from '../skills/pixel-perfect/scripts/lib/io.mjs';

export const BAR = Object.freeze({ pages: 12, staticPass: 10, motionPass: 8, medianMinutes: 45 });

export function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Build the summary from per-site records. A site with no report counts as failing both gates.
// barMet needs exactly 12 pages; a different count is noted and the bar fails.
export function summarize(sites) {
  const rows = sites.map((s) => ({
    site: s.site,
    staticPass: Boolean(s.report?.staticPass),
    motionPass: Boolean(s.report?.motionPass),
    minutes: Number.isFinite(s.run?.minutes) ? s.run.minutes : null,
    hasReport: Boolean(s.report),
  }));
  const pages = rows.length;
  const staticPass = rows.filter((r) => r.staticPass).length;
  const motionPass = rows.filter((r) => r.motionPass).length;
  const medianMinutes = median(rows.map((r) => r.minutes));
  const notes = [];
  if (pages !== BAR.pages) notes.push(`expected ${BAR.pages} pages, found ${pages}; bar cannot pass`);
  const missing = rows.filter((r) => !r.hasReport).map((r) => r.site);
  if (missing.length) notes.push(`no report.json for: ${missing.join(', ')}; counted as failing both gates`);
  const barMet =
    pages === BAR.pages &&
    staticPass >= BAR.staticPass &&
    motionPass >= BAR.motionPass &&
    medianMinutes !== null &&
    medianMinutes < BAR.medianMinutes;
  return { pages, staticPass, motionPass, medianMinutes, barMet, bar: BAR, notes, sites: rows };
}

export function renderMarkdown(s) {
  const minutes = s.medianMinutes === null ? '-' : s.medianMinutes;
  const lines = [
    '# Eval summary',
    '',
    `Launch bar: ${s.barMet ? 'met' : 'not met'}`,
    '',
    '| Measure | Result | Bar |',
    '| --- | --- | --- |',
    `| Pages | ${s.pages} | ${BAR.pages} |`,
    `| Static pass | ${s.staticPass} | at least ${BAR.staticPass} |`,
    `| Motion pass | ${s.motionPass} | at least ${BAR.motionPass} |`,
    `| Median minutes | ${minutes} | under ${BAR.medianMinutes} |`,
    '',
    '| Site | Static | Motion | Minutes |',
    '| --- | --- | --- | --- |',
    ...s.sites.map((r) => `| ${r.site} | ${r.staticPass ? 'pass' : 'fail'} | ${r.motionPass ? 'pass' : 'fail'} | ${r.minutes ?? '-'} |`),
  ];
  if (s.notes.length) lines.push('', 'Notes:', ...s.notes.map((n) => `- ${n}`));
  return `${lines.join('\n')}\n`;
}

function siteFolders(dir) {
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort();
}

function isEntryPoint() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function run() {
  const { positionals } = parseArgs({ allowPositionals: true, options: {} });
  if (positionals.length !== 1) throw new Error('Usage: node evals/summarize.mjs evals/results/<date>');
  const dir = resolve(positionals[0]);
  if (!existsSync(dir)) throw new Error(`Results folder not found: ${dir}`);

  log(`summarising ${dir}`);
  const sites = siteFolders(dir).map((site) => {
    const folder = join(dir, site);
    return {
      site,
      run: readJson(join(folder, 'run.json'), null),
      report: readJson(join(folder, 'report.json'), null),
    };
  });

  const summary = summarize(sites);
  writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(dir, 'summary.md'), renderMarkdown(summary));

  done(
    {
      ok: true,
      pages: summary.pages,
      staticPass: summary.staticPass,
      motionPass: summary.motionPass,
      medianMinutes: summary.medianMinutes,
      barMet: summary.barMet,
    },
    summary.barMet ? 0 : 2,
  );
}

if (isEntryPoint()) main(run);
