# Evals

The launch set is 12 pages the skill may copy without asking anyone: 6 pages from our own product sites, 2 Webflow templates and 2 Framer templates whose licenses allow copying, and 2 WordPress default-theme demos under the GPL. The list lives in `sites.json`.

## The bar

A launch passes when:

- static gate: at least 10 of 12 pages pass at all 3 widths, fallbacks counted;
- motion gate: at least 8 of 12 pages pass;
- time: the median run is under 45 minutes per page.

Tokens are recorded for every run. The budget is set after the first full pass over all 12 pages, not before.

## Running a page

Each run starts from an empty project folder, so the clone has nothing to lean on. Run the skill's workflow against the page, then write two files into the run's result folder:

- `report.json`, the report the skill produces (`report.mjs` writes it). `summarize.mjs` reads `staticPass`, `motionPass` and `pass` from it.
- `run.json`, the run's metadata:

```json
{ "site": "brio-home", "agent": "claude-code", "model": "claude-opus-5-5", "minutes": 38.5, "tokens": { "input": 1200000, "output": 90000 } }
```

Put each page's two files in `evals/results/<date>/<site>/`, where `<site>` is the `id` from `sites.json`.

## Summarizing

```bash
node evals/summarize.mjs evals/results/<date>
```

It reads every site folder, checks the bar, and writes `summary.md` and `summary.json` in that folder. It exits 2 when the bar is not met. Its stdout line:

```json
{"ok":true,"pages":12,"staticPass":11,"motionPass":9,"medianMinutes":38.5,"barMet":true}
```

## Before the launch run

The `own` entries in `sites.json` carry `"confirm": true`. Confirm the own-site URLs are final before the launch pass. The four template URLs were picked on 18 Oct 2026. Each listing offers its template free to clone or remix, and eval runs rebuild the pages locally only. The WordPress demos are fixed.

Screenshots of pages we do not own stay out of any marketing. The eval reports are for measuring the skill, not for publishing.
