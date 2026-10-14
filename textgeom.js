// Geometry of text runs reported by PDF.js, in PDF user space.

export function itemGeom(it) {
  const [a, b, c, d, e, f] = it.transform;
  // horizontal, upright text only (a slight skew, as in scans, is allowed)
  if (a <= 0 || d <= 0 || Math.abs(b) > 0.05 * a || Math.abs(c) > 0.05 * d) return null;
  const size = Math.hypot(c, d) || it.height || a;
  const st = it.style || {};
  let asc = typeof st.ascent === 'number' && st.ascent > 0.3 && st.ascent < 1.3 ? st.ascent : 0.8;
  let desc = typeof st.descent === 'number' && st.descent < 0 && st.descent > -0.6 ? st.descent : -0.2;
  return { x0: e, x1: e + it.width, y0: f + desc * size, y1: f + asc * size, base: f, size };
}

// Position of character i within a text run, measured with real font metrics rather than
// assuming every character is the same width.
let mctx = null;
const totals = new WeakMap();
function fontFor(it) {
  const fam = ((it.style && it.style.fontFamily) || '').toLowerCase();
  if (/mono|courier/.test(fam)) return 'monospace';
  if (/serif/.test(fam) && !/sans/.test(fam)) return '"Times New Roman", Times, serif';
  return 'Helvetica, Arial, sans-serif';
}
function measure(it, s) {
  if (!mctx) mctx = (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas')).getContext('2d');
  mctx.font = `100px ${fontFor(it)}`;
  return mctx.measureText(s).width;
}
export function xAt(it, i) {
  const s = it.str, g0 = it.transform[4];
  if (i <= 0) return g0;
  if (i >= s.length) return g0 + it.width;
  let total = totals.get(it);
  if (total === undefined) { total = measure(it, s) || 1; totals.set(it, total); }
  return g0 + it.width * (measure(it, s.slice(0, i)) / total);
}
export function indexAt(it, x) {
  let lo = 0, hi = it.str.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if ((xAt(it, mid) + xAt(it, mid + 1)) / 2 < x) lo = mid + 1; else hi = mid; }
  return lo;
}

export const intersects = (r, s) => r[0] < s[2] && s[0] < r[2] && r[1] < s[3] && s[1] < r[3];
export function overlapArea(r, s) {
  const w = Math.min(r[2], s[2]) - Math.max(r[0], s[0]);
  const h = Math.min(r[3], s[3]) - Math.max(r[1], s[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

// Rectangles covering the text between two points, line by line, as a reader would select it.
export function snapRects(items, pA, pB) {
  const R = [Math.min(pA[0], pB[0]), Math.min(pA[1], pB[1]), Math.max(pA[0], pB[0]), Math.max(pA[1], pB[1])];
  const cand = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const g = itemGeom(it); if (!g) continue;
    const h = g.y1 - g.y0;
    const vOverlap = Math.min(g.y1, R[3]) - Math.max(g.y0, R[1]);
    const holdsPoint = [pA, pB].some(q => q[1] >= g.y0 && q[1] <= g.y1);
    if (!(vOverlap > 0.35 * h || holdsPoint)) continue;
    if (g.x1 < R[0] - 1 || g.x0 > R[2] + 1) continue;
    cand.push({ ...g, it });
  }
  if (!cand.length) return [];
  // group into lines by baseline
  cand.sort((a, b) => b.base - a.base || a.x0 - b.x0);
  const lines = [];
  for (const g of cand) {
    const L = lines.find(l => Math.abs(l.base - g.base) < g.size * 0.5);
    if (L) { L.x0 = Math.min(L.x0, g.x0); L.x1 = Math.max(L.x1, g.x1); L.y0 = Math.min(L.y0, g.base - 0.22 * g.size); L.y1 = Math.max(L.y1, g.base + 0.89 * g.size); L.items.push(g); }
    else lines.push({ ...g, y0: g.base - 0.22 * g.size, y1: g.base + 0.89 * g.size, items: [g] });
  }
  lines.sort((a, b) => b.base - a.base);
  const top = pA[1] >= pB[1] ? pA : pB, bottom = top === pA ? pB : pA;
  // extend a position to the edge of the word it falls in, as a reader's selection would
  const snap = (L, x, side) => {
    if (x <= L.x0) return L.x0;
    if (x >= L.x1) return L.x1;
    const g = L.items.find(q => x >= q.x0 && x <= q.x1);
    if (!g) return x;
    const s = g.it.str;
    let i = Math.min(s.length, indexAt(g.it, x));
    const i0 = i, P = /[.,;:!?)\]}"'\u2019\u201d(\[{\u2018\u201c]/;
    if (side === 'start') {
      while (i > 0 && !/\s/.test(s[i - 1])) i--;
      while (i < s.length && /\s/.test(s[i])) i++;
      while (i < i0 && P.test(s[i])) i++; // leave an opening bracket or quote out unless dragged over
    } else {
      while (i < s.length && !/\s/.test(s[i])) i++;
      while (i > 0 && /\s/.test(s[i - 1])) i--;
      while (i > i0 && P.test(s[i - 1])) i--; // leave trailing punctuation out unless dragged over
    }
    return xAt(g.it, i);
  };
  const out = [];
  lines.forEach((L, i) => {
    let x0 = L.x0, x1 = L.x1;
    if (lines.length === 1) { x0 = snap(L, R[0], 'start'); x1 = snap(L, R[2], 'end'); }
    else if (i === 0) x0 = snap(L, top[0], 'start');
    else if (i === lines.length - 1) x1 = snap(L, bottom[0], 'end');
    if (x1 - x0 > 1) out.push([x0, L.y0, x1, L.y1]);
  });
  return out;
}

