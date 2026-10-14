// Quire PDF: an offline PDF editor. Everything happens in this browser tab;
// no document ever leaves the machine. The original file is never modified.
import * as pdfjsLib from './lib/pdf.min.mjs';
import * as Engine from './engine.js';
import { itemGeom, overlapArea, snapRects, itemAt, matchRects, wordBoxes, stdFontFor, cssFont, stdFontKey, PATTERNS, escapeRe, xAt, matchRectsLines } from './textgeom.js';
import { diff, changes as diffChanges } from './compare.js';
import * as Ocr from './ocr.js';
import * as Export from './export.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.mjs', import.meta.url).href;
const { PDFDocument, StandardFonts, rgb, degrees, BlendMode, PDFName, PDFRawStream, PDFNumber, PDFArray, PDFHexString,
  pushGraphicsState, popGraphicsState, setLineWidth, setStrokingRgbColor, moveTo, lineTo, stroke,
  setLineCap, setLineJoin, LineCapStyle, LineJoinStyle, PDFTextField, PDFCheckBox, PDFDropdown,
  PDFOptionList, PDFRadioGroup } = window.PDFLib;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
  }
  for (const c of kids) if (c != null) n.append(c);
  return n;
};
const SVGNS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}) => { const n = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
const uid = () => Math.random().toString(36).slice(2, 10);
const clone = (o) => JSON.parse(JSON.stringify(o));
const PX = 96 / 72;

const COLORS = {
  highlight: ['#ffe14d', '#8ff0a4', '#ffa3c8', '#9fd4ff'],
  pen: ['#14243a', '#1f4fd1', '#c4161c', '#127a3a'],
};

// ---------------------------------------------------------------- state
const S = {
  sources: [],          // {name, bytes, pdf (pdf.js doc), numPages, fields: [], text: Map}
  pages: [],            // {uid, src, idx, rot, annots: []}
  forms: {},            // srcIndex -> {fieldName: value}
  images: new Map(),    // id -> {bytes (PNG), url, w, h}
  zoom: 1,
  fitMode: true,
  tool: 'select',
  style: { highlight: COLORS.highlight[0], pen: COLORS.pen[0], penWidth: 2, textSize: 11, textColor: '#14243a',
    markKind: 'highlight', redactFill: 'black', stamp: 'APPROVED', noteColor: '#ffd84d', fieldKind: 'text' },
  selAnnot: null,       // {page uid, id}
  selPages: new Set(),
  anchorPage: null,
  pendingSig: null,     // image id waiting to be placed
  settings: {
    watermark: { on: false, text: 'DRAFT', size: 72, opacity: 0.15 },
    numbers: { on: false, format: 'Page {n} of {N}', pos: 'bottom-centre', size: 9 },
    hf: { on: false, size: 9, slots: { tl: '', tc: '', tr: '', bl: '', bc: '', br: '' } },
    bates: { on: false, prefix: 'MW', start: 1, digits: 6, pos: 'br' },
    compress: { on: false, quality: 0.72 },
    flatten: false,
    clean: false,
    protect: { on: false, user: '', owner: '', allowPrint: true, allowCopy: true, allowEdit: true },
  },
  author: '',
  compare: null,        // {name, changes: [], marks: Map(page uid -> [{rect, kind}])}
  railTab: 'pages',
  history: [],
  search: { q: '', hits: [], cur: -1 },
  lastReport: null,
  sample: false,
};

// ---------------------------------------------------------------- utilities
function toast(msg, ms = 3200) {
  const t = el('div', { class: 'toast', text: msg });
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}
async function busyProgress(msg, fn) {
  const label = el('div', { text: msg });
  const b = el('div', { class: 'busy' }, label);
  document.body.append(b);
  try { return await fn(t => { label.textContent = t; }); } finally { b.remove(); }
}
async function busy(msg, fn) {
  const b = el('div', { class: 'busy' }, el('div', { text: msg }));
  document.body.append(b);
  try { return await fn(); } finally { b.remove(); }
}
const store = {
  get(k, d) { try { const v = localStorage.getItem('quire.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('quire.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); }
function words(s) { return (s.toLowerCase().match(/[\p{L}\p{N}£$%€'’]+/gu) || []).map(w => w.replace(/’/g, "'").replace(/^'+|'+$/g, '')).filter(w => /[\p{L}\p{N}]/u.test(w)); }
function isSubsequence(small, big) {
  let j = 0;
  for (let i = 0; i < big.length && j < small.length; i++) if (big[i] === small[j]) j++;
  return j === small.length;
}
function baseName(n) { return n.replace(/\.pdf$/i, ''); }
function fmtBytes(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

// Saving: inside a Claude artifact use the downloads capability; elsewhere a normal download.
let downloadsPromise = null;
function getDownloads() {
  if (!downloadsPromise) downloadsPromise = (window.claude && typeof window.claude.use === 'function')
    ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null);
  return downloadsPromise;
}
async function saveFile(bytes, filename, mime = 'application/pdf') {
  const blob = new Blob([bytes], { type: mime });
  const dl = await getDownloads();
  if (dl) {
    try { await dl.save({ filename, data: blob }); return true; }
    catch (e) {
      if (e && e.code === 'declined') { toast('Save cancelled.'); return false; }
      if (e && e.code === 'rate_limited') { toast('A save is already waiting for your confirmation.'); return false; }
      if (e && !['unavailable', 'not_granted', 'capability_disabled', 'capability_removed'].includes(e.code)) { toast('Could not save: ' + (e.message || e.code)); return false; }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return true;
}

// ---------------------------------------------------------------- history
function snapshot() {
  S.history.push({ pages: clone(S.pages), forms: clone(S.forms) });
  if (S.history.length > 60) S.history.shift();
  $('#btnUndo').disabled = false;
}
function undo() {
  const h = S.history.pop();
  if (!h) return;
  const structural = h.pages.length !== S.pages.length || h.pages.some((p, i) => p.uid !== S.pages[i].uid || p.rot !== S.pages[i].rot);
  S.pages = h.pages; S.forms = h.forms; S.selAnnot = null;
  $('#btnUndo').disabled = !S.history.length;
  if (structural) rebuildAll(); else { refreshAllAnnots(); refreshForms(); }
  renderInspector();
}

// ---------------------------------------------------------------- loading
async function readFile(file) { return new Uint8Array(await file.arrayBuffer()); }

function hasEncryptDict(bytes) {
  // the /Encrypt key always sits in an uncompressed trailer or xref-stream dictionary
  const tail = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.length - 65536)));
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
  return /\/Encrypt(?![A-Za-z])/.test(tail) || /\/Encrypt(?![A-Za-z])/.test(head);
}
function askPassword(message) {
  return new Promise(resolve => {
    const inp = el('input', { type: 'password', class: 'field', id: 'pwOpen', autocomplete: 'off', 'aria-label': 'Password' });
    const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Password' });
    const done = v => { modal.remove(); resolve(v); };
    const form = el('form', { class: 'dialog' }, el('h2', { text: 'Password required' }), el('p', { class: 'note', text: message }), inp,
      el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn outline', text: 'Cancel', onclick: () => done(null) }),
        el('button', { type: 'submit', class: 'btn primary', text: 'Unlock' })));
    form.addEventListener('submit', e => { e.preventDefault(); done(inp.value); });
    modal.append(form); document.body.append(modal); inp.focus();
  });
}

async function addSource(bytes, name) {
  let protectedWith = null, pdf = null;
  if (hasEncryptDict(bytes)) {
    // Encrypted files are decrypted in memory so every tool can work on them; the original stays untouched.
    let res = await busy('Unlocking…', () => Engine.decrypt(bytes, ''));
    let msg = `${name} is protected with a password.`;
    while (!res.ok) {
      const pw = await askPassword(msg);
      if (pw == null) throw Object.assign(new Error('cancelled'), { name: 'Cancelled' });
      res = await busy('Unlocking…', () => Engine.decrypt(bytes, pw));
      if (res.ok) protectedWith = pw; else msg = 'That password did not work. Try again.';
    }
    bytes = res.bytes;
    if (protectedWith == null) protectedWith = '';
  }
  pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const src = { name, bytes, pdf, numPages: pdf.numPages, fields: [], text: new Map(), viewports: new Map(), protectedWith };
  S.sources.push(src);
  const si = S.sources.length - 1;
  try { await loadFields(si); } catch (e) { console.warn('Form fields could not be read', e); }
  return si;
}

async function openDocument(bytes, name, { sample = false } = {}) {
  // load the new file first; the current document is only replaced once it has opened
  const previous = S.sources;
  S.sources = [];
  let si;
  try { si = await addSource(bytes, name); }
  catch (e) {
    for (const s of S.sources) s.pdf.destroy();
    S.sources = previous;
    toast(e.name === 'Cancelled' ? 'Not opened.' : 'This file could not be read as a PDF.');
    return false;
  }
  for (const s of previous) s.pdf.destroy();
  S.pages = []; S.forms = {}; S.history = []; S.selPages.clear(); S.selAnnot = null;
  S.search = { q: '', hits: [], cur: -1 }; $('#q').value = ''; $('#qCount').textContent = '';
  S.lastReport = null; S.sample = sample; S.compare = null; S.railTab = 'pages';
  S.fileHandle = null; S.replaceConfirmed = null; if ($('#btnSaveBack')) updateSaveUi();
  S.settings.protect = { on: false, user: '', owner: '', allowPrint: true, allowCopy: true, allowEdit: true };
  const src0 = S.sources[si];
  if (src0.fields.length) S.forms[si] = src0.initialValues;
  if (src0.protectedWith != null) {
    S.settings.protect.on = !!src0.protectedWith; S.settings.protect.user = src0.protectedWith || '';
    toast(src0.protectedWith ? 'Unlocked. The saved copy will keep the same password unless you change it under When saving.'
      : 'This file had editing restrictions. They are lifted in this working copy; your original is unchanged.', 6000);
  }
  for (let i = 0; i < src0.numPages; i++) S.pages.push({ uid: uid(), src: si, idx: i, rot: 0, annots: [] });
  $('#btnUndo').disabled = true;
  S.fitMode = true;
  await rebuildAll();
  $('#stName').textContent = sample ? 'Sample document (open your own PDF to begin)' : name;
  S.scanned = [];
  renderInspector();
  refreshScanned();
  return true;
}

async function insertDocuments(files) {
  if (!S.sources.length) { if (files[0]) await openDocument(await readFile(files[0]), files[0].name); files = files.slice(1); }
  if (!files.length) return;
  snapshot();
  const sel = [...S.selPages].map(u => S.pages.findIndex(p => p.uid === u)).filter(i => i >= 0);
  let at = sel.length ? Math.max(...sel) + 1 : S.pages.length;
  let added = 0;
  for (const f of files) {
    let si;
    try { si = await addSource(await readFile(f), f.name); }
    catch { toast(`${f.name} could not be read as a PDF.`); continue; }
    const np = S.sources[si].numPages;
    const fresh = Array.from({ length: np }, (_, i) => ({ uid: uid(), src: si, idx: i, rot: 0, annots: [] }));
    S.pages.splice(at, 0, ...fresh); at += np; added += np;
  }
  if (S.sample) { S.sample = false; $('#stName').textContent = S.sources[0].name; }
  await rebuildAll();
  refreshScanned();
  if (added) toast(`Added ${added} page${added === 1 ? '' : 's'}.`);
}

// ---------------------------------------------------------------- forms (read)
async function loadFields(si) {
  const src = S.sources[si];
  const doc = await PDFDocument.load(src.bytes, { ignoreEncryption: true, updateMetadata: false });
  const form = doc.getForm();
  const pageRefs = doc.getPages().map(p => p.ref.toString());
  const values = {};
  for (const f of form.getFields()) {
    let type = null;
    if (f instanceof PDFTextField) type = 'text';
    else if (f instanceof PDFCheckBox) type = 'check';
    else if (f instanceof PDFDropdown) type = 'select';
    else if (f instanceof PDFOptionList) type = 'list';
    else if (f instanceof PDFRadioGroup) type = 'radio';
    if (!type || f.isReadOnly()) continue;
    const widgets = f.acroField.getWidgets();
    const opts = type === 'radio' ? f.getOptions() : (type === 'select' || type === 'list') ? f.getOptions() : null;
    const entry = { name: f.getName(), type, widgets: [], options: opts, multiline: type === 'text' && f.isMultiline() };
    widgets.forEach((w, wi) => {
      const r = w.getRectangle();
      let pi = -1;
      const pref = w.P();
      if (pref) pi = pageRefs.indexOf(pref.toString());
      if (pi < 0) {
        // find the page whose /Annots holds this widget
        const wref = doc.context.getObjectRef(w.dict);
        doc.getPages().forEach((pg, k) => {
          const annots = pg.node.Annots();
          if (annots && wref && annots.asArray().some(a => a.toString() === wref.toString())) pi = k;
        });
      }
      let onValue = null;
      if (type === 'radio') { try { onValue = opts[wi]; } catch { /* ignore */ } }
      if (pi >= 0) entry.widgets.push({ page: pi, rect: [r.x, r.y, r.x + r.width, r.y + r.height], onValue });
    });
    if (!entry.widgets.length) continue;
    if (type === 'text') values[entry.name] = f.getText() || '';
    else if (type === 'check') values[entry.name] = f.isChecked();
    else if (type === 'radio') values[entry.name] = f.getSelected() || '';
    else values[entry.name] = (f.getSelected() || [])[0] || '';
    src.fields.push(entry);
  }
  src.initialValues = values;
  if (src.fields.length) S.forms[si] = values;
}

// ---------------------------------------------------------------- document view
const views = new Map(); // page uid -> {div, canvas, svg, layer, vp, renderTask, rendered}
let observer = null;

async function getPdfPage(p) { return S.sources[p.src].pdf.getPage(p.idx + 1); }
async function viewportFor(p, scale) {
  const pg = await getPdfPage(p);
  return pg.getViewport({ scale, rotation: (pg.rotate + p.rot) % 360 });
}
async function computeFitZoom() {
  if (!S.pages.length) return 1;
  const wrap = $('#docwrap');
  let maxW = 0;
  for (const p of S.pages.slice(0, 40)) { const vp = await viewportFor(p, 1); maxW = Math.max(maxW, vp.width); }
  const avail = Math.max(240, wrap.clientWidth - 48);
  return Math.min(2.2, Math.max(0.3, avail / (maxW * PX)));
}

async function rebuildAll() {
  S.building = (S.building || 0) + 1;
  try { await rebuildAllInner(); } finally { S.building--; }
}
async function rebuildAllInner() {
  if (S.fitMode) S.zoom = await computeFitZoom();
  $('#zLabel').textContent = Math.round(S.zoom * 100) + '%';
  await buildDocView();
  await buildThumbs();
  if (S.search.q) await runSearch(S.search.q, true);
}

async function buildDocView() {
  const doc = $('#doc');
  const scroll = $('#docwrap').scrollTop;
  if (observer) observer.disconnect();
  for (const v of views.values()) if (v.renderTask) v.renderTask.cancel();
  views.clear();
  doc.replaceChildren();
  const scale = S.zoom * PX;
  observer = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) renderPage(e.target.dataset.uid);
  }, { root: $('#docwrap'), rootMargin: '600px 0px' });
  for (let i = 0; i < S.pages.length; i++) {
    const p = S.pages[i];
    const vp = await viewportFor(p, scale);
    const div = el('div', { class: 'page', 'data-uid': p.uid });
    div.style.width = vp.width + 'px'; div.style.height = vp.height + 'px';
    const canvas = el('canvas', { class: 'render' });
    const svg = sv('svg', { class: 'ann', viewBox: `0 0 ${vp.width} ${vp.height}` });
    const layer = el('div', { class: 'layer' });
    div.append(canvas, svg, layer, el('span', { class: 'pno', text: String(i + 1) }));
    doc.append(div);
    views.set(p.uid, { div, canvas, svg, layer, vp, rendered: false, renderTask: null });
    bindPagePointer(p.uid);
    drawAnnots(p.uid);
    drawFields(p.uid);
    observer.observe(div);
  }
  applyToolCursor();
  $('#docwrap').scrollTop = scroll;
  updateStatusPage();
}

async function renderPage(u) {
  const v = views.get(u); const p = S.pages.find(x => x.uid === u);
  if (!v || !p || v.rendered) return;
  v.rendered = true;
  const pg = await getPdfPage(p);
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const vp = pg.getViewport({ scale: S.zoom * PX * dpr, rotation: (pg.rotate + p.rot) % 360 });
  v.canvas.width = Math.floor(vp.width); v.canvas.height = Math.floor(vp.height);
  const ctx = v.canvas.getContext('2d');
  const hasFields = (S.sources[p.src].fields || []).some(f => f.widgets.some(w => w.page === p.idx));
  v.renderTask = pg.render({ canvasContext: ctx, viewport: vp,
    annotationMode: hasFields ? pdfjsLib.AnnotationMode.ENABLE_FORMS : pdfjsLib.AnnotationMode.ENABLE });
  try { await v.renderTask.promise; } catch (e) { if (e && e.name !== 'RenderingCancelledException') console.warn(e); v.rendered = false; }
}

async function buildThumbs() {
  const box = $('#thumbs');
  box.replaceChildren();
  const multi = S.sources.length > 1;
  for (let i = 0; i < S.pages.length; i++) {
    const p = S.pages[i];
    const c = el('canvas');
    const t = el('div', { class: 'thumb' + (S.selPages.has(p.uid) ? ' sel' : ''), draggable: 'true', 'data-uid': p.uid, tabindex: '0',
      'aria-label': `Page ${i + 1}` }, c, el('span', { class: 'n', text: String(i + 1) }));
    if (multi) t.append(el('span', { class: 'src', text: String.fromCharCode(65 + p.src) , title: S.sources[p.src].name }));
    box.append(t);
    bindThumb(t, p.uid);
    // render small
    (async () => {
      const pg = await getPdfPage(p);
      const vp1 = pg.getViewport({ scale: 1, rotation: (pg.rotate + p.rot) % 360 });
      const sc = 120 / vp1.width;
      const vp = pg.getViewport({ scale: sc * 1.5, rotation: (pg.rotate + p.rot) % 360 });
      c.width = vp.width; c.height = vp.height;
      c.style.width = (vp.width / 1.5) + 'px'; c.style.height = (vp.height / 1.5) + 'px';
      await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise.catch(() => {});
    })();
  }
  $('#railHint').textContent = multi ? 'Letters show which file a page came from. Drag to reorder.' : 'Drag to reorder. Ctrl or Shift to select several.';
}

function updateStatusPage() {
  const wrap = $('#docwrap');
  const mid = wrap.scrollTop + wrap.clientHeight / 3;
  let cur = 1;
  $$('.page', $('#doc')).forEach((d, i) => { if (d.offsetTop <= mid) cur = i + 1; });
  $('#stPage').textContent = S.pages.length ? `Page ${cur} of ${S.pages.length}` : '';
}

// ---------------------------------------------------------------- thumbnails: select, reorder
function bindThumb(t, u) {
  t.addEventListener('click', e => {
    const idx = S.pages.findIndex(p => p.uid === u);
    if (e.shiftKey && S.anchorPage) {
      const a = S.pages.findIndex(p => p.uid === S.anchorPage);
      S.selPages.clear();
      for (let k = Math.min(a, idx); k <= Math.max(a, idx); k++) S.selPages.add(S.pages[k].uid);
    } else if (e.ctrlKey || e.metaKey) {
      S.selPages.has(u) ? S.selPages.delete(u) : S.selPages.add(u); S.anchorPage = u;
    } else { S.selPages.clear(); S.selPages.add(u); S.anchorPage = u; }
    $$('.thumb').forEach(x => x.classList.toggle('sel', S.selPages.has(x.dataset.uid)));
    views.get(u)?.div.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
  t.addEventListener('dragstart', e => {
    if (!S.selPages.has(u)) { S.selPages.clear(); S.selPages.add(u); $$('.thumb').forEach(x => x.classList.toggle('sel', S.selPages.has(x.dataset.uid))); }
    e.dataTransfer.setData('text/plain', 'quire-pages'); e.dataTransfer.effectAllowed = 'move';
  });
  t.addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes('text/plain')) return;
    e.preventDefault();
    const r = t.getBoundingClientRect();
    const narrow = window.matchMedia('(max-width: 900px)').matches;
    const after = narrow ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
    $$('.thumb').forEach(x => x.classList.remove('drop-before', 'drop-after'));
    t.classList.add(after ? 'drop-after' : 'drop-before');
  });
  t.addEventListener('dragleave', () => t.classList.remove('drop-before', 'drop-after'));
  t.addEventListener('drop', e => {
    e.preventDefault();
    const after = t.classList.contains('drop-after');
    $$('.thumb').forEach(x => x.classList.remove('drop-before', 'drop-after'));
    if (e.dataTransfer.getData('text/plain') !== 'quire-pages') return;
    movePages(u, after);
  });
}
async function movePages(targetUid, after) {
  if (S.selPages.has(targetUid)) return;
  snapshot();
  const moving = S.pages.filter(p => S.selPages.has(p.uid));
  const rest = S.pages.filter(p => !S.selPages.has(p.uid));
  let at = rest.findIndex(p => p.uid === targetUid) + (after ? 1 : 0);
  rest.splice(at, 0, ...moving);
  S.pages = rest;
  await rebuildAll();
}
function selectedIndexes() {
  return S.pages.map((p, i) => (S.selPages.has(p.uid) ? i : -1)).filter(i => i >= 0);
}
async function rotateSelected(d) {
  const sel = selectedIndexes();
  if (!sel.length) { toast('Select one or more pages in the page rail first.'); return; }
  snapshot();
  for (const i of sel) S.pages[i].rot = (S.pages[i].rot + d + 360) % 360;
  await rebuildAll();
}
async function deleteSelected() {
  const sel = selectedIndexes();
  if (!sel.length) { toast('Select one or more pages in the page rail first.'); return; }
  if (sel.length === S.pages.length) { toast('A document needs at least one page.'); return; }
  snapshot();
  S.pages = S.pages.filter(p => !S.selPages.has(p.uid));
  S.selPages.clear();
  await rebuildAll();
  toast(`Deleted ${sel.length} page${sel.length === 1 ? '' : 's'}. Undo is available.`);
}

// ---------------------------------------------------------------- coordinates
// Annotations are stored in PDF user space so they stay attached to the page content.
function v2u(u, x, y) { const [a, b] = views.get(u).vp.convertToPdfPoint(x, y); return [a, b]; }
function u2v(u, x, y) { const [a, b] = views.get(u).vp.convertToViewportPoint(x, y); return [a, b]; }
function rectU2V(u, r) {
  const [x1, y1] = u2v(u, r[0], r[1]); const [x2, y2] = u2v(u, r[2], r[3]);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}
function rectV2U(u, x, y, w, h) {
  const [a1, b1] = v2u(u, x, y); const [a2, b2] = v2u(u, x + w, y + h);
  return [Math.min(a1, a2), Math.min(b1, b2), Math.max(a1, a2), Math.max(b1, b2)];
}
function frameAt(u, vx, vy) {
  // user-space anchor plus unit vectors that point right and down in the current view
  const o = v2u(u, vx, vy), r = v2u(u, vx + 10, vy), d = v2u(u, vx, vy + 10);
  const n = (a) => { const L = Math.hypot(a[0], a[1]) || 1; return [a[0] / L, a[1] / L]; };
  return { anchor: o, ux: n([r[0] - o[0], r[1] - o[1]]), dx: n([d[0] - o[0], d[1] - o[1]]) };
}
function frameToView(u, a) {
  const [x, y] = u2v(u, a.anchor[0], a.anchor[1]);
  const [rx, ry] = u2v(u, a.anchor[0] + a.ux[0], a.anchor[1] + a.ux[1]);
  const ang = Math.atan2(ry - y, rx - x) * 180 / Math.PI;
  return { x, y, ang, k: Math.hypot(rx - x, ry - y) }; // k = view px per point
}

// ---------------------------------------------------------------- annotations: drawing
function pageOf(u) { return S.pages.find(p => p.uid === u); }
function refreshAllAnnots() { for (const u of views.keys()) drawAnnots(u); }

function drawAnnots(u) {
  const v = views.get(u); const p = pageOf(u);
  if (!v || !p) return;
  const svg = v.svg;
  svg.replaceChildren();
  const g = sv('g', { class: 'annots' });
  const hits = sv('g', { class: 'hits' });
  svg.append(hits, g);
  for (const a of p.annots) {
    let n;
    if (a.type === 'highlight' || a.type === 'whiteout' || a.type === 'rect') {
      const r = rectU2V(u, a.rect);
      n = sv('rect', { x: r.x, y: r.y, width: r.w, height: r.h });
      if (a.type === 'highlight') { n.setAttribute('fill', a.color); n.setAttribute('fill-opacity', '0.4'); n.style.mixBlendMode = 'multiply'; }
      else if (a.type === 'whiteout') { n.setAttribute('fill', '#ffffff'); }
      else { n.setAttribute('fill', 'transparent'); n.setAttribute('stroke', a.color); n.setAttribute('stroke-width', a.width * views.get(u).vp.scale); }
    } else if (a.type === 'ink') {
      const pts = a.points.map(pt => u2v(u, pt[0], pt[1]).map(z => z.toFixed(1)).join(',')).join(' ');
      n = sv('polyline', { points: pts, fill: 'none', stroke: a.color, 'stroke-width': a.width * v.vp.scale, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
      const hitLine = sv('polyline', { points: pts, fill: 'none', stroke: 'transparent', 'stroke-width': Math.max(12, a.width * v.vp.scale + 8) });
      const grp = sv('g'); grp.append(hitLine, n); n = grp;
    } else if (a.type === 'text') {
      const f = frameToView(u, a);
      n = sv('g', { transform: `translate(${f.x} ${f.y}) rotate(${f.ang})` });
      const lines = (a.text || '').split('\n');
      const lh = a.size * 1.2 * f.k;
      const bg = sv('rect', { x: -2, y: -2, width: textWidthPt(a) * f.k + 4, height: lines.length * lh + 4, fill: 'transparent' });
      n.append(bg);
      lines.forEach((line, i) => {
        const t = sv('text', { x: 0, y: i * lh + a.size * f.k * 0.93, fill: a.color, 'font-family': 'Helvetica, Arial, sans-serif', 'font-size': a.size * f.k });
        t.textContent = line || ' ';
        n.append(t);
      });
    } else if (a.type === 'image') {
      const f = frameToView(u, a);
      const img = S.images.get(a.img);
      n = sv('g', { transform: `translate(${f.x} ${f.y}) rotate(${f.ang})` });
      const im = sv('image', { x: 0, y: 0, width: a.w * f.k, height: a.h * f.k, preserveAspectRatio: 'none' });
      if (img) im.setAttribute('href', img.url);
      n.append(sv('rect', { x: 0, y: 0, width: a.w * f.k, height: a.h * f.k, fill: 'transparent' }), im);
    } else if (a.type === 'markup') {
      n = sv('g');
      for (const rr of a.rects) {
        const r = rectU2V(u, rr);
        n.append(sv('rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: 'transparent' }));
        if (a.kind === 'highlight') {
          const h = sv('rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: a.color, 'fill-opacity': '0.4' });
          h.style.mixBlendMode = 'multiply'; n.append(h);
        } else {
          const yy = a.kind === 'underline' ? rr[1] + (rr[3] - rr[1]) * 0.12 : rr[1] + (rr[3] - rr[1]) * 0.42;
          const [x1, y1] = u2v(u, rr[0], yy), [x2, y2] = u2v(u, rr[2], yy);
          n.append(sv('line', { x1, y1, x2, y2, stroke: a.color, 'stroke-width': Math.max(1, 1.1 * v.vp.scale) }));
        }
      }
    } else if (a.type === 'field') {
      const r = rectU2V(u, a.rect);
      n = sv('g');
      n.append(sv('rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: 'rgba(56,120,200,0.10)', stroke: '#3878c8', 'stroke-width': 1.2, 'stroke-dasharray': a.kind === 'signature' ? '6 3' : '' }));
      const lab = sv('text', { x: r.x + 3, y: r.y - 3, fill: '#2a5fa0', 'font-family': 'Helvetica, Arial, sans-serif', 'font-size': 10, 'pointer-events': 'none' });
      lab.textContent = `${a.name}${a.required ? ' *' : ''}`; n.append(lab);
      if (a.kind === 'checkbox') n.append(sv('path', { d: `M${r.x + r.w * 0.2} ${r.y + r.h * 0.55} L${r.x + r.w * 0.42} ${r.y + r.h * 0.78} L${r.x + r.w * 0.82} ${r.y + r.h * 0.25}`, fill: 'none', stroke: '#3878c8', 'stroke-width': 1.4, 'stroke-opacity': 0.5 }));
      if (a.kind === 'dropdown') n.append(sv('path', { d: `M${r.x + r.w - 12} ${r.y + r.h / 2 - 2} l4 4 l4 -4`, fill: 'none', stroke: '#3878c8', 'stroke-width': 1.4 }));
      if (a.kind === 'signature') { const t = sv('text', { x: r.x + 6, y: r.y + r.h - 6, fill: '#3878c8', 'font-family': 'Helvetica, Arial, sans-serif', 'font-size': Math.min(12, r.h * 0.45), 'pointer-events': 'none' }); t.textContent = 'Sign here'; n.append(t); }
    } else if (a.type === 'redact') {
      const r = rectU2V(u, a.rect);
      n = S.redactPreview
        ? sv('rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: a.fill === 'white' ? '#ffffff' : '#000000' })
        : sv('rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: a.fill === 'white' ? '#ffffff' : '#000000', 'fill-opacity': '0.4',
          stroke: '#d0161c', 'stroke-width': 1.5, 'stroke-dasharray': '5 3' });
    } else if (a.type === 'edit') {
      const r = rectU2V(u, a.rect);
      const [bx, by] = u2v(u, a.origin[0], a.origin[1]);
      const [rx, ry] = u2v(u, a.origin[0] + 10, a.origin[1]);
      const ang = Math.atan2(ry - by, rx - bx) * 180 / Math.PI;
      const css = cssFont(a.font);
      n = sv('g');
      n.append(sv('rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: '#ffffff' }));
      const t = sv('text', { x: bx, y: by, fill: a.color || '#000000', 'font-family': css.family, 'font-weight': css.weight, 'font-style': css.style,
        'font-size': a.size * v.vp.scale, transform: `rotate(${ang} ${bx} ${by})` });
      t.setAttribute('xml:space', 'preserve');
      t.textContent = a.text;
      n.append(t, sv('rect', { class: 'ed-outline', x: r.x - 1, y: r.y - 1, width: r.w + 2, height: r.h + 2, fill: 'none', stroke: '#4a6272', 'stroke-opacity': '0.6', 'stroke-dasharray': '2 2' }));
    } else if (a.type === 'pedit') {
      const z = rectU2V(u, peditZone(a));
      const css = cssFont(a.font);
      n = sv('g');
      n.append(sv('rect', { x: z.x - 1, y: z.y - 1, width: z.w + 2, height: z.h + 2, fill: '#ffffff' }));
      for (const L of a.layout || []) for (const w of L.words) {
        const [tx, ty] = u2v(u, w.x, L.base);
        const t = sv('text', { x: tx, y: ty, fill: a.color || '#000', 'font-family': css.family, 'font-weight': css.weight, 'font-style': css.style, 'font-size': a.size * v.vp.scale });
        t.textContent = w.t; n.append(t);
      }
      n.append(sv('rect', { class: a.extraLines ? 'ed-warn' : 'ed-outline', x: z.x - 2, y: z.y - 2, width: z.w + 4, height: z.h + 4, fill: 'none', stroke: a.extraLines ? '#b3261e' : '#4a6272', 'stroke-opacity': '0.6', 'stroke-dasharray': '3 2' }));
    } else if (a.type === 'note') {
      const [x, y] = u2v(u, a.at[0], a.at[1]);
      const s = Math.max(14, 16 * v.vp.scale);
      n = sv('g', { transform: `translate(${x} ${y})` });
      n.append(sv('path', { d: `M0 0 H${s} V${s * 0.74} H${s * 0.46} L${s * 0.22} ${s} V${s * 0.74} H0 Z`, fill: a.color, stroke: '#7a5d00', 'stroke-width': 1 }),
        sv('path', { d: `M${s * 0.2} ${s * 0.26} H${s * 0.8} M${s * 0.2} ${s * 0.48} H${s * 0.62}`, stroke: '#7a5d00', 'stroke-width': 1.2 }));
      const ttl = sv('title'); ttl.textContent = (a.author ? a.author + ': ' : '') + (a.text || '(empty comment)'); n.append(ttl);
    } else if (a.type === 'stamp') {
      const f = frameToView(u, a);
      const k = f.k;
      n = sv('g', { transform: `translate(${f.x} ${f.y}) rotate(${f.ang})` });
      n.append(sv('rect', { x: 0, y: 0, width: a.w * k, height: a.h * k, rx: 3 * k, fill: 'transparent', stroke: a.color, 'stroke-width': 2 * k }));
      const t1 = sv('text', { x: a.w * k / 2, y: (6 + a.size * 0.78) * k, 'text-anchor': 'middle', fill: a.color, 'font-family': 'Helvetica, Arial, sans-serif', 'font-weight': '700', 'font-size': a.size * k, 'letter-spacing': 0.5 * k });
      t1.textContent = a.label; n.append(t1);
      if (a.sub) { const t2 = sv('text', { x: a.w * k / 2, y: (6 + a.size * 0.78 + 4 * a.size / 16 + (a.subSize || 8) * 0.78) * k, 'text-anchor': 'middle', fill: a.color, 'font-family': 'Helvetica, Arial, sans-serif', 'font-size': (a.subSize || 8) * k }); t2.textContent = a.sub; n.append(t2); }
    }
    if (!n) continue;
    n.setAttribute('data-id', a.id);
    g.append(n);
  }
  // selection outline
  if (S.selAnnot && S.selAnnot.page === u) {
    const a = p.annots.find(x => x.id === S.selAnnot.id);
    if (a) {
      const b = annotBoxView(u, a);
      svg.append(sv('rect', { class: 'sel-box', x: b.x - 3, y: b.y - 3, width: b.w + 6, height: b.h + 6 }));
      if (!['ink', 'markup', 'note', 'edit', 'pedit'].includes(a.type)) svg.append(sv('rect', { class: 'handle', 'data-handle': '1', x: b.x + b.w - 2, y: b.y + b.h - 2, width: 9, height: 9 }));
    }
  }
  // search hits
  if (S.compare) for (const m of (S.compare.marks.get(u) || [])) {
    const r = rectU2V(u, m.rect);
    if (m.kind === 'ins') hits.append(sv('rect', { class: 'cmp-ins', x: r.x - 1.5, y: r.y, width: 3, height: r.h }));
    else hits.append(sv('rect', { class: 'cmp-del', x: r.x, y: r.y, width: r.w, height: r.h }));
  }
  for (const [hi, h] of S.search.hits.entries()) {
    if (h.page !== u) continue;
    const r = rectU2V(u, h.rect);
    hits.append(sv('rect', { class: 'hit' + (hi === S.search.cur ? ' current' : ''), x: r.x, y: r.y, width: r.w, height: r.h }));
  }
  drawPreviewMarks(u);
}

let measureCtx = null;
function textWidthPt(a) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = `${a.size}px Helvetica, Arial, sans-serif`;
  return Math.max(20, ...(a.text || ' ').split('\n').map(l => measureCtx.measureText(l).width));
}
function annotBoxView(u, a) {
  if (a.type === 'pedit') return rectU2V(u, peditZone(a));
  if (a.rect) return rectU2V(u, a.rect);
  if (a.type === 'markup') {
    const bs = a.rects.map(r => rectU2V(u, r));
    const x0 = Math.min(...bs.map(b => b.x)), y0 = Math.min(...bs.map(b => b.y));
    return { x: x0, y: y0, w: Math.max(...bs.map(b => b.x + b.w)) - x0, h: Math.max(...bs.map(b => b.y + b.h)) - y0 };
  }
  if (a.type === 'note') { const [x, y] = u2v(u, a.at[0], a.at[1]); const s = Math.max(14, 16 * views.get(u).vp.scale); return { x, y, w: s, h: s }; }
  if (a.type === 'ink') {
    const vs = a.points.map(pt => u2v(u, pt[0], pt[1]));
    const xs = vs.map(q => q[0]), ys = vs.map(q => q[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  // framed (text, image): bounding box of the rotated frame
  const w = a.type === 'text' ? textWidthPt(a) : a.w;
  const h = a.type === 'text' ? (a.text || '').split('\n').length * a.size * 1.2 : a.h;
  const corners = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => u2v(u,
    a.anchor[0] + a.ux[0] * x + a.dx[0] * y, a.anchor[1] + a.ux[1] * x + a.dx[1] * y));
  const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

// watermark and page number previews (not interactive)
function drawPreviewMarks(u) {
  const v = views.get(u); const idx = S.pages.findIndex(p => p.uid === u);
  const { watermark: wm, numbers: nb } = S.settings;
  const W = v.vp.width, H = v.vp.height, k = v.vp.scale;
  if (wm.on && wm.text) {
    const t = sv('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', 'dominant-baseline': 'middle', fill: '#808080', 'fill-opacity': wm.opacity,
      'font-family': 'Helvetica, Arial, sans-serif', 'font-weight': 'bold', 'font-size': wm.size * k, transform: `rotate(-45 ${W / 2} ${H / 2})`, 'pointer-events': 'none' });
    t.textContent = wm.text; v.svg.append(t);
  }
  for (const st of stampTexts(S.pages, idx, S.settings.bates.start | 0)) {
    const size = S.settings.hf.size || 9;
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = `${size}px Helvetica, Arial, sans-serif`;
    const tw = measureCtx.measureText(st.text).width;
    const [px, py] = slotPos(st.slot, tw, W / k, H / k, size);
    const t = sv('text', { x: px * k, y: py * k, fill: '#1a1a1a', 'font-family': 'Helvetica, Arial, sans-serif', 'font-size': size * k, 'pointer-events': 'none' });
    t.textContent = st.text; v.svg.append(t);
  }
  if (nb.on) {
    const txt = nb.format.replace('{n}', idx + 1).replace('{N}', S.pages.length);
    const right = nb.pos === 'bottom-right';
    const t = sv('text', { x: right ? W - 36 * k : W / 2, y: H - 24 * k, 'text-anchor': right ? 'end' : 'middle', fill: '#333',
      'font-family': 'Helvetica, Arial, sans-serif', 'font-size': nb.size * k, 'pointer-events': 'none' });
    t.textContent = txt; v.svg.append(t);
  }
}

// ---------------------------------------------------------------- annotations: interaction
function setTool(t) {
  if (t === 'sign') { openSignDialog(); return; }
  S.tool = t; S.pendingSig = null;
  if (t !== 'select' && S.selAnnot) { const u = S.selAnnot.page; S.selAnnot = null; drawAnnots(u); }
  $$('#tools .btn').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
  applyToolCursor();
  renderInspector();
}
function applyToolCursor() {
  for (const v of views.values()) {
    v.div.classList.toggle('tool-create', ['highlight', 'ink', 'rect', 'whiteout', 'redact', 'note', 'stamp', 'field'].includes(S.tool) || !!S.pendingSig);
    v.div.classList.toggle('tool-text', S.tool === 'text' || S.tool === 'edit');
    v.layer.style.pointerEvents = 'none';
  }
}

function pointIn(u, e) {
  const r = views.get(u).div.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function bindPagePointer(u) {
  const v = views.get(u);
  const div = v.div;
  div.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    if (e.target.closest('.fld') || e.target.closest('.tedit') || e.target.closest('.eedit') || e.target.closest('.pedit-box')) return;
    const open = document.querySelector('.tedit, .eedit, .pedit-box');
    if (open) { e.preventDefault(); open.blur(); return; }
    const p = pageOf(u);
    const [x, y] = pointIn(u, e);
    if (S.pendingSig) { placeSignature(u, x, y); e.preventDefault(); return; }
    const annEl = e.target.closest('[data-id]');
    if (S.tool === 'edit') {
      e.preventDefault();
      const ex = annEl && p.annots.find(z => z.id === annEl.getAttribute('data-id') && (z.type === 'edit' || z.type === 'pedit'));
      if (ex && ex.type === 'edit') return openEditEditor(u, ex, false, x);
      return dragEditBox(u, x, y, e);
    }
    const handle = e.target.closest('[data-handle]');
    if (S.tool === 'select' || handle || (annEl && S.tool !== 'ink')) {
      if (handle && S.selAnnot) return startResize(u, e);
      if (annEl) {
        const id = annEl.getAttribute('data-id');
        S.selAnnot = { page: u, id };
        for (const w of views.keys()) drawAnnots(w);
        renderInspector();
        return startMove(u, id, e);
      }
      if (S.selAnnot) { const prev = S.selAnnot.page; S.selAnnot = null; drawAnnots(prev); renderInspector(); }
      return;
    }
    if (S.tool === 'text') { e.preventDefault(); return createText(u, x, y); }
    if (S.tool === 'note') { e.preventDefault(); return createNote(u, x, y); }
    if (S.tool === 'stamp') { e.preventDefault(); return placeStamp(u, x, y); }
    if (S.tool === 'highlight') return dragMarkup(u, x, y, e);
    if (S.tool === 'field' && S.style.fieldKind === 'checkbox') { e.preventDefault(); return clickCheckbox(u, x, y); }
    if (['rect', 'whiteout', 'redact', 'field'].includes(S.tool)) return dragRect(u, x, y, e);
    if (S.tool === 'ink') return dragInk(u, x, y, e);
  });
  div.addEventListener('dblclick', e => {
    const annEl = e.target.closest('[data-id]');
    if (!annEl) return;
    const p = pageOf(u); const a = p.annots.find(z => z.id === annEl.getAttribute('data-id'));
    if (a && a.type === 'text') editText(u, a);
    if (a && a.type === 'edit') openEditEditor(u, a, false);
    if (a && a.type === 'pedit') openParaEditor(u, a, false);
    if (a && a.type === 'note') { S.selAnnot = { page: u, id: a.id }; renderInspector(); setTimeout(() => $('#noteText')?.focus(), 0); }
  });
}

function capture(e, onMove, onUp) {
  const target = e.currentTarget || e.target;
  try { target.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  const mv = ev => onMove(ev);
  const up = ev => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); onUp(ev); };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', up);
}

function dragRect(u, x0, y0, e) {
  const v = views.get(u);
  const tool = S.tool;
  const ghost = sv('rect', { x: x0, y: y0, width: 0, height: 0,
    fill: tool === 'highlight' ? S.style.highlight : tool === 'whiteout' ? '#fff' : tool === 'redact' ? '#000' : 'none',
    'fill-opacity': tool === 'highlight' ? 0.4 : tool === 'redact' ? 0.45 : 1,
    stroke: tool === 'whiteout' ? '#999' : tool === 'rect' ? S.style.pen : tool === 'redact' ? '#d0161c' : tool === 'field' ? '#3878c8' : 'none',
    'stroke-dasharray': tool === 'whiteout' || tool === 'redact' || tool === 'field' ? '4 3' : '' });
  v.svg.append(ghost);
  let x1 = x0, y1 = y0;
  capture(e, ev => {
    [x1, y1] = pointIn(u, ev);
    ghost.setAttribute('x', Math.min(x0, x1)); ghost.setAttribute('y', Math.min(y0, y1));
    ghost.setAttribute('width', Math.abs(x1 - x0)); ghost.setAttribute('height', Math.abs(y1 - y0));
  }, () => {
    ghost.remove();
    if (Math.abs(x1 - x0) < 4 || Math.abs(y1 - y0) < 4) return;
    snapshot();
    const a = { id: uid(), type: tool, rect: rectV2U(u, Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)) };
    if (tool === 'field') { Object.assign(a, newField(S.style.fieldKind)); pageOf(u).annots.push(a); S.selAnnot = { page: u, id: a.id }; drawAnnots(u); renderInspector(); return; }
    if (tool === 'highlight') a.color = S.style.highlight;
    if (tool === 'redact') { a.fill = S.style.redactFill; renderInspector(); }
    if (tool === 'rect') { a.color = S.style.pen; a.width = S.style.penWidth; }
    pageOf(u).annots.push(a);
    drawAnnots(u);
    if (tool === 'redact') renderInspector();
  });
}

// Highlight, underline or strike through text, snapping to the lines under the drag.
function dragMarkup(u, x0, y0, e) {
  const v = views.get(u);
  const ghost = sv('rect', { x: x0, y: y0, width: 0, height: 0, fill: S.style.highlight, 'fill-opacity': 0.2, stroke: '#888', 'stroke-dasharray': '3 3' });
  v.svg.append(ghost);
  let x1 = x0, y1 = y0;
  capture(e, ev => {
    [x1, y1] = pointIn(u, ev);
    ghost.setAttribute('x', Math.min(x0, x1)); ghost.setAttribute('y', Math.min(y0, y1));
    ghost.setAttribute('width', Math.abs(x1 - x0)); ghost.setAttribute('height', Math.abs(y1 - y0));
  }, async () => {
    ghost.remove();
    if (Math.abs(x1 - x0) < 3 && Math.abs(y1 - y0) < 3) return;
    const p = pageOf(u);
    const pA = v2u(u, x0, y0), pB = v2u(u, x1, y1);
    const rects = snapRects(await pageText(p), pA, pB);
    const kind = S.style.markKind;
    if (rects.length) {
      snapshot();
      p.annots.push({ id: uid(), type: 'markup', kind, rects, color: kind === 'highlight' ? S.style.highlight : S.style.markLine || '#c4161c' });
    } else if (kind === 'highlight' && Math.abs(x1 - x0) > 4 && Math.abs(y1 - y0) > 4) {
      // no selectable text here (a scan, say): highlight the area instead
      snapshot();
      p.annots.push({ id: uid(), type: 'highlight', color: S.style.highlight, rect: rectV2U(u, Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)) });
    } else { toast('There is no text there to mark.'); return; }
    drawAnnots(u);
  });
}

// ---- edit existing text
async function fontNameOf(p, it) {
  try {
    const pg = await getPdfPage(p);
    if (pg.commonObjs.has(it.fontName)) { const f = pg.commonObjs.get(it.fontName); return f.name || f.loadedName || ''; }
  } catch { /* unknown font */ }
  return '';
}
async function startEditText(u, x, y) {
  const p = pageOf(u);
  const [ux, uy] = v2u(u, x, y);
  const items = await pageText(p);
  const hit = itemAt(items, ux, uy);
  if (!hit) { toast('Click directly on a line of text to edit it. Scanned pages have no editable text.'); return; }
  const key = `${p.src}:${p.idx}:${hit.index}`;
  const existing = p.annots.find(a => a.type === 'edit' && a.itemKey === key);
  if (existing) return openEditEditor(u, existing, false, x);
  const pe = p.annots.find(a => a.type === 'pedit' && ux >= a.rect[0] && ux <= a.rect[2] && uy >= a.rect[1] && uy <= a.rect[3]);
  if (pe) { const c = peditOffsetAt(pe, ux, uy); return openParaEditor(u, pe, false, [c, c]); }
  const same = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const g2 = itemGeom(it); if (!g2) continue;
    if (Math.abs(g2.base - hit.g.base) < hit.g.size * 0.35) same.push(g2);
  }
  if (same.length > 1) {
    same.sort((a, b) => a.x0 - b.x0);
    // keep only the run of pieces that touches the clicked one
    let i0 = same.findIndex(g2 => g2.x0 === hit.g.x0 && g2.x1 === hit.g.x1), i1 = i0;
    if (i0 >= 0) {
      // only word-by-word text (as recognition produces) is joined; a wider gap, such as after a label, ends the line
      const gap = hit.g.size * 0.6;
      while (i0 > 0 && same[i0].x0 - same[i0 - 1].x1 < gap) i0--;
      while (i1 < same.length - 1 && same[i1 + 1].x0 - same[i1].x1 < gap) i1++;
      if (i1 > i0) {
        const run = same.slice(i0, i1 + 1);
        const R = [run[0].x0 - 0.5, Math.min(...run.map(g2 => g2.y0)) + 0.1, run.at(-1).x1 + 0.5, Math.max(...run.map(g2 => g2.y1)) - 0.1];
        return startParagraphEdit(u, R, ux);
      }
    }
  }
  const fontName = await fontNameOf(p, hit.it);
  const g = hit.g;
  const draft = { id: uid(), type: 'edit', itemKey: key, rect: [g.x0 - 0.6, g.y0 - 0.2, g.x1 + 0.6, g.y1 + 0.2], origin: [g.x0, g.base], size: g.size,
    font: stdFontFor(fontName, hit.it.style && hit.it.style.fontFamily), fontName, text: hit.it.str.replace(/\s+$/, ''), orig: hit.it.str.replace(/\s+$/, ''), color: '#000000' };
  openEditEditor(u, draft, true, x);
}
function openEditEditor(u, a, isNew, clickX = null) {
  const v = views.get(u);
  const r = rectU2V(u, a.rect);
  const [bx, by] = u2v(u, a.origin[0], a.origin[1]);
  const [rx, ry] = u2v(u, a.origin[0] + 10, a.origin[1]);
  const ang = Math.atan2(ry - by, rx - bx) * 180 / Math.PI;
  const css = cssFont(a.font);
  const fontPx = a.size * v.vp.scale;
  const inp = el('input', { class: 'eedit', type: 'text', spellcheck: 'true', 'aria-label': 'Edit text' });
  inp.value = a.text;
  Object.assign(inp.style, { left: (bx - 3) + 'px', top: (by - fontPx * 0.98) + 'px', height: (fontPx * 1.3) + 'px', fontSize: fontPx + 'px',
    fontFamily: css.family, fontWeight: css.weight, fontStyle: css.style, transform: `rotate(${ang}deg)`, transformOrigin: `3px ${fontPx * 0.98}px` });
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  const fit = () => { measureCtx.font = `${css.style} ${css.weight} ${fontPx}px ${css.family}`; inp.style.width = (Math.max(r.w, measureCtx.measureText(inp.value).width) + 30) + 'px'; };
  fit(); inp.addEventListener('input', fit);
  let cancelled = false;
  const finish = () => {
    inp.remove();
    const val = inp.value.replace(/\s+$/, '');
    if (!cancelled && val !== a.text) {
      snapshot();
      const p = pageOf(u);
      if (isNew) { a.text = val; p.annots.push(a); } else a.text = val;
      if (!isNew && val === a.orig) p.annots = p.annots.filter(z => z.id !== a.id); // back to the original wording
      S.selAnnot = null;
    }
    drawAnnots(u); renderInspector();
  };
  inp.addEventListener('keydown', ev => {
    ev.stopPropagation();
    if (ev.key === 'Enter') { ev.preventDefault(); inp.blur(); }
    if (ev.key === 'Escape') { cancelled = true; inp.blur(); }
  });
  inp.addEventListener('blur', finish, { once: true });
  v.layer.append(inp);
  const g = v.svg.querySelector(`[data-id="${a.id}"]`); if (g) g.style.display = 'none';
  inp.focus();
  // put the cursor where the click was, so a word can be changed or added without retyping the line
  let caret = inp.value.length;
  if (clickX != null) {
    measureCtx.font = `${css.style} ${css.weight} ${fontPx}px ${css.family}`;
    let best = Infinity;
    for (let i = 0; i <= inp.value.length; i++) {
      const d = Math.abs(bx + measureCtx.measureText(inp.value.slice(0, i)).width - clickX);
      if (d < best) { best = d; caret = i; }
    }
  }
  inp.setSelectionRange(caret, caret);
}

// ---- edit a paragraph: drag a box round the text
function dragEditBox(u, x0, y0, e) {
  const v = views.get(u);
  const ghost = sv('rect', { x: x0, y: y0, width: 0, height: 0, fill: 'rgba(74,98,114,0.08)', stroke: '#4a6272', 'stroke-dasharray': '4 3' });
  v.svg.append(ghost);
  let x1 = x0, y1 = y0;
  capture(e, ev => {
    [x1, y1] = pointIn(u, ev);
    ghost.setAttribute('x', Math.min(x0, x1)); ghost.setAttribute('y', Math.min(y0, y1));
    ghost.setAttribute('width', Math.abs(x1 - x0)); ghost.setAttribute('height', Math.abs(y1 - y0));
  }, () => {
    ghost.remove();
    if (Math.abs(x1 - x0) < 6 && Math.abs(y1 - y0) < 6) return startEditText(u, x0, y0);
    startParagraphEdit(u, rectV2U(u, Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)));
  });
}
let metricDoc = null;
const metricFonts = {};
async function metricFont(key) {
  if (!metricFonts[key]) { if (!metricDoc) metricDoc = await PDFDocument.create(); metricFonts[key] = await metricDoc.embedFont(StandardFonts[key]); }
  return metricFonts[key];
}
async function startParagraphEdit(u, R, clickX = null) {
  const p = pageOf(u);
  const items = await pageText(p);
  const sel = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const g = itemGeom(it); if (!g) continue;
    const cx = (g.x0 + g.x1) / 2, cy = (g.y0 + g.y1) / 2;
    // a run belongs to the box if its middle is inside, or if most of it is
    if ((cx >= R[0] && cx <= R[2] && cy >= R[1] && cy <= R[3]) || (overlapArea([g.x0, g.y0, g.x1, g.y1], R) > 0.6 * (g.x1 - g.x0) * (g.y1 - g.y0))) sel.push({ it, g });
  }
  const prior = p.annots.filter(a => a.type === 'pedit' && overlapArea(peditZone(a), R) > 0);
  if (prior.length === 1) { const rg = peditRangeIn(prior[0], R); return openParaEditor(u, prior[0], false, rg || [prior[0].text.length, prior[0].text.length]); }
  if (!sel.length) { toast('There is no text inside that box. Scanned pages need Recognise text first.'); return; }
  if (p.annots.some(a => (a.type === 'edit' || a.type === 'pedit') && overlapArea(a.type === 'pedit' ? peditZone(a) : a.rect, R) > 0)) { toast('Part of that area has already been edited. Select the earlier edit and restore it first.'); return; }
  sel.sort((a, b) => b.g.base - a.g.base || a.g.x0 - b.g.x0);
  const lines = [];
  for (const o of sel) {
    const L = lines.find(l => Math.abs(l.base - o.g.base) < o.g.size * 0.5);
    if (L) L.runs.push(o); else lines.push({ base: o.g.base, runs: [o] });
  }
  for (const L of lines) {
    L.runs.sort((a, b) => a.g.x0 - b.g.x0);
    let t = '';
    L.runs.forEach((o, i) => {
      if (i) { const prev = L.runs[i - 1]; if (o.g.x0 - prev.g.x1 > o.g.size * 0.15 && !/\s$/.test(t) && !/^\s/.test(o.it.str)) t += ' '; }
      t += o.it.str;
    });
    L.text = t.replace(/\s+/g, ' ').trim();
    L.x0 = Math.min(...L.runs.map(o => o.g.x0)); L.x1 = Math.max(...L.runs.map(o => o.g.x1));
    L.y0 = Math.min(...L.runs.map(o => o.g.y0)); L.y1 = Math.max(...L.runs.map(o => o.g.y1));
  }
  lines.sort((a, b) => b.base - a.base);
  const gaps = lines.slice(1).map((L, i) => lines[i].base - L.base).sort((a, b) => a - b);
  const sizes = sel.map(o => o.g.size).sort((a, b) => a - b);
  const size = sizes[Math.floor(sizes.length / 2)];
  const pitch = gaps.length ? gaps[Math.floor(gaps.length / 2)] : size * 1.2;
  const counts = new Map(); for (const o of sel) counts.set(o.it.fontName, (counts.get(o.it.fontName) || 0) + o.it.str.length);
  const mainFont = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  const sample = sel.find(o => o.it.fontName === mainFont).it;
  const fontName = await fontNameOf(p, sample);
  const right = Math.max(...lines.map(L => L.x1));
  const nonLast = lines.slice(0, -1).map(L => L.x1);
  const align = nonLast.length >= 2 && Math.max(...nonLast) - Math.min(...nonLast) < 1.6 ? 'both' : 'left';
  let text = '';
  lines.forEach((L, i) => { if (i) text += (/[-‐]$/.test(text) && /^[a-z]/.test(L.text)) ? '' : ' '; text += L.text; });
  const lineRects = lines.map(L => [L.x0 - 0.6, L.y0 - 0.3, L.x1 + 0.6, L.y1 + 0.3]);
  const a = {
    id: uid(), type: 'pedit', lineRects,
    rect: [Math.min(...lineRects.map(r => r[0])), Math.min(...lineRects.map(r => r[1])), Math.max(...lineRects.map(r => r[2])), Math.max(...lineRects.map(r => r[3]))],
    x0: lines[0].x0, contX: lines.length > 1 ? Math.min(...lines.slice(1).map(L => L.x0)) : lines[0].x0, right,
    firstBase: lines[0].base, pitch, size, font: stdFontFor(fontName, sample.style && sample.style.fontFamily), fontName,
    color: '#000000', text, orig: text, origLines: lines.length, align, mixed: counts.size > 1,
  };
  let range = null;
  if (clickX != null && lines.length === 1) {
    // cursor where the click was: find the piece under it and the matching place in the text
    const runs = lines[0].runs; let pos = 0, caret = text.length, bd = Infinity;
    for (const o of runs) {
      const str = o.it.str.replace(/\s+/g, ' ').trim(); if (!str) continue;
      const at = text.indexOf(str, pos); if (at < 0) continue; pos = at + str.length;
      const d = clickX < o.g.x0 ? o.g.x0 - clickX : clickX > o.g.x1 ? clickX - o.g.x1 : 0;
      if (d < bd) { bd = d; caret = at + Math.round(Math.max(0, Math.min(1, (clickX - o.g.x0) / ((o.g.x1 - o.g.x0) || 1))) * str.length); }
    }
    range = [caret, caret];
  }
  openParaEditor(u, a, true, range);
}
async function layoutPedit(a) {
  const font = await metricFont(stdFontKey(a.font));
  const sp = font.widthOfTextAtSize(' ', a.size);
  const out = [];
  let base = a.firstBase;
  for (const para of a.text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { base -= a.pitch; continue; }
    let line = [], lineW = 0, first = true;
    const start = () => (first ? a.x0 : a.contX);
    const flush = last => { out.push({ x: start(), base, words: line, last }); base -= a.pitch; first = false; line = []; lineW = 0; };
    for (const w of words) {
      const ww = font.widthOfTextAtSize(sanitizeFor(font, w), a.size);
      if (line.length && a.origLines > 1 && lineW + sp + ww > a.right - start() + 0.01) flush(false);
      line.push({ t: w, w: ww }); lineW += (line.length > 1 ? sp : 0) + ww;
    }
    if (line.length) flush(true);
  }
  let pos = 0;
  for (const L of out) for (const w of L.words) { const i = a.text.indexOf(w.t, pos); w.o = i < 0 ? pos : i; pos = w.o + w.t.length; }
  for (const L of out) {
    const total = L.words.reduce((n, w) => n + w.w, 0), gaps = L.words.length - 1;
    const gap = a.align === 'both' && !L.last && gaps > 0 ? Math.max(sp, (a.right - L.x - total) / gaps) : sp;
    let x = L.x; for (const w of L.words) { w.x = x; x += w.w + gap; }
  }
  a.layout = out;
  a.extraLines = Math.max(0, out.length - a.origLines);
  a.layoutRight = Math.max(0, ...out.map(L => L.words.length ? L.words.at(-1).x + L.words.at(-1).w : 0));
}
// character position in a.text nearest a point on the page
function peditOffsetAt(a, ux, uy) {
  const lines = a.layout || [];
  if (!lines.length) return a.text.length;
  const L = lines.reduce((b, l) => Math.abs(uy - (l.base + a.size * 0.3)) < Math.abs(uy - (b.base + a.size * 0.3)) ? l : b);
  if (!L.words.length) return a.text.length;
  let best = L.words[0], bd = Infinity;
  for (const w of L.words) { const d = ux < w.x ? w.x - ux : ux > w.x + w.w ? ux - w.x - w.w : 0; if (d < bd) { bd = d; best = w; } }
  const f = Math.max(0, Math.min(1, (ux - best.x) / (best.w || 1)));
  return best.o + Math.round(f * best.t.length);
}
function peditRangeIn(a, R) {
  let lo = Infinity, hi = -1;
  for (const L of a.layout || []) for (const w of L.words) {
    const cx = w.x + w.w / 2, cy = L.base + a.size * 0.3;
    if (cx >= R[0] && cx <= R[2] && cy >= R[1] && cy <= R[3]) { lo = Math.min(lo, w.o); hi = Math.max(hi, w.o + w.t.length); }
  }
  return hi < 0 ? null : [lo, hi];
}
function peditZone(a) { return [Math.min(a.x0, a.contX) - 1, a.rect[1] - (a.extraLines || 0) * a.pitch, Math.max(a.rect[2], a.right, a.layoutRight || 0) + 1, a.rect[3]]; }
function openParaEditor(u, a, isNew, range = null) {
  const v = views.get(u);
  const k = v.vp.scale;
  const left = Math.min(a.x0, a.contX);
  const box = rectU2V(u, [left - 2, a.rect[1] - 2, a.right + 2, a.rect[3] + 2]);
  const css = cssFont(a.font);
  const ta = el('textarea', { class: 'pedit-box', spellcheck: 'true', 'aria-label': 'Edit paragraph' });
  ta.value = a.text;
  Object.assign(ta.style, { left: box.x + 'px', top: box.y + 'px', width: box.w + 'px', fontSize: (a.size * k) + 'px', lineHeight: (a.pitch * k) + 'px',
    fontFamily: css.family, fontWeight: css.weight, fontStyle: css.style, textIndent: ((a.x0 - left) * k) + 'px', textAlign: a.align === 'both' ? 'justify' : 'left' });
  const hint = el('div', { class: 'pedit-hint', text: 'Edit freely. Ctrl+Enter or click outside to finish; Esc to cancel. Enter starts a new paragraph.' });
  Object.assign(hint.style, { left: box.x + 'px', top: Math.max(0, box.y - 26) + 'px' });
  const fit = () => { ta.style.height = 'auto'; ta.style.height = Math.max(box.h, ta.scrollHeight) + 'px'; };
  let cancelled = false, done = false;
  const finish = async () => {
    if (done) return; done = true;
    ta.remove(); hint.remove();
    const val = ta.value.replace(/[ \t]+\n/g, '\n').replace(/\s+$/, '');
    const p = pageOf(u);
    if (!cancelled && val !== a.text) {
      snapshot();
      if (!isNew && val === a.orig) p.annots = p.annots.filter(z => z.id !== a.id);
      else { a.text = val; await layoutPedit(a); if (isNew) p.annots.push(a); }
      S.selAnnot = null;
    }
    drawAnnots(u); renderInspector();
  };
  ta.addEventListener('input', fit);
  ta.addEventListener('keydown', ev => {
    ev.stopPropagation();
    if (ev.key === 'Escape') { cancelled = true; finish(); }
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); finish(); }
  });
  ta.addEventListener('blur', () => finish());
  ta.addEventListener('pointerdown', ev => ev.stopPropagation());
  v.layer.append(hint, ta);
  const g = v.svg.querySelector(`[data-id="${a.id}"]`); if (g) g.style.display = 'none';
  fit();
  ta.focus();
  const [s0, s1] = range || [ta.value.length, ta.value.length];
  ta.setSelectionRange(s0, s1);
}

// ---- comments
function createNote(u, x, y) {
  const at = v2u(u, x, y);
  const a = { id: uid(), type: 'note', at, text: '', color: S.style.noteColor, author: S.author };
  snapshot();
  pageOf(u).annots.push(a);
  S.selAnnot = { page: u, id: a.id };
  setTool('select');
  drawAnnots(u);
  setTimeout(() => $('#noteText')?.focus(), 0);
}

// ---- form fields
const FIELD_KINDS = { text: 'Text', paragraph: 'Paragraph', checkbox: 'Checkbox', dropdown: 'Dropdown', signature: 'Signature' };
function allFieldNames() {
  const names = new Set();
  for (const s of S.sources) for (const f of s.fields || []) names.add(f.name);
  for (const p of S.pages) for (const a of p.annots) if (a.type === 'field') names.add(a.name);
  return names;
}
function uniqueFieldName(base) {
  const names = allFieldNames();
  base = (base || 'Field').replace(/[.\[\]]/g, ' ').replace(/\s+/g, ' ').trim() || 'Field';
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}
function newField(kind, name) {
  return { kind, name: uniqueFieldName(name || FIELD_KINDS[kind] + ' 1'), required: false, options: kind === 'dropdown' ? ['Option 1', 'Option 2'] : [] };
}
function clickCheckbox(u, x, y) {
  const k = views.get(u).vp.scale, s = 12 * k;
  snapshot();
  const a = { id: uid(), type: 'field', rect: rectV2U(u, x - s / 2, y - s / 2, s, s), ...newField('checkbox') };
  pageOf(u).annots.push(a); S.selAnnot = { page: u, id: a.id }; drawAnnots(u); renderInspector();
}
async function detectFields() {
  let added = 0;
  snapshot();
  for (const p of S.pages) {
    const items = await pageText(p);
    for (const it of items) {
      const s = it.str; if (!s) continue;
      const g = itemGeom(it); if (!g) continue;
      const re = /_{5,}|\.{6,}|\u2026{3,}/g;
      let m;
      while ((m = re.exec(s))) {
        const x0 = xAt(it, m.index), x1 = xAt(it, m.index + m[0].length);
        if (x1 - x0 < 30) continue;
        const rect = [x0, g.base - 2, x1, g.base + Math.max(12, g.size * 1.25)];
        if (p.annots.some(a => a.type === 'field' && overlapArea(a.rect, rect) > 0)) continue;
        // label: the words just before the line, on the same text run or the run to its left
        let before = s.slice(0, m.index);
        if (!before.trim()) {
          const left = items.filter(o => o !== it && o.str && o.str.trim() && Math.abs(o.transform[5] - g.base) < g.size * 0.5 && o.transform[4] + o.width <= x0 + 1)
            .sort((a, b) => (b.transform[4] + b.width) - (a.transform[4] + a.width))[0];
          before = left ? left.str : '';
        }
        const label = (before.replace(/[_.\u2026:]+\s*$/, '').trim().split(/\s{2,}|\t/).pop() || '').replace(/[:\s]+$/, '').slice(-40);
        const kind = /sign/i.test(label) ? 'signature' : 'text';
        if (kind === 'signature') rect[3] = g.base + Math.max(24, g.size * 2.2);
        p.annots.push({ id: uid(), type: 'field', rect, ...newField(kind, label || (kind === 'signature' ? 'Signature' : 'Text')) });
        added++;
      }
    }
  }
  if (!added) S.history.pop();
  refreshAllAnnots(); renderInspector();
  toast(added ? `Added ${added} field${added === 1 ? '' : 's'} on dotted or underlined lines. Check the names on the right.` : 'No dotted or underlined lines found.');
}
function fieldPanel() {
  return el('section', { class: 'sec' }, el('h3', { text: 'Form field' }),
    el('div', { class: 'row' }, seg(Object.entries(FIELD_KINDS), S.style.fieldKind, v => { S.style.fieldKind = v; renderInspector(); }, 'Field type')),
    el('p', { text: S.style.fieldKind === 'checkbox' ? 'Click where the tick box should go.' : 'Drag out the area the field should fill.' }),
    el('div', { class: 'row' }, el('button', { class: 'btn outline', text: 'Detect fields', onclick: detectFields }),
      el('span', { class: 'note', text: 'Finds dotted and underlined lines such as \u201cSigned: ......\u201d.' })));
}

// ---- stamps
const STAMPS = {
  APPROVED: '#1f7a3a', PAID: '#1f4fd1', RECEIVED: '#5a3fb0', DRAFT: '#5f6870', CONFIDENTIAL: '#b3261e', COPY: '#5f6870', 'NOT APPROVED': '#b3261e', 'FOR INFORMATION': '#1d5866',
};
function stampSize(label, sub, size = 16) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = `700 ${size}px Helvetica, Arial, sans-serif`;
  const w1 = measureCtx.measureText(label).width + label.length * 0.5;
  measureCtx.font = `400 8px Helvetica, Arial, sans-serif`;
  const w2 = sub ? measureCtx.measureText(sub).width : 0;
  return { w: Math.max(w1, w2) + 16, h: 6 + size * 0.78 + (sub ? 4 + 8 * 0.78 : 0) + 7 };
}
function placeStamp(u, x, y) {
  const label = S.style.stamp;
  const dated = ['PAID', 'RECEIVED', 'APPROVED'].includes(label);
  const sub = dated ? new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + (S.author ? ' \u00b7 ' + S.author : '') : '';
  const { w, h } = stampSize(label, sub);
  const k = views.get(u).vp.scale;
  const f = frameAt(u, x - (w * k) / 2, y - (h * k) / 2);
  const a = { id: uid(), type: 'stamp', label, sub, color: STAMPS[label] || '#5f6870', size: 16, subSize: 8, w, h, ...f };
  snapshot();
  pageOf(u).annots.push(a);
  S.selAnnot = { page: u, id: a.id };
  setTool('select');
  drawAnnots(u);
}

function dragInk(u, x0, y0, e) {
  const v = views.get(u);
  const pts = [[x0, y0]];
  const line = sv('polyline', { points: `${x0},${y0}`, fill: 'none', stroke: S.style.pen, 'stroke-width': S.style.penWidth * v.vp.scale, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  v.svg.append(line);
  capture(e, ev => {
    const pt = pointIn(u, ev); const last = pts[pts.length - 1];
    if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) < 1.5) return;
    pts.push(pt); line.setAttribute('points', pts.map(q => q.join(',')).join(' '));
  }, () => {
    line.remove();
    if (pts.length < 2) return;
    snapshot();
    pageOf(u).annots.push({ id: uid(), type: 'ink', color: S.style.pen, width: S.style.penWidth, points: pts.map(q => v2u(u, q[0], q[1])) });
    drawAnnots(u);
  });
}

function shiftAnnot(a, du) {
  const [dx, dy] = du;
  if (a.rect) a.rect = [a.rect[0] + dx, a.rect[1] + dy, a.rect[2] + dx, a.rect[3] + dy];
  if (a.points) a.points = a.points.map(q => [q[0] + dx, q[1] + dy]);
  if (a.anchor) a.anchor = [a.anchor[0] + dx, a.anchor[1] + dy];
  if (a.rects) a.rects = a.rects.map(r => [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]);
  if (a.at) a.at = [a.at[0] + dx, a.at[1] + dy];
}
function startMove(u, id, e) {
  const a = pageOf(u).annots.find(z => z.id === id);
  if (!a || a.type === 'edit' || a.type === 'pedit' || a.type === 'markup') return; // these stay attached to their text
  const [sx, sy] = pointIn(u, e);
  const orig = clone(a);
  let moved = false;
  capture(e, ev => {
    const [x, y] = pointIn(u, ev);
    if (!moved && Math.hypot(x - sx, y - sy) < 3) return;
    if (!moved) { snapshot(); moved = true; }
    const p0 = v2u(u, sx, sy), p1 = v2u(u, x, y);
    Object.assign(a, clone(orig)); shiftAnnot(a, [p1[0] - p0[0], p1[1] - p0[1]]);
    drawAnnots(u);
  }, () => {});
}
function startResize(u, e) {
  const p = pageOf(u); const a = p.annots.find(z => z.id === S.selAnnot.id);
  if (!a) return;
  snapshot();
  const orig = clone(a);
  const box0 = annotBoxView(u, orig);
  capture(e, ev => {
    const [x, y] = pointIn(u, ev);
    const nw = Math.max(8, x - box0.x), nh = Math.max(8, y - box0.y);
    if (a.rect) a.rect = rectV2U(u, box0.x, box0.y, nw, nh);
    else if (a.type === 'image') { const s = Math.max(nw / box0.w, 0.05); a.w = orig.w * s; a.h = orig.h * s; }
    else if (a.type === 'stamp') { const s = Math.max(nw / box0.w, 0.3); a.w = orig.w * s; a.h = orig.h * s; a.size = orig.size * s; a.subSize = (orig.subSize || 8) * s; }
    else if (a.type === 'text') { const s = Math.max(nw / box0.w, 0.2); a.size = Math.max(4, Math.min(96, orig.size * s)); }
    drawAnnots(u);
  }, () => renderInspector());
}

function createText(u, x, y) {
  const f = frameAt(u, x, y - S.style.textSize * views.get(u).vp.scale * 0.5);
  const a = { id: uid(), type: 'text', text: '', size: S.style.textSize, color: S.style.textColor, ...f };
  snapshot();
  pageOf(u).annots.push(a);
  editText(u, a, true);
}
function editText(u, a, isNew = false) {
  const v = views.get(u);
  const f = frameToView(u, a);
  const ta = el('textarea', { class: 'tedit', spellcheck: 'true', 'aria-label': 'Text box' });
  ta.value = a.text;
  const fontPx = a.size * f.k;
  Object.assign(ta.style, { left: f.x + 'px', top: f.y + 'px', fontSize: fontPx + 'px', fontFamily: 'Helvetica, Arial, sans-serif', color: a.color,
    transform: `rotate(${f.ang}deg)` });
  const fit = () => {
    const lines = ta.value.split('\n');
    ta.rows = Math.max(1, lines.length);
    ta.style.width = (Math.max(60, textWidthPt({ ...a, text: ta.value || 'MMMMMM' }) * f.k) + fontPx) + 'px';
    ta.style.height = (lines.length * fontPx * 1.2 + 4) + 'px';
  };
  fit();
  ta.addEventListener('input', fit);
  const finish = () => {
    a.text = ta.value.replace(/\s+$/g, '');
    ta.remove();
    const p = pageOf(u);
    if (!a.text) { p.annots = p.annots.filter(z => z.id !== a.id); if (isNew) S.history.pop(); }
    S.selAnnot = a.text ? { page: u, id: a.id } : null;
    if (S.tool === 'text') setTool('select');
    drawAnnots(u); renderInspector();
  };
  ta.addEventListener('blur', finish, { once: true });
  ta.addEventListener('keydown', ev => { if (ev.key === 'Escape') ta.blur(); ev.stopPropagation(); });
  v.layer.append(ta);
  // hide the static copy while editing
  const g = v.svg.querySelector(`[data-id="${a.id}"]`); if (g) g.style.display = 'none';
  ta.focus();
}

function deleteSelectedAnnot() {
  if (!S.selAnnot) return;
  const p = pageOf(S.selAnnot.page); if (!p) return;
  snapshot();
  p.annots = p.annots.filter(a => a.id !== S.selAnnot.id);
  const u = S.selAnnot.page; S.selAnnot = null; drawAnnots(u); renderInspector();
}
function selectedAnnot() {
  if (!S.selAnnot) return null;
  const p = pageOf(S.selAnnot.page);
  return p ? p.annots.find(a => a.id === S.selAnnot.id) : null;
}

// ---------------------------------------------------------------- form fields (display)
function refreshForms() { for (const u of views.keys()) drawFields(u); }
function drawFields(u) {
  const v = views.get(u); const p = pageOf(u);
  v.layer.querySelectorAll('.fld').forEach(n => n.remove());
  const src = S.sources[p.src]; const vals = S.forms[p.src];
  if (!src.fields.length || !vals) return;
  for (const f of src.fields) for (const w of f.widgets) {
    if (w.page !== p.idx) continue;
    const r = rectU2V(u, w.rect);
    let n;
    const fontPx = Math.max(8, Math.min(r.h * 0.62, 12 * v.vp.scale));
    if (f.type === 'text') {
      n = f.multiline ? el('textarea', { class: 'fld' }) : el('input', { class: 'fld', type: 'text' });
      n.value = vals[f.name] || '';
      n.addEventListener('change', () => { snapshot(); vals[f.name] = n.value; syncField(f.name, p.src); });
    } else if (f.type === 'check') {
      n = el('input', { class: 'fld', type: 'checkbox' });
      n.checked = !!vals[f.name];
      n.addEventListener('change', () => { snapshot(); vals[f.name] = n.checked; syncField(f.name, p.src); });
    } else if (f.type === 'radio') {
      n = el('input', { class: 'fld', type: 'radio', name: `r-${p.src}-${f.name}-${u}` });
      n.checked = vals[f.name] === w.onValue;
      n.addEventListener('change', () => { snapshot(); vals[f.name] = w.onValue; syncField(f.name, p.src); });
    } else {
      n = el('select', { class: 'fld' }, el('option', { value: '', text: '' }), ...f.options.map(o => el('option', { value: o, text: o })));
      n.value = vals[f.name] || '';
      n.addEventListener('change', () => { snapshot(); vals[f.name] = n.value; syncField(f.name, p.src); });
    }
    n.dataset.field = f.name; n.dataset.src = p.src;
    n.title = f.name;
    Object.assign(n.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px', fontSize: fontPx + 'px' });
    v.layer.append(n);
  }
}
function syncField(name, si) {
  // keep duplicate widgets of the same field in step
  for (const v of views.values()) for (const n of v.layer.querySelectorAll('.fld')) {
    if (n.dataset.field !== name || Number(n.dataset.src) !== si) continue;
    const val = S.forms[si][name];
    if (n.type === 'checkbox') n.checked = !!val; else if (n.type === 'radio') { /* handled by name group */ } else if (n.value !== val) n.value = val;
  }
  renderInspector();
}

// ---------------------------------------------------------------- signatures
function openSignDialog() {
  const saved = store.get('signatures', []);
  const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Signature' });
  const dlg = el('div', { class: 'dialog' });
  modal.append(dlg);
  const tabs = el('div', { class: 'tabs', role: 'tablist' });
  const body = el('div');
  const mode = { cur: 'draw' };
  const tabBtn = (id, label) => el('button', { role: 'tab', 'aria-selected': String(id === mode.cur), onclick: () => { mode.cur = id; render(); } , text: label });
  let pad, padCtx, drawn = false, typed, upImg = null;
  const render = () => {
    tabs.replaceChildren(tabBtn('draw', 'Draw'), tabBtn('type', 'Type'), tabBtn('upload', 'Image'));
    body.replaceChildren();
    if (mode.cur === 'draw') {
      pad = el('canvas', { class: 'pad', width: 1040, height: 360, 'aria-label': 'Signature pad' });
      padCtx = pad.getContext('2d'); padCtx.lineWidth = 4.5; padCtx.lineCap = 'round'; padCtx.lineJoin = 'round'; padCtx.strokeStyle = '#14243a';
      drawn = false;
      let last = null;
      const pos = ev => { const r = pad.getBoundingClientRect(); return [(ev.clientX - r.left) * pad.width / r.width, (ev.clientY - r.top) * pad.height / r.height]; };
      pad.addEventListener('pointerdown', ev => { last = pos(ev); pad.setPointerCapture(ev.pointerId); });
      pad.addEventListener('pointermove', ev => { if (!last) return; const q = pos(ev); padCtx.beginPath(); padCtx.moveTo(...last); padCtx.lineTo(...q); padCtx.stroke(); last = q; drawn = true; });
      pad.addEventListener('pointerup', () => { last = null; });
      body.append(pad, el('div', { class: 'row' }, el('span', { class: 'note', text: 'Sign with a mouse, trackpad or finger.' }), el('span', { class: 'grow' }),
        el('button', { class: 'btn outline', text: 'Clear', onclick: () => { padCtx.clearRect(0, 0, pad.width, pad.height); drawn = false; } })));
    } else if (mode.cur === 'type') {
      const inp = el('input', { class: 'field', id: 'sigName', placeholder: 'Your name', value: store.get('sigName', '') });
      typed = el('div', { class: 'typed', text: inp.value || 'Your name' });
      inp.addEventListener('input', () => { typed.textContent = inp.value || 'Your name'; });
      body.append(inp, typed);
    } else {
      const pick = el('button', { class: 'btn outline', text: 'Choose image…', onclick: () => $('#fileImage').click() });
      const prev = el('div', { class: 'typed', style: 'display:grid;place-items:center' }, el('span', { class: 'note', text: 'A PNG with a transparent background works best.' }));
      $('#fileImage').onchange = async () => {
        const f = $('#fileImage').files[0]; $('#fileImage').value = '';
        if (!f) return;
        upImg = await createImageBitmap(f);
        const c = el('canvas'); c.width = upImg.width; c.height = upImg.height; c.getContext('2d').drawImage(upImg, 0, 0);
        upImg = c;
        prev.replaceChildren(el('img', { src: c.toDataURL('image/png'), style: 'max-height:120px' }));
      };
      body.append(pick, prev);
    }
  };
  const savedBox = el('div', { class: 'sig-list' });
  const renderSaved = () => {
    savedBox.replaceChildren();
    const list = store.get('signatures', []);
    if (!list.length) return;
    savedBox.append(el('div', { class: 'note', text: 'Saved in this browser:' }));
    list.forEach((url, i) => savedBox.append(el('div', { class: 'sig-item' },
      el('img', { src: url, alt: 'Saved signature' }),
      el('button', { class: 'btn outline', text: 'Use', onclick: () => { close(); usePng(url); } }),
      el('button', { 'aria-label': 'Remove saved signature', title: 'Remove', text: '✕', onclick: () => { const l = store.get('signatures', []); l.splice(i, 1); store.set('signatures', l); renderSaved(); } }))));
  };
  const remember = el('input', { type: 'checkbox', id: 'sigRemember', checked: 'checked' });
  const close = () => modal.remove();
  const make = async () => {
    let canvas;
    if (mode.cur === 'draw') { if (!drawn) { toast('Draw your signature first.'); return; } canvas = trimCanvas(pad); }
    else if (mode.cur === 'type') {
      const name = $('#sigName').value.trim(); if (!name) { toast('Type your name first.'); return; }
      store.set('sigName', name);
      try { await document.fonts.load('96px "Mrs Saint Delafield"'); } catch { /* fallback font */ }
      const c = el('canvas'); const ctx = c.getContext('2d'); ctx.font = '96px "Mrs Saint Delafield", "Segoe Script", cursive';
      c.width = Math.ceil(ctx.measureText(name).width + 60); c.height = 170;
      ctx.font = '96px "Mrs Saint Delafield", "Segoe Script", cursive'; ctx.fillStyle = '#14243a'; ctx.fillText(name, 30, 118);
      canvas = trimCanvas(c);
    } else { if (!upImg) { toast('Choose an image first.'); return; } canvas = upImg; }
    const url = canvas.toDataURL('image/png');
    if (remember.checked) { const l = store.get('signatures', []); if (!l.includes(url)) { l.unshift(url); store.set('signatures', l.slice(0, 6)); } }
    close(); usePng(url);
  };
  dlg.append(el('h2', { text: 'Add a signature' }), tabs, body,
    el('label', { class: 'toggle' }, remember, document.createTextNode('Remember this signature in this browser')),
    savedBox,
    el('div', { class: 'actions' }, el('button', { class: 'btn outline', text: 'Cancel', onclick: close }), el('button', { class: 'btn primary', text: 'Place on page', onclick: make })));
  modal.addEventListener('pointerdown', ev => { if (ev.target === modal) close(); });
  render(); renderSaved();
  document.body.append(modal);
}
function trimCanvas(c) {
  const ctx = c.getContext('2d'); const { width: w, height: h } = c;
  const d = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 <= x0) return c;
  const pad = 6; const o = el('canvas');
  o.width = x1 - x0 + pad * 2; o.height = y1 - y0 + pad * 2;
  o.getContext('2d').drawImage(c, x0 - pad, y0 - pad, o.width, o.height, 0, 0, o.width, o.height);
  return o;
}
async function usePng(dataUrl) {
  const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), ch => ch.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const id = uid();
  S.images.set(id, { bytes, url: dataUrl, w: bmp.width, h: bmp.height });
  S.pendingSig = id;
  S.tool = 'select';
  $$('#tools .btn').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tool === 'sign')));
  applyToolCursor();
  toast('Click on the page where the signature should go.');
}
function placeSignature(u, x, y) {
  const img = S.images.get(S.pendingSig);
  const wPt = 150, hPt = wPt * img.h / img.w;
  const k = views.get(u).vp.scale;
  const f = frameAt(u, x - (wPt * k) / 2, y - (hPt * k) / 2);
  snapshot();
  const a = { id: uid(), type: 'image', img: S.pendingSig, w: wPt, h: hPt, ...f };
  pageOf(u).annots.push(a);
  S.pendingSig = null;
  S.selAnnot = { page: u, id: a.id };
  setTool('select');
  drawAnnots(u);
}

