import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { absoluteHttp, cssUrls, isPrivateHost, parseSrcset } from '../assets.mjs';
import {
  fileNameFor,
  fontLicense,
  kindFor,
  extFor,
  publicBaseFor,
  registrableDomain,
  scriptCategory,
} from '../lib/asset-rules.mjs';
import { startServer } from '../serve.mjs';

const SCRIPTS = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE = join(SCRIPTS, 'test', 'fixtures', 'assets-site');
const execFileAsync = promisify(execFile);

// ---------- pure rules ----------

test('fontLicense classifies every license class', () => {
  const page = 'https://site.com/';

  const adobe = fontLicense('https://use.typekit.net/abc123.css', page);
  assert.equal(adobe.class, 'adobe-kit');
  assert.equal(adobe.status, 'remote');
  assert.equal(adobe.flag, true);

  const commercial = fontLicense('https://fast.fonts.net/t/1.css', page);
  assert.equal(commercial.class, 'commercial');
  assert.equal(commercial.status, 'skipped');
  assert.equal(commercial.flag, true);

  const google = fontLicense('https://fonts.gstatic.com/s/inter/v1/a.woff2', page);
  assert.equal(google.class, 'open');
  assert.equal(google.status, 'saved');
  assert.equal(google.flag, false);

  const fontsource = fontLicense('https://cdn.jsdelivr.net/npm/@fontsource/inter/latin-400.woff2', page);
  assert.equal(fontsource.class, 'open');

  const sameSite = fontLicense('https://fonts.site.com/f.woff2', 'https://www.site.com/');
  assert.equal(sameSite.class, 'owner-uploaded');
  assert.equal(sameSite.status, 'saved');
  assert.equal(sameSite.flag, true);

  const webflow = fontLicense('https://assets.website-files.com/x/f.woff2', 'https://other.com/');
  assert.equal(webflow.class, 'owner-uploaded');

  const wordpress = fontLicense('https://example.com/wp-content/fonts/f.woff2', 'https://other.com/');
  assert.equal(wordpress.class, 'owner-uploaded');

  const unknown = fontLicense('https://random.example.net/f.woff2', page);
  assert.equal(unknown.class, 'unknown');
  assert.equal(unknown.status, 'saved');
  assert.equal(unknown.flag, true);
});

test('scriptCategory sorts hosts into the category table, else other', () => {
  assert.equal(scriptCategory('www.googletagmanager.com'), 'analytics');
  assert.equal(scriptCategory('cdn.segment.com'), 'analytics');
  assert.equal(scriptCategory('static.hotjar.com'), 'analytics');
  assert.equal(scriptCategory('widget.intercom.io'), 'chat');
  assert.equal(scriptCategory('js.hsforms.net'), 'forms');
  assert.equal(scriptCategory('connect.facebook.net'), 'ads');
  assert.equal(scriptCategory('www.googlesyndication.com'), 'ads');
  assert.equal(scriptCategory('player.vimeo.com'), 'video');
  assert.equal(scriptCategory('www.youtube.com'), 'video');
  assert.equal(scriptCategory('localhost'), 'other');
  assert.equal(scriptCategory('cdn.example.com'), 'other');
});

