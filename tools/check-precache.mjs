/**
 * check-precache.mjs — fails if any shipped JS/CSS file is missing from the
 * service worker's SHELL list (a forgotten entry = broken offline play).
 * Run with `node tools/check-precache.mjs`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sw = readFileSync(join(root, 'sw.js'), 'utf8');
const listed = new Set([...sw.matchAll(/'\.\/([^']+)'/g)].map((m) => m[1]));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

const required = [
  ...walk(join(root, 'js')).filter((f) => f.endsWith('.js')),
  ...walk(join(root, 'css')).filter((f) => f.endsWith('.css')),
  join(root, 'index.html'), join(root, 'manifest.json'), join(root, 'offline.html'),
].map((f) => relative(root, f).replace(/\\/g, '/'));

const missing = required.filter((f) => !listed.has(f));
if (missing.length) {
  console.error('Missing from sw.js SHELL precache:\n  ' + missing.join('\n  '));
  process.exit(1);
}
console.log(`precache OK (${required.length} files listed)`);
