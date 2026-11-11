/**
 * Apple QuickDraw pictures (PICT, .pct, .pict; version 1 and 2, with or without the 512-byte file header), read
 * by the app's own interpreter from Inside Macintosh's description. Everything is drawn into a picture of the
 * frame's size, enlarged when a bitmap in it has a higher resolution (a 300 dpi scan keeps its pixels):
 * - bitmaps and pixel maps: BitsRect, BitsRgn, PackBitsRect, PackBitsRgn (1, 2, 4 and 8 bits with a color
 *   table), DirectBitsRect and DirectBitsRgn (16 and 32 bits, every packing type), scaled from their source to
 *   their destination rectangle, through the clip and mask regions, in the copy, or, xor, bic and transparent
 *   modes;
 * - QuickTime-compressed pictures (JPEG): handed back for the platform's JPEG decoder to draw;
 * - shapes: rectangles, rounded rectangles, ovals, arcs, polygons and regions, framed with the pen size or
 *   painted, filled, erased and inverted, with 8 × 8 patterns, RGB and old-style colors, and lines;
 * - text: handed back with its position, size, style and font for the caller to draw (fonts are the platform's).
 * Pictures that are only PostScript (in comments) show what their QuickDraw part draws.
 */
import { makeRaster, type DecodeResult, type Raster } from './raster';

const be16 = (u: Uint8Array, o: number) => (u[o] << 8) | u[o + 1];
const s16 = (u: Uint8Array, o: number) => (be16(u, o) << 16) >> 16;
const be32 = (u: Uint8Array, o: number) => ((u[o] << 24) | (u[o + 1] << 16) | (u[o + 2] << 8) | u[o + 3]) >>> 0;
type RGB = [number, number, number];
interface Rect { t: number; l: number; b: number; r: number }
const rectAt = (u: Uint8Array, o: number): Rect => ({ t: s16(u, o), l: s16(u, o + 2), b: s16(u, o + 4), r: s16(u, o + 6) });

export interface PictText { x: number; y: number; text: string; size: number; face: number; font: string; color: RGB }
export interface PictJpeg { bytes: Uint8Array; x: number; y: number; w: number; h: number }
export interface PictResult extends DecodeResult { texts: PictText[]; jpegs: PictJpeg[] }

/** Where the picture starts (after the optional 512-byte header) and its version, or null. */
function pictStart(u8: Uint8Array): { at: number; version: 1 | 2 } | null {
  for (const at of [512, 0]) {
    if (u8.length < at + 14) continue;
    const f = rectAt(u8, at + 2);
    if (!(f.b > f.t && f.r > f.l)) continue;
    if (u8[at + 10] === 0x11 && u8[at + 11] === 0x01) return { at, version: 1 };
    if (be16(u8, at + 10) === 0x0011 && be16(u8, at + 12) === 0x02ff) return { at, version: 2 };
  }
  return null;
}
export function isPict(u8: Uint8Array, name: string): boolean {
  const s = pictStart(u8);
  if (!s) return false;
  if (/\.(pct|pict|pic)$/i.test(name)) return true;
  // Without the extension: a version 2 picture behind the usual 512 zero bytes.
  return s.version === 2 && s.at === 512 && u8.subarray(0, 512).every((b) => b === 0);
}

// Regions ----------------------------------------------------------------------------------------------
interface Region { box: Rect; rows: number[][] | null } // rows[y - box.t] = [x0, x1, x2, x3 …] spans
function readRegion(u8: Uint8Array, p: number): { rgn: Region; size: number } {
  const size = be16(u8, p), box = rectAt(u8, p + 2);
  if (size <= 10) return { rgn: { box, rows: null }, size };
  const recs: { y: number; xs: number[] }[] = [];
  let q = p + 10; const end = p + size;
  while (q + 2 <= end) {
    const y = s16(u8, q); q += 2; if (y === 0x7fff) break;
    const xs: number[] = [];
    while (q + 2 <= end) { const x = s16(u8, q); q += 2; if (x === 0x7fff) break; xs.push(x); }
    recs.push({ y, xs });
  }
  const h = Math.max(0, box.b - box.t), rows: number[][] = Array.from({ length: h }, () => []);
  let cur: number[] = [];
  for (let i = 0; i < recs.length; i++) {
    const s = new Set(cur); for (const x of recs[i].xs) { if (s.has(x)) s.delete(x); else s.add(x); }
    cur = [...s].sort((a, b) => a - b);
    const y1 = i + 1 < recs.length ? recs[i + 1].y : box.b;
    for (let y = Math.max(recs[i].y, box.t); y < Math.min(y1, box.b); y++) rows[y - box.t] = cur;
  }
  return { rgn: { box, rows }, size };
}
function inRegion(g: Region, X: number, Y: number): boolean {
  if (X < g.box.l || X >= g.box.r || Y < g.box.t || Y >= g.box.b) return false;
  if (!g.rows) return true;
  const row = g.rows[Math.floor(Y) - g.box.t];
  if (!row) return false;
  for (let i = 0; i + 1 < row.length; i += 2) if (X >= row[i] && X < row[i + 1]) return true;
  return false;
}

