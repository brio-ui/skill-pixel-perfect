// Static server for a built clone. Usage: node serve.mjs --dir out [--port 4321] [--host 127.0.0.1]
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { done, log, main } from './lib/io.mjs';

const MAX_PORT_TRIES = 20;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
};

export function mimeFor(file) {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function isInside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// Parse a single byte range against a file size. Returns null (ignore the header),
// 'unsatisfiable', or { start, end }.
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  if (size === 0) return 'unsatisfiable';
  if (a === '') {
    const n = Number(b);
    if (n === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (start >= size || (b !== '' && Number(b) < start)) return 'unsatisfiable';
  return { start, end };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

// Pick the file for a request path: the file itself, then path.html, then path/index.html.
function resolveFile(root, rel) {
  const target = resolve(root, rel);
  const candidates = [target, `${target}.html`, join(target, 'index.html')];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const real = realpathSync(candidate);
    if (!isInside(root, real)) return { outside: true };
    if (statSync(real).isFile()) return { file: real };
  }
  return null;
}

function handler(root) {
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    }
    // Use the raw path: URL parsing would fold "/../" before the check sees it.
    const raw = String(req.url ?? '/').split(/[?#]/)[0];
    if (!raw.startsWith('/')) return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain; charset=utf-8' });
    let decoded;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    if (decoded.includes('\0')) return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain; charset=utf-8' });

    const rel = decoded.replace(/^\/+/, '');
    if (!isInside(root, resolve(root, rel))) {
      return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    let found;
    try {
      found = resolveFile(root, rel);
    } catch {
      found = null;
    }
    if (found?.outside) return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
    if (!found) return notFound(root, req, res);
    return sendFile(req, res, found.file);
  };
}

function notFound(root, req, res) {
  const page = join(root, '404.html');
  const isFile = existsSync(page) && statSync(page).isFile();
  if (!isFile) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': statSync(page).size };
  res.writeHead(404, { 'Cache-Control': 'no-store', ...headers });
  if (req.method === 'HEAD') return res.end();
  createReadStream(page).pipe(res);
  return undefined;
}

function sendFile(req, res, file) {
  const { size } = statSync(file);
  const headers = {
    'Content-Type': mimeFor(file),
    'Accept-Ranges': 'bytes',
    'Content-Length': size,
  };
  const rangeHeader = req.headers.range;
  const range = rangeHeader ? parseRange(rangeHeader, size) : null;
  if (range === 'unsatisfiable') {
    return send(res, 416, '', { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' });
  }
  let status = 200;
  let start = 0;
  let end = size - 1;
  if (range) {
    status = 206;
    ({ start, end } = range);
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    headers['Content-Length'] = end - start + 1;
  }
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  if (req.method === 'HEAD' || size === 0) return res.end();
  const stream = createReadStream(file, status === 206 ? { start, end } : undefined);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
  return undefined;
}

function listenOn(server, port, host) {
  return new Promise((resolvePromise, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolvePromise();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

// Serve dir on host:port. A busy port (not 0) moves to the next one, up to 20 more tries.
export async function startServer({ dir, port = 4321, host = '127.0.0.1' } = {}) {
  if (!dir) throw new Error('startServer needs a dir');
  const absDir = resolve(dir);
  if (!existsSync(absDir) || !statSync(absDir).isDirectory()) throw new Error(`Not a folder: ${absDir}`);
  const root = realpathSync(absDir);
  const server = createServer(handler(root));
  let bound = null;
  for (let attempt = 0; attempt <= (port === 0 ? 0 : MAX_PORT_TRIES); attempt++) {
    const tryPort = port === 0 ? 0 : port + attempt;
    try {
      await listenOn(server, tryPort, host);
      bound = tryPort;
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      log(`port ${tryPort} is busy, trying the next one`);
    }
  }
  if (bound === null) throw new Error(`No free port from ${port} to ${port + MAX_PORT_TRIES}`);
  const actual = server.address().port;
  const hostPart = host.includes(':') ? `[${host}]` : host;
  return { server, url: `http://${hostPart}:${actual}/`, port: actual };
}

const isEntry = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isEntry) {
  await main(async () => {
    const { values } = parseArgs({
      options: {
        dir: { type: 'string' },
        port: { type: 'string', default: '4321' },
        host: { type: 'string', default: '127.0.0.1' },
      },
    });
    if (!values.dir) throw new Error('Missing --dir');
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Bad --port value: ${values.port}`);
    const { server, url, port: bound } = await startServer({ dir: values.dir, port, host: values.host });
    const stop = () => {
      server.closeAllConnections?.();
      server.close(() => process.exit(0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    done({ ok: true, url, dir: resolve(values.dir), port: bound });
  });
}
