/**
 * Merging several pictures of the same scene: exposure fusion (Mertens, Kautz and Van Reeth:
 * per-pixel weights from contrast, saturation and well-exposedness, blended through a Laplacian
 * pyramid so no tone-mapping artifacts appear) and focus stacking (the sharpest source per pixel
 * by local Laplacian energy, with a smoothed selection map).
 */
import { blend4, makeRaster, type Raster } from '../codecs/raster';
import { gaussianBlur } from './adjust';
import { grayAt, harrisCorners, describe, matchFeatures, ransac, inv3, apply3, type Mat3 } from './stitch';

const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/** Half-size (box) copy. */
function down(src: Raster): Raster { const w = Math.max(1, src.width >> 1), h = Math.max(1, src.height >> 1), out = makeRaster(w, h), s = src.data, d = out.data, W = src.width; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const x0 = Math.min(W - 1, x * 2), y0 = Math.min(src.height - 1, y * 2), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(src.height - 1, y0 + 1); const o = (y * w + x) * 4; for (let c = 0; c < 4; c++) d[o + c] = (s[(y0 * W + x0) * 4 + c] + s[(y0 * W + x1) * 4 + c] + s[(y1 * W + x0) * 4 + c] + s[(y1 * W + x1) * 4 + c]) / 4; } return out; }
/** Bilinear upsample to w×h (float arrays, 4 channels). */
function up(src: Float32Array, sw: number, sh: number, w: number, h: number): Float32Array { const out = new Float32Array(w * h * 4); for (let y = 0; y < h; y++) { const fy = Math.min(sh - 1, (y + 0.5) * sh / h - 0.5), y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(sh - 1, y0 + 1), ty = Math.max(0, fy - y0); for (let x = 0; x < w; x++) { const fx = Math.min(sw - 1, (x + 0.5) * sw / w - 0.5), x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(sw - 1, x0 + 1), tx = Math.max(0, fx - x0); const o = (y * w + x) * 4; for (let c = 0; c < 4; c++) out[o + c] = (src[(y0 * sw + x0) * 4 + c] * (1 - tx) + src[(y0 * sw + x1) * 4 + c] * tx) * (1 - ty) + (src[(y1 * sw + x0) * 4 + c] * (1 - tx) + src[(y1 * sw + x1) * 4 + c] * tx) * ty; } } return out; }
const toF = (r: Raster) => Float32Array.from(r.data);

/** Per-pixel fusion weights (contrast^wc · saturation^ws · exposedness^we), normalized across the inputs. */
export function fusionWeights(inputs: Raster[], wc = 1, ws = 1, we = 1, sigma = 0.2): Float32Array[] {
  const w = inputs[0].width, h = inputs[0].height, n = w * h;
  const weights = inputs.map((r) => {
    const out = new Float32Array(n), d = r.data, g = new Float32Array(n);
    for (let i = 0, j = 0; j < n; i += 4, j++) g[j] = lum(d[i], d[i + 1], d[i + 2]) / 255;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const j = y * w + x, i = j * 4;
      const l = x > 0 ? g[j - 1] : g[j], rr = x < w - 1 ? g[j + 1] : g[j], u = y > 0 ? g[j - w] : g[j], dn = y < h - 1 ? g[j + w] : g[j];
      const contrast = Math.abs(4 * g[j] - l - rr - u - dn) + 1e-3;
      const R = d[i] / 255, G = d[i + 1] / 255, B = d[i + 2] / 255, mean = (R + G + B) / 3, sat = Math.sqrt(((R - mean) ** 2 + (G - mean) ** 2 + (B - mean) ** 2) / 3) + 1e-3;
      const expo = Math.exp(-((R - 0.5) ** 2) / (2 * sigma * sigma)) * Math.exp(-((G - 0.5) ** 2) / (2 * sigma * sigma)) * Math.exp(-((B - 0.5) ** 2) / (2 * sigma * sigma)) + 1e-4;
      out[j] = Math.pow(contrast, wc) * Math.pow(sat, ws) * Math.pow(expo, we);
    }
    return out;
  });
  for (let j = 0; j < n; j++) { let s = 0; for (const wt of weights) s += wt[j]; for (const wt of weights) wt[j] /= s || 1; }
  return weights;
}

