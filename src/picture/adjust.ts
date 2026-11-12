/**
 * Adjustments on rasters (no DOM): tone (brightness, contrast, gamma, exposure, levels, auto levels and
 * contrast, equalize, normalize, shadows/highlights, vignette), color (saturation, vibrance, hue,
 * balance, white balance, tint, posterize, channel mixers, faded-color restoration) and detail
 * (Gaussian and box blur, unsharp mask, despeckle, noise reduction, red-eye).
 */
import { makeRaster, type Raster } from '../codecs/raster';

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
const copy = (r: Raster): Raster => { const o = makeRaster(r.width, r.height); o.data.set(r.data); return o; };
const lumOf = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/** Applies a per-channel lookup table (three 256-entry arrays). */
export function applyLut(src: Raster, lr: Uint8ClampedArray | number[], lg = lr, lb = lr): Raster {
  const out = copy(src); const d = out.data;
  for (let i = 0; i < d.length; i += 4) { d[i] = lr[d[i]]; d[i + 1] = lg[d[i + 1]]; d[i + 2] = lb[d[i + 2]]; }
  return out;
}

export interface ColorCorrection { brightness?: number; contrast?: number; gamma?: number; saturation?: number; red?: number; green?: number; blue?: number; exposure?: number }

/** IrfanView-style color corrections: brightness −255…255, contrast −127…127, gamma 0.01–6.99, saturation −255…255, channel balance −255…255, exposure in EV. */
export function colorCorrect(src: Raster, c: ColorCorrection): Raster {
  const b = c.brightness || 0, con = c.contrast || 0, g = c.gamma || 1, ev = c.exposure || 0;
  const f = (259 * (con + 255)) / (255 * (259 - con));
  const lut = (shift: number) => { const t = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) { let v = i * Math.pow(2, ev); v = f * (v - 128) + 128 + b + shift; v = 255 * Math.pow(Math.max(0, Math.min(1, v / 255)), 1 / g); t[i] = clamp(Math.round(v)); } return t; };
  let out = applyLut(src, lut(c.red || 0), lut(c.green || 0), lut(c.blue || 0));
  if (c.saturation) out = saturate(out, c.saturation / 255);
  return out;
}

/** Saturation: −1 = gray, 0 = unchanged, +1 = doubled. */
export function saturate(src: Raster, amount: number): Raster {
  const out = copy(src); const d = out.data; const k = 1 + amount;
  for (let i = 0; i < d.length; i += 4) { const l = lumOf(d[i], d[i + 1], d[i + 2]); d[i] = clamp(l + (d[i] - l) * k); d[i + 1] = clamp(l + (d[i + 1] - l) * k); d[i + 2] = clamp(l + (d[i + 2] - l) * k); }
  return out;
}

/** Vibrance: boosts the less saturated colors more; skin tones (orange hues) are protected. */
export function vibrance(src: Raster, amount: number): Raster {
  const out = copy(src); const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx ? (mx - mn) / mx : 0;
    const skin = r > g && g > b && r - b < 120 && r - b > 20 ? 0.4 : 1;
    const k = 1 + amount * (1 - sat) * skin;
    const l = lumOf(r, g, b);
    d[i] = clamp(l + (r - l) * k); d[i + 1] = clamp(l + (g - l) * k); d[i + 2] = clamp(l + (b - l) * k);
  }
  return out;
}

export function levels(src: Raster, o: { inBlack?: number; inWhite?: number; gamma?: number; outBlack?: number; outWhite?: number; channel?: 'all' | 'r' | 'g' | 'b' }): Raster {
  const ib = o.inBlack ?? 0, iw = o.inWhite ?? 255, g = o.gamma ?? 1, ob = o.outBlack ?? 0, ow = o.outWhite ?? 255;
  const t = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) { let v = (i - ib) / Math.max(1, iw - ib); v = Math.pow(Math.max(0, Math.min(1, v)), 1 / g); t[i] = clamp(Math.round(ob + v * (ow - ob))); }
  const id = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) id[i] = i;
  const ch = o.channel || 'all';
  return applyLut(src, ch === 'all' || ch === 'r' ? t : id, ch === 'all' || ch === 'g' ? t : id, ch === 'all' || ch === 'b' ? t : id);
}

