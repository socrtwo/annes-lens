/**
 * Effects on rasters (no DOM): artistic (emboss, oil paint, edge detect, median, pencil sketch,
 * watercolor, cartoon, halftone, mosaic, pixelate, solarize, tiles, 3-D button), photographic (film
 * grain, soft focus, glow, focal black and white, graduated tint, Orton, cross process, toy camera,
 * tilt-shift, duotone, noise), distortions by coordinate remapping (swirl, explosion, rain drops,
 * fragment, spread, shift lines, radial and zoom blur, fisheye, wave, glass, ripple, pinch, polar)
 * and frames (drop shadow, reflection, round corners, instant-print frame, vignette frame), plus a
 * custom convolution. Randomness is seeded so previews and the full-size result match.
 */
import { blend4, makeRaster, type Raster } from '../codecs/raster';
import { gaussianBlur, saturate, colorCorrect, posterize, vignette, applyLut, hsl } from './adjust';
import { grayscale, negative, resample } from './ops';

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
const copy = (r: Raster): Raster => { const o = makeRaster(r.width, r.height); o.data.set(r.data); return o; };
const lumOf = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
export type RGB = [number, number, number];

/** A small deterministic PRNG (mulberry32). */
export function rng(seed = 1): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Sampling -------------------------------------------------------------------------------------

/** Bilinear sample at (x, y) with edge clamping; writes RGBA into `out` at `o`. */
function sample(s: Uint8ClampedArray, w: number, h: number, x: number, y: number, out: Uint8ClampedArray, o: number, transparentOutside = false): void {
  if (transparentOutside && (x < -0.5 || y < -0.5 || x > w - 0.5 || y > h - 0.5)) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; return; }
  const cx = Math.min(w - 1, Math.max(0, x)), cy = Math.min(h - 1, Math.max(0, y));
  const x0 = Math.floor(cx), y0 = Math.floor(cy), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), fx = cx - x0, fy = cy - y0;
  const a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, c = (y1 * w + x0) * 4, d = (y1 * w + x1) * 4;
  blend4(s, a, b, c, d, fx, fy, out, o);
}

/** Builds the output by asking `map` where each destination pixel comes from (source coordinates). */
export function remap(src: Raster, map: (x: number, y: number, out: [number, number]) => void, transparentOutside = false): Raster {
  const w = src.width, h = src.height, out = makeRaster(w, h), s = src.data, d = out.data, p: [number, number] = [0, 0];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { p[0] = x; p[1] = y; map(x, y, p); sample(s, w, h, p[0], p[1], d, (y * w + x) * 4, transparentOutside); }
  return out;
}

/** Generic 2-D convolution of the color channels with an n×n kernel (alpha kept). */
export function convolve(src: Raster, kernel: number[], size: number, divisor = 0, bias = 0): Raster {
  const w = src.width, h = src.height, out = makeRaster(w, h), s = src.data, d = out.data, half = (size - 1) >> 1;
  let div = divisor; if (!div) { div = kernel.reduce((a, b) => a + b, 0); if (!div) div = 1; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0;
    for (let ky = 0; ky < size; ky++) { const yy = Math.min(h - 1, Math.max(0, y + ky - half)); for (let kx = 0; kx < size; kx++) { const k = kernel[ky * size + kx]; if (!k) continue; const xx = Math.min(w - 1, Math.max(0, x + kx - half)); const o = (yy * w + xx) * 4; r += s[o] * k; g += s[o + 1] * k; b += s[o + 2] * k; } }
    const o = (y * w + x) * 4; d[o] = clamp(r / div + bias); d[o + 1] = clamp(g / div + bias); d[o + 2] = clamp(b / div + bias); d[o + 3] = s[o + 3];
  }
  return out;
}

function blend(a: Raster, b: Raster, t: number): Raster {
  const out = copy(a); const d = out.data, q = b.data;
  for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = clamp(d[i + c] + (q[i + c] - d[i + c]) * t);
  return out;
}
function screen(a: Raster, b: Raster, t: number): Raster {
  const out = copy(a); const d = out.data, q = b.data;
  for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) { const sc = 255 - ((255 - d[i + c]) * (255 - q[i + c])) / 255; d[i + c] = clamp(d[i + c] + (sc - d[i + c]) * t); }
  return out;
}

// Artistic -------------------------------------------------------------------------------------

/** Emboss: relief lit from `angle` degrees; strength 1–10. */
export function emboss(src: Raster, strength = 2, angle = 135, gray = true): Raster {
  const a = (angle * Math.PI) / 180, dx = Math.cos(a), dy = -Math.sin(a);
  const k = [-dx - dy, -2 * dy, dx - dy, -2 * dx, 0, 2 * dx, -dx + dy, 2 * dy, dx + dy].map((v) => v * strength * 0.5);
  const base = gray ? grayscale(src) : src;
  return convolve(base, k, 3, 1, 128);
}

