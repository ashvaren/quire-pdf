// PDF to Word: rebuilds each page's text as real, flowing Word paragraphs (indents, spacing,
// alignment, tabs, bullets, fonts) rather than fixed text boxes, so the result can be edited.
// Input is the per-page layout from engine.pageLayout(); output is .docx bytes.

const MARKER = /^(?:[\u2022\u25cf\u25aa\u25a0\u2013\u2014\-\u00b7o*.]|\(?\d{1,3}[.)]?(?:\d{1,3}[.)]?){0,3}|\(?[a-zA-Z][.)]|\(?[ivxlcdm]{1,6}[.)])$/;
const KNOWN = [
  [/^(arial|helvetica|liberationsans|arimo|nimbussans)/i, 'Arial'],
  [/^(timesnewroman|times|liberationserif|tinos|nimbusroman)/i, 'Times New Roman'],
  [/^(couriernew|courier|liberationmono|cousine|nimbusmono)/i, 'Courier New'],
  [/^calibri/i, 'Calibri'], [/^cambria/i, 'Cambria'], [/^georgia/i, 'Georgia'], [/^garamond|^ebgaramond/i, 'Garamond'],
  [/^verdana/i, 'Verdana'], [/^tahoma/i, 'Tahoma'], [/^segoeui/i, 'Segoe UI'], [/^trebuchet/i, 'Trebuchet MS'],
  [/^bookantiqua|^palatino/i, 'Book Antiqua'], [/^centurygothic/i, 'Century Gothic'], [/^gillsans/i, 'Gill Sans MT'],
  [/^aptos/i, 'Aptos'], [/^symbol/i, 'Symbol'], [/^wingdings/i, 'Wingdings'], [/^consolas/i, 'Consolas'], [/^lucida/i, 'Lucida Sans'],
  [/^franklingothic/i, 'Franklin Gothic Book'], [/^futura/i, 'Futura'], [/^optima/i, 'Optima'], [/^baskerville/i, 'Baskerville Old Face'],
];
export function wordFont(ch) {
  const raw = (ch.font || '').replace(/^[A-Z]{6}\+/, '');
  // symbol fonts: ordinary Unicode characters (a bullet, say) read better in a text font
  if (/symbol|wingding|dingbat/i.test(raw) && ch.c && ch.c.charCodeAt(0) < 0xf000) return ch.mono ? 'Courier New' : 'Arial';
  const key = raw.replace(/[-,_ ](bold|italic|oblique|regular|roman|book|medium|light|semibold|black|heavy|demi|condensed).*$/i, '')
    .replace(/(PSMT|PS|MT|-?Bold|-?Italic|-?Regular)+$/i, '').replace(/[\s_-]/g, '');
  for (const [re, name] of KNOWN) if (re.test(key)) return name;
  return ch.mono ? 'Courier New' : ch.serif ? 'Times New Roman' : 'Arial';
}
const isBold = ch => ch.bold || /bold|black|heavy|semibold|demi/i.test(ch.font || '');
const isItalic = ch => ch.italic || /italic|oblique/i.test(ch.font || '');
function hexColor(c) {
  if (!c || !c.length) return null;
  let r, g, b;
  if (c.length === 1) r = g = b = c[0];
  else if (c.length === 3) [r, g, b] = c;
  else if (c.length === 4) { const [C, M, Y, K] = c; r = (1 - C) * (1 - K); g = (1 - M) * (1 - K); b = (1 - Y) * (1 - K); }
  else return null;
  const h = v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  const s = (h(r) + h(g) + h(b)).toUpperCase();
  return s === '000000' ? null : s;
}
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const tw = pt => Math.round(pt * 20);
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// ---------------------------------------------------------------- lines
function buildLines(page, pageIndex, measure) {
  const chars = [];
  let skipped = 0;
  for (const l of page.lines) {
    const horiz = Math.abs(l.dir[1]) < 0.05 && l.dir[0] > 0;
    for (const c of l.chars) {
      if (c.c === '\n' || c.c === '\r' || c.c === '\u2028' || c.c === '\u2029') continue;
      if (!horiz) { if (c.c.trim()) skipped++; continue; }
      chars.push(c);
    }
  }
  chars.sort((a, b) => a.oy - b.oy || a.x0 - b.x0);
  const lines = [];
  for (const c of chars) {
    const L = lines.find(l => Math.abs(l.base - c.oy) < Math.max(1.5, 0.45 * Math.min(l.size, c.size)));
    if (L) { L.chars.push(c); if (c.c.trim()) L.size = Math.max(L.size, c.size); }
    else lines.push({ base: c.oy, size: c.c.trim() ? c.size : 0.1, chars: [c] });
  }
  const out = [];
  for (const L of lines) {
    L.chars.sort((a, b) => a.x0 - b.x0);
    const ink = L.chars.filter(c => c.c.trim());
    if (!ink.length) continue;
    // split into pieces at wide gaps (tab stops) and insert spaces the PDF left implicit
    const pieces = [];
    let cur = null, prevInk = null, sawSpace = 0;
    const spaceW = L.size * 0.28;
    for (const c of L.chars) {
      if (!c.c.trim()) { if (c.c === '\t' && cur) { cur.tabAfter = true; } else if (c.c === ' ' || c.c === '\u00a0') sawSpace++; continue; }
      if (prevInk) {
        const gap = c.x0 - prevInk.x1;
        const tabbed = cur && cur.tabAfter;
        if (gap > Math.max(L.size * 1.1, spaceW * 3.2) || (tabbed && gap > spaceW * 1.5)) { cur = null; }
        else if (sawSpace || gap > L.size * 0.16) {
          // keep the source's own spacing (a double space after a clause number changes where lines break)
          const n = Math.max(1, Math.min(4, sawSpace || Math.round(gap / spaceW)));
          for (let k = 0; k < n; k++) cur.chars.push({ ...prevInk, c: ' ', x0: prevInk.x1, x1: c.x0, space: true });
        }
      }
      if (!cur) { cur = { chars: [] }; pieces.push(cur); }
      cur.chars.push(c);
      prevInk = c; sawSpace = 0;
    }
    // a list marker set a little apart from its text becomes its own piece, so it can hang
    if (pieces.length) {
      const pc = pieces[0];
      const sp = pc.chars.findIndex(c => c.space);
      if (sp > 0 && sp <= 8) {
        const tok = pc.chars.slice(0, sp).map(c => c.c).join('');
        let e = sp; while (e < pc.chars.length && pc.chars[e].space) e++;
        const gap = pc.chars[e] ? pc.chars[e].x0 - pc.chars[sp - 1].x1 : 0;
        if (MARKER.test(tok) && gap > L.size * 0.6) pieces.splice(0, 1, { chars: pc.chars.slice(0, sp) }, { chars: pc.chars.slice(e) });
      }
    }
    for (const p of pieces) for (const c of p.chars) if (c.c === '\uf0b7' || c.c === '\uf0a7') c.c = '\u2022';
    for (const p of pieces) { p.x0 = p.chars[0].x0; p.x1 = p.chars[p.chars.length - 1].x1; p.text = p.chars.map(c => c.c).join(''); }
    const text = pieces.map(p => p.text).join('\t');
    const firstWord = pieces[0].chars.findIndex(c => c.c === ' ');
    const fw = firstWord > 0 ? pieces[0].chars[firstWord - 1].x1 - pieces[0].x0 : pieces[0].x1 - pieces[0].x0;
    // recognised (scanned) text is stretched word by word to fit the picture; find the type size
    // that gives the same line length in an ordinary font, so the Word version wraps the same way
    if (measure && ink.every(c => /helvetica/i.test(c.font || ''))) {
      const natural = pieces.reduce((n, pc) => n + measure(pc.text), 0);
      const actual = pieces.reduce((n, pc) => n + (pc.x1 - pc.x0), 0);
      if (natural > 0) {
        const eff = Math.round((actual / natural) * 2) / 2;
        if (eff > 3 && Math.abs(eff / L.size - 1) > 0.03) { L.size = eff; for (const pc of pieces) for (const c of pc.chars) c.size = eff; }
      }
    }
    out.push({ page: pageIndex, base: L.base, size: L.size, pieces, text, x0: pieces[0].x0, x1: pieces[pieces.length - 1].x1, firstWordW: fw,
      top: Math.min(...ink.map(c => c.y0)), bottom: Math.max(...ink.map(c => c.y1)) });
  }
  out.sort((a, b) => a.base - b.base);
  return { lines: out, skipped };
}