function percentiles(src: Raster, lo: number, hi: number, channel: 0 | 1 | 2 | 3): [number, number] {
  const hist = new Uint32Array(256); let n = 0;
  for (let i = 0; i < src.data.length; i += 4) { if (src.data[i + 3] < 128) continue; hist[channel === 3 ? Math.round(lumOf(src.data[i], src.data[i + 1], src.data[i + 2])) : src.data[i + channel]]++; n++; }
  let acc = 0, a = 0, b = 255;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * lo) { a = i; break; } }
  acc = 0;
  for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= n * (1 - hi)) { b = i; break; } }
  return [a, Math.max(a + 1, b)];
}

/** Stretches each channel so its 0.5% and 99.5% percentiles reach black and white. */
export function autoLevels(src: Raster, clip = 0.005): Raster {
  const luts = [0, 1, 2].map((c) => { const [a, b] = percentiles(src, clip, 1 - clip, c as 0 | 1 | 2); const t = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) t[i] = clamp(Math.round(((i - a) * 255) / (b - a))); return t; });
  return applyLut(src, luts[0], luts[1], luts[2]);
}

/** Stretches luminance only (colors keep their balance). */
export function autoContrast(src: Raster, clip = 0.005): Raster {
  const [a, b] = percentiles(src, clip, 1 - clip, 3);
  const t = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) t[i] = clamp(Math.round(((i - a) * 255) / (b - a)));
  return applyLut(src, t);
}

/** Gray-world white balance: scales channels so their means match. */
export function autoColor(src: Raster, strength = 1): Raster {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < src.data.length; i += 4) { if (src.data[i + 3] < 128) continue; r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2]; n++; }
  if (!n) return copy(src);
  const mean = (r + g + b) / (3 * n);
  const k = [mean / (r / n || 1), mean / (g / n || 1), mean / (b / n || 1)].map((v) => 1 + (v - 1) * strength);
  const t = (f: number) => { const l = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) l[i] = clamp(Math.round(i * f)); return l; };
  return applyLut(src, t(k[0]), t(k[1]), t(k[2]));
}

/** White balance by temperature (−100 cool … +100 warm) and tint (−100 green … +100 magenta), or from a neutral reference color. */
export function whiteBalance(src: Raster, o: { temperature?: number; tint?: number; neutral?: [number, number, number] }): Raster {
  let kr = 1, kg = 1, kb = 1;
  if (o.neutral) { const m = (o.neutral[0] + o.neutral[1] + o.neutral[2]) / 3; kr = m / (o.neutral[0] || 1); kg = m / (o.neutral[1] || 1); kb = m / (o.neutral[2] || 1); }
  const t = (o.temperature || 0) / 100, ti = (o.tint || 0) / 100;
  kr *= 1 + 0.3 * t; kb *= 1 - 0.3 * t; kg *= 1 - 0.2 * ti;
  const lut = (f: number) => { const l = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) l[i] = clamp(Math.round(i * f)); return l; };
  return applyLut(src, lut(kr), lut(kg), lut(kb));
}

/** Histogram equalization of luminance (colors scaled with it). */
export function equalize(src: Raster): Raster {
  const hist = new Uint32Array(256); let n = 0;
  for (let i = 0; i < src.data.length; i += 4) { hist[Math.round(lumOf(src.data[i], src.data[i + 1], src.data[i + 2]))]++; n++; }
  const cdf = new Float32Array(256); let acc = 0; for (let i = 0; i < 256; i++) { acc += hist[i]; cdf[i] = acc / n; }
  const out = copy(src); const d = out.data;
  for (let i = 0; i < d.length; i += 4) { const l = Math.round(lumOf(d[i], d[i + 1], d[i + 2])); const k = l ? (255 * cdf[l]) / l : 1; d[i] = clamp(d[i] * k); d[i + 1] = clamp(d[i + 1] * k); d[i + 2] = clamp(d[i + 2] * k); }
  return out;
}