// ---------------------------------------------------------------- search
async function pageText(p) {
  const src = S.sources[p.src];
  if (src.text.has(p.idx)) return src.text.get(p.idx);
  const pg = await src.pdf.getPage(p.idx + 1);
  const tc = await pg.getTextContent();
  const items = tc.items.filter(it => 'str' in it);
  for (const it of items) it.style = tc.styles[it.fontName] || {};
  src.text.set(p.idx, items);
  return items;
}
async function runSearch(q, keepCur = false) {
  S.search.q = q;
  const hits = [];
  if (q.trim().length >= 2) {
    const re = new RegExp(escapeRe(q.trim()), 'gi');
    for (const p of S.pages) {
      for (const m of matchRectsLines(await pageText(p), re)) hits.push({ page: p.uid, rect: m.rect });
    }
  }
  const prev = S.search.cur;
  S.search.hits = hits;
  S.search.cur = hits.length ? (keepCur ? Math.min(Math.max(prev, 0), hits.length - 1) : 0) : -1;
  $('#qCount').textContent = q.trim().length < 2 ? '' : hits.length ? `${S.search.cur + 1} of ${hits.length}` : 'none';
  refreshAllAnnots();
  if (!keepCur && hits.length) showHit(0);
}
function showHit(i) {
  const h = S.search.hits[i]; if (!h) return;
  S.search.cur = i;
  $('#qCount').textContent = `${i + 1} of ${S.search.hits.length}`;
  refreshAllAnnots();
  const v = views.get(h.page); const r = rectU2V(h.page, h.rect);
  const wrap = $('#docwrap');
  wrap.scrollTo({ top: v.div.offsetTop + r.y - wrap.clientHeight / 3, behavior: 'smooth' });
}

