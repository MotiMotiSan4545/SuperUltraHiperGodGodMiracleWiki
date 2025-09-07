self.addEventListener('install', e => {
  e.waitUntil(
    caches.open('recwiki-cache').then(cache => {
      return cache.addAll(['/','/public/Icon.png','/manifest.json']);
    })
  );
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(resp => resp || fetch(e.request))
  );
});