/** Oil paint: each pixel takes the most frequent intensity bucket in its neighbourhood. */
export function oilPaint(src: Raster, radius = 3, levels = 20): Raster {
  const w = src.width, h = src.height, out = makeRaster(w, h), s = src.data, d = out.data;
  const count = new Uint32Array(levels), sr = new Float64Array(levels), sg = new Float64Array(levels), sb = new Float64Array(levels);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    count.fill(0); sr.fill(0); sg.fill(0); sb.fill(0);
    for (let dy = -radius; dy <= radius; dy++) { const yy = Math.min(h - 1, Math.max(0, y + dy)); for (let dx = -radius; dx <= radius; dx++) { const xx = Math.min(w - 1, Math.max(0, x + dx)); const o = (yy * w + xx) * 4; const l = Math.min(levels - 1, Math.floor((lumOf(s[o], s[o + 1], s[o + 2]) * levels) / 256)); count[l]++; sr[l] += s[o]; sg[l] += s[o + 1]; sb[l] += s[o + 2]; } }
    let best = 0; for (let i = 1; i < levels; i++) if (count[i] > count[best]) best = i;
    const o = (y * w + x) * 4; d[o] = sr[best] / count[best]; d[o + 1] = sg[best] / count[best]; d[o + 2] = sb[best] / count[best]; d[o + 3] = s[o + 3];
  }
  return out;
}

export type EdgeMode = 'sobel' | 'prewitt' | 'laplacian';
/** Edge detection on luminance (white edges on black, or inverted for a line drawing). */
export function edgeDetect(src: Raster, mode: EdgeMode = 'sobel', invert = false, strength = 1): Raster {
  const w = src.width, h = src.height, out = makeRaster(w, h), s = src.data, d = out.data;
  const lum = new Float32Array(w * h); for (let i = 0, j = 0; i < s.length; i += 4, j++) lum[j] = lumOf(s[i], s[i + 1], s[i + 2]);
  const at = (x: number, y: number) => lum[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v: number;
    if (mode === 'laplacian') v = Math.abs(4 * at(x, y) - at(x - 1, y) - at(x + 1, y) - at(x, y - 1) - at(x, y + 1)) * 2;
    else { const c = mode === 'sobel' ? 2 : 1; const gx = -at(x - 1, y - 1) - c * at(x - 1, y) - at(x - 1, y + 1) + at(x + 1, y - 1) + c * at(x + 1, y) + at(x + 1, y + 1); const gy = -at(x - 1, y - 1) - c * at(x, y - 1) - at(x + 1, y - 1) + at(x - 1, y + 1) + c * at(x, y + 1) + at(x + 1, y + 1); v = Math.hypot(gx, gy) / (c + 2) * 1.5; }
    v = clamp(v * strength); if (invert) v = 255 - v;
    const o = (y * w + x) * 4; d[o] = d[o + 1] = d[o + 2] = v; d[o + 3] = s[o + 3];
  }
  return out;
}

/** Median filter of the color channels with the given radius (histogram based, O(radius) per pixel per channel). */
export function median(src: Raster, radius = 2): Raster {
  const w = src.width, h = src.height, out = makeRaster(w, h), s = src.data, d = out.data;
  const hist = new Uint32Array(256);
  for (let c = 0; c < 3; c++) for (let y = 0; y < h; y++) {
    hist.fill(0); let n = 0;
    const add = (x: number, sign: number) => { for (let dy = -radius; dy <= radius; dy++) { const yy = Math.min(h - 1, Math.max(0, y + dy)); hist[s[(yy * w + Math.min(w - 1, Math.max(0, x))) * 4 + c]] += sign; n += sign; } };
    for (let x = -radius; x <= radius; x++) add(x, 1);
    for (let x = 0; x < w; x++) {
      if (x) { add(x - radius - 1, -1); add(x + radius, 1); }
      let acc = 0, m = 0; const target = (n + 1) >> 1; for (; m < 256; m++) { acc += hist[m]; if (acc >= target) break; }
      d[(y * w + x) * 4 + c] = m;
    }
  }
  for (let i = 3; i < s.length; i += 4) d[i] = s[i];
  return out;
}

/** Pencil sketch: grayscale color-dodged with its blurred negative. */
export function pencilSketch(src: Raster, radius = 6, strength = 1): Raster {
  const g = grayscale(src), inv = gaussianBlur(negative(g), radius), out = copy(g), d = out.data, q = inv.data;
  for (let i = 0; i < d.length; i += 4) { const v = q[i] >= 255 ? 255 : Math.min(255, (d[i] * 256) / (255 - q[i])); const o = clamp(255 - (255 - v) * strength); d[i] = d[i + 1] = d[i + 2] = o; }
  return out;
}

/** Watercolor: smoothed colors with a lighter paper look and soft edges. */
export function watercolor(src: Raster, radius = 3, levels = 12): Raster {
  const smooth = median(gaussianBlur(src, Math.max(1, radius / 2)), radius);
  const post = posterize(smooth, levels);
  const edges = edgeDetect(smooth, 'sobel', true, 0.6);
  const out = copy(blend(post, smooth, 0.5)); const d = out.data, e = edges.data;
  for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = clamp((d[i + c] * (e[i] * 0.5 + 128)) / 255 + 25);
  return out;
}