// ---------------------------------------------------------------- inspector
function renderInspector() {
  const box = $('#insp');
  const keepScroll = box.scrollTop;
  box.replaceChildren();
  const a = selectedAnnot();
  if (a) box.append(annotPanel(a));
  else if (S.tool === 'highlight') box.append(markPanel());
  else if (['ink', 'rect'].includes(S.tool)) box.append(penPanel());
  else if (S.tool === 'text') box.append(textPanel());
  else if (S.tool === 'whiteout') box.append(el('section', { class: 'sec' }, el('h3', { text: 'White-out' }),
    el('p', { text: 'Covers part of a page with white, for example before typing a correction on top. The text underneath stays in the file; use Redact to remove it.' })));
  else if (S.tool === 'edit') box.append(el('section', { class: 'sec' }, el('h3', { text: 'Edit text' }),
    el('p', {}, el('strong', { text: 'One line: ' }), document.createTextNode('click where you want to change it. The cursor goes where you clicked; type, then press Enter.')),
    el('p', {}, el('strong', { text: 'A paragraph: ' }), document.createTextNode('drag a box round it. The whole paragraph opens for editing and rewraps to fit, keeping its margins, size and line spacing.')),
    el('p', { class: 'note', text: 'When you save, the old words are removed and the new ones set in the nearest standard typeface (Arial, Times or Courier) at the same size.' })));
  else if (S.tool === 'note') box.append(notePrefs());
  else if (S.tool === 'stamp') box.append(stampPanel());
  else if (S.tool === 'field') box.append(fieldPanel());
  if (S.scanned && S.scanned.length) box.append(el('section', { class: 'sec' }, el('h3', { text: 'Scanned pages' }),
    el('p', { text: `${S.scanned.length} page${S.scanned.length === 1 ? ' is a picture' : 's are pictures'} of text, so ${S.scanned.length === 1 ? 'it' : 'they'} cannot be searched, selected or redacted by word yet.` }),
    el('button', { class: 'btn primary', id: 'btnOcr', text: 'Recognise text', onclick: recogniseDocument }),
    el('p', { class: 'note', style: 'margin-top:8px', text: 'English only. Runs on this computer and takes a few seconds a page.' })));
  if (S.tool === 'redact' || redactCount() > 0) box.append(redactPanel());
  if (S.compare) box.append(comparePanel());
  const notes = allNotes();
  if (notes.length) box.append(commentsPanel(notes));
  const formSrcs = Object.keys(S.forms);
  if (formSrcs.length) {
    const total = formSrcs.reduce((n, si) => n + S.sources[si].fields.length, 0);
    box.append(el('section', { class: 'sec' }, el('h3', { text: 'Form' }),
      el('p', { text: `${total} fillable field${total === 1 ? '' : 's'}, shown in blue on the page.` }),
      el('label', { class: 'toggle' }, check(S.settings.flatten, v => { S.settings.flatten = v; }), document.createTextNode('Flatten on save (fields become fixed text)'))));
  }
  box.append(outputPanel());
  if (S.lastReport) box.append(S.lastReport);
  box.append(el('section', { class: 'sec' }, el('h3', { text: 'Shortcuts' }),
    el('p', {}, kbd('Ctrl'), ' ', kbd('S'), ' save · ', kbd('Ctrl'), ' ', kbd('Z'), ' undo · ', kbd('?'), ' all shortcuts'),
    el('button', { class: 'btn outline', id: 'btnKeys', text: 'Show all keyboard shortcuts', onclick: showShortcuts }),
    el('button', { class: 'btn outline', id: 'btnTour', text: 'Take the tour', onclick: () => startTour() })));
  box.scrollTop = keepScroll;
}
const kbd = t => el('span', { class: 'kbd', text: t });
// every keyboard shortcut, grouped, with what it does
const SHORTCUTS = [
  ['Files', [
    [['Ctrl', 'O'], 'Open a PDF'],
    [['Ctrl', 'S'], 'Save. Writes into the original file when you opened it from your computer; otherwise saves a copy'],
    [['Ctrl', 'Shift', 'S'], 'Save a copy, leaving the original as it is'],
  ]],
  ['Finding text', [
    [['Ctrl', 'F'], 'Go to the find box'],
    [['Enter'], 'Next match (in the find box)'],
    [['Shift', 'Enter'], 'Previous match (in the find box)'],
  ]],
  ['Undo and selection', [
    [['Ctrl', 'Z'], 'Undo the last change'],
    [['Delete'], 'Remove the selected item (Backspace also works)'],
    [['Esc'], 'Deselect, cancel a signature waiting to be placed, and go back to Select'],
  ]],
  ['Tools', [
    [['V'], 'Select and move items'],
    [['H'], 'Highlight text'],
    [['T'], 'Add text'],
    [['D'], 'Draw freehand'],
    [['R'], 'Draw a box'],
    [['W'], 'White-out'],
    [['S'], 'Sign'],
    [['N'], 'Add a comment'],
    [['P'], 'Stamp'],
    [['F'], 'Add a form field'],
    [['E'], 'Edit existing text'],
    [['X'], 'Redact'],
  ]],
  ['While editing text', [
    [['Enter'], 'Finish editing a single line'],
    [['Ctrl', 'Enter'], 'Finish editing a paragraph'],
    [['Enter'], 'Start a new paragraph (in the paragraph editor)'],
    [['Esc'], 'Cancel the edit and keep the text as it was'],
    [['Click outside'], 'Accept the edit'],
  ]],
  ['Viewing', [
    [['Ctrl', '+'], 'Zoom in'],
    [['Ctrl', '\u2212'], 'Zoom out'],
    [['Ctrl', '0'], 'Fit the page to the window width'],
    [['?'], 'Show this list'],
  ]],
];
// ---- version and what's new
// Each release adds an entry at the top. APP_VERSION is shown in the status bar and drives the
// "What's new" box, which appears once after an update unless switched off.
const RELEASES = [
  { v: '1.4.1', date: '14 October 2026', items: [
    'The welcome step of the tour now shows what\u2019s new in this version, with a link to every version.',
    'The tour has a new step pointing out the version number and what\u2019s new.',
  ] },
  { v: '1.4.0', date: '14 October 2026', items: [
    'Version number in the status bar; click it to see the history of changes.',
    'What’s new: after an update, a short summary of the changes appears once when Quire starts. Tick the box to stop it appearing.',
    'Guided tour of the main features on start, with Don’t show on start; replay it from the side panel.',
  ] },
  { v: '1.3.0', date: '14 October 2026', items: [
    'Editing: clicking outside the box accepts the edit, and clicks inside it move the cursor.',
    'Edited text no longer leaves an outline. Click any word of an edited paragraph to change just that word, or drag over part of it to select those words.',
    'Recognised (OCR) text is edited a line at a time, and the scanned words are covered in the saved file.',
    'Full list of keyboard shortcuts (press ?), and Ctrl +, Ctrl − and Ctrl 0 to zoom.',
  ] },
  { v: '1.2.0', date: '14 October 2026', items: [
    'Ashvaren branding: the fern, house colours and fonts, and a new app icon.',
    'Light and dark mode switch in the toolbar.',
    'Save and Save copy now sit beside Open.',
    'Updates are always fetched fresh, so a new version appears the next time Quire opens.',
  ] },
  { v: '1.1.0', date: '14 October 2026', items: [
    'Save writes your changes into the original file when you opened it from your computer; Save copy still makes a new file.',
    'Double-click a PDF in File Explorer to open it in the installed app.',
    'Editing a line keeps the text and puts the cursor where you click.',
    'Drag a box round a paragraph to edit it as a block; the words rewrap to the original margins.',
    'Redaction is laid out as three steps: mark, check, save, with a preview of the final boxes.',
  ] },
  { v: '1.0.0', date: 'October 2026', items: [
    'First release: view, annotate, sign, fill and build forms, edit text, redact, reorder and combine pages, compare versions, recognise scanned text, export to Word, batch processing, watermarks, page numbers, headers and footers, Bates numbers and password protection. Works offline.',
  ] },
];
const APP_VERSION = RELEASES[0].v;
const vparts = v => v.split('.').map(Number);
const newer = (a, b) => { const x = vparts(a), y = vparts(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
function showWhatsNew({ since = null, onStart = false } = {}) {
  if (document.querySelector('.modal[aria-label="What’s new"]')) return;
  const list = since ? RELEASES.filter(r => newer(r.v, since)) : RELEASES;
  const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'What’s new' });
  const off = el('input', { type: 'checkbox', id: 'wnOff' }); off.checked = !!store.get('whatsNewOff', false);
  off.addEventListener('change', () => store.set('whatsNewOff', off.checked));
  const close = () => { modal.remove(); document.removeEventListener('keydown', esc, true); store.set('seenVersion', APP_VERSION); };
  const esc = ev => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); } };
  document.addEventListener('keydown', esc, true);
  modal.addEventListener('pointerdown', ev => { if (ev.target === modal) close(); });
  modal.append(el('div', { class: 'dialog whatsnew' },
    el('div', { class: 'wn-head' }, el('span', { class: 'wn-kicker', text: onStart ? 'Quire has been updated' : 'Version history' }),
      el('h2', { text: onStart ? `What’s new in ${APP_VERSION}` : 'What’s new' })),
    el('div', { class: 'wn-list' }, ...list.map(r => el('section', { class: 'wn-rel' },
      el('h3', {}, el('span', { class: 'wn-v', text: r.v }), el('span', { class: 'wn-date', text: r.date })),
      el('ul', {}, ...r.items.map(t => el('li', { text: t })))))),
    el('div', { class: 'actions wn-foot' }, el('label', { class: 'toggle' }, off, document.createTextNode('Don’t show what’s new on start')),
      el('button', { class: 'btn primary', id: 'wnClose', text: 'Close', onclick: close }))));
  document.body.append(modal);
  $('#wnClose').focus();
}

