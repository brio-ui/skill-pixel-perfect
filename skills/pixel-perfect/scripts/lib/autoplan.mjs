// Auto plan, page preparation and pixel helpers for capture.mjs.
// buildPlan turns what detectPage found into a plan.json object. liveTiles and changedBox
// compare two PNGs. prepareStatic brings a page to the still frame every static capture uses.
import pixelmatch from 'pixelmatch';
import { GATE, ID_RE } from './io.mjs';
import { advance, autoScroll, closeConsent, scrollToY, settle, waitForFonts } from './browser.mjs';

const KINDS = ['load', 'scroll', 'hover', 'click', 'loop', 'scrub'];
const ACTIONS = ['click', 'hover', 'focus'];
const MAX_BREAKPOINTS = 6;
const MIN_PX = 320;
const MAX_PX = 1920;

// Bring a loaded page (clock paused) to the still frame: close consent, scroll through it so
// lazy content and reveals load, return to the top, then settle. Returns { consent }.
export async function prepareStatic(page) {
  const consent = await closeConsent(page);
  await advance(page, 2000);
  await autoScroll(page);
  await waitForFonts(page);
  await scrollToY(page, 0);
  await advance(page, 3000);
  await settle(page);
  return { consent };
}

// Read the page for an auto plan. Runs in the page; call it on a loaded page before prepareStatic,
// so CSS animations that started at load are still visible. Boxes are document coordinates.
// Returns { candidates, breakpoints }.
export async function detectPage(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width >= 1 && r.height >= 1 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const docBox = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
    };
    const pathOf = (el) => {
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && node !== document.documentElement) {
        if (node.id && /^[A-Za-z][\w-]*$/.test(node.id) && document.querySelectorAll(`#${node.id}`).length === 1) {
          parts.unshift(`#${node.id}`);
          break;
        }
        let part = node.localName;
        if (node.parentElement) {
          const sameTag = [...node.parentElement.children].filter((c) => c.localName === node.localName);
          if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
        }
        parts.unshift(part);
        node = node.parentElement;
      }
      return parts.join(' > ');
    };
    const text = (el) => (el ? el.innerText || el.textContent || '' : '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const skip = new Set(['SCRIPT', 'STYLE', 'LINK', 'NOSCRIPT', 'TEMPLATE', 'HEADER', 'FOOTER', 'META']);

    const headers = [...document.querySelectorAll('header')].filter((h) => !h.closest('main') && visible(h));
    const footers = [...document.querySelectorAll('footer')].filter((f) => !f.closest('main') && visible(f));
    const container = document.querySelector('main') ?? document.body;
    const middle = [...container.children].filter(
      (el) => !skip.has(el.tagName) && visible(el) && getComputedStyle(el).position !== 'fixed' && docBox(el).h >= 40,
    );
    const ordered = [...headers.slice(0, 1), ...middle, ...footers.slice(0, 1)];
    const seen = new Set();
    const candidates = [];
    for (const el of ordered) {
      if (seen.has(el)) continue;
      seen.add(el);
      const anims = document.getAnimations().filter((a) => a.effect?.target && el.contains(a.effect.target));
      let cssLoopMs = 0;
      let cssFinite = false;
      for (const a of anims) {
        const t = a.effect.getComputedTiming();
        if (t.iterations === Infinity) {
          if (Number.isFinite(t.duration) && t.duration > cssLoopMs) cssLoopMs = t.duration;
        } else if (a.playState === 'running') {
          cssFinite = true;
        }
      }
      const hoverEl = [...el.querySelectorAll('a[href], button')].find(visible);
      const clickEl = el.querySelector('button[aria-controls]');
      candidates.push({
        tag: el.localName,
        id: el.id || '',
        heading: text(el.querySelector('h1, h2, h3')),
        selector: pathOf(el),
        box: docBox(el),
        cssLoopMs: Math.round(cssLoopMs),
        cssFinite,
        hover: hoverEl && el.tagName !== 'HEADER' ? pathOf(hoverEl) : null,
        click: clickEl ? { selector: pathOf(clickEl), visible: visible(clickEl) } : null,
      });
    }

    const counts = new Map();
    const walk = (rules) => {
      for (const rule of rules) {
        const media = rule.conditionText ?? rule.media?.mediaText ?? '';
        if (rule.media || rule.conditionText !== undefined) {
          for (const m of media.matchAll(/(min|max)-width:\s*(\d+(?:\.\d+)?)px/g)) {
            const px = Number(m[2]);
            const key = `${m[1]}:${px}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
        }
        if (rule.cssRules) walk([...rule.cssRules]);
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        walk([...sheet.cssRules]);
      } catch {
        // Cross-origin sheets cannot be read from the page; they are not used for geometry widths.
      }
    }
    const breakpoints = [...counts].map(([key, count]) => {
      const [kind, px] = key.split(':');
      return { kind, px: Number(px), count };
    });
    return { candidates, breakpoints };
  });
}

// Changed tiles between two full-page PNGs, merged into boxes in page coordinates.
// A pixel counts as changed when its channels differ by more than threshold in sum.
// Pixels outside one image (different page heights) count as changed.
export function liveTiles(a, b, { tile = 32, threshold = 24 } = {}) {
  const W = Math.max(a.width, b.width);
  const H = Math.max(a.height, b.height);
  const tileChanged = (x0, y0) => {
    const x1 = Math.min(W, x0 + tile);
    const y1 = Math.min(H, y0 + tile);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (x >= a.width || y >= a.height || x >= b.width || y >= b.height) return true;
        const i = (y * a.width + x) * 4;
        const j = (y * b.width + x) * 4;
        const d =
          Math.abs(a.data[i] - b.data[j]) + Math.abs(a.data[i + 1] - b.data[j + 1]) + Math.abs(a.data[i + 2] - b.data[j + 2]);
        if (d > threshold) return true;
      }
    }
    return false;
  };
  const boxes = [];
  for (let y0 = 0; y0 < H; y0 += tile) {
    const row = y0 / tile;
    const h = Math.min(H, y0 + tile) - y0;
    let runStart = -1;
    const flush = (endX) => {
      if (runStart < 0) return;
      const x = runStart * tile;
      const w = Math.min(W, endX * tile) - x;
      const above = boxes.find((bx) => bx.x === x && bx.w === w && bx.y + bx.h === y0 && bx.row === row - 1);
      if (above) {
        above.h += h;
        above.row = row;
      } else {
        boxes.push({ x, y: y0, w, h, row });
      }
      runStart = -1;
    };
    const cols = Math.ceil(W / tile);
    for (let col = 0; col < cols; col++) {
      if (tileChanged(col * tile, y0)) {
        if (runStart < 0) runStart = col;
      } else {
        flush(col);
      }
    }
    flush(cols);
  }
  return boxes.map(({ x, y, w, h }) => ({ x, y, w, h }));
}

// Bounding box of the pixels that pixelmatch marks as different, or null when none differ.
export function changedBox(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    return { x: 0, y: 0, w: Math.max(a.width, b.width), h: Math.max(a.height, b.height) };
  }
  const out = Buffer.alloc(a.width * a.height * 4);
  const count = pixelmatch(a.data, b.data, out, a.width, a.height, { threshold: GATE.aaThreshold, includeAA: false });
  if (!count) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -1;
  let y2 = -1;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      if (out[i] === 255 && out[i + 1] === 0 && out[i + 2] === 0) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
    }
  }
  return { x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 };
}

// Overlap of two boxes in the same coordinates, or null when they do not touch.
export function intersectBox(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function slugId(text, max = 32) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

function uniqueId(base, used) {
  let id = base || 'section';
  let n = 2;
  while (used.has(id)) id = `${base || 'section'}-${n++}`;
  used.add(id);
  return id;
}

// Build a plan.json object from detectPage output.
//   candidates: detectPage().candidates, in document order
//   breakpoints: detectPage().breakpoints
//   live: boxes in page coordinates that changed between two stability screenshots
export function buildPlan({ url, widths, candidates, breakpoints = [], live = [], notes = [] }) {
  const usedSections = new Set();
  const sections = [];
  const states = [];
  const motion = [];
  const usedMotion = new Set();
  const pick = (list) => {
    const kept = list.filter((w) => widths.includes(w));
    return kept.length ? kept : [...widths];
  };
  let hoverMade = false;
  let clickMade = false;

  for (const c of candidates) {
    const idBase = slugId(c.id) || (c.tag === 'header' || c.tag === 'footer' ? c.tag : '') || slugId(c.heading) || `${c.tag}-${sections.length + 1}`;
    const id = uniqueId(idBase, usedSections);
    sections.push({ id, selector: c.selector, label: (c.heading || c.id || c.tag).slice(0, 80) });

    if (c.hover && !hoverMade) {
      hoverMade = true;
      const stateId = `${id}-hover`;
      states.push({ id: stateId, section: id, action: 'hover', selector: c.hover, widths: pick([1440]), label: `${c.heading || id} hover` });
    }
    if (c.click && !clickMade) {
      clickMade = true;
      const stateId = `${id}-open`;
      const stateWidths = c.click.visible ? pick([1440]) : pick([390]);
      states.push({ id: stateId, section: id, action: 'click', selector: c.click.selector, widths: stateWidths, label: `${c.heading || id} open` });
    }

    const liveHere = live.some((b) => intersectBox(b, c.box));
    if (c.cssLoopMs > 0) {
      const durationMs = Math.min(6000, Math.max(3000, Math.round((c.cssLoopMs * 1.5) / 50) * 50));
      motion.push({ id: `loop:${id}`, kind: 'loop', section: id, durationMs, periodMs: c.cssLoopMs, driver: 'css', widths: pick([1440, 390]) });
    } else if (liveHere) {
      motion.push({ id: `loop:${id}`, kind: 'loop', section: id, durationMs: 3000, driver: 'js', widths: pick([1440, 390]) });
    } else if (c.cssFinite) {
      motion.push({ id: `load:${id}`, kind: 'load', section: id, widths: pick([1440, 390]) });
    }
  }

  for (const state of states) {
    const kind = state.action === 'click' ? 'click' : 'hover';
    const name = state.id;
    if (kind === 'hover') {
      motion.push({ id: `hover:${name}`, kind, section: state.section, state: state.id, durationMs: 600, widths: pick([1440]) });
    } else {
      motion.push({ id: `click:${name}`, kind, section: state.section, state: state.id, durationMs: 800, widths: pick(state.widths) });
    }
  }
  for (const m of motion) {
    if (usedMotion.has(m.id)) m.id = uniqueId(m.id, usedMotion);
    else usedMotion.add(m.id);
  }

  const planWidths = [...widths];
  const geometryWidths = geometryFor(breakpoints, planWidths);
  return {
    version: 1,
    url,
    widths: planWidths,
    geometryWidths,
    sections,
    states,
    masks: [],
    motion,
    notes: [...notes, `Auto plan: ${sections.length} sections, ${states.length} states, ${motion.length} motion entries. Review before building.`],
  };
}

// Extra widths for the geometry check. Each breakpoint adds the whole-pixel widths on both sides
// of its switch, so a fractional breakpoint such as Bootstrap's max-width: 767.98px gives 767 and 768.
export function geometryFor(breakpoints, planWidths) {
  const usable = breakpoints.filter((b) => b.px >= MIN_PX && b.px <= MAX_PX && (b.kind === 'min' || b.kind === 'max'));
  usable.sort((a, b) => b.count - a.count || a.px - b.px);
  const widths = new Set();
  for (const b of usable.slice(0, MAX_BREAKPOINTS)) {
    if (b.kind === 'min') {
      const first = Math.ceil(b.px);
      widths.add(first - 1);
      widths.add(first);
    } else {
      const last = Math.floor(b.px);
      widths.add(last);
      widths.add(last + 1);
    }
  }
  return [...widths].filter((w) => !planWidths.includes(w)).sort((a, b) => a - b);
}

// Problems in a plan object. Returns [] when the plan is usable.
export function validatePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object') return ['plan is not an object'];
  if (plan.version !== 1) errors.push('version must be 1');
  if (!Array.isArray(plan.widths) || !plan.widths.length) errors.push('widths must be a non-empty array');
  if (!Array.isArray(plan.sections) || !plan.sections.length) errors.push('sections must be a non-empty array');
  const sectionIds = new Set();
  for (const s of plan.sections ?? []) {
    if (!ID_RE.test(s.id ?? '')) errors.push(`bad section id: ${s.id}`);
    else if (sectionIds.has(s.id)) errors.push(`duplicate section id: ${s.id}`);
    else sectionIds.add(s.id);
    if (typeof s.selector !== 'string' || !s.selector) errors.push(`section ${s.id} has no selector`);
  }
  const stateIds = new Set();
  for (const s of plan.states ?? []) {
    if (!ID_RE.test(s.id ?? '')) errors.push(`bad state id: ${s.id}`);
    else if (stateIds.has(s.id)) errors.push(`duplicate state id: ${s.id}`);
    else stateIds.add(s.id);
    if (!sectionIds.has(s.section)) errors.push(`state ${s.id} points at unknown section ${s.section}`);
    if (!ACTIONS.includes(s.action)) errors.push(`state ${s.id} has bad action ${s.action}`);
  }
  const motionIds = new Set();
  for (const m of plan.motion ?? []) {
    const match = /^([a-z]+):([a-z0-9-]{1,40})$/.exec(m.id ?? '');
    if (!match || !KINDS.includes(match[1]) || match[1] !== m.kind) errors.push(`bad motion id: ${m.id}`);
    else if (motionIds.has(m.id)) errors.push(`duplicate motion id: ${m.id}`);
    else motionIds.add(m.id);
    if (!sectionIds.has(m.section)) errors.push(`motion ${m.id} points at unknown section ${m.section}`);
    if ((m.kind === 'hover' || m.kind === 'click') && !stateIds.has(m.state)) errors.push(`motion ${m.id} needs a known state`);
  }
  return errors;
}
