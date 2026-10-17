// Writes the report the user keeps: index.html, report.json, assets.json and img/ from the latest grade round.
import { copyFileSync, existsSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { done, ensureDir, fileSlug, log, main, readJson, writeJson } from './lib/io.mjs';

const CUTOVER_LINE = 'Full-site migration from Brio is planned. Follow updates at brioui.com.';

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Rounds with a grade.json. A round folder left by a crashed grade run is skipped.
function existingRounds(gradeDir) {
  if (!existsSync(gradeDir)) return [];
  return readdirSync(gradeDir)
    .map((name) => /^round-(\d+)$/.exec(name))
    .filter((m) => m && existsSync(join(gradeDir, m[0], 'grade.json')))
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

const widthOrder = (keys) => [...keys].sort((a, b) => Number(a) - Number(b));

// Same rule as grade.mjs: 100 minus diffPct, or 0 when the pixel diff was skipped.
function widthScore(r) {
  if (!r.pixel || r.pixel.skipped) return 0;
  return Math.round((100 - r.pixel.diffPct) * 100) / 100;
}

// Static checks for one section. A section on a fallback counts only when these pass.
function staticChecksPass(sec) {
  return (
    Object.values(sec.widths).every((r) => r.pass) &&
    sec.states.every((s) => s.pass) &&
    sec.geometryWidths.every((g) => g.pass)
  );
}

// Build report.json data. Pure apart from reading the optional assets and cutover files.
export function buildReportData({ grade, history, original, clone, assets, cutover }) {
  // data-pp-fallback values from the clone capture, per section id.
  const cloneFallback = new Map();
  for (const w of Object.keys(clone.widths ?? {})) {
    for (const s of clone.widths[w].sections ?? []) {
      const used = cloneFallback.get(s.id) ?? new Set();
      for (const f of s.fallback ?? []) used.add(f);
      cloneFallback.set(s.id, used);
    }
  }

  const sections = grade.sections.map((sec) => {
    const widths = {};
    for (const [w, r] of Object.entries(sec.widths)) {
      widths[w] = { pass: r.pass, diffPct: r.pixel?.diffPct ?? null };
    }
    return {
      id: sec.id,
      pass: sec.pass,
      score: sec.score,
      next: sec.next,
      fallbacksUsed: [...(cloneFallback.get(sec.id) ?? [])],
      widths,
    };
  });

  const staticPass = grade.sections.length > 0 && grade.sections.every(staticChecksPass);
  const motionChecks = grade.sections.flatMap((sec) => [...sec.motion, ...sec.reduced]);
  const motionPass = motionChecks.every((c) => c.pass);

  const masks = [];
  for (const sec of grade.sections) {
    for (const [w, r] of Object.entries(sec.widths)) {
      if (r.masks && (r.masks.pct > 0 || !r.masks.pass)) {
        const reason = (r.masks.sources ?? []).join(', ') || 'none';
        masks.push({ section: sec.id, width: Number(w), reason, pct: r.masks.pct, pass: r.masks.pass });
      }
    }
  }

  let assetSummary = null;
  if (assets) {
    const list = assets.assets ?? [];
    assetSummary = {
      saved: list.filter((a) => a.status === 'saved').length,
      remote: list.filter((a) => a.status === 'remote').length,
      skipped: list.filter((a) => a.status === 'skipped').length,
      flagged: list.filter((a) => a.flag).length,
      flags: list
        .filter((a) => a.flag)
        .map((a) => ({ url: a.url, class: a.license?.class ?? null, note: a.note ?? a.license?.note ?? null })),
    };
  }

  return {
    url: original.url,
    date: new Date().toISOString(),
    round: grade.round,
    pass: staticPass && motionPass,
    staticPass,
    motionPass,
    score: grade.score,
    rounds: history,
    sections,
    fallbacks: grade.sections
      .filter((sec) => sec.next === 'fallback' || sec.fallbacks.length || cloneFallback.get(sec.id)?.size)
      .map((sec) => ({
        section: sec.id,
        next: sec.next,
        grade: sec.fallbacks,
        used: [...(cloneFallback.get(sec.id) ?? [])],
      })),
    masks,
    assets: assetSummary,
    cutover,
  };
}

// Page HTML. Inline CSS only; images come from img/; no links, scripts or remote requests.
export function renderHtml({ data, grade, original, clone, assets, diffImages, cropImages, motionRows }) {
  const e = esc;
  const widths = widthOrder(new Set(grade.sections.flatMap((s) => Object.keys(s.widths))));
  const result = data.pass ? 'PASS' : 'FAIL';

  const sectionRows = grade.sections
    .map((sec) => {
      const cells = widths
        .map((w) => {
          const r = sec.widths[w];
          if (!r) return '<td class="muted">skipped</td>';
          if (r.missing) return `<td class="fail">missing, 0</td>`;
          return `<td class="${r.pass ? 'pass' : 'fail'}">${r.pass ? 'pass' : 'fail'}, ${widthScore(r)}</td>`;
        })
        .join('');
      const next = sec.next === 'done' ? 'done' : sec.next;
      return `<tr><th>${e(sec.id)}</th><td class="${sec.pass ? 'pass' : 'fail'}">${sec.pass ? 'PASS' : 'FAIL'}</td><td>${e(sec.score ?? '-')}</td><td>${e(next)}</td>${cells}</tr>`;
    })
    .join('');

  const fallbackItems = data.sections.filter((s) => s.next === 'fallback' || s.fallbacksUsed.length);
  const fallbackHtml = fallbackItems.length
    ? `<ul>${fallbackItems
        .map((s) => `<li>${e(s.id)}: next ${e(s.next)}, built with ${s.fallbacksUsed.length ? e(s.fallbacksUsed.join(', ')) : 'no fallback'}</li>`)
        .join('')}</ul>`
    : '<p>None.</p>';

  const maskHtml = data.masks.length
    ? `<table><tr><th>Section</th><th>Width</th><th>Reasons</th><th>Coverage</th><th>Cap</th></tr>${data.masks
        .map((m) => `<tr><td>${e(m.section)}</td><td>${e(m.width)}</td><td>${e(m.reason)}</td><td>${e(m.pct)}%</td><td class="${m.pass ? 'pass' : 'fail'}">${m.pass ? 'ok' : 'over cap'}</td></tr>`)
        .join('')}</table>`
    : '<p>No masks.</p>';

  const stateRows = grade.sections.flatMap((sec) => sec.states.map((st) => ({ ...st, section: sec.id })));
  const stateHtml = stateRows.length
    ? `<table><tr><th>State</th><th>Section</th><th>Width</th><th>Result</th><th>Diff %</th><th>Geometry misses</th><th>Diff</th></tr>${stateRows
        .map((st) => {
          const img = st.diffPng && diffImages.get(st.diffPng);
          return `<tr><td>${e(st.id)}</td><td>${e(st.section)}</td><td>${e(st.width)}</td><td class="${st.pass ? 'pass' : 'fail'}">${st.pass ? 'pass' : 'fail'}${st.note ? ` (${e(st.note)})` : ''}${st.missing ? ' (missing in clone)' : ''}</td><td>${e(st.diffPct ?? '-')}</td><td>${e(st.geometryFailed ?? '-')}</td><td>${img ? `<img src="${e(img)}" alt="Diff for state ${e(st.id)} at ${e(st.width)}px" loading="lazy">` : ''}</td></tr>`;
        })
        .join('')}</table>`
    : '<p>No states.</p>';

  const motionHtml = motionRows.length
    ? motionRows
        .map((row) => {
          const frames = row.frames
            .map((f) => `<tr><td>${e(f.pct)}%</td><td>${f.orig ? `<img src="${e(f.orig)}" alt="Original at ${e(f.pct)}%" loading="lazy">` : 'no frame'}</td><td>${f.clone ? `<img src="${e(f.clone)}" alt="Clone at ${e(f.pct)}%" loading="lazy">` : 'no frame'}</td></tr>`)
            .join('');
          return `<article><h3>${e(row.id)} at ${e(row.width)}px: ${row.pass ? 'pass' : 'fail'}</h3><p>Max deviation ${e(row.maxPx ?? '-')} px, max opacity ${e(row.maxOpacity ?? '-')}, start delta ${e(row.startDeltaMs ?? '-')} ms, end delta ${e(row.endDeltaMs ?? '-')} ms.${row.note ? ` ${e(row.note)}.` : ''}</p><table><tr><th>Trace</th><th>Original</th><th>Clone</th></tr>${frames}</table></article>`;
        })
        .join('')
    : '<p>No motion checks.</p>';

  const geometryRows = [];
  for (const sec of grade.sections) {
    for (const [w, r] of Object.entries(sec.widths)) {
      for (const f of r.geometry?.failed ?? []) geometryRows.push([sec.id, w, f.key, `delta x ${f.delta.x}, y ${f.delta.y}, w ${f.delta.w}, h ${f.delta.h}`]);
      for (const m of r.geometry?.missing ?? []) {
        geometryRows.push([sec.id, w, typeof m === 'string' ? m : m.key, 'missing in clone']);
      }
    }
  }
  const geometryHtml = geometryRows.length
    ? `<table><tr><th>Section</th><th>Width</th><th>Element</th><th>Miss</th></tr>${geometryRows
        .map((row) => `<tr>${row.map((cell) => `<td>${e(cell)}</td>`).join('')}</tr>`)
        .join('')}</table>`
    : '<p>No geometry misses.</p>';

  const assetRows = assets?.assets ?? [];
  const assetHtml = data.assets
    ? `<p>Saved ${e(data.assets.saved)}, remote ${e(data.assets.remote)}, skipped ${e(data.assets.skipped)}, flagged ${e(data.assets.flagged)}.</p><table><tr><th>Kind</th><th>Status</th><th>License</th><th>Flag</th><th>URL</th></tr>${assetRows
        .map((a) => `<tr><td>${e(a.kind)}</td><td>${e(a.status)}</td><td>${e(a.license?.class ?? '-')}</td><td class="${a.flag ? 'fail' : 'pass'}">${a.flag ? 'yes' : 'no'}</td><td><code>${e(a.url)}</code>${a.note || a.license?.note ? `<br>${e(a.note ?? a.license?.note)}` : ''}</td></tr>`)
        .join('')}</table>`
    : '<p>No asset manifest.</p>';

  const scripts = assets?.scripts ?? [];
  const cutoverDone = Boolean(data.cutover?.done);
  const scriptsHtml = scripts.length
    ? `<ul>${scripts
        .map((s) => `<li>${e(s.host)} (${e(s.category)}): ${cutoverDone ? 'included after cutover' : 'left out until cutover'}</li>`)
        .join('')}</ul>`
    : '<p>No third-party scripts found.</p>';

  const historyHtml = data.rounds.length
    ? `<table><tr><th>Round</th><th>Score</th><th>Result</th></tr>${data.rounds
        .map((r) => `<tr><td>${e(r.round)}</td><td>${e(r.score)}</td><td>${r.pass ? 'pass' : 'fail'}</td></tr>`)
        .join('')}</table>`
    : '<p>No rounds.</p>';

  const diffHtml = diffImages.size
    ? [...diffImages.entries()]
        .map(([, src]) => `<figure><img src="${e(src)}" alt="Pixel diff ${e(basename(src))}" loading="lazy"><figcaption>${e(basename(src))}</figcaption></figure>`)
        .join('')
    : '<p>No diff images.</p>';

  const cropHtml = cropImages.length
    ? cropImages
        .map((c) => `<figure><figcaption>${e(c.label)}</figcaption><img src="${e(c.src)}" alt="${e(c.label)}" loading="lazy"></figure>`)
        .join('')
    : '<p>No crops. Every section passes or uses no fallback.</p>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pixel Perfect report</title>
<style>
body { font: 15px/1.5 system-ui, sans-serif; margin: 0; background: #f7f7f5; color: #1c1c1a; }
main { max-width: 1100px; margin: 0 auto; padding: 32px 20px 64px; }
h1 { font-size: 26px; margin: 0 0 6px; }
h2 { font-size: 19px; margin: 36px 0 12px; border-bottom: 1px solid #d8d8d2; padding-bottom: 6px; }
h3 { font-size: 16px; margin: 20px 0 6px; }
table { border-collapse: collapse; width: 100%; background: #fff; margin: 8px 0; }
th, td { border: 1px solid #e0e0da; padding: 6px 8px; text-align: left; vertical-align: top; font-size: 13px; }
th { background: #efefeb; font-weight: 600; }
img { max-width: 100%; height: auto; display: block; border: 1px solid #d8d8d2; background: #fff; }
figure { margin: 8px 0; }
figcaption { font-size: 12px; color: #55554f; margin-top: 4px; }
.result { padding: 14px 16px; border-radius: 6px; background: #fff; border: 1px solid #d8d8d2; }
.pass { color: #1b6b35; }
.fail { color: #a11d1d; font-weight: 600; }
.muted { color: #77776f; }
.meta { color: #55554f; font-size: 13px; margin: 0; }
code { font-size: 12px; word-break: break-all; }
footer { margin-top: 48px; font-size: 13px; color: #55554f; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<main>
<header>
<h1>Pixel Perfect report</h1>
<p class="meta">Source: <code>${e(data.url)}</code></p>
<p class="meta">Date: ${e(data.date)}. Grade round ${e(data.round)}.</p>
</header>

<section class="result">
<h2>Page result: <span class="${data.pass ? 'pass' : 'fail'}">${result}</span></h2>
<p>Score ${e(data.score ?? '-')}. Static: ${data.staticPass ? 'pass' : 'fail'}. Motion: ${data.motionPass ? 'pass' : 'fail'}. A section on a fallback counts toward static only when it passes.</p>
</section>

<h2>Score by section and width</h2>
<table>
<tr><th>Section</th><th>Result</th><th>Score</th><th>Next</th>${widths.map((w) => `<th>${e(w)}px</th>`).join('')}</tr>
${sectionRows}
</table>

<h2>Fallbacks</h2>
${fallbackHtml}

<h2>Masks</h2>
${maskHtml}

<h2>States</h2>
${stateHtml}

<h2>Motion</h2>
${motionHtml}

<h2>Geometry misses</h2>
${geometryHtml}

<h2>Assets</h2>
${assetHtml}

<h2>Third-party scripts</h2>
${scriptsHtml}

<h2>Score history</h2>
${historyHtml}

<h2>Pixel diffs</h2>
<div class="grid">${diffHtml}</div>

<h2>Original and clone crops</h2>
<div class="grid">${cropHtml}</div>

<footer>
<p>${e(CUTOVER_LINE)}</p>
</footer>
</main>
</body>
</html>
`;
}

function isEntryPoint() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function run() {
  const { values } = parseArgs({
    options: {
      grade: { type: 'string', default: '.pixel-perfect/grade' },
      original: { type: 'string', default: '.pixel-perfect/original' },
      clone: { type: 'string', default: '.pixel-perfect/clone' },
      assets: { type: 'string', default: '.pixel-perfect/assets.json' },
      cutover: { type: 'string', default: '.pixel-perfect/cutover.json' },
      out: { type: 'string', default: 'pixel-perfect-report' },
    },
  });

  const rounds = existingRounds(values.grade);
  if (!rounds.length) throw new Error(`No round-<n> folders in ${values.grade}`);
  const current = rounds[rounds.length - 1];
  log(`building report from round ${current}`);

  const roundDir = join(values.grade, `round-${current}`);
  const grade = readJson(join(roundDir, 'grade.json'));
  const history = rounds.map((k) => {
    const g = readJson(join(values.grade, `round-${k}`, 'grade.json'));
    return { round: k, score: g.score, pass: g.pass };
  });
  const original = readJson(join(values.original, 'capture.json'));
  const clone = readJson(join(values.clone, 'capture.json'));
  const assets = readJson(values.assets, null);
  const cutover = readJson(values.cutover, null) ?? { done: false, status: 'pending' };

  const data = buildReportData({ grade, history, original, clone, assets, cutover });

  // img/: diffs of this round, crops for failed or fallback sections, and motion frames from both captures.
  const imgDir = ensureDir(join(values.out, 'img'));
  const copyTo = (src, name) => {
    if (!src || !existsSync(src)) return null;
    copyFileSync(src, join(imgDir, name));
    return `img/${name}`;
  };

  const diffImages = new Map();
  const diffDir = join(roundDir, 'diff');
  if (existsSync(diffDir)) {
    for (const file of readdirSync(diffDir).filter((f) => f.endsWith('.png')).sort()) {
      const src = copyTo(join(diffDir, file), `diff-${file}`);
      diffImages.set(`diff/${file}`, src);
    }
  }

  const cropImages = [];
  for (const sec of grade.sections) {
    if (sec.pass && !sec.fallbacks.length && sec.next !== 'fallback') continue;
    for (const w of Object.keys(sec.widths)) {
      const oSec = original.widths[w]?.sections?.find((s) => s.id === sec.id);
      const cSec = clone.widths[w]?.sections?.find((s) => s.id === sec.id);
      const o = oSec?.png ? copyTo(join(values.original, oSec.png), `crop-original-${sec.id}-${w}.png`) : null;
      const c = cSec?.png ? copyTo(join(values.clone, cSec.png), `crop-clone-${sec.id}-${w}.png`) : null;
      if (o) cropImages.push({ label: `${sec.id} at ${w}px, original`, src: o });
      if (c) cropImages.push({ label: `${sec.id} at ${w}px, clone`, src: c });
    }
  }

  const motionRows = [];
  for (const sec of grade.sections) {
    for (const m of sec.motion) {
      const w = String(m.width);
      const oe = original.widths[w]?.motion?.find((x) => x.id === m.id);
      const ce = clone.widths[w]?.motion?.find((x) => x.id === m.id);
      const frames = ['0', '50', '100'].map((pct) => {
        const oSrc = oe?.frames?.[pct];
        const cSrc = ce?.frames?.[pct];
        const stem = `${fileSlug(m.id)}-${w}-${pct}`;
        return {
          pct,
          orig: oSrc ? copyTo(join(values.original, oSrc), `motion-original-${stem}.png`) : null,
          clone: cSrc ? copyTo(join(values.clone, cSrc), `motion-clone-${stem}.png`) : null,
        };
      });
      motionRows.push({ id: m.id, width: m.width, pass: m.pass, maxPx: m.maxPx, maxOpacity: m.maxOpacity, startDeltaMs: m.startDeltaMs, endDeltaMs: m.endDeltaMs, note: m.note, frames });
    }
  }

  if (assets) writeJson(join(values.out, 'assets.json'), assets);
  writeJson(join(values.out, 'report.json'), data);
  const liveDiffs = new Map([...diffImages].filter(([, src]) => src));
  writeFileSync(
    join(values.out, 'index.html'),
    renderHtml({ data, grade, original, clone, assets, diffImages: liveDiffs, cropImages, motionRows }),
  );

  done({ ok: true, out: values.out, pass: data.pass, score: data.score, round: current });
}

if (isEntryPoint()) main(run);
