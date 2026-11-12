/**
 * Geometry on rasters: rotation by any angle (expand or keep the canvas), straightening angle from
 * the dominant near-horizontal/vertical edges, deskew angle for scanned text (projection profile),
 * four-corner perspective correction, and lens correction (radial distortion, vignetting,
 * chromatic aberration). Sampling is bilinear through `remap`.
 */
import { blend4, makeRaster, type Raster } from '../codecs/raster';
import { remap, type RGB } from './effects';

const lumOf = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/** Rotates by `deg` clockwise; `expand` grows the canvas to hold everything, filled with `bg` (null = transparent). */
export function rotateRaster(src: Raster, deg: number, expand = true, bg: RGB | null = [255, 255, 255]): Raster {
  const a = (deg * Math.PI) / 180, w = src.width, h = src.height;
  const snap = (v: number) => (Math.abs(v) < 1e-9 ? 0 : Math.abs(Math.abs(v) - 1) < 1e-9 ? Math.sign(v) : v);
  const c = snap(Math.cos(a)), s = snap(Math.sin(a));
  const W = expand ? Math.ceil(Math.abs(w * c) + Math.abs(h * s)) : w, H = expand ? Math.ceil(Math.abs(w * s) + Math.abs(h * c)) : h;
  const out = makeRaster(W, H), d = out.data, sd = src.data, cx = w / 2, cy = h / 2, ox = W / 2, oy = H / 2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x + 0.5 - ox, dy = y + 0.5 - oy;
    const sx = cx + dx * c + dy * s - 0.5, sy = cy - dx * s + dy * c - 0.5;
    const o = (y * W + x) * 4;
    if (sx < -0.5 || sy < -0.5 || sx > w - 0.5 || sy > h - 0.5) { if (bg) { d[o] = bg[0]; d[o + 1] = bg[1]; d[o + 2] = bg[2]; d[o + 3] = 255; } continue; }
    const x0 = Math.max(0, Math.floor(sx)), y0 = Math.max(0, Math.floor(sy)), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), fx = Math.max(0, sx - x0), fy = Math.max(0, sy - y0);
    const a0 = (y0 * w + x0) * 4, b0 = (y0 * w + x1) * 4, c0 = (y1 * w + x0) * 4, d0 = (y1 * w + x1) * 4;
    blend4(sd, a0, b0, c0, d0, fx, fy, d, o);
    if (bg) { const alpha = d[o + 3] / 255; for (let i = 0; i < 3; i++) d[o + i] = bg[i] + (d[o + i] - bg[i]) * alpha; d[o + 3] = 255; }
  }
  return out;
}

/** The angle (degrees, −45…45) that makes the dominant long edges horizontal or vertical: gradient orientation histogram with 0.25° bins. */
export function straightenAngle(src: Raster, maxAngle = 20): number {
  const w = src.width, h = src.height, g = new Float32Array(w * h), s = src.data;
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = lumOf(s[i], s[i + 1], s[i + 2]);
  const bins = Math.round(maxAngle * 2 / 0.25) + 1, hist = new Float64Array(bins);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = g[i + 1] - g[i - 1] + 0.5 * (g[i - w + 1] - g[i - w - 1] + g[i + w + 1] - g[i + w - 1]);
    const gy = g[i + w] - g[i - w] + 0.5 * (g[i + w - 1] - g[i - w - 1] + g[i + w + 1] - g[i - w + 1]);
    const mag = Math.hypot(gx, gy); if (mag < 24) continue;
    let ang = (Math.atan2(gy, gx) * 180) / Math.PI; // edge normal
    ang = ((ang % 90) + 90) % 90; if (ang > 45) ang -= 90; // fold to −45…45 (horizontal and vertical edges coincide)
    if (Math.abs(ang) > maxAngle) continue;
    hist[Math.round((ang + maxAngle) / 0.25)] += mag;
  }
  // Smooth and pick the peak; the picture is rotated by the negative of it.
  let best = 0, bestV = -1;
  for (let b = 0; b < bins; b++) { const v = hist[b] + 0.5 * ((hist[b - 1] || 0) + (hist[b + 1] || 0)); if (v > bestV) { bestV = v; best = b; } }
  const angle = best * 0.25 - maxAngle;
  return Math.abs(angle) < 0.2 ? 0 : -angle;
}