export function hsl(src: Raster, o: { hue?: number; saturation?: number; lightness?: number }): Raster {
  const out = copy(src); const d = out.data;
  const hs = (o.hue || 0) / 360, ss = (o.saturation || 0) / 100, ls = (o.lightness || 0) / 100;
  for (let i = 0; i < d.length; i += 4) {
    let [h, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
    h = (h + hs + 1) % 1; s = Math.max(0, Math.min(1, s * (1 + ss))); l = ls >= 0 ? l + (1 - l) * ls : l * (1 + ls);
    const [r, g, b] = hslToRgb(h, s, l); d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
  return out;
}
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const dd = mx - mn, s = l > 0.5 ? dd / (2 - mx - mn) : dd / (mx + mn);
  const h = mx === r ? ((g - b) / dd + (g < b ? 6 : 0)) / 6 : mx === g ? ((b - r) / dd + 2) / 6 : ((r - g) / dd + 4) / 6;
  return [h, s, l];
}
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (!s) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t: number) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
}

/** Tint: blends toward a color by luminance (sepia with [112, 66, 20] at strength 1). */
export function tint(src: Raster, color: [number, number, number], strength: number): Raster {
  const out = copy(src); const d = out.data;
  for (let i = 0; i < d.length; i += 4) { const l = lumOf(d[i], d[i + 1], d[i + 2]) / 255; const tr = color[0] * l * 2, tg = color[1] * l * 2, tb = color[2] * l * 2; d[i] = clamp(d[i] * (1 - strength) + Math.min(255, tr) * strength); d[i + 1] = clamp(d[i + 1] * (1 - strength) + Math.min(255, tg) * strength); d[i + 2] = clamp(d[i + 2] * (1 - strength) + Math.min(255, tb) * strength); }
  return out;
}

export function posterize(src: Raster, levelsPerChannel: number): Raster {
  const n = Math.max(2, Math.min(256, Math.round(levelsPerChannel)));
  const t = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) t[i] = Math.round(Math.round((i / 255) * (n - 1)) * (255 / (n - 1)));
  return applyLut(src, t);
}

/** Color balance: shifts per tonal range (values −100…100 per channel for shadows, midtones, highlights). */
export function colorBalance(src: Raster, o: { shadows?: [number, number, number]; midtones?: [number, number, number]; highlights?: [number, number, number] }): Raster {
  const out = copy(src); const d = out.data;
  const s = o.shadows || [0, 0, 0], m = o.midtones || [0, 0, 0], hh = o.highlights || [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) {
    const l = lumOf(d[i], d[i + 1], d[i + 2]) / 255;
    const ws = Math.max(0, 1 - l * 2), wh = Math.max(0, l * 2 - 1), wm = 1 - ws - wh;
    for (let c = 0; c < 3; c++) d[i + c] = clamp(d[i + c] + (s[c] * ws + m[c] * wm + hh[c] * wh) * 1.28);
  }
  return out;
}

/** Channel mixer: each output channel as a weighted sum of the inputs (percent). `mono` sends the red row to all three. */
export function channelMixer(src: Raster, rows: [number, number, number][], mono = false): Raster {
  const out = copy(src); const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const v = rows.map((w) => clamp((w[0] * r + w[1] * g + w[2] * b) / 100));
    if (mono) d[i] = d[i + 1] = d[i + 2] = v[0]; else { d[i] = v[0]; d[i + 1] = v[1]; d[i + 2] = v[2]; }
  }
  return out;
}

/** Faded prints and slides: each channel stretched to full range (dye fade is mostly a per-channel loss), then a mild gray-world correction. */
export function restoreFaded(src: Raster): Raster { return autoColor(autoLevels(src, 0.002), 0.6); }

