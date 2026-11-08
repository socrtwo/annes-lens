/**
 * Develop RAW: a DNG's sensor data to a picture.
 *
 * Black subtraction and scaling to the white level → white balance (as shot, automatic, daylight, or
 * a temperature and tint through the camera's color matrix) and exposure → highlights (clip like
 * LibRaw, keep unclipped data, or rebuild clipped channels as neutral with a soft shoulder) →
 * demosaic (2×2 half size, bilinear, or Malvar–He–Cutler gradient-corrected bilinear) → the camera
 * matrix to linear sRGB the way dcraw/LibRaw build it (rows normalized so white stays white), then
 * to the chosen output space (sRGB, Display P3, Adobe RGB-compatible or ProPhoto, Bradford-adapted)
 * with its tone curve, the default crop and the orientation.
 *
 * With bilinear demosaicing, camera white balance and clipped highlights in sRGB the result matches
 * LibRaw within a level or two (tests/unit/raw.test.ts).
 */
import type { Raster } from '../codecs/raster';
import { spaceIcc, SPACES, rgbToD50, mul3, inv3, apply3 } from '../color/spaces';
import type { Mat3, Para } from '../color/icc';
import type { DngRaw } from './dng';
import { readRaw } from './families';

export type WbMode = 'asShot' | 'auto' | 'daylight' | 'custom';
export type HighlightMode = 'clip' | 'unclip' | 'recover';
export type Demosaic = 'half' | 'bilinear' | 'high';
export type OutSpace = 'srgb' | 'p3' | 'adobergb' | 'prophoto';
export interface DevelopOptions { wb?: WbMode; temp?: number; tint?: number; exposure?: number; highlights?: HighlightMode; demosaic?: Demosaic; space?: OutSpace; crop?: boolean; orient?: boolean; baseline?: boolean }
export interface Developed { raster: Raster; icc: Uint8Array; neutral: number[]; multipliers: number[]; temp: number; tint: number; rgbCam: Mat3; raw: DngRaw }

// Illuminants and white points ---------------------------------------------------------------------
const ILLUMINANT_K: Record<number, number> = { 1: 5500, 2: 4150, 3: 2850, 4: 5500, 9: 5500, 10: 6500, 11: 7500, 12: 6430, 13: 5000, 14: 4150, 15: 3450, 17: 2856, 18: 4874, 19: 6774, 20: 5503, 21: 6504, 22: 7504, 23: 5003, 24: 3200 };
/** Chromaticity of a white at `t` kelvin: CIE daylight from 4000 K, the Planckian locus (Kim et al.) below. */
export function whiteXY(t: number): [number, number] {
  t = Math.max(1667, Math.min(25000, t));
  if (t >= 4000) {
    const x = t <= 7000 ? -4.607e9 / t ** 3 + 2.9678e6 / t ** 2 + 0.09911e3 / t + 0.244063 : -2.0064e9 / t ** 3 + 1.9018e6 / t ** 2 + 0.24748e3 / t + 0.23704;
    return [x, -3 * x * x + 2.87 * x - 0.275];
  }
  const x = -0.2661239e9 / t ** 3 - 0.2343589e6 / t ** 2 + 0.8776956e3 / t + 0.17991;
  const y = t <= 2222 ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683 : -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867;
  return [x, y];
}
/** Correlated color temperature of a chromaticity (McCamy). */
export const cctOf = (x: number, y: number): number => { const n = (x - 0.332) / (0.1858 - y); return 449 * n ** 3 + 3525 * n ** 2 + 6823.3 * n + 5520.33; };
const xyz = ([x, y]: [number, number]): [number, number, number] => [x / y, 1, (1 - x - y) / y];