test('registrableDomain handles two-part suffixes, IPs and single labels', () => {
  assert.equal(registrableDomain('cdn.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('www.example.com'), 'example.com');
  assert.equal(registrableDomain('shop.example.com.au'), 'example.com.au');
  assert.equal(registrableDomain('127.0.0.1'), '127.0.0.1');
  assert.equal(registrableDomain('localhost'), 'localhost');
});

test('kindFor picks a kind from content type, URL extension, resource type and source', () => {
  assert.equal(kindFor({ url: 'https://x.com/a.png', contentType: 'image/png' }), 'img');
  assert.equal(kindFor({ url: 'https://x.com/a.bin', contentType: 'font/woff2' }), 'font');
  assert.equal(kindFor({ url: 'https://x.com/a.woff2' }), 'font');
  assert.equal(kindFor({ url: 'https://x.com/a.png', resourceType: 'font' }), 'font');
  assert.equal(kindFor({ url: 'https://x.com/logo.svg', contentType: 'image/svg+xml' }), 'svg');
  assert.equal(kindFor({ url: 'https://x.com/clip', contentType: 'video/mp4' }), 'video');
  assert.equal(kindFor({ url: 'https://x.com/a.mp4' }), 'video');
  assert.equal(kindFor({ url: 'https://x.com/a.png', source: 'icon' }), 'icon');
  assert.equal(kindFor({ url: 'https://x.com/a.png', contentType: 'application/octet-stream' }), 'img');
  assert.equal(kindFor({ url: 'https://x.com/a.css', contentType: 'text/css' }), 'misc');
});

test('extFor prefers the content type, then the URL extension, then bin', () => {
  assert.equal(extFor('https://x.com/a', 'image/jpeg'), 'jpg');
  assert.equal(extFor('https://x.com/a.JPEG', ''), 'jpg');
  assert.equal(extFor('https://x.com/a.webp', 'application/octet-stream'), 'webp');
  assert.equal(extFor('https://x.com/a.png', 'image/svg+xml'), 'svg');
  assert.equal(extFor('https://x.com/noext', ''), 'bin');
});

test('fileNameFor makes a slug, an 8-char hash and the extension', () => {
  assert.equal(fileNameFor('https://x.com/img/Hero%20Shot.png', 'image/png', '1a2b3c4d5e6f'), 'hero-shot-1a2b3c4d.png');
  assert.equal(fileNameFor('https://x.com/a/%E4%B8%AD.png', 'image/png', 'abcdef0123'), 'file-abcdef01.png');
  assert.equal(fileNameFor('https://x.com/', 'image/png', 'abcdef0123'), 'file-abcdef01.png');
  const long = fileNameFor(`https://x.com/${'a'.repeat(60)}.png`, 'image/png', 'ffffffff00');
  assert.equal(long, `${'a'.repeat(40)}-ffffffff.png`);
});

test('publicBaseFor turns an out folder into its URL prefix', () => {
  assert.equal(publicBaseFor('public/assets'), '/assets');
  assert.equal(publicBaseFor('public'), '/');
  assert.equal(publicBaseFor('assets/x'), 'assets/x');
  assert.equal(publicBaseFor('./public/img/'), '/img');
  assert.equal(publicBaseFor('out/public/a'), '/a');
});

test('absoluteHttp keeps only http and https URLs', () => {
  assert.equal(absoluteHttp('/a.png', 'https://x.com/p/'), 'https://x.com/a.png');
  assert.equal(absoluteHttp('data:image/png;base64,AAAA'), null);
  assert.equal(absoluteHttp('blob:https://x.com/abc'), null);
  assert.equal(absoluteHttp('javascript:void(0)'), null);
  assert.equal(absoluteHttp('ftp://x.com/a'), null);
});

test('isPrivateHost matches loopback, private and link-local literals only', () => {
  const host = (u) => new URL(u).hostname;
  for (const u of [
    'http://localhost/',
    'http://app.localhost/',
    'http://127.0.0.1/',
    'http://2130706433/',
    'http://10.1.2.3/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://0.0.0.0/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
  ]) {
    assert.equal(isPrivateHost(host(u)), true, u);
  }
  for (const u of ['https://example.com/', 'http://8.8.8.8/', 'http://172.32.0.1/', 'http://[2606:4700::1111]/', 'http://[::ffff:8.8.8.8]/']) {
    assert.equal(isPrivateHost(host(u)), false, u);
  }
});

test('parseSrcset returns the URL of each candidate', () => {
  assert.deepEqual(parseSrcset('a.png 1x, b.png 2x'), ['a.png', 'b.png']);
  assert.deepEqual(parseSrcset('a.png, b.png 2x'), ['a.png', 'b.png']);
  assert.deepEqual(parseSrcset(''), []);
});

test('cssUrls reads quoted and bare url() values', () => {
  assert.deepEqual(cssUrls(`url("a.png") url('b.png') url(c.png)`), ['a.png', 'b.png', 'c.png']);
});

// ---------- integration: CLI against two origins ----------

function copyFixture(root) {
  const page = join(root, 'page');
  const cdn = join(root, 'cdn');
  cpSync(join(FIXTURE, 'page'), page, { recursive: true });
  cpSync(join(FIXTURE, 'cdn'), cdn, { recursive: true });
  return { page, cdn };
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function lastJsonLine(stdout) {
  return JSON.parse(stdout.trim().split('\n').pop());
}

test(
  'assets CLI saves page assets, dedupes by content, flags licenses and lists scripts',
  { timeout: 240000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'pp-assets-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const { page, cdn } = copyFixture(root);

    // Page on 127.0.0.1; CDN on localhost so the two origins count as different sites.
    const cdnServer = await startServer({ dir: cdn, port: 0, host: '127.0.0.1' });
    const cdnBase = `http://localhost:${cdnServer.port}`;
    const indexPath = join(page, 'index.html');
    writeFileSync(indexPath, readFileSync(indexPath, 'utf8').replaceAll('__CDN__', cdnBase));
    const pageServer = await startServer({ dir: page, port: 0, host: '127.0.0.1' });
    t.after(async () => {
      await new Promise((resolve) => {
        cdnServer.server.closeAllConnections?.();
        cdnServer.server.close(() => resolve());
      });
      await new Promise((resolve) => {
        pageServer.server.closeAllConnections?.();
        pageServer.server.close(() => resolve());
      });
    });

    const work = join(root, 'work');
    mkdirSync(work);
    const pageUrl = pageServer.url;
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        join(SCRIPTS, 'assets.mjs'),
        '--url',
        pageUrl,
        '--out',
        'public/assets',
        '--manifest',
        '.pixel-perfect/assets.json',
        '--widths',
        '1440,390',
        '--max-video-mb',
        '0.001',
      ],
      { cwd: work, timeout: 240000, maxBuffer: 16 * 1024 * 1024 },
    );

    // stdout summary
    const summary = lastJsonLine(stdout);
    assert.equal(summary.ok, true);
    assert.equal(summary.manifest, '.pixel-perfect/assets.json');
    assert.equal(summary.failed, 0);
    assert.equal(summary.scripts, 1);
    assert.equal(summary.remote >= 1, true);
    assert.equal(summary.saved >= 8, true);

    // manifest shape
    const manifestPath = join(work, '.pixel-perfect', 'assets.json');
    assert.equal(existsSync(manifestPath), true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.version, 1);
    assert.equal(manifest.url, pageUrl);
    assert.equal(manifest.out, 'public/assets');
    assert.equal(manifest.publicBase, '/assets');
    assert.ok(Array.isArray(manifest.notes));
    assert.ok(Array.isArray(manifest.assets));
    assert.ok(Array.isArray(manifest.scripts));

    for (const entry of manifest.assets) {
      for (const key of ['url', 'local', 'path', 'kind', 'contentType', 'bytes', 'sha256', 'status', 'flag', 'license']) {
        assert.ok(key in entry, `entry ${entry.url} has ${key}`);
      }
      if (entry.kind !== 'font') assert.equal(entry.license, null, `non-font ${entry.url} has no license`);
    }

    const byEnd = (suffix) => manifest.assets.filter((a) => a.url.endsWith(suffix));
    const one = (suffix) => {
      const hits = byEnd(suffix);
      assert.equal(hits.length, 1, `exactly one entry for ${suffix}`);
      return hits[0];
    };

    // saved images, on disk and by hash
    const hero = one('/img/hero.png');
    assert.equal(hero.status, 'saved');
    assert.equal(hero.kind, 'img');
    assert.match(hero.local, /^\/assets\/img\/hero-[0-9a-f]{8}\.png$/);
    assert.equal(hero.sha256, sha256(join(work, hero.path)));
    assert.equal(statSync(join(work, hero.path)).size, hero.bytes);

    // same bytes under another URL share one file
    const heroCopy = one('/img/hero-copy.png');
    assert.equal(heroCopy.path, hero.path);
    assert.equal(heroCopy.local, hero.local);
    assert.equal(heroCopy.sha256, hero.sha256);

    const band = one('/img/band.png');
    assert.equal(band.status, 'saved');
    assert.equal(band.kind, 'img');

    const logo = one('/img/logo.svg');
    assert.equal(logo.status, 'saved');
    assert.equal(logo.kind, 'svg');

    const heroSrcset = one('/img/hero-2x.png');
    assert.equal(heroSrcset.status, 'saved');

    // icons and og image
    const favicon = one('/img/favicon.png');
    assert.equal(favicon.kind, 'icon');
    assert.equal(favicon.status, 'saved');
    const touch = one('/img/touch.png');
    assert.equal(touch.kind, 'icon');
    const og = one('/img/og.png');
    assert.equal(og.status, 'saved');
    assert.equal(og.kind, 'img');

    // font from the page origin counts as owner-uploaded, flagged for a license check
    const font = one('/fonts/fixture.woff2');
    assert.equal(font.status, 'saved');
    assert.equal(font.kind, 'font');
    assert.equal(font.flag, true);
    assert.equal(font.license.class, 'owner-uploaded');
    assert.equal(font.license.flag, true);
    assert.ok(font.license.note.length > 0);

    // CDN image: saved; srcset and meta both point at it, so it appears once
    const card = manifest.assets.filter((a) => a.url === `${cdnBase}/img/card.png`);
    assert.equal(card.length, 1);
    assert.equal(card[0].status, 'saved');
    assert.equal(card[0].flag, false);

    // CDN video over the 0.001 MB cap: kept as a remote link, flagged
    const video = one('/media/clip.mp4');
    assert.equal(video.status, 'remote');
    assert.equal(video.kind, 'video');
    assert.equal(video.flag, true);
    assert.equal(video.local, null);
    assert.equal(video.path, null);
    assert.equal(video.sha256, null);
    assert.equal(video.bytes, 4096);
    assert.match(video.note, /Kept as a remote link/);

    // no duplicate URLs in the manifest
    const urls = manifest.assets.map((a) => a.url);
    assert.equal(new Set(urls).size, urls.length);

    // bytes on disk match the summary, and each saved hash has exactly one file
    const savedEntries = manifest.assets.filter((a) => a.status === 'saved');
    const uniquePaths = [...new Set(savedEntries.map((a) => a.path))];
    const diskBytes = uniquePaths.reduce((sum, p) => sum + statSync(join(work, p)).size, 0);
    assert.equal(summary.bytes, diskBytes);
    assert.equal(uniquePaths.length, new Set(savedEntries.map((a) => a.sha256)).size);

    // third-party script on another host
    assert.equal(manifest.scripts.length, 1);
    assert.equal(manifest.scripts[0].host, 'localhost');
    assert.equal(manifest.scripts[0].category, 'other');
    assert.deepEqual(manifest.scripts[0].urls, [`${cdnBase}/js/analytics.js`]);
  },
);
