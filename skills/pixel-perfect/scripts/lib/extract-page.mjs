// Functions that run inside the page through page.evaluate. Playwright sends each one as source text,
// so none of them may use anything from this module's scope. Page text is copied as text, never run.

// Stylesheets in document order, plus constructed (adopted) sheets as text.
export function listStylesheets() {
  const sheets = [];
  for (const sheet of Array.from(document.styleSheets)) {
    if (sheet.disabled) continue;
    const owner = sheet.ownerNode;
    const media = sheet.media ? sheet.media.mediaText : '';
    if (owner && owner.localName === 'style') sheets.push({ kind: 'inline', text: owner.textContent || '', media });
    else if (sheet.href) sheets.push({ kind: 'link', href: sheet.href, media });
  }
  const adopted = Array.from(document.adoptedStyleSheets || []).map((sheet) =>
    Array.from(sheet.cssRules)
      .map((rule) => rule.cssText)
      .join('\n'),
  );
  return { sheets, adopted, baseURI: document.baseURI, url: location.href };
}

// Parse each sheet text in a constructed sheet and list its rules with their @media, @supports,
// @container, @layer and @starting-style wrappers. Rule text is kept as the browser serialises it.
export function parseSheets(texts) {
  const entries = [];
  const customPropsOf = (style) => {
    const decls = [];
    for (let i = 0; i < style.length; i++) {
      const name = style[i];
      if (!name.startsWith('--')) continue;
      const priority = style.getPropertyPriority(name);
      decls.push(`${name}: ${style.getPropertyValue(name)}${priority ? ` !${priority}` : ''};`);
    }
    return decls.join(' ');
  };
  const walk = (rules, wrappers) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        entries.push({
          type: 'style',
          text: rule.cssText,
          selectorText: rule.selectorText,
          wrappers,
          customProps: customPropsOf(rule.style),
        });
      } else if (rule instanceof CSSMediaRule) {
        walk(rule.cssRules, [...wrappers, `@media ${rule.media.mediaText}`]);
      } else if (rule instanceof CSSSupportsRule) {
        walk(rule.cssRules, [...wrappers, `@supports ${rule.conditionText}`]);
      } else if (rule instanceof CSSContainerRule) {
        const name = rule.containerName ? `${rule.containerName} ` : '';
        walk(rule.cssRules, [...wrappers, `@container ${name}${rule.conditionText}`]);
      } else if (rule instanceof CSSLayerBlockRule) {
        walk(rule.cssRules, [...wrappers, rule.name ? `@layer ${rule.name}` : '@layer']);
      } else if (typeof CSSStartingStyleRule !== 'undefined' && rule instanceof CSSStartingStyleRule) {
        walk(rule.cssRules, [...wrappers, '@starting-style']);
      } else if (rule instanceof CSSKeyframesRule) {
        entries.push({ type: 'keyframes', name: rule.name, text: rule.cssText, wrappers });
      } else if (rule instanceof CSSFontFaceRule) {
        const family = rule.style.getPropertyValue('font-family').replace(/["']/g, '').trim().toLowerCase();
        entries.push({ type: 'font-face', family, text: rule.cssText, wrappers });
      } else if (rule instanceof CSSLayerStatementRule) {
        entries.push({ type: 'layer', text: rule.cssText, names: Array.from(rule.nameList), wrappers });
      } else if (rule instanceof CSSPropertyRule) {
        entries.push({ type: 'property', text: rule.cssText, wrappers });
      }
    }
  };
  for (const text of texts) {
    const sheet = new CSSStyleSheet();
    try {
      sheet.replaceSync(text);
    } catch {
      continue;
    }
    walk(sheet.cssRules, []);
  }
  return entries;
}