/** Cartoon: flattened colors with dark outlines. */
export function cartoon(src: Raster, levels = 6, edge = 60): Raster {
  const smooth = median(src, 2), post = posterize(smooth, levels), edges = edgeDetect(smooth, 'sobel', false, 1.5);
  const out = copy(post); const d = out.data, e = edges.data;
  for (let i = 0; i < d.length; i += 4) if (e[i] > edge) { d[i] = d[i + 1] = d[i + 2] = 0; }
  return out;
}

/** Halftone: round dots on a grid, sized by darkness (`cell` pixels, screen `angle` in degrees). */
export function halftone(src: Raster, cell = 6, angle = 45, color = false, ink: RGB = [0, 0, 0], paper: RGB = [255, 255, 255]): Raster {
  const w = src.width, h = src.height, out = makeRaster(w, h), s = src.data, d = out.data;
  const a = (angle * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const avg = (cx: number, cy: number, c: number) => { let sum = 0, n = 0; const r = Math.ceil(cell / 2); for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(h, cy + r); y++) for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(w, cx + r); x++) { const o = (y * w + x) * 4; sum += c < 3 ? s[o + c] : lumOf(s[o], s[o + 1], s[o + 2]); n++; } return n ? sum / n : 255; };
  const cache = new Map<string, number[]>();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    // rotate into screen space, find the cell center, rotate back
    const u = x * ca + y * sa, v = -x * sa + y * ca;
    const cu = (Math.floor(u / cell) + 0.5) * cell, cv = (Math.floor(v / cell) + 0.5) * cell;
    const cx = cu * ca - cv * sa, cy = cu * sa + cv * ca;
    const key = `${Math.round(cx)},${Math.round(cy)}`;
    let vals = cache.get(key); if (!vals) { vals = color ? [avg(cx, cy, 0), avg(cx, cy, 1), avg(cx, cy, 2)] : [avg(cx, cy, 3)]; cache.set(key, vals); }
    const dist = Math.hypot(x - cx, y - cy);
    const o = (y * w + x) * 4;
    if (color) for (let c = 0; c < 3; c++) { const rad = (cell / 2) * Math.sqrt(1 - vals[c] / 255) * 1.15; d[o + c] = dist < rad ? 0 : 255; }
    else { const rad = (cell / 2) * Math.sqrt(1 - vals[0] / 255) * 1.15; const inDot = dist < rad; for (let c = 0; c < 3; c++) d[o + c] = inDot ? ink[c] : paper[c]; }
    d[o + 3] = s[o + 3];
  }
  return out;
}

/** Pixelate: blocks of `size` pixels take their average color. */
export function pixelize(src: Raster, size = 8): Raster {
  const w = src.width, h = src.height, out = makeRaster(w, h), s = src.data, d = out.data, n = Math.max(1, Math.round(size));
  for (let by = 0; by < h; by += n) for (let bx = 0; bx < w; bx += n) {
    let r = 0, g = 0, b = 0, a = 0, cnt = 0;
    for (let y = by; y < Math.min(h, by + n); y++) for (let x = bx; x < Math.min(w, bx + n); x++) { const o = (y * w + x) * 4; r += s[o]; g += s[o + 1]; b += s[o + 2]; a += s[o + 3]; cnt++; }
    for (let y = by; y < Math.min(h, by + n); y++) for (let x = bx; x < Math.min(w, bx + n); x++) { const o = (y * w + x) * 4; d[o] = r / cnt; d[o + 1] = g / cnt; d[o + 2] = b / cnt; d[o + 3] = a / cnt; }
  }
  return out;
}

/** Mosaic: pixelate with grout lines of `gap` pixels in `grout` color. */
export function mosaic(src: Raster, size = 12, gap = 1, grout: RGB = [40, 40, 40]): Raster {
  const out = pixelize(src, size), d = out.data, w = src.width, h = src.height;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x % size < gap || y % size < gap) { const o = (y * w + x) * 4; d[o] = grout[0]; d[o + 1] = grout[1]; d[o + 2] = grout[2]; }
  return out;
}

/** Solarize: values above the threshold are inverted. */
export function solarize(src: Raster, threshold = 128): Raster {
  const t = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) t[i] = i >= threshold ? 255 - i : i;
  return applyLut(src, t);
}