/** Separable Gaussian blur. */
export function gaussianBlur(src: Raster, radius: number): Raster {
  const sigma = Math.max(0.1, radius / 2);
  const size = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(size * 2 + 1); let sum = 0;
  for (let i = -size; i <= size; i++) { k[i + size] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += k[i + size]; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return convolve1d(convolve1d(src, k, true), k, false);
}
export function boxBlur(src: Raster, radius: number): Raster {
  const size = Math.max(1, Math.round(radius));
  const k = new Float32Array(size * 2 + 1).fill(1 / (size * 2 + 1));
  return convolve1d(convolve1d(src, k, true), k, false);
}
function convolve1d(src: Raster, k: Float32Array, horizontal: boolean): Raster {
  const w = src.width, h = src.height, half = (k.length - 1) / 2;
  const out = makeRaster(w, h); const s = src.data, d = out.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    // Weighted by alpha (premultiplied), so transparent pixels lend no color to the edge of a cut-out.
    let r = 0, g = 0, b = 0, a = 0, pr = 0, pg = 0, pb = 0;
    for (let i = -half; i <= half; i++) {
      const xx = horizontal ? Math.min(w - 1, Math.max(0, x + i)) : x, yy = horizontal ? y : Math.min(h - 1, Math.max(0, y + i));
      const o = (yy * w + xx) * 4, wt = k[i + half], wa = wt * s[o + 3];
      r += s[o] * wa; g += s[o + 1] * wa; b += s[o + 2] * wa; a += wa;
      pr += s[o] * wt; pg += s[o + 1] * wt; pb += s[o + 2] * wt;
    }
    const o = (y * w + x) * 4;
    if (a > 0) { d[o] = r / a; d[o + 1] = g / a; d[o + 2] = b / a; } else { d[o] = pr; d[o + 1] = pg; d[o + 2] = pb; }
    d[o + 3] = a;
  }
  return out;
}

/** Unsharp mask: amount in percent, radius in pixels, threshold 0–255. */
export function unsharpMask(src: Raster, amount: number, radius: number, threshold = 0): Raster {
  const blurred = gaussianBlur(src, radius);
  const out = copy(src); const d = out.data, s = src.data, bl = blurred.data, k = amount / 100;
  for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) { const diff = s[i + c] - bl[i + c]; if (Math.abs(diff) >= threshold) d[i + c] = clamp(s[i + c] + diff * k); }
  return out;
}
export const sharpen = (src: Raster, strength = 1): Raster => unsharpMask(src, 60 * strength, 1, 2);

/** 3×3 median of each channel (speckles and salt-and-pepper noise). */
export function despeckle(src: Raster, radius = 1): Raster {
  const w = src.width, h = src.height, out = makeRaster(w, h), s = src.data, d = out.data;
  const win: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) {
      win.length = 0;
      for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) { const xx = Math.min(w - 1, Math.max(0, x + dx)), yy = Math.min(h - 1, Math.max(0, y + dy)); win.push(s[(yy * w + xx) * 4 + c]); }
      win.sort((p, q) => p - q);
      d[o + c] = win[win.length >> 1];
    }
    d[o + 3] = s[o + 3];
  }
  return out;
}

/** Noise reduction: a bilateral filter (spatial radius, range strength 0–100). */
export function denoise(src: Raster, radius = 2, strength = 30): Raster {
  const w = src.width, h = src.height, out = makeRaster(w, h), s = src.data, d = out.data;
  const sr = Math.max(1, strength) * 1.5, sw = new Float32Array(2 * radius + 1); for (let i = -radius; i <= radius; i++) sw[i + radius] = Math.exp(-(i * i) / (2 * radius * radius));
  const rw = new Float32Array(256); for (let i = 0; i < 256; i++) rw[i] = Math.exp(-(i * i) / (2 * sr * sr));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) {
      let sum = 0, wsum = 0; const v = s[o + c];
      for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) { const xx = Math.min(w - 1, Math.max(0, x + dx)), yy = Math.min(h - 1, Math.max(0, y + dy)); const u = s[(yy * w + xx) * 4 + c]; const wt = sw[dx + radius] * sw[dy + radius] * rw[Math.abs(u - v)]; sum += u * wt; wsum += wt; }
      d[o + c] = clamp(Math.round(sum / wsum));
    }
    d[o + 3] = s[o + 3];
  }
  return out;
}

