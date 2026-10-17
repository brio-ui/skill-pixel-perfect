import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  absolutizeCssUrls,
  absoluteUrl,
  guardSelectorList,
  prepareSheet,
  rewriteCssUrls,
  splitSelectorList,
  stripDynamicPseudos,
} from '../lib/css-text.mjs';

test('splitSelectorList splits on top-level commas only', () => {
  assert.deepEqual(splitSelectorList('a, b:is(c, d), [data-x="1,2"], e\\,f'), [
    'a',
    'b:is(c, d)',
    '[data-x="1,2"]',
    'e\\,f',
  ]);
  assert.deepEqual(splitSelectorList("p[title='a,b'] , .x"), ["p[title='a,b']", '.x']);
});

test('stripDynamicPseudos removes dynamic pseudo-classes and pseudo-elements', () => {
  assert.equal(stripDynamicPseudos('a:hover'), 'a');
  assert.equal(stripDynamicPseudos('a > :hover'), 'a > *');
  assert.equal(stripDynamicPseudos('p::before'), 'p');
  assert.equal(stripDynamicPseudos('p::after'), 'p');
  assert.equal(stripDynamicPseudos('div:first-line'), 'div');
  assert.equal(stripDynamicPseudos('div:first-letter'), 'div');
  assert.equal(stripDynamicPseudos('li:first-child:focus-visible'), 'li:first-child');
  assert.equal(stripDynamicPseudos('a:focus-visible .x'), 'a .x');
  assert.equal(stripDynamicPseudos('input:focus-within'), 'input');
  assert.equal(stripDynamicPseudos('a:visited'), 'a');
  assert.equal(stripDynamicPseudos('section:target'), 'section');
  assert.equal(stripDynamicPseudos('button:active'), 'button');
  assert.equal(stripDynamicPseudos(':hover'), '*');
  assert.equal(stripDynamicPseudos('::selection'), '*');
});

test('stripDynamicPseudos keeps structural pseudo-classes and pseudo-element arguments intact', () => {
  assert.equal(stripDynamicPseudos('a:not(:hover)'), 'a:not(:hover)');
  assert.equal(stripDynamicPseudos('li:nth-child(2n+1)'), 'li:nth-child(2n+1)');
  assert.equal(stripDynamicPseudos('a[href^="x:hover"]'), 'a[href^="x:hover"]');
  assert.equal(stripDynamicPseudos('::part(label):hover'), '*');
});

test('guardSelectorList adds the guard to each subject compound, before pseudo-elements', () => {
  const g = ':where(.s, .s *)';
  assert.equal(guardSelectorList('.hero .title', g), `.hero .title${g}`);
  assert.equal(guardSelectorList('section#hero h1::before', g), `section#hero h1${g}::before`);
  assert.equal(guardSelectorList('p:first-line', g), `p${g}:first-line`);
  assert.equal(guardSelectorList('a:hover, b > c', g), `a:hover${g}, b > c${g}`);
  assert.equal(guardSelectorList('.a:is(.b, .c)::after', g), `.a:is(.b, .c)${g}::after`);
  assert.equal(guardSelectorList('::selection', g), `${g}::selection`);
  assert.equal(guardSelectorList('.bar::-webkit-scrollbar-thumb:hover', g), `.bar${g}::-webkit-scrollbar-thumb:hover`);
  assert.equal(guardSelectorList('.md\\:flex', g), `.md\\:flex${g}`);
  assert.equal(guardSelectorList('a[title="x ::before"]', g), `a[title="x ::before"]${g}`);
  assert.equal(guardSelectorList('li:nth-child(2n + 1)~li', g), `li:nth-child(2n + 1)~li${g}`);
});

test('absoluteUrl resolves against the base and returns null for bad input', () => {
  assert.equal(absoluteUrl('../x.css', 'https://a.test/b/c/'), 'https://a.test/b/x.css');
  assert.equal(absoluteUrl('http://[', 'nope'), null);
});

test('absolutizeCssUrls makes url() and string @import references absolute', () => {
  const css = [
    '.a { background: url(img/a.png); }',
    '.b { background: url("data:image/png;base64,AA"); }',
    '.c { fill: url(#gradient); }',
    "@import 'more.css';",
  ].join('\n');
  const out = absolutizeCssUrls(css, 'https://cdn.test/css/site.css');
  assert.match(out, /url\("https:\/\/cdn\.test\/css\/img\/a\.png"\)/);
  assert.match(out, /url\("data:image\/png;base64,AA"\)/);
  assert.match(out, /url\(#gradient\)/);
  assert.match(out, /@import "https:\/\/cdn\.test\/css\/more\.css";/);
});

test('rewriteCssUrls passes the mapper result through and escapes double quotes', () => {
  const out = rewriteCssUrls('a { background: url(https://x.test/a.png); }', (ref) =>
    ref === 'https://x.test/a.png' ? '/assets/a"b.png' : ref,
  );
  assert.equal(out, 'a { background: url("/assets/a%22b.png"); }');
});

test('prepareSheet inlines nested imports with media, supports and layer wrappers', async () => {
  const files = {
    'https://cdn.test/a.css': '@import "b.css" (min-width: 600px);\n.a { color: red; }',
    'https://cdn.test/b.css': '@import url("c.css") layer(theme) supports(display: grid);\n.b { color: blue; }',
    'https://cdn.test/c.css': '.c { color: green; }',
  };
  const fetched = [];
  const fetchText = async (url) => {
    fetched.push(url);
    return files[url] ?? null;
  };
  const notes = [];
  const out = await prepareSheet('@import url("https://cdn.test/a.css");\n.top { margin: 0; }', {
    baseUrl: 'https://cdn.test/index.css',
    fetchText,
    notes,
  });
  assert.deepEqual(fetched, ['https://cdn.test/a.css', 'https://cdn.test/b.css', 'https://cdn.test/c.css']);
  assert.match(out, /@media \(min-width: 600px\) \{/);
  assert.match(out, /@layer theme \{/);
  assert.match(out, /@supports \(display: grid\) \{/);
  assert.match(out, /\.c \{ color: green; \}/);
  assert.match(out, /\.top \{ margin: 0; \}/);
  assert.doesNotMatch(out, /@import/);
  assert.deepEqual(notes, []);
});

test('prepareSheet drops imports deeper than maxDepth with a note', async () => {
  const files = {
    'https://cdn.test/a.css': '@import "b.css";\n.a { color: red; }',
    'https://cdn.test/b.css': '.b { color: blue; }',
  };
  const notes = [];
  const out = await prepareSheet('@import url("https://cdn.test/a.css");', {
    baseUrl: 'https://cdn.test/index.css',
    fetchText: async (url) => files[url] ?? null,
    notes,
    maxDepth: 1,
  });
  assert.match(out, /\.a \{ color: red; \}/);
  assert.doesNotMatch(out, /\.b \{/);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /nested deeper than 1 levels/);
  assert.match(notes[0], /b\.css/);
});

test('prepareSheet records a note for an import that cannot be fetched', async () => {
  const notes = [];
  const out = await prepareSheet('@import url("https://cdn.test/missing.css");\n.top { margin: 0; }', {
    baseUrl: 'https://cdn.test/index.css',
    fetchText: async () => null,
    notes,
  });
  assert.match(out, /\.top \{ margin: 0; \}/);
  assert.deepEqual(notes, ['Could not fetch imported stylesheet https://cdn.test/missing.css']);
});