// ---------------------------------------------------------------- paragraphs
function isMarkerPiece(line) {
  return line.pieces.length > 1 && MARKER.test(line.pieces[0].text.trim()) && line.pieces[1].x0 - line.pieces[0].x1 > 4;
}
function segment(allLines, geo) {
  const paras = [];
  const pitchFor = size => geo.pitch.get(Math.round(size * 2) / 2) || size * 1.2;
  let P = null;
  const close = () => { if (P) paras.push(P); P = null; };
  for (let i = 0; i < allLines.length; i++) {
    const L = allLines[i];
    const prev = P && P.lines[P.lines.length - 1];
    let start = !P;
    if (P) {
      const samePage = prev.page === L.page;
      const marker = isMarkerPiece(L);
      const centred = geo.isCentred(L) || geo.isCentred(prev);
      const extra = l => l.pieces.length - (isMarkerPiece(l) ? 1 : 0);
      const tabular = extra(prev) > 1 || extra(L) > 1;
      const sizeChange = Math.abs(L.size - prev.size) > 0.6;
      const gapBig = samePage && (L.base - prev.base) > 1.55 * pitchFor(prev.size);
      const backwards = samePage && L.base <= prev.base;
      // the decisive test: would this line's first word have fitted on the previous line?
      // (a near tie counts as not fitting: the PDF's own measurements decided it, and splitting a
      // paragraph by mistake does more harm than joining two)
      const fitted = prev.x1 + prev.size * 0.28 + L.firstWordW <= geo.right - 1.5;
      const contX = P.contX;
      const indentBreak = contX != null ? Math.abs(L.x0 - contX) > 2.5 : false;
      const firstX = P.lines.length === 1 ? (isMarkerPiece(P.lines[0]) ? P.lines[0].pieces[1].x0 : P.lines[0].x0) : null;
      const contImplausible = P.lines.length === 1 && L.x0 > firstX + 2.5; // a continuation never starts further right than the first line's text
      const pageEdge = !samePage && (L.page !== prev.page + 1);
      start = marker || centred || tabular || sizeChange || gapBig || backwards || fitted || indentBreak || contImplausible || pageEdge
        || (!samePage && fitted);
    }
    if (start) { close(); P = { lines: [L], contX: null }; }
    else { P.lines.push(L); if (P.contX == null) P.contX = L.x0; }
  }
  close();
  return paras;
}

