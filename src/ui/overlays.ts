/**
 * View-only overlays and display filters drawn by the viewer: grid and guides, rulers, clipping
 * warnings, focus peaking, a histogram, the information overlay (OSD), the loupe; grayscale
 * preview, color-blindness simulation and display adjustments (brightness, contrast, gamma).
 * Nothing here changes the picture.
 */
import { readout } from '../picture/measure';
import type { Viewer } from './viewer';
import type { Frame, Page } from '../picture/model';
import { colorStep } from '../color/display';

export type GridMode = 'off' | 'thirds' | 'golden' | 'square';
export type ColorBlind = 'off' | 'protanopia' | 'deuteranopia' | 'tritanopia' | 'achromatopsia';
export const viewState = {
  /** A template that replaces the user's for the moment (slideshow captions, cull mode); view state, so it is never saved as the preference. */
  osdTemplate: null as string | null,
  grid: 'off' as GridMode, gridSize: 50, rulers: false, clipping: false, peaking: false, histogram: false, osd: false, loupe: false, loupeZoom: 4,
  grayscale: false, colorBlind: 'off' as ColorBlind, display: { brightness: 0, contrast: 0, gamma: 1 },
  /** Navigator: a mini-map of the whole picture with the visible part outlined (when it does not fit). */
  navigator: false,
  /** Measure: points in picture pixels, whether the shape is closed, and the scale. */
  measure: { on: false, pts: [] as [number, number][], closed: false, scale: null as { perPx: number; unit: string } | null },
  /** Recognize Text: word boxes (picture pixels) and the search that highlights some of them. */
  ocr: { show: false, words: [] as { text: string; conf: number; bbox: { x0: number; y0: number; x1: number; y1: number } }[], query: '' },
  /** Read QR Code or Barcode: the outlines of the codes found. */
  codes: [] as { text: string; format: string; corners: [number, number][] }[],
};
/** True when the OCR search matches this word (case- and accent-insensitive). */
const fold = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export const ocrMatch = (word: string, q: string): boolean => !!q.trim() && fold(word).includes(fold(q.trim()));

/** Where the navigator sits (CSS px, bottom right) and its scale (navigator px per picture px). */
export function navigatorRect(vw: number, vh: number, pw: number, ph: number, size = 180, margin = 12): { x: number; y: number; w: number; h: number; k: number } {
  const k = Math.min(size / pw, size / ph);
  const w = Math.max(1, Math.round(pw * k)), h = Math.max(1, Math.round(ph * k));
  return { x: vw - w - margin, y: vh - h - margin, w, h, k };
}
/** The navigator is shown only when the picture is larger than the view. */
export const navigatorShown = (vw: number, vh: number, r: { w: number; h: number }): boolean => viewState.navigator && (r.w > vw + 1 || r.h > vh + 1);
export const displayActive = (): boolean => viewState.grayscale || viewState.colorBlind !== 'off' || viewState.display.brightness !== 0 || viewState.display.contrast !== 0 || viewState.display.gamma !== 1;

