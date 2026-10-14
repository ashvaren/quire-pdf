// Text recognition for scanned pages (Tesseract, English), run entirely in the browser.
// Recognised words are written into the PDF as invisible text aligned with the image, the same
// way scanners produce "searchable PDFs", so search, selection and redaction all work.

let workerPromise = null;
let progressHook = null;

export function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { default: Tesseract } = await import('./lib/tess/tesseract.esm.min.js');
      const base = new URL('./lib/tess/', import.meta.url).href;
      return Tesseract.createWorker('eng', 1, {
        workerPath: base + 'ocr-worker.js', corePath: base, langPath: base,
        workerBlobURL: false, cacheMethod: 'none', gzip: true,
        logger: m => { if (progressHook) progressHook(m); },
      });
    })().catch(e => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

// Returns lines: [{baseline:[x0,y0,x1,y1], top, words:[{text, x0, x1, y0, y1, conf}]}] in image pixels
export async function recognise(canvas, onProgress) {
  const w = await getWorker();
  progressHook = onProgress || null;
  try {
    const { data } = await w.recognize(canvas, {}, { blocks: true, text: false });
    const lines = [];
    for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
      const words = (l.words || []).filter(wd => wd.text && wd.text.trim() && wd.confidence > 20)
        .map(wd => ({ text: wd.text.trim(), x0: wd.bbox.x0, x1: wd.bbox.x1, y0: wd.bbox.y0, y1: wd.bbox.y1, conf: wd.confidence }));
      if (!words.length) continue;
      const bl = l.baseline && l.baseline.x1 > l.baseline.x0 ? [l.baseline.x0, l.baseline.y0, l.baseline.x1, l.baseline.y1] : [l.bbox.x0, l.bbox.y1, l.bbox.x1, l.bbox.y1];
      lines.push({ baseline: bl, top: l.bbox.y0, bottom: l.bbox.y1, words });
    }
    return lines;
  } finally { progressHook = null; }
}

// Writes invisible words onto a pdf-lib page.
// toUser(px, py) maps image pixels to PDF user space; scale = image pixels per point.
export function addTextLayer(lib, page, font, lines, toUser, scale, sanitize) {
  const { pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize, setTextMatrix, setTextRenderingMode, showText, TextRenderingMode } = lib;
  const key = page.node.newFontDictionary('QuireOCR', font.ref);
  const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
  let count = 0;
  for (const line of lines) {
    const [bx0, by0, bx1, by1] = line.baseline;
    const slope = bx1 !== bx0 ? (by1 - by0) / (bx1 - bx0) : 0;
    const yAt = x => by0 + (x - bx0) * slope;
    // the line's ascent in pixels sets one size for the whole line (Helvetica ascender 0.718 em)
    const ascentPx = Math.max(4, ((by0 + by1) / 2) - line.top);
    const sizePt = (ascentPx / 0.75) / scale;
    for (const w of line.words) {
      const text = sanitize(w.text);
      if (!text.trim()) continue;
      const L = toUser(w.x0, yAt(w.x0)), R = toUser(w.x1, yAt(w.x1));
      const dx = R[0] - L[0], dy = R[1] - L[1], len = Math.hypot(dx, dy);
      if (len < 0.5) continue;
      const ux = [dx / len, dy / len];
      const adv = font.widthOfTextAtSize(text, 1);
      if (adv <= 0) continue;
      const a = len / adv;
      ops.push(setFontAndSize(key, 1), setTextMatrix(ux[0] * a, ux[1] * a, -ux[1] * sizePt, ux[0] * sizePt, L[0], L[1]), showText(font.encodeText(text)));
      count++;
    }
  }
  ops.push(endText(), popGraphicsState());
  if (count) page.pushOperators(...ops);
  return count;
}
