// Word-level comparison of two documents (Myers' O(ND) difference algorithm).

export function diff(a, b, maxD = 4000) {
  const n = a.length, m = b.length, max = n + m;
  const v = new Int32Array(2 * max + 2);
  const trace = [];
  const off = max;
  let found = -1;
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(v.slice(off - d, off + d + 1 + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null; // too different to compare usefully
  // backtrack
  const ops = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const vv = trace[d]; // snapshot taken before step d, indexed from -(d) .. d
    const get = k => vv[k + d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && get(k - 1) < get(k + 1))) ? k + 1 : k - 1;
    const prevX = get(prevK), prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push(['=', x - 1, y - 1]); x--; y--; }
    if (x === prevX) ops.push(['+', null, y - 1]); else ops.push(['-', x - 1, null]);
    x = prevX; y = prevY;
  }
  while (x > 0 && y > 0) { ops.push(['=', x - 1, y - 1]); x--; y--; }
  return ops.reverse();
}

// Group edit operations into changes: {aFrom, aTo, bFrom, bTo} (half-open ranges).
export function changes(ops) {
  const out = [];
  let cur = null;
  let ai = 0, bi = 0;
  for (const [op] of ops) {
    if (op === '=') { if (cur) { out.push(cur); cur = null; } ai++; bi++; continue; }
    if (!cur) cur = { aFrom: ai, aTo: ai, bFrom: bi, bTo: bi };
    if (op === '-') { ai++; cur.aTo = ai; } else { bi++; cur.bTo = bi; }
  }
  if (cur) out.push(cur);
  return out;
}
