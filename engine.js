// MuPDF-based operations that pdf-lib cannot do safely: true redaction, decryption,
// encryption, real comment annotations and removal of hidden data.
// The engine (about 10 MB) is loaded on first use only.

let mupdfPromise = null;
export function loadEngine() {
  if (!mupdfPromise) {
    // MuPDF's clean-up sweep mentions unused object numbers that other writers leave out of the
    // cross-reference table; that message is harmless, everything else is passed on.
    globalThis.$libmupdf_wasm_Module = {
      print: m => console.log(m),
      printErr: m => { if (!/cannot find object in xref/.test(m)) console.warn(m); },
    };
    mupdfPromise = import('./lib/mupdf/mupdf.js');
  }
  return mupdfPromise;
}

function open(mupdf, bytes) {
  return mupdf.Document.openDocument(bytes, 'application/pdf').asPDF();
}
function out(doc, opts) {
  return doc.saveToBuffer(opts).asUint8Array().slice();
}
const xf = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
function toPageRect(m, r) {
  const a = xf(m, r[0], r[1]), b = xf(m, r[2], r[3]);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

// Returns {ok:true, bytes} with encryption removed, or {ok:false} for a wrong password.
export async function decrypt(bytes, password) {
  const mupdf = await loadEngine();
  const doc = open(mupdf, bytes);
  if (doc.needsPassword() && !doc.authenticatePassword(password || '')) return { ok: false };
  return { ok: true, bytes: out(doc, 'decrypt') };
}

// jobs: [{page, rects:[[x0,y0,x1,y1] user space], mode:'edit'|'redact'}]
export async function removeContent(bytes, jobs) {
  const mupdf = await loadEngine();
  const P = mupdf.PDFPage;
  const doc = open(mupdf, bytes);
  const byPage = new Map();
  const covered = [];
  for (const j of jobs) {
    if (!byPage.has(j.page)) byPage.set(j.page, { edit: [], redact: [] });
    byPage.get(j.page)[j.mode].push(...j.rects);
  }
  for (const [pi, sets] of byPage) {
    const page = doc.loadPage(pi);
    const m = page.getTransform();
    // edits: remove only the glyphs, keep shading and images behind them
    if (sets.edit.length) {
      for (const r of sets.edit) { const a = page.createAnnotation('Redact'); a.setRect(toPageRect(m, r)); }
      page.applyRedactions(false, P.REDACT_IMAGE_NONE, P.REDACT_LINE_ART_NONE, P.REDACT_TEXT_REMOVE);
      // on a scanned page the words are part of the picture, so removing the text layer leaves them
      // showing: look at what is left under each edit and report the ones that still show writing
      const s = 2, pix = page.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceGray, false, false);
      const W = pix.getWidth(), H = pix.getHeight(), st = pix.getStride(), px = pix.getPixels();
      const ox = pix.getX ? pix.getX() : 0, oy = pix.getY ? pix.getY() : 0;
      for (const r of sets.edit) {
        const q = toPageRect(m, r);
        const x0 = Math.max(0, Math.floor(q[0] * s) - ox), x1 = Math.min(W, Math.ceil(q[2] * s) - ox);
        const y0 = Math.max(0, Math.floor(q[1] * s) - oy), y1 = Math.min(H, Math.ceil(q[3] * s) - oy);
        let n = 0, dark = 0, light = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const v = px[y * st + x]; n++; if (v < 110) dark++; else if (v > 200) light++; }
        if (n && dark / n > 0.03 && dark / n < 0.6 && light / n > 0.3) covered.push({ page: pi, rect: r });
      }
      try { pix.destroy?.(); } catch { /* ignore */ }
    }
    // redactions: remove text, blank the image pixels and covered line art
    if (sets.redact.length) {
      for (const r of sets.redact) { const a = page.createAnnotation('Redact'); a.setRect(toPageRect(m, r)); }
      page.applyRedactions(false, P.REDACT_IMAGE_PIXELS, P.REDACT_LINE_ART_REMOVE_IF_COVERED, P.REDACT_TEXT_REMOVE);
    }
  }
  const res = out(doc, 'garbage=compact');
  res.covered = covered;
  return res;
}

const PERM = { print: 4, modify: 8, copy: 16, annotate: 32, fill: 256, extract: 512, assemble: 1024, printHigh: 2048 };