/** XYZ → camera at a temperature: the DNG's two matrices interpolated by inverse temperature, with camera calibration and analog balance. */
export function cameraMatrix(r: DngRaw, temp: number): Mat3 {
  const fix = (m: number[] | null, cc: number[] | null): Mat3 | null => { if (!m || m.length < 9) return null; let M = m.slice(0, 9) as Mat3; if (cc && cc.length >= 9) M = mul3(cc.slice(0, 9) as Mat3, M); return M; };
  const m1 = fix(r.colorMatrix1, r.cameraCalibration1), m2 = fix(r.colorMatrix2, r.cameraCalibration2);
  let M: Mat3;
  if (m1 && m2) {
    let t1 = ILLUMINANT_K[r.illuminant1] || 2856, t2 = ILLUMINANT_K[r.illuminant2] || 6504, a = m1, b = m2;
    if (t1 > t2) { [t1, t2] = [t2, t1]; [a, b] = [b, a]; }
    const w = Math.max(0, Math.min(1, (1 / temp - 1 / t2) / (1 / t1 - 1 / t2)));
    M = a.map((v, i) => w * v + (1 - w) * b[i]) as Mat3;
  } else if (m1 || m2) M = (m1 || m2)!;
  else throw new Error('This DNG has no color matrix');
  const ab = r.analogBalance;
  return ab && ab.length >= 3 ? mul3([ab[0], 0, 0, 0, ab[1], 0, 0, 0, ab[2]], M) : M;
}
/** The temperature whose white the camera sees as `neutral` (iterated, since the matrix depends on it). */
export function neutralToTemp(r: DngRaw, neutral: number[]): { temp: number; tint: number } {
  let t = 5000;
  for (let k = 0; k < 6; k++) { const X = apply3(inv3(cameraMatrix(r, t)), neutral), s = X[0] + X[1] + X[2]; t = Math.max(1667, Math.min(25000, cctOf(X[0] / s, X[1] / s))); }
  // Tint: how much the green of the as-shot neutral differs from the white at that temperature.
  const n0 = apply3(cameraMatrix(r, t), xyz(whiteXY(t))), g0 = n0[1] / Math.sqrt(n0[0] * n0[2]), g1 = neutral[1] / Math.sqrt(neutral[0] * neutral[2]);
  return { temp: Math.round(t), tint: Math.round((g1 / g0 - 1) * 200) };
}
/** Camera neutral for a temperature and tint. */
export function tempToNeutral(r: DngRaw, temp: number, tint = 0): number[] {
  const n = apply3(cameraMatrix(r, temp), xyz(whiteXY(temp)));
  return [n[0] / n[1], 1 + tint / 200, n[2] / n[1]];
}

// Tone curves ---------------------------------------------------------------------------------------
/** Linear → encoded through an ICC parametric curve (type 0 or 3). */
export function encodeTrc(p: Para): (v: number) => number {
  if (p.d === undefined) { const e = 1 / p.g; return (v) => (v <= 0 ? 0 : v >= 1 ? 1 : v ** e); }
  const a = p.a ?? 1, b = p.b ?? 0, c = p.c ?? 0, d = p.d, lin = c * d, e = 1 / p.g;
  return (v) => (v <= 0 ? 0 : v >= 1 ? 1 : v < lin ? v / c : (v ** e - b) / a);
}

// Orientation -----------------------------------------------------------------------------------------
export function orientRaster(r: Raster, o: number): Raster {
  if (o <= 1 || o > 8) return r;
  const { width: w, height: h, data } = r, swap = o >= 5, W = swap ? h : w, H = swap ? w : h, out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let X = x, Y = y;
    switch (o) {
      case 2: X = w - 1 - x; break; case 3: X = w - 1 - x; Y = h - 1 - y; break; case 4: Y = h - 1 - y; break;
      case 5: X = y; Y = x; break; case 6: X = h - 1 - y; Y = x; break; case 7: X = h - 1 - y; Y = w - 1 - x; break; case 8: X = y; Y = w - 1 - x; break;
    }
    const s = (y * w + x) * 4, d = (Y * W + X) * 4; out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
  }
  return { width: W, height: H, data: out as Uint8ClampedArray<ArrayBuffer> };
}

