# The gate

What the grade checks, how to read a failure and fix it, how the css-port fallback works, and which shortcuts count as cheating. The script contracts are in `scripts.md`. Motion checks are in `motion.md`.

## The numbers

All of them live in `GATE` in `scripts/lib/io.mjs`. Never change them.

| Setting | Value | Meaning |
| --- | --- | --- |
| `pixelPct` | 1.0 | Most differing pixels a section may have at one width, in percent of its unmasked pixels |
| `aaThreshold` | 0.1 | pixelmatch color threshold; anti-aliased pixels are ignored |
| `boxPx` | 2 | Most an element box may drift on x, y, width or height, relative to its section |
| `heightPx` | 2 | Most a section's width or height may differ before the pixel diff is skipped |
| `maskCapPct` | 15 | Most of a section that masks may cover |
| `motionPx` | 2 | Most a motion sample's box may differ |
| `motionOpacity` | 0.05 | Most a motion sample's opacity may differ |
| `motionMs` | 50 | Most a motion's start or end may differ, in ms |
| `motionStepMs` | 50 | Time between motion samples |
| `maxFixRounds` | 3 | Fix rounds after the first build |
| `plateauPoints` | 0.2 | A round that gains less than this, in section score, is flat |
| `plateauRounds` | 2 | Flat rounds in a row that end the fix loop for a section |

## What passes

A section passes at one width when it exists in the clone, its size is within 2 px, masks cover at most 15% of it, at most 1% of its unmasked pixels differ, and every element box is within 2 px. The section passes when it passes at every plan width and every state, geometry width, motion entry and reduced-motion check that belongs to it passes too. The page passes when every section passes.

The score is 100 minus the pixel diff percent at each width, averaged per section and then over the page. A width with a skipped diff scores 0. The score shows progress; pass and fail come from the checks.

## The fix loop

- Round 0 grades the first full build. Rounds 1 to 3 are fix rounds.
- Fix every section marked `fix`, then run one round. Never run a round twice on the same build: each round counts toward the limit and the plateau check. Use a scratch check (`round.mjs --scratch`) to try a change.
- A section's `next` becomes `fallback` when it still fails at round 3, or when its last 2 rounds were flat: each gained less than 0.2 points and did not lower its count of failing checks.
- After a section gets its fallback, run at most 2 more rounds.
- Changes to shared code such as the theme, the fonts or the layout can break sections that passed. Compare each round's failures with the last round's.

## Reading a failure

`round.mjs` prints short `failures` lines. `node "$PP/inspect.mjs" --grade --section <id>` prints the details for one section: sizes, the worst element deltas, missing and extra keys, style hints, and where the pixel diff sits. The full grade is `.pixel-perfect/grade/round-<n>/grade.json`.

Work through a section's failures in this order. Size failures turn off the pixel diff, and element drift causes most pixel diffs, so the later checks often clear once the earlier ones pass.

### missing

`hero @1440: missing`

The clone has no visible element with `data-pp-section="hero"` at that width. Put the attribute on the section's root element and keep the root visible at every width where the original shows the section. A width where the original section is missing is skipped.

### size

`hero @1440: size 1440x820, original 1440x812`

The pixel diff at that width is skipped until the size is within 2 px, so fix size first.

For height drift, find the first element in document order whose `delta.y` or `delta.h` is not 0. Every element after it moves by the same amount, so fix that one. Common causes:

- line height, or a fallback font with other metrics because the web font did not load,
- margins that collapse in the original and not in the clone, or the other way round,
- padding, gap or border width,
- an image with no width, height or aspect ratio,
- text that wraps at another point because of font size, letter spacing or max width.

Width drift usually comes from the root: its max width, padding or display.

### geometry

`hero @1440: geometry 3 failed, 1 missing`

Elements are paired by key, then by the nearest box center. A text element's key is its text, lowercased with whitespace collapsed, cut to 80 characters. Media use their type: `m:img`, `m:svg`, `m:video`, `m:canvas`, `m:iframe` or `m:bg` for a background image. The section root uses `root`.

- `failed` lists pairs more than 2 px apart, with their `delta`. The same `delta.y` on a run of elements means something above them has the wrong height. A `delta.w` or `delta.h` on text points to font size, font metrics, letter spacing or wrapping. A `delta.x` alone points to alignment, padding, gap or max width.
- `missing` lists original elements with no partner. The text differs (a typo, text split differently across elements, or text in another case: keep the source text as `index.html` has it and apply `text-transform` in CSS where the original does), the element is hidden, or the media has another form, such as an `<img>` rebuilt as a background image.
- `extra` lists clone elements with no partner. They do not fail. A missing key and an extra key at the same place mean the text or the media type differs.
- `hints` lists up to 12 computed style differences between paired elements, largest elements first. Fix these first. They often fix the geometry and the pixels too.

### pixels

`hero @1440: pixels 2.69%`

`regions` lists up to 5 boxes where the differing pixels gather, relative to the section's top-left corner. `inspect.mjs --grade --section <id>` names the original elements under each box. Causes, roughly from most to least common:

- Fonts: wrong family, weight or style, or a font file that did not load. Check the `fonts.css` import and the files in `public/assets/font/`. Font smoothing changes every glyph edge: remove the scaffold's `antialiased` class unless the original sets `-webkit-font-smoothing` the same way.
- Colors: compare the exact computed values in `hints`. Tailwind palette colors are defined in oklch and rarely equal the original's hex values, so use arbitrary values such as `text-[#1a1a1a]`. Check opacity layering too: `bg-black/50` and an `rgba()` background can differ.
- Images: copy `src`, `srcset` and `sizes` as `index.html` has them, so the browser picks the same file. Use a plain `<img>`, keep `object-fit` and `object-position`, and match background size, position and repeat.
- Edges: border radius, box shadow, 1 px borders and outlines. A fractional position blurs text and border edges, so check boxes for half pixels.
- Text rendering: letter spacing, word spacing, `font-feature-settings`, kerning, ligatures and font synthesis.
- Icons: keep inline SVGs inline, with the same `viewBox`, stroke width and fill. Never swap in an icon font or another icon set.

### states

`header @390: state nav-open 2.10%`, `header @390: state nav-open missing`

- `missing`: no element with `data-pp-trigger` containing the state id, or the trigger has no box at that width, or something covers it so the mouse never reaches it. Put the attribute on the element the user clicks or hovers, and keep it visible at that width.
- After the action, the capture moves the page clock 1 s forward and waits for the page to settle. Open, hover and focus styles must finish within that second, so a slower transition fails.
- The check covers the area that changed in the original, grown by 16 px on each side. A geometry failure in a state means element boxes in the opened state differ.
- A state that changes nothing in the original passes with a note.

### geometry widths

`hero @767: geometry-width 4 failed`

The clone switches layout at another width than the original. Geometry widths sit on both sides of the original's breakpoints. The usual cause is Tailwind's default breakpoints. Use the breakpoints in `tokens.json` with the same direction as the original's media query. Tailwind's `min-[900px]:` compiles to `width >= 900px`, the same as `min-width: 900px`. Its `max-*` variants compile to `width < N`, while `max-width: N` includes N itself, so add one pixel: `max-width: 899px` becomes `max-[900px]:`. For breakpoints used in many places, define `--breakpoint-*` theme variables as references/stack.md shows.

### motion and reduced motion

`hero @1440: motion load:hero 14.2px, opacity 0.31, end +300ms`, `logos @390: reduced loop:logos moved`

See "Reading a failure" in `motion.md`.

### unassigned

`unassigned` lists `data-pp-section` ids in the clone that the plan does not have. They are not graded. This is usually a typo, so the section the id was meant for also shows up as `missing`.

## Masks

Every mask from either side is painted one flat color on both screenshots before the pixel diff. Masks come from:

- `iframe`, `canvas`, `embed` and `object` elements, on both sides,
- plan masks (`masks` in plan.json, each with a `reason`), on the original,
- `data-pp-mask` elements, on the clone,
- live areas: 32 px tiles that changed during the original's stability pass.

Masks only take pixels out of the pixel diff. Element boxes under a mask are still checked.

Masks may cover at most 15% of a section at each width; above that the width fails with `mask-cap`. When the original's own live content, such as a background video, a ticker or a map, covers more than 15% of a section, the clone cannot fix it. The section stays failing and the final message says how much of it is live. Never split a section, shrink a mask or move content to get under the cap. A `data-pp-mask` placeholder counts toward the cap, so size it to the original widget's box and never larger.

## Changing the plan

- Before round 0, edit the plan freely.
- After round 0, edit it only to fix a real mistake: a missed state, a wrong trigger selector, a missing motion entry, a section boundary that cuts through a block, or live content the stability pass missed. Removing a wrong mask is fine, because it makes the check stricter.
- Never drop or weaken a check because it fails. That rules out removing states, motion entries, widths or geometry widths, masking content that does not change between loads, and merging sections to dilute a diff.
- After every edit, remove `.pixel-perfect/original` and capture again, and run extract again if the sections changed. The round count carries on, so earlier rounds were graded against the old plan.
- List every plan edit made after round 0 in the final message, with its reason.

## The css-port fallback

When a section's grade says `fallback` with `css-port`, rebuild the section on the original's own CSS. `scoped.css` holds every rule that applies to the section, rewritten so it can be imported into the clone without leaking into other sections.

1. Copy `.pixel-perfect/source/<id>/scoped.css` unchanged to `src/components/sections/<id>.port.css`, and import it from the section component: `import './<id>.port.css';`. Do not edit or reformat it. If extract runs again, copy it again.
2. Rebuild the markup from `.pixel-perfect/source/<id>/index.html` with the same tags, nesting, ids, classes and attributes, copied exactly. The ported rules match on these, and the attribute rules described below match exact attribute values such as `align="center"` or `type="a"`. Keep wrapper elements even when they look useless.
3. Keep `data-pp-section="<id>"` on the root and add `data-pp-fallback="css-port"`.
4. Leave Tailwind classes off the ported markup. The reset wipes them inside the section.
5. Where the original styles open and closed states with classes or attributes (`is-open`, `active`, `aria-expanded="true"`, `[open]`), set the same class or attribute names from component state, so the ported rules apply.
6. When rules need classes on an ancestor outside the section, such as `html.js` or `body.home`, add those classes to `<html>` or `<body>` in the layout. The guards keep those rules inside the section.