/** Red-eye: pixels whose red clearly dominates get their red pulled down to the green/blue level. */
export function redEye(src: Raster, strength = 1): Raster {
  const out = copy(src); const d = out.data;
  for (let i = 0; i < d.length; i += 4) { const r = d[i], g = d[i + 1], b = d[i + 2]; if (r > 60 && r > 1.5 * Math.max(g, b)) { const t = Math.round((g + b) / 2); d[i] = clamp(r + (t - r) * strength); } }
  return out;
}

/** Shadows and highlights: lifts dark areas and tames bright ones by a blurred luminance mask (amounts 0–100). */
export function shadowsHighlights(src: Raster, shadows: number, highlights: number, radius = 20): Raster {
  const mask = gaussianBlur(src, radius);
  const out = copy(src); const d = out.data, m = mask.data;
  const sa = shadows / 100, ha = highlights / 100;
  for (let i = 0; i < d.length; i += 4) {
    const l = lumOf(m[i], m[i + 1], m[i + 2]) / 255;
    const k = 1 + sa * (1 - l) * (1 - l) * 1.5 - ha * l * l * 0.6;
    d[i] = clamp(d[i] * k); d[i + 1] = clamp(d[i + 1] * k); d[i + 2] = clamp(d[i + 2] * k);
  }
  return out;
}

export function vignette(src: Raster, amount: number, radius = 0.75, color: [number, number, number] = [0, 0, 0]): Raster {
  const out = copy(src); const d = out.data; const w = src.width, h = src.height, cx = w / 2, cy = h / 2, rr = Math.hypot(cx, cy);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dist = Math.hypot(x - cx, y - cy) / rr;
    const t = Math.max(0, Math.min(1, (dist - radius) / (1 - radius + 0.001))) * (amount / 100);
    const o = (y * w + x) * 4; d[o] = clamp(d[o] * (1 - t) + color[0] * t); d[o + 1] = clamp(d[o + 1] * (1 - t) + color[1] * t); d[o + 2] = clamp(d[o + 2] * (1 - t) + color[2] * t);
  }
  return out;
}

/** Dehaze: a dark-channel-prior approximation with a global atmospheric light. */
export function dehaze(src: Raster, amount: number): Raster {
  const w = src.width, h = src.height, s = src.data;
  const dark = makeRaster(w, h);
  for (let i = 0; i < s.length; i += 4) { const v = Math.min(s[i], s[i + 1], s[i + 2]); dark.data[i] = dark.data[i + 1] = dark.data[i + 2] = v; dark.data[i + 3] = 255; }
  const dc = boxBlur(dark, 7);
  let air = 0; for (let i = 0; i < dc.data.length; i += 4) if (dc.data[i] > air) air = dc.data[i];
  air = Math.max(air, 200);
  const out = copy(src); const d = out.data, k = amount / 100;
  for (let i = 0; i < d.length; i += 4) { const t = Math.max(0.1, 1 - k * 0.95 * (dc.data[i] / air)); for (let c = 0; c < 3; c++) d[i + c] = clamp((s[i + c] - air) / t + air); }
  return out;
}

/** Clarity: local contrast in the midtones (unsharp mask with a large radius, protected extremes). */
export function clarity(src: Raster, amount: number): Raster {
  const blurred = gaussianBlur(src, 12);
  const out = copy(src); const d = out.data, s = src.data, bl = blurred.data, k = amount / 100;
  for (let i = 0; i < d.length; i += 4) { const l = lumOf(s[i], s[i + 1], s[i + 2]) / 255; const prot = 1 - Math.pow(Math.abs(l - 0.5) * 2, 2); for (let c = 0; c < 3; c++) d[i + c] = clamp(s[i + c] + (s[i + c] - bl[i + c]) * k * prot); }
  return out;
}