// notes: [{page, at:[x,y] user space, text, color:[r,g,b], author}]
// clean: remove document information, XMP metadata, attachments, scripts and automatic actions
// protect: {user, owner, allowPrint, allowCopy, allowEdit}
export async function finalise(bytes, { notes = [], clean = false, protect = null, title = null } = {}) {
  const mupdf = await loadEngine();
  const doc = open(mupdf, bytes);
  const removed = [];
  for (const n of notes) {
    const page = doc.loadPage(n.page);
    const m = page.getTransform();
    const [x, y] = xf(m, n.at[0], n.at[1]);
    const a = page.createAnnotation('Text');
    a.setRect([x, y, x + 20, y + 20]);
    a.setContents(n.text);
    if (n.author) a.setAuthor(n.author);
    a.setColor(n.color || [1, 0.84, 0.2]);
    try { a.setIcon('Comment'); } catch { /* default icon */ }
    a.update();
  }
  if (clean) {
    const trailer = doc.getTrailer();
    const root = trailer.get('Root');
    const info = trailer.get('Info');
    if (!info.isNull()) {
      // empty the dictionary itself; some files ignore removing the reference alone
      const keys = []; info.forEach((v, k) => keys.push(k));
      if (keys.length) removed.push('document properties');
      for (const k of keys) info.delete(k);
      trailer.delete('Info');
    }
    if (!root.get('Metadata').isNull()) { root.delete('Metadata'); removed.push('XMP metadata'); }
    const names = root.get('Names');
    if (!names.isNull()) {
      if (!names.get('EmbeddedFiles').isNull()) { names.delete('EmbeddedFiles'); removed.push('attached files'); }
      if (!names.get('JavaScript').isNull()) { names.delete('JavaScript'); removed.push('scripts'); }
    }
    for (const k of ['OpenAction', 'AA']) if (!root.get(k).isNull()) { root.delete(k); removed.push('automatic actions'); }
    if (!root.get('PieceInfo').isNull()) { root.delete('PieceInfo'); removed.push('application data'); }
    for (let i = 0; i < doc.countPages(); i++) {
      const pobj = doc.loadPage(i).getObject();
      if (!pobj.get('AA').isNull()) { pobj.delete('AA'); removed.push('page actions'); }
      if (!pobj.get('PieceInfo').isNull()) { pobj.delete('PieceInfo'); removed.push('application data'); }
    }
  } else if (title) {
    doc.setMetaData('info:Title', title);
  }
  let opts = 'garbage=compact';
  if (protect && (protect.user || protect.owner)) {
    let p = -1; // all permitted
    if (!protect.allowPrint) p &= ~(PERM.print | PERM.printHigh);
    if (!protect.allowCopy) p &= ~(PERM.copy | PERM.extract);
    if (!protect.allowEdit) p &= ~(PERM.modify | PERM.annotate | PERM.fill | PERM.assemble);
    const owner = protect.owner || protect.user;
    opts += `,encrypt=aes-256,user-password=${encodeOpt(protect.user || '')},owner-password=${encodeOpt(owner)},permissions=${p}`;
  }
  return { bytes: out(doc, opts), removed: [...new Set(removed)] };
}
function encodeOpt(s) {
  // MuPDF option strings are comma separated; passwords containing commas are rejected up front
  if (/[,=]/.test(s)) throw new Error('Passwords cannot contain commas or equals signs.');
  return s;
}

// For verification: does this file open with the given password, and with no password?
export async function checkProtection(bytes, password) {
  const mupdf = await loadEngine();
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  const needs = doc.needsPassword();
  const opens = needs ? !!doc.authenticatePassword(password || '') : true;
  return { needs, opens };
}

// ---- exact character geometry (used for find-and-redact and for proving redactions are empty)
const inv = m => { const det = m[0] * m[3] - m[1] * m[2]; return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det]; };
function quadBox(q) { const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]]; return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; }
function pageLines(page) {
  const lines = []; let cur = null;
  page.toStructuredText('preserve-whitespace').walk({
    beginLine() { cur = { text: '', boxes: [] }; },
    onChar(c, origin, font, size, quad) { cur.text += c; for (let i = 0; i < c.length; i++) cur.boxes.push(quadBox(quad)); },
    endLine() { if (cur) lines.push(cur); cur = null; },
  });
  return lines;
}