/** The skew angle (degrees) of scanned text: the rotation whose row projection profile has the highest variance (±maxAngle, 0.1° steps near the peak). */
export function deskewAngle(src: Raster, maxAngle = 10): number {
  const w = src.width, h = src.height, s = src.data;
  // Work on a downscaled binary ink map (dark pixels) for speed.
  const k = Math.max(1, Math.round(Math.max(w, h) / 600)), sw = Math.floor(w / k), sh = Math.floor(h / k), ink: { x: number; y: number }[] = [];
  let sum = 0, n = 0; for (let i = 0; i < s.length; i += 4 * k) { sum += lumOf(s[i], s[i + 1], s[i + 2]); n++; }
  const thr = Math.min(160, (sum / n) * 0.7);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) { const o = ((y * k) * w + x * k) * 4; if (lumOf(s[o], s[o + 1], s[o + 2]) < thr) ink.push({ x: x - sw / 2, y: y - sh / 2 }); }
  if (ink.length < 20) return 0;
  const score = (deg: number) => { const a = (deg * Math.PI) / 180, c = Math.cos(a), si = Math.sin(a), rows = new Float64Array(sh + sw + 2), off = (sh + sw) / 2; for (const p of ink) { const yy = Math.round(-p.x * si + p.y * c + off); if (yy >= 0 && yy < rows.length) rows[yy]++; } let m = 0; for (const v of rows) m += v; m /= rows.length; let v2 = 0; for (const v of rows) v2 += (v - m) * (v - m); return v2; };
  let best = 0, bestS = -1;
  for (let d = -maxAngle; d <= maxAngle; d += 0.5) { const sc = score(d); if (sc > bestS) { bestS = sc; best = d; } }
  for (let d = best - 0.5; d <= best + 0.5; d += 0.1) { const sc = score(d); if (sc > bestS) { bestS = sc; best = d; } }
  return Math.abs(best) < 0.05 ? 0 : -Math.round(best * 10) / 10;
}

export type Quad = [[number, number], [number, number], [number, number], [number, number]]; // TL, TR, BR, BL in source pixels
/** Maps the quadrilateral `q` of the source onto a W×H rectangle (homography), e.g. a document photographed at an angle. */
export function perspective(src: Raster, q: Quad, W?: number, H?: number): Raster {
  const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const outW = Math.max(1, Math.round(W || Math.max(dist(q[0], q[1]), dist(q[3], q[2])))), outH = Math.max(1, Math.round(H || Math.max(dist(q[0], q[3]), dist(q[1], q[2]))));
  // Homography from the unit square (0,0)-(1,1) to the quad.
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3, dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1 || 1e-9;
  const g = (dx3 * dy2 - dx2 * dy3) / den, hh = (dx1 * dy3 - dx3 * dy1) / den;
  const a = x1 - x0 + g * x1, b = x3 - x0 + hh * x3, c = x0, d = y1 - y0 + g * y1, e = y3 - y0 + hh * y3, f = y0;
  const out = makeRaster(outW, outH), od = out.data, sd = src.data, w = src.width, h = src.height;
  for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) {
    const u = (x + 0.5) / outW, v = (y + 0.5) / outH, z = g * u + hh * v + 1;
    const sx = (a * u + b * v + c) / z - 0.5, sy = (d * u + e * v + f) / z - 0.5;
    const o = (y * outW + x) * 4;
    if (sx < -0.5 || sy < -0.5 || sx > w - 0.5 || sy > h - 0.5) { od[o + 3] = 0; continue; }
    const px0 = Math.max(0, Math.floor(sx)), py0 = Math.max(0, Math.floor(sy)), px1 = Math.min(w - 1, px0 + 1), py1 = Math.min(h - 1, py0 + 1), fx = Math.max(0, sx - px0), fy = Math.max(0, sy - py0);
    const a0 = (py0 * w + px0) * 4, b0 = (py0 * w + px1) * 4, c0 = (py1 * w + px0) * 4, d0 = (py1 * w + px1) * 4;
    for (let i = 0; i < 4; i++) od[o + i] = (sd[a0 + i] * (1 - fx) + sd[b0 + i] * fx) * (1 - fy) + (sd[c0 + i] * (1 - fx) + sd[d0 + i] * fx) * fy;
  }
  return out;
}