/** Exposure fusion of same-size pictures (dark to bright, any order); `levels` pyramid levels. */
export function exposureFusion(inputs: Raster[], opts: { contrast?: number; saturation?: number; exposedness?: number; levels?: number } = {}): Raster {
  if (inputs.length === 1) return inputs[0];
  const w = inputs[0].width, h = inputs[0].height;
  const weights = fusionWeights(inputs, opts.contrast ?? 1, opts.saturation ?? 1, opts.exposedness ?? 1);
  const levels = Math.max(1, Math.min(opts.levels ?? 6, Math.floor(Math.log2(Math.min(w, h))) - 1));
  // Gaussian pyramids of the weights (as 4-channel float arrays for the shared up/down code) and Laplacian pyramids of the inputs.
  const weightRaster = (wt: Float32Array) => { const r = makeRaster(w, h); for (let j = 0; j < wt.length; j++) { const v = wt[j] * 255; r.data[j * 4] = v; r.data[j * 4 + 1] = v; r.data[j * 4 + 2] = v; r.data[j * 4 + 3] = 255; } return r; };
  const gauss = (r: Raster) => { const g: Raster[] = [r]; for (let l = 1; l < levels; l++) g.push(down(gaussianBlur(g[l - 1], 1))); return g; };
  const blended: Float32Array[] = []; const sizes: [number, number][] = [];
  for (let k = 0; k < inputs.length; k++) {
    const G = gauss(inputs[k]), WG = gauss(weightRaster(weights[k]));
    for (let l = 0; l < levels; l++) {
      const cur = toF(G[l]); const lw = G[l].width, lh = G[l].height;
      let lap: Float32Array;
      if (l < levels - 1) { const upper = up(toF(G[l + 1]), G[l + 1].width, G[l + 1].height, lw, lh); lap = cur.map((v, i) => v - upper[i]); } else lap = cur;
      const wg = WG[l].data;
      if (!blended[l]) { blended[l] = new Float32Array(lap.length); sizes[l] = [lw, lh]; }
      const b = blended[l]; for (let i = 0; i < lap.length; i += 4) { const wt = wg[i] / 255; b[i] += lap[i] * wt; b[i + 1] += lap[i + 1] * wt; b[i + 2] += lap[i + 2] * wt; b[i + 3] = 255; }
    }
  }
  // Collapse.
  let acc = blended[levels - 1];
  for (let l = levels - 2; l >= 0; l--) { const [lw, lh] = sizes[l]; const u = up(acc, sizes[l + 1][0], sizes[l + 1][1], lw, lh); acc = blended[l].map((v, i) => v + u[i]); }
  const out = makeRaster(w, h); for (let i = 0; i < acc.length; i++) out.data[i] = i % 4 === 3 ? 255 : Math.max(0, Math.min(255, acc[i]));
  return out;
}