/** Tiles: square tiles jittered by up to `offset` pixels over a `grout` background. */
export function tiles(src: Raster, size = 24, offset = 6, grout: RGB = [0, 0, 0], seed = 7): Raster {
  const w = src.width, h = src.height, out = makeRaster(w, h), s = src.data, d = out.data, rnd = rng(seed);
  for (let i = 0; i < d.length; i += 4) { d[i] = grout[0]; d[i + 1] = grout[1]; d[i + 2] = grout[2]; d[i + 3] = 255; }
  for (let ty = 0; ty < h; ty += size) for (let tx = 0; tx < w; tx += size) {
    const ox = Math.round((rnd() * 2 - 1) * offset), oy = Math.round((rnd() * 2 - 1) * offset);
    for (let y = ty; y < Math.min(h, ty + size - 1); y++) for (let x = tx; x < Math.min(w, tx + size - 1); x++) {
      const dx = x + ox, dy = y + oy; if (dx < 0 || dy < 0 || dx >= w || dy >= h) continue;
      const so = (y * w + x) * 4, o = (dy * w + dx) * 4; d[o] = s[so]; d[o + 1] = s[so + 1]; d[o + 2] = s[so + 2]; d[o + 3] = s[so + 3];
    }
  }
  return out;
}

/** 3-D button: bevelled edges, light top-left and dark bottom-right (`bevel` pixels wide). */
export function button3d(src: Raster, bevel = 12, depth = 0.5): Raster {
  const w = src.width, h = src.height, out = copy(src), d = out.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const l = x, t = y, r = w - 1 - x, b = h - 1 - y, m = Math.min(l, t, r, b);
    if (m >= bevel) continue;
    const k = (1 - m / bevel) * depth;
    const light = m === l || m === t ? (m === l && m === r ? 0 : 1) : -1;
    const o = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) d[o + c] = clamp(d[o + c] + light * k * 160);
  }
  return out;
}

// Photographic ---------------------------------------------------------------------------------

/** Adds noise: amount 0–100, Gaussian or uniform, monochrome or per channel. */
export function noise(src: Raster, amount = 20, mono = true, gaussian = true, seed = 3): Raster {
  const out = copy(src), d = out.data, rnd = rng(seed), k = amount * 1.28;
  const g = () => { const u = Math.max(1e-9, rnd()), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * 0.5; };
  const n = () => (gaussian ? g() : rnd() * 2 - 1) * k;
  for (let i = 0; i < d.length; i += 4) { if (mono) { const v = n(); d[i] = clamp(d[i] + v); d[i + 1] = clamp(d[i + 1] + v); d[i + 2] = clamp(d[i + 2] + v); } else for (let c = 0; c < 3; c++) d[i + c] = clamp(d[i + c] + n()); }
  return out;
}

/** Film grain: luminance-weighted noise in clumps of `size` pixels, strongest in the midtones. */
export function filmGrain(src: Raster, amount = 30, size = 1, seed = 5): Raster {
  const w = src.width, h = src.height, gw = Math.ceil(w / size), gh = Math.ceil(h / size);
  let grain = makeRaster(gw, gh); grain.data.fill(128); for (let i = 3; i < grain.data.length; i += 4) grain.data[i] = 255;
  grain = noise(grain, amount, true, true, seed);
  if (size > 1) grain = resample(grain, w, h, 'bilinear');
  const out = copy(src), d = out.data, g = grain.data;
  for (let i = 0; i < d.length; i += 4) { const l = lumOf(d[i], d[i + 1], d[i + 2]) / 255; const wgt = 1 - Math.abs(l - 0.5) * 1.2; const v = (g[i] - 128) * wgt; d[i] = clamp(d[i] + v); d[i + 1] = clamp(d[i + 1] + v); d[i + 2] = clamp(d[i + 2] + v); }
  return out;
}

/** Soft focus: the picture blended with a blurred copy. */
export const softFocus = (src: Raster, radius = 8, amount = 50): Raster => blend(src, gaussianBlur(src, radius), amount / 100);

/** Glow: bright areas bloom (screen blend of a blurred, brightened copy). */
export function glow(src: Raster, radius = 12, amount = 60, threshold = 160): Raster {
  const t = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) t[i] = i < threshold ? 0 : Math.round(((i - threshold) * 255) / (255 - threshold));
  const bright = gaussianBlur(applyLut(src, t), radius);
  return screen(src, bright, amount / 100);
}

/** Orton glow: a dreamy look, screen of a blurred copy plus contrast and saturation. */
export function orton(src: Raster, radius = 10, amount = 70): Raster {
  const soft = gaussianBlur(src, radius);
  return saturate(colorCorrect(screen(src, soft, amount / 100), { contrast: 15 }), 0.15);
}

/** Color kept inside a circle (center as fractions, radius as a fraction of the half diagonal, feather 0–1). */
export function focalBW(src: Raster, cx = 0.5, cy = 0.5, radius = 0.4, feather = 0.3, outside: 'gray' | 'sepia' = 'gray'): Raster {
  const w = src.width, h = src.height, out = copy(src), d = out.data, half = Math.hypot(w, h) / 2;
  const r0 = radius * half, r1 = r0 * (1 + feather) + 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dist = Math.hypot(x - cx * w, y - cy * h); if (dist <= r0) continue;
    const t = Math.min(1, (dist - r0) / (r1 - r0)), o = (y * w + x) * 4, l = lumOf(d[o], d[o + 1], d[o + 2]);
    const g: RGB = outside === 'sepia' ? [clamp(l * 1.07 + 10), clamp(l * 0.95), clamp(l * 0.8)] : [l, l, l];
    for (let c = 0; c < 3; c++) d[o + c] = clamp(d[o + c] + (g[c] - d[o + c]) * t);
  }
  return out;
}

