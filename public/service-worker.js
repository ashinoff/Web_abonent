const version = 'abonent-shell-2026-10-04-v2';
const shell = ['./','./index.html','./styles.css','./config.js','./app.js','./worker.js',
  './core.js','./monthly.js','./analysis-service.js','./analysis-engine.js','./analysis-settings.js',
  './analysis-tuning.js','./analysis-ui.js','./analysis-chart.js','./chart-years.js','./demo.js',
  './download-buffer.js','./gestures.js','./notes-ui.js','./readings.js','./record-sections.js',
  './source-files.js','./source.js','./workbook-check.js','./prepared-data.js','./prepared-cache.js','./load-map.js',
  './vendor/xlsx.full.min.js','./favicon.svg','./rosseti-logo.svg'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(version).then(cache => cache.addAll(shell)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('abonent-shell-') && key !== version).map(key => caches.delete(key)))), self.clients.claim()]));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  event.respondWith(fetch(event.request).then(response => response.ok ? response : caches.match(event.request).then(saved => saved || response))
    .catch(() => caches.match(event.request).then(saved => saved || Response.error())));
});