// Pure helpers (tested) ----------------------------------------------------------------------------
/** Luminance and RGB histograms (256 bins each) of RGBA data. */
export function histogram(data: Uint8ClampedArray): { lum: Uint32Array; r: Uint32Array; g: Uint32Array; b: Uint32Array; clippedHi: number; clippedLo: number } {
  const lum = new Uint32Array(256), r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256); let hi = 0, lo = 0;
  for (let i = 0; i < data.length; i += 4) { r[data[i]]++; g[data[i + 1]]++; b[data[i + 2]]++; lum[Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])]++; if (data[i] >= 254 || data[i + 1] >= 254 || data[i + 2] >= 254) hi++; if (data[i] <= 1 && data[i + 1] <= 1 && data[i + 2] <= 1) lo++; }
  return { lum, r, g, b, clippedHi: hi, clippedLo: lo };
}
/** Marks lost highlights (any channel ≥ 254) red and lost shadows (all ≤ 1) blue; everything else transparent. */
export function clippingMask(data: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) { if (data[i] >= 254 || data[i + 1] >= 254 || data[i + 2] >= 254) { out[i] = 255; out[i + 3] = 200; } else if (data[i] <= 1 && data[i + 1] <= 1 && data[i + 2] <= 1) { out[i + 2] = 255; out[i + 3] = 200; } }
  return out;
}
/** Focus peaking: pixels whose local contrast (Laplacian of luminance) exceeds `threshold` in a bright color. */
export function peakingMask(data: Uint8ClampedArray, w: number, h: number, threshold = 40, color: [number, number, number] = [255, 40, 40]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data.length), lum = new Float32Array(w * h);
  for (let i = 0, j = 0; j < lum.length; i += 4, j++) lum[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; const lap = Math.abs(4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - w] - lum[i + w]); if (lap > threshold) { const o = i * 4; out[o] = color[0]; out[o + 1] = color[1]; out[o + 2] = color[2]; out[o + 3] = 255; } }
  return out;
}
/** Display lookup table for brightness (−100…100), contrast (−100…100) and gamma. */
export function displayLut(brightness: number, contrast: number, gamma: number): Uint8ClampedArray {
  const t = new Uint8ClampedArray(256), k = Math.tan(((contrast + 100) / 200) * (Math.PI / 2) * 0.98) / Math.tan((Math.PI / 4) * 0.98);
  for (let i = 0; i < 256; i++) { let v = (i - 128) * k + 128 + brightness * 1.28; v = 255 * Math.pow(Math.max(0, Math.min(1, v / 255)), 1 / Math.max(0.05, gamma)); t[i] = Math.max(0, Math.min(255, Math.round(v))); }
  return t;
}
/** Machado et al. (2009) full-severity simulation matrices (sRGB, row-major). */
export const CB_MATRIX: Record<Exclude<ColorBlind, 'off'>, number[]> = {
  protanopia: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.011820, 0.042940, 0.968881],
  tritanopia: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.303900],
  achromatopsia: [0.299, 0.587, 0.114, 0.299, 0.587, 0.114, 0.299, 0.587, 0.114],
};
export function applyDisplay(data: Uint8ClampedArray, o: { grayscale?: boolean; colorBlind?: ColorBlind; lut?: Uint8ClampedArray | null }): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data.length); out.set(data);
  const m = o.colorBlind && o.colorBlind !== 'off' ? CB_MATRIX[o.colorBlind] : null;
  for (let i = 0; i < out.length; i += 4) {
    let r = out[i], g = out[i + 1], b = out[i + 2];
    if (o.lut) { r = o.lut[r]; g = o.lut[g]; b = o.lut[b]; }
    if (m) { const nr = m[0] * r + m[1] * g + m[2] * b, ng = m[3] * r + m[4] * g + m[5] * b, nb = m[6] * r + m[7] * g + m[8] * b; r = nr; g = ng; b = nb; }
    if (o.grayscale) { const l = 0.299 * r + 0.587 * g + 0.114 * b; r = g = b = l; }
    out[i] = Math.max(0, Math.min(255, Math.round(r))); out[i + 1] = Math.max(0, Math.min(255, Math.round(g))); out[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
  }
  return out;
}
/** Expands {name} {w} {h} {zoom} {n} {total} {exifdate} {camera} {exposure} {size} {page} {pages} in an overlay template. */
export function expandOsd(template: string, v: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k) => (v[k] !== undefined ? String(v[k]) : '')).split('\n').map((l) => l.replace(/\s+$/, '')).filter((l, i, a) => l.trim() || (i > 0 && i < a.length - 1)).join('\n');
}
/** A color formatted as hex, rgb(), hsl() or the nearest CSS color name. */
export function formatColor(rgb: [number, number, number], how: 'hex' | 'rgb' | 'hsl' | 'name'): string {
  const [r, g, b] = rgb;
  if (how === 'hex') return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
  if (how === 'rgb') return `rgb(${r}, ${g}, ${b})`;
  if (how === 'hsl') { const rr = r / 255, gg = g / 255, bb = b / 255, mx = Math.max(rr, gg, bb), mn = Math.min(rr, gg, bb), l = (mx + mn) / 2; let h = 0, s = 0; if (mx !== mn) { const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === rr ? ((gg - bb) / d + (gg < bb ? 6 : 0)) : mx === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4; h *= 60; } return `hsl(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`; }
  let best = 'black', bd = Infinity; for (const [name, [nr, ng, nb]] of Object.entries(CSS_COLORS)) { const d = (nr - r) ** 2 + (ng - g) ** 2 + (nb - b) ** 2; if (d < bd) { bd = d; best = name; } } return best;
}
const CSS_COLORS: Record<string, [number, number, number]> = { black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], lime: [0, 255, 0], blue: [0, 0, 255], yellow: [255, 255, 0], cyan: [0, 255, 255], magenta: [255, 0, 255], silver: [192, 192, 192], gray: [128, 128, 128], maroon: [128, 0, 0], olive: [128, 128, 0], green: [0, 128, 0], purple: [128, 0, 128], teal: [0, 128, 128], navy: [0, 0, 128], orange: [255, 165, 0], pink: [255, 192, 203], brown: [165, 42, 42], gold: [255, 215, 0], coral: [255, 127, 80], salmon: [250, 128, 114], khaki: [240, 230, 140], tan: [210, 180, 140], beige: [245, 245, 220], ivory: [255, 255, 240], lavender: [230, 230, 250], violet: [238, 130, 238], indigo: [75, 0, 130], turquoise: [64, 224, 208], skyblue: [135, 206, 235], steelblue: [70, 130, 180], slategray: [112, 128, 144], darkgray: [169, 169, 169], lightgray: [211, 211, 211], crimson: [220, 20, 60], tomato: [255, 99, 71], chocolate: [210, 105, 30], sienna: [160, 82, 45], peru: [205, 133, 63], wheat: [245, 222, 179], forestgreen: [34, 139, 34], seagreen: [46, 139, 87], olivedrab: [107, 142, 35], darkgreen: [0, 100, 0], royalblue: [65, 105, 225], dodgerblue: [30, 144, 255], midnightblue: [25, 25, 112], plum: [221, 160, 221], orchid: [218, 112, 214], hotpink: [255, 105, 180], darkred: [139, 0, 0] };