/** Graduated tint: a color fading in from one edge (direction in degrees, 0 = from the top), strength 0–100, `position` 0–1 where the fade ends. */
export function graduatedTint(src: Raster, color: RGB = [255, 160, 60], direction = 0, strength = 50, position = 0.5): Raster {
  const w = src.width, h = src.height, out = copy(src), d = out.data, a = (direction * Math.PI) / 180, nx = -Math.sin(a), ny = Math.cos(a);
  const proj = (x: number, y: number) => ((x / w - 0.5) * nx + (y / h - 0.5) * ny + 0.5);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const t = Math.max(0, Math.min(1, 1 - proj(x, y) / Math.max(0.01, position))) * (strength / 100), o = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) d[o + c] = clamp(d[o + c] + (color[c] - d[o + c]) * t);
  }
  return out;
}

/** Cross process: the slide-in-print-chemistry look (S-curves per channel, cyan shadows, yellow highlights). */
export function crossProcess(src: Raster, strength = 100): Raster {
  const k = strength / 100;
  const curve = (pts: [number, number][]) => { const t = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) { let j = 1; while (j < pts.length - 1 && pts[j][0] < i) j++; const [x0, y0] = pts[j - 1], [x1, y1] = pts[j]; const v = y0 + ((i - x0) * (y1 - y0)) / Math.max(1, x1 - x0); t[i] = clamp(Math.round(i + (v - i) * k)); } return t; };
  const r = curve([[0, 0], [60, 35], [128, 140], [200, 225], [255, 255]]), g = curve([[0, 0], [64, 50], [128, 130], [192, 210], [255, 255]]), b = curve([[0, 40], [96, 100], [192, 170], [255, 210]]);
  return saturate(applyLut(src, r, g, b), 0.2 * k);
}

/** Toy camera: boosted saturation and contrast, a warm cast, soft corners and a heavy vignette. */
export function toyCamera(src: Raster, strength = 100): Raster {
  const k = strength / 100;
  let out = colorCorrect(src, { contrast: 30 * k, saturation: 60 * k, red: 10 * k, blue: -12 * k });
  out = vignette(out, 70 * k, 0.55, [0, 0, 0]);
  const soft = gaussianBlur(out, 3);
  const w = out.width, h = out.height, d = out.data, q = soft.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const t = Math.min(1, Math.hypot((x / w - 0.5) * 2, (y / h - 0.5) * 2) ** 2) * k; const o = (y * w + x) * 4; for (let c = 0; c < 3; c++) d[o + c] = clamp(d[o + c] + (q[o + c] - d[o + c]) * t); }
  return out;
}

/** Tilt-shift miniature: a sharp horizontal band at `center` (0–1) of height `band` (0–1), blurred elsewhere, with a saturation boost. */
export function tiltShift(src: Raster, center = 0.5, band = 0.3, feather = 0.2, radius = 8, boost = 30): Raster {
  const soft = gaussianBlur(src, radius), out = saturate(src, boost / 100), d = out.data, q = soft.data, w = src.width, h = src.height;
  for (let y = 0; y < h; y++) { const dist = Math.abs(y / h - center) - band / 2; const t = dist <= 0 ? 0 : Math.min(1, dist / Math.max(0.001, feather)); if (!t) continue; for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; for (let c = 0; c < 3; c++) d[o + c] = clamp(d[o + c] + (q[o + c] - d[o + c]) * t); } }
  return out;
}

/** Duotone: luminance mapped between a dark and a light color. */
export function duotone(src: Raster, dark: RGB = [20, 30, 80], light: RGB = [255, 230, 180]): Raster {
  const out = copy(src), d = out.data;
  for (let i = 0; i < d.length; i += 4) { const t = lumOf(d[i], d[i + 1], d[i + 2]) / 255; for (let c = 0; c < 3; c++) d[i + c] = clamp(dark[c] + (light[c] - dark[c]) * t); }
  return out;
}

// Distortions ----------------------------------------------------------------------------------

/** Swirl around the center by `angle` degrees at the center, falling off to `radius` (fraction of the half diagonal). */
export function swirl(src: Raster, angle = 90, radius = 1, cx = 0.5, cy = 0.5): Raster {
  const w = src.width, h = src.height, ox = cx * w, oy = cy * h, R = radius * Math.hypot(w, h) / 2, a0 = (angle * Math.PI) / 180;
  return remap(src, (x, y, p) => { const dx = x - ox, dy = y - oy, r = Math.hypot(dx, dy); if (r >= R) return; const t = a0 * (1 - r / R) ** 2, c = Math.cos(t), s = Math.sin(t); p[0] = ox + dx * c - dy * s; p[1] = oy + dx * s + dy * c; });
}

