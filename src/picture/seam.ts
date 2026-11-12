/**
 * Content-aware resizing by seam carving: the lowest-energy connected path of pixels (gradient
 * magnitude, plus a protect mask that keeps areas and a remove mask that pulls seams through
 * areas) is removed or duplicated, one seam at a time; horizontal seams go through a transpose.
 */
import { makeRaster, type Raster } from '../codecs/raster';

function energyOf(src: Raster, protect?: Uint8Array | null, remove?: Uint8Array | null): Float32Array {
  const w = src.width, h = src.height, d = src.data, e = new Float32Array(w * h);
  const lum = (i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const j = y * w + x, l = lum(((y) * w + Math.max(0, x - 1)) * 4), r = lum((y * w + Math.min(w - 1, x + 1)) * 4), u = lum((Math.max(0, y - 1) * w + x) * 4), dn = lum((Math.min(h - 1, y + 1) * w + x) * 4);
    let v = Math.abs(r - l) + Math.abs(dn - u);
    if (protect && protect[j]) v += 100000; if (remove && remove[j]) v -= 100000;
    e[j] = v;
  }
  return e;
}
/** The x position per row of the lowest-energy vertical seam. */
export function findSeam(e: Float32Array, w: number, h: number): Int32Array {
  const cost = new Float32Array(w * h), from = new Int8Array(w * h);
  for (let x = 0; x < w; x++) cost[x] = e[x];
  for (let y = 1; y < h; y++) for (let x = 0; x < w; x++) { const j = y * w + x, up = (y - 1) * w; let best = cost[up + x], dir = 0; if (x > 0 && cost[up + x - 1] < best) { best = cost[up + x - 1]; dir = -1; } if (x < w - 1 && cost[up + x + 1] < best) { best = cost[up + x + 1]; dir = 1; } cost[j] = e[j] + best; from[j] = dir; }
  let x = 0; for (let i = 1; i < w; i++) if (cost[(h - 1) * w + i] < cost[(h - 1) * w + x]) x = i;
  const seam = new Int32Array(h);
  for (let y = h - 1; y >= 0; y--) { seam[y] = x; x += from[y * w + x]; }
  return seam;
}
function removeSeam(src: Raster, seam: Int32Array, masks: (Uint8Array | null | undefined)[]): { raster: Raster; masks: (Uint8Array | null)[] } {
  const w = src.width, h = src.height, out = makeRaster(w - 1, h);
  const outMasks = masks.map((m) => (m ? new Uint8Array((w - 1) * h) : null));
  for (let y = 0; y < h; y++) { const sx = seam[y]; out.data.set(src.data.subarray(y * w * 4, (y * w + sx) * 4), y * (w - 1) * 4); out.data.set(src.data.subarray((y * w + sx + 1) * 4, (y + 1) * w * 4), (y * (w - 1) + sx) * 4); masks.forEach((m, k) => { if (!m) return; const om = outMasks[k]!; om.set(m.subarray(y * w, y * w + sx), y * (w - 1)); om.set(m.subarray(y * w + sx + 1, (y + 1) * w), y * (w - 1) + sx); }); }
  return { raster: out, masks: outMasks };
}
/** Widens by one pixel per seam: each seam pixel is kept and followed by the average of it and its right neighbour. */
export function insertSeams(src: Raster, seams: Int32Array[]): Raster {
  const w = src.width, h = src.height, n = seams.length, out = makeRaster(w + n, h);
  for (let y = 0; y < h; y++) {
    const at = seams.map((s) => s[y]).sort((a, b) => a - b); let k = 0, ox = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      out.data.set(src.data.subarray(i, i + 4), (y * (w + n) + ox) * 4); ox++;
      while (k < at.length && at[k] === x) { const nx = Math.min(w - 1, x + 1), i2 = (y * w + nx) * 4; for (let c = 0; c < 4; c++) out.data[(y * (w + n) + ox) * 4 + c] = (src.data[i + c] + src.data[i2 + c] + 1) >> 1; ox++; k++; }
    }
  }
  return out;
}
/**
 * Seams found one after another, each in the picture left by removing the ones before it, as columns of the
 * original picture: removals are undone latest first (seam j < i shifts seam i right where it lies at or left of it).
 */
export function seamsToOriginal(taken: Int32Array[]): Int32Array[] {
  return taken.map((t, i) => { const s = new Int32Array(t); for (let y = 0; y < s.length; y++) for (let j = i - 1; j >= 0; j--) if (taken[j][y] <= s[y]) s[y]++; return s; });
}
function transpose(r: Raster): Raster { const o = makeRaster(r.height, r.width); for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) o.data.set(r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4), (x * r.height + y) * 4); return o; }
const transposeMask = (m: Uint8Array | null | undefined, w: number, h: number): Uint8Array | null => { if (!m) return null; const o = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[x * h + y] = m[y * w + x]; return o; };

/** Resizes to `targetW`×`targetH` by carving (or inserting) seams; `protect` keeps pixels, `remove` pulls seams through them (both picture-sized masks, 255 = on). */
export function seamCarve(src: Raster, targetW: number, targetH: number, protect?: Uint8Array | null, remove?: Uint8Array | null, progress?: (done: number, total: number) => void): Raster {
  let r = src, p = protect || null, rm = remove || null;
  const total = Math.abs(targetW - src.width) + Math.abs(targetH - src.height); let done = 0;
  const carveWidth = (to: number) => {
    while (r.width > to) { const seam = findSeam(energyOf(r, p, rm), r.width, r.height); const out = removeSeam(r, seam, [p, rm]); r = out.raster; p = out.masks[0]; rm = out.masks[1]; progress?.(++done, total); }
    if (r.width < to) {
      const n = to - r.width; const seams: Int32Array[] = []; let tmp = r, tp = p, trm = rm; const taken: Int32Array[] = [];
      for (let i = 0; i < n; i++) { const seam = findSeam(energyOf(tmp, tp, trm), tmp.width, tmp.height); taken.push(seam); const out = removeSeam(tmp, seam, [tp, trm]); tmp = out.raster; tp = out.masks[0]; trm = out.masks[1]; }
      seams.push(...seamsToOriginal(taken));
      r = insertSeams(r, seams); p = null; rm = null; done += n; progress?.(done, total);
    }
  };
  carveWidth(Math.max(1, targetW));
  if (targetH !== r.height) { const w = r.width, h = r.height; r = transpose(r); p = transposeMask(p, w, h); rm = transposeMask(rm, w, h); carveWidth(Math.max(1, targetH)); r = transpose(r); }
  return r;
}
