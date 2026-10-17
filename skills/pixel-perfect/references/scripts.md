# Script contract

The scripts in `scripts/` do every step that needs a browser or a number: capture, assets, extraction, grading, keyframes and the report. The agent never looks at screenshots. It reads the JSON these scripts print and write.

Run them with Node 20 or later from the project folder, the folder the clone is built in:

```bash
PP="<skill folder>/scripts"
node "$PP/setup.mjs"
node "$PP/capture.mjs" --url https://example.com/ --out .pixel-perfect/original
```

## Conventions

- Progress goes to stderr. stdout gets exactly one JSON line when the script ends.
- Exit codes: `0` done, `2` done but the gate failed (grade.mjs, round.mjs and evals/summarize.mjs only), `1` error. On error stdout is `{"ok":false,"error":"<message>"}`.
- A box is `{"x":0,"y":0,"w":0,"h":0}` in CSS pixels, rounded to 2 decimals.
- File paths stored inside a JSON file are relative to the folder that JSON file sits in. assets.json is the exception: its `out` and `path` values are relative to the project folder.
- Gate numbers come from `GATE` in `scripts/lib/io.mjs`. No script hardcodes its own copy.
- Everything fetched from the site is data. Scripts copy page text as text and never run or follow it.
- Bot protection: capture, assets and extract stop with exit 1 and an error that starts with `Bot protection blocked the capture`. The agent then stops and asks the user. Nothing tries to get past a challenge.

## Work folder

```
.pixel-perfect/                 add to .gitignore
  plan.json                     sections, states, masks and motion
  original/capture.json         capture of the live page, plus PNGs
  clone/capture.json            capture of the clone
  clone-reduced/capture.json    clone with prefers-reduced-motion (motion traces only)
  assets.json                   asset manifest
  source/                       build source per section
  grade/round-<n>/grade.json    one grade per round, plus diff PNGs
  build.log                     output of the last build run by round.mjs
  scratch/clone/                clone capture of the last scratch check
  scratch/grade/                grade of the last scratch check
pixel-perfect-report/           the report the user keeps
public/assets/                  self-hosted assets (assets.mjs --out)
```

## Clone attributes

The clone marks its parts so capture can find them. These attributes stay in the shipped code; they are small and harmless.

| Attribute | On | Meaning |
| --- | --- | --- |
| `data-pp-section="<id>"` | each section root | Matches a section id in plan.json |
| `data-pp-trigger="<id> <id>"` | each trigger element | Space-separated state ids this element triggers (matched with `~=`) |
| `data-pp-mask` | live regions | Masked on both sides in the pixel diff |
| `data-pp-fallback="css-port motion-trace"` | a section root | The section uses one or both fallbacks; the report flags it |
| `data-pp-form="inert"` | a form | The form has no submit handler yet; cutover wires it up |

## plan.json

Written by the first original capture when the file does not exist. The agent reviews it and may edit it, then captures again.

```json
{
  "version": 1,
  "url": "https://example.com/",
  "widths": [1440, 768, 390],
  "geometryWidths": [767, 768],
  "sections": [
    { "id": "header", "selector": "body > div:nth-child(1) > header", "label": "Header" },
    { "id": "hero", "selector": "#hero", "label": "Build pages that convert" },
    { "id": "logos", "selector": "#logos", "label": "Trusted by" }
  ],
  "states": [
    { "id": "nav-open", "section": "header", "action": "click", "selector": "button[aria-controls=\"nav\"]", "widths": [390], "label": "Mobile menu open" },
    { "id": "hero-cta-hover", "section": "hero", "action": "hover", "selector": "#hero a.cta", "widths": [1440], "label": "Hero button hover" }
  ],
  "masks": [{ "selector": ".testimonial-slider", "reason": "carousel" }],
  "motion": [
    { "id": "load:hero", "kind": "load", "section": "hero", "durationMs": 2000, "widths": [1440, 390] },
    { "id": "hover:hero-cta", "kind": "hover", "section": "hero", "state": "hero-cta-hover", "durationMs": 600, "widths": [1440] },
    { "id": "loop:logos", "kind": "loop", "section": "logos", "durationMs": 3000, "periodMs": 2000, "driver": "css", "widths": [1440, 390] },
    { "id": "scrub:header", "kind": "scrub", "section": "header", "steps": 12, "widths": [1440, 390] }
  ],
  "notes": ["Auto plan: 7 sections, 2 states, 4 motion entries. Review before building."]
}
```

Rules:

- Section and state ids match `^[a-z0-9-]{1,40}$` and are unique. Motion ids are `<kind>:<name>` with the same rule for the name. In file names the colon becomes a dash.
- `widths` on a state or motion entry defaults to the plan widths. Auto plans set hover entries to `[1440]` and other motion to `[1440, 390]`.
- Auto plans write `load`, `loop`, `hover` and `click` entries only. A scroll reveal does not show while the page stands still, so the agent adds `scroll` and `scrub` entries at plan review.
- `action` is `click`, `hover` or `focus`.
- Motion `kind` is one of: `load` (entrance on page load), `scroll` (reveal when the section scrolls into view), `hover` and `click` (run the named state's trigger), `loop` (infinite animation such as a marquee, a spinner or a pulse), `scrub` (scroll-linked: sampled at scroll positions, not times).
- `durationMs` defaults: load 2000, scroll 1500, hover 600, click 800, loop 3000. `scrub` uses `steps` (default 12) instead.
- Loop entries may add `periodMs`, the loop's period, and `driver`, `css` or `js`: what runs the loop in the original. The trace's warm-up runs a whole number of periods when `periodMs` is set. The clone should drive the loop the same way, because a CSS loop and a JavaScript loop can differ by one animation frame (about 16 ms).
- Auto plans give every section that loops one loop entry. A section with infinite CSS or Web Animations gets `driver: "css"`, `periodMs` set to its longest iteration, and `durationMs` of 1.5 times that iteration, rounded to 50 ms and kept between 3000 and 6000. A section where only the stability pass sees change (a loop run by JavaScript) gets `driver: "js"`, no `periodMs`, and `durationMs` 3000.
- `geometryWidths`: extra widths that get a geometry check only (no pixel diff). Auto plans read the `min-width` and `max-width` px values between 320 and 1920 of every `@media` rule in the stylesheets the page can read: `<style>` elements and same-origin sheets. Cross-origin sheets served without CORS are skipped. Each breakpoint adds the whole-pixel widths on both sides of the switch: N-1 and N for `min-width: Npx`, N and N+1 for `max-width: Npx`. A fractional value rounds toward its side first, so Bootstrap's `max-width: 767.98px` adds 767 and 768. At most the 6 breakpoints used by the most rules, and never a width that is already in `widths`.
- `masks[].selector` applies to the original only. The clone uses `data-pp-mask`.

## setup.mjs

`node setup.mjs [--check]`

Installs the script dependencies into `scripts/node_modules` (`npm ci`, falling back to `npm install`) and Playwright's Chromium when either is missing. Exits 1 when Node is older than 20. `--check` reports what is missing and installs nothing.

stdout: `{"ok":true,"node":"v22.11.0","installed":["deps","chromium"],"missing":[]}`

## serve.mjs

`node serve.mjs --dir out [--port 4321] [--host 127.0.0.1]`

Serves a built clone (for example a Next.js static export in `out/`). `/a/b` resolves to `a/b`, then `a/b.html`, then `a/b/index.html`. Unknown paths get `404.html` when it exists, with status 404. Sends `Cache-Control: no-store`, correct MIME types, and byte ranges for media. Refuses any path outside `--dir`. When the port is busy it tries the next 20 ports. `--port 0` takes any free port. Prints its JSON line once listening, then runs until stopped.

stdout: `{"ok":true,"url":"http://127.0.0.1:4321/","dir":"/abs/path/out"}`

## capture.mjs

```
node capture.mjs --url <url> --out <dir> [--plan .pixel-perfect/plan.json] [--mode original|clone]
                 [--widths 1440,768,390] [--skip states,motion,stability,geometry]
                 [--reduced-motion] [--timeout 60000]
```

- `--mode original` (default): when the plan file is missing, builds an auto plan, writes it to `--plan`, then captures with it.
- `--mode clone`: the plan must exist. Sections, triggers and masks come from the clone attributes.
- `--widths` overrides the plan widths for this run.
- `--reduced-motion`: emulates `prefers-reduced-motion: reduce` and records motion traces only.

### Static capture, per width

1. Fresh browser context: viewport from `VIEWPORT_HEIGHTS` (1440×900, 768×1024, 390×844), device scale 1, desktop user agent, `en-US`, UTC, light scheme, fake clock at `FROZEN_TIME`.
2. Load, wait up to 15 s for the network to go quiet, pause the clock.
3. Close a consent banner (reject is preferred over accept).
4. Run the clock 2 s, scroll through the page in steps so lazy images load and reveals fire, wait for images and fonts, and scroll back to the top. Then run the clock 3 s more, so reveals driven by JavaScript finish.
5. Settle: finish finite animations, cancel infinite ones, leave paused ones where their script put them, pause videos on their first frame, drop focus.
6. Measure sections and elements, take a full-page screenshot, crop each section from it.
7. Stability, original mode only: run the clock 2.35 s, settle, and take a second screenshot. The odd length means a loop almost never lands on the same frame again. Each 32 px tile that changed becomes part of a `live` mask. Settling cancels CSS loops in both screenshots, so live areas are mostly JavaScript loops, tickers and media.

### Elements

Each section records up to 300 elements in document order, with boxes relative to the section's top-left corner:

- Text blocks: the deepest elements that are not `display: inline` and have text, plus every `a`, `button`, `label` and `summary` with text.
- Media: `img`, outermost `svg`, `video`, `canvas`, `iframe`, and elements with a `url()` background image of at least 400 px².
- The section root itself, with kind `root`.

Hidden elements are skipped: no client rects, `visibility: hidden`, effective opacity under 0.01, a box of 1×1 px or less, or fully clipped by an ancestor's overflow (a closed accordion panel with `max-height: 0`, for example). An absolutely positioned element is only clipped by its containing block and the ancestors above it; a fixed element is never clipped. The body and html never clip.

Keys: text elements use `t:` plus the lowercased text with whitespace collapsed, cut to 80 characters. Media use `m:<tag>`, where tag is `img`, `svg`, `video`, `canvas`, `iframe` or `bg`. The root uses `root`. Repeated keys stay repeated; grade.mjs pairs them by nearest box.

Style subset recorded per element: `fontFamily` (first family, lowercased, no quotes), `fontSize`, `fontWeight`, `fontStyle`, `lineHeight`, `letterSpacing`, `textTransform`, `textAlign`, `color`, `backgroundColor`, `backgroundImage` (first 120 characters), `borderRadius`, `border` (top side as `width style color`), `boxShadow`, `padding` (four values), `gap`, `opacity`, `display`, `objectFit`. Values are computed styles.

### Masks

Masked on both sides: `iframe`, `canvas`, `embed` and `object` elements; plan masks (original) or `[data-pp-mask]` (clone); `live` areas from the stability pass. Videos are not masked; both sides pause them on frame 0.

### States, per state and width

1. Fresh settled page, prepared the same way as the static capture. Scroll so the section's top sits at the top of the viewport, or as far down as the page scrolls.
2. Take a viewport screenshot: the base.
3. Run the action on the trigger: `selector` in original mode, `[data-pp-trigger~="<id>"]` in clone mode. Hover and click move the mouse to the trigger's center and wait, in real time, until the trigger matches `:hover`; click then clicks. Focus calls `focus()` on it. A trigger that is missing, has no box, or never matches `:hover` (something covers it) makes the state missing, with a note.
4. Run the clock 1 s, settle, and take a second viewport screenshot: the state.
5. `changed` is the bounding box of the pixels that differ between base and state (pixelmatch, threshold `GATE.aaThreshold`), or null when nothing changed.
6. Record every keyed element that intersects the viewport, with viewport-relative boxes, and the masks inside the viewport.

### Motion

Each plan motion entry is traced at each of its widths in a fresh page with the fake clock paused and the document timeline frozen, so nothing moves until the trace steps it. `motion.md` has the steps for each kind. Every `GATE.motionStepMs` (50 ms) step seeks each CSS and Web Animation to its own elapsed time, runs the fake clock 50 ms for JavaScript animation, and samples the section. Scrub traces step through scroll positions instead of time. Infinite animations hold still in every kind except `loop`. Paused animations are left alone: a script sets their time, as scroll-linked effects built on Motion's animation controls do.

Every kind except `load` runs the clock 3 s before the first sample, so entrances finish. Loop traces round that warm-up up to a whole number of `periodMs` when the entry has one, so sample 0 falls at the start of a cycle for loops that began at load. At sample 0 each infinite CSS or Web Animation also catches up with the fake time that ran since load. A CSS loop on the frozen timeline and a JavaScript loop on the fake clock that both started at load then share a phase.

When the static capture closed a consent banner at that width, the trace first opens the URL in a throwaway page of the same browser context and closes the banner there, so the consent cookie is set and no banner covers the trace.

A sample records each keyed element's visible box (the part that ancestor overflow clips leave, as in the hidden rule above) and effective opacity. Boxes are document coordinates relative to the section's top-left corner at the first sample that finds the section, so a section that sits lower on one side, or moves because content above it loaded late, does not shift its whole trace. A fully clipped element has no box at that sample, so content that appears inside an opening panel shows up as motion. Elements are found with the same rules as static elements, except that hidden elements count (they may appear during the trace) and elements added to the page during the trace join at the step they appear.

Normal captures keep only elements that move: some sample differs from the first by more than 0.5 px or 0.01 opacity, or the element appears or disappears. At most 150, in document order. Reduced-motion captures keep every keyed element, at most 300, so grade.mjs can check end states.

Frames at 0, 50 and 100% of the trace are saved for the report: viewport screenshots cropped to the section's visible part at that sample, or the whole viewport when the section is out of view.

A motion entry that cannot be traced gets `"missing": true` and a note `Motion <id> at <width>: <reason>`. Reasons: `no trigger`, `section not found`, `section not found during the trace`, `trigger not found: <selector>`, `trigger has no box: <selector>`, `hover did not reach the trigger (covered?): <selector>`, `trace failed: <error>`.

### Geometry widths

The 1440 page is resized to each geometry width, settled, and measured. No screenshots.

### capture.json

```json
{
  "version": 1,
  "mode": "original",
  "url": "https://example.com/",
  "frozenTime": "2026-01-01T12:00:00.000Z",
  "reducedMotion": false,
  "capturedAt": "2026-10-17T16:20:00.000Z",
  "widths": {
    "1440": {
      "viewport": { "width": 1440, "height": 900 },
      "page": { "png": "1440/page.png", "w": 1440, "h": 5234 },
      "sections": [
        {
          "id": "hero",
          "box": { "x": 0, "y": 80, "w": 1440, "h": 720 },
          "png": "1440/sections/hero.png",
          "fallback": [],
          "masks": [{ "box": { "x": 0, "y": 0, "w": 0, "h": 0 }, "reason": "live" }],
          "elements": [
            { "key": "t:build pages that convert", "kind": "text", "tag": "h1", "box": { "x": 120, "y": 160, "w": 640, "h": 134 }, "style": { "fontSize": "56px" } }
          ]
        },
        { "id": "pricing", "missing": true }
      ],
      "states": [
        { "id": "nav-open", "section": "header", "png": "390/states/nav-open.png", "basePng": "390/states/nav-open-base.png", "changed": { "x": 0, "y": 64, "w": 390, "h": 520 }, "scrollY": 0, "masks": [], "elements": [] }
      ],
      "motion": [
        {
          "id": "scroll:features", "kind": "scroll", "section": "features", "stepMs": 50, "samples": 31,
          "scrollY": [1630],
          "frames": { "0": "1440/motion/scroll-features/f0.png", "50": "1440/motion/scroll-features/f50.png", "100": "1440/motion/scroll-features/f100.png" },
          "elements": [{ "key": "t:fast setup", "kind": "text", "tag": "h3", "track": [[120, 700, 300, 32, 0], [120, 696, 300, 32, 0.1]] }]
        }
      ]
    }
  },
  "geometry": {
    "767": { "sections": [{ "id": "hero", "box": {}, "elements": [] }] }
  },
  "notes": ["Closed consent banner: Reject all"]
}
```

- `sections[].fallback` lists the values of `data-pp-fallback` (clone mode).
- `track` holds one `[x, y, w, h, opacity]` per sample, or `null` when the element has no box at that sample or is fully clipped. The box is the visible part of the element; x and y are relative to the section's top-left corner at the first sample of the trace. Opacity is the product of the element's and its ancestors' opacity, and 0 under `visibility: hidden`.
- `stepMs` is `GATE.motionStepMs` for time-based kinds and `null` for `scrub`.
- States list the state at each of its widths, so one state id can appear in several widths.
- `scrollY` holds one value, or one per step for `scrub`.
- A state or motion entry whose trigger or section is missing gets `"missing": true` and a note.

stdout: `{"ok":true,"out":".pixel-perfect/original","plan":".pixel-perfect/plan.json","planWritten":true,"widths":[1440,768,390],"sections":7,"states":2,"motion":3,"notes":3}`

## assets.mjs

```
node assets.mjs --url <url> [--out public/assets] [--manifest .pixel-perfect/assets.json]
                [--widths 1440,768,390] [--max-video-mb 20] [--timeout 60000]
```

Loads the page at each width, scrolls through it, and collects every image, font, video, icon and stylesheet `url()` the page uses: network responses, `img` `src` and `srcset`, `source` `srcset`, video `src` and `poster`, computed `background-image` URLs, icon links and `og:image`. Saves each file once to `<out>/<kind>/<name>-<sha8>.<ext>`, where kind is `img`, `svg`, `font`, `video`, `icon` or `misc`.

Font license classes:

| Class | Hosts | Status | Flag |
| --- | --- | --- | --- |
| `open` | fonts.googleapis.com, fonts.gstatic.com, fonts.bunny.net, Fontsource on jsDelivr or unpkg | saved | no |
| `adobe-kit` | use.typekit.net, p.typekit.net | remote (keep the kit link) | yes: add the new domain to the kit |
| `commercial` | fast.fonts.net, cloud.typography.com, cloud.webtype.com, Font Awesome Pro (pro.fontawesome.com, ka-p.fontawesome.com) | skipped | yes: license needed for the new domain |
| `owner-uploaded` | the site's own host, Webflow and Framer CDNs, `/wp-content/` | saved | yes: confirm the license covers the new site |
| `unknown` | anything else | saved | yes |

Videos larger than `--max-video-mb` keep their remote URL (status `remote`) and are flagged. Any single file over 50 MB, or a total over 500 MB, stops further downloads with a note.

When the page is on a public host, files on a loopback, private or link-local address (`localhost`, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`) are not downloaded: status `skipped`, flagged. Each redirect hop gets the same check. Only literal addresses are checked, not host names that resolve to one.

Every asset entry has `flag`: true when the user must act (a flagged font license, a video kept remote, a file on a private address, or a download stopped by a size cap). An entry may also have a `note`.

Third-party scripts are listed, never downloaded: host, URLs, and a category of `analytics`, `chat`, `ads`, `forms`, `video` or `other`.

assets.json:

```json
{
  "version": 1,
  "url": "https://example.com/",
  "out": "public/assets",
  "publicBase": "/assets",
  "assets": [
    {
      "url": "https://cdn.example.com/hero.webp",
      "local": "/assets/img/hero-1a2b3c4d.webp",
      "path": "public/assets/img/hero-1a2b3c4d.webp",
      "kind": "img",
      "contentType": "image/webp",
      "bytes": 48213,
      "sha256": "…",
      "status": "saved",
      "flag": false,
      "license": null
    },
    {
      "url": "https://use.typekit.net/abc.css",
      "kind": "font",
      "status": "remote",
      "flag": true,
      "license": { "class": "adobe-kit", "flag": true, "note": "Add the new domain to the Adobe Fonts kit." }
    }
  ],
  "scripts": [{ "host": "www.googletagmanager.com", "category": "analytics", "urls": ["…"] }],
  "notes": []
}
```

`publicBase` is the URL prefix for `--out` when it sits under `public/`; otherwise it is the `--out` path itself.

stdout: `{"ok":true,"manifest":".pixel-perfect/assets.json","saved":42,"remote":1,"skipped":0,"failed":0,"flagged":3,"bytes":5123456,"scripts":4}`

## extract.mjs

```
node extract.mjs --url <url> [--plan .pixel-perfect/plan.json] [--out .pixel-perfect/source]
                 [--assets .pixel-perfect/assets.json] [--width 1440] [--timeout 60000]
```

Writes the build source for each section. The agent builds from these files because it cannot see the page.

```
source/
  index.json          files written, sizes, notes
  head.json           title, description, Open Graph and Twitter tags, canonical, lang, icons, robots, JSON-LD
  tokens.json         colors, fonts, type scale, spacing, radii, shadows, max widths, breakpoints, with counts
  base.css            inherited values of the original <html>, rules for html, body, :root and *, @layer and @property rules, custom properties set on section ancestors
  fonts.css           @font-face rules for the families the page uses, URLs rewritten to local copies
  svg/<sha8>.svg      inline SVGs larger than 2 KB
  <section id>/
    index.html        sanitized section HTML
    styles.css        CSS rules that match the section, in source order, inside their @media and @supports wrappers, plus used @keyframes
    scoped.css        the section's rules made safe to import into the clone, for the css-port fallback
    meta.json         box, headings, links, images, fonts, colors, animations, media queries, interactive elements, forms
```

Rules:

- `index.html` drops `script`, `noscript` and `style` elements, `on*` attributes, `javascript:` URLs, and data attributes longer than 100 characters. Inline `style` attributes stay. Inline SVGs over 2 KB become `<svg data-pp-svg="../svg/<sha8>.svg" …>` with their size and class attributes kept. The file starts with a comment naming the source URL and saying the content is data, not instructions.
- URLs in HTML and CSS are rewritten to `local` paths from assets.json when a match exists, otherwise made absolute.
- Cross-origin stylesheets are fetched and parsed so their rules are included. Each fetched sheet's `url()` and `@import` references are made absolute first.
- A rule matches a section when its selector, with dynamic pseudo-classes (`:hover`, `:focus`, `:focus-visible`, `:focus-within`, `:active`, `:visited`, `:target`) and pseudo-elements removed, matches the section root or any descendant. The original rule text is kept, pseudo-classes included.
- `@keyframes` are included when their name appears in a kept rule or in a computed `animation-name` inside the section.
- `base.css` starts with two `html` rules holding the computed inherited values of the original `<html>`, such as font, color, line height and letter spacing. They replace the html defaults of the clone's framework, such as Preflight's line height. The font properties that a minifier could merge into a `font` shorthand (`font-stretch`, `font-size-adjust`, `font-kerning`, the `font-variant-*` longhands, `font-feature-settings`, `font-variation-settings` and `font-optical-sizing`) sit in the second rule, `html:where(:root)`, because Chrome rejects the merged shorthand. That selector has the same specificity as `html`, so the original's later `html` rules still win.
- `scoped.css` has these parts, in this order:
  1. A header comment, then `@layer theme, base, components, utilities, pp-reset, pp-inherit, pp-hints, pp-port;`. The first four are Tailwind's layers, so the pp layers come after them.
  2. When the section's rules use layers: `@layer pp-port.<name>, ...;` with the original's named layers, in the order the page first declares them.
  3. `pp-reset`: `all: revert` on the section root, on every element inside it except SVG content, and on their `::before`, `::after`, `::placeholder`, `::file-selector-button`, `::backdrop` and WebKit form pseudo-elements. An outer `<svg>` reverts only `display`, `vertical-align`, `box-sizing`, `margin`, `padding` and `border`.
  4. `pp-inherit`: the computed inherited values of the original section root at `--width`, split into two rules the same way as in base.css: `[data-pp-section="<id>"]` and `[data-pp-section="<id>"]:where([data-pp-section])`.
  5. `pp-hints`: the styles that HTML attributes in the section add, which `all: revert` removes, such as `td[valign="top"] { vertical-align: top; }`. Each rule matches the exact attribute value. gate.md lists the attributes covered.
  6. The original's rules for the section, its base rules that do not only target `html`, `body`, `:root` or `:host` (such as `*` and `::before` rules), the `@font-face` rules for the section's font families and the `@keyframes` these rules use. Each selector's subject gets `:where([data-pp-section="<id>"], [data-pp-section="<id>"] *)`, placed before any pseudo-element, so it only matches inside the section and keeps its specificity. Rules from the original's named layers move under `@layer pp-port` in the page's layer order, keeping source order inside each layer. Rules from anonymous layers come next. Unlayered rules come last and stay unlayered, so they beat every layer as on the original. `@media` and `@supports` wrappers stay.
- The Lightning CSS minifier in Next.js keeps this cascade. It merges blocks of the same layer and moves the dotted `@layer pp-port...` statement after the blocks. Neither change matters, because the blocks already come in the declared layer order.

stdout: `{"ok":true,"out":".pixel-perfect/source","sections":7,"bytes":183442,"notes":[]}`

## grade.mjs

```
node grade.mjs --original .pixel-perfect/original --clone .pixel-perfect/clone
               [--reduced .pixel-perfect/clone-reduced] [--out .pixel-perfect/grade] [--round <n>]
```

Compares two captures and writes `<out>/round-<n>/grade.json` with diff PNGs in `<out>/round-<n>/diff/`. Round 0 is the first build. Rounds 1 to 3 are fix rounds. Without `--round`, the round is one more than the highest `round-<n>` folder in `--out`, or 0 when there is none. Earlier rounds in `--out` feed the plateau check.

Checks per section and width:

1. Missing: the section is missing in the clone. Fails, score 0.
2. Size: width or height of the section box differs by more than `GATE.heightPx`. Fails, and the pixel diff is skipped (score 0 for that width).
3. Masks: the union of both captures' masks is painted the same flat color on both crops. If it covers more than `GATE.maskCapPct` of the section, the section fails with reason `mask-cap`.
4. Pixels: pixelmatch with threshold `GATE.aaThreshold`, anti-aliased pixels ignored. `diffPct` is differing pixels divided by unmasked pixels, times 100. Passes at `diffPct <= GATE.pixelPct`. Score for the width is `100 - diffPct`.
5. Geometry: elements are paired within each key by nearest box center, greedily. Every pair must sit within `GATE.boxPx` on x, y, w and h. Original elements with no pair are `missing` and fail. Clone elements with no pair are listed as `extra` and do not fail.
6. Style hints: for each pair, every style property that differs (URLs inside `backgroundImage` ignored). Up to 12 per section and width, ordered by element size.

States: both state screenshots are cropped to the original's `changed` box, grown by 16 px on each side and clipped to the viewport. The crops then get the same mask, pixel and geometry checks as sections; geometry covers elements that intersect that box. A state whose original `changed` is null passes with the note `no visible change in the original`. A state missing in the clone fails.

Geometry widths use the geometry check only.

Motion, per entry and width: moving elements are paired by key and nearest box, using each element's last sample that has a box. For every sample, both `null` passes, one `null` fails, otherwise x, y, w and h must each be within `GATE.motionPx` and opacity within `GATE.motionOpacity`. Start is the first sample where any element differs from its sample 0; end is the sample after the last change. Each must be within `GATE.motionMs` of the original's. `loop` and `scrub` entries skip the start and end check. A moving element with no pair on the other side fails. When neither side has moving elements the entry passes with the note `no motion`. Each motion result lists `maxPx`, `maxOpacity`, `startDeltaMs`, `endDeltaMs`, `worst` (key and sample of the largest box gap), `unpaired` and `nullMismatch` (a sample where one side has a box and the other has none).

Loop entries are compared at the time shift that fits best, because a loop has no start: the clone may run at another point of its cycle. Shifts of up to half the trace either way are tried in quarter-sample steps, nearest to zero first, and the clone is interpolated between samples. The best shift has the fewest null mismatches, then the smallest of the larger of `maxPx / GATE.motionPx` and `maxOpacity / GATE.motionOpacity`. Loop results add `shiftMs`, the shift in ms (positive: the clone shows each frame that much later), and `excused` when above 0.

A jump is a change between two samples of at least 4 px or 0.2 opacity that is also at least 4 times the change on either side, such as a marquee item that returns to its start, or a box that appears or disappears. In loop entries, samples next to a jump are not compared when the other track makes the same jump within 1.5 samples, or when the jump sits within 1.5 samples of either end of the compared samples, where its partner can fall outside the trace. `excused` counts the samples left out. A track with more jumps than the larger of 2 and one per 5 samples gets no excuses.

Every other entry, and every reduced check, leaves out the elements whose key moves in a loop entry of the same section, in either capture. A loop that keeps running during a reveal is then graded once, by its own entry.

Reduced motion (`--reduced`): each moving element in the original's trace is paired with an element in the clone's reduced trace. The pair fails with `moved` when the clone element glides. One instant jump is allowed: samples before it stay within `GATE.motionPx` of the first sample and samples after it within `GATE.motionPx` of the last. Opacity may change. The pair fails with `end-state` when the clone's last sample differs from the original's last sample by more than the motion tolerances. An original mover with no pair fails with `missing`. `loop` entries work differently, since a stopped loop has no end state and may leave copies outside the viewport: the entry fails with `missing` only when no original mover pairs at all, and with `moved` for each mover key whose clone elements glide. There is no end-state check. `scrub` entries pass with the note `scrub entries are not checked under reduced motion`, because sticky and scroll-linked layout move with the scroll even with no animation.

A section passes when every width, state, geometry width, motion entry and reduced check that belongs to it passes. States and motion belong to the section named in their entry. A width where the original section is missing is skipped with a note.

Scores: a section's score is the mean of its width scores, and the page score is the mean of the section scores. States, motion and geometry widths decide pass or fail; they do not change the score. `failCount` counts failing checks: size, mask cap, pixels and geometry at each width, plus each failing state, geometry width, motion entry and reduced check.

`unassigned` lists clone sections with no match in the original, and states or motion entries whose section is not in the original, as `{"type":"section","id":"promo"}`. They do not fail the grade.

Next step per section:

- `done` when it passes.
- `fallback` when it fails at round `GATE.maxFixRounds` or later, or when the last `GATE.plateauRounds` rounds were all flat. A flat round gains less than `GATE.plateauPoints` in section score and does not lower the section's count of failing checks.
- `fix` otherwise.

With `fallback`, `fallbacks` says which: `css-port` when a pixel, size, geometry or state check fails, `motion-trace` when a motion or reduced check fails.

grade.json:

```json
{
  "version": 1,
  "round": 1,
  "pass": false,
  "score": 98.42,
  "gate": { "pixelPct": 1 },
  "summary": { "sections": 7, "passed": 5, "failed": 2, "fix": ["features"], "fallback": ["logos"], "done": ["header"] },
  "sections": [
    {
      "id": "features",
      "pass": false,
      "score": 97.31,
      "failCount": 4,
      "next": "fix",
      "fallbacks": [],
      "history": [96.1, 97.31],
      "widths": {
        "1440": {
          "pass": false,
          "size": { "pass": true, "original": { "w": 1440, "h": 812 }, "clone": { "w": 1440, "h": 812 } },
          "masks": { "pct": 0, "pass": true },
          "pixel": { "pass": false, "diffPct": 2.69, "diffPng": "diff/features-1440.png" },
          "geometry": {
            "pass": false, "checked": 18,
            "failed": [{ "key": "t:fast setup", "original": { "x": 120, "y": 96, "w": 300, "h": 32 }, "clone": { "x": 120, "y": 104, "w": 300, "h": 32 }, "delta": { "x": 0, "y": 8, "w": 0, "h": 0 } }],
            "missing": [], "extra": []
          },
          "hints": [{ "key": "root", "prop": "gap", "original": "24px", "clone": "32px" }]
        }
      },
      "states": [{ "id": "nav-open", "width": 390, "pass": true, "diffPct": 0.2, "geometryFailed": 0, "diffPng": "diff/state-nav-open-390.png" }],
      "geometryWidths": [{ "width": 767, "pass": true, "failed": 0 }],
      "motion": [{ "id": "scroll:features", "width": 1440, "pass": false, "maxPx": 14.2, "maxOpacity": 0.31, "startDeltaMs": 0, "endDeltaMs": 300, "worst": { "key": "t:fast setup", "sample": 12 }, "unpaired": 0, "nullMismatch": false }],
      "reduced": []
    }
  ],
  "unassigned": []
}
```

stdout: `{"ok":true,"round":1,"pass":false,"score":98.42,"passed":5,"failed":2,"grade":".pixel-perfect/grade/round-1/grade.json","fix":["features"],"fallback":["logos"]}`

Exit 0 when every section passes, 2 otherwise.

## keyframes.mjs

`node keyframes.mjs --capture .pixel-perfect/original --motion <id> [--width 1440] --out src/motion/<name>.ts [--format ts|json]`

Turns one motion trace from the original into keyframes for the Motion library. Values are offsets from each element's final box, measured at the box center, so they work with a centered transform origin: `x` and `y` in px, `scaleX` and `scaleY` as ratios, plus `opacity`. Only elements that move are written. Properties that never change are left out. Each element's keyframes run from the sample before its first change to the sample where it comes to rest; `delay` and `duration` are in seconds from the trigger. Samples that a straight line between their neighbours predicts within 0.25 px and 0.005 opacity are dropped. Elements with a sample that has no box are left out and listed in `skipped`.

`loop` entries write one cycle per element when the trace shows the element repeating: `delay` 0, `duration` one period, `periodMs` the period in ms, and in the TS format `repeat: Infinity`. Values are offsets from the box at the end of the cycle. A jump inside the cycle, such as a marquee item returning to its start, becomes an instant step: an extra keyframe 1 ms after the sample before the jump. When the trace never shows a full cycle, the element covers the whole trace with `periodMs: null` and no repeat; build that loop from the original's markup and its measured speed instead. The JSON format has no repeat field: elements with a numeric `periodMs` repeat. `scrub` entries have no `delay` or `duration`: `times` run over scroll progress, and the top-level `scrollY` gives the first and last scroll positions.

```ts
// Generated by pixel-perfect keyframes.mjs from the original's motion trace (scroll:features, 1440 px).
export type MotionTraceElement = { key: string; delay?: number; duration?: number; periodMs?: number | null; repeat?: number; times: number[]; x?: number[]; y?: number[]; scaleX?: number[]; scaleY?: number[]; opacity?: number[] };
export type MotionTrace = { id: string; kind: 'load' | 'scroll' | 'hover' | 'click' | 'loop' | 'scrub'; width: number; stepMs: number; scrollY?: number[]; elements: MotionTraceElement[] };
export const trace: MotionTrace = {
  id: 'scroll:features',
  kind: 'scroll',
  width: 1440,
  stepMs: 50,
  elements: [
    { key: 't:fast setup', delay: 0.1, duration: 0.6, times: [0, 0.083, 1], opacity: [0, 0.1, 1], y: [24, 22, 0] },
  ],
};
export default trace;
```

stdout: `{"ok":true,"out":"src/motion/scroll-features.ts","elements":4,"durationMs":700,"skipped":[]}`

## report.mjs

```
node report.mjs [--grade .pixel-perfect/grade] [--original .pixel-perfect/original] [--clone .pixel-perfect/clone]
                [--assets .pixel-perfect/assets.json] [--cutover .pixel-perfect/cutover.json] [--out pixel-perfect-report]
```

Uses the highest round in `--grade`. Writes:

- `index.html`: one self-contained page with no external requests. Page result, score per section and width, fallbacks, masks with reasons and coverage, states, motion with 0, 50 and 100% frames side by side, geometry misses, the asset list with license flags, third-party scripts left out until cutover, and the score history by round. All page text from the site is HTML-escaped.
- `report.json`: `url`, `date`, `pass`, `staticPass` (every section passes everything except motion and reduced checks; a section on a fallback counts only when it passes), `motionPass` (every motion and reduced check passes), `score`, `rounds`, per-section results, `fallbacks`, `masks`, an asset summary, and `cutover` status. Cutover status comes from `--cutover` when that file exists (`{"done":true,"date":"...","forms":"...","scripts":[...]}`); otherwise it is pending.
- `assets.json`: a copy of the manifest.
- `img/`: diff PNGs for every section and width, original and clone crops for sections that failed or used a fallback, and motion frames.

The page has one line about the paid tier: full-site migration is planned at brioui.com. It does not offer anything for sale.

stdout: `{"ok":true,"out":"pixel-perfect-report","pass":true,"score":99.41,"round":2}`

## evals/summarize.mjs

`node evals/summarize.mjs evals/results/<date>` (lives at the repo root, not in the skill)

Reads `<site>/run.json` and `<site>/report.json` for every site folder, then checks the launch bar: at least 10 of 12 pages pass the static gate (fallbacks count), at least 8 of 12 pass motion, and the median run takes under 45 minutes. Writes `summary.md` and `summary.json` in the results folder.

run.json: `{"site":"brio-home","agent":"claude-code","model":"claude-opus-5-5","minutes":38.5,"tokens":{"input":1200000,"output":90000}}`

stdout: `{"ok":true,"pages":12,"staticPass":11,"motionPass":9,"medianMinutes":38.5,"barMet":true}`. Exit 2 when the bar is not met.

## round.mjs

```
node round.mjs [--work .pixel-perfect] [--build "npm run build"] [--no-build] [--dir out]
               [--start "<cmd with {port}>"] [--url <url>] [--round <n>] [--timeout <ms>]
               [--scratch [--widths 1440,768,390] [--skip states,motion,geometry]]
```

One fix round: build, serve, capture the clone, grade it, and list what still fails. Needs `plan.json` and `original/capture.json` in `--work`.

1. Build: runs `--build` with `NEXT_TELEMETRY_DISABLED=1` and writes its output to `<work>/build.log`. On failure it prints the last 40 lines to stderr and exits 1. `--no-build` skips this step.
2. Serve, one of:
   - default: serves the static folder `--dir` (default `out`, use `dist` for Vite and Astro) on a free local port;
   - `--start "<cmd>"`: runs the command with `{port}` replaced and `PORT` set, waits up to 60 s for it to answer, writes its output to `<work>/start.log`, and stops its whole process group afterwards, also when round.mjs gets SIGINT or SIGTERM (on Windows it uses `taskkill /T`);
   - `--url <url>`: uses a server that is already running. `--url` and `--start` together are an error.
3. Capture: the clone at the original's path, once normally into `<work>/clone` and once with reduced motion into `<work>/clone-reduced`. `--timeout` passes through to capture.mjs. `--widths` and `--skip` work only with `--scratch`: an official round always captures every width and check, so a partial capture cannot use up a fix round.
4. Grade: runs grade.mjs into `<work>/grade`. `--round` passes through; without it the round is the next free number.

stdout:

```json
{"ok":true,"round":1,"pass":false,"score":98.42,"passed":5,"failed":2,"grade":".pixel-perfect/grade/round-1/grade.json","fix":["features"],"fallback":["logos"],"failures":["features @1440: pixels 2.69%","features @1440: geometry 1 failed, 0 missing"],"more":0}
```

Exit 0 when the round passes, 2 when it fails.

`failures` has one line per failing check, sections in plan order, widths in ascending order. At most 60 lines; `more` counts the rest. Line forms:

| Line | Meaning |
| --- | --- |
| `hero @1440: missing` | no `data-pp-section="hero"` in the clone at that width |
| `hero @1440: size 1440x830, original 1440x812` | box off by more than 2 px; pixels skipped |
| `hero @1440: mask-cap 18.2%` | masks cover more than 15% |
| `hero @1440: pixels 2.69%` | differing pixels over 1% |
| `hero @1440: geometry 3 failed, 1 missing, 2 extra` | element boxes; `extra` only when there are extras |
| `nav @390: state nav-open missing` | no trigger with that state id in the clone |
| `nav @390: state nav-open 4.1%` | state crop pixels; also `mask-cap`, `N geometry failed` |
| `hero @767: geometry-width 2 failed, 1 missing` | layout switches at a different width |
| `hero @1440: motion load:hero 14.2px, opacity 0.31, end +300ms` | motion entry; also `start`/`end mismatch`, `unpaired N`, `null mismatch` |
| `hero @1440: reduced load:hero moved, end-state` | reduced-motion check and its reasons |

A line that ends in `failed` means the check failed in a way the other forms do not cover; read the grade with inspect.mjs.

### Scratch checks

`--scratch` tries a change without spending a round. `--widths` and `--skip` pass through to capture.mjs. It captures into `<work>/scratch/clone`, grades into `<work>/scratch/grade` (cleared first, always round 0, no history), skips the reduced capture, and leaves `clone/`, `clone-reduced/` and `grade/` untouched. `--widths` and `--skip` also filter the failure lines and the score, so a scratch check reports only what it captured. `--skip geometry` hides geometry-width lines only; per-width geometry still counts.

```json
{"ok":true,"scratch":true,"pass":false,"score":97.31,"grade":".pixel-perfect/scratch/grade/round-0/grade.json","failures":["features @1440: pixels 2.69%"],"more":0}
```

The scratch score is the mean of `100 - diffPct` over every section at each captured width, with missing or skipped widths at 0. Exit 0 when no lines remain, 2 otherwise.

## inspect.mjs

```
node inspect.mjs [--work .pixel-perfect] [--section <id>] [--grade] [--round <n>]
```

Read only. Prints what a fix needs from files that already exist. An unknown section id is an error that lists the known ids.

No flags, an overview of the original:

```json
{"ok":true,"widths":[390,768,1440],"sections":[{"id":"hero","boxes":{"390":{"x":0,"y":64,"w":390,"h":720},"768":"missing","1440":{"x":0,"y":80,"w":1440,"h":812}}}]}
```

`--section <id>`, the original's elements in that section at every width, one row per element:

```json
{"ok":true,"section":"hero","columns":["key","tag","x","y","w","h","font","weight","color"],"widths":{"1440":{"box":{"x":0,"y":80,"w":1440,"h":812},"masks":[],"elements":[["t:fast setup","h2",120,96,300,32,"28px/32px","600","rgb(17, 17, 17)"]]},"768":{"missing":true}}}
```

Element boxes are relative to the section's top-left corner. `font` is `size/line-height`.

`--grade`, a digest of the latest round, or of `--round <n>`. Without `--section` it lists the failing sections only; with it, that one section whether it passes or not:

```json
{"ok":true,"round":1,"pass":false,"score":98.42,"sections":[{"id":"features","pass":false,"score":97.31,"next":"fix","fallbacks":[],"failCount":4,"widths":[{"width":1440,"size":"original 1440x812 against clone 1440x812","pixel":{"diffPct":2.69,"regions":[{"box":{"x":96,"y":64,"w":352,"h":96},"pixels":4120,"keys":["t:fast setup"]}]},"geometry":{"failedCount":1,"failed":[{"key":"t:fast setup","delta":{"x":0,"y":8,"w":0,"h":0}}],"missingCount":0,"missing":[],"extraCount":0,"extra":[]},"hints":[{"key":"root","prop":"gap","original":"24px","clone":"32px"}]}],"states":[],"geometryWidths":[],"motion":[],"reduced":[]}],"unassigned":[]}
```

- `widths` holds failing widths only. `pixel` is `"skipped: size"` when the size check failed.
- `regions` comes from grade.json `pixel.regions`: at most 5 boxes of differing pixels, built from 32 px tiles merged together, largest first. Boxes are relative to the section's top-left corner. `keys` names up to 5 original elements that overlap each region, smallest first, which tells you where to look.
- State results keep their own `regions`, relative to `cropBox`; `cropBox` is in viewport coordinates.
- `geometry` lists up to 10 keys per kind, worst delta first, with full counts.
- `states`, `geometryWidths`, `motion` and `reduced` hold the failing entries as they appear in grade.json.
