const CACHE_NAME = 'mis-metas-pwa-v1.08';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './pocketbase.umd.js',
  './manifest.json',
  './media/icono.png',
  './media/favicon.png',
  './media/icon-192.png',
  './media/icon-512.png',
  './media/apple-touch-icon.png',
  './media/iPhone20.png',
  './media/macbook.svg',
  './media/ipad.svg',
  './media/watch.svg',
  './media/airpods.svg',
  './media/console.svg',
  './media/trip.svg',
  './media/vehicle.svg'
];

// Instalación: Precachear recursos esenciales y forzar activación inmediata
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

// Activación: Limpieza agresiva de cualquier caché antigua y tomar control de clientes
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Intercepción de peticiones:
// Para HTML/JS/CSS usar Network-First para que los cambios en Safari se apliquen de inmediato
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  const isCodeAsset = url.pathname.endsWith('.html') ||
                      url.pathname.endsWith('.js') ||
                      url.pathname.endsWith('.css') ||
                      url.pathname.endsWith('/') ||
                      url.pathname === '';

  if (isCodeAsset) {
    // Network first con fallback a caché
    event.respondWith(
      fetch(event.request)
        .then(networkResponse => {
          if (networkResponse && networkResponse.status === 200) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseToCache));
          }
          return networkResponse;
        })
        .catch(() => {
          return caches.match(event.request).then(cached => {
            if (cached) return cached;
            if (event.request.mode === 'navigate') {
              return caches.match('./index.html');
            }
          });
        })
    );
  } else {
    // Para imágenes y recursos estáticos: Cache First con Network Fallback
    event.respondWith(
      caches.match(event.request).then(cachedResponse => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(event.request).then(networkResponse => {
          if (networkResponse && networkResponse.status === 200) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseToCache));
          }
          return networkResponse;
        });
      })
    );
  }
});