### How scoped.css works

The file starts with `@layer theme, base, components, utilities, pp-reset, pp-inherit, pp-hints, pp-port;`, so its layers sit after Tailwind's.

- `pp-reset`: `all: revert` on the section root and on every element inside it except SVG content, so Preflight, utilities and base styles no longer reach the section. An outer `<svg>` only gets its display, vertical alignment, box sizing, margin, padding and border reverted, and elements inside an SVG keep their presentation attributes. Preflight's `border` style still reaches SVG content; it shows up as computed style differences on SVG shapes and has no visible effect.
- `pp-inherit`: the values the section root inherited in the original, such as font, color, line height and letter spacing, measured at 1440 px. Font properties like `font-stretch` and `font-feature-settings` sit in a second rule, because some minifiers merge a full set of font longhands into one `font` shorthand that Chrome rejects.
- `pp-hints`: the styles that HTML attributes add and `all: revert` removes: `width` and `height` on images, video, iframes, embeds, tables, rows, cells and columns, `width` on `hr`, table `cellpadding`, `cellspacing`, `border` and `align`, `bgcolor` and `valign` on table parts, `nowrap` on cells, `align` on `div`, `p`, headings and table parts, list `type`, iframe `frameborder`, and `hidden`.
- `pp-port`: the original's rules. Each selector is limited to the section with `:where([data-pp-section="<id>"], [data-pp-section="<id>"] *)` on its subject, placed before any pseudo-element, which adds no specificity. Ancestor parts of a selector stay as they were. The original's named layers keep their order inside `pp-port`. `@media` wrappers stay, so the section switches at the original's breakpoints. The file also holds the `@font-face` and `@keyframes` rules the section uses.

### Old HTML attributes in JSX

React types some old attributes and not others. All of these forms build in Next.js:

- Typed, write them as props: `cellPadding="4"`, `cellSpacing="0"`, `border={1}` on `table`, `valign="top"` and `width="60"` on `td`, `frameBorder="0"`, `type="a"` on `ol`, `hidden`, and `width={40} height={20}` on `img`.
- Not typed, spread them: `<td valign="top" {...{ nowrap: '', bgcolor: '#eeeeee' }}>` or `<p {...{ align: 'center' }}>`. When the spread is the element's only attribute and the element has no children, TypeScript rejects it with TS2559, so cast it: `<hr {...({ width: '50%' } as Record<string, string>)} />`.
- Whitespace: JSX drops the line break between elements on separate lines, but the original keeps a space there. Keep inline neighbors such as an `<img>` next to an `<svg>` on one line with a space between them, or put `{' '}` between them.

### Limits

These cases do not port exactly. Fix them by hand in the component or in a small extra CSS file, never in `scoped.css`:

- An `em` or `%` font size on the section root resolves against the clone's parent.
- Rules in anonymous layers end up after the named layers.
- `currentcolor` inside `text-shadow` becomes a fixed color.
- `:root:has()` rules are left out.
- Preflight's `[hidden]` rule is `!important` and wins, so an element with `hidden` that the original shows through CSS stays hidden.
- These attributes are not rebuilt: everything on `font`, `size`, `color` and `noshade` on `hr`, `align`, `border`, `hspace` and `vspace` on `img`, `frame`, `rules`, `bordercolor` and `background` on `table`, `wrap` on `pre`, and `contenteditable`.
- When one section uses both `type="a"` and `type="A"` lists, both get the same numbering.
- Tailwind classes from the clone can still reach SVG content, and HTML inside `foreignObject` is not reset.
- Inherited values are measured at 1440 px only.

## Forbidden shortcuts

Each of these makes the grade report something false. When the honest fix fails, use the fallback. When the fallback fails too, the section stays failing and the report says so.

- Editing `GATE`, any script in the skill, or anything under `.pixel-perfect/original/` or `.pixel-perfect/grade/`.
- Changing the plan outside the rules in "Changing the plan".
- Deleting, renaming or overwriting round folders, or passing `--round` to replace an earlier round.
- Masks over content that does not change between loads, and `data-pp-mask` placeholders larger than the widget they stand for.
- Screenshots or captured PNGs in the clone, such as a picture of a section, a heading or an icon in place of the real thing.
- Forcing boxes into place with absolute positions, transforms, negative margins or fixed heights that the original does not use.
- Detecting the capture through headless Chrome, `navigator.webdriver`, the frozen clock, the viewport sizes or the `data-pp-*` attributes, to show the capture a different page.
- Hiding elements at some widths so the grade skips them.
- Copying the original's JavaScript, or loading the original page in an iframe.