export interface LensOptions { /** Radial distortion: negative removes barrel, positive removes pincushion (−1…1). */ k1?: number; k2?: number; /** Vignetting correction: positive brightens the corners (−1…1). */ vignette?: number; /** Chromatic aberration: red and blue channel scale in 1/1000 (−20…20). */ caRed?: number; caBlue?: number; /** Scale to hide the edges after correction (1 = none). */ scale?: number }
/** Lens correction: Brown radial model with per-channel scales for lateral color, then a vignetting gain. */
export function lensCorrect(src: Raster, o: LensOptions): Raster {
  const k1 = o.k1 || 0, k2 = o.k2 || 0, vig = o.vignette || 0, scale = o.scale || 1, cr = 1 + (o.caRed || 0) / 1000, cb = 1 + (o.caBlue || 0) / 1000;
  const w = src.width, h = src.height, cx = w / 2, cy = h / 2, R = Math.hypot(cx, cy);
  const channel = (k: number) => remap(src, (x, y, p) => { const dx = (x + 0.5 - cx) / R, dy = (y + 0.5 - cy) / R, r2 = (dx * dx + dy * dy); const f = (1 + k1 * r2 + k2 * r2 * r2) * k / scale; p[0] = cx + dx * f * R - 0.5; p[1] = cy + dy * f * R - 0.5; }, true);
  const base = channel(1), out = base;
  if (cr !== 1 || cb !== 1) { const red = cr !== 1 ? channel(cr) : base, blue = cb !== 1 ? channel(cb) : base; for (let i = 0; i < out.data.length; i += 4) { out.data[i] = red.data[i]; out.data[i + 2] = blue.data[i + 2]; } }
  if (vig) { const d = out.data; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const dx = (x + 0.5 - cx) / R, dy = (y + 0.5 - cy) / R, r2 = dx * dx + dy * dy; const gain = 1 + vig * r2 * 1.5; const o = (y * w + x) * 4; for (let c = 0; c < 3; c++) d[o + c] = Math.max(0, Math.min(255, d[o + c] * gain)); } }
  return out;
}

/** Finds the largest bright quadrilateral-ish region (a page on a dark background): the convex hull extremes of bright pixels. Null when nothing stands out. */
export function findPageCorners(src: Raster): Quad | null {
  const w = src.width, h = src.height, s = src.data;
  let sum = 0; for (let i = 0; i < s.length; i += 16) sum += lumOf(s[i], s[i + 1], s[i + 2]);
  const mean = sum / (s.length / 16);
  const thr = mean + 25;
  const pts: [number, number][] = [];
  const step = Math.max(1, Math.round(Math.max(w, h) / 400));
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) { const o = (y * w + x) * 4; if (lumOf(s[o], s[o + 1], s[o + 2]) > thr) pts.push([x, y]); }
  if (pts.length < 50 || pts.length > (w / step) * (h / step) * 0.97) return null;
  const pick = (f: (p: [number, number]) => number) => pts.reduce((a, b) => (f(b) > f(a) ? b : a));
  const tl = pick(([x, y]) => -(x + y)), br = pick(([x, y]) => x + y), tr = pick(([x, y]) => x - y), bl = pick(([x, y]) => y - x);
  const area = Math.abs((tr[0] - tl[0]) * (bl[1] - tl[1]) - (bl[0] - tl[0]) * (tr[1] - tl[1]));
  if (area < w * h * 0.1) return null;
  return [tl, tr, br, bl];
}
