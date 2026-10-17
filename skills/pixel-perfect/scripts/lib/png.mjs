// PNG helpers shared by capture (cropping) and grade (diffing).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PNG } from 'pngjs';
import { ensureDir } from './io.mjs';

export { PNG };

export function readPng(path) {
  return PNG.sync.read(readFileSync(path));
}

export function writePng(path, png) {
  ensureDir(dirname(path));
  writeFileSync(path, PNG.sync.write(png));
}

// Round a box to whole pixels and clamp it to the image. Returns null when nothing is left.
export function clampBox(png, box) {
  const x = Math.max(0, Math.round(box.x));
  const y = Math.max(0, Math.round(box.y));
  const w = Math.min(png.width - x, Math.round(box.w));
  const h = Math.min(png.height - y, Math.round(box.h));
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

// Copy a rectangle out of a PNG. Returns null for an empty or out-of-bounds box.
export function cropPng(src, box) {
  const area = clampBox(src, box);
  if (!area) return null;
  const out = new PNG({ width: area.w, height: area.h });
  for (let row = 0; row < area.h; row++) {
    const start = ((area.y + row) * src.width + area.x) * 4;
    src.data.copy(out.data, row * area.w * 4, start, start + area.w * 4);
  }
  return out;
}

// Paint boxes one flat colour so they drop out of a pixel diff. Returns the painted pixel count.
export function paintBoxes(png, boxes, rgba = [255, 0, 255, 255]) {
  const painted = new Uint8Array(png.width * png.height);
  for (const box of boxes) {
    const area = clampBox(png, box);
    if (!area) continue;
    for (let y = area.y; y < area.y + area.h; y++) {
      for (let x = area.x; x < area.x + area.w; x++) {
        const i = y * png.width + x;
        painted[i] = 1;
        png.data[i * 4] = rgba[0];
        png.data[i * 4 + 1] = rgba[1];
        png.data[i * 4 + 2] = rgba[2];
        png.data[i * 4 + 3] = rgba[3];
      }
    }
  }
  return painted.reduce((sum, v) => sum + v, 0);
}
