// Node-side CSS text helpers for extract.mjs. They work on sheet text, not on a parsed sheet.
// The page-side matcher in extract-page.mjs relies on stripDynamicPseudos and splitSelectorList.

const DYNAMIC_PSEUDO_CLASSES = new Set(['hover', 'focus', 'focus-visible', 'focus-within', 'active', 'visited', 'target']);
const LEGACY_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);
const PSEUDO_RE = /:{1,2}([a-zA-Z-]+)/y; // used with lastIndex (sticky)
const URL_OR_IMPORT_RE =
  /(?<![\w-])url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*?))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/gi;

// Index just past the quoted string that starts at i.
function endOfQuoted(text, i) {
  const quote = text[i];
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === quote) return j + 1;
  }
  return text.length;
}

// Index just past the bracket or paren group that starts at i.
function endOfGroup(text, i) {
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (ch === '\\') j++;
    else if (ch === '"' || ch === "'") j = endOfQuoted(text, j) - 1;
    else if (ch === '(' || ch === '[') depth++;
    else if ((ch === ')' || ch === ']') && --depth === 0) return j + 1;
  }
  return text.length;
}

// Split a selector list on top-level commas. Parens, brackets, quotes and escapes are respected.
export function splitSelectorList(selector) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === '\\') {
      cur += selector.slice(i, i + 2);
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = endOfQuoted(selector, i);
      cur += selector.slice(i, end);
      i = end - 1;
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if ((ch === ')' || ch === ']') && depth > 0) depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur.trim());
  return parts.filter(Boolean);
}

// Remove pseudo-elements and dynamic pseudo-classes from one selector (no commas).
// A compound left empty by the removal becomes "*": "a > :hover" becomes "a > *".
export function stripDynamicPseudos(selector) {
  let out = '';
  let compound = '';
  let stripped = false;
  const flush = () => {
    out += compound === '' && stripped ? '*' : compound;
    compound = '';
    stripped = false;
  };
  let i = 0;
  while (i < selector.length) {
    const ch = selector[i];
    if (ch === '\\') {
      compound += selector.slice(i, i + 2);
      i += 2;
    } else if (ch === '"' || ch === "'") {
      const end = endOfQuoted(selector, i);
      compound += selector.slice(i, end);
      i = end;
    } else if (ch === '(' || ch === '[') {
      const end = endOfGroup(selector, i);
      compound += selector.slice(i, end);
      i = end;
    } else if (ch === ':') {
      PSEUDO_RE.lastIndex = i;
      const m = PSEUDO_RE.exec(selector);
      const name = m ? m[1].toLowerCase() : '';
      const isElement = m && (m[0].startsWith('::') || LEGACY_PSEUDO_ELEMENTS.has(name));
      if (m && (isElement || DYNAMIC_PSEUDO_CLASSES.has(name))) {
        let end = i + m[0].length;
        if (m[0].startsWith('::') && selector[end] === '(') end = endOfGroup(selector, end);
        stripped = true;
        i = end;
      } else {
        compound += ch;
        i++;
      }
    } else if (ch === '>' || ch === '+' || ch === '~' || /\s/.test(ch)) {
      flush();
      out += ch;
      i++;
    } else {
      compound += ch;
      i++;
    }
  }
  flush();
  return out;
}

// Add guard to the subject compound of every selector in a list, before its first pseudo-element:
// "section#hero h1::before" becomes "section#hero h1<guard>::before". Ancestor compounds are left
// alone, so rules that start at html, body or the section root itself still match. A guard such as
// ":where(...)" adds no specificity.
export function guardSelectorList(selectorText, guard) {
  return splitSelectorList(selectorText)
    .map((selector) => guardSelector(selector, guard))
    .join(', ');
}

function guardSelector(selector, guard) {
  let pseudoAt = -1;
  let i = 0;
  while (i < selector.length) {
    const ch = selector[i];
    if (ch === '\\') {
      i += 2;
    } else if (ch === '"' || ch === "'") {
      i = endOfQuoted(selector, i);
    } else if (ch === '(' || ch === '[') {
      i = endOfGroup(selector, i);
    } else if (ch === '>' || ch === '+' || ch === '~' || /\s/.test(ch)) {
      pseudoAt = -1; // a new compound starts
      i++;
    } else if (ch === ':') {
      PSEUDO_RE.lastIndex = i;
      const m = PSEUDO_RE.exec(selector);
      const isElement = m && (m[0].startsWith('::') || LEGACY_PSEUDO_ELEMENTS.has(m[1].toLowerCase()));
      if (isElement && pseudoAt === -1) pseudoAt = i;
      i += m ? m[0].length : 1;
    } else {
      i++;
    }
  }
  if (pseudoAt === -1) return selector + guard;
  return selector.slice(0, pseudoAt) + guard + selector.slice(pseudoAt);
}