/** Explosion: pixels thrown outward from the center by random distances up to `amount` pixels. */
export function explosion(src: Raster, amount = 12, cx = 0.5, cy = 0.5, seed = 11): Raster {
  const w = src.width, h = src.height, ox = cx * w, oy = cy * h, rnd = rng(seed), jitter = new Float32Array(w * h); for (let i = 0; i < jitter.length; i++) jitter[i] = rnd();
  return remap(src, (x, y, p) => { const dx = x - ox, dy = y - oy, r = Math.hypot(dx, dy) || 1, k = jitter[y * w + x] * amount; p[0] = x - (dx / r) * k; p[1] = y - (dy / r) * k; });
}

/** Rain drops: round lenses of random size scattered over the picture. */
export function rain(src: Raster, count = 40, size = 24, seed = 13): Raster {
  const w = src.width, h = src.height, rnd = rng(seed), drops: [number, number, number][] = [];
  for (let i = 0; i < count; i++) drops.push([rnd() * w, rnd() * h, size * (0.4 + rnd() * 0.6)]);
  const out = remap(src, (x, y, p) => { for (const [dx, dy, r] of drops) { const ex = x - dx, ey = y - dy, d = Math.hypot(ex, ey); if (d < r) { const k = 1 - ((1 - d / r) ** 2) * 0.6; p[0] = dx + ex * k; p[1] = dy + ey * k; return; } } });
  const d = out.data;
  for (const [dx, dy, r] of drops) for (let y = Math.max(0, Math.floor(dy - r)); y < Math.min(h, dy + r); y++) for (let x = Math.max(0, Math.floor(dx - r)); x < Math.min(w, dx + r); x++) { const dd = Math.hypot(x - dx, y - dy); if (dd < r && dd > r * 0.85) { const o = (y * w + x) * 4; for (let c = 0; c < 3; c++) d[o + c] = clamp(d[o + c] + ((x - dx) + (y - dy) < 0 ? 40 : -30)); } }
  return out;
}

/** Fragment: four copies offset in the diagonal directions, averaged. */
export function fragment(src: Raster, distance = 4): Raster {
  const w = src.width, h = src.height, out = makeRaster(w, h), s = src.data, d = out.data, tmp = new Uint8ClampedArray(4), offs = [[-distance, -distance], [distance, -distance], [-distance, distance], [distance, distance]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let r = 0, g = 0, b = 0, a = 0; for (const [ox, oy] of offs) { sample(s, w, h, x + ox, y + oy, tmp, 0); r += tmp[0]; g += tmp[1]; b += tmp[2]; a += tmp[3]; } const o = (y * w + x) * 4; d[o] = r / 4; d[o + 1] = g / 4; d[o + 2] = b / 4; d[o + 3] = a / 4; }
  return out;
}

/** Spread: each pixel swapped with a random neighbour within `amount` pixels. */
export function spread(src: Raster, amount = 5, seed = 17): Raster {
  const rnd = rng(seed);
  return remap(src, (x, y, p) => { p[0] = x + (rnd() * 2 - 1) * amount; p[1] = y + (rnd() * 2 - 1) * amount; });
}

/** Shift lines: rows (or columns) shifted sideways by random amounts, in bands of `band` pixels. */
export function shiftLines(src: Raster, amount = 10, band = 4, vertical = false, seed = 19): Raster {
  const rnd = rng(seed), shifts = new Map<number, number>();
  const sh = (i: number) => { const k = Math.floor(i / band); let v = shifts.get(k); if (v === undefined) { v = (rnd() * 2 - 1) * amount; shifts.set(k, v); } return v; };
  return remap(src, (x, y, p) => { if (vertical) p[1] = y + sh(x); else p[0] = x + sh(y); });
}

/** Radial (spin) blur around the center by `angle` degrees. */
export function radialBlur(src: Raster, angle = 10, steps = 12, cx = 0.5, cy = 0.5): Raster {
  const w = src.width, h = src.height, ox = cx * w, oy = cy * h, out = makeRaster(w, h), s = src.data, d = out.data, tmp = new Uint8ClampedArray(4), a0 = (angle * Math.PI) / 180;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x - ox, dy = y - oy; let r = 0, g = 0, b = 0, a = 0;
    for (let i = 0; i < steps; i++) { const t = a0 * (i / (steps - 1) - 0.5), c = Math.cos(t), sn = Math.sin(t); sample(s, w, h, ox + dx * c - dy * sn, oy + dx * sn + dy * c, tmp, 0); r += tmp[0]; g += tmp[1]; b += tmp[2]; a += tmp[3]; }
    const o = (y * w + x) * 4; d[o] = r / steps; d[o + 1] = g / steps; d[o + 2] = b / steps; d[o + 3] = a / steps;
  }
  return out;
}

