// Service worker: lets the installed app open without network. It caches the app itself (HTML,
// scripts, styles, icons) and Google's sign-in script; calendar data is NOT cached here (the app
// keeps its own offline copy in IndexedDB), and API calls always go to the network.
//
// Strategies:
// - the page (navigations): network first, cached copy when offline
// - /assets/* (file names contain a content hash, never change): cache first
// - other app files and the Google sign-in script: cached copy, refreshed in the background

const CACHE = 'ics-agenda-app-v1';
const SHELL = ['./', './manifest.webmanifest', './favicon.svg', './icons/icon-192.png'];
const GIS_SCRIPT = 'https://accounts.google.com/gsi/client';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

const scopeUrl = () => new URL(self.registration.scope);

/** Deletes cached /assets/ files the new page no longer references (old deployments). */
async function pruneAssets(cache, html) {
  const used = new Set(
    [...html.matchAll(/assets\/[^"'\s>]+/g)].map((m) => new URL(m[0], scopeUrl()).href),
  );
  for (const request of await cache.keys()) {
    if (request.url.includes('/assets/') && !used.has(request.url)) await cache.delete(request);
  }
}

async function networkFirstPage(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) {
      // One cached copy of the page, whatever URL it was opened with.
      await cache.put(scopeUrl().href, response.clone());
      response
        .clone()
        .text()
        .then((html) => pruneAssets(cache, html))
        .catch(() => {});
    }
    return response;
  } catch {
    const cached = await cache.match(scopeUrl().href);
    if (cached) return cached;
    throw new Error('Offline and the app is not cached yet.');
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const refresh = fetch(request)
    .then(async (response) => {
      // The sign-in script is cross-origin ("opaque" response, status 0): cache it too.
      if (response.ok || response.type === 'opaque') await cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);
  return cached ?? (await refresh) ?? Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.href.startsWith(GIS_SCRIPT)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
  // Anything else outside the app (Drive API, online calendars…) goes straight to the network.
  if (!url.href.startsWith(scopeUrl().href)) return;

  if (request.mode === 'navigate') event.respondWith(networkFirstPage(request));
  else if (url.pathname.includes('/assets/')) event.respondWith(cacheFirst(request));
  else event.respondWith(staleWhileRevalidate(request));
});
