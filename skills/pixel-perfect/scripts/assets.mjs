// Collects the images, fonts, videos and icons a page uses and saves them locally.
// Usage: node assets.mjs --url <url> [--out public/assets] [--manifest .pixel-perfect/assets.json]
//                        [--widths 1440,768,390] [--max-video-mb 20] [--timeout 60000]
import { createHash } from 'node:crypto';
import { realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  autoScroll,
  closeConsent,
  desktopUserAgent,
  launch,
  openPage,
  waitForFonts,
  waitForImages,
} from './lib/browser.mjs';
import { done, ensureDir, log, main, parseWidths, writeJson } from './lib/io.mjs';
import {
  fileNameFor,
  fontLicense,
  kindFor,
  publicBaseFor,
  registrableDomain,
  scriptCategory,
} from './lib/asset-rules.mjs';

const SIZE_CAP_BYTES = 50 * 1024 * 1024;
const TOTAL_CAP_BYTES = 500 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;
const DEFAULT_MAX_VIDEO_MB = 20;
const PRIVATE_NOTE = 'Private or loopback address on a public page. Not downloaded.';

// Files named inside stylesheets are kept only when their extension is one of these.
const FILE_EXT = /\.(woff2|woff|ttf|otf|eot|png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|mp4|webm|mov|m4v)$/i;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/gi;

