// Quire PDF offline cache. Change VERSION whenever the files are updated, so every
// installed copy fetches the new set once and then runs offline again.
const VERSION = 'quire-1.4.0';
const CORE = ["app.js", "compare.js", "engine.js", "export.js", "icon-192.png", "icon-512.png", "index.html", "lib/fflate.mjs", "lib/pdf-lib.min.js", "lib/pdf.min.mjs", "lib/pdf.worker.min.mjs", "manifest.json", "ocr.js", "textgeom.js", "lib/fonts/lato-latin-400-italic.woff2", "lib/fonts/lato-latin-400-normal.woff2", "lib/fonts/lato-latin-700-normal.woff2", "lib/fonts/mrs-saint-delafield-latin-400-normal.woff2", "lib/fonts/raleway-latin-400-normal.woff2", "lib/fonts/raleway-latin-500-normal.woff2", "lib/fonts/raleway-latin-600-normal.woff2"];
const HEAVY = ["lib/mupdf/mupdf-wasm.js", "lib/mupdf/mupdf-wasm.wasm", "lib/mupdf/mupdf.js", "lib/tess/eng-traineddata.wasm", "lib/tess/ocr-worker.js", "lib/tess/tesseract-core-lstm.wasm.js", "lib/tess/tesseract-core-simd-lstm.wasm.js", "lib/tess/tesseract.esm.min.js", "lib/tess/worker.min.js"];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    // bypass the browser's HTTP cache so an update never stores yesterday's files
    const fresh = u => new Request(u, { cache: 'reload' });
    await c.addAll(['./', ...CORE].map(fresh));
    // the engines are large; fetch them now too, but do not fail the install over them
    await Promise.allSettled(HEAVY.map(f => c.add(fresh(f))));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    const hit = await c.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    } catch (err) {
      if (req.mode === 'navigate') { const page = await c.match('./'); if (page) return page; }
      throw err;
    }
  })());
});
