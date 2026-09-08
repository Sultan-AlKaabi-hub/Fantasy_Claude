/**
 * dev-server.mjs — zero-dependency static server for local development.
 *
 *   node tools/dev-server.mjs [port]      (default 8081)
 *
 * Serves the repo root with correct MIME types and no caching (so edits show
 * up on reload), and accepts `POST /__shot?name=<file>` with a PNG data URL
 * body, which it writes to ./screenshots/<file>.png. The game exposes
 * `window.gloomfall.game.renderer.buf` so a capture is one line in DevTools:
 *
 *   fetch('/__shot?name=market', {method:'POST', body: gloomfall.game.renderer.buf.toDataURL()})
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.argv[2]) || 8081;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/manifest+json; charset=utf-8', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'POST' && url.pathname === '/__shot') {
    const name = (url.searchParams.get('name') || 'shot').replace(/[^a-z0-9_-]/gi, '');
    let body = '';
    for await (const chunk of req) body += chunk;
    const m = body.match(/^data:image\/png;base64,(.+)$/);
    if (!m) { res.writeHead(400); return res.end('expected a PNG data URL'); }
    await mkdir(join(ROOT, 'screenshots'), { recursive: true });
    const file = join(ROOT, 'screenshots', `${name}.png`);
    await writeFile(file, Buffer.from(m[1], 'base64'));
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(`saved ${file}`);
  }
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (path === '' || path.endsWith('/') || path.endsWith('\\')) path += 'index.html';
  const file = resolve(ROOT, path);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`dev server → http://127.0.0.1:${PORT}/`));