// ---- guided tour: a spotlight on each key feature with a short note on how to use it
const TOUR = [
  { title: 'Welcome to Quire', body: 'Your PDF editor from Ashvaren. Everything happens on this computer: files are never uploaded anywhere. This short tour shows the main features; it takes about a minute.', extra: 'whatsnew' },
  { sel: '#btnOpen', title: 'Open a PDF', body: 'Click Open, press Ctrl+O, or drag a PDF onto the page. In the installed app you can also double-click a PDF in File Explorer and choose Quire.' },
  { sel: '#btnSave', title: 'Save and Save copy', body: 'Save copy creates a new file and leaves your original untouched. When you open a file from your computer, a Save button appears here too, which writes your changes back into the original (it asks once first).' },
  { sel: '[data-tool="edit"]', title: 'Edit existing text', body: 'Choose Edit text, then click on a line to change a word, with the cursor where you clicked. Drag a box round a paragraph to edit it as a block; the words rewrap to the original margins. Click outside to accept, or press Esc to cancel.' },
  { sel: '[data-tool="highlight"]', to: '[data-tool="stamp"]', title: 'Mark up the page', body: 'Highlight, add text, draw, add boxes, white-out, comment and stamp. Pick a tool, then click or drag on the page. Use Select (V) to move or delete what you have added.' },
  { sel: '[data-tool="sign"]', title: 'Sign', body: 'Draw, type or upload your signature once and tick Remember to keep it on this computer. Then click wherever it should go.' },
  { sel: '[data-tool="redact"]', title: 'Redact', body: 'Three steps: mark what must go (drag boxes, or find a name and Mark all), check the marks, then Save redacted copy. The text and pictures underneath are deleted from the file and Quire checks nothing readable is left.' },
  { sel: '.rail', title: 'Pages', body: 'Drag thumbnails to reorder. Rotate, delete, extract or split pages, insert a blank page or an image. Ctrl or Shift selects several.' },
  { sel: '#btnInsert', to: '#btnBatch', title: 'Combine, compare, Word and batch', body: 'Add pages from other PDFs, compare two versions with the changes marked, export to an editable Word document, or apply the same job to a folder of files.' },
  { sel: '.search', title: 'Find', body: 'Search the whole document (Ctrl+F). Enter jumps to the next match, Shift+Enter to the previous one.' },
  { sel: '#insp', title: 'The side panel', body: 'Settings for the selected tool or item appear here, along with options for saving: watermark, page numbers, headers and footers, Bates numbers, smaller file size and a password. After each save, a report confirms what was checked.' },
  { sel: '#stVer', title: 'Version and what’s new', body: 'The version you are using is shown here. Click it at any time to see what has changed in each release. After an update, a short What’s new summary also appears once when Quire starts; you can switch that off from the box itself.' },
  { sel: '#btnTheme', title: 'Light or dark', body: 'Switch between light and dark mode. Press ? at any time for the full list of keyboard shortcuts, and use Take the tour in the side panel to see this again.' },
];
let tourEl = null;
function startTour(at = 0) {
  endTour();
  let i = at;
  const spot = el('div', { class: 'tour-spot' });
  const veil = el('div', { class: 'tour-veil' });
  const hide = el('input', { type: 'checkbox', id: 'tourHide' }); hide.checked = !!store.get('tourHidden', false);
  hide.addEventListener('change', () => store.set('tourHidden', hide.checked));
  const extra = el('div', { class: 'tour-extra' });
  const title = el('h2', { id: 'tourTitle' }), body = el('p', { id: 'tourBody' }), count = el('span', { class: 'tour-count' }), dots = el('div', { class: 'tour-dots' });
  const back = el('button', { class: 'btn outline', id: 'tourBack', text: 'Back', onclick: () => go(i - 1) });
  const next = el('button', { class: 'btn primary', id: 'tourNext', text: 'Next', onclick: () => (i === TOUR.length - 1 ? endTour() : go(i + 1)) });
  const skip = el('button', { class: 'tour-skip', id: 'tourSkip', text: 'Close tour', onclick: endTour });
  const card = el('div', { class: 'tour-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tourTitle', 'aria-describedby': 'tourBody' },
    el('div', { class: 'tour-top' }, count, skip), title, body, extra, dots,
    el('div', { class: 'tour-foot' }, el('label', { class: 'toggle' }, hide, document.createTextNode("Don't show on start")), el('div', { class: 'tour-btns' }, back, next)));
  const keys = ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); endTour(); }
    else if (ev.key === 'ArrowRight' || (ev.key === 'Enter' && ev.target === document.body)) { ev.preventDefault(); ev.stopPropagation(); next.click(); }
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); ev.stopPropagation(); if (i > 0) go(i - 1); }
    else if (!ev.target.closest?.('.tour-card')) { ev.stopPropagation(); }
  };
  const place = () => {
    const st = TOUR[i];
    const a = st.sel && document.querySelector(st.sel), b = st.to && document.querySelector(st.to);
    const cw = Math.min(360, window.innerWidth - 32);
    card.style.width = cw + 'px';
    if (!a || !a.getClientRects().length) {
      spot.style.display = 'none'; veil.style.clipPath = '';
      card.style.left = (window.innerWidth - cw) / 2 + 'px'; card.style.top = Math.max(16, (window.innerHeight - card.offsetHeight) / 2) + 'px';
      return;
    }
    spot.style.display = 'block';
    let r = a.getBoundingClientRect();
    if (b) { const r2 = b.getBoundingClientRect(); r = { left: Math.min(r.left, r2.left), top: Math.min(r.top, r2.top), right: Math.max(r.right, r2.right), bottom: Math.max(r.bottom, r2.bottom) }; }
    const pad = 6, L = Math.max(4, r.left - pad), T = Math.max(4, r.top - pad), R = Math.min(window.innerWidth - 4, r.right + pad), B = Math.min(window.innerHeight - 4, r.bottom + pad);
    Object.assign(spot.style, { left: L + 'px', top: T + 'px', width: (R - L) + 'px', height: (B - T) + 'px' });
    // dim everything except the feature being described
    const W = window.innerWidth, Hh = window.innerHeight;
    veil.style.clipPath = `path(evenodd, 'M0 0H${W}V${Hh}H0Z M${L} ${T}H${R}V${B}H${L}Z')`;
    const ch = card.offsetHeight, gap = 14;
    let x, y;
    if (B + gap + ch < window.innerHeight - 8) { y = B + gap; x = (L + R) / 2 - cw / 2; }
    else if (T - gap - ch > 8) { y = T - gap - ch; x = (L + R) / 2 - cw / 2; }
    else if (L - gap - cw > 8) { x = L - gap - cw; y = (T + B) / 2 - ch / 2; }
    else { x = R + gap; y = (T + B) / 2 - ch / 2; }
    card.style.left = Math.max(12, Math.min(window.innerWidth - cw - 12, x)) + 'px';
    card.style.top = Math.max(12, Math.min(window.innerHeight - ch - 12, y)) + 'px';
  };
  const go = n => {
    i = Math.max(0, Math.min(TOUR.length - 1, n));
    const st = TOUR[i];
    title.textContent = st.title; body.textContent = st.body;
    extra.replaceChildren();
    if (st.extra === 'whatsnew') {
      const r = RELEASES[0];
      extra.append(el('div', { class: 'tour-wn' },
        el('div', { class: 'tour-wn-head' }, el('strong', { text: `What’s new in ${r.v}` }), el('span', { text: r.date })),
        el('ul', {}, ...r.items.map(t => el('li', { text: t }))),
        el('button', { class: 'tour-skip', id: 'tourHistory', text: 'See every version', onclick: () => { endTour(); showWhatsNew(); } })));
    }
    count.textContent = `${i + 1} of ${TOUR.length}`;
    dots.replaceChildren(...TOUR.map((_, k) => el('span', { class: k === i ? 'on' : '' })));
    back.disabled = i === 0;
    next.textContent = i === TOUR.length - 1 ? 'Finish' : 'Next';
    place();
    next.focus();
  };
  tourEl = { nodes: [veil, spot, card], cleanup: () => { document.removeEventListener('keydown', keys, true); window.removeEventListener('resize', place); } };
  document.addEventListener('keydown', keys, true);
  window.addEventListener('resize', place);
  document.body.append(veil, spot, card);
  go(i);
}
function endTour() {
  if (!tourEl) return;
  tourEl.cleanup(); tourEl.nodes.forEach(n => n.remove()); tourEl = null;
}