function paraProps(P, prevP, geo, pageTop) {
  const ls = P.lines, first = ls[0];
  const gaps = [];
  for (let i = 1; i < ls.length; i++) if (ls[i].page === ls[i - 1].page) gaps.push(ls[i].base - ls[i - 1].base);
  const pitch = median(gaps) || geo.pitch.get(Math.round(first.size * 2) / 2) || first.size * 1.2;
  const marker = isMarkerPiece(first);
  const textX = marker ? first.pieces[1].x0 : first.x0;
  let left = (P.contX != null ? P.contX : textX) - geo.left;
  let firstLine = (marker ? first.pieces[0].x0 : first.x0) - geo.left - left;
  let align = 'left';
  if (ls.length === 1 && geo.isCentred(first)) { align = 'center'; left = 0; firstLine = 0; }
  else if (ls.length === 1 && first.pieces.length === 1 && first.x0 > geo.left + 0.45 * geo.width && Math.abs(first.x1 - geo.right) < 2.5) { align = 'right'; left = 0; firstLine = 0; }
  else {
    const nonLast = ls.slice(0, -1).filter(l => l.pieces.length === 1 || marker);
    if (nonLast.length) {
      const rights = nonLast.map(l => l.x1);
      const spread = Math.max(...rights) - Math.min(...rights);
      const atEdge = Math.max(...rights) > geo.right - 3;
      if (atEdge && spread < 1.6 && (nonLast.length >= 2 || stretched(nonLast[0]))) align = 'both';
    }
  }
  // spacing above
  let before = 0, pageBreak = false;
  if (!prevP) before = Math.max(0, first.base - pageTop(first));
  else {
    const last = prevP.lines[prevP.lines.length - 1];
    if (last.page === first.page) before = Math.max(0, first.base - last.base - pitch);
    else { pageBreak = true; before = Math.max(0, first.base - pageTop(first)); }
  }
  // tab stops for the pieces after the first (or after the marker)
  const tabs = new Map();
  for (const L of ls) L.pieces.forEach((pc, k) => {
    if (k === 0 || (marker && L === first && k === 1)) return;
    const isLast = k === L.pieces.length - 1;
    if (isLast && Math.abs(pc.x1 - geo.right) < 2.5 && (pc.x1 - pc.x0) < geo.width * 0.4) tabs.set('r' + Math.round(geo.right - geo.left), { pos: geo.right - geo.left, kind: 'right' });
    else tabs.set('l' + Math.round(pc.x0 - geo.left), { pos: pc.x0 - geo.left, kind: 'left' });
  });
  if (marker && left > 0) tabs.set('h' + Math.round(left), { pos: left, kind: 'left' });
  const maxRight = Math.max(...ls.map(l => l.x1));
  let rightInd = maxRight > geo.right + 0.3 ? -(maxRight - geo.right + 0.8) : 0;
  // choose a right edge that reproduces the PDF's own line breaks: every line must still fit,
  // and every line plus the next line's first word must not (widths from the PDF's glyphs)
  const win = fitWindow(P, marker);
  if (win) {
    // move the edge as little as possible; justified text may only move a hair, or its edge would show
    const edge = geo.right - rightInd;
    // word processors measure in twentieths of a point, so leave a little room either side of a tie
    const m = Math.min(0.6, (win.hi - win.lo) / 2 - 0.01);
    const want = Math.min(Math.max(edge, win.lo + m), win.hi - m);
    if (Math.abs(want - edge) > 0.01 && (align !== 'both' || Math.abs(want - edge) <= 1.2)) rightInd = geo.right - want;
  }
  return { pitch, left, firstLine, align, before, pageBreak, marker, rightInd, tabs: [...tabs.values()].sort((a, b) => a.pos - b.pos) };
}
const spaceEm = ch => { const f = wordFont(ch); return f === 'Courier New' ? 0.6 : f === 'Times New Roman' ? 0.25 : 0.2778; };
function naturalEnd(line, startPiece) {
  // where the line would end with ordinary word spacing: its real end, less any stretching of
  // the word gaps (justified text); kerning stays as the PDF applied it, and Word applies it too
  const pcs = line.pieces.slice(startPiece);
  let end = pcs[pcs.length - 1].x1, stretch = 0;
  for (const pc of pcs) {
    for (let i = 0; i < pc.chars.length; i++) {
      const c = pc.chars[i];
      if (!c.space || (i > 0 && pc.chars[i - 1].space)) continue;
      let n = 0; while (pc.chars[i + n] && pc.chars[i + n].space) n++;
      stretch += (c.x1 - c.x0) - n * spaceEm(c) * c.size;
    }
  }
  return end - Math.max(0, stretch);
}
function fitWindow(P, marker) {
  const ls = P.lines;
  if (ls.length < 2) return null;
  let lo = -Infinity, hi = Infinity, used = 0;
  for (let i = 0; i < ls.length; i++) {
    const L = ls[i];
    if (L.pieces.length - (i === 0 && marker ? 1 : 0) > 1) return null; // tabbed lines are laid out by their stops
    const end = naturalEnd(L, i === 0 && marker ? 1 : 0);
    lo = Math.max(lo, end);
    const N = ls[i + 1];
    if (!N || N.page !== L.page) continue;
    if (/[-\u2010\u2011]$/.test(L.text)) continue;
    const sp = spaceEm(L.pieces[L.pieces.length - 1].chars.slice(-1)[0]) * L.size;
    hi = Math.min(hi, end + sp + N.firstWordW);
    used++;
  }
  return used && lo < hi ? { lo, hi } : null;
}
function stretched(line) {
  const sp = line.pieces[0].chars.filter(c => c.space || c.c === ' ');
  if (sp.length < 2) return false;
  const avg = sp.reduce((n, c) => n + (c.x1 - c.x0), 0) / sp.length;
  return avg > line.size * 0.36; // a natural space is about 0.28 em
}