// pages: [{key, page}] ; returns {key: [{rect (user space), text}]}
export async function findMatches(bytes, pages, source, flags) {
  const mupdf = await loadEngine();
  const doc = open(mupdf, bytes);
  const result = {};
  for (const { key, page: pi } of pages) {
    const page = doc.loadPage(pi);
    const back = inv(page.getTransform());
    const hits = [];
    for (const line of pageLines(page)) {
      const re = new RegExp(source, flags.includes('g') ? flags : flags + 'g');
      let m;
      while ((m = re.exec(line.text))) {
        if (!m[0].length) { re.lastIndex++; continue; }
        const bs = line.boxes.slice(m.index, m.index + m[0].length);
        const r = [Math.min(...bs.map(b => b[0])), Math.min(...bs.map(b => b[1])), Math.max(...bs.map(b => b[2])), Math.max(...bs.map(b => b[3]))];
        const a = xf(back, r[0], r[1]), b = xf(back, r[2], r[3]);
        hits.push({ rect: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])], text: m[0] });
      }
    }
    result[key] = hits;
  }
  return result;
}

// Any visible character left touching a redaction area? jobs: [{page, rects (user space)}]
export async function leakCheck(bytes, jobs, password) {
  const mupdf = await loadEngine();
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  if (doc.needsPassword()) doc.authenticatePassword(password || '');
  const pdf = doc.asPDF();
  const leaks = [];
  for (const j of jobs) {
    const page = pdf.loadPage(j.page);
    const m = page.getTransform();
    const zones = j.rects.map(r => toPageRect(m, [r[0] + 0.3, r[1] + 0.3, r[2] - 0.3, r[3] - 0.3]));
    for (const line of pageLines(page)) {
      [...line.text].forEach((ch, i) => {
        if (!ch.trim()) return;
        const b = line.boxes[i];
        if (b && zones.some(z => b[0] < z[2] && z[0] < b[2] && b[1] < z[3] && z[1] < b[3])) leaks.push({ page: j.page, ch });
      });
    }
  }
  return leaks;
}

// ---- layout for export: characters with font details, and images, per page (top-left origin)
export async function pageLayout(bytes, password) {
  const mupdf = await loadEngine();
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  if (doc.needsPassword()) doc.authenticatePassword(password || '');
  const pages = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    const [x0, y0, x1, y1] = page.getBounds();
    const lines = [], images = [];
    let cur = null;
    page.toStructuredText('preserve-whitespace,preserve-images,preserve-spans').walk({
      onImageBlock(bbox, transform, image) {
        try {
          const w = image.getWidth(), h = image.getHeight();
          if (w * h > 25e6) return;
          let pix = image.toPixmap();
          const rgbCs = mupdf.ColorSpace.DeviceRGB;
          if (!pix.getColorSpace() || pix.getNumberOfComponents() - pix.getAlpha() !== 3) pix = pix.convertToColorSpace(rgbCs, false);
          const mask = image.getMask();
          if (!mask && !pix.getAlpha()) { images.push({ bbox, png: pix.asPNG().slice() }); return; }
          const W = pix.getWidth(), H = pix.getHeight(), stride = pix.getStride(), n = pix.getNumberOfComponents();
          const src = pix.getPixels();
          const rgba = new Uint8ClampedArray(W * H * 4);
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const s = y * stride + x * n, d = (y * W + x) * 4;
            rgba[d] = src[s]; rgba[d + 1] = src[s + 1]; rgba[d + 2] = src[s + 2]; rgba[d + 3] = n === 4 ? src[s + 3] : 255;
          }
          if (mask) {
            const mp = mask.toPixmap(), mw = mp.getWidth(), mh = mp.getHeight(), ms = mp.getStride(), mn = mp.getNumberOfComponents(), mpx = mp.getPixels();
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
              const mx = Math.min(mw - 1, Math.floor(x * mw / W)), my = Math.min(mh - 1, Math.floor(y * mh / H));
              rgba[(y * W + x) * 4 + 3] = mpx[my * ms + mx * mn];
            }
          }
          images.push({ bbox, rgba, w: W, h: H });
        } catch (e) { console.warn('image skipped', e); }
      },
      beginLine(bbox, wmode, dir) { cur = { bbox, dir, chars: [] }; },
      onChar(c, origin, font, size, quad, color) {
        const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]];
        cur.chars.push({ c, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), ox: origin[0], oy: origin[1],
          font: font.getName(), bold: font.isBold(), italic: font.isItalic(), serif: font.isSerif(), mono: font.isMono(), size, color: color ? [...color] : [0] });
      },
      endLine() { if (cur && cur.chars.length) lines.push(cur); cur = null; },
    });
    pages.push({ w: x1 - x0, h: y1 - y0, lines, images });
  }
  return pages;
}