function showShortcuts() {
  if (document.querySelector('.modal[aria-label="Keyboard shortcuts"]')) return;
  const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Keyboard shortcuts' });
  const close = () => { modal.remove(); document.removeEventListener('keydown', esc, true); };
  const esc = ev => { if (ev.key === 'Escape' || ev.key === '?') { ev.preventDefault(); ev.stopPropagation(); close(); } };
  document.addEventListener('keydown', esc, true);
  modal.addEventListener('pointerdown', ev => { if (ev.target === modal) close(); });
  const groups = SHORTCUTS.map(([title, rows]) => el('section', { class: 'keys-group' }, el('h3', { text: title }),
    el('dl', { class: 'keys' }, ...rows.flatMap(([keys, what]) => [
      el('dt', {}, ...keys.flatMap((k, i) => i ? [el('span', { class: 'plus', text: '+' }), kbd(k)] : [kbd(k)])),
      el('dd', { text: what })]))));
  modal.append(el('div', { class: 'dialog keys-dialog' }, el('h2', { text: 'Keyboard shortcuts' }),
    el('p', { class: 'note', text: 'Single-letter shortcuts work whenever you are not typing in a box. On a Mac, use Cmd in place of Ctrl.' }),
    el('div', { class: 'keys-cols' }, ...groups),
    el('div', { class: 'actions' }, el('button', { class: 'btn primary', text: 'Close', onclick: close }))));
  document.body.append(modal);
}
function check(val, on) { const c = el('input', { type: 'checkbox' }); c.checked = val; c.addEventListener('change', () => { on(c.checked); refreshAllAnnots(); }); return c; }
function swatches(list, cur, on) {
  return el('div', { class: 'swatches' }, ...list.map(c => {
    const b = el('button', { class: 'sw', 'aria-label': 'Colour ' + c, 'aria-pressed': String(c === cur), style: `background:${c}` });
    b.addEventListener('click', () => on(c)); return b;
  }));
}
function seg(options, cur, on, label) {
  return el('div', { class: 'seg', role: 'group', 'aria-label': label }, ...options.map(([v, t]) => {
    const b = el('button', { 'aria-pressed': String(v === cur), text: t, 'data-v': v }); b.addEventListener('click', () => on(v)); return b;
  }));
}
function markPanel() {
  const kind = S.style.markKind;
  return el('section', { class: 'sec' }, el('h3', { text: 'Mark text' }),
    el('div', { class: 'row' }, seg([['highlight', 'Highlight'], ['underline', 'Underline'], ['strike', 'Strike']], kind, v => { S.style.markKind = v; renderInspector(); }, 'Mark style')),
    el('p', { text: 'Drag across the words to mark. On a scan without text, Highlight marks the area you drag.' }),
    kind === 'highlight' ? swatches(COLORS.highlight, S.style.highlight, c => { S.style.highlight = c; renderInspector(); })
      : swatches(['#c4161c', '#1f4fd1', '#14243a', '#127a3a'], S.style.markLine || '#c4161c', c => { S.style.markLine = c; renderInspector(); }));
}
function penPanel() {
  const w = el('input', { type: 'range', min: '0.5', max: '8', step: '0.5', value: S.style.penWidth, id: 'penWidth', class: 'grow', 'aria-label': 'Line width' });
  w.addEventListener('input', () => { S.style.penWidth = Number(w.value); });
  return el('section', { class: 'sec' }, el('h3', { text: S.tool === 'ink' ? 'Pen' : 'Box' }),
    swatches(COLORS.pen, S.style.pen, c => { S.style.pen = c; renderInspector(); }),
    el('div', { class: 'row', style: 'margin-top:10px' }, el('label', { for: 'penWidth', text: 'Width' }), w));
}
function textPanel() {
  const s = el('input', { type: 'number', min: '5', max: '72', value: S.style.textSize, id: 'textSize', class: 'field', style: 'width:80px' });
  s.addEventListener('change', () => { S.style.textSize = Number(s.value) || 11; });
  return el('section', { class: 'sec' }, el('h3', { text: 'Text' }), el('p', { text: 'Click on the page to type. Double-click a text box later to edit it.' }),
    el('div', { class: 'row' }, el('label', { for: 'textSize', text: 'Size (pt)' }), s),
    swatches(COLORS.pen, S.style.textColor, c => { S.style.textColor = c; renderInspector(); }));
}
function authorField() {
  const inp = el('input', { class: 'field', id: 'authorName', placeholder: 'Your name', value: S.author, 'aria-label': 'Your name for comments and stamps' });
  inp.addEventListener('change', () => { S.author = inp.value.trim(); store.set('author', S.author); });
  return el('div', { class: 'row' }, el('label', { for: 'authorName', text: 'Name on comments' }), inp);
}
function notePrefs() {
  return el('section', { class: 'sec' }, el('h3', { text: 'Comment' }),
    el('p', { text: 'Click where the comment belongs, then type it here. Comments are saved as real PDF comments, so Acrobat and Nitro show and edit them.' }),
    authorField());
}
function stampPanel() {
  return el('section', { class: 'sec' }, el('h3', { text: 'Stamp' }),
    el('div', { class: 'stamps' }, ...Object.entries(STAMPS).map(([lbl, col]) => {
      const b = el('button', { class: 'stamp-btn', 'aria-pressed': String(S.style.stamp === lbl), style: `color:${col}`, text: lbl });
      b.addEventListener('click', () => { S.style.stamp = lbl; renderInspector(); }); return b;
    })),
    el('p', { class: 'note', style: 'margin-top:8px', text: 'Approved, Paid and Received carry today’s date and your name. Click on the page to place.' }),
    authorField());
}
function redactCount() { return S.pages.reduce((n, p) => n + p.annots.filter(a => a.type === 'redact').length, 0); }
function redactPanel() {
  const n = redactCount();
  const pagesWith = S.pages.filter(p => p.annots.some(a => a.type === 'redact')).length;
  const find = el('input', { class: 'field', id: 'redFind', placeholder: 'Word, name or figure', 'aria-label': 'Text to redact' });
  const markAll = async (re, label) => {
    let added = 0;
    snapshot();
    // exact character positions from MuPDF, so nothing at the edge of a match survives
    const found = await busy('Searching…', async () => {
      const res = {};
      for (const si of new Set(S.pages.map(p => p.src))) {
        const list = S.pages.filter(p => p.src === si).map(p => ({ key: p.uid, page: p.idx }));
        Object.assign(res, await Engine.findMatches(S.sources[si].bytes, list, re.source, re.flags));
      }
      return res;
    });
    for (const p of S.pages) {
      for (const m of found[p.uid] || []) {
        const r = [m.rect[0] - 0.5, m.rect[1] - 0.5, m.rect[2] + 0.5, m.rect[3] + 0.5];
        if (p.annots.some(a => a.type === 'redact' && Math.abs(a.rect[0] - r[0]) < 0.5 && Math.abs(a.rect[1] - r[1]) < 0.5)) continue;
        p.annots.push({ id: uid(), type: 'redact', rect: r, fill: S.style.redactFill, why: label }); added++;
      }
    }
    if (!added) S.history.pop();
    toast(added ? `Marked ${added} match${added === 1 ? '' : 'es'} for redaction.` : `No ${label} found.`);
    refreshAllAnnots(); renderInspector();
  };
  const step = (n, title, ...body) => el('div', { class: 'rstep' }, el('div', { class: 'rnum', text: String(n) }), el('div', { class: 'rbody' }, el('strong', { text: title }), ...body));
  return el('section', { class: 'sec' }, el('h3', { text: 'Redaction' }),
    el('p', { class: 'note', text: 'Redaction removes content permanently. It works in three steps, and nothing is removed until step 3.' }),
    step(1, 'Mark what must go',
      el('p', { text: 'With Redact selected, drag a box over any text, signature or picture. Or find every occurrence of a name or number:' }),
      el('div', { class: 'row' }, find, el('button', { class: 'btn outline', text: 'Mark all', onclick: () => { const q = find.value.trim(); if (q.length < 2) { toast('Type at least two characters.'); return; } markAll(new RegExp(escapeRe(q), 'gi'), `matches for “${q}”`); } })),
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:4px' }, ...Object.entries(PATTERNS).map(([k, pat]) =>
        el('button', { class: 'btn outline', style: 'height:26px;font-size:12px;padding:0 8px', text: pat.label, onclick: () => markAll(pat.re(), pat.label.toLowerCase()) })))),
    step(2, 'Check the marks',
      el('p', { text: n ? `${n} area${n === 1 ? '' : 's'} marked on ${pagesWith} page${pagesWith === 1 ? '' : 's'}, shown in grey with a red outline. To remove one, click it and press Delete.` : 'Marked areas appear in grey with a red outline.' }),
      el('label', { class: 'toggle' }, (() => { const c = el('input', { type: 'checkbox', id: 'redPreview' }); c.checked = !!S.redactPreview; c.addEventListener('change', () => { S.redactPreview = c.checked; refreshAllAnnots(); }); return c; })(), document.createTextNode('Show as it will look (solid boxes)')),
      el('div', { class: 'row', style: 'margin-top:6px' }, el('span', { class: 'note', text: 'Box colour' }), seg([['black', 'Black'], ['white', 'White']], S.style.redactFill, v => {
        S.style.redactFill = v; for (const p of S.pages) for (const a of p.annots) if (a.type === 'redact') a.fill = v; refreshAllAnnots(); renderInspector();
      }, 'Redaction fill'),
        n ? el('button', { class: 'btn outline', text: 'Clear all', onclick: () => { snapshot(); for (const p of S.pages) p.annots = p.annots.filter(a => a.type !== 'redact'); S.selAnnot = null; refreshAllAnnots(); renderInspector(); } }) : null)),
    step(3, 'Save the redacted copy',
      el('p', { text: 'Saving deletes the text, image pixels and drawings under every mark from the file itself, fills the boxes, then checks that nothing readable is left. Your original file is not changed.' }),
      el('button', { class: 'btn primary', id: 'btnSaveRedacted', text: 'Save redacted copy', disabled: n ? null : 'disabled', onclick: () => doSave(S.pages, '(redacted)') })));
}
function allNotes() {
  const out = [];
  S.pages.forEach((p, i) => p.annots.forEach(a => { if (a.type === 'note') out.push({ p, i, a }); }));
  return out;
}
function commentsPanel(notes) {
  return el('section', { class: 'sec' }, el('h3', { text: `Comments (${notes.length})` }),
    el('div', { class: 'changes' }, ...notes.map(({ p, i, a }) => el('button', { class: 'comment', onclick: () => {
      S.selAnnot = { page: p.uid, id: a.id }; refreshAllAnnots(); renderInspector();
      const v = views.get(p.uid); const [, y] = u2v(p.uid, a.at[0], a.at[1]);
      $('#docwrap').scrollTo({ top: v.div.offsetTop + y - 120, behavior: 'smooth' });
    } }, el('span', { class: 'pg', text: `Page ${i + 1}${a.author ? ' · ' + a.author : ''}` }), document.createTextNode(a.text || '(empty)')))));
}
function annotPanel(a) {
  const names = { highlight: 'Highlight', rect: 'Box', ink: 'Drawing', text: 'Text box', image: 'Signature', whiteout: 'White-out',
    markup: a.kind === 'underline' ? 'Underline' : a.kind === 'strike' ? 'Strikethrough' : 'Highlight', redact: 'Redaction', edit: 'Edited text', pedit: 'Edited paragraph', note: 'Comment', stamp: 'Stamp', field: 'Form field' };
  const sec = el('section', { class: 'sec' }, el('h3', { text: 'Selected: ' + names[a.type] }));
  const u = S.selAnnot.page;
  const upd = fn => { snapshot(); fn(); drawAnnots(u); renderInspector(); };
  if (a.type === 'highlight' || (a.type === 'markup' && a.kind === 'highlight')) sec.append(swatches(COLORS.highlight, a.color, c => upd(() => { a.color = c; })));
  if (a.type === 'markup' && a.kind !== 'highlight') sec.append(swatches(['#c4161c', '#1f4fd1', '#14243a', '#127a3a'], a.color, c => upd(() => { a.color = c; })));
  if (['ink', 'rect', 'text'].includes(a.type)) sec.append(swatches(COLORS.pen, a.color, c => upd(() => { a.color = c; })));
  if (a.type === 'text') {
    const s = el('input', { type: 'number', min: '4', max: '96', value: Math.round(a.size * 10) / 10, class: 'field', style: 'width:80px', id: 'selSize' });
    s.addEventListener('change', () => upd(() => { a.size = Number(s.value) || a.size; }));
    sec.append(el('div', { class: 'row', style: 'margin-top:10px' }, el('label', { for: 'selSize', text: 'Size (pt)' }), s,
      el('button', { class: 'btn outline', text: 'Edit text', onclick: () => editText(u, a) })));
  }
  if (a.type === 'whiteout') sec.append(el('p', { text: 'The text underneath is still in the file. Use Redact to remove it.' }));
  if (a.type === 'field') {
    const nm = el('input', { class: 'field', id: 'fieldName', value: a.name, 'aria-label': 'Field name' });
    nm.addEventListener('change', () => {
      const want = nm.value.trim();
      if (!want) { nm.value = a.name; return; }
      if (want !== a.name && allFieldNames().has(want)) { toast('Another field already has that name.'); nm.value = a.name; return; }
      if (/[.\[\]]/.test(want)) { toast('Field names cannot contain full stops or brackets.'); nm.value = a.name; return; }
      upd(() => { a.name = want; });
    });
    sec.append(el('p', { class: 'note', text: FIELD_KINDS[a.kind] + ' field' }), el('div', { class: 'row' }, el('label', { for: 'fieldName', text: 'Name' }), nm),
      el('label', { class: 'toggle' }, (() => { const c = el('input', { type: 'checkbox', id: 'fieldReq' }); c.checked = a.required; c.addEventListener('change', () => upd(() => { a.required = c.checked; })); return c; })(), document.createTextNode('Required')));
    if (a.kind === 'dropdown') {
      const ta = el('textarea', { class: 'field', id: 'fieldOpts', rows: '4', 'aria-label': 'Choices, one per line' });
      ta.value = a.options.join('\n');
      ta.addEventListener('change', () => upd(() => { a.options = ta.value.split('\n').map(t => t.trim()).filter(Boolean); }));
      sec.append(el('p', { class: 'note', text: 'Choices, one per line:' }), ta);
    }
  }
  if (a.type === 'redact') sec.append(el('p', { text: 'Everything under this mark is deleted when you save.' }),
    seg([['black', 'Black'], ['white', 'White']], a.fill, v => upd(() => { a.fill = v; }), 'Fill'));
  if (a.type === 'pedit') {
    const nl = a.layout ? a.layout.length : a.origLines;
    sec.append(el('p', { class: 'note', text: `${nl} line${nl === 1 ? '' : 's'}, ${a.font.fam}${a.font.bold ? ' bold' : ''}, ${Math.round(a.size * 10) / 10} pt.` }));
    if (a.extraLines) sec.append(el('div', { class: 'report warn', text: `The new wording runs ${a.extraLines} line${a.extraLines === 1 ? '' : 's'} longer than the original, so it will overlap whatever is below. Shorten it, or restore it and drag a box that includes the text below as well.` }));
    if (a.mixed) sec.append(el('p', { class: 'note', text: 'This paragraph mixed typefaces (bold or italic words, say); the edited version uses one throughout.' }));
    sec.append(el('div', { class: 'row', style: 'margin-top:6px' }, seg([['left', 'Left'], ['both', 'Justified']], a.align, async v => { snapshot(); a.align = v; await layoutPedit(a); drawAnnots(u); renderInspector(); }, 'Alignment')),
      el('div', { class: 'row' }, el('button', { class: 'btn outline', text: 'Change', onclick: () => openParaEditor(u, a, false) }),
        el('button', { class: 'btn outline', text: 'Restore original', onclick: deleteSelectedAnnot })));
    return sec;
  }
  if (a.type === 'edit') {
    sec.append(el('p', { class: 'note', text: `Was: “${a.orig}”` }), el('p', { class: 'note', text: `Typeface: ${a.font.fam}${a.font.bold ? ' bold' : ''}${a.font.italic ? ' italic' : ''}, ${Math.round(a.size * 10) / 10} pt (original ${a.fontName ? a.fontName.replace(/^[A-Z]{6}\+/, '') : 'unknown'})` }),
      el('div', { class: 'row' }, el('button', { class: 'btn outline', text: 'Change', onclick: () => openEditEditor(u, a, false) }),
        el('button', { class: 'btn outline', text: 'Restore original', onclick: deleteSelectedAnnot })));
    return sec;
  }
  if (a.type === 'note') {
    const ta = el('textarea', { class: 'field', id: 'noteText', rows: '4', placeholder: 'Type your comment' });
    ta.value = a.text;
    ta.addEventListener('change', () => { snapshot(); a.text = ta.value; a.author = a.author || S.author; drawAnnots(u); renderInspector(); });
    sec.append(ta, el('div', { class: 'row', style: 'margin-top:8px' }, swatches(['#ffd84d', '#8fd3ff', '#9be89f', '#ffa3c8'], a.color, c => upd(() => { a.color = c; }))), authorField());
  }
  sec.append(el('div', { class: 'row', style: 'margin-top:10px' }, el('button', { class: 'btn outline', text: 'Delete', onclick: deleteSelectedAnnot }),
    el('span', { class: 'note', text: ['markup', 'note'].includes(a.type) ? '' : 'Drag to move; corner handle to resize.' })));
  return sec;
}
function comparePanel() {
  const c = S.compare;
  const list = el('div', { class: 'changes' });
  c.changes.slice(0, 300).forEach(ch => {
    const b = el('button', { class: 'change' }, el('span', { class: 'pg', text: ch.pageLabel }));
    if (ch.del) b.append(el('del', { text: ch.del }));
    if (ch.del && ch.ins) b.append(document.createTextNode(' → '));
    if (ch.ins) b.append(el('ins', { text: ch.ins }));
    b.addEventListener('click', () => {
      if (!ch.page) return;
      const v = views.get(ch.page); const r = rectU2V(ch.page, ch.rect);
      $('#docwrap').scrollTo({ top: v.div.offsetTop + r.y - 160, behavior: 'smooth' });
    });
    list.append(b);
  });
  return el('section', { class: 'sec' }, el('h3', { text: 'Comparison' }),
    el('p', { text: c.changes.length ? `${c.changes.length} change${c.changes.length === 1 ? '' : 's'} against ${c.name}. Red marks wording that differs; green bars mark where the other version adds words.` : `No wording differences from ${c.name}.` }),
    c.changes.length > 300 ? el('p', { class: 'note', text: 'Showing the first 300.' }) : null,
    list,
    el('div', { class: 'row', style: 'margin-top:8px' }, el('button', { class: 'btn outline', text: 'Clear comparison', onclick: () => { S.compare = null; refreshAllAnnots(); renderInspector(); } }),
      el('span', { class: 'note', text: 'Compares wording, not layout.' })));
}
function hfEditor() {
  const hf = S.settings.hf;
  const box = el('div', { class: 'hf-grid' });
  for (const slot of ['tl', 'tc', 'tr', 'bl', 'bc', 'br']) {
    const inp = el('input', { class: 'field', id: 'hf_' + slot, placeholder: SLOT_NAMES[slot], value: hf.slots[slot], 'aria-label': SLOT_NAMES[slot] });
    inp.addEventListener('input', () => { hf.slots[slot] = inp.value; refreshAllAnnots(); });
    box.append(inp);
  }
  const size = el('input', { type: 'number', class: 'field', id: 'hfSize', min: '6', max: '16', value: hf.size, style: 'width:70px' });
  size.addEventListener('change', () => { hf.size = Number(size.value) || 9; refreshAllAnnots(); });
  return el('div', { style: 'margin:6px 0 10px 24px;display:grid;gap:6px' }, box,
    el('div', { class: 'row' }, el('label', { for: 'hfSize', text: 'Size (pt)' }), size),
    el('p', { class: 'note', text: 'Codes: {page}, {pages}, {date}, {file}, {bates}.' }));
}
function batesEditor() {
  const b = S.settings.bates;
  const prefix = el('input', { class: 'field', id: 'batesPrefix', value: b.prefix, style: 'width:90px', 'aria-label': 'Prefix' });
  prefix.addEventListener('input', () => { b.prefix = prefix.value; refreshAllAnnots(); });
  const start = el('input', { type: 'number', class: 'field', id: 'batesStart', min: '0', value: b.start, style: 'width:90px', 'aria-label': 'First number' });
  start.addEventListener('change', () => { b.start = Math.max(0, Number(start.value) | 0); refreshAllAnnots(); renderInspector(); });
  const digits = el('input', { type: 'number', class: 'field', id: 'batesDigits', min: '1', max: '10', value: b.digits, style: 'width:70px', 'aria-label': 'Digits' });
  digits.addEventListener('change', () => { b.digits = Math.min(10, Math.max(1, Number(digits.value) | 0)); refreshAllAnnots(); renderInspector(); });
  const pos = el('select', { class: 'field', id: 'batesPos', 'aria-label': 'Position' }, ...Object.entries(SLOT_NAMES).map(([k, v]) => el('option', { value: k, text: v })));
  pos.value = b.pos; pos.addEventListener('change', () => { b.pos = pos.value; refreshAllAnnots(); });
  const n = S.pages.length;
  return el('div', { style: 'margin:6px 0 10px 24px;display:grid;gap:6px' },
    el('div', { class: 'row' }, el('label', { for: 'batesPrefix', text: 'Prefix' }), prefix, el('label', { for: 'batesStart', text: 'From' }), start),
    el('div', { class: 'row' }, el('label', { for: 'batesDigits', text: 'Digits' }), digits, pos),
    el('p', { class: 'note', text: n ? `This document: ${batesLabel(b.start)} to ${batesLabel(b.start + n - 1)}.` : '' }));
}
function outputPanel() {
  const { watermark: wm, numbers: nb, compress: cp, protect: pr } = S.settings;
  const wmText = el('input', { class: 'field', id: 'wmText', value: wm.text, 'aria-label': 'Watermark text' });
  wmText.addEventListener('input', () => { wm.text = wmText.value; refreshAllAnnots(); });
  const wmOp = el('input', { type: 'range', min: '0.05', max: '0.5', step: '0.05', value: wm.opacity, id: 'wmOp', class: 'grow' });
  wmOp.addEventListener('input', () => { wm.opacity = Number(wmOp.value); refreshAllAnnots(); });
  const nbFmt = el('select', { class: 'field', id: 'nbFmt', 'aria-label': 'Page number style' },
    ...['Page {n} of {N}', '{n}', '{n} / {N}', '- {n} -'].map(f => el('option', { value: f, text: f.replace('{n}', '3').replace('{N}', '12') })));
  nbFmt.value = nb.format; nbFmt.addEventListener('change', () => { nb.format = nbFmt.value; refreshAllAnnots(); });
  const nbPos = el('select', { class: 'field', id: 'nbPos', 'aria-label': 'Page number position' },
    el('option', { value: 'bottom-centre', text: 'Bottom centre' }), el('option', { value: 'bottom-right', text: 'Bottom right' }));
  nbPos.value = nb.pos; nbPos.addEventListener('change', () => { nb.pos = nbPos.value; refreshAllAnnots(); });
  const pw = el('input', { class: 'field', id: 'pwUser', type: 'password', autocomplete: 'new-password', placeholder: 'Password to open', value: pr.user });
  pw.addEventListener('input', () => { pr.user = pw.value; });
  const pwO = el('input', { class: 'field', id: 'pwOwner', type: 'password', autocomplete: 'new-password', placeholder: 'Password to change restrictions (optional)', value: pr.owner });
  pwO.addEventListener('input', () => { pr.owner = pwO.value; });
  const allow = (key, label) => el('label', { class: 'toggle' }, check(pr[key], v => { pr[key] = v; }), document.createTextNode(label));
  return el('section', { class: 'sec' }, el('h3', { text: 'When saving' }),
    el('label', { class: 'toggle' }, check(wm.on, v => { wm.on = v; renderInspector(); }), document.createTextNode('Watermark')),
    wm.on ? el('div', { style: 'margin:6px 0 10px 24px' }, wmText, el('div', { class: 'row', style: 'margin-top:6px' }, el('label', { for: 'wmOp', text: 'Strength' }), wmOp)) : null,
    el('label', { class: 'toggle', style: 'margin-top:6px' }, check(nb.on, v => { nb.on = v; renderInspector(); }), document.createTextNode('Page numbers')),
    nb.on ? el('div', { style: 'margin:6px 0 10px 24px;display:grid;gap:6px' }, nbFmt, nbPos) : null,
    el('label', { class: 'toggle', style: 'margin-top:6px' }, check(S.settings.hf.on, v => { S.settings.hf.on = v; renderInspector(); }), document.createTextNode('Headers and footers')),
    S.settings.hf.on ? hfEditor() : null,
    el('label', { class: 'toggle', style: 'margin-top:6px' }, check(S.settings.bates.on, v => { S.settings.bates.on = v; renderInspector(); }), document.createTextNode('Bates numbers')),
    S.settings.bates.on ? batesEditor() : null,
    el('label', { class: 'toggle', style: 'margin-top:6px' }, check(cp.on, v => { cp.on = v; }), document.createTextNode('Reduce file size (recompress photos and scans)')),
    el('label', { class: 'toggle', style: 'margin-top:6px' }, check(S.settings.clean, v => { S.settings.clean = v; }), document.createTextNode('Remove hidden data (author, properties, attachments, scripts)')),
    el('label', { class: 'toggle', style: 'margin-top:6px' }, check(pr.on, v => { pr.on = v; renderInspector(); }), document.createTextNode('Protect with a password')),
    pr.on ? el('div', { style: 'margin:6px 0 10px 24px;display:grid;gap:6px' }, pw, el('span', { class: 'note', text: 'Restrict what others can do:' }),
      allow('allowPrint', 'Allow printing'), allow('allowCopy', 'Allow copying text'), allow('allowEdit', 'Allow changes and comments'), pwO,
      el('span', { class: 'note', text: 'Encrypted with AES-256. Without the password the file cannot be opened, including by you.' })) : null,
    el('p', { class: 'note', style: 'margin-top:10px', text: 'Every save is checked: the new file is reopened and its text compared word for word with the source pages, and every redaction is confirmed empty.' }));
}

