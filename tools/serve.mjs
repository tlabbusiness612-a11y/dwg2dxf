// Minimal static server for development: serves web/ on http://localhost:PORT.
// localhost counts as a secure context, so service workers work without HTTPS.
//   node tools/serve.mjs [port] [--testdata DIR]
// --testdata additionally exposes DIR under /__testdata/ (dev only, for
// automated browser tests); never deploy this server.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname, sep, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const args = process.argv.slice(2);
const port = Number(args.find((a) => /^\d+$/.test(a)) || 8765);
const ti = args.indexOf('--testdata');
const testdata = ti >= 0 ? resolve(args[ti + 1]) : null;
// --samples DIR: public sample drawings under /samples/ (safe to expose)
const si = args.indexOf('--samples');
const samples = si >= 0 ? resolve(args[si + 1]) : null;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8', '.dwg': 'application/octet-stream', '.dxf': 'application/dxf'
};

function safeJoin(base, p) {
  const full = normalize(join(base, decodeURIComponent(p)));
  return full === base || full.startsWith(base + sep) ? full : null;
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let file;
  if (testdata && url.pathname.startsWith('/__testdata/')) file = safeJoin(testdata, url.pathname.slice(12));
  else if (samples && (url.pathname === '/samples' || url.pathname.startsWith('/samples/')))
    file = safeJoin(samples, url.pathname.slice(9));
  else file = safeJoin(root, url.pathname.slice(1));
  try {
    if (file && (await stat(file)).isDirectory()) file = join(file, 'index.html');
    if (!file || !(await stat(file)).isFile()) throw new Error('not found');
    let body = await readFile(file);
    const headers = { 'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Vary': 'Accept-Encoding' };
    // gzip text and wasm (the 6 MB engine shrinks to ~1.6 MB) when the client accepts it
    if (/\.(wasm|js|css|html|json|webmanifest|svg|txt)$/i.test(file) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      body = gzipSync(body, { level: 9 });
      headers['Content-Encoding'] = 'gzip';
    }
    res.writeHead(200, headers);
    res.end(body);
    console.log(200, req.method, url.pathname);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    console.log(404, req.method, url.pathname);
  }
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