export function absoluteHttp(raw, base) {
  const value = String(raw ?? '').trim();
  if (!value || /^(data|blob):/i.test(value)) return null;
  try {
    const u = base ? new URL(value, base) : new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

// Loopback, private and link-local hosts, written as literals. Names that resolve to them are not checked.
export function isPrivateHost(hostname) {
  const h = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '::') return true;
  // fc00::/7 (unique local) and fe80::/10 (link-local).
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return true;
  // The URL parser writes ::ffff:127.0.0.1 as ::ffff:7f00:1.
  const mapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const [hi, lo] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
    return isPrivateHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const m = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// srcset: "a.png 1x, b.png 2x" -> ["a.png", "b.png"]. A URL may end in a comma when the descriptor is empty.
export function parseSrcset(value) {
  const s = String(value ?? '');
  const urls = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (i >= s.length) break;
    const start = i;
    while (i < s.length && !/\s/.test(s[i])) i++;
    const token = s.slice(start, i);
    const endsWithComma = token.endsWith(',');
    const url = token.replace(/,+$/, '');
    if (!endsWithComma) {
      while (i < s.length && s[i] !== ',') i++;
    }
    if (url) urls.push(url);
  }
  return urls;
}

export function cssUrls(text) {
  return [...String(text ?? '').matchAll(CSS_URL)].map((m) => (m[1] ?? m[2] ?? m[3] ?? '').trim());
}

function mimeOf(contentType) {
  return String(contentType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

function isFontType(ct) {
  return ct.startsWith('font/') || ct.includes('font') || ct.includes('opentype');
}

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

function addCandidate(map, url, info) {
  let cand = map.get(url);
  if (!cand) {
    cand = { url, sources: new Set(), resourceType: null, contentType: null, status: null, body: null };
    map.set(url, cand);
  }
  cand.sources.add(info.source);
  cand.resourceType ??= info.resourceType ?? null;
  cand.contentType ??= info.contentType ?? null;
  if (info.status === 200 || cand.status === null) cand.status = info.status ?? cand.status;
  if (info.body && !cand.body) cand.body = info.body;
  return cand;
}

// Network responses that may be assets. Scripts and stylesheets are handled separately.
function isAssetResponse(resourceType, contentType, url) {
  if (resourceType === 'image' || resourceType === 'font') return true;
  if (contentType.startsWith('image/') || contentType.startsWith('video/') || isFontType(contentType)) return true;
  if (resourceType === 'media') return /\.(mp4|webm|mov|m4v)$/i.test(pathOf(url));
  return false;
}

async function recordResponse(response, state) {
  const url = response.url();
  if (!absoluteHttp(url)) return;
  const resourceType = response.request().resourceType();
  const status = response.status();
  const contentType = mimeOf(response.headers()['content-type']);

  if (resourceType === 'script') {
    state.scripts.add(url);
    return;
  }
  if (resourceType === 'stylesheet') {
    if (status === 200) {
      const text = await response.text().catch(() => '');
      state.sheets.set(url, text);
    }
    // Adobe kit and commercial stylesheets are recorded as font entries.
    const lic = fontLicense(url, state.pageUrl);
    if (lic.class === 'adobe-kit' || lic.class === 'commercial') {
      addCandidate(state.candidates, url, { source: 'sheet', resourceType, contentType: 'text/css', status });
    }
    return;
  }
  if (!isAssetResponse(resourceType, contentType, url)) return;

  // Image and font bodies come from the page. Video and partial (206) bodies are fetched again later.
  const wantsBody =
    status === 200 && (resourceType === 'image' || resourceType === 'font' || contentType.startsWith('image/') || isFontType(contentType));
  const body = wantsBody ? await response.body().catch(() => null) : null;
  addCandidate(state.candidates, url, { source: 'network', resourceType, contentType, status, body });
}

// Runs in the page. Returns raw attribute and computed values; Node resolves them.
function collectDom() {
  const bgs = new Set();
  for (const el of document.querySelectorAll('*')) {
    for (const pseudo of [undefined, '::before', '::after']) {
      const value = getComputedStyle(el, pseudo).backgroundImage;
      if (value && value.includes('url(')) bgs.add(value);
    }
  }
  return {
    baseURI: document.baseURI,
    img: [...document.querySelectorAll('img')].map((img) => [
      img.currentSrc,
      img.getAttribute('src'),
      img.getAttribute('srcset'),
    ]),
    pictureSources: [...document.querySelectorAll('picture source[srcset]')].map((s) => s.getAttribute('srcset')),
    video: [
      ...[...document.querySelectorAll('video')].flatMap((v) => [v.getAttribute('src'), v.getAttribute('poster'), v.currentSrc]),
      ...[...document.querySelectorAll('video source[src]')].map((s) => s.getAttribute('src')),
    ],
    background: [...bgs],
    icons: [...document.querySelectorAll('link[rel*="icon"][href]')].map((l) => l.getAttribute('href')),
    meta: [
      ...document.querySelectorAll(
        'meta[property="og:image"], meta[name="og:image"], meta[property="twitter:image"], meta[name="twitter:image"]',
      ),
    ].map((m) => m.getAttribute('content')),
  };
}

function addDomSources(state, dom) {
  const base = dom.baseURI;
  const add = (raw, source) => {
    const url = absoluteHttp(raw, base);
    if (url) addCandidate(state.candidates, url, { source });
  };
  for (const [current, src, srcset] of dom.img) {
    add(current, 'dom');
    add(src, 'dom');
    for (const u of parseSrcset(srcset)) add(u, 'dom');
  }
  for (const srcset of dom.pictureSources) for (const u of parseSrcset(srcset)) add(u, 'dom');
  for (const raw of dom.video) add(raw, 'dom');
  for (const bg of dom.background) for (const u of cssUrls(bg)) add(u, 'dom');
  for (const raw of dom.icons) add(raw, 'icon');
  for (const raw of dom.meta) add(raw, 'meta');
}

async function captureWidth(browser, state, { url, width, timeout }) {
  const pending = [];
  const beforeGoto = (page) => {
    page.on('response', (response) => {
      pending.push(recordResponse(response, state).catch((err) => log(`response skipped: ${err.message}`)));
    });
  };
  const { context, page } = await openPage(browser, { url, width, clock: false, timeout, beforeGoto });
  try {
    const finalUrl = page.url();
    const consent = await closeConsent(page);
    if (consent) state.notes.push(`Closed consent banner (${width}px): ${consent}`);
    await autoScroll(page);
    await waitForImages(page);
    await waitForFonts(page);
    const dom = await page.evaluate(collectDom);
    await Promise.allSettled(pending);
    addDomSources(state, dom);
    return finalUrl;
  } finally {
    await context.close().catch(() => {});
  }
}

function localFor(publicBase, rel) {
  return `/${[publicBase, rel].filter(Boolean).join('/')}`.replace(/\/{2,}/g, '/');
}

function licenseOf(lic) {
  return { class: lic.class, flag: lic.flag, note: lic.note };
}

function kindOf(cand, contentType) {
  return kindFor({
    url: cand.url,
    contentType,
    resourceType: cand.resourceType,
    source: cand.sources.has('icon') ? 'icon' : undefined,
  });
}

// Size decision for a file of known size. Returns null when the file may be saved.
function sizeVerdict(kind, bytes, ctx) {
  if (kind === 'video' && bytes > ctx.maxVideoBytes) {
    const mb = (bytes / (1024 * 1024)).toFixed(1);
    return {
      status: 'remote',
      flag: true,
      bytes,
      note: `Video is ${mb} MB, over --max-video-mb ${ctx.maxVideoMb}. Kept as a remote link.`,
    };
  }
  if (bytes > SIZE_CAP_BYTES) {
    return { status: 'skipped', flag: true, bytes, note: 'Over 50 MB. Not saved.' };
  }
  return null;
}

async function fetchBody(cand, ctx) {
  // Redirects are followed one hop at a time so a redirect cannot reach a private host.
  let url = cand.url;
  let res;
  for (let hops = 0; ; hops++) {
    res = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': ctx.userAgent, Accept: '*/*' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) break;
    await res.body?.cancel().catch(() => {});
    const next = absoluteHttp(location, url);
    if (!next) return { status: 'failed', note: `Redirect to a non-http URL: ${location}` };
    if (hops >= MAX_REDIRECTS) return { status: 'failed', note: `More than ${MAX_REDIRECTS} redirects.` };
    if (!ctx.privateOk && isPrivateHost(new URL(next).hostname)) {
      return { status: 'skipped', flag: true, note: PRIVATE_NOTE };
    }
    url = next;
  }
  const contentType = mimeOf(res.headers.get('content-type'));
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { status: 'failed', contentType, note: `HTTP ${res.status}` };
  }
  const kind = kindOf(cand, contentType);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 0) {
    const verdict = sizeVerdict(kind, declared, ctx);
    if (verdict) {
      await res.body?.cancel().catch(() => {});
      return { ...verdict, contentType, kind };
    }
  }
  // Length unknown or small enough: stream and stop once past the limit.
  const limit = kind === 'video' ? Math.min(ctx.maxVideoBytes, SIZE_CAP_BYTES) : SIZE_CAP_BYTES;
  const chunks = [];
  let total = 0;
  let over = false;
  for await (const chunk of res.body ?? []) {
    total += chunk.length;
    if (total > limit) {
      over = true;
      break;
    }
    chunks.push(chunk);
  }
  if (over) return { ...sizeVerdict(kind, total, ctx), contentType, kind };
  return { status: 'ok', buffer: Buffer.concat(chunks), contentType, kind };
}

// Get the bytes for one candidate: the page's own body when we have it, otherwise Node fetch.
async function acquire(cand, ctx) {
  if (cand.body && cand.status === 200) {
    const contentType = cand.contentType ?? '';
    const kind = kindOf(cand, contentType);
    const verdict = sizeVerdict(kind, cand.body.length, ctx);
    if (verdict) return { ...verdict, contentType, kind };
    return { status: 'ok', buffer: cand.body, contentType, kind };
  }
  if (cand.status !== null && cand.status >= 400) {
    return { status: 'failed', contentType: cand.contentType, note: `HTTP ${cand.status}` };
  }
  try {
    return await fetchBody(cand, ctx);
  } catch (err) {
    const note = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'Timed out after 30 s.' : `Download failed: ${err.message}`;
    return { status: 'failed', contentType: cand.contentType, note };
  }
}

// Entry for a file that is not saved: remote, skipped or failed.
function stubEntry(cand, kind, fields) {
  return {
    url: cand.url,
    local: null,
    path: null,
    kind,
    contentType: fields.contentType ?? cand.contentType ?? null,
    bytes: fields.bytes ?? null,
    sha256: null,
    status: fields.status,
    flag: fields.flag ?? false,
    license: fields.license ?? null,
    ...(fields.note ? { note: fields.note } : {}),
  };
}

// One candidate becomes one manifest entry.
async function processCandidate(cand, ctx) {
  const lic = fontLicense(cand.url, ctx.pageUrl);
  const isCss = cand.resourceType === 'stylesheet' || /\.css$/i.test(pathOf(cand.url)) || cand.contentType === 'text/css';

  if (lic.class === 'adobe-kit') {
    // Font files from the kit are never recorded; only the kit stylesheet is.
    if (!isCss) return null;
    return stubEntry(cand, 'font', { status: 'remote', flag: true, license: licenseOf(lic), note: lic.note });
  }
  if (lic.class === 'commercial') {
    return stubEntry(cand, 'font', { status: 'skipped', flag: true, license: licenseOf(lic), note: lic.note });
  }

  const hint = kindOf(cand, cand.contentType);
  if (!ctx.privateOk && isPrivateHost(new URL(cand.url).hostname)) {
    return stubEntry(cand, hint, { status: 'skipped', flag: true, note: PRIVATE_NOTE });
  }
  if (ctx.totalBytes > TOTAL_CAP_BYTES) {
    return stubEntry(cand, hint, { status: 'skipped', flag: true, note: 'download cap reached' });
  }

  const got = await acquire(cand, ctx);
  if (got.status !== 'ok') {
    const kind = got.kind ?? hint;
    return stubEntry(cand, kind, {
      status: got.status,
      flag: got.flag,
      note: got.note,
      bytes: got.bytes,
      contentType: got.contentType,
      license: kind === 'font' ? licenseOf(lic) : null,
    });
  }

  const { kind } = got;
  const sha256 = createHash('sha256').update(got.buffer).digest('hex');
  let saved = ctx.bySha.get(sha256);
  if (!saved) {
    const file = fileNameFor(cand.url, got.contentType, sha256);
    const rel = `${kind}/${file}`;
    const abs = join(ctx.outAbs, rel);
    ensureDir(dirname(abs));
    writeFileSync(abs, got.buffer);
    ctx.totalBytes += got.buffer.length;
    saved = { rel, path: relative(ctx.cwd, abs), local: localFor(ctx.publicBase, rel) };
    ctx.bySha.set(sha256, saved);
  }
  const license = kind === 'font' ? licenseOf(lic) : null;
  return {
    url: cand.url,
    local: saved.local,
    path: saved.path,
    kind,
    contentType: got.contentType || null,
    bytes: got.buffer.length,
    sha256,
    status: 'saved',
    flag: license ? license.flag : false,
    license,
  };
}

function scriptGroups(urls, pageUrl) {
  const pageSite = registrableDomain(new URL(pageUrl).hostname);
  const byHost = new Map();
  for (const url of urls) {
    const host = new URL(url).hostname;
    if (registrableDomain(host) === pageSite) continue;
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(url);
  }
  return [...byHost].map(([host, list]) => ({ host, category: scriptCategory(host), urls: list }));
}

export async function runAssets({
  url,
  out = 'public/assets',
  manifest = '.pixel-perfect/assets.json',
  widths = parseWidths(undefined),
  maxVideoMb = DEFAULT_MAX_VIDEO_MB,
  timeout = 60000,
  cwd = process.cwd(),
}) {
  const cwdAbs = realpathSync(resolve(cwd));
  const outAbs = resolve(cwdAbs, out);
  const manifestAbs = resolve(cwdAbs, manifest);
  const outRel = relative(cwdAbs, outAbs) || '.';
  const publicBase = publicBaseFor(outRel);
  const state = {
    pageUrl: url,
    candidates: new Map(),
    sheets: new Map(),
    scripts: new Set(),
    notes: [],
  };

  const browser = await launch();
  let pageUrl = url;
  let userAgent;
  try {
    userAgent = desktopUserAgent(browser);
    for (const width of widths) {
      log(`capturing assets at ${width}px`);
      pageUrl = await captureWidth(browser, state, { url, width, timeout });
    }
  } finally {
    await browser.close().catch(() => {});
  }

  for (const [sheetUrl, text] of state.sheets) {
    for (const raw of cssUrls(text)) {
      const fileUrl = absoluteHttp(raw, sheetUrl);
      if (fileUrl && FILE_EXT.test(pathOf(fileUrl))) addCandidate(state.candidates, fileUrl, { source: 'css' });
    }
  }

  const ctx = {
    cwd: cwdAbs,
    outAbs,
    publicBase,
    pageUrl,
    // A page on a private host (a local dev server, say) may use files from private hosts.
    privateOk: isPrivateHost(new URL(url).hostname) || isPrivateHost(new URL(pageUrl).hostname),
    userAgent,
    maxVideoMb,
    maxVideoBytes: Math.floor(maxVideoMb * 1024 * 1024),
    totalBytes: 0,
    bySha: new Map(),
  };

  const assets = [];
  for (const cand of state.candidates.values()) {
    log(`asset ${cand.url}`);
    const entry = await processCandidate(cand, ctx);
    if (entry) assets.push(entry);
  }
  if (ctx.totalBytes > TOTAL_CAP_BYTES) state.notes.push('Download cap of 500 MB reached; later files were skipped.');

  const scripts = scriptGroups(state.scripts, pageUrl);
  const notes = [...state.notes];
  const manifestData = {
    version: 1,
    url,
    out: outRel,
    publicBase,
    assets,
    scripts,
    notes,
  };
  writeJson(manifestAbs, manifestData);

  const count = (status) => assets.filter((a) => a.status === status).length;
  const summary = {
    ok: true,
    manifest: relative(cwdAbs, manifestAbs),
    saved: count('saved'),
    remote: count('remote'),
    skipped: count('skipped'),
    failed: count('failed'),
    flagged: assets.filter((a) => a.flag).length,
    bytes: ctx.totalBytes,
    scripts: scripts.reduce((sum, group) => sum + group.urls.length, 0),
  };
  return { summary, manifest: manifestData };
}

const isEntry = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isEntry) {
  await main(async () => {
    const { values } = parseArgs({
      options: {
        url: { type: 'string' },
        out: { type: 'string', default: 'public/assets' },
        manifest: { type: 'string', default: '.pixel-perfect/assets.json' },
        widths: { type: 'string' },
        'max-video-mb': { type: 'string', default: String(DEFAULT_MAX_VIDEO_MB) },
        timeout: { type: 'string', default: '60000' },
      },
    });
    if (!values.url || !absoluteHttp(values.url)) throw new Error('Missing or bad --url (http or https)');
    const maxVideoMb = Number(values['max-video-mb']);
    if (!(maxVideoMb > 0)) throw new Error(`Bad --max-video-mb value: ${values['max-video-mb']}`);
    const timeout = Number(values.timeout);
    if (!(timeout > 0)) throw new Error(`Bad --timeout value: ${values.timeout}`);
    const { summary } = await runAssets({
      url: values.url,
      out: values.out,
      manifest: values.manifest,
      widths: parseWidths(values.widths),
      maxVideoMb,
      timeout,
    });
    done(summary);
  });
}
