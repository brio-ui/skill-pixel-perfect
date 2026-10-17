# Stack

How to build the clone. The default stack is Next.js with Tailwind v4 and static export. When the project folder already holds a project, build inside it with its own framework instead. This file covers the scaffold, the theme, how to write sections, images, the head, forms, Brio components, and the round flags each stack needs.

The grade never reads your source. It measures the rendered page, so any stack that serves the right HTML and CSS at the three widths can pass. Keep the output clean and editable, since the point of the skill is code the owner can keep.

## Pick the stack

- The project folder has a `package.json`: build inside that project and match how it already styles pages. Add Tailwind only if it is already there.
- The folder is empty or holds only the files create-next-app accepts: scaffold the default stack below.

Keep the project's own styling system:

- Tailwind v4: use `@theme`, as below.
- Tailwind v3: put the tokens under `theme.extend` in `tailwind.config.js`. The arbitrary-value syntax (`text-[17px]`, `min-[900px]:`) works the same. The `@theme` block and the `@import "tailwindcss"` line are v4 only.
- No Tailwind: write the clone with CSS Modules or whatever the project uses. Do not add Tailwind to a project that has none without asking the user first. The css-port fallback in references/gate.md works in any stack, since it imports plain CSS.

The rest of this file is the default Next.js stack.

## Scaffold

Run in the project folder, which must be empty or hold only accepted files:

```bash
NEXT_TELEMETRY_DISABLED=1 npx --yes create-next-app@16 . --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --yes --disable-git
```

`@16` pins the major version the skill was built against. `--disable-git` leaves the project's git alone. create-next-app refuses a folder that has other files, so scaffold before you write anything else. The accepted files are `.git`, `.gitignore`, `.gitattributes`, `.DS_Store`, `.vscode`, `.idea`, `.zed`, `LICENSE` and `docs`.

## Static export

Replace `next.config.ts` with:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  turbopack: { rules: { "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" } } },
};

export default nextConfig;
```

`output: 'export'` writes a static site to `out/`, which round.mjs serves. `images.unoptimized` is required for export. Keep the turbopack CSS rule that the scaffold adds; removing it breaks the Tailwind build. The scaffold's `next.config.ts` may also carry `cacheComponents` and `partialPrefetching`; drop both, since they need a running server, and `partialPrefetching` fails to build without `cacheComponents`.

No server-only features: no route handlers, server actions, middleware, `revalidate`, `cookies()`, `headers()` or dynamic params that are not pre-rendered. The output is a folder of static files.

A stack that cannot export to a static folder, such as one that needs a running server, uses `round.mjs --start "<command that serves on {port}>"` instead of the default `out/` folder. See the round flags at the end of this file.

Telemetry stays off. round.mjs already sets `NEXT_TELEMETRY_DISABLED=1` for the build, but set it in the scaffold command too so the first run is quiet.

## globals.css and layout

Replace the whole of `src/app/globals.css` with:

```css
@import "tailwindcss";
@import "./fonts.css";
@import "./base.css" layer(base);
```

Then add the `@theme` block below. `fonts.css` and `base.css` are the files extract.mjs wrote; copy them next to `globals.css`. `base.css` goes in `layer(base)` so the page's own base rules sit under Tailwind's utilities and your section classes win. `fonts.css` stays unlayered so `@font-face` always applies.

Trim `src/app/layout.tsx` to:

```tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "..." };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

Drop the scaffold's Geist font imports and the `antialiased`, `h-full`, `min-h-full`, `flex` and `flex-col` classes it puts on `<html>` and `<body>`. They change text rendering and layout and cause pixel and geometry failures. Set `lang` from `head.json`. The metadata comes from step 2 of the build.

Delete the scaffold's sample files: `public/next.svg`, `public/vercel.svg`, `public/file.svg`, `public/globe.svg`, `public/window.svg`, `public/dot.svg` and `src/app/favicon.ico`. Replace the favicon with the original's icons from `head.json`.

eslint.config.mjs keeps the scaffold's `defineConfig([...])`. Add one rule so plain `<img>` does not error:

```js
{ rules: { '@next/next/no-img-element': 'off' } }
```

## Theme

Turn `tokens.json` into a Tailwind v4 `@theme` block in `globals.css`. Map each token group to the namespace that drives the utilities you need:

| tokens.json | `@theme` variable | Utilities it creates |
| --- | --- | --- |
| colors | `--color-<name>` | `text-<name>`, `bg-<name>`, `border-<name>` |
| fonts | `--font-<name>` | `font-<name>` |
| typeScale | `--text-<name>` and `--text-<name>--line-height` | `text-<name>` with its line height |
| spacing | `--spacing-<name>` | `p-<name>`, `gap-<name>`, `m-<name>` |
| radii | `--radius-<name>` | `rounded-<name>` |
| shadows | `--shadow-<name>` | `shadow-<name>` |
| maxWidths | `--container-<name>` | `max-w-<name>` |
| breakpoints | `--breakpoint-<name>` | `<name>:` and `max-<name>:` variants |

Use the exact value from the token. Colors stay in the original's format; do not convert hex to oklch or round rgb, since the grade compares computed values and a converted color can differ by a pixel. For a value that appears once, skip the token and use an arbitrary value in the class, such as `text-[17px]` or `gap-[22px]`.

To match the project to only the original's scale, reset Tailwind's defaults with `--<namespace>-*: initial` before your own entries. For example `--breakpoint-*: initial;` drops `sm:` through `2xl:` so a stray `md:` cannot leak a default breakpoint into the layout.

### Breakpoints

Switch layouts at the original's breakpoints from `tokens.json`, not at Tailwind's defaults. Tailwind v4 compiles `min-[900px]:` to `@media (width >= 900px)`, the same as `min-width: 900px`. Its `max-*` variants compile to `width < N`, but CSS `max-width: N` includes N, so add one pixel: an original `max-width: 899px` becomes `max-[900px]:`. For a breakpoint used across many sections, define `--breakpoint-tablet: 900px`, which gives `tablet:` as `(width >= 900px)` and `max-tablet:` as `(width < 900px)`.

## Sections

One component per plan section, in plan order, under `src/components/sections/<Pascal>.tsx`. Render them in order from `src/app/page.tsx`. The root element of each carries `data-pp-section="<section id>"`.

Build server components by default; they are plain functions and need no directive. Add `'use client'` only to a component that holds state, such as an open menu or an accordion.

Work from the section's `index.html` and `styles.css` in `.pixel-perfect/source/<id>/` and match the computed values: font size, line height, letter spacing, weight, color, padding, gap, max width and radius. `node "$PP/inspect.mjs" --section <id>` lists the original's elements with their boxes at every width, so you can see which element each class belongs to.

Element structure: the grade pairs elements by their text and media type, so keep each block of text in its own element, split the same way as the original, and keep media in the same form. An inline `<svg>` stays inline, an `<img>` stays an `<img>`, and a CSS background image stays a background.

### Images

Use a plain `<img>`, not `next/image`; the eslint rule above allows it and static export cannot optimize images anyway. Point `src` at the local file under `/assets/` from the manifest. Keep `width` and `height` so the box matches before the image loads. Keep `srcset` and `sizes` when the original has them, since they decide which file renders at each width. For a `<picture>` element, keep its `<source>` list. A CSS background image stays in CSS, set to the local URL.

### SVG

An inline `<svg>` stays inline in the JSX. Convert its HTML attributes to the JSX forms: `class` to `className`, `clip-path` to `clipPath`, `fill-rule` to `fillRule`, `stroke-width` to `strokeWidth`, `xmlns:xlink` to `xmlnsXlink`. extract.mjs moves an inline SVG over 2 KB to `svg/<hash>.svg`; render those with an `<img>` whose `src` is the local file, and add `data-pp-svg` to it so the grade treats it as the original's inline SVG rather than a missing one.

### Video

A `<video>` under 20 MB plays from the local file. A larger one keeps its original URL and is flagged in the report. A canvas, WebGL or video that the grade cannot measure is masked; see references/motion.md.

## Head and metadata

Copy the title, description, Open Graph and Twitter tags, icons and `lang` from `head.json` into the `metadata` export and the `<html lang>` attribute. Set:

- `metadataBase` to the original origin, so relative OG image URLs resolve.
- `alternates.canonical` to the original URL.
- `robots: { index: false }` for the noindex tag. It stays until cutover.

Render JSON-LD from `head.json` `jsonLd` with a script tag, escaping `<` so the JSON cannot close the tag early:

```tsx
<script
  type="application/ld+json"
  dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
/>
```

A JSON-LD block that did not parse is kept in `head.json` as text with a note; paste it back as-is.

## Links

Use a plain `<a href>`, not `next/link`. next/link prefetches the target route, and a route that does not exist in this one-page clone throws in the console and can fail the build. Make same-site links root-relative (`/pricing`) and leave external links as they are. Put the page at the same path as the original, so `/pricing` lives at `src/app/pricing/page.tsx`. When the original's URLs end in a slash, set `trailingSlash: true` in `next.config.ts` so the export writes `pricing/index.html`.

## The hidden-element trap