// ---------------------------------------------------------------- runs
function runsOf(chars) {
  const runs = [];
  for (const c of chars) {
    const props = { font: wordFont(c), b: isBold(c), i: isItalic(c), sz: Math.round(c.size * 2), color: hexColor(c.color) };
    const R = runs[runs.length - 1];
    const same = R && R.font === props.font && R.b === props.b && R.i === props.i && R.sz === props.sz && R.color === props.color;
    if (c.space && R) { R.text += ' '; continue; } // a space takes the formatting of the word before it
    if (same) R.text += c.c; else runs.push({ ...props, text: c.c });
  }
  return runs;
}
function runXml(r) {
  const rpr = `<w:rPr><w:rFonts w:ascii="${esc(r.font)}" w:hAnsi="${esc(r.font)}" w:cs="${esc(r.font)}"/>${r.b ? '<w:b/>' : ''}${r.i ? '<w:i/>' : ''}${r.color ? `<w:color w:val="${r.color}"/>` : ''}<w:kern w:val="2"/><w:sz w:val="${r.sz}"/><w:szCs w:val="${r.sz}"/></w:rPr>`;
  if (r.tab) return `<w:r>${rpr}<w:tab/></w:r>`;
  if (r.br) return `<w:r>${rpr}<w:br w:type="page"/></w:r>`;
  return `<w:r>${rpr}<w:t xml:space="preserve">${esc(r.text)}</w:t></w:r>`;
}