// Cached processed canvases per frame --------------------------------------------------------------
const caches = new WeakMap<Frame, { key: string; display?: HTMLCanvasElement; clip?: HTMLCanvasElement; peak?: HTMLCanvasElement; hist?: ReturnType<typeof histogram> }>();
const frameData = (f: Frame): { c: HTMLCanvasElement; data: Uint8ClampedArray } => { const c = f.image instanceof HTMLCanvasElement ? f.image : (() => { const cv = document.createElement('canvas'); cv.width = f.width; cv.height = f.height; cv.getContext('2d')!.drawImage(f.image as CanvasImageSource, 0, 0); return cv; })(); return { c, data: c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, f.width, f.height).data }; };
const canvasFrom = (data: Uint8ClampedArray, w: number, h: number) => { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d')!.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0); return c; };
function cacheFor(f: Frame, key: string) { let c = caches.get(f); if (!c || c.key !== key) { c = { key }; caches.set(f, c); } return c; }

/** The frame to draw: the original, or a copy with the display filters applied (cached). */
export function displayFrame(f: Frame, page?: Page | null): CanvasImageSource {
  const cm = colorStep(page), adjust = displayActive();
  if (!adjust && !cm) return f.image as CanvasImageSource;
  const d = viewState.display, key = `d:${cm?.key || ''}:${viewState.grayscale}:${viewState.colorBlind}:${d.brightness}:${d.contrast}:${d.gamma}`;
  const c = cacheFor(f, key);
  if (!c.display) {
    const { data } = frameData(f);
    if (cm) cm.fn(data);
    c.display = canvasFrom(adjust ? applyDisplay(data, { grayscale: viewState.grayscale, colorBlind: viewState.colorBlind, lut: d.brightness || d.contrast || d.gamma !== 1 ? displayLut(d.brightness, d.contrast, d.gamma) : null }) : data, f.width, f.height);
  }
  return c.display;
}

/** Draws the active overlays on top of the picture rectangle `r` (viewer CSS pixels). */
export function drawOverlays(ctx: CanvasRenderingContext2D, v: Viewer, r: { x: number; y: number; w: number; h: number }, f: Frame, info: { name: string; index: number; total: number; exif?: { dateTaken?: string; make?: string; model?: string; exposure?: string } | null; size: number; page: number; pages: number; dpi?: [number, number]; template: string; pointer: { x: number; y: number } | null }): void {
  const s = viewState;
  if (s.clipping || s.peaking) {
    const key = `m:${s.clipping}:${s.peaking}`; const c = cacheFor(f, key);
    if (s.clipping && !c.clip) { const { data } = frameData(f); c.clip = canvasFrom(clippingMask(data), f.width, f.height); }
    if (s.peaking && !c.peak) { const { data } = frameData(f); c.peak = canvasFrom(peakingMask(data, f.width, f.height), f.width, f.height); }
    ctx.save(); ctx.imageSmoothingEnabled = false;
    if (c.clip) ctx.drawImage(c.clip, r.x, r.y, r.w, r.h); if (c.peak) ctx.drawImage(c.peak, r.x, r.y, r.w, r.h);
    ctx.restore();
  }
  if (s.grid !== 'off') {
    ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1; ctx.setLineDash([]); ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 2;
    const lines: number[][] = [];
    if (s.grid === 'thirds') lines.push([1 / 3, 2 / 3]); else if (s.grid === 'golden') lines.push([0.382, 0.618]);
    ctx.beginPath();
    if (s.grid === 'square') { const step = Math.max(4, s.gridSize * v.zoom); for (let x = r.x + step; x < r.x + r.w; x += step) { const xx = Math.round(x) + 0.5; ctx.moveTo(xx, r.y); ctx.lineTo(xx, r.y + r.h); } for (let y = r.y + step; y < r.y + r.h; y += step) { const yy = Math.round(y) + 0.5; ctx.moveTo(r.x, yy); ctx.lineTo(r.x + r.w, yy); } }
    else for (const t of lines[0]) { const x = Math.round(r.x + r.w * t) + 0.5, y = Math.round(r.y + r.h * t) + 0.5; ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h); ctx.moveTo(r.x, y); ctx.lineTo(r.x + r.w, y); }
    ctx.stroke(); ctx.restore();
  }
  if (s.rulers) {
    const unit = info.dpi ? 'in' : 'px', dpi = info.dpi?.[0] || 96, per = unit === 'in' ? dpi * v.zoom : v.zoom; // CSS px per unit
    let step = 1; while (step * per < 40) step *= step % 3 === 0 ? 2 : step.toString().startsWith('1') ? 5 : step.toString().startsWith('5') ? 2 : 2;
    ctx.save(); ctx.fillStyle = 'rgba(30,30,30,0.85)'; const vw = ctx.canvas.clientWidth || ctx.canvas.width, vh = ctx.canvas.clientHeight || ctx.canvas.height;
    ctx.fillRect(0, 0, vw, 18); ctx.fillRect(0, 0, 18, vh); ctx.fillStyle = '#eee'; ctx.strokeStyle = '#eee'; ctx.font = '10px sans-serif'; ctx.textBaseline = 'top';
    ctx.beginPath();
    for (let u = 0; ; u += step) { const x = r.x + u * per; if (x > vw) break; if (x < 18) continue; ctx.moveTo(x, 18); ctx.lineTo(x, 10); ctx.fillText(String(u), x + 2, 2); }
    for (let u = 0; ; u += step) { const y = r.y + u * per; if (y > vh) break; if (y < 18) continue; ctx.moveTo(18, y); ctx.lineTo(10, y); ctx.save(); ctx.translate(2, y + 2); ctx.rotate(Math.PI / 2); ctx.fillText(String(u), 0, -10); ctx.restore(); }
    ctx.stroke(); ctx.fillText(unit, 3, 3); ctx.restore();
  }
  if (s.histogram) {
    const c = cacheFor(f, 'h'); if (!c.hist) { const { data } = frameData(f); c.hist = histogram(data); }
    const hst = c.hist, W = 160, H = 70, x0 = r.x + r.w - W - 10 < 10 ? 10 : Math.min(ctx.canvas.clientWidth - W - 10, r.x + r.w - W - 10), y0 = Math.max(10, Math.min(ctx.canvas.clientHeight - H - 10, r.y + 10));
    ctx.save(); ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x0, y0, W, H);
    const draw = (hh: Uint32Array, color: string) => { let mx = 1; for (let i = 1; i < 255; i++) mx = Math.max(mx, hh[i]); ctx.fillStyle = color; for (let i = 0; i < 256; i++) { const b = (Math.min(hh[i], mx) / mx) * (H - 6); ctx.fillRect(x0 + 2 + (i * (W - 4)) / 256, y0 + H - 2 - b, (W - 4) / 256 + 0.5, b); } };
    ctx.globalCompositeOperation = 'lighter'; draw(hst.r, 'rgba(255,60,60,0.7)'); draw(hst.g, 'rgba(60,255,60,0.7)'); draw(hst.b, 'rgba(80,80,255,0.7)'); ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#fff'; ctx.font = '10px sans-serif'; ctx.textBaseline = 'top'; ctx.fillText(`${hst.clippedHi ? `▲ ${((100 * hst.clippedHi) / (f.width * f.height)).toFixed(1)}% ` : ''}${hst.clippedLo ? `▼ ${((100 * hst.clippedLo) / (f.width * f.height)).toFixed(1)}%` : ''}`, x0 + 4, y0 + 2);
    ctx.restore();
  }
  if (s.osd) {
    const text = expandOsd(info.template, { name: info.name, w: f.width, h: f.height, zoom: Math.round(v.zoom * 100), n: info.index + 1, total: info.total, exifdate: info.exif?.dateTaken || '', camera: [info.exif?.make, info.exif?.model].filter(Boolean).join(' '), exposure: info.exif?.exposure || '', size: info.size < 1048576 ? `${(info.size / 1024).toFixed(1)} KB` : `${(info.size / 1048576).toFixed(2)} MB`, page: info.page + 1, pages: info.pages });
    ctx.save(); ctx.font = '13px sans-serif'; ctx.textBaseline = 'top'; const lines = text.split('\n'); const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16;
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(10 + (s.rulers ? 18 : 0), 10 + (s.rulers ? 18 : 0), w, lines.length * 17 + 10); ctx.fillStyle = '#fff';
    lines.forEach((l, i) => ctx.fillText(l, 18 + (s.rulers ? 18 : 0), 15 + (s.rulers ? 18 : 0) + i * 17)); ctx.restore();
  }
  const vw = ctx.canvas.clientWidth || ctx.canvas.width, vh = ctx.canvas.clientHeight || ctx.canvas.height;
  if (navigatorShown(vw, vh, r)) {
    const pw = f.width, ph = f.height, n = navigatorRect(vw, vh, pw, ph);
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(n.x - 3, n.y - 3, n.w + 6, n.h + 6);
    ctx.imageSmoothingEnabled = true; (ctx as any).imageSmoothingQuality = 'medium';
    try { ctx.drawImage(displayFrame(f, v.picture?.current), 0, 0, pw, ph, n.x, n.y, n.w, n.h); } catch { /* closed bitmap */ }
    const z = v.zoom, vx = (0 - r.x) / z, vy = (0 - r.y) / z, vwP = vw / z, vhP = vh / z;
    const bx = n.x + Math.max(0, vx) * n.k, by = n.y + Math.max(0, vy) * n.k, bw = Math.min(pw, vx + vwP) * n.k - Math.max(0, vx) * n.k, bh = Math.min(ph, vy + vhP) * n.k - Math.max(0, vy) * n.k;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.rect(n.x, n.y, n.w, n.h); ctx.rect(bx, by, bw, bh); ctx.fill('evenodd');
    ctx.strokeStyle = '#ffd400'; ctx.lineWidth = 2; ctx.strokeRect(bx + 1, by + 1, Math.max(2, bw - 2), Math.max(2, bh - 2));
    ctx.restore();
  }
  if (s.ocr.show && s.ocr.words.length) {
    ctx.save(); ctx.lineWidth = 1;
    for (const w of s.ocr.words) {
      const x = r.x + w.bbox.x0 * v.zoom, y = r.y + w.bbox.y0 * v.zoom, ww = (w.bbox.x1 - w.bbox.x0) * v.zoom, hh = (w.bbox.y1 - w.bbox.y0) * v.zoom;
      if (ocrMatch(w.text, s.ocr.query)) { ctx.fillStyle = 'rgba(255,220,0,0.45)'; ctx.fillRect(x, y, ww, hh); ctx.strokeStyle = '#ffb000'; ctx.lineWidth = 2; ctx.strokeRect(x, y, ww, hh); ctx.lineWidth = 1; continue; }
      ctx.strokeStyle = w.conf < 60 ? 'rgba(255,120,0,0.9)' : 'rgba(0,160,255,0.75)'; ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(ww), Math.round(hh));
    }
    ctx.restore();
  }
  if (s.codes.length) {
    ctx.save(); ctx.lineJoin = 'round'; ctx.font = '12px sans-serif'; ctx.textBaseline = 'bottom';
    for (const c of s.codes) {
      const pv = c.corners.map(([x, y]) => [r.x + x * v.zoom, r.y + y * v.zoom]);
      ctx.beginPath(); pv.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.closePath();
      ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 5; ctx.stroke(); ctx.strokeStyle = '#33e07a'; ctx.lineWidth = 3; ctx.stroke();
      const label = `${c.format}: ${c.text.length > 40 ? c.text.slice(0, 39) + '…' : c.text}`, tw = ctx.measureText(label).width + 10;
      const lx = Math.min(...pv.map((q) => q[0])), ly = Math.min(...pv.map((q) => q[1]));
      ctx.fillStyle = 'rgba(0,0,0,0.75)'; ctx.fillRect(lx, Math.max(0, ly - 20), tw, 18); ctx.fillStyle = '#fff'; ctx.fillText(label, lx + 5, Math.max(18, ly - 4));
    }
    ctx.restore();
  }
  if (s.measure.on && s.measure.pts.length) {
    const m = s.measure, toV = (q: [number, number]): [number, number] => [r.x + q[0] * v.zoom, r.y + q[1] * v.zoom];
    const pv = m.pts.map(toV);
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const path = () => { ctx.beginPath(); pv.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); if (m.closed) ctx.closePath(); };
    if (m.closed && pv.length > 2) { path(); ctx.fillStyle = 'rgba(255,212,0,0.18)'; ctx.fill(); }
    path(); ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineWidth = 4; ctx.stroke(); ctx.strokeStyle = '#ffd400'; ctx.lineWidth = 2; ctx.stroke();
    for (const q of pv) { ctx.beginPath(); ctx.arc(q[0], q[1], 4, 0, Math.PI * 2); ctx.fillStyle = '#ffd400'; ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke(); }
    const lines = readout(m.pts, m.closed, m.scale, v.picture?.current.world);
    if (lines.length) {
      ctx.font = '13px sans-serif'; ctx.textBaseline = 'top';
      const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14, hh = lines.length * 17 + 8;
      const last = pv[pv.length - 1]; let x = last[0] + 12, y = last[1] + 12;
      if (x + w > vw - 4) x = last[0] - w - 12; if (y + hh > vh - 4) y = last[1] - hh - 12;
      x = Math.max(4, x); y = Math.max(4, y);
      ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(x, y, w, hh); ctx.fillStyle = '#fff';
      lines.forEach((l, i) => ctx.fillText(l, x + 7, y + 5 + i * 17));
    }
    ctx.restore();
  }
  if (s.loupe && info.pointer) {
    const R = 70, z = s.loupeZoom, p = v.toPicture(info.pointer.x, info.pointer.y);
    if (p.x >= 0 && p.y >= 0 && p.x < f.width && p.y < f.height) {
      const src = (R * 2) / (v.zoom * z); // source size in picture pixels
      ctx.save(); ctx.beginPath(); ctx.arc(info.pointer.x, info.pointer.y, R, 0, Math.PI * 2); ctx.closePath(); ctx.clip(); ctx.imageSmoothingEnabled = z * v.zoom < 1;
      ctx.drawImage(displayFrame(f, v.picture?.current), p.x - src / 2, p.y - src / 2, src, src, info.pointer.x - R, info.pointer.y - R, R * 2, R * 2);
      ctx.restore(); ctx.save(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.shadowColor = '#000'; ctx.shadowBlur = 4; ctx.beginPath(); ctx.arc(info.pointer.x, info.pointer.y, R, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = '11px sans-serif'; ctx.fillText(`${z}×`, info.pointer.x + R - 24, info.pointer.y + R - 14); ctx.restore();
    }
  }
}
