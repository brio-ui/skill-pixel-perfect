import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mimeFor, parseRange, startServer } from '../serve.mjs';

const closers = [];

function track(handle) {
  closers.push(handle);
  return handle;
}

// Raw request: fetch() would normalise "/../" before the server sees it.
function request(port, { method = 'GET', path = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function makeSite() {
  const base = mkdtempSync(join(tmpdir(), 'pp-serve-'));
  const site = join(base, 'site');
  mkdirSync(join(site, 'docs'), { recursive: true });
  writeFileSync(join(site, 'index.html'), '<h1>home</h1>');
  writeFileSync(join(site, 'about.html'), '<h1>about</h1>');
  writeFileSync(join(site, 'docs', 'index.html'), '<h1>docs</h1>');
  writeFileSync(join(site, 'style.css'), 'body{}');
  writeFileSync(join(site, '..foo'), 'dotdot-name');
  writeFileSync(join(site, 'data.bin'), '0123456789');
  writeFileSync(join(site, '404.html'), '<h1>custom 404</h1>');
  writeFileSync(join(base, 'secret.txt'), 'SECRET-OUTSIDE-ROOT');
  return { base, site };
}

function cleanup(base) {
  return () => rmSync(base, { recursive: true, force: true });
}

async function closeAll() {
  while (closers.length) {
    const { server } = closers.pop();
    await new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }
}

test.afterEach(closeAll);

test('mimeFor maps known extensions case-insensitively and falls back to octet-stream', () => {
  assert.equal(mimeFor('a/b.HTML'), 'text/html; charset=utf-8');
  assert.equal(mimeFor('x.png'), 'image/png');
  assert.equal(mimeFor('x.woff2'), 'font/woff2');
  assert.equal(mimeFor('x.mp4'), 'video/mp4');
  assert.equal(mimeFor('x.unknownext'), 'application/octet-stream');
});

test('parseRange handles open, closed and suffix ranges', () => {
  assert.deepEqual(parseRange('bytes=2-5', 10), { start: 2, end: 5 });
  assert.deepEqual(parseRange('bytes=7-', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=0-99', 10), { start: 0, end: 9 });
  assert.equal(parseRange('bytes=20-30', 10), 'unsatisfiable');
  assert.equal(parseRange('bytes=5-2', 10), 'unsatisfiable');
  assert.equal(parseRange('items=1-2', 10), null);
  assert.equal(parseRange(undefined, 10), null);
});

test('serves files, directory indexes and extensionless HTML', async (t) => {
  const { base, site } = makeSite();
  t.after(cleanup(base));
  const { server, port } = track(await startServer({ dir: site, port: 0 }));

  const file = await request(port, { path: '/style.css' });
  assert.equal(file.status, 200);
  assert.equal(file.headers['content-type'], 'text/css; charset=utf-8');
  assert.equal(file.headers['cache-control'], 'no-store');
  assert.equal(file.body.toString(), 'body{}');

  const root = await request(port, { path: '/' });
  assert.equal(root.status, 200);
  assert.equal(root.body.toString(), '<h1>home</h1>');

  const extless = await request(port, { path: '/about' });
  assert.equal(extless.status, 200);
  assert.equal(extless.body.toString(), '<h1>about</h1>');

  const dir = await request(port, { path: '/docs/' });
  assert.equal(dir.status, 200);
  assert.equal(dir.body.toString(), '<h1>docs</h1>');

  const dotName = await request(port, { path: '/..foo' });
  assert.equal(dotName.status, 200, 'a name starting with ".." is inside the root');
  assert.equal(dotName.body.toString(), 'dotdot-name');

  assert.ok(server.listening);
});

test('unknown paths get the custom 404.html with status 404', async (t) => {
  const { base, site } = makeSite();
  t.after(cleanup(base));
  const { port } = track(await startServer({ dir: site, port: 0 }));
  const res = await request(port, { path: '/missing/page' });
  assert.equal(res.status, 404);
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(res.body.toString(), '<h1>custom 404</h1>');
});

test('unknown paths get a plain 404 when there is no 404.html', async (t) => {
  const { base, site } = makeSite();
  t.after(cleanup(base));
  rmSync(join(site, '404.html'));
  const { port } = track(await startServer({ dir: site, port: 0 }));
  const res = await request(port, { path: '/nope' });
  assert.equal(res.status, 404);
  assert.equal(res.body.toString(), 'Not found');
});

test('path traversal is refused with 403 in both raw and encoded forms', async (t) => {
  const { base, site } = makeSite();
  t.after(cleanup(base));
  const { port } = track(await startServer({ dir: site, port: 0 }));

  const raw = await request(port, { path: '/../secret.txt' });
  assert.equal(raw.status, 403);
  assert.ok(!raw.body.toString().includes('SECRET'));

  const encoded = await request(port, { path: '/%2e%2e%2fsecret.txt' });
  assert.equal(encoded.status, 403);
  assert.ok(!encoded.body.toString().includes('SECRET'));

  const deeper = await request(port, { path: '/docs/../../secret.txt' });
  assert.equal(deeper.status, 403);
  assert.ok(!deeper.body.toString().includes('SECRET'));
});

test('an encoded NUL byte in the path gets 400', async (t) => {
  const { base, site } = makeSite();
  t.after(cleanup(base));
  const { port } = track(await startServer({ dir: site, port: 0 }));
  const res = await request(port, { path: '/style.css%00.html' });
  assert.equal(res.status, 400);
});

test('byte ranges give 206 with the right slice', async (t) => {
  const { base, site } = makeSite();
  t.after(cleanup(base));
  const { port } = track(await startServer({ dir: site, port: 0 }));

  const closed = await request(port, { path: '/data.bin', headers: { Range: 'bytes=2-5' } });
  assert.equal(closed.status, 206);
  assert.equal(closed.headers['content-range'], 'bytes 2-5/10');
  assert.equal(closed.headers['content-length'], '4');
  assert.equal(closed.body.toString(), '2345');

  const open = await request(port, { path: '/data.bin', headers: { Range: 'bytes=7-' } });
  assert.equal(open.status, 206);
  assert.equal(open.headers['content-range'], 'bytes 7-9/10');
  assert.equal(open.body.toString(), '789');

  const suffix = await request(port, { path: '/data.bin', headers: { Range: 'bytes=-3' } });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.body.toString(), '789');
});

test('an unsatisfiable range gets 416 with the total size', async (t) => {
  const { base, site } = makeSite();
  t.after(cleanup(base));
  const { port } = track(await startServer({ dir: site, port: 0 }));
  const res = await request(port, { path: '/data.bin', headers: { Range: 'bytes=20-30' } });
  assert.equal(res.status, 416);
  assert.equal(res.headers['content-range'], 'bytes */10');
});

test('HEAD returns headers and no body', async (t) => {
  const { base, site } = makeSite();
  t.after(cleanup(base));
  const { port } = track(await startServer({ dir: site, port: 0 }));
  const res = await request(port, { method: 'HEAD', path: '/data.bin' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-length'], '10');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.body.length, 0);
});

test('other methods get 405', async (t) => {
  const { base, site } = makeSite();
  t.after(cleanup(base));
  const { port } = track(await startServer({ dir: site, port: 0 }));
  const res = await request(port, { method: 'POST', path: '/index.html' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, 'GET, HEAD');
});

test('a busy port moves to the next free port', async (t) => {
  const { base, site } = makeSite();
  t.after(cleanup(base));
  const blocker = track(await listenOnRandomPort());
  const busy = blocker.port;
  const started = track(await startServer({ dir: site, port: busy }));
  assert.ok(started.port > busy, `expected a port above ${busy}, got ${started.port}`);
  assert.ok(started.port <= busy + 20);
  assert.equal(started.url, `http://127.0.0.1:${started.port}/`);
  const res = await request(started.port, { path: '/style.css' });
  assert.equal(res.status, 200);
});

test('port 0 binds a real free port and reports it', async (t) => {
  const { base, site } = makeSite();
  t.after(cleanup(base));
  const started = track(await startServer({ dir: site, port: 0 }));
  assert.ok(started.port > 0);
  assert.equal(started.url, `http://127.0.0.1:${started.port}/`);
});

test('startServer rejects a folder that does not exist', async () => {
  await assert.rejects(startServer({ dir: join(tmpdir(), 'pp-no-such-dir-xyz'), port: 0 }), /Not a folder/);
});

function listenOnRandomPort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => res.end('busy'));
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