// ---------------------------------------------------------------- saving
function sanitizeFor(font, s) {
  const set = new Set(font.getCharacterSet());
  return [...s].map(ch => (set.has(ch.codePointAt(0)) ? ch : ch === '\t' ? '    ' : '?')).join('');
}
function viewFrameOf(page) {
  // maps a point in the page as displayed (points, origin top-left) to user space
  const R = ((page.getRotation().angle % 360) + 360) % 360;
  const cb = page.getCropBox ? page.getCropBox() : { x: 0, y: 0, ...page.getSize() };
  const { x: cx, y: cy, width: cw, height: ch } = cb;
  const W = R % 180 ? ch : cw, H = R % 180 ? cw : ch;
  const map = (vx, vy) => {
    if (R === 0) return [cx + vx, cy + ch - vy];
    if (R === 90) return [cx + vy, cy + vx];
    if (R === 180) return [cx + cw - vx, cy + vy];
    return [cx + cw - vy, cy + ch - vx];
  };
  return { R, W, H, map };
}
function drawInk(page, a) {
  const c = hexToRgb(a.color);
  const ops = [pushGraphicsState(), setStrokingRgbColor(c.red, c.green, c.blue), setLineWidth(a.width),
    setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round), moveTo(a.points[0][0], a.points[0][1])];
  for (const q of a.points.slice(1)) ops.push(lineTo(q[0], q[1]));
  ops.push(stroke(), popGraphicsState());
  page.pushOperators(...ops);
}

// ---- headers, footers and Bates numbers
const SLOT_NAMES = { tl: 'Top left', tc: 'Top centre', tr: 'Top right', bl: 'Bottom left', bc: 'Bottom centre', br: 'Bottom right' };
function batesLabel(n) { const b = S.settings.bates; return (b.prefix || '') + String(n).padStart(Math.max(1, b.digits | 0), '0'); }
function fillTokens(t, k, total, fileName, bates) {
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return t.replace(/\{page\}/g, String(k + 1)).replace(/\{pages\}/g, String(total)).replace(/\{date\}/g, date)
    .replace(/\{file\}/g, baseName(fileName || '')).replace(/\{bates\}/g, bates || '');
}
// texts to place on page k, by slot: [{slot, text}]
function stampTexts(pageList, k, batesStart) {
  const out = [];
  const { hf, bates } = S.settings;
  const p = pageList[k];
  const file = S.sources[p.src] ? S.sources[p.src].name : '';
  const bl = bates.on ? batesLabel(batesStart + k) : '';
  if (hf.on) for (const [slot, t] of Object.entries(hf.slots)) if (t && t.trim()) out.push({ slot, text: fillTokens(t.trim(), k, pageList.length, file, bl) });
  if (bates.on && !(hf.on && Object.values(hf.slots).some(t => /\{bates\}/.test(t)))) {
    const same = out.find(o => o.slot === bates.pos);
    if (same) same.text = same.text + '    ' + bl; else out.push({ slot: bates.pos, text: bl });
  }
  return out;
}
// position of a slot text on a page as displayed (points, top-left origin): baseline-left
function slotPos(slot, tw, W, H, size) {
  const m = 30;
  const x = slot[1] === 'l' ? m + 6 : slot[1] === 'r' ? W - m - 6 - tw : W / 2 - tw / 2;
  const y = slot[0] === 't' ? m + size * 0.8 : H - m + size * 0.2;
  return [x, y];
}

async function buildPdf(pageList, { allowIdentity = true, batesStart = null } = {}) {
  const bStart = batesStart == null ? (S.settings.bates.start | 0) : batesStart;
  const used = [...new Set(pageList.map(p => p.src))];
  const identity = allowIdentity && S.sources.length === 1 && pageList.length === S.sources[0].numPages && pageList.every((p, i) => p.src === 0 && p.idx === i);
  const srcDocs = {};
  for (const si of used) {
    const d = await PDFDocument.load(S.sources[si].bytes, { ignoreEncryption: true, updateMetadata: false });
    const vals = S.forms[si];
    if (vals) {
      const form = d.getForm();
      for (const f of S.sources[si].fields) {
        try {
          const fld = form.getField(f.name); const v = vals[f.name];
          if (f.type === 'text') fld.setText(v || undefined);
          else if (f.type === 'check') v ? fld.check() : fld.uncheck();
          else if (f.type === 'radio') { if (v) fld.select(v); else fld.clear(); }
          else if (v) fld.select(v); else fld.clear();
        } catch (e) { console.warn('Field not written', f.name, e); }
      }
      try {
        const helv = await d.embedFont(StandardFonts.Helvetica);
        form.updateFieldAppearances(helv);
        if (S.settings.flatten || !identity) { form.flatten(); removeDanglingRefs(d); }
      } catch (e) { console.warn('Form appearance', e); }
    }
    srcDocs[si] = d;
  }
  let out;
  if (identity) out = srcDocs[0];
  else {
    out = await PDFDocument.create();
    // copy in runs from the same source to keep shared resources together
    let i = 0;
    while (i < pageList.length) {
      let j = i; while (j + 1 < pageList.length && pageList[j + 1].src === pageList[i].src) j++;
      const run = pageList.slice(i, j + 1);
      const copied = await out.copyPages(srcDocs[run[0].src], run.map(p => p.idx));
      copied.forEach(cp => out.addPage(cp));
      i = j + 1;
    }
    const first = S.sources[pageList[0].src];
    out.setTitle(baseName(first.name));
  }
  // rotation belongs to the page itself
  out.getPages().forEach((page, k) => { const p = pageList[k]; if (p.rot) page.setRotation(degrees((page.getRotation().angle + p.rot) % 360)); });

  // Stage 2: permanent removal of redacted and edited content (MuPDF)
  const jobs = [];
  pageList.forEach((p, k) => {
    const ed = p.annots.filter(a => a.type === 'edit').map(a => a.rect).concat(...p.annots.filter(a => a.type === 'pedit').map(a => a.lineRects));
    const rd = p.annots.filter(a => a.type === 'redact').map(a => a.rect);
    if (ed.length) jobs.push({ page: k, mode: 'edit', rects: ed });
    if (rd.length) jobs.push({ page: k, mode: 'redact', rects: rd });
  });
  let scanCovered = [];
  if (jobs.length) {
    const mid = await out.save({ useObjectStreams: false });
    const cleaned = await Engine.removeContent(mid, jobs);
    scanCovered = cleaned.covered || [];
    out = await PDFDocument.load(cleaned, { updateMetadata: false });
  }
  const onScan = (k, rects) => scanCovered.some(c => c.page === k && rects.some(r => r === c.rect || (r[0] === c.rect[0] && r[1] === c.rect[1] && r[2] === c.rect[2] && r[3] === c.rect[3])));
  const white = (page, r) => page.drawRectangle({ x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1], color: rgb(1, 1, 1) });

  // Stage 3: markup, replacement text, stamps, watermark and page numbers (pdf-lib)
  out.setProducer('Quire PDF'); out.setModificationDate(new Date());
  const pages = out.getPages();
  const helv = await out.embedFont(StandardFonts.Helvetica);
  const helvB = await out.embedFont(StandardFonts.HelveticaBold);
  const fontCache = new Map();
  const stdFont = async key => { if (!fontCache.has(key)) fontCache.set(key, await out.embedFont(StandardFonts[key])); return fontCache.get(key); };
  const imgCache = new Map();
  const notes = [];
  const newFields = [];
  for (let k = 0; k < pageList.length; k++) {
    const p = pageList[k]; const page = pages[k];
    for (const a of p.annots) {
      if (a.type === 'redact') { page.drawRectangle({ x: a.rect[0], y: a.rect[1], width: a.rect[2] - a.rect[0], height: a.rect[3] - a.rect[1], color: a.fill === 'white' ? rgb(1, 1, 1) : rgb(0, 0, 0) }); continue; }
      if (a.type === 'pedit') {
        if (onScan(k, a.lineRects)) white(page, peditZone(a));
        const f = await stdFont(stdFontKey(a.font));
        for (const L of a.layout || []) for (const w of L.words) {
          const t = sanitizeFor(f, w.t);
          if (t.trim()) page.drawText(t, { x: w.x, y: L.base, size: a.size, font: f, color: hexToRgb(a.color || '#000000') });
        }
        continue;
      }
      if (a.type === 'edit') {
        if (onScan(k, [a.rect])) white(page, [a.rect[0], a.rect[1], Math.max(a.rect[2], a.origin[0] + (await stdFont(stdFontKey(a.font))).widthOfTextAtSize(sanitizeFor(await stdFont(stdFontKey(a.font)), a.text || ''), a.size) + 1), a.rect[3]]);
        if (!a.text) continue;
        const f = await stdFont(stdFontKey(a.font));
        const t = sanitizeFor(f, a.text);
        page.drawText(t, { x: a.origin[0], y: a.origin[1], size: a.size, font: f, color: hexToRgb(a.color || '#000000') });
        continue;
      }
      if (a.type === 'field') { newFields.push({ k, a }); continue; }
      if (a.type === 'note') { if (a.text && a.text.trim()) notes.push({ page: k, at: a.at, text: a.text, author: a.author || S.author, color: hexToRgb(a.color) }); continue; }
      if (a.type === 'markup') {
        for (const r of a.rects) {
          if (a.kind === 'highlight') page.drawRectangle({ x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1], color: hexToRgb(a.color), opacity: 0.4, blendMode: BlendMode.Multiply });
          else {
            const y = a.kind === 'underline' ? r[1] + (r[3] - r[1]) * 0.12 : r[1] + (r[3] - r[1]) * 0.42;
            page.drawLine({ start: { x: r[0], y }, end: { x: r[2], y }, thickness: Math.max(0.6, (r[3] - r[1]) * 0.07), color: hexToRgb(a.color) });
          }
        }
        continue;
      }
      if (a.type === 'stamp') {
        const ang = Math.atan2(a.ux[1], a.ux[0]) * 180 / Math.PI;
        const at = (x, y) => [a.anchor[0] + a.ux[0] * x + a.dx[0] * y, a.anchor[1] + a.ux[1] * x + a.dx[1] * y];
        const col = hexToRgb(a.color);
        const [bx, by] = at(0, a.h);
        page.drawRectangle({ x: bx, y: by, width: a.w, height: a.h, borderColor: col, borderWidth: 2 * a.size / 16, rotate: degrees(ang) });
        const t1 = sanitizeFor(helvB, a.label), w1 = helvB.widthOfTextAtSize(t1, a.size);
        const [x1, y1] = at((a.w - w1) / 2, 6 * a.size / 16 + a.size * 0.78);
        page.drawText(t1, { x: x1, y: y1, size: a.size, font: helvB, color: col, rotate: degrees(ang) });
        if (a.sub) {
          const ss = a.subSize || 8, t2 = sanitizeFor(helv, a.sub), w2 = helv.widthOfTextAtSize(t2, ss);
          const [x2, y2] = at((a.w - w2) / 2, 6 * a.size / 16 + a.size * 0.78 + 4 * a.size / 16 + ss * 0.78);
          page.drawText(t2, { x: x2, y: y2, size: ss, font: helv, color: col, rotate: degrees(ang) });
        }
        continue;
      }
      if (a.type === 'highlight') page.drawRectangle({ x: a.rect[0], y: a.rect[1], width: a.rect[2] - a.rect[0], height: a.rect[3] - a.rect[1], color: hexToRgb(a.color), opacity: 0.4, blendMode: BlendMode.Multiply });
      else if (a.type === 'whiteout') page.drawRectangle({ x: a.rect[0], y: a.rect[1], width: a.rect[2] - a.rect[0], height: a.rect[3] - a.rect[1], color: rgb(1, 1, 1) });
      else if (a.type === 'rect') page.drawRectangle({ x: a.rect[0], y: a.rect[1], width: a.rect[2] - a.rect[0], height: a.rect[3] - a.rect[1], borderColor: hexToRgb(a.color), borderWidth: a.width });
      else if (a.type === 'ink' && a.points.length > 1) drawInk(page, a);
      else if (a.type === 'text') {
        const ang = Math.atan2(a.ux[1], a.ux[0]) * 180 / Math.PI;
        a.text.split('\n').forEach((line, i) => {
          const off = i * a.size * 1.2 + a.size * 0.93;
          const x = a.anchor[0] + a.dx[0] * off, y = a.anchor[1] + a.dx[1] * off;
          const t = sanitizeFor(helv, line);
          if (t.trim()) page.drawText(t, { x, y, size: a.size, font: helv, color: hexToRgb(a.color), rotate: degrees(ang) });
        });
      } else if (a.type === 'image') {
        let img = imgCache.get(a.img);
        if (!img) { img = await out.embedPng(S.images.get(a.img).bytes); imgCache.set(a.img, img); }
        const ang = Math.atan2(a.ux[1], a.ux[0]) * 180 / Math.PI;
        const x = a.anchor[0] + a.dx[0] * a.h, y = a.anchor[1] + a.dx[1] * a.h;
        page.drawImage(img, { x, y, width: a.w, height: a.h, rotate: degrees(ang) });
      }
    }
    const fr = viewFrameOf(page);
    const { watermark: wm, numbers: nb } = S.settings;
    if (wm.on && wm.text.trim()) {
      const t = sanitizeFor(helvB, wm.text.trim());
      const tw = helvB.widthOfTextAtSize(t, wm.size);
      // centre the text on the page as displayed, at 45 degrees
      // text runs up and to the right; start point = centre - half its length - half its cap height
      const c = Math.SQRT1_2, s = Math.SQRT1_2, half = wm.size * 0.35;
      const vx = fr.W / 2 - (tw / 2) * c + half * s;
      const vy = fr.H / 2 + (tw / 2) * s + half * c;
      const [x, y] = fr.map(vx, vy);
      page.drawText(t, { x, y, size: wm.size, font: helvB, color: rgb(0.5, 0.5, 0.5), opacity: wm.opacity, rotate: degrees(fr.R + 45) });
    }
    if (nb.on) {
      const t = nb.format.replace('{n}', k + 1).replace('{N}', pageList.length);
      const tw = helv.widthOfTextAtSize(t, nb.size);
      const vx = nb.pos === 'bottom-right' ? fr.W - 36 - tw : fr.W / 2 - tw / 2;
      const [x, y] = fr.map(vx, fr.H - 24);
      page.drawText(t, { x, y, size: nb.size, font: helv, color: rgb(0.2, 0.2, 0.2), rotate: degrees(fr.R) });
    }
    for (const st of stampTexts(pageList, k, bStart)) {
      const size = S.settings.hf.size || 9;
      const t = sanitizeFor(helv, st.text);
      const tw = helv.widthOfTextAtSize(t, size);
      const [vx, vy] = slotPos(st.slot, tw, fr.W, fr.H, size);
      const [x, y] = fr.map(vx, vy);
      page.drawText(t, { x, y, size, font: helv, color: rgb(0.1, 0.1, 0.1), rotate: degrees(fr.R) });
    }
  }
  if (newFields.length) addFormFields(out, pages, newFields, helv);
  let saved = 0;
  if (S.settings.compress.on) saved = await recompressImages(out, S.settings.compress.quality);
  let bytes = await out.save({ useObjectStreams: true });

  // Stage 4: real comments, hidden-data removal and encryption (MuPDF)
  const pr = S.settings.protect;
  const protect = pr.on && (pr.user || pr.owner) ? pr : null;
  let removed = [];
  if (notes.length || S.settings.clean || protect) {
    const f = await Engine.finalise(bytes, { notes: notes.map(n => ({ ...n, color: [n.color.red, n.color.green, n.color.blue] })), clean: S.settings.clean, protect });
    bytes = f.bytes; removed = f.removed;
  }
  const batesRange = S.settings.bates.on ? [batesLabel(bStart), batesLabel(bStart + pageList.length - 1)] : null;
  return { bytes, identity, compressedBy: saved, removed, notes: notes.length, batesRange, fields: newFields.map(f => f.a.name), batesNext: bStart + pageList.length, redactions: jobs.filter(j => j.mode === 'redact').reduce((n, j) => n + j.rects.length, 0), protect };
}

function addFormFields(out, pages, list, helv) {
  const form = out.getForm();
  const grey = rgb(0.55, 0.6, 0.66);
  for (const { k, a } of list) {
    const page = pages[k];
    const [x0, y0, x1, y1] = a.rect;
    const box = { x: x0, y: y0, width: x1 - x0, height: y1 - y0, borderWidth: 0.75, borderColor: grey, textColor: rgb(0, 0, 0) };
    let f;
    if (a.kind === 'text' || a.kind === 'paragraph') {
      f = form.createTextField(a.name);
      if (a.kind === 'paragraph') f.enableMultiline();
      f.addToPage(page, { ...box, font: helv });
      f.setFontSize(10);
    } else if (a.kind === 'checkbox') {
      f = form.createCheckBox(a.name); f.addToPage(page, box);
    } else if (a.kind === 'dropdown') {
      f = form.createDropdown(a.name); f.addOptions(a.options.length ? a.options : ['']); f.addToPage(page, { ...box, font: helv });
    } else if (a.kind === 'signature') {
      const ctx = out.context;
      const widget = ctx.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', Rect: [x0, y0, x1, y1], T: PDFHexString.fromText(a.name), F: 4, P: page.ref,
        MK: ctx.obj({ BC: [0.55, 0.6, 0.66] }), Ff: a.required ? 2 : 0 });
      const ref = ctx.register(widget);
      page.node.addAnnot(ref);
      form.acroForm.addField(ref);
      page.drawRectangle({ x: x0, y: y0, width: x1 - x0, height: y1 - y0, borderColor: grey, borderWidth: 0.75 });
      continue;
    }
    if (a.required) f.enableRequired();
  }
  form.updateFieldAppearances(helv);
}

// pdf-lib's flatten can leave page /Annots entries pointing at deleted widgets; strict readers object.
function removeDanglingRefs(doc) {
  const ctx = doc.context;
  const live = ref => { try { return ctx.lookup(ref) !== undefined; } catch { return false; } };
  for (const page of doc.getPages()) {
    const annots = page.node.lookup(PDFName.of('Annots'));
    if (!(annots instanceof PDFArray)) continue;
    const keep = annots.asArray().filter(r => !(r && r.objectNumber !== undefined) || live(r));
    if (keep.length === annots.size()) continue;
    if (keep.length) page.node.set(PDFName.of('Annots'), ctx.obj(keep)); else page.node.delete(PDFName.of('Annots'));
  }
  // orphaned parent field nodes whose kids were all removed
  let changed = true;
  while (changed) {
    changed = false;
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (!obj || typeof obj.get !== 'function' || !(obj.get(PDFName.of('Kids')) instanceof PDFArray)) continue;
      const kids = obj.get(PDFName.of('Kids'));
      const keep = kids.asArray().filter(r => !(r && r.objectNumber !== undefined) || live(r));
      if (keep.length === kids.size()) continue;
      changed = true;
      if (keep.length) obj.set(PDFName.of('Kids'), ctx.obj(keep));
      else if (obj.get(PDFName.of('T')) || obj.get(PDFName.of('FT'))) ctx.delete(ref);
      else obj.set(PDFName.of('Kids'), ctx.obj([]));
    }
  }
  const acro = doc.catalog.lookup(PDFName.of('AcroForm'));
  if (acro) {
    const fields = acro.lookup(PDFName.of('Fields'));
    if (fields instanceof PDFArray) {
      const keep = fields.asArray().filter(r => !(r && r.objectNumber !== undefined) || live(r));
      acro.set(PDFName.of('Fields'), ctx.obj(keep));
    }
  }
}

async function recompressImages(doc, quality) {
  let before = 0, after = 0;
  const maxSide = 2000;
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const d = obj.dict;
    if (d.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
    let filter = d.get(PDFName.of('Filter'));
    if (filter instanceof PDFArray) filter = filter.size() === 1 ? filter.get(0) : null;
    if (filter !== PDFName.of('DCTDecode')) continue;
    if (d.get(PDFName.of('Decode')) || d.get(PDFName.of('ImageMask'))) continue;
    let cs = d.get(PDFName.of('ColorSpace'));
    if (cs && !(cs instanceof PDFName)) {
      const arr = cs instanceof PDFArray ? cs : null;
      const n = arr && arr.size() === 2 && arr.get(0) === PDFName.of('ICCBased') ? doc.context.lookup(arr.get(1)) : null;
      const comps = n && n.dict ? n.dict.get(PDFName.of('N')) : null;
      if (!comps || comps.asNumber() !== 3) continue;
    } else if (cs && ![PDFName.of('DeviceRGB'), PDFName.of('DeviceGray')].includes(cs)) continue;
    const old = obj.contents;
    try {
      const bmp = await createImageBitmap(new Blob([old], { type: 'image/jpeg' }));
      const hasMask = !!d.get(PDFName.of('SMask'));
      const s = hasMask ? 1 : Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
      const c = new OffscreenCanvas(w, h); c.getContext('2d').drawImage(bmp, 0, 0, w, h);
      const blob = await c.convertToBlob({ type: 'image/jpeg', quality });
      const nb = new Uint8Array(await blob.arrayBuffer());
      if (nb.length >= old.length * 0.9) continue;
      const nd = d.clone(doc.context);
      nd.set(PDFName.of('Width'), PDFNumber.of(w)); nd.set(PDFName.of('Height'), PDFNumber.of(h));
      nd.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB')); nd.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
      nd.delete(PDFName.of('DecodeParms')); nd.set(PDFName.of('Length'), PDFNumber.of(nb.length));
      doc.context.assign(ref, PDFRawStream.of(nd, nb));
      before += old.length; after += nb.length;
    } catch (e) { console.warn('Image skipped', e); }
  }
  return before - after;
}

// Reopen the saved file and confirm: every source word survived in order (outside redacted or
// edited areas), nothing readable remains under a redaction, edits read as intended, and the
// password protection works.
async function verify(bytes, pageList, built) {
  const pw = built && built.protect ? built.protect.user || built.protect.owner : undefined;
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice(), password: pw }).promise;
  const problems = [], leaks = [], editIssues = [], redJobs = [], batesMissing = [];
  let redactions = 0, edits = 0;
  if (pdf.numPages !== pageList.length) problems.push(`expected ${pageList.length} pages, found ${pdf.numPages}`);
  const inside = (wb, z) => { if (!wb.rect) return false; const cx = (wb.rect[0] + wb.rect[2]) / 2, cy = (wb.rect[1] + wb.rect[3]) / 2; return cx > z[0] && cx < z[2] && cy > z[1] && cy < z[3]; };
  let checked = 0;
  for (let k = 0; k < Math.min(pdf.numPages, pageList.length); k++) {
    const p = pageList[k];
    const reds = p.annots.filter(a => a.type === 'redact').map(a => a.rect);
    const eds = p.annots.filter(a => a.type === 'edit');
    const peds = p.annots.filter(a => a.type === 'pedit');
    redactions += reds.length; edits += eds.length + peds.length;
    const zones = [...reds, ...eds.map(a => a.rect), ...peds.map(peditZone)];
    const srcItems = await pageText(p);
    const keepWords = wordBoxes(srcItems).filter(wb => !zones.some(z => inside(wb, z))).map(wb => wb.w);
    const pg = await pdf.getPage(k + 1);
    const tc = await pg.getTextContent();
    const outItems = tc.items.filter(i => 'str' in i);
    for (const i of outItems) i.style = tc.styles[i.fontName] || {};
    const outWords = wordBoxes(outItems);
    if (!isSubsequence(keepWords, outWords.map(w => w.w))) problems.push(`page ${k + 1}`);
    if (built && built.batesRange) {
      const want = batesLabel((built.batesNext - pageList.length) + k).toLowerCase();
      if (!outItems.some(i => i.str.toLowerCase().includes(want))) batesMissing.push(k + 1);
    }
    for (const z of reds) {
      const left = outWords.filter(wb => inside(wb, z));
      if (left.length) leaks.push(`page ${k + 1} (${left.map(w => w.raw).join(' ').slice(0, 40)})`);
    }
    if (reds.length) redJobs.push({ page: k, rects: reds });
    for (const a of peds) {
      const z = peditZone(a);
      const want = words(a.text);
      const got = outWords.filter(wb => inside(wb, z)).map(w => w.w);
      const nowWords = new Set(want);
      const stale = got.filter(w => !nowWords.has(w) && words(a.orig).includes(w));
      if (!isSubsequence(want, got) || stale.length) editIssues.push(`page ${k + 1}`);
    }
    for (const a of eds) {
      const want = words(a.text);
      const got = outWords.filter(wb => inside(wb, [a.rect[0], a.rect[1], Math.max(a.rect[2], a.rect[0] + 2000), a.rect[3]])).map(w => w.w);
      const stale = got.filter(w => !want.includes(w) && words(a.orig).includes(w));
      if (!isSubsequence(want, got) || stale.length) editIssues.push(`page ${k + 1}`);
    }
    checked++;
  }
  let fieldsOk = true;
  if (built && built.fields && built.fields.length) {
    const objs = (await pdf.getFieldObjects()) || {};
    const missing = built.fields.filter(n => !objs[n]);
    fieldsOk = !missing.length;
    if (missing.length) problems.push(`fields missing: ${missing.join(', ')}`);
  }
  pdf.destroy();
  if (redJobs.length) {
    // character-level proof: no visible glyph may touch a redaction area
    const left = await Engine.leakCheck(bytes, redJobs, pw);
    const byPage = {};
    for (const l of left) (byPage[l.page + 1] = byPage[l.page + 1] || []).push(l.ch);
    for (const [pg, chs] of Object.entries(byPage)) leaks.push(`page ${pg} (${chs.join('').slice(0, 30)})`);
  }
  let protection = null;
  if (built && built.protect && built.protect.user) {
    const good = await Engine.checkProtection(bytes, built.protect.user);
    const bad = await Engine.checkProtection(bytes, built.protect.user + 'x');
    protection = good.needs && good.opens && !bad.opens;
  }
  const batesOk = !batesMissing.length;
  return { ok: !problems.length && !leaks.length && !editIssues.length && protection !== false && batesOk, problems, leaks, editIssues, checked, redactions, edits, protection, batesOk };
}