/** Auto-adjust: levels, a touch of saturation; One-Click Enhance adds gentle sharpening. */
export const autoAdjust = (src: Raster): Raster => saturate(autoLevels(src), 0.1);
export const enhance = (src: Raster): Raster => unsharpMask(saturate(autoLevels(src), 0.12), 40, 1, 2);

// Curves, tone equalizer, selective color, 3-D LUTs, dust and scratches, descreen ------------------

export type CurvePoint = [number, number];
/** A monotone cubic (Fritsch–Carlson) interpolation through sorted points → 256-entry LUT. */
export function curveLut(points: CurvePoint[]): Uint8ClampedArray {
  const pts = [...points].sort((a, b) => a[0] - b[0]).filter((p, i, a) => !i || p[0] !== a[i - 1][0]);
  if (pts.length === 0) pts.push([0, 0], [255, 255]);
  if (pts.length === 1) pts.push([pts[0][0] === 255 ? 0 : 255, pts[0][1]]);
  const n = pts.length, xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const d: number[] = [], m: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m.push(d[0]); for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2); m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) { if (!d[i]) { m[i] = m[i + 1] = 0; continue; } const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b; if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; } }
  const out = new Uint8ClampedArray(256);
  for (let x = 0; x < 256; x++) {
    if (x <= xs[0]) { out[x] = clamp(Math.round(ys[0])); continue; }
    if (x >= xs[n - 1]) { out[x] = clamp(Math.round(ys[n - 1])); continue; }
    let i = 0; while (xs[i + 1] < x) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    const y = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    out[x] = clamp(Math.round(y));
  }
  return out;
}
/** Curves: the RGB curve applied to every channel, then the per-channel curves. */
export function curves(src: Raster, c: { all?: CurvePoint[]; r?: CurvePoint[]; g?: CurvePoint[]; b?: CurvePoint[] }): Raster {
  const id: CurvePoint[] = [[0, 0], [255, 255]];
  const all = curveLut(c.all || id), lr = curveLut(c.r || id), lg = curveLut(c.g || id), lb = curveLut(c.b || id);
  const comp = (l: Uint8ClampedArray) => { const t = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) t[i] = l[all[i]]; return t; };
  return applyLut(src, comp(lr), comp(lg), comp(lb));
}

/** Tone equalizer: gains (−100…100) for five bands of a blurred luminance mask (blacks, shadows, midtones, highlights, whites); local contrast stays. */
export function toneEqualizer(src: Raster, gains: [number, number, number, number, number], radius = 24): Raster {
  const mask = gaussianBlur(src, radius), out = copy(src), d = out.data, mk = mask.data;
  const centers = [0, 64, 128, 192, 255];
  for (let i = 0; i < d.length; i += 4) {
    const l = lumOf(mk[i], mk[i + 1], mk[i + 2]);
    let g = 0, wsum = 0;
    for (let b = 0; b < 5; b++) { const w = Math.max(0, 1 - Math.abs(l - centers[b]) / 64); g += gains[b] * w; wsum += w; }
    if (wsum) g /= wsum;
    if (!g) continue;
    const k = Math.pow(2, g / 100); // ±1 EV at full gain
    d[i] = clamp(d[i] * k); d[i + 1] = clamp(d[i + 1] * k); d[i + 2] = clamp(d[i + 2] * k);
  }
  return out;
}