// The text run under a point, if any.
export function itemAt(items, x, y) {
  let best = null, bestArea = Infinity;
  items.forEach((it, i) => {
    if (!it.str || !it.str.trim()) return;
    const g = itemGeom(it); if (!g) return;
    if (x >= g.x0 - 1.5 && x <= g.x1 + 1.5 && y >= g.y0 - 1.5 && y <= g.y1 + 1.5) {
      const area = (g.x1 - g.x0) * (g.y1 - g.y0);
      if (area < bestArea) { best = { it, g, index: i }; bestArea = area; }
    }
  });
  return best;
}

// Rectangles for every match of a pattern within individual text runs.
export function matchRects(items, re) {
  const out = [];
  for (const it of items) {
    const s = it.str; if (!s) continue;
    const g = itemGeom(it); if (!g) continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s))) {
      if (!m[0].length) { re.lastIndex++; continue; }
      const k = m.index, n = m[0].length;
      out.push({ rect: [xAt(it, k), g.y0, xAt(it, k + n), g.y1], text: m[0] });
      if (!re.global) break;
    }
  }
  return out;
}

// Matches across whole lines, so phrases spanning separate text runs (common in scanned and
// converted documents) are still found.
export function matchRectsLines(items, re) {
  const runs = [];
  for (const it of items) { if (!it.str) continue; const g = itemGeom(it); if (g) runs.push({ it, g }); }
  runs.sort((a, b) => (Math.abs(a.g.base - b.g.base) < Math.min(a.g.size, b.g.size) * 0.5 ? a.g.x0 - b.g.x0 : b.g.base - a.g.base));
  const lines = [];
  for (const r of runs) {
    const L = lines[lines.length - 1];
    if (L && Math.abs(L.base - r.g.base) < Math.min(L.size, r.g.size) * 0.5) L.runs.push(r); else lines.push({ base: r.g.base, size: r.g.size, runs: [r] });
  }
  const out = [];
  for (const L of lines) {
    let text = ''; const map = [];
    L.runs.forEach((r, ri) => {
      if (ri) {
        const prev = L.runs[ri - 1];
        const gap = r.g.x0 - prev.g.x1;
        if (gap > r.g.size * 0.15 && !/\s$/.test(text) && !/^\s/.test(r.it.str)) { text += ' '; map.push(null); }
      }
      for (let i = 0; i < r.it.str.length; i++) { text += r.it.str[i]; map.push([r, i]); }
    });
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (!m[0].length) { re.lastIndex++; continue; }
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = m.index; i < m.index + m[0].length; i++) {
        const e = map[i]; if (!e) continue;
        const [r, ci] = e;
        x0 = Math.min(x0, xAt(r.it, ci)); x1 = Math.max(x1, xAt(r.it, ci + 1));
        y0 = Math.min(y0, r.g.y0); y1 = Math.max(y1, r.g.y1);
      }
      if (x1 > x0) out.push({ rect: [x0, y0, x1, y1], text: m[0] });
      if (!re.global) break;
    }
  }
  return out;
}

// Each word with its position, for comparison and verification.
export function wordBoxes(items) {
  const out = [];
  for (const it of items) {
    const s = it.str; if (!s) continue;
    const g = itemGeom(it);
    const re = /[\p{L}\p{N}£$%€'’]+/gu;
    let m;
    while ((m = re.exec(s))) {
      const w = m[0].toLowerCase().replace(/’/g, "'");
      const rect = g ? [xAt(it, m.index), g.y0, xAt(it, m.index + m[0].length), g.y1] : null;
      out.push({ w, raw: m[0], rect });
    }
  }
  return out;
}

export function stdFontFor(name, family) {
  const n = `${name || ''} ${family || ''}`;
  const bold = /bold|black|heavy|semibold|demi/i.test(name || '');
  const italic = /italic|oblique/i.test(name || '');
  let fam = 'Helvetica';
  if (/courier|mono|consol/i.test(n)) fam = 'Courier';
  else if (/times|georgia|garamond|cambria|palatino|minion|book ?antiqua|baskerville|caslon/i.test(n) || (/serif/i.test(family || '') && !/sans/i.test(family || ''))) fam = 'Times';
  return { fam, bold, italic };
}
export function cssFont(f) {
  const fam = f.fam === 'Times' ? '"Times New Roman", Times, serif' : f.fam === 'Courier' ? '"Courier New", Courier, monospace' : 'Helvetica, Arial, sans-serif';
  return { family: fam, weight: f.bold ? '700' : '400', style: f.italic ? 'italic' : 'normal' };
}
export function stdFontKey(f) {
  const m = {
    Helvetica: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
    Times: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
    Courier: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'],
  }[f.fam];
  return m[(f.bold ? 1 : 0) + (f.italic ? 2 : 0)];
}

export const PATTERNS = {
  email: { label: 'Email addresses', re: () => /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
  phone: { label: 'Phone numbers', re: () => /(?:\+44\s?\(?0?\)?\s?\d{2,4}|\(?0\d{2,4}\)?)[\s-]?\d{3,4}[\s-]?\d{3,4}/g },
  postcode: { label: 'Postcodes', re: () => /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi },
  bank: { label: 'Sort codes and account numbers', re: () => /\b\d{2}-\d{2}-\d{2}\b|\b\d{8}\b/g },
  ni: { label: 'National Insurance numbers', re: () => /\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi },
  money: { label: 'Money amounts', re: () => /[£$€]\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?(?:k|m|bn)\b)?/gi },
};
export function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
