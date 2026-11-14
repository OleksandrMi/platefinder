// Офлайн-режим: приложение и модель распознавания кешируются после первого запуска.
const VERSION = 'pf-web-6';
const SHELL = [
  './', 'index.html', 'js/app.js', 'js/matcher.js', 'js/powiats.js', 'js/detector.js', 'js/pipeline.js',
  'js/prep.js', 'js/scan-worker.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'pf-cdn').map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // библиотеки и модель с CDN — из кеша (версии зафиксированы)
  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(
      caches.open('pf-cdn').then(async (c) => {
        const hit = await c.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok || res.type === 'opaque') c.put(e.request, res.clone());
        return res;
      }),
    );
    return;
  }

  // своё приложение — сначала сеть (чтобы обновления приходили сразу), без сети — кеш
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) caches.open(VERSION).then((c) => c.put(e.request, res.clone()));
          return res;
        })
        .catch(() => caches.match(e.request, { ignoreSearch: true })),
    );
  }
});