// ---------------------------------------------------------------- images
const EMU = 12700;
function anchorXml(img, id, relId) {
  const [x0, y0, x1, y1] = img.bbox;
  const cx = Math.round((x1 - x0) * EMU), cy = Math.round((y1 - y0) * EMU);
  return `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${id}" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1">` +
    `<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${Math.round(x0 * EMU)}</wp:posOffset></wp:positionH>` +
    `<wp:positionV relativeFrom="page"><wp:posOffset>${Math.round(y0 * EMU)}</wp:posOffset></wp:positionV><wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="${id}" name="Picture ${id}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="image${id}.png"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
    `</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`;
}

// ---------------------------------------------------------------- calibration
// Where Word and LibreOffice put the baseline of an exactly spaced line, measured below the
// line's top; set by the calibration test.
export const BASELINE = { a: 0.8, b: 0 };
const baselineOffset = (pitch, size) => BASELINE.a * pitch + BASELINE.b * size;

// ---------------------------------------------------------------- PNG (for images with transparency)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function encodePngRGBA(rgba, w, h, zlibSync) {
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1); }
  const idat = zlibSync(raw, { level: 6 });
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length); const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length); for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8); dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length))); return out;
  };
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0;
  for (const p of parts) { png.set(p, o); o += p.length; }
  return png;
}

// ---------------------------------------------------------------- main
export async function toDocx(pages, { title = '', zipSync, zlibSync, keepPages = true, measure = null } = {}) {
  const encodePng = (rgba, w, h) => encodePngRGBA(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength), w, h, zlibSync);
  const all = [];
  let skipped = 0;
  const images = [];
  pages.forEach((pg, i) => {
    const r = buildLines(pg, i, measure);
    all.push(...r.lines); skipped += r.skipped;
    const textArea = r.lines.length;
    for (const im of pg.images) {
      const [x0, y0, x1, y1] = im.bbox;
      const area = ((x1 - x0) * (y1 - y0)) / (pg.w * pg.h);
      if (area > 0.6 && textArea) continue; // a scanned page with recognised text: keep the text, drop the picture
      if (x1 - x0 < 2 || y1 - y0 < 2) continue;
      images.push({ ...im, page: i });
    }
  });
  const W = pages[0] ? pages[0].w : 595.28, H = pages[0] ? pages[0].h : 841.89;
  const body = all.filter(l => l.text.replace(/\s/g, '').length > 2);
  const left = Math.max(18, Math.min(...(body.length ? body : all).map(l => l.x0)));
  // the text column's right edge: the commonest line ending (justified text), else nearly the furthest
  const ends = (body.length ? body : all).map(l => l.x1).sort((a, b) => a - b);
  const buckets = new Map();
  for (const x of ends) { const k = Math.round(x * 2) / 2; buckets.set(k, (buckets.get(k) || 0) + 1); }
  const [modeX, modeN] = [...buckets].reduce((best, e) => (e[1] > best[1] || (e[1] === best[1] && e[0] > best[0]) ? e : best), [0, 0]);
  const p98 = ends.length ? ends[Math.min(ends.length - 1, Math.floor(ends.length * 0.98))] : W - 56;
  const justifiedEdge = modeN >= Math.max(3, ends.length * 0.05) && modeX > p98 - 6;
  // justified text marks the column edge exactly, and lines that only just fit were broken early,
  // so the column is set a hair inside it; ragged text gets a little room instead
  let right = justifiedEdge ? Math.max(...ends.filter(x => x <= modeX + 0.6)) : Math.max(...ends.filter(x => x <= p98 + 3));
  right = Math.min(W - 18, right);
  const rightMargin = Math.max(10, justifiedEdge ? W - right : W - right - 0.6);
  // typical line pitch for each text size
  const gapsBySize = new Map();
  for (let i = 1; i < all.length; i++) {
    const a = all[i - 1], b = all[i];
    if (a.page !== b.page || Math.abs(a.size - b.size) > 0.3) continue;
    const g = b.base - a.base;
    if (g > a.size * 0.95 && g < a.size * 1.9) { const k = Math.round(a.size * 2) / 2; if (!gapsBySize.has(k)) gapsBySize.set(k, []); gapsBySize.get(k).push(g); }
  }
  const pitch = new Map([...gapsBySize].map(([k, v]) => [k, median(v)]));
  const width = right - left;
  const geo = {
    left, right, width, pitch,
    isCentred: L => L.pieces.length === 1 && L.x0 > left + 18 && right - L.x1 > 18 && Math.abs((L.x0 + L.x1) / 2 - (left + right) / 2) < 3,
  };
  // top margin: the highest first line on any page sets it; later pages add space above
  const firstOn = new Map();
  for (const L of all) if (!firstOn.has(L.page)) firstOn.set(L.page, L);
  const pitchOf = L => pitch.get(Math.round(L.size * 2) / 2) || L.size * 1.2;
  let top = Math.min(...[...firstOn.values()].map(L => L.base - baselineOffset(pitchOf(L), L.size)));
  if (!isFinite(top)) top = 56.7;
  top = Math.max(10, top);
  const pageTop = L => top + baselineOffset(pitchOf(L), L.size);
  const lastBottom = Math.max(...all.map(l => l.base + l.size * 0.3), H - 72);
  const bottom = Math.max(12, Math.min(72, H - lastBottom - 4));

  const paras = segment(all, geo);
  const xml = [];
  let imgId = 0;
  const rels = [];
  const media = {};
  const imagesByPage = new Map();
  for (const im of images) { if (!imagesByPage.has(im.page)) imagesByPage.set(im.page, []); imagesByPage.get(im.page).push(im); }
  const placedPages = new Set();
  const words = [];
  for (let k = 0; k < paras.length; k++) {
    const P = paras[k];
    const pp = paraProps(P, paras[k - 1], geo, pageTop);
    const ppr = [];
    if (pp.pageBreak && keepPages) ppr.push('<w:pageBreakBefore/>');
    ppr.push('<w:widowControl w:val="0"/>');
    if (pp.tabs.length) ppr.push('<w:tabs>' + pp.tabs.map(t => `<w:tab w:val="${t.kind}" w:pos="${tw(t.pos)}"/>`).join('') + '</w:tabs>');
    ppr.push(`<w:spacing w:before="${tw(pp.before)}" w:after="0" w:line="${tw(pp.pitch)}" w:lineRule="exact"/>`);
    const ind = [`w:left="${tw(Math.max(0, pp.left))}"`];
    if (pp.firstLine < -0.5) ind.push(`w:hanging="${tw(-pp.firstLine)}"`); else if (pp.firstLine > 0.5) ind.push(`w:firstLine="${tw(pp.firstLine)}"`);
    ppr.push(`<w:ind ${ind.join(' ')} w:right="${tw(pp.rightInd)}"/>`);
    if (pp.align !== 'left') ppr.push(`<w:jc w:val="${pp.align}"/>`);
    // runs
    const runs = [];
    P.lines.forEach((L, li) => {
      L.pieces.forEach((pc, pi) => {
        if (pi > 0) runs.push({ ...runs[runs.length - 1], tab: true, text: '' });
        runs.push(...runsOf(pc.chars));
      });
      if (li < P.lines.length - 1 && runs.length && P.lines[li + 1].page !== L.page && keepPages) {
        runs.push({ ...runs[runs.length - 1], br: true, text: '' });
      } else if (li < P.lines.length - 1 && runs.length) {
        const lastRun = [...runs].reverse().find(r => !r.tab && !r.br);
        const next = P.lines[li + 1].text;
        if (lastRun && !(/[-\u2010\u2011]$/.test(lastRun.text) && /^[a-z]/.test(next))) { if (!/\s$/.test(lastRun.text)) lastRun.text += ' '; }
      }
    });
    for (const r of runs) if (!r.tab && !r.br) words.push(...r.text.split(/\s+/).filter(Boolean));
    // images anchored to the first paragraph that starts on their page
    let drawings = '';
    const pg = P.lines[0].page;
    if (!placedPages.has(pg) && imagesByPage.has(pg)) {
      placedPages.add(pg);
      for (const im of imagesByPage.get(pg)) {
        let png = im.png;
        if (!png && im.rgba && encodePng) png = await encodePng(im.rgba, im.w, im.h);
        if (!png) continue;
        imgId++;
        const relId = `rIdImg${imgId}`;
        media[`word/media/image${imgId}.png`] = png;
        rels.push(`<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${imgId}.png"/>`);
        drawings += anchorXml(im, imgId, relId);
      }
    }
    xml.push(`<w:p><w:pPr>${ppr.join('')}</w:pPr>${drawings}${runs.map(runXml).join('')}</w:p>`);
  }
  // images on pages with no text at all get an empty paragraph of their own
  for (const [pg, list] of imagesByPage) if (!placedPages.has(pg)) {
    let drawings = '';
    for (const im of list) {
      let png = im.png; if (!png && im.rgba && encodePng) png = await encodePng(im.rgba, im.w, im.h); if (!png) continue;
      imgId++; const relId = `rIdImg${imgId}`;
      media[`word/media/image${imgId}.png`] = png;
      rels.push(`<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${imgId}.png"/>`);
      drawings += anchorXml(im, imgId, relId);
    }
    xml.push(`<w:p><w:pPr>${xml.length ? '<w:pageBreakBefore/>' : ''}</w:pPr>${drawings}</w:p>`);
  }
  const sect = `<w:sectPr><w:pgSz w:w="${tw(W)}" w:h="${tw(H)}"${W > H ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="${tw(top)}" w:right="${tw(rightMargin)}" w:bottom="${tw(bottom)}" w:left="${tw(left)}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`;
  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NS}><w:body>${xml.join('')}${sect}</w:body></w:document>`;
  const enc = s => new TextEncoder().encode(s);
  const files = {
    '[Content_Types].xml': enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`),
    '_rels/.rels': enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`),
    'word/_rels/document.xml.rels': enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>${rels.join('')}</Relationships>`),
    'word/styles.xml': enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" w:eastAsia="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>`),
    'word/settings.xml': enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:doNotExpandShiftReturn/><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="14"/></w:compat></w:settings>`),
    'docProps/core.xml': enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>Quire PDF</dc:creator></cp:coreProperties>`),
    'word/document.xml': enc(doc),
    ...media,
  };
  return { bytes: zipSync(files, { level: 6 }), stats: { paragraphs: paras.length, pages: pages.length, images: imgId, skippedChars: skipped, words } };
}