/** Focus stack: per pixel the input with the highest smoothed Laplacian energy; `radius` smooths the choice map. */
export function focusStack(inputs: Raster[], radius = 4): { raster: Raster; map: Uint8Array } {
  if (inputs.length === 1) return { raster: inputs[0], map: new Uint8Array(inputs[0].width * inputs[0].height) };
  const w = inputs[0].width, h = inputs[0].height, n = w * h;
  const energy = inputs.map((r) => {
    const d = r.data, g = new Float32Array(n), e = makeRaster(w, h);
    for (let i = 0, j = 0; j < n; i += 4, j++) g[j] = lum(d[i], d[i + 1], d[i + 2]);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const j = y * w + x; const l = x > 0 ? g[j - 1] : g[j], rr = x < w - 1 ? g[j + 1] : g[j], u = y > 0 ? g[j - w] : g[j], dn = y < h - 1 ? g[j + w] : g[j]; const v = Math.min(255, Math.abs(4 * g[j] - l - rr - u - dn)); e.data[j * 4] = v; e.data[j * 4 + 1] = v; e.data[j * 4 + 2] = v; e.data[j * 4 + 3] = 255; }
    return gaussianBlur(e, radius).data;
  });
  const map = new Uint8Array(n);
  for (let j = 0; j < n; j++) { let best = 0, bv = -1; for (let k = 0; k < inputs.length; k++) { const v = energy[k][j * 4]; if (v > bv) { bv = v; best = k; } } map[j] = best; }
  // Smooth the choice by majority in a window to avoid speckle, then composite.
  const r = Math.max(1, radius >> 1), sm = new Uint8Array(n), counts = new Uint16Array(inputs.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { counts.fill(0); for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const xx = Math.min(w - 1, Math.max(0, x + dx)), yy = Math.min(h - 1, Math.max(0, y + dy)); counts[map[yy * w + xx]]++; } let best = 0; for (let k = 1; k < inputs.length; k++) if (counts[k] > counts[best]) best = k; sm[y * w + x] = best; }
  const out = makeRaster(w, h);
  for (let j = 0; j < n; j++) { const src = inputs[sm[j]].data; out.data.set(src.subarray(j * 4, j * 4 + 4), j * 4); }
  return { raster: out, map: sm };
}

// Refinements ---------------------------------------------------------------------------------------

/** Where each other picture's pixel comes from in the first one (a similarity: shift, turn and scale), from matched corners; null when nothing matches. */
export function alignmentTo(reference: Raster, other: Raster): Mat3 | null {
  const scale = Math.min(1, 800 / Math.max(reference.width, reference.height));
  const ga = normalizeGray(grayAt(reference, scale)), gb = normalizeGray(grayAt(other, scale));
  const pa = harrisCorners(ga, 500, 10), pb = harrisCorners(gb, 500, 10);
  if (pa.length < 8 || pb.length < 8) return null;
  const da = describe(ga, pa), db = describe(gb, pb);
  const pairs = matchFeatures(da.desc, db.desc, 0.85);
  if (pairs.length < 6) return null;
  const A = pairs.map(([i]) => da.pts[i]), B = pairs.map(([, j]) => db.pts[j]);
  const fit = ransac(B, A, 'similarity', 2.5, 1500); // maps other → reference (in the working scale)
  if (!fit || fit.inliers.length < 6) return null;
  const M = fit.M.slice(); M[2] /= scale; M[5] /= scale; // translation back to full size; the linear part is scale-free
  return M;
}
/** Gray values stretched to their 1st–99th percentiles, so differently exposed pictures match. */
function normalizeGray(g: { w: number; h: number; v: Float32Array }): { w: number; h: number; v: Float32Array } {
  const sorted = Float32Array.from(g.v).sort(), lo = sorted[Math.floor(sorted.length * 0.01)], hi = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
  const k = hi > lo ? 1 / (hi - lo) : 1;
  return { w: g.w, h: g.h, v: g.v.map((x) => Math.max(0, Math.min(1, (x - lo) * k))) };
}
/** The picture warped so that it lines up with the reference (bilinear; the edges that come from nowhere keep the nearest pixel). */
export function warpSimilarity(src: Raster, M: Mat3, w: number, h: number): Raster {
  const inv = inv3(M); if (!inv) return src;
  const out = makeRaster(w, h), d = out.data, s = src.data, sw = src.width, sh = src.height;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [u, v] = apply3(inv, x, y);
    const cx = Math.max(0, Math.min(sw - 1.001, u)), cy = Math.max(0, Math.min(sh - 1.001, v));
    const x0 = Math.floor(cx), y0 = Math.floor(cy), fx = cx - x0, fy = cy - y0, i00 = (y0 * sw + x0) * 4, i01 = i00 + 4, i10 = i00 + sw * 4, i11 = i10 + 4, o = (y * w + x) * 4;
    blend4(s, i00, i01, i10, i11, fx, fy, d, o);
  }
  return out;
}
/** Lines every picture up with the first; `moved` says which were warped (and by how far, in pixels at the center). */
export function alignRasters(inputs: Raster[]): { rasters: Raster[]; moved: { index: number; shift: number; turn: number; scale: number }[]; failed: number[] } {
  const ref = inputs[0], out = [ref], moved: { index: number; shift: number; turn: number; scale: number }[] = [], failed: number[] = [];
  for (let k = 1; k < inputs.length; k++) {
    const M = alignmentTo(ref, inputs[k]);
    if (!M) { out.push(inputs[k]); failed.push(k); continue; }
    const cx = ref.width / 2, cy = ref.height / 2, [px, py] = apply3(M, cx, cy), shift = Math.hypot(px - cx, py - cy), sc = Math.hypot(M[0], M[3]), turn = Math.atan2(M[3], M[0]) * 180 / Math.PI;
    if (shift < 0.3 && Math.abs(turn) < 0.02 && Math.abs(sc - 1) < 0.001) { out.push(inputs[k]); continue; }
    out.push(warpSimilarity(inputs[k], M, ref.width, ref.height)); moved.push({ index: k, shift, turn, scale: sc });
  }
  return { rasters: out, moved, failed };
}

