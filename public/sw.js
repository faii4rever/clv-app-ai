// Service worker MINIMAL - cuma buat memenuhi syarat "installable PWA"
// (Chrome/PWABuilder mewajibkan ada service worker terdaftar sebelum app
// bisa di-"Add to Home Screen" atau dibungkus jadi APK/TWA).
//
// SENGAJA tidak melakukan caching apa pun. App ini selalu butuh koneksi ke
// server (chat, model list, dll), dan kita sudah pernah kena masalah file
// lama ke-cache di browser - jadi di sini biarkan semua request lewat apa
// adanya ke network, tidak disimpan/diganti.
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
