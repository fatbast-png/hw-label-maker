/* Offline support: keeps a copy of the app so it opens without signal.
   Bump VERSION whenever any app file changes so phones pick up the new copy. */
var VERSION = "hw-labels-v3.0.1";
var FILES = [
  "./", "index.html", "style.css", "app.js", "labels.js", "store.js", "manifest.webmanifest", "sample-cards.csv",
  "vendor/qrcode-generator-2.0.4.js", "vendor/niimbluelib-0.48.0.min.js",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png", "icons/apple-touch-icon.png"
];
self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(FILES.map(function (f) { return new Request(f, { cache: "reload" }); })); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
// Network first (so updates show up straight away when online), cached copy when offline.
self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  // The page itself (and the app code) skips the browser's HTTP cache too, so a new version shows on the next open.
  var path = new URL(req.url).pathname;
  var fresh = req.mode === "navigate" || /(\/|\.html|\.js|\.css|\.webmanifest)$/.test(path);
  e.respondWith((fresh ? fetch(req.url, { cache: "no-cache", credentials: "same-origin" }) : fetch(req)).then(function (res) {
    if (res && res.ok) { var copy = res.clone(); caches.open(VERSION).then(function (c) { c.put(req, copy); }); }
    return res;
  }).catch(function () {
    return caches.match(req, { ignoreSearch: true }).then(function (hit) { return hit || caches.match("index.html"); });
  }));
});