// The pipeline ----------------------------------------------------------------------------------------
const SRGB_XYZ_D65: Mat3 = [0.412453, 0.35758, 0.180423, 0.212671, 0.71516, 0.072169, 0.019334, 0.119193, 0.950227];

/** Develops DNG bytes (or an already read raw). */
export function develop(src: Uint8Array | DngRaw, o: DevelopOptions = {}): Developed {
  const r = src instanceof Uint8Array ? readRaw(src) : src;
  const W = r.width, H = r.height, spp = r.samples;
  // 1. Normalized samples (0…1 at the white level).
  const bdx = r.blackDim[1], bdy = r.blackDim[0], f = new Float32Array(W * H * spp);
  for (let y = 0; y < H; y++) {
    const br = r.blackRow ? r.blackRow[y] || 0 : 0;
    for (let x = 0; x < W; x++) {
      const bc = r.blackCol ? r.blackCol[x] || 0 : 0;
      for (let s = 0; s < spp; s++) {
        const bi = ((y % bdy) * bdx + (x % bdx)) * (r.black.length >= bdx * bdy * spp ? spp : 1) + (r.black.length >= bdx * bdy * spp ? s : 0);
        const b = (r.black[bi] ?? r.black[0]) + br + bc, wl = r.white[Math.min(s, r.white.length - 1)];
        const i = (y * W + x) * spp + s; f[i] = (r.data[i] - b) / (wl - b);
      }
    }
  }
  const colorAt = (x: number, y: number) => (r.cfa ? r.cfa[(y & 1) * 2 + (x & 1)] : 0);
  // 2. White balance.
  const mode = o.wb || 'asShot';
  let neutral: number[];
  if (mode === 'custom') neutral = tempToNeutral(r, o.temp || 5500, o.tint || 0);
  else if (mode === 'daylight') neutral = tempToNeutral(r, 5500, 0);
  else if (mode === 'auto') {
    // Gray world over samples well below clipping.
    const sum = [0, 0, 0], n = [0, 0, 0];
    if (r.cfa) for (let y = 0; y + 1 < H; y += 2) for (let x = 0; x + 1 < W; x += 2) { let ok = true; for (let k = 0; k < 4; k++) if (f[(y + (k >> 1)) * W + x + (k & 1)] > 0.9) ok = false; if (!ok) continue; for (let k = 0; k < 4; k++) { const c = colorAt(x + (k & 1), y + (k >> 1)); sum[c] += Math.max(0, f[(y + (k >> 1)) * W + x + (k & 1)]); n[c]++; } }
    else for (let i = 0; i < W * H; i++) { if (f[i * 3] > 0.9 || f[i * 3 + 1] > 0.9 || f[i * 3 + 2] > 0.9) continue; for (let c = 0; c < 3; c++) { sum[c] += Math.max(0, f[i * 3 + c]); n[c]++; } }
    const m = sum.map((s, c) => s / Math.max(1, n[c]));
    neutral = m[1] > 0 ? [m[0] / m[1], 1, m[2] / m[1]] : [1, 1, 1];
  } else if (r.asShotNeutral && r.asShotNeutral.length >= 3) neutral = r.asShotNeutral.slice(0, 3);
  else if (r.asShotWhiteXY && r.asShotWhiteXY.length >= 2) { const t = cctOf(r.asShotWhiteXY[0], r.asShotWhiteXY[1]), n = apply3(cameraMatrix(r, t), xyz([r.asShotWhiteXY[0], r.asShotWhiteXY[1]])); neutral = [n[0] / n[1], 1, n[2] / n[1]]; }
  else neutral = tempToNeutral(r, 5500, 0);
  neutral = neutral.map((v) => (v > 1e-6 ? v : 1e-6));
  const { temp, tint } = neutralToTemp(r, neutral);
  const hl = o.highlights || 'recover';
  let mul = neutral.map((v) => 1 / v);
  const norm = hl === 'unclip' ? Math.max(...mul) : Math.min(...mul); mul = mul.map((v) => v / norm);
  const gain = 2 ** ((o.exposure || 0) + (o.baseline === false ? 0 : r.baselineExposure || 0));
  const scale = mul.map((v) => v * gain);
  // 3. Scaled samples; clip mode clips each sample like dcraw/LibRaw.
  if (r.cfa) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; let v = Math.max(0, f[i]) * scale[colorAt(x, y)]; if (hl === 'clip' && v > 1) v = 1; f[i] = v; }
  else for (let i = 0; i < W * H * 3; i++) { let v = Math.max(0, f[i]) * scale[i % 3]; if (hl === 'clip' && v > 1) v = 1; f[i] = v; }
  // 4. Color: camera → linear sRGB (dcraw's rgb_cam), then → the output space.
  const cm = cameraMatrix(r, temp);
  const camRgb = mul3(cm, SRGB_XYZ_D65);
  for (let i = 0; i < 3; i++) { const s = camRgb[i * 3] + camRgb[i * 3 + 1] + camRgb[i * 3 + 2]; for (let j = 0; j < 3; j++) camRgb[i * 3 + j] /= s; }
  const rgbCam = inv3(camRgb);
  const spaceId = o.space || 'srgb', space = SPACES.find((s) => s.id === spaceId)!;
  const toOut = spaceId === 'srgb' ? rgbCam : mul3(inv3(rgbToD50(space.primaries!, space.white!)), mul3(rgbToD50(SPACES[0].primaries!, SPACES[0].white!), rgbCam));
  const enc = encodeTrc(space.trc);
  const LUT = 4096, lut = new Uint8Array(LUT + 1); for (let i = 0; i <= LUT; i++) lut[i] = Math.round(255 * enc(i / LUT));
  const clipAt = scale.map((s) => s * 0.995);
  // 5. Demosaic and write.
  const half = r.cfa && o.demosaic === 'half', OW = half ? W >> 1 : W, OH = half ? H >> 1 : H;
  const out = new Uint8ClampedArray(OW * OH * 4);
  const mir = (v: number, n: number) => (v < 0 ? -v : v >= n ? 2 * n - 2 - v : v); // keeps the Bayer phase
  const c_ = (x: number, y: number) => f[mir(y, H) * W + mir(x, W)];
  const rgb = [0, 0, 0];
  const bilinear = (x: number, y: number) => {
    const c = colorAt(x, y), v = c_(x, y); rgb[c] = v;
    if (c === 1) {
      const hc = colorAt(x + 1, y), vc = 2 - hc;
      rgb[hc] = (c_(x - 1, y) + c_(x + 1, y)) / 2; rgb[vc] = (c_(x, y - 1) + c_(x, y + 1)) / 2;
    } else {
      rgb[1] = (c_(x - 1, y) + c_(x + 1, y) + c_(x, y - 1) + c_(x, y + 1)) / 4;
      rgb[2 - c] = (c_(x - 1, y - 1) + c_(x + 1, y - 1) + c_(x - 1, y + 1) + c_(x + 1, y + 1)) / 4;
    }
  };
  const mhc = (x: number, y: number) => {
    const c = colorAt(x, y), v = c_(x, y); rgb[c] = v;
    const N = c_(x, y - 1), S = c_(x, y + 1), E = c_(x + 1, y), Wd = c_(x - 1, y);
    const NN = c_(x, y - 2), SS = c_(x, y + 2), EE = c_(x + 2, y), WW = c_(x - 2, y);
    const diag = c_(x - 1, y - 1) + c_(x + 1, y - 1) + c_(x - 1, y + 1) + c_(x + 1, y + 1);
    if (c === 1) {
      const hc = colorAt(x + 1, y), vc = 2 - hc;
      rgb[hc] = (5 * v - diag - (EE + WW) + 0.5 * (NN + SS) + 4 * (E + Wd)) / 8;
      rgb[vc] = (5 * v - diag - (NN + SS) + 0.5 * (EE + WW) + 4 * (N + S)) / 8;
    } else {
      rgb[1] = (4 * v - (NN + SS + EE + WW) + 2 * (N + S + E + Wd)) / 8;
      rgb[2 - c] = (6 * v - 1.5 * (NN + SS + EE + WW) + 2 * diag) / 8;
    }
    for (let k = 0; k < 3; k++) if (rgb[k] < 0) rgb[k] = 0;
  };
  const px = r.cfa ? (o.demosaic === 'high' ? mhc : bilinear) : (x: number, y: number) => { const i = (y * W + x) * 3; rgb[0] = f[i]; rgb[1] = f[i + 1]; rgb[2] = f[i + 2]; };
  const shoulder = (v: number) => (v <= 0.9 ? v : 0.9 + 0.1 * (1 - Math.exp(-(v - 0.9) / 0.1)));
  for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) {
    if (half) {
      const x0 = x * 2, y0 = y * 2; rgb[0] = rgb[1] = rgb[2] = 0;
      for (let k = 0; k < 4; k++) { const xx = x0 + (k & 1), yy = y0 + (k >> 1), c = colorAt(xx, yy); rgb[c] += c === 1 ? f[yy * W + xx] / 2 : f[yy * W + xx]; }
    } else px(x, y);
    if (hl === 'recover') {
      let m = 0, sat = false; for (let k = 0; k < 3; k++) { if (rgb[k] > m) m = rgb[k]; if (rgb[k] >= clipAt[k]) sat = true; }
      // A clipped channel takes the brightest value; the others move toward it as the pixel gets brighter,
      // so blown areas turn white instead of magenta or cyan.
      if (sat) { const t = Math.min(1, Math.max(0, (m - 1) / 0.5)); for (let k = 0; k < 3; k++) rgb[k] = rgb[k] >= clipAt[k] ? m : rgb[k] + (m - rgb[k]) * t; }
    }
    const R = toOut[0] * rgb[0] + toOut[1] * rgb[1] + toOut[2] * rgb[2], G = toOut[3] * rgb[0] + toOut[4] * rgb[1] + toOut[5] * rgb[2], B = toOut[6] * rgb[0] + toOut[7] * rgb[1] + toOut[8] * rgb[2];
    const o4 = (y * OW + x) * 4, q = (v: number) => lut[Math.round(Math.max(0, Math.min(1, hl === 'recover' ? shoulder(v) : v)) * LUT)];
    out[o4] = q(R); out[o4 + 1] = q(G); out[o4 + 2] = q(B); out[o4 + 3] = 255;
  }
  let raster: Raster = { width: OW, height: OH, data: out as Uint8ClampedArray<ArrayBuffer> };
  if (o.crop !== false && r.crop) {
    const k = half ? 0.5 : 1, cx = Math.round(r.crop.x * k), cy = Math.round(r.crop.y * k), cw = Math.min(OW - cx, Math.round(r.crop.w * k)), ch = Math.min(OH - cy, Math.round(r.crop.h * k));
    if (cw > 0 && ch > 0 && (cw < OW || ch < OH)) { const c = new Uint8ClampedArray(cw * ch * 4); for (let y = 0; y < ch; y++) c.set(out.subarray(((cy + y) * OW + cx) * 4, ((cy + y) * OW + cx + cw) * 4), y * cw * 4); raster = { width: cw, height: ch, data: c as Uint8ClampedArray<ArrayBuffer> }; }
  }
  if (o.orient !== false) raster = orientRaster(raster, r.orientation);
  return { raster, icc: spaceIcc(spaceId), neutral, multipliers: mul, temp, tint, rgbCam, raw: r };
}