/**
 * Ghost weights for exposure fusion: each picture's brightness is matched to the reference (the one with the middle
 * mean) by a linear gain, and where it then still differs from the reference by more than the noise its weight falls
 * off; the reference itself keeps weight 1, so moving things are taken from one exposure only (no doubled people).
 */
export function ghostWeights(inputs: Raster[], sigma = 0.08): { weights: Float32Array[]; reference: number } {
  const n = inputs[0].width * inputs[0].height;
  const means = inputs.map((r) => { let s = 0; for (let i = 0; i < r.data.length; i += 4) s += lum(r.data[i], r.data[i + 1], r.data[i + 2]); return s / n / 255; });
  const order = means.map((m, i) => [m, i] as const).sort((a, b) => a[0] - b[0]), reference = order[order.length >> 1][1];
  const refL = new Float32Array(n), rd = inputs[reference].data;
  for (let i = 0, j = 0; j < n; i += 4, j++) refL[j] = lum(rd[i], rd[i + 1], rd[i + 2]) / 255;
  const weights = inputs.map((r, k) => {
    const w = new Float32Array(n).fill(1); if (k === reference) return w;
    const d = r.data; let num = 0, den = 0;
    for (let i = 0, j = 0; j < n; i += 4, j++) { const l = lum(d[i], d[i + 1], d[i + 2]) / 255; if (l > 0.03 && l < 0.97 && refL[j] > 0.03 && refL[j] < 0.97) { num += l * refL[j]; den += l * l; } }
    const gain = den > 0 ? num / den : 1;
    const raw = makeRaster(r.width, r.height);
    for (let i = 0, j = 0; j < n; i += 4, j++) {
      const l0 = lum(d[i], d[i + 1], d[i + 2]) / 255, l = Math.min(1, l0 * gain), ref = refL[j];
      const clipped = l0 >= 0.995 || ref >= 0.995 || l0 <= 0.005 || ref <= 0.005; // beyond the sensor's range nothing can be compared (judged before the gain)
      const diff = clipped ? 0 : Math.abs(l - ref);
      const v = Math.exp(-(diff * diff) / (2 * sigma * sigma)) * 255; raw.data[i] = raw.data[i + 1] = raw.data[i + 2] = v; raw.data[i + 3] = 255;
    }
    const sm = gaussianBlur(raw, 3).data;
    for (let i = 0, j = 0; j < n; i += 4, j++) w[j] = Math.max(0.02, sm[i] / 255);
    return w;
  });
  return { weights, reference };
}