export type SelectiveRange = 'reds' | 'yellows' | 'greens' | 'cyans' | 'blues' | 'magentas' | 'whites' | 'neutrals' | 'blacks';
export interface SelectiveAdjust { hue?: number; saturation?: number; lightness?: number }
const RANGE_HUE: Record<string, number> = { reds: 0, yellows: 60, greens: 120, cyans: 180, blues: 240, magentas: 300 };
/** Selective color: hue shift (°), saturation and lightness (−100…100) applied to pixels in a color range, with soft edges. */
export function selectiveColor(src: Raster, ranges: Partial<Record<SelectiveRange, SelectiveAdjust>>): Raster {
  const out = copy(src), d = out.data;
  const active = Object.entries(ranges).filter(([, a]) => a && (a.hue || a.saturation || a.lightness)) as [SelectiveRange, SelectiveAdjust][];
  if (!active.length) return out;
  for (let i = 0; i < d.length; i += 4) {
    const hsl0 = rgbToHsl(d[i], d[i + 1], d[i + 2]);
    let h = hsl0[0] * 360, s = hsl0[1], l = hsl0[2];
    let dh = 0, ds = 0, dl = 0;
    for (const [name, a] of active) {
      let w: number;
      if (name === 'whites') w = Math.max(0, (l - 0.7) / 0.3) * Math.max(0, 1 - s * 2);
      else if (name === 'blacks') w = Math.max(0, (0.3 - l) / 0.3) * Math.max(0, 1 - s * 2);
      else if (name === 'neutrals') w = Math.max(0, 1 - s * 4) * (l > 0.15 && l < 0.85 ? 1 : 0);
      else { let dist = Math.abs(((h - RANGE_HUE[name]) % 360 + 540) % 360 - 180); w = Math.max(0, 1 - dist / 45) * Math.min(1, s * 3); }
      if (!w) continue;
      dh += (a.hue || 0) * w; ds += (a.saturation || 0) * w; dl += (a.lightness || 0) * w;
    }
    if (!dh && !ds && !dl) continue;
    h = (h + dh + 360) % 360; s = Math.max(0, Math.min(1, s * (1 + ds / 100))); l = Math.max(0, Math.min(1, l + (dl / 100) * (dl > 0 ? 1 - l : l)));
    const [r, g, b] = hslToRgb(h / 360, s, l); d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
  return out;
}

export interface Lut3d { size: number; data: Float32Array; title: string; domainMin: [number, number, number]; domainMax: [number, number, number] }
/** Parses an Adobe/Resolve .cube file (3-D; 1-D tables are expanded). */
export function parseCube(text: string): Lut3d {
  let size = 0, size1d = 0, title = ''; const dmin: [number, number, number] = [0, 0, 0], dmax: [number, number, number] = [1, 1, 1]; const vals: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Z_0-9]+)\s*(.*)$/);
    if (m && /^[A-Z_]/.test(line) && !/^[-+.\d]/.test(line)) {
      if (m[1] === 'LUT_3D_SIZE') size = +m[2]; else if (m[1] === 'LUT_1D_SIZE') size1d = +m[2]; else if (m[1] === 'TITLE') title = m[2].replace(/^"|"$/g, '');
      else if (m[1] === 'DOMAIN_MIN') m[2].split(/\s+/).forEach((v, i) => { dmin[i] = +v; }); else if (m[1] === 'DOMAIN_MAX') m[2].split(/\s+/).forEach((v, i) => { dmax[i] = +v; });
      continue;
    }
    const nums = line.split(/\s+/).map(Number); if (nums.length >= 3 && nums.every((n) => Number.isFinite(n))) vals.push(nums[0], nums[1], nums[2]);
  }
  if (size1d && !size) {
    // Expand a 1-D table into a small 3-D one.
    const s = Math.min(33, size1d), data = new Float32Array(s * s * s * 3);
    const at = (c: number, t: number) => { const p = t * (size1d - 1), i0 = Math.floor(p), i1 = Math.min(size1d - 1, i0 + 1), f = p - i0; return vals[i0 * 3 + c] * (1 - f) + vals[i1 * 3 + c] * f; };
    for (let b = 0; b < s; b++) for (let g = 0; g < s; g++) for (let r = 0; r < s; r++) { const o = ((b * s + g) * s + r) * 3; data[o] = at(0, r / (s - 1)); data[o + 1] = at(1, g / (s - 1)); data[o + 2] = at(2, b / (s - 1)); }
    return { size: s, data, title, domainMin: dmin, domainMax: dmax };
  }
  if (!size || vals.length < size * size * size * 3) throw new Error(`Not a complete .cube file (${vals.length / 3} of ${size * size * size} entries).`);
  return { size, data: Float32Array.from(vals.slice(0, size * size * size * 3)), title, domainMin: dmin, domainMax: dmax };
}
/** Applies a 3-D LUT with trilinear interpolation; `strength` 0–1 blends with the original. */
export function applyLut3d(src: Raster, lut: Lut3d, strength = 1): Raster {
  const out = copy(src), d = out.data, n = lut.size, L = lut.data, mx = n - 1;
  const idx = (r: number, g: number, b: number) => ((b * n + g) * n + r) * 3;
  for (let i = 0; i < d.length; i += 4) {
    const rr = ((d[i] / 255 - lut.domainMin[0]) / (lut.domainMax[0] - lut.domainMin[0])) * mx, gg = ((d[i + 1] / 255 - lut.domainMin[1]) / (lut.domainMax[1] - lut.domainMin[1])) * mx, bb = ((d[i + 2] / 255 - lut.domainMin[2]) / (lut.domainMax[2] - lut.domainMin[2])) * mx;
    const r0 = Math.max(0, Math.min(mx, Math.floor(rr))), g0 = Math.max(0, Math.min(mx, Math.floor(gg))), b0 = Math.max(0, Math.min(mx, Math.floor(bb)));
    const r1 = Math.min(mx, r0 + 1), g1 = Math.min(mx, g0 + 1), b1 = Math.min(mx, b0 + 1);
    const fr = Math.max(0, Math.min(1, rr - r0)), fg = Math.max(0, Math.min(1, gg - g0)), fb = Math.max(0, Math.min(1, bb - b0));
    for (let c = 0; c < 3; c++) {
      const c00 = L[idx(r0, g0, b0) + c] * (1 - fr) + L[idx(r1, g0, b0) + c] * fr, c10 = L[idx(r0, g1, b0) + c] * (1 - fr) + L[idx(r1, g1, b0) + c] * fr;
      const c01 = L[idx(r0, g0, b1) + c] * (1 - fr) + L[idx(r1, g0, b1) + c] * fr, c11 = L[idx(r0, g1, b1) + c] * (1 - fr) + L[idx(r1, g1, b1) + c] * fr;
      const v = ((c00 * (1 - fg) + c10 * fg) * (1 - fb) + (c01 * (1 - fg) + c11 * fg) * fb) * 255;
      d[i + c] = clamp(d[i + c] + (v - d[i + c]) * strength);
    }
  }
  return out;
}

/** Dust and scratches: pixels that differ from the local median by more than `threshold` take the median (radius 1–8). Returns the result and the mask of replaced pixels. */
export function dustScratches(src: Raster, radius = 2, threshold = 24): { raster: Raster; mask: Uint8Array } {
  const med = despeckle(src, radius), out = copy(src), d = out.data, m = med.data, mask = new Uint8Array(src.width * src.height);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const diff = Math.max(Math.abs(d[i] - m[i]), Math.abs(d[i + 1] - m[i + 1]), Math.abs(d[i + 2] - m[i + 2]));
    if (diff > threshold) { d[i] = m[i]; d[i + 1] = m[i + 1]; d[i + 2] = m[i + 2]; mask[j] = 1; }
  }
  return { raster: out, mask };
}

/** Descreen: removes a halftone screen of about `period` pixels (blur at half the period, then a mild unsharp mask to bring back edges). */
export function descreen(src: Raster, period = 4, restore = 40): Raster {
  const soft = gaussianBlur(src, Math.max(1, period / 2));
  return restore ? unsharpMask(soft, restore, Math.max(2, period), 4) : soft;
}