// For each style entry with parts (stripped selectors), find the sections it matches.
// A part matches a section when root.matches(part) or root.querySelector(part).
// entry.ancestor is set when a part matches an ancestor of a section root (html and body excluded).
// An invalid selector keeps the rule for every section.
export function matchRules({ sections, entries }) {
  const found = {};
  const roots = {};
  const ancestors = new Set();
  for (const section of sections) {
    let el = null;
    try {
      el = document.querySelector(section.selector);
    } catch {
      el = null;
    }
    roots[section.id] = el;
    found[section.id] = Boolean(el);
    if (!el) continue;
    for (let a = el.parentElement; a && a !== document.documentElement && a !== document.body; a = a.parentElement) {
      ancestors.add(a);
    }
  }
  const ids = sections.map((s) => s.id).filter((id) => roots[id]);
  const ancestorList = [...ancestors];
  const sectionHit = (root, part) => {
    try {
      return root.matches(part) || root.querySelector(part) !== null;
    } catch {
      return true;
    }
  };
  const ancestorHit = (el, part) => {
    try {
      return el.matches(part);
    } catch {
      return false;
    }
  };
  for (const entry of entries) {
    if (entry.type !== 'style' || entry.base) continue;
    entry.sections = ids.filter((id) => entry.parts.some((part) => sectionHit(roots[id], part)));
    entry.ancestor = entry.parts.some((part) => ancestorList.some((el) => ancestorHit(el, part)));
  }
  return { found, entries };
}