/** Zoom blur: streaks toward the center, `amount` as a fraction of the distance. */
export function zoomBlur(src: Raster, amount = 0.1, steps = 12, cx = 0.5, cy = 0.5): Raster {
  const w = src.width, h = src.height, ox = cx * w, oy = cy * h, out = makeRaster(w, h), s = src.data, d = out.data, tmp = new Uint8ClampedArray(4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x - ox, dy = y - oy; let r = 0, g = 0, b = 0, a = 0;
    for (let i = 0; i < steps; i++) { const k = 1 - amount * (i / (steps - 1)); sample(s, w, h, ox + dx * k, oy + dy * k, tmp, 0); r += tmp[0]; g += tmp[1]; b += tmp[2]; a += tmp[3]; }
    const o = (y * w + x) * 4; d[o] = r / steps; d[o + 1] = g / steps; d[o + 2] = b / steps; d[o + 3] = a / steps;
  }
  return out;
}

/** Fisheye (positive amount) or barrel/pincushion correction (negative). */
export function fishEye(src: Raster, amount = 0.5): Raster {
  const w = src.width, h = src.height, ox = w / 2, oy = h / 2, R = Math.hypot(ox, oy);
  return remap(src, (x, y, p) => { const dx = (x - ox) / R, dy = (y - oy) / R, r = Math.hypot(dx, dy); if (!r) return; const k = amount >= 0 ? Math.pow(r, 1 + amount) / r : Math.pow(r, 1 / (1 - amount)) / r; p[0] = ox + dx * k * R; p[1] = oy + dy * k * R; });
}

/** Wave: sinusoidal displacement (amplitude and wavelength in pixels), horizontal and/or vertical. */
export function wave(src: Raster, amplitude = 10, wavelength = 60, direction: 'both' | 'horizontal' | 'vertical' = 'both', phase = 0): Raster {
  const f = (2 * Math.PI) / Math.max(1, wavelength), ph = (phase * Math.PI) / 180;
  return remap(src, (x, y, p) => { if (direction !== 'vertical') p[0] = x + amplitude * Math.sin(y * f + ph); if (direction !== 'horizontal') p[1] = y + amplitude * Math.sin(x * f + ph); });
}

/** Glass: looking through textured glass, random refraction in cells of `cell` pixels. */
export function glass(src: Raster, amount = 6, cell = 8, seed = 23): Raster {
  const w = src.width, h = src.height, gw = Math.ceil(w / cell) + 2, gh = Math.ceil(h / cell) + 2, rnd = rng(seed), gx = new Float32Array(gw * gh), gy = new Float32Array(gw * gh);
  for (let i = 0; i < gx.length; i++) { gx[i] = (rnd() * 2 - 1) * amount; gy[i] = (rnd() * 2 - 1) * amount; }
  const at = (g: Float32Array, x: number, y: number) => { const fx = x / cell, fy = y / cell, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0, i = y0 * gw + x0; return (g[i] * (1 - tx) + g[i + 1] * tx) * (1 - ty) + (g[i + gw] * (1 - tx) + g[i + gw + 1] * tx) * ty; };
  return remap(src, (x, y, p) => { p[0] = x + at(gx, x, y); p[1] = y + at(gy, x, y); });
}

/** Ripple: concentric waves from the center. */
export function ripple(src: Raster, amplitude = 6, wavelength = 24, cx = 0.5, cy = 0.5): Raster {
  const w = src.width, h = src.height, ox = cx * w, oy = cy * h, f = (2 * Math.PI) / Math.max(1, wavelength);
  return remap(src, (x, y, p) => { const dx = x - ox, dy = y - oy, r = Math.hypot(dx, dy) || 1, k = amplitude * Math.sin(r * f); p[0] = x + (dx / r) * k; p[1] = y + (dy / r) * k; });
}

/** Pinch (positive) or bulge (negative) toward the center, within `radius` (fraction of the half diagonal). */
export function pinch(src: Raster, amount = 0.5, radius = 0.8, cx = 0.5, cy = 0.5): Raster {
  const w = src.width, h = src.height, ox = cx * w, oy = cy * h, R = radius * Math.hypot(w, h) / 2;
  return remap(src, (x, y, p) => { const dx = x - ox, dy = y - oy, r = Math.hypot(dx, dy); if (r >= R || !r) return; const t = r / R, k = Math.pow(t, amount >= 0 ? 1 + amount : 1 / (1 - amount)) / t; p[0] = ox + dx * k; p[1] = oy + dy * k; });
}

/** Polar coordinates: rectangular → polar (the top row becomes the center) or back. */
export function polar(src: Raster, toPolar = true): Raster {
  const w = src.width, h = src.height, ox = w / 2, oy = h / 2, R = Math.min(ox, oy);
  if (toPolar) return remap(src, (x, y, p) => { const dx = x - ox, dy = y - oy, r = Math.hypot(dx, dy); let a = Math.atan2(dx, -dy); if (a < 0) a += 2 * Math.PI; p[0] = (a / (2 * Math.PI)) * (w - 1); p[1] = (r / R) * (h - 1); }, true);
  return remap(src, (x, y, p) => { const a = (x / (w - 1)) * 2 * Math.PI, r = (y / (h - 1)) * R; p[0] = ox + Math.sin(a) * r; p[1] = oy - Math.cos(a) * r; });
}

// Frames and shadows ---------------------------------------------------------------------------