/** Exposure fusion with the refinements: pictures lined up first and moving things taken from one exposure. */
export function exposureFusionRefined(inputs: Raster[], opts: { contrast?: number; saturation?: number; exposedness?: number; levels?: number; align?: boolean; deghost?: boolean } = {}): { raster: Raster; moved: number; failed: number; reference: number } {
  let rasters = inputs, moved = 0, failed = 0;
  if (opts.align !== false && inputs.length > 1) { const a = alignRasters(inputs); rasters = a.rasters; moved = a.moved.length; failed = a.failed.length; }
  if (!(opts.deghost !== false) || rasters.length < 2) return { raster: exposureFusion(rasters, opts), moved, failed, reference: -1 };
  const g = ghostWeights(rasters);
  return { raster: exposureFusionWeighted(rasters, opts, g.weights), moved, failed, reference: g.reference };
}
/** Exposure fusion whose per-picture weights are multiplied by extra per-pixel factors (the ghost weights). */
export function exposureFusionWeighted(inputs: Raster[], opts: { contrast?: number; saturation?: number; exposedness?: number; levels?: number }, extra: Float32Array[]): Raster {
  const base = fusionWeights(inputs, opts.contrast ?? 1, opts.saturation ?? 1, opts.exposedness ?? 1);
  const n = inputs[0].width * inputs[0].height;
  for (let j = 0; j < n; j++) { let s = 0; for (let k = 0; k < inputs.length; k++) { base[k][j] *= extra[k][j]; s += base[k][j]; } for (let k = 0; k < inputs.length; k++) base[k][j] /= s || 1; }
  return fuseWithWeights(inputs, base, opts.levels);
}
/** The pyramid blend of exposureFusion for given normalized weights. */
function fuseWithWeights(inputs: Raster[], weights: Float32Array[], levelsOpt?: number): Raster {
  const w = inputs[0].width, h = inputs[0].height;
  const levels = Math.max(1, Math.min(levelsOpt ?? 6, Math.floor(Math.log2(Math.min(w, h))) - 1));
  const weightRaster = (wt: Float32Array) => { const r = makeRaster(w, h); for (let j = 0; j < wt.length; j++) { const v = wt[j] * 255; r.data[j * 4] = v; r.data[j * 4 + 1] = v; r.data[j * 4 + 2] = v; r.data[j * 4 + 3] = 255; } return r; };
  const gauss = (r: Raster) => { const g: Raster[] = [r]; for (let l = 1; l < levels; l++) g.push(down(gaussianBlur(g[l - 1], 1))); return g; };
  const blended: Float32Array[] = []; const sizes: [number, number][] = [];
  for (let k = 0; k < inputs.length; k++) {
    const G = gauss(inputs[k]), WG = gauss(weightRaster(weights[k]));
    for (let l = 0; l < levels; l++) {
      const cur = toF(G[l]); const lw = G[l].width, lh = G[l].height;
      let lap: Float32Array;
      if (l < levels - 1) { const upper = up(toF(G[l + 1]), G[l + 1].width, G[l + 1].height, lw, lh); lap = cur.map((v, i) => v - upper[i]); } else lap = cur;
      const wg = WG[l].data;
      if (!blended[l]) { blended[l] = new Float32Array(lap.length); sizes[l] = [lw, lh]; }
      const b = blended[l]; for (let i = 0; i < lap.length; i += 4) { const wt = wg[i] / 255; b[i] += lap[i] * wt; b[i + 1] += lap[i + 1] * wt; b[i + 2] += lap[i + 2] * wt; b[i + 3] = 255; }
    }
  }
  let acc = blended[levels - 1];
  for (let l = levels - 2; l >= 0; l--) { const [lw, lh] = sizes[l]; const u = up(acc, sizes[l + 1][0], sizes[l + 1][1], lw, lh); acc = blended[l].map((v, i) => v + u[i]); }
  const out = makeRaster(w, h); for (let i = 0; i < acc.length; i++) out.data[i] = i % 4 === 3 ? 255 : Math.max(0, Math.min(255, acc[i]));
  return out;
}

/**
 * Focus stacking with the refinements: pictures lined up first (focus breathing changes the scale a little), sharpness
 * measured at two scales, the choice map cleaned by a majority filter and the pixels blended along the seams
 * (a soft choice over `feather` pixels) so the edges between source pictures do not show.
 */
