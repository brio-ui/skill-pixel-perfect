// In-page collectors shared by capture.mjs and lib/trace.mjs.
// pageLib() runs inside the page. installCollector() puts it on globalThis.__ppLib once per document.

export const MAX_ELEMENTS = 300;

// Everything in this function runs in the browser, so it must not use anything from this module.
function pageLib() {
  const XHTML = 'http://www.w3.org/1999/xhtml';
  const NO_TEXT = new Set(['script', 'style', 'noscript', 'template', 'title', 'textarea', 'option']);
  const ALWAYS_TEXT = new Set(['a', 'button', 'label', 'summary']);
  const MEDIA = new Set(['img', 'video', 'canvas', 'iframe']);

  const round = (n) => Math.round(n * 100) / 100;
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  // Same rule as textKey() in io.mjs.
  const textKey = (value) => `t:${norm(value).toLowerCase().slice(0, 80)}`;

  const docBox = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height };
  };
  const relBox = (box, origin) => ({
    x: round(box.x - origin.x),
    y: round(box.y - origin.y),
    w: round(box.w),
    h: round(box.h),
  });
  const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const clipTo = (a, b) => {
    if (!b) return a;
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const w = Math.min(a.x + a.w, b.x + b.w) - x;
    const h = Math.min(a.y + a.h, b.y + b.h) - y;
    return w > 0 && h > 0 ? { x, y, w, h } : null;
  };

  function opacityOf(el, memo) {
    if (!el || el.nodeType !== 1) return 1;
    if (memo.has(el)) return memo.get(el);
    const value = Number(getComputedStyle(el).opacity) * opacityOf(el.parentElement, memo);
    memo.set(el, value);
    return value;
  }

  // The element's opacity times every ancestor's, and 0 under visibility: hidden.
  function effectiveOpacity(el, memo) {
    if (getComputedStyle(el).visibility !== 'visible') return 0;
    return opacityOf(el, memo);
  }

  // Padding box of an ancestor that clips its content on x and/or y, or null when it clips nothing.
  // The body and html never count: their overflow applies to the viewport.
  function clipOf(el, clips) {
    if (clips.has(el)) return clips.get(el);
    let clip = null;
    if (el !== document.body && el !== document.documentElement) {
      const s = getComputedStyle(el);
      const x = s.overflowX !== 'visible';
      const y = s.overflowY !== 'visible';
      if (x || y) {
        const b = docBox(el);
        const left = parseFloat(s.borderLeftWidth) || 0;
        const top = parseFloat(s.borderTopWidth) || 0;
        const w = b.w - left - (parseFloat(s.borderRightWidth) || 0);
        const h = b.h - top - (parseFloat(s.borderBottomWidth) || 0);
        clip = { x, y, box: { x: b.x + left, y: b.y + top, w, h } };
      }
    }
    clips.set(el, clip);
    return clip;
  }

  // The part of el's box (document coordinates) that ancestor overflow clips leave visible, or null
  // when nothing shows. An absolutely positioned element skips the ancestors between it and its
  // containing block (offsetParent); a fixed element is not clipped by any ancestor.
  function visibleBox(el, clips = new Map()) {
    let box = docBox(el);
    for (let cur = el; ; ) {
      const position = getComputedStyle(cur).position;
      if (position === 'fixed') break;
      const next = position === 'absolute' ? cur.offsetParent : cur.parentElement;
      if (!next || next === document.body || next === document.documentElement) break;
      const clip = clipOf(next, clips);
      if (clip) {
        const c = clip.box;
        const x1 = clip.x ? Math.max(box.x, c.x) : box.x;
        const x2 = clip.x ? Math.min(box.x + box.w, c.x + c.w) : box.x + box.w;
        const y1 = clip.y ? Math.max(box.y, c.y) : box.y;
        const y2 = clip.y ? Math.min(box.y + box.h, c.y + c.h) : box.y + box.h;
        if (x2 - x1 < 0.5 || y2 - y1 < 0.5) return null;
        box = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      }
      cur = next;
    }
    return box;
  }

  // Hidden: no client rects, effective opacity under 0.01, a box of 1×1 px or less, or fully
  // clipped by an ancestor's overflow (a closed accordion panel with max-height: 0, for example).
  function isHidden(el, memo, clips = new Map()) {
    if (!el.getClientRects().length) return true;
    if (effectiveOpacity(el, memo) < 0.01) return true;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 && r.height <= 1) return true;
    return !visibleBox(el, clips);
  }

  // Keyed elements under root, in document order: the root, text blocks and media.
  // Text keys are filled in later because innerText forces layout.
  function keyed(root, { includeHidden = false, includeRoot = true } = {}) {
    const all = [root, ...root.querySelectorAll('*')];

    // Mark every element that contains a text node with visible characters.
    const hasText = new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!/\S/.test(node.data)) continue;
      const parent = node.parentElement;
      if (!parent || NO_TEXT.has(parent.localName) || parent.closest('svg')) continue;
      if (!includeHidden && !parent.getClientRects().length) continue;
      for (let n = parent; n && !hasText.has(n); n = n.parentElement) {
        hasText.add(n);
        if (n === root) break;
      }
    }

    // Deepest text blocks: walk in reverse document order so descendants come first.
    const blocks = new Set();
    const below = new Set();
    for (let i = all.length - 1; i >= 0; i--) {
      const el = all[i];
      if (!hasText.has(el)) continue;
      const display = getComputedStyle(el).display;
      if (display === 'inline' || display === 'contents' || (display === 'none' && !includeHidden)) continue;
      if (!below.has(el)) blocks.add(el);
      let n = el;
      while (n !== root) {
        n = n.parentElement;
        if (!n || below.has(n)) break;
        below.add(n);
      }
    }

    const out = [];
    for (const el of all) {
      const tag = el.localName;
      if (el === root && includeRoot) out.push({ el, key: 'root', kind: 'root', tag });
      if (blocks.has(el) || (ALWAYS_TEXT.has(tag) && hasText.has(el))) out.push({ el, key: null, kind: 'text', tag });
      let media = null;
      if (MEDIA.has(tag)) media = tag;
      else if (tag === 'svg') media = el.parentElement?.closest('svg') ? null : 'svg';
      else if (el.namespaceURI === XHTML && getComputedStyle(el).backgroundImage.includes('url(')) {
        const r = el.getBoundingClientRect();
        if (includeHidden || r.width * r.height >= 400) media = 'bg';
      }
      if (media) out.push({ el, key: `m:${media}`, kind: 'media', tag });
    }
    return out;
  }

  function styleOf(el) {
    const s = getComputedStyle(el);
    return {
      fontFamily: (s.fontFamily.split(',')[0] || '').replace(/["']/g, '').trim().toLowerCase(),
      fontSize: s.fontSize,
      fontWeight: s.fontWeight,
      fontStyle: s.fontStyle,
      lineHeight: s.lineHeight,
      letterSpacing: s.letterSpacing,
      textTransform: s.textTransform,
      textAlign: s.textAlign,
      color: s.color,
      backgroundColor: s.backgroundColor,
      backgroundImage: s.backgroundImage.slice(0, 120),
      borderRadius: s.borderRadius,
      border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
      boxShadow: s.boxShadow,
      padding: `${s.paddingTop} ${s.paddingRight} ${s.paddingBottom} ${s.paddingLeft}`,
      gap: s.gap,
      opacity: s.opacity,
      display: s.display,
      objectFit: s.objectFit,
    };
  }

  function query(selector) {
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  }

  // [{ id, selector }] -> [{ id, found, box, fallback }] with document-coordinate boxes.
  function sections(list) {
    return list.map(({ id, selector }) => {
      const el = query(selector);
      if (!el || !el.getClientRects().length) return { id, found: false };
      const box = docBox(el);
      if (box.w < 1 || box.h < 1) return { id, found: false };
      const fallback = (el.getAttribute('data-pp-fallback') || '').split(/\s+/).filter(Boolean);
      return { id, found: true, box: relBox(box, { x: 0, y: 0 }), fallback };
    });
  }

  function cloneSectionIds() {
    return [...document.querySelectorAll('[data-pp-section]')].map((el) => el.getAttribute('data-pp-section'));
  }

  // Keyed elements of one root (the body when selector is null), boxes relative to origin.
  // clip (document coordinates) keeps only elements that intersect it.
  function elements({ selector, origin, includeHidden = false, includeRoot = true, max = 300, withStyle = true, clip = null }) {
    const root = selector ? query(selector) : document.body;
    if (!root) return null;
    const memo = new Map();
    const clips = new Map();
    const result = [];
    for (const item of keyed(root, { includeHidden, includeRoot })) {
      if (result.length >= max) break;
      const { el } = item;
      if (!includeHidden && item.kind !== 'root' && isHidden(el, memo, clips)) continue;
      const box = docBox(el);
      if (clip && !intersects(box, clip)) continue;
      const key = item.key ?? textKey(el.innerText);
      if (key === 't:') continue;
      const entry = { key, kind: item.kind, tag: item.tag, box: relBox(box, origin) };
      if (withStyle) entry.style = styleOf(el);
      result.push(entry);
    }
    return result;
  }

  // Mask boxes: iframe, canvas, embed and object, plus extra [{ selector, reason }].
  // Boxes are clipped to clip (document coordinates) and made relative to origin.
  function masks({ extra = [], clip = null, origin = { x: 0, y: 0 } }) {
    const memo = new Map();
    const clips = new Map();
    const seen = new Set();
    const out = [];
    const add = (el, reason) => {
      if (seen.has(el)) return;
      seen.add(el);
      if (isHidden(el, memo, clips)) return;
      const box = clipTo(docBox(el), clip);
      if (box) out.push({ box: relBox(box, origin), reason: el.getAttribute('data-pp-mask') || reason });
    };
    for (const el of document.querySelectorAll('iframe, canvas, embed, object')) add(el, el.localName);
    for (const { selector, reason } of extra) {
      let list = [];
      try {
        list = document.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const el of list) add(el, reason);
    }
    return out;
  }

  // Motion traces. traceStart() remembers which animations already finished (prep settled them).
  // traceStep() seeks the rest to their own elapsed time (seek), or finishes them (finish, used
  // between scrub positions), then registers new elements and samples every registered one.
  // Infinite animations are only seeked when loops is true; otherwise they hold still.
  // Infinite animations found at step 0 of a loop trace first catch up with loopOffsetMs, the
  // fake time that ran since the page loaded. A CSS loop (frozen timeline) and a JavaScript loop
  // (fake clock) that both started at load then share a phase.
  // Boxes are relative to the section's top-left corner at the first step that finds the section.
  let trace = null;

  function traceStart({ selector }) {
    trace = { selector, origin: null, items: [], index: new Map(), anims: new Map(), ignore: new Set() };
    for (const a of document.getAnimations()) {
      if (a.timeline === document.timeline && a.playState === 'finished') trace.ignore.add(a);
    }
    return Boolean(query(selector));
  }

  function traceStep({ k, stepMs, seek = true, finish = false, loops = false, loopOffsetMs = 0, maxItems = 1000 }) {
    for (const a of document.getAnimations()) {
      if (a.timeline !== document.timeline) continue;
      if (trace.ignore.has(a)) {
        if (a.playState === 'finished') continue;
        trace.ignore.delete(a);
      }
      // A paused animation belongs to a script that sets its time itself (a scroll-linked effect
      // built on Motion's animation controls, for example), so the trace leaves it alone.
      // Its start is recorded again if it plays later.
      if (a.playState === 'paused') {
        trace.anims.delete(a);
        continue;
      }
      const end = a.effect?.getComputedTiming?.().endTime;
      const infinite = end == null || end === Infinity;
      if (finish) {
        if (!infinite && a.playState !== 'finished') {
          try {
            a.finish();
          } catch {}
        }
        continue;
      }
      if (!seek || (infinite && !loops)) continue;
      let start = trace.anims.get(a);
      if (!start) {
        const rate = a.playbackRate || 1;
        const catchUp = loops && infinite && k === 0 ? loopOffsetMs * rate : 0;
        start = { k, t: Number(a.currentTime ?? 0) + catchUp, rate };
        trace.anims.set(a, start);
      }
      try {
        a.currentTime = start.t + (k - start.k) * stepMs * start.rate;
      } catch {}
    }

    const added = [];
    const root = query(trace.selector);
    const rootBox = root && root.getClientRects().length ? docBox(root) : null;
    if (rootBox && !trace.origin) trace.origin = { x: rootBox.x, y: rootBox.y };
    if (root && trace.origin) {
      for (const item of keyed(root, { includeHidden: true, includeRoot: true })) {
        if (trace.items.length >= maxItems) break;
        let ids = trace.index.get(item.el);
        if (!ids) {
          ids = new Set();
          trace.index.set(item.el, ids);
        }
        if (ids.has(item.kind)) continue;
        const key = item.key ?? textKey(item.el.innerText);
        if (key === 't:') continue;
        ids.add(item.kind);
        trace.items.push(item.el);
        added.push({ key, kind: item.kind, tag: item.tag });
      }
    }

    // Samples use the visible part of each box, so content inside a growing clip (an opening
    // accordion panel) moves too. A fully clipped element has no box at that sample.
    const memo = new Map();
    const clips = new Map();
    const boxes = trace.items.map((el) => {
      if (!el.isConnected || !el.getClientRects().length) return null;
      const visible = visibleBox(el, clips);
      if (!visible) return null;
      const b = relBox(visible, trace.origin);
      return [b.x, b.y, b.w, b.h, Math.round(effectiveOpacity(el, memo) * 1000) / 1000];
    });
    return { found: Boolean(rootBox), added, boxes, scrollY: window.scrollY, rootBox };
  }

  // Count of images in the viewport that have not finished loading.
  function pendingVisibleImages() {
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    return [...document.images].filter((img) => {
      if (img.complete) return false;
      const r = img.getBoundingClientRect();
      return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw && r.width > 0 && r.height > 0;
    }).length;
  }

  return { textKey, sections, cloneSectionIds, elements, masks, traceStart, traceStep, pendingVisibleImages };
}

const LIB_SOURCE = `globalThis.__ppLib || (globalThis.__ppLib = (${pageLib.toString()})()); true`;

// Install the collector in the current document. Safe to call again; it installs once.
export async function installCollector(page) {
  await page.evaluate(LIB_SOURCE);
}

// Sections by selector. list: [{ id, selector }]. Returns [{ id, found, box, fallback }].
export async function findSections(page, list) {
  await installCollector(page);
  return page.evaluate((l) => globalThis.__ppLib.sections(l), list);
}

// Ids of every [data-pp-section] in the clone, in document order.
export async function cloneSectionIds(page) {
  await installCollector(page);
  return page.evaluate(() => globalThis.__ppLib.cloneSectionIds());
}

// Keyed elements. options: { selector, origin, includeHidden, includeRoot, max, withStyle, clip }.
// Returns null when the selector matches nothing.
export async function collectElements(page, options) {
  await installCollector(page);
  return page.evaluate((o) => globalThis.__ppLib.elements(o), { max: MAX_ELEMENTS, ...options });
}

// Mask boxes. options: { extra: [{ selector, reason }], clip, origin }.
export async function collectMasks(page, options) {
  await installCollector(page);
  return page.evaluate((o) => globalThis.__ppLib.masks(o), options);
}