/** Drop shadow: the canvas grows and a blurred shadow is drawn offset behind the picture over `bg`. */
export function dropShadow(src: Raster, offset = 12, blur = 10, opacity = 0.6, color: RGB = [0, 0, 0], bg: RGB = [255, 255, 255]): Raster {
  const pad = blur * 2, w = src.width, h = src.height, W = w + pad * 2 + Math.abs(offset), H = h + pad * 2 + Math.abs(offset);
  const shadow = makeRaster(W, H), sd = shadow.data, x0 = pad + Math.max(0, -offset), y0 = pad + Math.max(0, -offset), sx = x0 + offset, sy = y0 + offset;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) sd[((sy + y) * W + sx + x) * 4 + 3] = src.data[(y * w + x) * 4 + 3];
  const soft = blur ? gaussianBlur(shadow, blur) : shadow, out = makeRaster(W, H), d = out.data, q = soft.data;
  for (let i = 0; i < d.length; i += 4) { const a = (q[i + 3] / 255) * opacity; for (let c = 0; c < 3; c++) d[i + c] = bg[c] + (color[c] - bg[c]) * a; d[i + 3] = 255; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const so = (y * w + x) * 4, o = ((y0 + y) * W + x0 + x) * 4, a = src.data[so + 3] / 255; for (let c = 0; c < 3; c++) d[o + c] = d[o + c] + (src.data[so + c] - d[o + c]) * a; }
  return out;
}

/** Reflection: a mirrored, fading copy appended below (height as a fraction, gap in pixels). */
export function reflection(src: Raster, height = 0.4, gap = 2, opacity = 0.5, bg: RGB = [255, 255, 255]): Raster {
  const w = src.width, h = src.height, rh = Math.round(h * height), out = makeRaster(w, h + gap + rh), d = out.data;
  for (let i = 0; i < d.length; i += 4) { d[i] = bg[0]; d[i + 1] = bg[1]; d[i + 2] = bg[2]; d[i + 3] = 255; }
  d.set(src.data, 0);
  for (let y = 0; y < rh; y++) { const sy = h - 1 - y, a = opacity * (1 - y / rh); for (let x = 0; x < w; x++) { const so = (sy * w + x) * 4, o = ((h + gap + y) * w + x) * 4, k = a * (src.data[so + 3] / 255); for (let c = 0; c < 3; c++) d[o + c] = bg[c] + (src.data[so + c] - bg[c]) * k; } }
  return out;
}

/** Round corners: pixels outside the rounded rectangle become `bg` (or transparent when `bg` is null). */
export function roundCorners(src: Raster, radius = 24, bg: RGB | null = null): Raster {
  const w = src.width, h = src.height, out = copy(src), d = out.data, r = Math.min(radius, w / 2, h / 2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const cx = x < r ? r - 0.5 : x >= w - r ? w - r - 0.5 : x, cy = y < r ? r - 0.5 : y >= h - r ? h - r - 0.5 : y;
    const dist = Math.hypot(x - cx, y - cy) - r + 0.5; if (dist <= 0) continue;
    const cov = Math.max(0, 1 - dist), o = (y * w + x) * 4;
    if (bg) { for (let c = 0; c < 3; c++) d[o + c] = bg[c] + (d[o + c] - bg[c]) * cov; } else d[o + 3] = d[o + 3] * cov;
  }
  return out;
}

/** Instant-print frame: a white border with a wider strip at the bottom. */
export function instantFrame(src: Raster, border = 0.05, bottom = 0.2, color: RGB = [250, 250, 245]): Raster {
  const w = src.width, h = src.height, b = Math.round(Math.min(w, h) * border), bb = Math.round(Math.min(w, h) * bottom), out = makeRaster(w + 2 * b, h + b + bb), d = out.data, W = out.width;
  for (let i = 0; i < d.length; i += 4) { d[i] = color[0]; d[i + 1] = color[1]; d[i + 2] = color[2]; d[i + 3] = 255; }
  for (let y = 0; y < h; y++) d.set(src.data.subarray(y * w * 4, (y + 1) * w * 4), ((b + y) * W + b) * 4);
  return out;
}

/** Vignette frame: a soft frame in `color` fading in over `width` (fraction of the half size), rectangular or oval. */
export function vignetteFrame(src: Raster, width = 0.3, color: RGB = [255, 255, 255], oval = false): Raster {
  const w = src.width, h = src.height, out = copy(src), d = out.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const nx = Math.abs(x / w - 0.5) * 2, ny = Math.abs(y / h - 0.5) * 2;
    const e = oval ? Math.hypot(nx, ny) : Math.max(nx, ny);
    const t = Math.max(0, Math.min(1, (e - (1 - width)) / width)), o = (y * w + x) * 4;
    if (!t) continue; const k = t * t;
    for (let c = 0; c < 3; c++) d[o + c] = d[o + c] + (color[c] - d[o + c]) * k;
  }
  return out;
}

/** Hue shift helper for effect presets (exported for the effects browser). */
export const hueShift = (src: Raster, deg: number): Raster => hsl(src, { hue: deg });
