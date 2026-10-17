# Pixel Perfect

Rebuild a live web page you own as clean, editable code, and prove the match with numbers.

Pixel Perfect is an agent skill. You give one URL. Bundled Playwright scripts capture the page at 1440, 768 and 390 px, download its assets, and extract its markup and CSS. Your coding agent rebuilds the page section by section, and the scripts grade the rebuild against the original. The agent fixes whatever the grade reports and repeats until every section matches.

A section passes, at each width, when its box is within 2 px of the original's, at most 1% of its unmasked pixels differ, every element box sits within 2 px, and every state and motion check passes. Motion is measured too: samples within 2 px and 0.05 opacity, start and end within 50 ms.

The agent never looks at screenshots. The scripts measure pixels, boxes and motion and write JSON; the agent works from the numbers. The PNGs are for your report.

## Use it on a page you own

Pixel Perfect is for pages you own or have written permission to copy. It does not capture pages behind a login, and it keeps the clone hidden from search engines until you run cutover. Cloning a site you do not own can infringe copyright.

## Install

```bash
npx skills add brio-ui/skill-pixel-perfect
```

Needs Node 20 or later and a shell. It runs in any agent that can use a shell, including Claude Code, Codex, Cursor, OpenCode and Gemini CLI. The first run installs Playwright and Chromium into the skill folder. No MCP server, no telemetry.

## Run

In your agent:

```
/pixel-perfect https://example.com/
```

The skill shows an ownership notice, captures the page, and builds the clone in your project. When a project already exists in the folder it builds inside that project; otherwise it scaffolds Next.js with Tailwind v4 and static export. When the clone passes, it writes a report to `pixel-perfect-report/`.

`/pixel-perfect cutover` gets a finished clone ready to go live: it removes the noindex tag, wires the forms to a service you pick, and adds back the scripts you choose. It never deploys; you ship the code yourself.

## What it does not do

- No screenshots, Figma files or redesigns. It clones a live page.
- No pages behind a login, paywall, admin panel or checkout.
- It never copies the original's scripts. Menus, accordions and tabs are rebuilt in clean code.
- It never deploys, pushes or changes DNS.

## Layout

```
skills/pixel-perfect/
  SKILL.md             the workflow
  references/          gate, motion, stack, assets and legal, cutover, scripts
  scripts/             capture, assets, extract, grade, round, inspect, report
evals/                 the 12-page launch set and the summarizer
```

## License

MIT. See [LICENSE](LICENSE).

Full-site migration from Brio is planned. Follow updates at [brioui.com](https://brioui.com).
