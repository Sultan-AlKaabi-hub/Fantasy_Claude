/* eslint-env serviceworker */
/**
 * sw.js — Gloomfall service worker.
 *
 * Strategy
 *   • App shell (HTML, CSS, JS modules, manifest, icons) is PRECACHED on
 *     install and served CACHE-FIRST. The game has zero runtime data fetches,
 *     so once installed it is fully playable offline forever.
 *   • Navigations are served from the cached index.html (app-shell model) and
 *     fall back to offline.html only if the shell was somehow never cached.
 *   • Any other same-origin request (e.g. a future asset) uses
 *     STALE-WHILE-REVALIDATE so updates land silently in the background.
 *   • Cross-origin requests are not intercepted (the CSP forbids them anyway).
 *
 * Updates
 *   Bump VERSION on every deploy (the CI workflow does this from the commit
 *   SHA). A new worker installs alongside the old one, and the page shows a
 *   "Reload" toast; posting {type:'SKIP_WAITING'} activates it immediately.
 *   activate() deletes every cache that does not match the new VERSION.
 *
 * Not used, on purpose
 *   • Background Sync / Periodic Sync — there is no server to sync with; the
 *     save lives in IndexedDB and never leaves the device.
 *   • Push — no notifications are sent by this game.
 */
const VERSION = '__BUILD__';                       // replaced with the commit SHA at deploy
// A placeholder that survived (local dev) starts with '__'; the sed in CI replaces every
// occurrence, so the check must not repeat the literal.
const CACHE = `gloomfall-${VERSION.startsWith('__') ? 'dev' : VERSION}`;

const SHELL = [
  './',
  './index.html',
  './offline.html',
  './manifest.json',
  './css/app.css',
  './js/main.js',
  './js/config.js',
  './js/core/qr.js',
  './js/game.js',
  './js/combat.js',
  './js/core/constants.js',
  './js/core/util.js',
  './js/core/fsm.js',
  './js/core/input.js',
  './js/core/audio.js',
  './js/core/storage.js',
  './js/core/camera.js',
  './js/world/level.js',
  './js/world/world1.js',
  './js/entities/entity.js',
  './js/entities/player.js',
  './js/entities/enemy.js',
  './js/fx/particles.js',
  './js/render/sprites.js',
  './js/render/backdrop.js',
  './js/render/renderer.js',
  './js/render/hud.js',
  './js/render/title.js',
  './icons/favicon-32.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon-180.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Fetch each shell file individually so one 404 (e.g. an optional icon)
    // cannot abort the whole install.
    await Promise.all(SHELL.map(async (url) => {
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (res.ok) await cache.put(url, res);
      } catch { /* offline during install: the next load will retry */ }
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('gloomfall-') && k !== CACHE).map((k) => caches.delete(k)));
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.disable(); } catch { /* ignore */ }
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // App-shell navigation: always answer with the cached index.html.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const shell = await cache.match('./index.html');
      if (shell) {
        // Refresh the shell in the background when online.
        event.waitUntil(fetch('./index.html', { cache: 'no-cache' }).then((r) => r.ok && cache.put('./index.html', r)).catch(() => {}));
        return shell;
      }
      try { return await fetch(req); } catch { return (await cache.match('./offline.html')) || Response.error(); }
    })());
    return;
  }

  // Static assets: cache-first for precached shell files, SWR for anything else.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    const network = fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
      return res;
    }).catch(() => null);
    if (cached) {
      event.waitUntil(network);      // stale-while-revalidate
      return cached;
    }
    const res = await network;
    return res || new Response('', { status: 504, statusText: 'Offline' });
  })());
});