// Resolve ref against baseUrl. Returns null when the result is not a URL.
export function absoluteUrl(ref, baseUrl) {
  try {
    return new URL(String(ref).trim(), baseUrl).href;
  } catch {
    return null;
  }
}

// Replace every url() and string @import reference with mapper(ref).
// data: URLs and #fragments are left alone.
export function rewriteCssUrls(text, mapper) {
  return text.replace(URL_OR_IMPORT_RE, (match, dq, sq, bare, idq, isq) => {
    const ref = (dq ?? sq ?? bare ?? idq ?? isq ?? '').trim();
    if (!ref || ref.startsWith('data:') || ref.startsWith('#')) return match;
    const safe = String(mapper(ref)).replace(/"/g, '%22');
    return match[0] === '@' ? `@import "${safe}"` : `url("${safe}")`;
  });
}

export function absolutizeCssUrls(text, baseUrl) {
  return rewriteCssUrls(text, (ref) => absoluteUrl(ref, baseUrl) ?? ref);
}

function skipTrivia(text, start) {
  let i = start;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (!text.startsWith('/*', i)) return i;
    const end = text.indexOf('*/', i + 2);
    i = end < 0 ? text.length : end + 2;
  }
}

// Index of the ';' that ends the statement starting at i (or text.length).
function statementEnd(text, start) {
  for (let j = start; j < text.length; j++) {
    const ch = text[j];
    if (ch === '\\') j++;
    else if (ch === '"' || ch === "'") j = endOfQuoted(text, j) - 1;
    else if (ch === '(') j = endOfGroup(text, j) - 1;
    else if (ch === ';') return j;
  }
  return text.length;
}

// Parse the part of an @import after the keyword: url, optional layer(), supports(), media list.
export function parseImportStatement(stmt) {
  let s = stmt.trim();
  const head = /^url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*?))\s*\)|^"([^"]*)"|^'([^']*)'/i.exec(s);
  if (!head) return null;
  const url = (head[1] ?? head[2] ?? head[3] ?? head[4] ?? head[5] ?? '').trim();
  if (!url) return null;
  s = s.slice(head[0].length).trim();
  const imp = { url, layer: undefined, supports: undefined, media: '' };
  const layer = /^layer(?![\w-])(?:\(\s*([^)]*?)\s*\))?/i.exec(s);
  if (layer) {
    imp.layer = layer[1] ?? '';
    s = s.slice(layer[0].length).trim();
  }
  if (/^supports\(/i.test(s)) {
    const open = s.indexOf('(');
    const end = endOfGroup(s, open);
    imp.supports = s.slice(open + 1, end - 1).trim();
    s = s.slice(end).trim();
  }
  imp.media = s;
  return imp;
}

// Leading @import rules of a sheet, and the rest of the sheet after them.
export function splitLeadingImports(text) {
  const imports = [];
  let i = skipTrivia(text, 0);
  while (/^@import\b/i.test(text.slice(i, i + 8))) {
    const end = statementEnd(text, i);
    const imp = parseImportStatement(text.slice(i + 7, end));
    if (imp) imports.push(imp);
    i = skipTrivia(text, Math.min(end + 1, text.length));
  }
  return { imports, rest: text.slice(i) };
}

function supportsCondition(cond) {
  return /^\(|^[\w-]+\(/.test(cond) ? cond : `(${cond})`;
}

function wrapImport(css, imp) {
  let out = css;
  if (imp.layer !== undefined) out = `@layer${imp.layer ? ` ${imp.layer}` : ''} {\n${out}\n}`;
  if (imp.supports) out = `@supports ${supportsCondition(imp.supports)} {\n${out}\n}`;
  if (imp.media) out = `@media ${imp.media} {\n${out}\n}`;
  return out;
}

// Make url() and @import references absolute against baseUrl, then inline @import rules.
// fetchText(url) returns the sheet text or null. Imports nest up to maxDepth levels;
// deeper ones are dropped with a note. Problems go into notes.
export async function prepareSheet(text, { baseUrl, fetchText, notes = [], level = 1, maxDepth = 3 }) {
  const { imports, rest } = splitLeadingImports(absolutizeCssUrls(text, baseUrl));
  const parts = [];
  for (const imp of imports) {
    if (level > maxDepth) {
      notes.push(`@import nested deeper than ${maxDepth} levels left out: ${imp.url}`);
      continue;
    }
    const childText = await fetchText(imp.url);
    if (childText == null) {
      notes.push(`Could not fetch imported stylesheet ${imp.url}`);
      continue;
    }
    const inner = await prepareSheet(childText, { baseUrl: imp.url, fetchText, notes, level: level + 1, maxDepth });
    parts.push(wrapImport(inner, imp));
  }
  parts.push(rest);
  return parts.join('\n');
}