// Live computed data for each found section, plus page-wide tokens and font families.
export function collectLive({ sections, assetMap }) {
  const round = (v) => Math.round(v * 100) / 100;
  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const isJs = (v) => /^javascript:/i.test(String(v ?? '').replace(/[\u0000- ]+/g, ''));
  const splitTop = (value) => {
    const out = [];
    let depth = 0;
    let cur = '';
    for (const ch of String(value ?? '')) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        out.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };
  const families = (value) => splitTop(value).map((f) => f.replace(/["']/g, '').trim().toLowerCase());
  const visible = (el) => el.getClientRects().length > 0;
  const topN = (map) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
      .slice(0, 40)
      .map(([value, count]) => ({ value, count }));
  const tally = (map, value) => {
    if (value === '' || value == null) return;
    map.set(value, (map.get(value) ?? 0) + 1);
  };
  const newAcc = () => ({
    colors: new Map(),
    fonts: new Map(),
    fontFull: new Map(),
    typeScale: new Map(),
    spacing: new Map(),
    radii: new Map(),
    shadows: new Map(),
    maxWidths: new Map(),
  });
  const SKIP_COLOR = /^(transparent|rgba\(\s*0,\s*0,\s*0,\s*0\s*\))$/;
  const addColor = (acc, v) => {
    if (v && !SKIP_COLOR.test(v)) tally(acc.colors, v);
  };
  const tallyElement = (el, acc) => {
    if (!visible(el)) return;
    const cs = getComputedStyle(el);
    addColor(acc, cs.color);
    addColor(acc, cs.backgroundColor);
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      if (parseFloat(cs[`border${side}Width`]) > 0 && cs[`border${side}Style`] !== 'none') {
        addColor(acc, cs[`border${side}Color`]);
      }
    }
    if (el instanceof SVGElement) {
      for (const prop of ['fill', 'stroke']) {
        if (cs[prop] && cs[prop] !== 'none') addColor(acc, cs[prop]);
      }
    }
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
    if (hasText) {
      const family = families(cs.fontFamily)[0] ?? '';
      tally(acc.typeScale, `${cs.fontSize} / ${cs.lineHeight} / ${cs.fontWeight} / ${cs.letterSpacing}`);
      tally(acc.fonts, `${family} ${cs.fontWeight}`);
      const key = `${family}|${cs.fontWeight}|${cs.fontSize}`;
      const cur = acc.fontFull.get(key) ?? { family, weight: cs.fontWeight, size: cs.fontSize, count: 0 };
      cur.count++;
      acc.fontFull.set(key, cur);
    }
    for (const prop of [
      'paddingTop',
      'paddingRight',
      'paddingBottom',
      'paddingLeft',
      'marginTop',
      'marginRight',
      'marginBottom',
      'marginLeft',
      'rowGap',
      'columnGap',
    ]) {
      const v = cs[prop];
      if (/^-?[\d.]+px$/.test(v) && parseFloat(v) !== 0) tally(acc.spacing, v);
    }
    if (parseFloat(cs.borderTopLeftRadius) > 0) tally(acc.radii, cs.borderTopLeftRadius);
    if (cs.boxShadow && cs.boxShadow !== 'none') tally(acc.shadows, cs.boxShadow);
    if (cs.maxWidth && cs.maxWidth !== 'none') tally(acc.maxWidths, cs.maxWidth);
  };
  const seg = (n) => {
    let s = n.localName;
    if (n.id) s += `#${n.id}`;
    for (const c of [...n.classList].slice(0, 2)) s += `.${c}`;
    const parent = n.parentElement;
    if (parent) {
      const same = [...parent.children].filter((c) => c.localName === n.localName);
      if (same.length > 1) s += `:nth-of-type(${same.indexOf(n) + 1})`;
    }
    return s;
  };
  const cssPath = (el, root) => {
    const parts = [];
    for (let n = el; n; n = n.parentElement) {
      parts.unshift(seg(n));
      if (n === root) break;
    }
    return parts.join(' > ');
  };
  const pick = (list, i) => (list.length ? list[i % list.length] : '');
  const ZERO_TIMES = /^(0s)(\s*,\s*0s)*$/;
  // Inherited properties that change what a screenshot shows. caret-color and visibility are left
  // out: the caret is hidden in screenshots, and a hidden ancestor would hide the whole section.
  const INHERITED = [
    'color',
    'color-scheme',
    'font-family',
    'font-size',
    'font-style',
    'font-weight',
    'font-stretch',
    'font-size-adjust',
    'font-variant-caps',
    'font-variant-ligatures',
    'font-variant-numeric',
    'font-variant-east-asian',
    'font-variant-alternates',
    'font-variant-position',
    'font-feature-settings',
    'font-variation-settings',
    'font-kerning',
    'font-optical-sizing',
    'font-synthesis-weight',
    'font-synthesis-style',
    'line-height',
    'letter-spacing',
    'word-spacing',
    'text-align',
    'text-indent',
    'text-transform',
    'text-shadow',
    'text-rendering',
    'text-decoration-skip-ink',
    'text-underline-offset',
    'text-underline-position',
    'white-space',
    'text-wrap-style',
    'word-break',
    'overflow-wrap',
    'line-break',
    'hyphens',
    'tab-size',
    'direction',
    'writing-mode',
    'cursor',
    'list-style-type',
    'list-style-position',
    'list-style-image',
    'quotes',
    'border-collapse',
    'border-spacing',
    'image-rendering',
    'accent-color',
    '-webkit-font-smoothing',
    '-webkit-text-size-adjust',
    '-webkit-tap-highlight-color',
  ];
  // Computed values of the inherited properties on el. getComputedStyle reports a unitless
  // line-height in pixels, and children would then inherit the pixels, so the number is read
  // from computedStyleMap instead.
  const inheritedOf = (el) => {
    if (!el) return {};
    const cs = getComputedStyle(el);
    const values = {};
    for (const prop of INHERITED) {
      const value = cs.getPropertyValue(prop).trim();
      if (value) values[prop] = value;
    }
    try {
      const lineHeight = el.computedStyleMap().get('line-height');
      if (lineHeight && lineHeight.unit === 'number') values['line-height'] = String(lineHeight.value);
    } catch {
      // No computedStyleMap: keep the resolved value.
    }
    return values;
  };

  // Presentational hints of HTML attributes, such as <img width> or <td nowrap>, as [selector,
  // declarations] pairs. The css-port reset reverts hints together with every other author style,
  // so the port file sets them again in its pp-hints layer. The selectors match on the attribute,
  // which the clone copies, and the values follow Chromium. Chromium also gives the cells of a
  // table without cellpadding a 1px padding. SVG content is left out of the reset and needs no
  // hints. Rarer legacy attributes (font, hr size and color, img align and border, table frame and
  // rules, pre wrap, contenteditable) are not covered.
  const DIMENSION_TAGS = {
    width: new Set(['img', 'video', 'iframe', 'embed', 'object', 'table', 'td', 'th', 'col', 'colgroup', 'hr']),
    height: new Set(['img', 'video', 'iframe', 'embed', 'object', 'table', 'td', 'th', 'tr']),
  };
  const TABLE_PARTS = new Set(['thead', 'tbody', 'tfoot', 'tr', 'td', 'th']);
  const BLOCK_ALIGN = { center: '-webkit-center', middle: '-webkit-center', left: '-webkit-left', right: '-webkit-right' };
  const LIST_TYPES = {
    ol: { 1: 'decimal', a: 'lower-alpha', A: 'upper-alpha', i: 'lower-roman', I: 'upper-roman' },
    ul: { disc: 'disc', circle: 'circle', square: 'square', none: 'none' },
  };
  const quoted = (value) => `"${value.replace(/["\\]/g, '\\$&').replace(/\n/g, '\\a ')}"`;
  // An HTML dimension: digits with an optional fraction, then an optional percent sign. Text after
  // the number is ignored, so "40px" is 40.
  const dimension = (value) => {
    const m = /^\s*(\d+(?:\.\d+)?)(%?)/.exec(value ?? '');
    return m ? `${m[1]}${m[2] || 'px'}` : null;
  };
  const integer = (value) => /^\s*(\d+)/.exec(value ?? '')?.[1] ?? null;
  const cellsOf = (table) => `${table} > :is(thead, tbody, tfoot) > tr > :is(td, th), ${table} > tr > :is(td, th)`;
  const hintsOf = (root) => {
    const rules = new Map();
    const add = (selector, declarations) => {
      if (!rules.has(selector)) rules.set(selector, declarations);
    };
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
      const tag = el.localName;
      const attr = (name) => el.getAttribute(name);
      const on = (name) => `${tag}[${name}=${quoted(attr(name))}]`;
      const cell = tag === 'td' || tag === 'th';
      for (const name of ['width', 'height']) {
        const size = DIMENSION_TAGS[name].has(tag) ? dimension(attr(name)) : null;
        // Chromium ignores a zero width or height on a table cell.
        if (size && !(cell && parseFloat(size) === 0)) add(on(name), `${name}: ${size};`);
      }
      const w = dimension(attr('width'));
      const h = dimension(attr('height'));
      if ((tag === 'img' || tag === 'video') && w?.endsWith('px') && h?.endsWith('px') && parseFloat(w) > 0 && parseFloat(h) > 0) {
        add(`${on('width')}[height=${quoted(attr('height'))}]`, `aspect-ratio: auto ${parseFloat(w)} / ${parseFloat(h)};`);
      }
      if (el.hasAttribute('hidden')) {
        if (attr('hidden').toLowerCase() === 'until-found') add('[hidden="until-found" i]', 'content-visibility: hidden;');
        else add('[hidden]:not([hidden="until-found" i])', 'display: none;');
      }
      if (tag === 'table') {
        const padding = integer(attr('cellpadding'));
        if (padding !== null) add(cellsOf(on('cellpadding')), `padding: ${padding}px;`);
        else add(':is(td, th)', 'padding: 1px;');
        const spacing = integer(attr('cellspacing'));
        if (spacing !== null) add(on('cellspacing'), `border-spacing: ${spacing}px;`);
        // A border attribute with no number means 1. Cells then get a 1px inset border.
        const border = el.hasAttribute('border') ? Number(integer(attr('border')) ?? 1) : 0;
        if (border > 0 && !el.hasAttribute('frame') && !el.hasAttribute('rules')) {
          add(on('border'), `border-width: ${border}px; border-style: outset;`);
          add(cellsOf(on('border')), 'border-width: 1px; border-style: inset; border-color: inherit;');
        }
        const align = attr('align')?.toLowerCase();
        if (align === 'center') add(on('align'), 'margin-inline: auto;');
        else if (align === 'left' || align === 'right') add(on('align'), `float: ${align};`);
      }
      const bg = attr('bgcolor');
      if (bg !== null && (tag === 'table' || TABLE_PARTS.has(tag))) {
        const color = CSS.supports('color', bg) ? bg : /^[0-9a-f]{6}$/i.test(bg) ? `#${bg}` : null;
        if (color) add(on('bgcolor'), `background-color: ${color};`);
      }
      const valign = attr('valign');
      if (valign && TABLE_PARTS.has(tag) && CSS.supports('vertical-align', valign)) {
        add(on('valign'), `vertical-align: ${valign.toLowerCase()};`);
      }
      if (cell && el.hasAttribute('nowrap')) add(`${tag}[nowrap]`, 'white-space: nowrap;');
      const align = attr('align');
      if (align && tag !== 'table') {
        const key = align.toLowerCase();
        let value = null;
        if (tag === 'div' || tag === 'p') value = BLOCK_ALIGN[key] ?? key;
        else if (TABLE_PARTS.has(tag)) value = BLOCK_ALIGN[key] ?? (key === 'absmiddle' ? 'center' : key);
        else if (/^h[1-6]$/.test(tag)) value = key === 'middle' ? 'center' : key;
        if (value && CSS.supports('text-align', value)) add(on('align'), `text-align: ${value};`);
      }
      // ol type is case-sensitive ("a" and "A"), but attribute selectors on type match without case
      // and Chromium has no "s" flag. A section that uses both cases gets the first one for both.
      const type = attr('type');
      if (type !== null && (tag === 'ol' || tag === 'ul' || tag === 'li')) {
        const listType =
          tag === 'ul' ? LIST_TYPES.ul[type.toLowerCase()] : LIST_TYPES.ol[type] ?? (tag === 'li' ? LIST_TYPES.ul[type.toLowerCase()] : null);
        if (listType) add(on('type'), `list-style-type: ${listType};`);
      }
      const frameborder = attr('frameborder');
      if (tag === 'iframe' && frameborder !== null && !(parseInt(frameborder, 10) > 0)) {
        add(on('frameborder'), 'border-width: 0px;');
      }
    }
    return [...rules];
  };

  const pageFamilies = new Set();
  for (const el of document.querySelectorAll('body, body *')) {
    for (const f of families(getComputedStyle(el).fontFamily)) pageFamilies.add(f);
  }

  const totals = newAcc();
  const seen = new Set();
  const found = {};
  const out = {};
  for (const section of sections) {
    let root = null;
    try {
      root = document.querySelector(section.selector);
    } catch {
      root = null;
    }
    found[section.id] = Boolean(root);
    if (!root) continue;

    const acc = newAcc();
    const animationNames = new Set();
    const famSet = new Set();
    const animations = [];
    const transitions = [];
    const els = [root, ...root.querySelectorAll('*')];
    for (const el of els) {
      const cs = getComputedStyle(el);
      for (const f of families(cs.fontFamily)) famSet.add(f);
      const names = splitTop(cs.animationName).filter((n) => n && n !== 'none');
      for (const n of names) animationNames.add(n);
      tallyElement(el, acc);
      if (!seen.has(el)) {
        seen.add(el);
        tallyElement(el, totals);
      }
      if (!visible(el)) continue;
      const path = cssPath(el, root);
      const durations = splitTop(cs.animationDuration);
      const timings = splitTop(cs.animationTimingFunction);
      const delays = splitTop(cs.animationDelay);
      const iterations = splitTop(cs.animationIterationCount);
      const rawNames = splitTop(cs.animationName);
      rawNames.forEach((name, i) => {
        if (!name || name === 'none') return;
        animations.push({
          path,
          name,
          duration: pick(durations, i),
          timingFunction: pick(timings, i),
          delay: pick(delays, i),
          iterationCount: pick(iterations, i),
        });
      });
      // Default is 0s duration and delay. Anything else is a real transition.
      if (!ZERO_TIMES.test(cs.transitionDuration) || !ZERO_TIMES.test(cs.transitionDelay)) {
        transitions.push({
          path,
          value: `${cs.transitionProperty} ${cs.transitionDuration} ${cs.transitionTimingFunction} ${cs.transitionDelay}`,
        });
      }
    }

    const fontRows = [...acc.fontFull.values()]
      .sort((a, b) => b.count - a.count || a.family.localeCompare(b.family))
      .slice(0, 40);
    const rect = root.getBoundingClientRect();
    const linkRows = [...root.querySelectorAll('a[href]')]
      .filter((a) => !isJs(a.getAttribute('href')))
      .map((a) => ({ text: clean(a.textContent).slice(0, 200), href: a.href }));
    const imageRows = [...root.querySelectorAll('img')].map((img) => {
      const src = img.currentSrc || img.src || '';
      const abs = src && !src.startsWith('data:') ? src : null;
      const r = img.getBoundingClientRect();
      return {
        src: abs,
        local: abs ? (assetMap[abs] ?? null) : null,
        alt: img.getAttribute('alt') ?? '',
        w: round(r.width),
        h: round(r.height),
      };
    });
    const interactive = [
      ...root.querySelectorAll(
        'a[href], button, summary, details, input, select, textarea, [role="button"], [role="tab"], [role="menuitem"], [aria-expanded], [aria-controls]',
      ),
    ].map((el) => ({
      tag: el.localName,
      role: el.getAttribute('role'),
      text: clean(el.textContent || el.getAttribute('aria-label') || el.getAttribute('value') || '').slice(0, 200),
      ariaExpanded: el.getAttribute('aria-expanded'),
      ariaControls: el.getAttribute('aria-controls'),
    }));
    const forms = [...root.querySelectorAll('form')].map((form) => ({
      action: form.getAttribute('action') ? form.action : null,
      method: (form.getAttribute('method') || 'get').toLowerCase(),
      fields: [...form.querySelectorAll('input, select, textarea')].map((f) => ({
        tag: f.localName,
        type: f.localName === 'input' ? (f.getAttribute('type') || 'text').toLowerCase() : f.localName,
        name: f.getAttribute('name'),
        placeholder: f.getAttribute('placeholder'),
        required: f.hasAttribute('required'),
      })),
    }));

    out[section.id] = {
      box: {
        x: round(rect.left + window.scrollX),
        y: round(rect.top + window.scrollY),
        w: round(rect.width),
        h: round(rect.height),
      },
      headings: [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => ({
        tag: h.localName,
        text: clean(h.textContent).slice(0, 300),
      })),
      links: linkRows,
      images: imageRows,
      fonts: fontRows.map(({ family, weight, size, count }) => ({ family, weight, size, count })),
      colors: topN(acc.colors),
      animations,
      transitions,
      interactive,
      forms,
      animationNames: [...animationNames],
      families: [...famSet],
      inherited: inheritedOf(root.parentElement),
      hints: hintsOf(root),
    };
  }

  return {
    found,
    pageFamilies: [...pageFamilies],
    htmlInherited: inheritedOf(document.documentElement),
    sections: out,
    tokens: {
      colors: topN(totals.colors),
      fonts: topN(totals.fonts),
      typeScale: topN(totals.typeScale),
      spacing: topN(totals.spacing),
      radii: topN(totals.radii),
      shadows: topN(totals.shadows),
      maxWidths: topN(totals.maxWidths),
    },
  };
}

// Head metadata. JSON-LD that does not parse is kept as text, with a note.
export function collectHead() {
  const notes = [];
  const abs = (u) => {
    try {
      return new URL(u, document.baseURI).href;
    } catch {
      return u;
    }
  };
  const content = (sel) => document.querySelector(sel)?.getAttribute('content') ?? '';
  const head = {
    title: document.title || '',
    description: content('meta[name="description"]'),
    og: {},
    twitter: {},
    canonical: '',
    lang: document.documentElement.lang || '',
    icons: [],
    robots: content('meta[name="robots"]'),
    jsonLd: [],
  };
  for (const m of document.querySelectorAll('meta[property^="og:"]')) {
    const key = m.getAttribute('property');
    if (!(key in head.og)) head.og[key] = m.getAttribute('content') ?? '';
  }
  for (const m of document.querySelectorAll('meta[name^="twitter:"]')) {
    const key = m.getAttribute('name');
    if (!(key in head.twitter)) head.twitter[key] = m.getAttribute('content') ?? '';
  }
  const canonical = document.querySelector('link[rel~="canonical"]');
  if (canonical?.getAttribute('href')) head.canonical = abs(canonical.getAttribute('href'));
  for (const link of document.querySelectorAll('link[rel*="icon"]')) {
    head.icons.push({
      rel: link.getAttribute('rel') || '',
      href: abs(link.getAttribute('href') || ''),
      sizes: link.getAttribute('sizes') || '',
      type: link.getAttribute('type') || '',
    });
  }
  document.querySelectorAll('script[type="application/ld+json"]').forEach((script, i) => {
    try {
      head.jsonLd.push(JSON.parse(script.textContent));
    } catch {
      head.jsonLd.push(script.textContent.trim());
      notes.push(`JSON-LD block ${i + 1} is not valid JSON; kept as text.`);
    }
  });
  return { head, notes };
}

// Copy of one section with page scripts, handlers and unsafe URLs removed, asset URLs rewritten,
// and large inline SVGs replaced by placeholders (data-pp-svg-tmp="<n>"; the outerHTML is in svgs).
export function sanitizeSection({ id, selector, assetMap }) {
  let root = null;
  try {
    root = document.querySelector(selector);
  } catch {
    root = null;
  }
  if (!root) return { found: false };

  const isJs = (v) => /^javascript:/i.test(String(v ?? '').replace(/[\u0000- ]+/g, ''));
  const rewriteRef = (ref) => {
    const v = String(ref).trim();
    if (!v || v.startsWith('#') || /^(mailto:|tel:|data:)/i.test(v)) return v;
    try {
      const abs = new URL(v, document.baseURI).href;
      return assetMap[abs] ?? abs;
    } catch {
      return v;
    }
  };
  const rewriteSrcset = (value) =>
    value
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => {
        const [url, ...rest] = c.split(/\s+/);
        return [rewriteRef(url), ...rest].join(' ');
      })
      .join(', ');
  const rewriteStyleUrls = (value) =>
    value.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (m, q, u) => `url("${rewriteRef(u)}")`);

  const clone = root.cloneNode(true);
  for (const el of clone.querySelectorAll('script, noscript, style, template, base, meta[http-equiv]')) {
    el.remove();
  }
  // SVG animation can switch a link to a javascript: URL.
  for (const el of clone.querySelectorAll('animate, set')) {
    if (/^(xlink:)?href$/i.test(el.getAttribute('attributeName') ?? '')) el.remove();
  }

  const URL_TAGS = new Set(['a', 'link', 'image', 'use']);
  // A data: URL in a frame runs as its own page, scripts included.
  const FRAME_TAGS = new Set(['iframe', 'frame', 'object', 'embed']);
  const isData = (v) => /^data:/i.test(String(v ?? '').replace(/[\u0000- ]+/g, ''));
  for (const el of [clone, ...clone.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value;
      if (name.startsWith('on') || name === 'srcdoc') el.removeAttribute(attr.name);
      else if (name.startsWith('data-') && value.length > 100) el.removeAttribute(attr.name);
      else if (['href', 'src', 'action', 'formaction', 'xlink:href', 'data'].includes(name) && isJs(value)) {
        el.removeAttribute(attr.name);
      } else if ((name === 'src' || name === 'data') && FRAME_TAGS.has(el.localName) && isData(value)) {
        el.removeAttribute(attr.name);
      } else if (name === 'srcset') el.setAttribute(attr.name, rewriteSrcset(value));
      else if (name === 'style') el.setAttribute(attr.name, rewriteStyleUrls(value));
      else if (name === 'src' || name === 'poster' || name === 'action' || name === 'formaction') {
        el.setAttribute(attr.name, rewriteRef(value));
      } else if ((name === 'href' || name === 'xlink:href') && URL_TAGS.has(el.localName)) {
        el.setAttribute(attr.name, rewriteRef(value));
      }
    }
  }

  const svgs = [];
  for (const svg of [...clone.querySelectorAll('svg')]) {
    if (!clone.contains(svg)) continue;
    const outer = svg.outerHTML;
    if (outer.length <= 2048) continue;
    const ph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const name of ['class', 'id', 'width', 'height', 'viewBox', 'style', 'role']) {
      if (svg.hasAttribute(name)) ph.setAttribute(name, svg.getAttribute(name));
    }
    for (const attr of [...svg.attributes]) {
      if (attr.name.startsWith('aria-')) ph.setAttribute(attr.name, attr.value);
    }
    ph.setAttribute('data-pp-svg-tmp', String(svgs.length));
    svgs.push(outer);
    svg.replaceWith(ph);
  }

  clone.setAttribute('data-pp-section', id);
  return { found: true, html: clone.outerHTML, svgs };
}