function reportPanel(r, name, size, built, extra) {
  const lines = [];
  if (!r.problems.length) lines.push(`Checked ${r.checked} page${r.checked === 1 ? '' : 's'}: all source text intact.`);
  else lines.push(`Text differs from the source on ${r.problems.join(', ')}. Compare it with the original before relying on it.`);
  if (r.redactions) lines.push(r.leaks.length ? `Text is still readable under a redaction on ${r.leaks.join('; ')}. Do not send this file.` : `${r.redactions} redaction${r.redactions === 1 ? '' : 's'} confirmed: nothing readable remains underneath.`);
  if (r.edits) lines.push(r.editIssues.length ? `Edited text did not come out as intended on ${r.editIssues.join(', ')}.` : `${r.edits} text edit${r.edits === 1 ? '' : 's'} confirmed.`);
  if (built.notes) lines.push(`${built.notes} comment${built.notes === 1 ? '' : 's'} saved as PDF comments.`);
  if (built.fields && built.fields.length) lines.push(`${built.fields.length} form field${built.fields.length === 1 ? '' : 's'} added and confirmed.`);
  if (built.batesRange) lines.push(r.batesOk ? `Bates numbers ${built.batesRange[0]} to ${built.batesRange[1]} confirmed.` : 'Bates numbers could not be confirmed on every page.');
  if (built.removed && built.removed.length) lines.push(`Removed: ${built.removed.join(', ')}.`);
  else if (S.settings.clean) lines.push('No hidden data found to remove.');
  if (r.protection === true) lines.push('Password protection confirmed: the file opens only with the password.');
  else if (built.protect && !built.protect.user) lines.push('Restrictions applied; the file opens without a password.');
  else if (r.protection === false) lines.push('Password protection could not be confirmed.');
  if (extra) lines.push(extra);
  return el('section', { class: 'sec' }, el('h3', { text: 'Last save' }),
    el('div', { class: r.ok ? 'report ok' : 'report warn' }, el('strong', { text: `${name} (${fmtBytes(size)})` }), el('ul', {}, ...lines.map(t => el('li', { text: t })))));
}

// ---- saving to files on this computer (installed app or a normal browser tab, not inside Claude)
const canFS = typeof window.showSaveFilePicker === 'function' && window.self === window.top;
const PDF_TYPES = [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }];
function updateSaveUi() {
  const h = S.fileHandle;
  $('#btnSaveBack').hidden = !h;
  $('#btnSave').classList.toggle('primary', !h); $('#btnSave').classList.toggle('outline', !!h);
  $('#stSafe').textContent = h ? `Save writes your changes into ${h.name}. Save copy leaves it as it is.` : 'Your original file is never changed. Saving creates a new copy.';
}
async function pickAndOpen() {
  if (!canFS) { $('#fileOpen').click(); return; }
  let handle;
  try { [handle] = await window.showOpenFilePicker({ types: PDF_TYPES, excludeAcceptAllOption: false }); }
  catch (e) { if (e.name !== 'AbortError') $('#fileOpen').click(); return; }
  await openFromHandle(handle);
}
async function openFromHandle(handle, extra = []) {
  const f = await handle.getFile();
  const ok = await busy('Opening…', async () => openDocument(await readFile(f), f.name));
  if (ok) {
    S.fileHandle = handle; S.replaceConfirmed = null; updateSaveUi();
    if (extra.length) await busy('Adding pages…', async () => insertDocuments(await Promise.all(extra.map(h => h.getFile()))));
  }
}
function confirmReplace(name) {
  return new Promise(resolve => {
    const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Replace file' });
    const done = v => { modal.remove(); resolve(v); };
    modal.append(el('div', { class: 'dialog' }, el('h2', { text: `Replace ${name}?` }),
      el('p', { text: 'Your changes will be written into the original file. If you might need it as it was, cancel and use Save copy instead.' }),
      el('p', { class: 'note', text: 'Quire asks once for each document you open.' }),
      el('div', { class: 'actions' }, el('button', { class: 'btn outline', text: 'Cancel', onclick: () => done(false) }), el('button', { class: 'btn primary', id: 'btnConfirmReplace', text: 'Replace', onclick: () => done(true) }))));
    document.body.append(modal);
  });
}
async function writeHandle(handle, bytes) {
  const w = await handle.createWritable();
  await w.write(bytes); await w.close();
}

async function doSave(pageList, suffix, target = 'copy') {
  if (!S.pages.length) return;
  const name0 = S.sample ? 'Sample.pdf' : S.sources[pageList[0].src].name;
  let handle = null;
  if (target === 'replace') {
    handle = S.fileHandle;
    if (!handle) return doSave(pageList, suffix, 'copy');
    try {
      if ((await handle.queryPermission({ mode: 'readwrite' })) !== 'granted' && (await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') { toast('Quire was not allowed to change that file. Use Save copy instead.'); return; }
    } catch (e) { toast('That file cannot be changed from here. Use Save copy instead.'); return; }
    if (S.replaceConfirmed !== handle) { if (!(await confirmReplace(handle.name))) return; S.replaceConfirmed = handle; }
  } else if (canFS) {
    try { handle = await window.showSaveFilePicker({ suggestedName: `${baseName(name0)} ${suffix}.pdf`, types: PDF_TYPES }); }
    catch (e) { if (e.name === 'AbortError') return; handle = null; }
  }
  const pr = S.settings.protect;
  if (pr.on && !pr.user && !pr.owner) { toast('Enter a password under When saving, or turn protection off.'); return; }
  if (pr.on && /[,=]/.test(pr.user + pr.owner)) { toast('Passwords cannot contain commas or equals signs.'); return; }
  const open = document.querySelector('.tedit, .eedit'); if (open) open.blur();
  const name = name0;
  const filename = handle ? handle.name : `${baseName(name)} ${suffix}.pdf`;
  let res;
  try {
    res = await busy('Building your copy…', async () => {
      const built = await buildPdf(pageList, { allowIdentity: suffix === '(edited)' });
      const check = await verify(built.bytes, pageList, built);
      return { ...built, check };
    });
  } catch (e) { console.error(e); toast('Saving failed: ' + (e.message || e)); return; }
  const extra = res.compressedBy > 0 ? `Images recompressed, saving ${fmtBytes(res.compressedBy)}.` : (S.settings.compress.on ? 'No images could be made smaller.' : '');
  S.lastReport = reportPanel(res.check, filename, res.bytes.length, res, extra);
  renderInspector();
  if (res.check.leaks.length) { toast('Not saved: text is still readable under a redaction. See the panel on the right.', 7000); return res; }
  let ok;
  if (handle) {
    try { await writeHandle(handle, res.bytes); ok = true; }
    catch (e) { console.error(e); toast('Could not write the file: ' + (e.message || e)); return res; }
  } else ok = await saveFile(res.bytes, filename);
  if (ok) toast(res.check.ok ? `Saved ${filename}` : `Saved ${filename}, with warnings. See the panel on the right.`);
  if (ok && target === 'replace') await reopenAfterReplace(handle, res);
  return res;
}
// After writing into the original, carry on from the saved file so nothing is applied twice.
async function reopenAfterReplace(handle, res) {
  const st = S.settings, report = S.lastReport;
  const keepProtect = clone(st.protect);
  let bytes = res.bytes;
  if (res.protect && res.protect.user) { const d = await Engine.decrypt(bytes, res.protect.user); if (d.ok) bytes = d.bytes; }
  const baked = [];
  if (st.watermark.on) { st.watermark.on = false; baked.push('watermark'); }
  if (st.numbers.on) { st.numbers.on = false; baked.push('page numbers'); }
  if (st.hf.on) { st.hf.on = false; baked.push('headers and footers'); }
  if (st.bates.on) { st.bates.on = false; baked.push('Bates numbers'); }
  st.compress.on = false; st.clean = false; st.flatten = false;
  const scroll = $('#docwrap').scrollTop;
  await openDocument(bytes, handle.name);
  if (keepProtect.on) S.settings.protect = keepProtect;
  S.fileHandle = handle; S.replaceConfirmed = handle; S.lastReport = report;
  updateSaveUi(); renderInspector();
  $('#docwrap').scrollTop = scroll;
  if (baked.length) toast(`The ${baked.join(', ')} are now part of the file, so those options have been switched off.`, 6000);
}

// ---------------------------------------------------------------- sample document
async function sampleBytes() {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica); const b = await d.embedFont(StandardFonts.HelveticaBold);
  const p = d.addPage([595, 842]);
  const ink = rgb(0.1, 0.13, 0.16);
  p.drawText('SAMPLE DOCUMENT', { x: 56, y: 790, size: 9, font: b, color: rgb(0.35, 0.4, 0.45) });
  p.drawText('Letter of engagement', { x: 56, y: 760, size: 22, font: b, color: ink });
  const body = [
    'This sample shows what Quire can do. Open your own PDF to replace it; nothing here',
    'is saved anywhere and your files never leave this browser.',
    '',
    '1. Scope. The adviser will review the proposed restructuring, prepare a short',
    '   written note on the options, and attend one meeting with the board.',
    '2. Fees. The fixed fee is £1,800 plus VAT, payable within 30 days of invoice.',
    '3. Confidentiality. Both parties will keep the other\'s information confidential.',
    '',
    'Try it: highlight a clause, add a text note, fill in the form below, sign it, then',
    'drag page 2 above page 1 in the page rail and save a copy.',
  ];
  body.forEach((l, i) => p.drawText(l, { x: 56, y: 715 - i * 18, size: 11, font: f, color: ink }));
  const form = d.getForm();
  p.drawText('Client name', { x: 56, y: 498, size: 11, font: f, color: ink });
  const t = form.createTextField('client.name'); t.addToPage(p, { x: 170, y: 490, width: 260, height: 22 });
  p.drawText('Date', { x: 56, y: 462, size: 11, font: f, color: ink });
  const dt = form.createTextField('date'); dt.addToPage(p, { x: 170, y: 454, width: 140, height: 22 });
  p.drawText('Terms accepted', { x: 56, y: 426, size: 11, font: f, color: ink });
  const cb = form.createCheckBox('accepted'); cb.addToPage(p, { x: 170, y: 422, width: 16, height: 16 });
  p.drawText('Signed', { x: 56, y: 360, size: 11, font: f, color: ink });
  p.drawLine({ start: { x: 170, y: 358 }, end: { x: 430, y: 358 }, thickness: 0.6, color: ink });
  const p2 = d.addPage([595, 842]);
  p2.drawText('SAMPLE DOCUMENT', { x: 56, y: 790, size: 9, font: b, color: rgb(0.35, 0.4, 0.45) });
  p2.drawText('Schedule: meeting dates', { x: 56, y: 760, size: 18, font: b, color: ink });
  ['Board meeting: 14 November', 'Follow-up note: 21 November', 'Final review: 5 December'].forEach((l, i) => p2.drawText(l, { x: 56, y: 720 - i * 20, size: 11, font: f, color: ink }));
  return await d.save();
}

// ---------------------------------------------------------------- text recognition
async function needsOcr(src, idx) {
  if (!src.text.has(idx)) {
    const pg = await src.pdf.getPage(idx + 1); const tc = await pg.getTextContent();
    const items = tc.items.filter(it => 'str' in it); for (const it of items) it.style = tc.styles[it.fontName] || {};
    src.text.set(idx, items);
  }
  const chars = src.text.get(idx).reduce((n, it) => n + it.str.replace(/\s/g, '').length, 0);
  if (chars >= 15) return false;
  const pg = await src.pdf.getPage(idx + 1);
  const ops = await pg.getOperatorList();
  const O = pdfjsLib.OPS;
  return ops.fnArray.some(f => f === O.paintImageXObject || f === O.paintInlineImageXObject || f === O.paintImageXObjectRepeat || f === O.paintJpegXObject);
}
async function findScannedPages() {
  const out = [];
  for (const p of S.pages) if (await needsOcr(S.sources[p.src], p.idx)) out.push(p);
  return out;
}
// Recognise the given pages of one source and replace that source with a searchable copy.
async function recogniseSource(si, idxs, report) {
  const src = S.sources[si];
  const doc = await PDFDocument.load(src.bytes, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let words = 0, n = 0;
  for (const idx of idxs) {
    n++;
    report && report(`Recognising text: page ${n} of ${idxs.length}`);
    const pg = await src.pdf.getPage(idx + 1);
    const view = S.pages.find(p => p.src === si && p.idx === idx);
    const rot = (pg.rotate + (view ? view.rot : 0)) % 360;
    const base = pg.getViewport({ scale: 1, rotation: rot });
    const scale = Math.min(300 / 72, 4200 / Math.max(base.width, base.height));
    const vp = pg.getViewport({ scale, rotation: rot });
    const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await pg.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.DISABLE }).promise;
    const lines = await Ocr.recognise(c, m => { if (m.status === 'recognizing text' && report) report(`Recognising text: page ${n} of ${idxs.length} (${Math.round(m.progress * 100)}%)`); });
    words += Ocr.addTextLayer(window.PDFLib, doc.getPage(idx), font, lines, (x, y) => vp.convertToPdfPoint(x, y), scale, t => sanitizeFor(font, t));
    c.width = c.height = 0;
  }
  const bytes = await doc.save({ useObjectStreams: true });
  src.pdf.destroy();
  src.bytes = bytes;
  src.pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  src.text.clear();
  src.ocrPages = (src.ocrPages || 0) + idxs.length;
  return words;
}
async function recogniseDocument() {
  const pages = await findScannedPages();
  if (!pages.length) { toast('Every page already has text.'); return; }
  let words = 0;
  try {
    words = await busyProgress('Preparing text recognition…', async report => {
      report('Loading the text recognition engine (first time only)…');
      await Ocr.getWorker();
      const bySrc = new Map();
      for (const p of pages) { if (!bySrc.has(p.src)) bySrc.set(p.src, new Set()); bySrc.get(p.src).add(p.idx); }
      let total = 0;
      for (const [si, set] of bySrc) total += await recogniseSource(si, [...set].sort((a, b) => a - b), report);
      return total;
    });
  } catch (e) { console.error(e); toast('Text recognition failed: ' + (e.message || e)); return; }
  S.scanned = [];
  await rebuildAll();
  renderInspector();
  toast(words ? `Recognised ${words} words on ${pages.length} page${pages.length === 1 ? '' : 's'}. Search, select and redact now work on them.` : 'No text was found on those pages.', 6000);
}
async function refreshScanned() {
  try { S.scanned = await findScannedPages(); } catch { S.scanned = []; }
  renderInspector();
}

// ---------------------------------------------------------------- export to Word
function openExportDialog() {
  const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Export to Word' });
  const keep = el('input', { type: 'checkbox', id: 'expKeep' }); keep.checked = store.get('exportKeepPages', true);
  const close = () => modal.remove();
  modal.append(el('div', { class: 'dialog' }, el('h2', { text: 'Export to Word' }),
    el('p', { class: 'note', text: 'Rebuilds the text as ordinary Word paragraphs with the same fonts, sizes, indents, spacing and alignment, so it can be edited and will reflow. Your markup and settings are included, as they would be in a saved copy.' }),
    el('label', { class: 'toggle' }, keep, document.createTextNode('Keep the PDF\u2019s page breaks (best for contracts; remove them in Word to let the text reflow freely)')),
    el('div', { class: 'actions' }, el('button', { class: 'btn outline', text: 'Cancel', onclick: close }),
      el('button', { class: 'btn primary', text: 'Export', onclick: () => { store.set('exportKeepPages', keep.checked); close(); exportWord(keep.checked); } }))));
  document.body.append(modal);
}
// text of a page's runs as it reads: runs on one line touching each other join up (a word split
// across two runs), anything else is separated by a space
function runsText(items) {
  let out = '', prev = null;
  for (const it of items) {
    if (prev) {
      const [, , , d, e, f] = it.transform, [, , , pd, pe, pf] = prev.transform;
      const size = Math.abs(d) || it.height || 10;
      const sameLine = Math.abs(f - pf) < size * 0.4;
      const gap = e - (pe + prev.width);
      if (prev.hasEOL || !sameLine || gap > size * 0.12) out += ' ';
    }
    out += it.str; prev = it;
  }
  return out;
}
async function docxWords(bytes) {
  const { unzipSync } = await import('./lib/fflate.mjs');
  const files = unzipSync(bytes);
  const xml = new TextDecoder().decode(files['word/document.xml']);
  const dom = new DOMParser().parseFromString(xml, 'application/xml');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const out = [];
  for (const p of dom.getElementsByTagNameNS(W, 'p')) {
    let t = '';
    for (const n of p.getElementsByTagNameNS(W, '*')) { if (n.localName === 't') t += n.textContent; else if (n.localName === 'tab' || n.localName === 'br') t += ' '; }
    out.push(...words(t));
  }
  return out;
}
async function exportWord(keepPages = true) {
  if (!S.pages.length) return;
  const name = S.sample ? 'Sample.pdf' : S.sources[S.pages[0].src].name;
  const filename = `${baseName(name)}.docx`;
  let res;
  try {
    res = await busy('Converting to Word…', async () => {
      const pr = S.settings.protect, wasOn = pr.on; pr.on = false;
      let built;
      try { built = await buildPdf(S.pages, { allowIdentity: true }); } finally { pr.on = wasOn; }
      const layout = await Engine.pageLayout(built.bytes);
      const { zipSync, zlibSync } = await import('./lib/fflate.mjs');
      const helvDoc = await PDFDocument.create(); const helvFont = await helvDoc.embedFont(StandardFonts.Helvetica);
      const doc = await Export.toDocx(layout, { title: baseName(name), zipSync, zlibSync, keepPages, measure: t => { try { return helvFont.widthOfTextAtSize(sanitizeFor(helvFont, t), 1); } catch { return 0; } } });
      // independent check: words in the Word file against the words in the PDF, read by a different library
      const pdf = await pdfjsLib.getDocument({ data: built.bytes.slice() }).promise;
      const pdfWords = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const tc = await (await pdf.getPage(i)).getTextContent();
        // join the runs as they read, so a word split across two runs counts once
        pdfWords.push(...words(runsText(tc.items.filter(it => 'str' in it))));
      }
      pdf.destroy();
      const got = await docxWords(doc.bytes);
      const bag = new Map(); for (const w of pdfWords) bag.set(w, (bag.get(w) || 0) + 1);
      for (const w of got) bag.set(w, (bag.get(w) || 0) - 1);
      // a word one reader joins and the other splits (common in recognised scans) is not a loss
      const joined = got.join('');
      const missing = [...bag].filter(([w, n]) => n > 0 && !joined.includes(w)).reduce((a, [w, n]) => a.concat(Array(n).fill(w)), []);
      const extra = [...bag].filter(([, n]) => n < 0).reduce((a, [w, n]) => a.concat(Array(-n).fill(w)), []);
      return { doc, pdfWords: pdfWords.length, missing, extra };
    });
  } catch (e) { console.error(e); toast('Export failed: ' + (e.message || e)); return; }
  const st = res.doc.stats;
  const ok = !res.missing.length;
  const lines = [
    ok ? `All ${res.pdfWords.toLocaleString('en-GB')} words carried over.` : `${res.missing.length} word${res.missing.length === 1 ? '' : 's'} missing from the Word file (${res.missing.slice(0, 8).join(', ')}${res.missing.length > 8 ? '…' : ''}).`,
    `${st.paragraphs} paragraphs over ${st.pages} page${st.pages === 1 ? '' : 's'}${st.images ? `, ${st.images} image${st.images === 1 ? '' : 's'}` : ''}.`,
    keepPages ? 'Page breaks follow the PDF.' : 'Text flows freely between pages.',
  ];
  if (st.skippedChars) lines.push(`${st.skippedChars} characters of rotated text were left out.`);
  lines.push('Open it in Word and check the last line of each page: occasionally a line breaks one word earlier or later than in the PDF.');
  S.lastReport = el('section', { class: 'sec' }, el('h3', { text: 'Word export' }),
    el('div', { class: ok ? 'report ok' : 'report warn' }, el('strong', { text: `${filename} (${fmtBytes(res.doc.bytes.length)})` }), el('ul', {}, ...lines.map(t => el('li', { text: t })))));
  renderInspector();
  if (await saveFile(res.doc.bytes, filename, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')) toast(`Saved ${filename}`);
}

// ---------------------------------------------------------------- batch processing
function openBatchDialog() {
  const st = S.settings;
  const files = { list: [] };
  const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Process several files' });
  const listBox = el('div', { class: 'note', text: 'No files chosen yet.' });
  const pick = el('input', { type: 'file', accept: 'application/pdf,.pdf', multiple: 'multiple', hidden: 'hidden', id: 'batchFiles' });
  pick.onchange = () => {
    files.list = [...pick.files].filter(f => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name)).sort((a, b) => a.name.localeCompare(b.name, 'en-GB', { numeric: true }));
    listBox.textContent = files.list.length ? `${files.list.length} file${files.list.length === 1 ? '' : 's'}, processed in this order: ${files.list.map(f => f.name).join(', ')}` : 'No PDF files chosen.';
  };
  const opt = (id, label, on = false) => { const c = el('input', { type: 'checkbox', id }); c.checked = on; return [c, el('label', { class: 'toggle' }, c, document.createTextNode(label))]; };
  const [cOcr, lOcr] = opt('bOcr', 'Recognise text on scanned pages', true);
  const [cRed, lRed] = opt('bRed', 'Redact personal details');
  const pats = Object.entries(PATTERNS).map(([k, p]) => { const c = el('input', { type: 'checkbox', 'data-k': k }); c.checked = ['email', 'phone', 'bank', 'ni'].includes(k); return el('label', { class: 'toggle' }, c, document.createTextNode(p.label)); });
  const redWords = el('input', { class: 'field', id: 'bRedWords', placeholder: 'Also redact these words or names (separate with commas)' });
  const [cClean, lClean] = opt('bClean', 'Remove hidden data', st.clean);
  const [cComp, lComp] = opt('bComp', 'Reduce file size', st.compress.on);
  const [cFlat, lFlat] = opt('bFlat', 'Flatten forms', st.flatten);
  const [cWm, lWm] = opt('bWm', `Watermark \u201c${st.watermark.text || 'DRAFT'}\u201d`, st.watermark.on);
  const [cHf, lHf] = opt('bHf', 'Headers and footers as set under When saving', st.hf.on);
  const [cBates, lBates] = opt('bBates', 'Bates numbers, continuing from one file to the next', st.bates.on);
  const bPrefix = el('input', { class: 'field', id: 'bPrefix', value: st.bates.prefix, style: 'width:90px', 'aria-label': 'Bates prefix' });
  const bStart = el('input', { type: 'number', class: 'field', id: 'bStart', value: st.bates.start, style: 'width:100px', 'aria-label': 'First Bates number' });
  const [cPw, lPw] = opt('bPw', 'Protect each file with a password');
  const pw = el('input', { type: 'password', class: 'field', id: 'bPwText', autocomplete: 'new-password', placeholder: 'Password' });
  const close = () => modal.remove();
  const run = async () => {
    if (!files.list.length) { toast('Choose the files to process first.'); return; }
    if (cPw.checked && (!pw.value || /[,=]/.test(pw.value))) { toast(pw.value ? 'Passwords cannot contain commas or equals signs.' : 'Enter the password to use.'); return; }
    const words = redWords.value.split(',').map(t => t.trim()).filter(t => t.length >= 2);
    const opts = {
      ocr: cOcr.checked,
      redact: cRed.checked ? { patterns: pats.map(l => l.querySelector('input')).filter(c => c.checked).map(c => c.dataset.k), words } : null,
      clean: cClean.checked, compress: cComp.checked, flatten: cFlat.checked, watermark: cWm.checked, hf: cHf.checked,
      bates: cBates.checked ? { prefix: bPrefix.value, start: Math.max(0, Number(bStart.value) | 0) } : null,
      password: cPw.checked ? pw.value : null,
    };
    close();
    await runBatch(files.list, opts);
  };
  modal.append(el('div', { class: 'dialog' }, el('h2', { text: 'Process several files' }),
    el('div', { class: 'row' }, el('button', { class: 'btn outline', text: 'Choose PDFs\u2026', onclick: () => pick.click() }), pick), listBox,
    el('div', { style: 'display:grid;gap:6px' }, lOcr, lRed,
      el('div', { style: 'margin-left:24px;display:grid;gap:4px' }, ...pats, redWords),
      lClean, lComp, lFlat, lWm, lHf, lBates, el('div', { class: 'row', style: 'margin-left:24px' }, el('span', { class: 'note', text: 'Prefix' }), bPrefix, el('span', { class: 'note', text: 'from' }), bStart),
      lPw, el('div', { style: 'margin-left:24px' }, pw)),
    el('p', { class: 'note', text: 'Each file is processed and checked on this computer. The results are saved together in one zip with a report; your originals are not changed.' }),
    el('div', { class: 'actions' }, el('button', { class: 'btn outline', text: 'Cancel', onclick: close }), el('button', { class: 'btn primary', text: 'Process', onclick: run }))));
  document.body.append(modal);
}

