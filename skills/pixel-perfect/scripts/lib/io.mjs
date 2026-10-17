// Shared helpers for the Pixel Perfect scripts.
// Every script writes progress to stderr and ends by printing one JSON line to stdout.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_WIDTHS = Object.freeze([1440, 768, 390]);
export const VIEWPORT_HEIGHTS = Object.freeze({ 1440: 900, 768: 1024, 390: 844 });
export const FROZEN_TIME = '2026-01-01T12:00:00.000Z';
// Section and state ids in plan.json. Motion ids are "<kind>:<id>".
export const ID_RE = /^[a-z0-9-]{1,40}$/;

// Gate numbers. grade.mjs and report.mjs read them from here; the docs quote them.
export const GATE = Object.freeze({
  pixelPct: 1.0, // max share of differing pixels per section and width, in percent
  aaThreshold: 0.1, // pixelmatch colour threshold
  boxPx: 2, // max drift of an element box (x, y, w, h) relative to its section
  heightPx: 2, // max section height drift before the pixel diff is skipped
  maskCapPct: 15, // max share of a section that masks may cover
  motionPx: 2, // max position or size deviation per motion sample
  motionOpacity: 0.05, // max opacity deviation per motion sample
  motionMs: 50, // max difference in motion start and end
  motionStepMs: 50, // sample interval for motion traces
  maxFixRounds: 3, // fix rounds after the first build (rounds 1 to 3)
  plateauPoints: 0.2, // a round that gains less than this counts as flat
  plateauRounds: 2, // this many flat rounds in a row ends the fix loop
});

export function viewportFor(width) {
  return { width, height: VIEWPORT_HEIGHTS[width] ?? 900 };
}

export function parseWidths(value) {
  if (value === undefined || value === null || value === '') return [...DEFAULT_WIDTHS];
  const widths = String(value)
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!widths.length) throw new Error(`Bad --widths value: ${value}`);
  return widths;
}

// Normalize a --url value. Only http and https pages are captured (references/assets-legal.md).
export function httpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Bad --url value: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`--url must be an http or https URL, got ${url.protocol}`);
  }
  return url.href;
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(path, fallback) {
  if (!existsSync(path)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`File not found: ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeJson(path, data) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

export function log(...parts) {
  console.error('[pixel-perfect]', ...parts);
}

// Print the summary line. Exit code 0 = done, 2 = done but the gate failed.
export function done(summary, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  process.exitCode = exitCode;
}

// Wrap a script's entry point so any error ends as {"ok":false,"error":...} with exit code 1.
export async function main(fn) {
  try {
    await fn();
  } catch (err) {
    log(err?.stack ?? String(err));
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(err?.message ?? err) })}\n`);
    process.exitCode = 1;
  }
}

export function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

// Key used to match a text element between the original and the clone.
// Repeated keys stay repeated; grade.mjs pairs them by nearest box.
// lib/collect.mjs computes the same key inside the page.
export function textKey(value) {
  return `t:${normalizeText(value).toLowerCase().slice(0, 80)}`;
}

// Slug used in file names: "scroll:features" -> "scroll-features".
export function fileSlug(id) {
  return String(id)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