Tailwind's Preflight sets, at `preflight.css`, `[hidden]:where(:not([hidden='until-found'])) { display: none !important; }`. The `!important` means you cannot override a `hidden` attribute with CSS to show the element. If the original shows something that carries a `hidden` attribute, drop the attribute in the clone instead of trying to override it.

## Forms

Forms render and validate but never send. Use this inert form:

```tsx
'use client';
import { useState, type ComponentProps, type FormEvent } from 'react';

// Pixel Perfect: this form does not send until /pixel-perfect cutover wires it to a service.
export function InertForm({ children, ...props }: ComponentProps<'form'>) {
  const [note, setNote] = useState('');
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNote('This form is not connected yet');
  }
  return (
    <form {...props} onSubmit={onSubmit} data-pp-form="inert">
      {children}
      {note && <p role="status">{note}</p>}
    </form>
  );
}
```

Drop the original's `action` and `method` so nothing can post before React hydrates. Keep the native validation attributes (`required`, `type`, `pattern`, `minlength`) so the form validates as the original did. The `data-pp-form="inert"` marker lets the report list it and cutover find it.

## Brio components

Brio UI ships sections that may match the original. Use one when it fits, restyle it to the original's tokens, and fall back to custom code when it cannot pass. Brio needs React 19 and the `motion` package.

Commands, all with telemetry off:

```bash
npx brio-ui list --json
BRIO_TELEMETRY=0 npx brio-ui init --yes --no-tokens
BRIO_TELEMETRY=0 npx brio-ui add <slug> --yes --json
```

`--no-tokens` keeps Brio from overwriting the theme you built from `tokens.json`. Check `npx brio-ui whoami` for a licence before adding a premium component; use premium only when it shows a covering licence. Never ask the user for a key and never run `npx brio-ui login`. On exit 5 (key) or 6 (licence), build the section by hand. Other exit codes: 2 usage, 3 not found, 4 network, 7 rate limit, 8 dependency, 9 conflict, 130 cancelled.

Free components: `faq`, `pricing-toggle`, `contact-form`. Premium: `announcement-bar`, `testimonials`, `plan-comparison`, `site-footer`, `logo-cloud`, `stats-band`, `team-grid`, `cta-band`.

Pattern map, original to Brio slug:

| Original section | Brio slug | Tier |
| --- | --- | --- |
| FAQ, accordion | `faq` | free |
| pricing with a monthly/yearly switch | `pricing-toggle` | free |
| contact or lead form | `contact-form` | free |
| top announcement or promo bar | `announcement-bar` | premium |
| quote or review cards | `testimonials` | premium |
| feature-by-plan table | `plan-comparison` | premium |
| multi-column footer | `site-footer` | premium |
| logo strip | `logo-cloud` | premium |
| number or metric band | `stats-band` | premium |
| team or people grid | `team-grid` | premium |
| closing call-to-action band | `cta-band` | premium |

### Two Brio gotchas

The Brio `contact-form` posts to a demo endpoint and shows a success state. Wrap it so it cannot post and shows its error state instead, and put the inert marker around it:

```tsx
<div data-pp-form="inert">
  <ContactForm onSubmit={() => { throw new Error('This form is not connected yet') }} />
</div>
```

The Brio `faq` root spreads only `className` and `style` to its inner buttons, so a `data-pp-trigger` on the component does not reach the buttons the grade needs to find. Either wrap it in a `TriggerIds` client component that sets `data-pp-trigger` on the inner buttons after mount, or skip Brio for any section that has graded states and build it by hand. If a Brio section still fails geometry, states or motion after round 1, replace it with custom code.

```tsx
'use client';
import { useEffect, useRef } from 'react';

// Sets data-pp-trigger on the real trigger buttons that a Brio component renders but does not forward to.
export function TriggerIds({ ids, children }: { ids: string[]; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const buttons = ref.current?.querySelectorAll('button') ?? [];
    buttons.forEach((b, i) => { if (ids[i]) b.setAttribute('data-pp-trigger', ids[i]); });
  }, [ids]);
  return <div style={{ display: 'contents' }} ref={ref}>{children}</div>;
}
```

## Round flags per stack

round.mjs builds with `npm run build` and serves `out/` by default. For other stacks:

- Vite or Astro static build: `node "$PP/round.mjs" --dir dist`.
- A stack that needs a server: `node "$PP/round.mjs" --no-build --start "npm start -- --port {port}"`, with `{port}` where the serve command takes its port. round.mjs waits up to 60 s for it to answer, then stops the whole process group.
- A server already running: `node "$PP/round.mjs" --no-build --url http://localhost:3000`.

references/scripts.md has every round flag and the failure-line formats.