async function processOne(file, opts, batesStart, report) {
  const keep = { sources: S.sources, pages: S.pages, forms: S.forms, settings: S.settings };
  S.sources = []; S.pages = []; S.forms = {};
  S.settings = clone(keep.settings);
  const st = S.settings;
  st.clean = opts.clean; st.compress.on = opts.compress; st.flatten = opts.flatten; st.watermark.on = opts.watermark; st.hf.on = opts.hf;
  st.bates.on = !!opts.bates; if (opts.bates) { st.bates.prefix = opts.bates.prefix; }
  st.protect = opts.password ? { on: true, user: opts.password, owner: '', allowPrint: true, allowCopy: true, allowEdit: true } : { on: false, user: '', owner: '', allowPrint: true, allowCopy: true, allowEdit: true };
  const result = { name: file.name, ok: false, notes: [] };
  try {
    const si = await addSource(await readFile(file), file.name);
    const src = S.sources[si];
    if (src.fields.length) S.forms[si] = src.initialValues;
    for (let i = 0; i < src.numPages; i++) S.pages.push({ uid: uid(), src: si, idx: i, rot: 0, annots: [] });
    result.pages = src.numPages;
    if (src.protectedWith && !opts.password) { st.protect = { on: true, user: src.protectedWith, owner: '', allowPrint: true, allowCopy: true, allowEdit: true }; result.notes.push('kept its existing password'); }
    if (opts.ocr) {
      const idxs = [];
      for (const p of S.pages) if (await needsOcr(src, p.idx)) idxs.push(p.idx);
      if (idxs.length) {
        await Ocr.getWorker();
        const w = await recogniseSource(si, idxs, t => report(`${file.name}: ${t.toLowerCase()}`));
        result.notes.push(`text recognised on ${idxs.length} page${idxs.length === 1 ? '' : 's'} (${w} words)`);
      }
    }
    if (opts.redact && (opts.redact.patterns.length || opts.redact.words.length)) {
      report(`${file.name}: finding details to redact`);
      const parts = opts.redact.patterns.map(k => PATTERNS[k].re().source).concat(opts.redact.words.map(escapeRe));
      const found = await Engine.findMatches(src.bytes, S.pages.map(p => ({ key: p.uid, page: p.idx })), parts.map(x => `(?:${x})`).join('|'), 'gi');
      let n = 0;
      for (const p of S.pages) for (const m of found[p.uid] || []) { p.annots.push({ id: uid(), type: 'redact', rect: [m.rect[0] - 0.5, m.rect[1] - 0.5, m.rect[2] + 0.5, m.rect[3] + 0.5], fill: 'black' }); n++; }
      result.notes.push(n ? `${n} item${n === 1 ? '' : 's'} redacted` : 'nothing found to redact');
    }
    report(`${file.name}: building and checking`);
    const built = await buildPdf(S.pages, { allowIdentity: true, batesStart });
    const check = await verify(built.bytes, S.pages, built);
    Object.assign(result, { bytes: built.bytes, built, check, ok: check.ok });
    if (built.batesRange) result.notes.push(`Bates ${built.batesRange[0]} to ${built.batesRange[1]}`);
    if (built.removed && built.removed.length) result.notes.push(`removed ${built.removed.join(', ')}`);
    if (check.protection === true) result.notes.push('password protection confirmed');
    if (!check.ok) result.notes.push('CHECK FAILED: ' + [...check.problems, ...check.leaks.map(l => 'text under redaction on ' + l), ...check.editIssues].join('; '));
  } catch (e) {
    result.notes.push(e.name === 'Cancelled' ? 'skipped (no password given)' : 'could not be processed: ' + (e.message || e));
  } finally {
    for (const s of S.sources) { try { s.pdf.destroy(); } catch { /* ignore */ } }
    S.sources = keep.sources; S.pages = keep.pages; S.forms = keep.forms; S.settings = keep.settings;
  }
  return result;
}

async function runBatch(files, opts) {
  const results = [];
  let next = opts.bates ? opts.bates.start : 0;
  await busyProgress('Starting…', async report => {
    for (const [i, f] of files.entries()) {
      report(`File ${i + 1} of ${files.length}: ${f.name}`);
      const r = await processOne(f, opts, next, t => report(`File ${i + 1} of ${files.length}: ${t}`));
      if (r.built && opts.bates) next = r.built.batesNext;
      results.push(r);
    }
  });
  const okOnes = results.filter(r => r.ok && r.bytes);
  const stamp = new Date().toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const lines = [`Quire PDF batch report, ${stamp}`, '', `Files: ${files.length}. Processed and checked: ${okOnes.length}.`, ''];
  for (const r of results) {
    lines.push(`${r.ok ? 'OK' : 'NOT INCLUDED'}  ${r.name}${r.pages ? ` (${r.pages} page${r.pages === 1 ? '' : 's'})` : ''}`);
    for (const n of r.notes) lines.push(`    ${n}`);
    if (r.ok) lines.push(`    all source text intact${r.check.redactions ? '; every redaction confirmed empty' : ''}`);
    lines.push('');
  }
  const report = lines.join('\r\n');
  const { zipSync } = await import('./lib/fflate.mjs');
  const filesOut = { 'Batch report.txt': new TextEncoder().encode(report + '\n') };
  for (const r of okOnes) filesOut[`${baseName(r.name)} (processed).pdf`] = r.bytes;
  const zip = zipSync(filesOut, { level: 0 });
  const failed = results.length - okOnes.length;
  S.lastReport = el('section', { class: 'sec' }, el('h3', { text: 'Batch' }), el('div', { class: failed ? 'report warn' : 'report ok' },
    el('strong', { text: `${okOnes.length} of ${results.length} files processed` }),
    el('ul', {}, ...results.map(r => el('li', { text: `${r.name}: ${r.ok ? 'done' : 'not included'}${r.notes.length ? ' (' + r.notes.join('; ') + ')' : ''}` })))));
  renderInspector();
  if (await saveFile(zip, `Batch ${new Date().toISOString().slice(0, 10)}.zip`, 'application/zip')) toast(failed ? `Saved ${okOnes.length} files; ${failed} not included. See the report.` : `Saved ${okOnes.length} processed files.`);
}

// ---------------------------------------------------------------- compare
async function readPdfForCompare(file) {
  let bytes = await readFile(file);
  if (hasEncryptDict(bytes)) {
    let res = await Engine.decrypt(bytes, ''), msg = `${file.name} is protected with a password.`;
    while (!res.ok) { const pw = await askPassword(msg); if (pw == null) return null; res = await Engine.decrypt(bytes, pw); msg = 'That password did not work. Try again.'; }
    bytes = res.bytes;
  }
  return pdfjsLib.getDocument({ data: bytes }).promise;
}
// sort text runs top to bottom, then left to right, so text added at the end of a page's
// content stream (an edit, say) is compared where it is read
function readingOrder(items) {
  const keyed = items.map((it, i) => ({ it, i, y: it.transform[5], x: it.transform[4], h: Math.abs(it.transform[3]) || it.height || 10 }));
  keyed.sort((a, b) => (Math.abs(a.y - b.y) < Math.min(a.h, b.h) * 0.5 ? a.x - b.x : b.y - a.y) || a.i - b.i);
  return keyed.map(k => k.it);
}
async function compareWith(file) {
  const other = await readPdfForCompare(file);
  if (!other) return;
  await busy('Comparing…', async () => {
    // words of this document with positions
    const mine = [];
    for (const p of S.pages) for (const wb of wordBoxes(readingOrder(await pageText(p)))) mine.push({ ...wb, page: p.uid });
    const theirs = [];
    for (let i = 1; i <= other.numPages; i++) {
      const pg = await other.getPage(i); const tc = await pg.getTextContent();
      for (const wb of wordBoxes(readingOrder(tc.items.filter(it => 'str' in it)))) theirs.push({ ...wb, page: i });
    }
    other.destroy();
    const ops = diff(mine.map(w => w.w), theirs.map(w => w.w));
    if (!ops) { toast('These documents are too different to compare word by word.'); return; }
    const marks = new Map();
    const add = (u, m) => { if (!marks.has(u)) marks.set(u, []); marks.get(u).push(m); };
    const list = [];
    for (const ch of diffChanges(ops)) {
      const del = mine.slice(ch.aFrom, ch.aTo), ins = theirs.slice(ch.bFrom, ch.bTo);
      for (const w of del) if (w.rect) add(w.page, { rect: w.rect, kind: 'del' });
      let anchor = del[0] || mine[ch.aFrom] || mine[ch.aFrom - 1];
      if (!del.length && anchor && anchor.rect) add(anchor.page, { rect: anchor.rect, kind: 'ins' });
      const pi = anchor ? S.pages.findIndex(p => p.uid === anchor.page) : -1;
      list.push({ del: del.map(w => w.raw).join(' '), ins: ins.map(w => w.raw).join(' '), page: anchor && anchor.rect ? anchor.page : null, rect: anchor && anchor.rect,
        pageLabel: pi >= 0 ? `Page ${pi + 1}${ins.length ? ` \u00b7 their page ${ins[0].page}` : ''}` : '' });
    }
    S.compare = { name: file.name, changes: list, marks };
  });
  refreshAllAnnots(); renderInspector();
  if (S.compare) toast(S.compare.changes.length ? `Found ${S.compare.changes.length} change${S.compare.changes.length === 1 ? '' : 's'}.` : 'No wording differences.');
}

// ---------------------------------------------------------------- bookmarks
async function renderBookmarks() {
  const box = $('#marks');
  box.replaceChildren();
  const si = S.pages.length ? S.pages[0].src : 0;
  const src = S.sources[si];
  const outline = src ? await src.pdf.getOutline() : null;
  if (!outline || !outline.length) { box.append(el('p', { class: 'note', style: 'padding:8px', text: 'This document has no bookmarks.' })); return; }
  const go = async dest => {
    try {
      const d = typeof dest === 'string' ? await src.pdf.getDestination(dest) : dest;
      if (!d) return;
      const idx = typeof d[0] === 'number' ? d[0] : await src.pdf.getPageIndex(d[0]);
      const p = S.pages.find(q => q.src === si && q.idx === idx);
      if (!p) { toast('That page is no longer in the document.'); return; }
      views.get(p.uid).div.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch { toast('That bookmark does not point to a page.'); }
  };
  const walk = async (items, depth) => {
    for (const it of items) {
      let pageNo = '';
      try { const d = typeof it.dest === 'string' ? await src.pdf.getDestination(it.dest) : it.dest; if (d) { const idx = typeof d[0] === 'number' ? d[0] : await src.pdf.getPageIndex(d[0]); const k = S.pages.findIndex(q => q.src === si && q.idx === idx); pageNo = k >= 0 ? String(k + 1) : ''; } } catch { /* no page */ }
      const b = el('button', { class: 'mark-item', style: `padding-left:${8 + depth * 14}px` }, el('span', { class: 'pg', text: pageNo }), document.createTextNode(it.title));
      b.addEventListener('click', () => go(it.dest));
      box.append(b);
      if (it.items && it.items.length) await walk(it.items, depth + 1);
    }
  };
  await walk(outline, 0);
}
function setRailTab(t) {
  S.railTab = t;
  $('#tabPages').setAttribute('aria-selected', String(t === 'pages'));
  $('#tabMarks').setAttribute('aria-selected', String(t === 'marks'));
  $('#thumbs').hidden = t !== 'pages'; $('#railHead').hidden = t !== 'pages'; $('#railHint').hidden = t !== 'pages';
  $('#marks').hidden = t !== 'marks';
  if (t === 'marks') renderBookmarks();
}

// ---------------------------------------------------------------- new pages
async function insertNewSource(bytes, name, count = 1) {
  snapshot();
  const sel = selectedIndexes();
  const at = sel.length ? Math.max(...sel) + 1 : S.pages.length;
  const si = await addSource(bytes, name);
  const fresh = Array.from({ length: S.sources[si].numPages }, (_, i) => ({ uid: uid(), src: si, idx: i, rot: 0, annots: [] }));
  S.pages.splice(at, 0, ...fresh);
  S.selPages.clear(); fresh.forEach(f => S.selPages.add(f.uid));
  if (S.sample) { S.sample = false; $('#stName').textContent = S.sources[0].name; }
  await rebuildAll();
  views.get(fresh[0].uid)?.div.scrollIntoView({ block: 'start' });
}
async function insertBlank() {
  const sel = selectedIndexes();
  const ref = S.pages[sel.length ? Math.max(...sel) : S.pages.length - 1];
  let w = 595.28, h = 841.89;
  if (ref) { const vp = await viewportFor(ref, 1); w = vp.width; h = vp.height; }
  const d = await PDFDocument.create(); d.addPage([w, h]);
  await insertNewSource(await d.save(), 'Blank page');
  toast('Blank page inserted.');
}
async function insertImagePages(files) {
  const d = await PDFDocument.create();
  for (const f of files) {
    let bytes = new Uint8Array(await f.arrayBuffer());
    let img;
    try {
      if (/jpe?g$/i.test(f.type) || /\.jpe?g$/i.test(f.name)) img = await d.embedJpg(bytes);
      else if (/png$/i.test(f.type)) img = await d.embedPng(bytes);
      else { const bmp = await createImageBitmap(f); const c = new OffscreenCanvas(bmp.width, bmp.height); c.getContext('2d').drawImage(bmp, 0, 0);
        img = await d.embedPng(new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer())); }
    } catch { toast(`${f.name} could not be read as an image.`); continue; }
    const land = img.width > img.height;
    const W = land ? 841.89 : 595.28, H = land ? 595.28 : 841.89, m = 28;
    const sc = Math.min((W - 2 * m) / img.width, (H - 2 * m) / img.height);
    const page = d.addPage([W, H]);
    page.drawImage(img, { x: (W - img.width * sc) / 2, y: (H - img.height * sc) / 2, width: img.width * sc, height: img.height * sc });
  }
  if (!d.getPageCount()) return;
  await insertNewSource(await d.save(), files.length === 1 ? files[0].name : 'Images');
  toast(`Inserted ${d.getPageCount()} image page${d.getPageCount() === 1 ? '' : 's'}.`);
}

// ---------------------------------------------------------------- split
function parseRanges(text, n) {
  const parts = [];
  for (const chunk of text.split(/[;,]/).map(t => t.trim()).filter(Boolean)) {
    const m = chunk.match(/^(\d+)\s*(?:-|to|\u2013)\s*(\d+|end)$/i) || chunk.match(/^(\d+)$/);
    if (!m) return { error: `\u201c${chunk}\u201d is not a page or range.` };
    const a = Number(m[1]), b = m[2] ? (m[2].toLowerCase() === 'end' ? n : Number(m[2])) : a;
    if (a < 1 || b > n || a > b) return { error: `\u201c${chunk}\u201d is outside pages 1 to ${n}.` };
    parts.push([a, b]);
  }
  return parts.length ? { parts } : { error: 'Enter at least one page range.' };
}
function openSplitDialog() {
  const n = S.pages.length;
  const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Split' });
  const every = el('input', { type: 'number', class: 'field', id: 'splitEvery', min: '1', max: String(n), value: String(Math.max(1, Math.min(n, 2))), style: 'width:80px' });
  const ranges = el('input', { class: 'field', id: 'splitRanges', placeholder: `e.g. 1-3, 4-${Math.max(4, n)}` });
  const mode = { v: 'every' };
  const rEvery = el('input', { type: 'radio', name: 'splitMode', id: 'smEvery', checked: 'checked' });
  const rRanges = el('input', { type: 'radio', name: 'splitMode', id: 'smRanges' });
  rEvery.onchange = () => { mode.v = 'every'; }; rRanges.onchange = () => { mode.v = 'ranges'; };
  ranges.addEventListener('focus', () => { rRanges.checked = true; mode.v = 'ranges'; });
  const close = () => modal.remove();
  const go = async () => {
    let parts = [];
    if (mode.v === 'every') { const k = Math.max(1, Number(every.value) || 1); for (let i = 1; i <= n; i += k) parts.push([i, Math.min(n, i + k - 1)]); }
    else { const r = parseRanges(ranges.value, n); if (r.error) { toast(r.error); return; } parts = r.parts; }
    if (parts.length < 2 && mode.v === 'every') { toast('That would make only one file.'); return; }
    close();
    await splitInto(parts);
  };
  modal.append(el('div', { class: 'dialog' }, el('h2', { text: 'Split into separate PDFs' }),
    el('label', { class: 'toggle' }, rEvery, document.createTextNode('Every '), every, document.createTextNode(' pages')),
    el('label', { class: 'toggle' }, rRanges, document.createTextNode('By ranges')), ranges,
    el('p', { class: 'note', text: `The ${n} pages as they stand now, with your markup, become separate files saved together in one zip.` }),
    el('div', { class: 'actions' }, el('button', { class: 'btn outline', text: 'Cancel', onclick: close }), el('button', { class: 'btn primary', text: 'Split', onclick: go }))));
  document.body.append(modal);
}
async function splitInto(parts) {
  const base = baseName(S.sample ? 'Sample.pdf' : S.sources[S.pages[0].src].name);
  const files = {};
  let allOk = true;
  await busy(`Building ${parts.length} files…`, async () => {
    for (const [a, b] of parts) {
      const list = S.pages.slice(a - 1, b);
      const built = await buildPdf(list, { allowIdentity: false });
      const chk = await verify(built.bytes, list, built);
      if (!chk.ok) allOk = false;
      files[`${base} part ${Object.keys(files).length + 1} (${a === b ? 'p' + a : 'pp' + a + '-' + b}).pdf`] = built.bytes;
    }
  });
  const { zipSync } = await import('./lib/fflate.mjs');
  const zip = zipSync(files, { level: 0 });
  const ok = await saveFile(zip, `${base} (split).zip`, 'application/zip');
  S.lastReport = el('section', { class: 'sec' }, el('h3', { text: 'Last save' }), el('div', { class: allOk ? 'report ok' : 'report warn',
    text: `${parts.length} files in ${base} (split).zip. ${allOk ? 'Every file checked: all source text intact.' : 'At least one file did not pass the text check; compare before relying on it.'}` }));
  renderInspector();
  if (ok) toast(`Saved ${parts.length} files in one zip.`);
}

// ---------------------------------------------------------------- wiring
function wire() {
  $('#btnOpen').onclick = () => pickAndOpen();
  $('#btnInsert').onclick = () => $('#fileInsert').click();
  $('#fileOpen').onchange = async () => { const f = $('#fileOpen').files[0]; $('#fileOpen').value = ''; if (f) await busy('Opening…', async () => openDocument(await readFile(f), f.name)); };
  $('#fileInsert').onchange = async () => { const fs = [...$('#fileInsert').files]; $('#fileInsert').value = ''; if (fs.length) await busy('Adding pages…', () => insertDocuments(fs)); };
  $$('#tools .btn').forEach(b => b.onclick = () => setTool(b.dataset.tool));
  $('#btnUndo').onclick = undo;
  // light and dark mode: follows Windows until a choice is made, then remembers it
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const effectiveTheme = () => document.documentElement.dataset.theme || (darkQuery.matches ? 'dark' : 'light');
  const applyTheme = t => {
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    const dark = effectiveTheme() === 'dark', b = $('#btnTheme'), label = dark ? 'Switch to light mode' : 'Switch to dark mode';
    b.classList.toggle('is-dark', dark); b.title = label; b.setAttribute('aria-label', label);
    const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.content = dark ? '#121c25' : '#1c2b38';
  };
  applyTheme(store.get('theme', null));
  darkQuery.addEventListener?.('change', () => applyTheme(store.get('theme', null)));
  $('#btnTheme').onclick = () => { const next = effectiveTheme() === 'dark' ? 'light' : 'dark'; store.set('theme', next); applyTheme(next); };
  $('#btnSave').onclick = () => doSave(S.pages, '(edited)', 'copy');
  $('#btnSaveBack').onclick = () => doSave(S.pages, '(edited)', 'replace');
  $('#pRotL').onclick = () => rotateSelected(-90);
  $('#pRotR').onclick = () => rotateSelected(90);
  $('#pDel').onclick = deleteSelected;
  $('#pBlank').onclick = () => insertBlank();
  $('#pImage').onclick = () => $('#filePageImage').click();
  $('#filePageImage').onchange = async () => { const fs = [...$('#filePageImage').files]; $('#filePageImage').value = ''; if (fs.length) await busy('Adding images…', () => insertImagePages(fs)); };
  $('#pSplit').onclick = openSplitDialog;
  $('#btnCompare').onclick = () => $('#fileCompare').click();
  $('#btnWord').onclick = openExportDialog;
  $('#btnBatch').onclick = openBatchDialog;
  $('#fileCompare').onchange = async () => { const f = $('#fileCompare').files[0]; $('#fileCompare').value = ''; if (f) await compareWith(f); };
  $('#tabPages').onclick = () => setRailTab('pages');
  $('#tabMarks').onclick = () => setRailTab('marks');
  $('#pExtract').onclick = () => {
    const sel = selectedIndexes();
    if (!sel.length) { toast('Select the pages to extract in the page rail first.'); return; }
    const list = sel.map(i => S.pages[i]);
    const label = sel.length === 1 ? `p${sel[0] + 1}` : `pp${sel[0] + 1}-${sel[sel.length - 1] + 1}`;
    doSave(list, `(${label})`);
  };
  const zoomTo = async z => { S.fitMode = false; S.zoom = Math.max(0.3, Math.min(4, z)); await rebuildAll(); };
  $('#zIn').onclick = () => zoomTo(S.zoom * 1.2);
  $('#zOut').onclick = () => zoomTo(S.zoom / 1.2);
  $('#zFit').onclick = async () => { S.fitMode = true; await rebuildAll(); };
  let qt = null;
  $('#q').addEventListener('input', () => { clearTimeout(qt); qt = setTimeout(() => runSearch($('#q').value), 250); });
  $('#q').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); const n = S.search.hits.length; if (n) showHit(e.shiftKey ? (S.search.cur - 1 + n) % n : (S.search.cur + 1) % n); } });
  $('#qNext').onclick = () => { const n = S.search.hits.length; if (n) showHit((S.search.cur + 1) % n); };
  $('#qPrev').onclick = () => { const n = S.search.hits.length; if (n) showHit((S.search.cur - 1 + n) % n); };
  $('#docwrap').addEventListener('scroll', () => requestAnimationFrame(updateStatusPage), { passive: true });
  let rt = null;
  window.addEventListener('resize', () => { if (!S.fitMode) return; clearTimeout(rt); rt = setTimeout(rebuildAll, 250); });

  document.addEventListener('keydown', e => {
    if (e.target.matches('input, textarea, select')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); doSave(S.pages, '(edited)', S.fileHandle && !e.shiftKey ? 'replace' : 'copy'); }
    else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    else if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); pickAndOpen(); }
    else if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#q').focus(); }
    else if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); $('#zIn').click(); }
    else if (mod && (e.key === '-' || e.key === '_')) { e.preventDefault(); $('#zOut').click(); }
    else if (mod && e.key === '0') { e.preventDefault(); $('#zFit').click(); }
    else if (e.key === '?') { e.preventDefault(); showShortcuts(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && S.selAnnot) { e.preventDefault(); deleteSelectedAnnot(); }
    else if (e.key === 'Escape') { S.pendingSig = null; if (S.selAnnot) { const u = S.selAnnot.page; S.selAnnot = null; drawAnnots(u); } setTool('select'); }
    else if (!mod) {
      const map = { v: 'select', h: 'highlight', t: 'text', d: 'ink', r: 'rect', w: 'whiteout', s: 'sign', n: 'note', p: 'stamp', e: 'edit', x: 'redact', f: 'field' };
      if (map[e.key.toLowerCase()]) setTool(map[e.key.toLowerCase()]);
    }
  });

  // drag and drop files onto the document
  const wrap = $('#docwrap'); let veil = null;
  wrap.addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    if (!veil) { veil = el('div', { class: 'drop-veil', text: S.sources.length && !S.sample ? 'Drop to open. Hold Shift to add the pages to this document.' : 'Drop a PDF to open it' }); wrap.append(veil); }
  });
  wrap.addEventListener('dragleave', e => { if (veil && !wrap.contains(e.relatedTarget)) { veil.remove(); veil = null; } });
  wrap.addEventListener('drop', async e => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault(); veil?.remove(); veil = null;
    // ask for the file handle now, while the drop is current, so Save can write back to it
    const item = e.dataTransfer.items && e.dataTransfer.items[0];
    const handleP = canFS && item && item.getAsFileSystemHandle ? item.getAsFileSystemHandle().catch(() => null) : Promise.resolve(null);
    const files = [...e.dataTransfer.files].filter(f => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
    if (!files.length) { toast('Only PDF files can be opened.'); return; }
    if (e.shiftKey && S.sources.length && !S.sample) await busy('Adding pages…', () => insertDocuments(files));
    else {
      await busy('Opening…', async () => { await openDocument(await readFile(files[0]), files[0].name); if (files.length > 1) await insertDocuments(files.slice(1)); });
      const h = await handleP;
      if (h && h.kind === 'file' && files.length === 1 && S.sources.length === 1) { S.fileHandle = h; S.replaceConfirmed = null; updateSaveUi(); }
    }
  });
}

S.author = store.get('author', '');
wire();
renderInspector();
await openDocument(await sampleBytes(), 'Sample.pdf', { sample: true });
// the tour greets you on start until you tick "Don't show on start"; not when Quire was opened with a file
let launchedWithFile = false;
$('#stVer').textContent = `Quire ${APP_VERSION}`;
$('#stVer').onclick = () => showWhatsNew();
setTimeout(() => {
  if (launchedWithFile || document.querySelector('.modal')) return;
  const seen = store.get('seenVersion', null);
  // after an update: what's new (unless switched off); otherwise the tour (unless switched off)
  if (seen && newer(APP_VERSION, seen) && !store.get('whatsNewOff', false)) return showWhatsNew({ since: seen, onStart: true });
  if (!seen && store.get('tourHidden', false) && !store.get('whatsNewOff', false)) return showWhatsNew({ since: RELEASES[1].v, onStart: true });
  store.set('seenVersion', APP_VERSION);
  if (!store.get('tourHidden', false)) startTour();
}, 700);
// When installed as an app and chosen to open a PDF from File Explorer, open that file.
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async params => {
    if (!params.files || !params.files.length) return;
    launchedWithFile = true; endTour();
    const handles = params.files.filter(h => h.kind === 'file' && /\.pdf$/i.test(h.name));
    if (!handles.length) return;
    await openFromHandle(handles[0], handles.slice(1));
  });
}
window.__quire = { S, APP_VERSION, showWhatsNew, startTour, endTour, openFromHandle, layoutPedit, views, rectU2V, exportWord, recogniseDocument, detectFields, buildPdf, verify, openDocument, insertDocuments, setTool, runSearch, doSave, compareWith, splitInto, insertBlank };