export function focusStackRefined(inputs: Raster[], opts: { radius?: number; align?: boolean; feather?: number } = {}): { raster: Raster; map: Uint8Array; moved: number; failed: number } {
  let rasters = inputs, moved = 0, failed = 0;
  if (opts.align !== false && inputs.length > 1) { const a = alignRasters(inputs); rasters = a.rasters; moved = a.moved.length; failed = a.failed.length; }
  if (rasters.length === 1) return { raster: rasters[0], map: new Uint8Array(rasters[0].width * rasters[0].height), moved, failed };
  const w = rasters[0].width, h = rasters[0].height, n = w * h, radius = opts.radius ?? 4;
  // Sharpness: |Laplacian| of the gray picture, smoothed at the chosen radius and at twice it (fine and coarse detail).
  const energy = rasters.map((r) => {
    const d = r.data, g = new Float32Array(n), e = makeRaster(w, h);
    for (let i = 0, j = 0; j < n; i += 4, j++) g[j] = lum(d[i], d[i + 1], d[i + 2]);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const j = y * w + x; const l = x > 0 ? g[j - 1] : g[j], rr = x < w - 1 ? g[j + 1] : g[j], u = y > 0 ? g[j - w] : g[j], dn = y < h - 1 ? g[j + w] : g[j]; const v = Math.min(255, Math.abs(4 * g[j] - l - rr - u - dn)); e.data[j * 4] = e.data[j * 4 + 1] = e.data[j * 4 + 2] = v; e.data[j * 4 + 3] = 255; }
    const fine = gaussianBlur(e, radius).data, coarse = gaussianBlur(e, radius * 2).data, out = new Float32Array(n);
    for (let j = 0; j < n; j++) out[j] = fine[j * 4] + 0.5 * coarse[j * 4];
    return out;
  });
  const map = new Uint8Array(n);
  for (let j = 0; j < n; j++) { let best = 0, bv = -1; for (let k = 0; k < rasters.length; k++) { const v = energy[k][j]; if (v > bv) { bv = v; best = k; } } map[j] = best; }
  const r = Math.max(1, radius), sm = new Uint8Array(n), counts = new Uint16Array(rasters.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { counts.fill(0); for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const xx = Math.min(w - 1, Math.max(0, x + dx)), yy = Math.min(h - 1, Math.max(0, y + dy)); counts[map[yy * w + xx]]++; } let best = 0; for (let k = 1; k < counts.length; k++) if (counts[k] > counts[best]) best = k; sm[y * w + x] = best; }
  // Soft seams: each source's indicator blurred over `feather` pixels gives per-pixel blend weights.
  const feather = opts.feather ?? Math.max(1, radius);
  const out = makeRaster(w, h), acc = new Float32Array(n * 4), wsum = new Float32Array(n);
  for (let k = 0; k < rasters.length; k++) {
    const ind = makeRaster(w, h); let any = false;
    for (let j = 0; j < n; j++) if (sm[j] === k) { ind.data[j * 4] = ind.data[j * 4 + 1] = ind.data[j * 4 + 2] = 255; ind.data[j * 4 + 3] = 255; any = true; }
    if (!any) continue;
    const soft = feather > 0 ? gaussianBlur(ind, feather).data : ind.data, d = rasters[k].data;
    for (let j = 0; j < n; j++) { const wt = soft[j * 4] / 255; if (!wt) continue; wsum[j] += wt; acc[j * 4] += d[j * 4] * wt; acc[j * 4 + 1] += d[j * 4 + 1] * wt; acc[j * 4 + 2] += d[j * 4 + 2] * wt; }
  }
  for (let j = 0; j < n; j++) { const s = wsum[j] || 1; out.data[j * 4] = acc[j * 4] / s; out.data[j * 4 + 1] = acc[j * 4 + 1] / s; out.data[j * 4 + 2] = acc[j * 4 + 2] / s; out.data[j * 4 + 3] = 255; }
  return { raster: out, map: sm, moved, failed };
}
