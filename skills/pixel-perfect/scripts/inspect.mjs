#!/usr/bin/env node
// Reads the work folder and prints what a fix needs: section boxes, the elements of one section,
// or the failures of the latest grade. Read only. Prints one JSON line.
//
//   node inspect.mjs [--work .pixel-perfect] [--section <id>] [--grade] [--round <n>]
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { done, main, readJson } from './lib/io.mjs';

const COLUMNS = ['key', 'tag', 'x', 'y', 'w', 'h', 'font', 'weight', 'color'];
const REGION_KEYS = 5; // original elements named per diff region
const LIST_CAP = 10; // geometry keys listed per kind

const numAsc = (a, b) => Number(a) - Number(b);
const widthKeys = (capture) => Object.keys(capture?.widths ?? {}).sort(numAsc);
const area = (box) => box.w * box.h;
const maxAbs = (delta) => Math.max(...Object.values(delta).map((v) => Math.abs(v)));

function need(path, hint) {
  if (!existsSync(path)) throw new Error(`Missing ${path}. ${hint}`);
  return readJson(path);
}

// Strict overlap, as in grade.mjs.
function boxIntersects(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function sectionIds(capture) {
  const ids = new Set();
  for (const w of widthKeys(capture)) for (const s of capture.widths[w].sections ?? []) ids.add(s.id);
  return [...ids];
}

function findSection(capture, width, id) {
  return (capture.widths[width]?.sections ?? []).find((s) => s.id === id) ?? null;
}

function knownOrThrow(ids, id) {
  if (!ids.includes(id)) throw new Error(`Unknown section id: ${id}. Known ids: ${ids.join(', ')}`);
  return id;
}

// Overview: each section's box at each width of the original capture.
function overview(original) {
  const widths = widthKeys(original);
  return {
    ok: true,
    widths: widths.map(Number),
    sections: sectionIds(original).map((id) => ({
      id,
      boxes: Object.fromEntries(
        widths.map((w) => {
          const sec = findSection(original, w, id);
          return [w, !sec || sec.missing ? 'missing' : sec.box];
        }),
      ),
    })),
  };
}

// One row per element: [key, tag, x, y, w, h, font, weight, color].
function elementRow(e) {
  const b = e.box ?? {};
  const st = e.style ?? {};
  return [
    e.key,
    e.tag ?? null,
    b.x ?? null,
    b.y ?? null,
    b.w ?? null,
    b.h ?? null,
    st.fontSize ? `${st.fontSize}/${st.lineHeight ?? 'normal'}` : null,
    st.fontWeight ?? null,
    st.color ?? null,
  ];
}

function sectionDetail(original, id) {
  const widths = {};
  for (const w of widthKeys(original)) {
    const sec = findSection(original, w, id);
    widths[w] =
      !sec || sec.missing
        ? { missing: true }
        : { box: sec.box, masks: sec.masks ?? [], elements: (sec.elements ?? []).map(elementRow) };
  }
  return { ok: true, section: id, columns: COLUMNS, widths };
}

// Original elements that overlap a diff region, smallest box first. Region boxes are relative to
// the section's top-left corner, as element boxes are.
function keysForRegion(original, width, sectionId, region) {
  const sec = findSection(original, width, sectionId);
  if (!sec || sec.missing) return [];
  return (sec.elements ?? [])
    .filter((e) => e.box && boxIntersects(e.box, region.box))
    .sort((a, b) => area(a.box) - area(b.box))
    .slice(0, REGION_KEYS)
    .map((e) => e.key);
}

function geometryDigest(g) {
  const failed = [...(g.failed ?? [])].sort((a, b) => maxAbs(b.delta) - maxAbs(a.delta));
  return {
    failedCount: failed.length,
    failed: failed.slice(0, LIST_CAP).map(({ key, delta }) => ({ key, delta })),
    missingCount: (g.missing ?? []).length,
    missing: (g.missing ?? []).slice(0, LIST_CAP).map((m) => m.key),
    extraCount: (g.extra ?? []).length,
    extra: (g.extra ?? []).slice(0, LIST_CAP).map((e) => e.key),
  };
}

// One section of the grade: failing widths only, plus its failing states, geometry widths, motion and reduced checks.
function sectionDigest(original, sec) {
  const widths = [];
  for (const w of Object.keys(sec.widths).sort(numAsc)) {
    const r = sec.widths[w];
    if (r.pass) continue;
    if (r.missing) {
      widths.push({ width: Number(w), missing: true });
      continue;
    }
    const entry = {
      width: Number(w),
      size: `original ${r.size.original.w}x${r.size.original.h} against clone ${r.size.clone.w}x${r.size.clone.h}`,
    };
    if (!r.masks.pass) entry.mask = { pct: r.masks.pct, reason: r.masks.reason ?? 'mask-cap' };
    entry.pixel = r.pixel.skipped
      ? `skipped: ${r.pixel.skipped}`
      : {
          diffPct: r.pixel.diffPct,
          regions: (r.pixel.regions ?? []).map((g) => ({
            box: g.box,
            pixels: g.pixels,
            keys: keysForRegion(original, Number(w), sec.id, g),
          })),
        };
    if (!r.geometry.pass) entry.geometry = geometryDigest(r.geometry);
    entry.hints = r.hints ?? [];
    widths.push(entry);
  }
  return {
    id: sec.id,
    pass: sec.pass,
    score: sec.score,
    next: sec.next,
    fallbacks: sec.fallbacks,
    failCount: sec.failCount,
    widths,
    states: sec.states.filter((s) => !s.pass),
    geometryWidths: sec.geometryWidths.filter((g) => !g.pass),
    motion: sec.motion.filter((m) => !m.pass),
    reduced: sec.reduced.filter((r) => !r.pass),
  };
}

function latestRound(gradeDir, value) {
  if (value !== undefined) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) throw new Error(`Bad --round value: ${value}`);
    return n;
  }
  const rounds = existsSync(gradeDir)
    ? readdirSync(gradeDir)
        .map((name) => /^round-(\d+)$/.exec(name))
        .filter(Boolean)
        .map((m) => Number(m[1]))
    : [];
  if (!rounds.length) throw new Error(`No round-<n> folder in ${gradeDir}. Run round.mjs or grade.mjs first.`);
  return Math.max(...rounds);
}

main(async () => {
  const { values } = parseArgs({
    options: {
      work: { type: 'string', default: '.pixel-perfect' },
      section: { type: 'string' },
      grade: { type: 'boolean', default: false },
      round: { type: 'string' },
    },
    strict: true,
  });
  const work = resolve(values.work);
  const original = need(join(work, 'original', 'capture.json'), 'Run capture.mjs first to create it.');

  if (!values.grade) {
    if (values.round !== undefined) throw new Error('--round needs --grade');
    if (values.section === undefined) return done(overview(original));
    return done(sectionDetail(original, knownOrThrow(sectionIds(original), values.section)));
  }

  const gradeDir = join(work, 'grade');
  const round = latestRound(gradeDir, values.round);
  const grade = need(join(gradeDir, `round-${round}`, 'grade.json'), 'Run round.mjs or grade.mjs first to create it.');
  const sections = values.section === undefined
    ? grade.sections.filter((s) => !s.pass)
    : [grade.sections.find((s) => s.id === knownOrThrow(grade.sections.map((s) => s.id), values.section))];

  done({
    ok: true,
    round,
    pass: grade.pass,
    score: grade.score,
    sections: sections.map((sec) => sectionDigest(original, sec)),
    unassigned: grade.unassigned ?? [],
  });
});
