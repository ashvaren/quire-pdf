// Loads the Tesseract worker, serving the English language data from a file name that
// every static host accepts (the data is the standard gzipped eng.traineddata).
const realFetch = self.fetch.bind(self);
self.fetch = (url, opts) => realFetch(String(url).replace(/eng\.traineddata(\.gz)?$/, 'eng-traineddata.wasm'), opts);
importScripts('worker.min.js');