// Shapes as tests on a point -------------------------------------------------------------------------
type Test = (X: number, Y: number) => boolean;
const inRect = (k: Rect): Test => (X, Y) => X >= k.l && X < k.r && Y >= k.t && Y < k.b;
function inOval(k: Rect): Test {
  const cx = (k.l + k.r) / 2, cy = (k.t + k.b) / 2, rx = (k.r - k.l) / 2, ry = (k.b - k.t) / 2;
  return (X, Y) => rx > 0 && ry > 0 && ((X - cx) / rx) ** 2 + ((Y - cy) / ry) ** 2 <= 1;
}
function inRRect(k: Rect, ow: number, oh: number): Test {
  const rx = Math.min(ow / 2, (k.r - k.l) / 2), ry = Math.min(oh / 2, (k.b - k.t) / 2);
  return (X, Y) => {
    if (!(X >= k.l && X < k.r && Y >= k.t && Y < k.b)) return false;
    if (rx <= 0 || ry <= 0) return true;
    const cx = X < k.l + rx ? k.l + rx : X > k.r - rx ? k.r - rx : X, cy = Y < k.t + ry ? k.t + ry : Y > k.b - ry ? k.b - ry : Y;
    return ((X - cx) / rx) ** 2 + ((Y - cy) / ry) ** 2 <= 1;
  };
}
/** QuickDraw angles: 0 at 12 o'clock, clockwise, in degrees. */
function inAngle(k: Rect, start: number, arc: number): Test {
  const cx = (k.l + k.r) / 2, cy = (k.t + k.b) / 2, w = k.r - k.l, h = k.b - k.t;
  let a0 = arc < 0 ? start + arc : start; const span = Math.min(360, Math.abs(arc)); a0 = ((a0 % 360) + 360) % 360;
  return (X, Y) => {
    // The angle is measured on the rectangle as if it were a square (QuickDraw's convention).
    let a = Math.atan2((X - cx) / (w || 1), -(Y - cy) / (h || 1)) * 180 / Math.PI; a = (a + 360) % 360;
    return ((a - a0 + 360) % 360) <= span;
  };
}
function inPoly(pts: [number, number][]): Test {
  return (X, Y) => {
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > Y) !== (yj > Y) && X < ((xj - xi) * (Y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
}
const inset = (k: Rect, dx: number, dy: number): Rect => ({ t: k.t + dy, l: k.l + dx, b: k.b - dy, r: k.r - dx });

// Colors ---------------------------------------------------------------------------------------------
const OLD_COLORS: Record<number, RGB> = { 33: [0, 0, 0], 30: [255, 255, 255], 205: [221, 8, 6], 341: [0, 128, 17], 409: [0, 0, 212], 273: [2, 171, 234], 137: [242, 8, 132], 69: [252, 243, 5] };
const c16 = (u: Uint8Array, o: number) => Math.floor(be16(u, o) / 257); // as ImageMagick; the same as the high byte for byte × 257 colors
const rgbAt = (u: Uint8Array, o: number): RGB => [c16(u, o), c16(u, o + 2), c16(u, o + 4)];

/** Data length of an opcode that is skipped or read generically (Inside Macintosh, Imaging With QuickDraw, A-22). */
function opLength(op: number, u8: Uint8Array, p: number, v2: boolean): number {
  if (op >= 0x8100) return 4 + be32(u8, p);
  if (op >= 0x8000) return 0;
  if (op >= 0x0100) return (op >> 8) * 2;
  if (op >= 0xd0 && op <= 0xfe) return 4 + be32(u8, p);
  if (op >= 0xb0 && op <= 0xcf) return 0;
  if ((op >= 0xa2 && op <= 0xaf) || (op >= 0x92 && op <= 0x97) || (op >= 0x9c && op <= 0x9f) || (op >= 0x24 && op <= 0x27) || (op >= 0x2c && op <= 0x2f)) return 2 + be16(u8, p);
  const fixed: Record<number, number> = { 0x00: 0, 0x02: 8, 0x03: 2, 0x04: 1, 0x05: 2, 0x06: 4, 0x07: 4, 0x08: 2, 0x09: 8, 0x0a: 8, 0x0b: 4, 0x0c: 4, 0x0d: 2, 0x0e: 4, 0x0f: 4, 0x10: 8, 0x11: v2 ? 2 : 1, 0x15: 2, 0x16: 2, 0x17: 0, 0x18: 0, 0x19: 0, 0x1a: 6, 0x1b: 6, 0x1c: 0, 0x1d: 6, 0x1e: 0, 0x1f: 6, 0x20: 8, 0x21: 4, 0x22: 6, 0x23: 2, 0xa0: 2, 0xff: 0 };
  if (op in fixed) return fixed[op];
  if (op >= 0x30 && op <= 0x37) return 8;
  if (op >= 0x38 && op <= 0x3f) return 0;
  if (op >= 0x40 && op <= 0x47) return 8;
  if (op >= 0x48 && op <= 0x4f) return 0;
  if (op >= 0x50 && op <= 0x57) return 8;
  if (op >= 0x58 && op <= 0x5f) return 0;
  if (op >= 0x60 && op <= 0x67) return 12;
  if (op >= 0x68 && op <= 0x6f) return 4;
  if (op >= 0x78 && op <= 0x7f) return 0;
  if (op >= 0x88 && op <= 0x8f) return 0;
  if ((op >= 0x70 && op <= 0x77) || (op >= 0x80 && op <= 0x87) || op === 0x01) return be16(u8, p);
  if (op === 0xa1) return 4 + be16(u8, p + 2);
  return -1; // variable: read by its own code
}

/** PackBits into `out` (unit 1 or 2 bytes). */
function unpack(src: Uint8Array, p: number, end: number, out: Uint8Array, unit: number): void {
  let o = 0;
  while (p < end && o < out.length) {
    const c = (src[p++] << 24) >> 24;
    if (c >= 0) { const n = (c + 1) * unit; out.set(src.subarray(p, Math.min(p + n, end)).subarray(0, out.length - o), o); o += n; p += n; }
    else if (c !== -128) { const n = 1 - c; for (let i = 0; i < n && o < out.length; i++) for (let k = 0; k < unit; k++) out[o++] = src[p + k]; p += unit; }
  }
}

interface Pixels { w: number; h: number; get(x: number, y: number): [number, number, number, number] | null; bits: number }

export function decodePict(u8: Uint8Array, o: { maxSide: number } = { maxSide: 12000 }): PictResult {
  const s = pictStart(u8);
  if (!s) throw new Error('This is not a QuickDraw picture');
  const v2 = s.version === 2, frame = rectAt(u8, s.at + 2), warnings: string[] = [];
  const texts: PictText[] = [], jpegs: PictJpeg[] = [];
  // State.
  let fg: RGB = [0, 0, 0], bg: RGB = [255, 255, 255], penW = 1, penH = 1, penMode = 8, ovW = 0, ovH = 0;
  let pnPat = new Uint8Array(8).fill(0xff), fillPat = new Uint8Array(8).fill(0xff), bkPat = new Uint8Array(8);
  let penX = 0, penY = 0, txX = 0, txY = 0, txSize = 12, txFace = 0, txFont = 0, ox = 0, oy = 0;
  const fontNames = new Map<number, string>();
  let clip: Region | null = null, last: { rect?: Rect; poly?: [number, number][]; rgn?: Region } = {};
  let hRes = 72;
  // Pass 1 records the drawing; pass 2 draws it at the scale that keeps the finest bitmap's pixels.
  type Cmd = { kind: 'fill'; test: Test; box: Rect; pat: Uint8Array; mode: number; fg: RGB; bg: RGB; clip: Region | null }
    | { kind: 'invert'; test: Test; box: Rect; clip: Region | null }
    | { kind: 'pixels'; px: Pixels; src: Rect; dst: Rect; mode: number; mask: Region | null; clip: Region | null; fg: RGB; bg: RGB };
  const cmds: Cmd[] = [];
  let scale = 1;
  const shape = (verb: number, test: Test, box: Rect) => {
    const c = clip;
    if (verb === 3) cmds.push({ kind: 'invert', test, box, clip: c });
    else if (verb === 0) cmds.push({ kind: 'fill', test, box, pat: pnPat, mode: penMode, fg, bg, clip: c });
    else cmds.push({ kind: 'fill', test, box, pat: verb === 1 ? pnPat : verb === 2 ? bkPat : fillPat, mode: verb === 1 ? penMode : 8, fg: verb === 2 ? bg : fg, bg, clip: c });
  };
  const at = (k: Rect): Rect => ({ t: k.t - oy, l: k.l - ox, b: k.b - oy, r: k.r - ox });
  const line = (x0: number, y0: number, x1: number, y1: number) => {
    // QuickDraw lines: the pen rectangle hangs below and to the right of each point on the line.
    const pts: [number, number][] = [];
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy, x = x0, y = y0;
    for (let i = 0; i < 100000; i++) { pts.push([x, y]); if (x === x1 && y === y1) break; const e2 = 2 * err; if (e2 >= dy) { err += dy; x += sx; } if (e2 <= dx) { err += dx; y += sy; } }
    const pw = penW, ph = penH, box: Rect = { t: Math.min(y0, y1), l: Math.min(x0, x1), b: Math.max(y0, y1) + ph, r: Math.max(x0, x1) + pw };
    if (!pw || !ph) return;
    // The cells the pen covers: on each row they are one run (the line moves at most a cell at a time, the pen is a
    // rectangle), so two numbers per row hold them; a grid over the line's box took its whole area for every line.
    const gh = box.b - box.t, lo = new Int32Array(gh).fill(0x7fffffff), hi = new Int32Array(gh).fill(-0x80000000);
    for (const [px, py] of pts) for (let b = 0; b < ph; b++) { const row = py - box.t + b; if (row < 0 || row >= gh) continue; if (px - box.l < lo[row]) lo[row] = px - box.l; if (px - box.l + pw > hi[row]) hi[row] = px - box.l + pw; }
    const test: Test = (X, Y) => {
      const gx = Math.floor(X) - box.l, gy = Math.floor(Y) - box.t;
      return gy >= 0 && gy < gh && gx >= lo[gy] && gx < hi[gy];
    };
    cmds.push({ kind: 'fill', test, box, pat: pnPat, mode: penMode, fg, bg, clip });
  };
  const framed = (outer: Test, inner: Test): Test => (X, Y) => outer(X, Y) && !inner(X, Y);

  // Bitmaps and pixel maps.
  const readPixels = (op: number, p: number): number => {
    const direct = op === 0x9a || op === 0x9b, rgnOp = op === 0x91 || op === 0x99 || op === 0x9b, packed = op !== 0x90 && op !== 0x91;
    if (direct) p += 4; // baseAddr
    const rbWord = be16(u8, p), isPixMap = direct || !!(rbWord & 0x8000), rowBytes = rbWord & 0x3fff;
    const bounds = rectAt(u8, p + 2); p += 10;
    let pixelSize = 1, packType = 0, cmpCount = 1, table: RGB[] = [];
    if (isPixMap) {
      packType = be16(u8, p + 2); pixelSize = be16(u8, p + 18); cmpCount = be16(u8, p + 20);
      if (direct && packType === 0) packType = pixelSize === 32 ? 4 : 3; // the default packing for the depth
      const res = be32(u8, p + 8) / 65536; if (res > 0) hRes = Math.max(hRes, res);
      p += 36;
      if (!direct) {
        const flags = be16(u8, p + 4), n = be16(u8, p + 6) + 1; p += 8;
        table = new Array(Math.max(n, 1 << Math.min(pixelSize, 8))).fill(null).map((_, i) => [i, i, i] as RGB);
        for (let i = 0; i < n; i++) { const v = be16(u8, p) & 0xff; table[flags & 0x8000 ? i : v] = rgbAt(u8, p + 2); p += 8; }
      }
    }
    const src = rectAt(u8, p), dst = rectAt(u8, p + 8), mode = be16(u8, p + 16); p += 18;
    let mask: Region | null = null;
    if (rgnOp) { const r = readRegion(u8, p); mask = r.rgn; p += r.size; }
    const w = bounds.r - bounds.l, h = bounds.b - bounds.t;
    if (!(w > 0 && h > 0) || w * h > 200e6) throw new Error(`A bitmap in this picture has an impossible size (${w} × ${h})`);
    // Rows: plain when rowBytes < 8 (or not packed), else a byte count (a word past 250) and PackBits.
    const bytesPerRow = direct && packType === 2 ? w * 3 : direct && packType === 4 ? w * cmpCount : rowBytes;
    const rows = new Uint8Array(bytesPerRow * h);
    const unit = direct && pixelSize === 16 && packType !== 1 ? 2 : 1;
    for (let y = 0; y < h; y++) {
      const out = rows.subarray(y * bytesPerRow, (y + 1) * bytesPerRow);
      if (rowBytes < 8 || !packed || packType === 1 || (direct && packType === 2)) { out.set(u8.subarray(p, p + bytesPerRow)); p += direct && packType === 2 ? w * 3 : rowBytes; continue; }
      const n = rowBytes > 250 ? be16(u8, p) : u8[p]; p += rowBytes > 250 ? 2 : 1;
      unpack(u8, p, Math.min(p + n, u8.length), out, unit); p += n;
    }
    if (p > u8.length) warnings.push('A bitmap in this picture is cut short');
    const get: Pixels['get'] = (x, y) => {
      const r = y * bytesPerRow;
      if (!isPixMap) { const bit = (rows[r + (x >> 3)] >> (7 - (x & 7))) & 1; return bit ? [-1, 0, 0, 1] : [-2, 0, 0, 0]; } // fg / bg
      if (!direct) {
        const per = 8 / pixelSize, byte = rows[r + Math.floor(x / per)], sh = 8 - pixelSize * ((x % per) + 1);
        const c = table[(byte >> sh) & ((1 << pixelSize) - 1)] || [0, 0, 0]; return [c[0], c[1], c[2], 255];
      }
      if (pixelSize === 16) { const v = (rows[r + x * 2] << 8) | rows[r + x * 2 + 1]; const c5 = (k: number) => (k << 3) | (k >> 2); return [c5((v >> 10) & 31), c5((v >> 5) & 31), c5(v & 31), 255]; }
      if (packType === 4) { const off = cmpCount === 4 ? 1 : 0; return [rows[r + (off) * w + x], rows[r + (off + 1) * w + x], rows[r + (off + 2) * w + x], 255]; }
      if (packType === 2) return [rows[r + x * 3], rows[r + x * 3 + 1], rows[r + x * 3 + 2], 255];
      return [rows[r + x * 4 + 1], rows[r + x * 4 + 2], rows[r + x * 4 + 3], 255];
    };
    const px: Pixels = { w, h, bits: isPixMap ? pixelSize : 1, get };
    const sx = (src.r - src.l) / Math.max(1, dst.r - dst.l), sy = (src.b - src.t) / Math.max(1, dst.b - dst.t);
    scale = Math.max(scale, Math.min(sx, sy));
    // Source coordinates are in the bitmap's bounds.
    const srcIn: Rect = { t: src.t - bounds.t, l: src.l - bounds.l, b: src.b - bounds.t, r: src.r - bounds.l };
    cmds.push({ kind: 'pixels', px, src: srcIn, dst: at(dst), mode, mask: mask ? { box: at(mask.box), rows: mask.rows } : null, clip, fg, bg });
    bitsSeen = Math.max(bitsSeen, px.bits);
    return p;
  };
  let bitsSeen = 0, pixmaps = 0, shapes = 0, endSeen = false;

  let p = s.at + 10;
  ops: while (p < u8.length) {
    let op: number;
    if (v2) { p = (p + 1) & ~1; if (p + 2 > u8.length) break; op = be16(u8, p); p += 2; } else op = u8[p++];
    const start = p;
    try {
      switch (true) {
        case op === 0xff: endSeen = true; break ops;
        case op === 0x01: { const r = readRegion(u8, p); clip = r.rgn.rows || r.rgn.box.l > frame.l || r.rgn.box.t > frame.t || r.rgn.box.r < frame.r || r.rgn.box.b < frame.b ? { box: at(r.rgn.box), rows: r.rgn.rows } : null; p += r.size; continue; }
        case op === 0x02: bkPat = u8.slice(p, p + 8); break;
        case op === 0x03: txFont = be16(u8, p); break;
        case op === 0x04: txFace = u8[p]; break;
        case op === 0x07: penH = s16(u8, p); penW = s16(u8, p + 2); break;
        case op === 0x08: penMode = be16(u8, p); break;
        case op === 0x09: pnPat = u8.slice(p, p + 8); break;
        case op === 0x0a: fillPat = u8.slice(p, p + 8); break;
        case op === 0x0b: ovH = s16(u8, p); ovW = s16(u8, p + 2); break;
        case op === 0x0c: ox += s16(u8, p + 2); oy += s16(u8, p); break;
        case op === 0x0d: txSize = be16(u8, p) || 12; break;
        case op === 0x0e: fg = OLD_COLORS[be32(u8, p)] || fg; break;
        case op === 0x0f: bg = OLD_COLORS[be32(u8, p)] || bg; break;
        case op >= 0x12 && op <= 0x14: { // pixel patterns: a type-2 (RGB) pattern is that color; type 1 falls back to its 1-bit pattern
          const type = be16(u8, p), pat1 = u8.slice(p + 2, p + 10); let q = p + 10;
          if (type === 2) { const c = rgbAt(u8, q); q += 6; if (op === 0x12) bg = c; else fg = c; if (op === 0x12) bkPat = new Uint8Array(8); else if (op === 0x13) pnPat = new Uint8Array(8).fill(0xff); else fillPat = new Uint8Array(8).fill(0xff); }
          else {
            const rb = be16(u8, q) & 0x3fff, bounds = rectAt(u8, q + 2); const pixelSize = be16(u8, q + 2 + 8 + 18); q += 2 + 8 + 36;
            const n = be16(u8, q + 6) + 1; q += 8 + n * 8;
            const h = bounds.b - bounds.t; void pixelSize;
            for (let y = 0; y < h; y++) { if (rb < 8) q += rb; else { const c = rb > 250 ? be16(u8, q) : u8[q]; q += (rb > 250 ? 2 : 1) + c; } }
            if (op === 0x12) bkPat = pat1; else if (op === 0x13) pnPat = pat1; else fillPat = pat1;
          }
          p = q; continue;
        }
        case op === 0x1a: fg = rgbAt(u8, p); break;
        case op === 0x1b: bg = rgbAt(u8, p); break;
        case op === 0x20: { const y0 = s16(u8, p), x0 = s16(u8, p + 2), y1 = s16(u8, p + 4), x1 = s16(u8, p + 6); line(x0 - ox, y0 - oy, x1 - ox, y1 - oy); penX = x1; penY = y1; shapes++; break; }
        case op === 0x21: { const y1 = s16(u8, p), x1 = s16(u8, p + 2); line(penX - ox, penY - oy, x1 - ox, y1 - oy); penX = x1; penY = y1; shapes++; break; }
        case op === 0x22: { const y0 = s16(u8, p), x0 = s16(u8, p + 2), dx = (u8[p + 4] << 24) >> 24, dy = (u8[p + 5] << 24) >> 24; line(x0 - ox, y0 - oy, x0 + dx - ox, y0 + dy - oy); penX = x0 + dx; penY = y0 + dy; shapes++; break; }
        case op === 0x23: { const dx = (u8[p] << 24) >> 24, dy = (u8[p + 1] << 24) >> 24; line(penX - ox, penY - oy, penX + dx - ox, penY + dy - oy); penX += dx; penY += dy; shapes++; break; }
        case op >= 0x28 && op <= 0x2b: {
          let q = p;
          if (op === 0x28) { txY = s16(u8, q); txX = s16(u8, q + 2); q += 4; }
          else if (op === 0x29) { txX += u8[q++]; }
          else if (op === 0x2a) { txY += u8[q++]; }
          else { txX += u8[q++]; txY += u8[q++]; }
          const n = u8[q++], str = new TextDecoder('macintosh').decode(u8.subarray(q, q + n)); q += n;
          texts.push({ x: txX - ox, y: txY - oy, text: str, size: txSize, face: txFace, font: fontNames.get(txFont) || fontFamily(txFont), color: fg });
          p = q; continue;
        }
        case op === 0x2c: { const n = be16(u8, p); fontNames.set(be16(u8, p + 2), new TextDecoder('macintosh').decode(u8.subarray(p + 5, p + 5 + u8[p + 4]))); p += 2 + n; continue; }
        case op >= 0x30 && op <= 0x3f: { const k = op < 0x38 ? (last.rect = at(rectAt(u8, p))) : last.rect; if (k) { const v = op & 7; shape(v, v === 0 ? framed(inRect(k), inRect(inset(k, penW, penH))) : inRect(k), k); shapes++; } break; }
        case op >= 0x40 && op <= 0x4f: { const k = op < 0x48 ? (last.rect = at(rectAt(u8, p))) : last.rect; if (k) { const v = op & 7; shape(v, v === 0 ? framed(inRRect(k, ovW, ovH), inRRect(inset(k, penW, penH), ovW - 2 * penW, ovH - 2 * penH)) : inRRect(k, ovW, ovH), k); shapes++; } break; }
        case op >= 0x50 && op <= 0x5f: { const k = op < 0x58 ? (last.rect = at(rectAt(u8, p))) : last.rect; if (k) { const v = op & 7; shape(v, v === 0 ? framed(inOval(k), inOval(inset(k, penW, penH))) : inOval(k), k); shapes++; } break; }
        case op >= 0x60 && op <= 0x6f: {
          let k = last.rect, q = p;
          if (op < 0x68) { k = last.rect = at(rectAt(u8, q)); q += 8; }
          const a = inAngle(k || frame, s16(u8, q), s16(u8, q + 2));
          if (k) { const v = op & 7, o1 = inOval(k), inner = inOval(inset(k, penW, penH)); shape(v, v === 0 ? (X, Y) => o1(X, Y) && !inner(X, Y) && a(X, Y) : (X, Y) => o1(X, Y) && a(X, Y), k); shapes++; }
          break;
        }
        case op >= 0x70 && op <= 0x7f: {
          let pts = last.poly;
          if (op < 0x78) { const n = (be16(u8, p) - 10) >> 2; pts = []; for (let i = 0; i < n; i++) pts.push([s16(u8, p + 12 + i * 4) - ox, s16(u8, p + 10 + i * 4) - oy]); last.poly = pts; }
          if (pts && pts.length) {
            const v = op & 7;
            if (v === 0) { for (let i = 1; i < pts.length; i++) line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]); }
            else { const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]); shape(v, inPoly(pts), { l: Math.min(...xs), t: Math.min(...ys), r: Math.max(...xs), b: Math.max(...ys) }); }
            shapes++;
          }
          if (op < 0x78) { p += be16(u8, p); continue; }
          break;
        }
        case op >= 0x80 && op <= 0x8f: {
          let g = last.rgn;
          if (op < 0x88) { const r = readRegion(u8, p); g = last.rgn = { box: at(r.rgn.box), rows: r.rgn.rows }; p += r.size; }
          if (g) {
            const v = op & 7, rg = g, inside: Test = (X, Y) => inRegion(rg, X, Y);
            shape(v, v === 0 ? (X, Y) => inside(X, Y) && !(inside(X - penW, Y) && inside(X + penW, Y) && inside(X, Y - penH) && inside(X, Y + penH)) : inside, g.box);
            shapes++;
          }
          if (op < 0x88) continue;
          break;
        }
        case op === 0x90 || op === 0x91 || op === 0x98 || op === 0x99 || op === 0x9a || op === 0x9b: p = readPixels(op, p); pixmaps++; continue;
        case op === 0x0c00: { if (s16(u8, p) === -2) { const hr = be32(u8, p + 4) / 65536; if (hr > 0) hRes = hr; } break; }
        case op === 0x8200: { // CompressedQuickTime: the image description, then the compressed data
          const len = be32(u8, p), q = p + 4, end = q + len;
          // version, matrix (3 × 3 Fixed), matte size and rectangle, mode, source rectangle, accuracy, mask size
          const matte = be32(u8, q + 38), maskSize = be32(u8, q + 64);
          let d = q + 68 + matte + maskSize;
          const dst = rectAt(u8, q + 52); // the source rectangle, mapped through the matrix
          const mx = (be32(u8, q + 2) | 0) / 65536, my = (be32(u8, q + 18) | 0) / 65536, tx = (be32(u8, q + 26) | 0) / 65536, ty = (be32(u8, q + 30) | 0) / 65536;
          const descSize = be32(u8, d), codec = String.fromCharCode(...u8.subarray(d + 4, d + 8));
          const iw = be16(u8, d + 32), ih = be16(u8, d + 34), dataSize = be32(u8, d + 44);
          d += descSize;
          if (codec === 'jpeg') {
            const w = (dst.r - dst.l) * (mx || 1), h = (dst.b - dst.t) * (my || 1);
            jpegs.push({ bytes: u8.slice(d, Math.min(d + (dataSize || end - d), end)), x: dst.l * (mx || 1) + tx - frame.l, y: dst.t * (my || 1) + ty - frame.t, w: w || iw, h: h || ih });
            scale = Math.max(scale, iw / Math.max(1, w || iw));
          } else warnings.push(`QuickTime-compressed data (${codec.trim() || 'unknown codec'}) is not drawn`);
          p = end; continue;
        }
        default: {
          const n = opLength(op, u8, p, v2);
          if (n < 0) { warnings.push(`Unknown QuickDraw opcode 0x${op.toString(16).padStart(4, '0')}; the rest of the picture is not drawn`); break ops; }
          p += n; continue;
        }
      }
      const n = opLength(op, u8, start, v2);
      p = start + Math.max(0, n);
    } catch (e: any) {
      warnings.push(`The picture could not be read past opcode 0x${op.toString(16)} (${e?.message || e})`); break;
    }
  }
  if (!endSeen) warnings.push('The picture has no end marker (cut short?)');

  // Pass 2: draw at the chosen scale.
  const fw = frame.r - frame.l, fh = frame.b - frame.t;
  scale = Math.max(1, Math.min(scale, hRes > 72 && !pixmaps ? hRes / 72 : scale, o.maxSide / Math.max(fw, fh)));
  if (scale !== 1) scale = Math.max(1, Math.round(scale * 1000) / 1000);
  const W = Math.max(1, Math.round(fw * scale)), H = Math.max(1, Math.round(fh * scale));
  if (W * H > 200e6) throw new Error(`This picture is too large to show (${W} × ${H})`);
  const r = makeRaster(W, H), d = r.data;
  d.fill(255);
  const toX = (px: number) => frame.l + (px + 0.5) / scale, toY = (py: number) => frame.t + (py + 0.5) / scale;
  const clipOk = (c: Region | null, X: number, Y: number) => !c || inRegion(c, X, Y);
  const set = (i: number, c: ArrayLike<number>) => { d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255; };
  for (const c of cmds) {
    const box = c.kind === 'pixels' ? c.dst : c.box;
    const x0 = Math.max(0, Math.floor((box.l - frame.l) * scale)), x1 = Math.min(W, Math.ceil((box.r - frame.l) * scale));
    const y0 = Math.max(0, Math.floor((box.t - frame.t) * scale)), y1 = Math.min(H, Math.ceil((box.b - frame.t) * scale));
    for (let py = y0; py < y1; py++) {
      const Y = toY(py);
      for (let px = x0; px < x1; px++) {
        const X = toX(px), i = (py * W + px) * 4;
        if (!clipOk(c.clip, X, Y)) continue;
        if (c.kind === 'invert') { if (c.test(X, Y)) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; } continue; }
        if (c.kind === 'fill') {
          if (!c.test(X, Y)) continue;
          const bit = (c.pat[Math.floor(Y - frame.t) & 7] >> (7 - (Math.floor(X - frame.l) & 7))) & 1;
          let m = c.mode >= 32 ? 8 : c.mode & 15; if (m < 8) m += 8; // patCopy 8, patOr 9, patXor 10, patBic 11, notPat… 12–15 (arithmetic modes: copy)
          const on = m >= 12 && m <= 15 ? !bit : !!bit, base = m >= 12 && m <= 15 ? m - 4 : m;
          if (base === 9) { if (on) set(i, c.fg); }
          else if (base === 10) { if (on) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; } }
          else if (base === 11) { if (on) set(i, c.bg); }
          else set(i, on ? c.fg : c.bg);
          continue;
        }
        // Pixels: nearest source pixel for this destination point.
        if (X < c.dst.l || X >= c.dst.r || Y < c.dst.t || Y >= c.dst.b) continue;
        if (c.mask && !inRegion(c.mask, X, Y)) continue;
        const sxp = Math.floor(c.src.l + (X - c.dst.l) * (c.src.r - c.src.l) / (c.dst.r - c.dst.l));
        const syp = Math.floor(c.src.t + (Y - c.dst.t) * (c.src.b - c.src.t) / (c.dst.b - c.dst.t));
        if (sxp < 0 || syp < 0 || sxp >= c.px.w || syp >= c.px.h) continue;
        const v = c.px.get(sxp, syp)!;
        const mode = c.mode & ~64 & 0xff;
        if (v[0] < 0) { // a 1-bit bitmap: set bits in the foreground color, clear ones in the background
          const on = v[0] === -1;
          if (mode === 1) { if (on) set(i, c.fg); }
          else if (mode === 2) { if (on) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; } }
          else if (mode === 3) { if (on) set(i, c.bg); }
          else if (mode === 36) { if (on) set(i, c.fg); }
          else set(i, on ? c.fg : c.bg);
          continue;
        }
        if (mode === 36 && v[0] === c.bg[0] && v[1] === c.bg[1] && v[2] === c.bg[2]) continue; // transparent
        set(i, v);
      }
    }
  }
  const notes = [`QuickDraw picture (PICT version ${s.version})`];
  if (pixmaps) notes.push(`${pixmaps} bitmap${pixmaps === 1 ? '' : 's'}, up to ${bitsSeen} bits per pixel`);
  if (shapes) notes.push(`${shapes} drawn shape${shapes === 1 ? '' : 's'}`);
  if (texts.length) notes.push(`${texts.length} text item${texts.length === 1 ? '' : 's'}`);
  if (jpegs.length) notes.push(`${jpegs.length} QuickTime JPEG picture${jpegs.length === 1 ? '' : 's'}`);
  if (scale !== 1) notes.push(`drawn at ${Math.round(72 * scale)} dpi to keep the bitmap's resolution`);
  const dpi: [number, number] = [Math.round(72 * scale), Math.round(72 * scale)];
  // Text and JPEG coordinates in the drawn picture's pixels.
  for (const t of texts) { t.x = (t.x - frame.l) * scale; t.y = (t.y - frame.t) * scale; t.size *= scale; }
  for (const j of jpegs) { j.x *= scale; j.y *= scale; j.w *= scale; j.h *= scale; }
  return { pages: [{ width: W, height: H, frames: [{ raster: r, delay: 0 }], loops: 0, bitDepth: bitsSeen || 24, hasAlpha: false, dpi, notes }], info: { frame: `${fw} × ${fh} points` }, warnings, texts, jpegs };
}

/** The classic Mac font numbers, as families the platform has. */
function fontFamily(id: number): string {
  return ({ 0: 'sans-serif', 1: 'sans-serif', 2: 'serif', 3: 'sans-serif', 4: 'monospace', 20: 'serif', 21: 'sans-serif', 22: 'monospace', 23: 'serif' } as Record<number, string>)[id] || 'sans-serif';
}
