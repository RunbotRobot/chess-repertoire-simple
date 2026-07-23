// App-shell cache only. Repertoire data always comes live from the Lichess
// explorer API — that traffic is never intercepted here, so quizzing always
// reflects the current rolling window rather than a stale cached snapshot.
//
// The number in CACHE must match APP_VERSION in js/app.js and bump on every
// deploy that changes any cached file. The browser only re-installs this
// worker (and thus only re-fetches the shell) when sw.js's own bytes
// change — if this string doesn't change, updates to app.js/explorer.js/etc.
// silently never reach clients, no matter how many times they're deployed.
const CACHE = 'opening-drill-v30';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './favicon.ico',
  './icon-16.png',
  './icon-32.png',
  './icon-48.png',
  './icon-96.png',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './js/app.js',
  './js/analysis.js',
  './js/board.js',
  './js/chessUtil.js',
  './js/engine.js',
  './js/explorer.js',
  './js/positionCache.js',
  './js/quiz.js',
  './js/speech.js',
  './js/storage.js',
  './js/wakelock.js',
  './js/vendor/chess.esm.js',
  './js/vendor/stockfish/stockfish-18-lite-single.js',
  './js/vendor/stockfish/stockfish-18-lite-single.wasm',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // let live API calls pass straight through

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      });
    })
  );
});
