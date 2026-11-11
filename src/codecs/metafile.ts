/**
 * Windows Metafile (WMF, with or without the placeable header) and Enhanced Metafile (EMF), drawn by a
 * GDI interpreter of the app's own onto a canvas, written from the [MS-WMF] and [MS-EMF] record
 * specifications: mapping modes, window and viewport origins and extents, EMF world transforms,
 * SaveDC/RestoreDC, pens (dashes, caps, joins), brushes (solid, hatched, pattern bitmaps), fonts
 * (escapement, weight, italics, underline, strike-out, character sets), lines, polygons, Béziers,
 * rectangles, ellipses, arcs, pies, chords, paths, text with spacing arrays, bitmaps (DIBs in every
 * depth, RLE, JPEG and PNG), raster operations approximated with blend modes, and clipping.
 * EMF+ records inside comments are skipped: dual files draw from their EMF records, as LibreOffice does
 * when EMF+ is absent. The picture size comes from the EMF frame or the WMF placeable header, at 96 dpi.
 */
export const isWmf = (u8: Uint8Array): boolean => u8.length > 22 && ((u8[0] === 0xd7 && u8[1] === 0xcd && u8[2] === 0xc6 && u8[3] === 0x9a) || ((u8[0] === 1 || u8[0] === 2) && u8[1] === 0 && u8[2] === 9 && u8[3] === 0 && (u8[4] === 0 || u8[4] === 1) && u8[5] === 3));
export const isEmf = (u8: Uint8Array): boolean => u8.length > 88 && u8[0] === 1 && u8[1] === 0 && u8[2] === 0 && u8[3] === 0 && u8[40] === 0x20 && u8[41] === 0x45 && u8[42] === 0x4d && u8[43] === 0x46;

type M = [number, number, number, number, number, number]; // a b c d e f: x' = a x + c y + e, y' = b x + d y + f
const mul = (p: M, q: M): M => [p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1], p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3], p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5]];
const I: M = [1, 0, 0, 1, 0, 0];

interface Pen { style: number; width: number; color: string; cosmetic: boolean; caps: number; join: number }
interface Brush { style: number; color: string; hatch: number; image?: CanvasImageSource | null }
interface Font { height: number; width: number; esc: number; weight: number; italic: boolean; underline: boolean; strike: boolean; face: string; charset: number }
interface DC {
  winOrg: [number, number]; winExt: [number, number]; vpOrg: [number, number]; vpExt: [number, number]; mapMode: number; world: M;
  pen: Pen; brush: Brush; font: Font; textColor: string; bkColor: string; bkMode: number; textAlign: number; fill: CanvasFillRule;
  pos: [number, number]; clips: Path2D[]; arcCW: boolean; rop2: number;
}
const color = (c: number) => `rgb(${c & 255},${(c >> 8) & 255},${(c >> 16) & 255})`;
const BLACK_PEN: Pen = { style: 0, width: 0, color: '#000', cosmetic: true, caps: 0, join: 0 };
const STOCK = (n: number): Pen | Brush | Font | null => {
  const gray = ['rgb(255,255,255)', 'rgb(192,192,192)', 'rgb(128,128,128)', 'rgb(64,64,64)', 'rgb(0,0,0)'];
  if (n <= 4) return { style: 0, color: gray[n], hatch: 0 };
  if (n === 5) return { style: 1, color: '#000', hatch: 0 };
  if (n === 6) return { ...BLACK_PEN, color: '#fff' };
  if (n === 7) return { ...BLACK_PEN };
  if (n === 8) return { ...BLACK_PEN, style: 5 };
  if (n >= 10 && n <= 17 && n !== 15) return { height: -13, width: 0, esc: 0, weight: 400, italic: false, underline: false, strike: false, face: n === 10 || n === 11 || n === 16 ? 'Courier New' : 'Arial', charset: 0 };
  if (n === 18) return { style: 0, color: '#fff', hatch: 0 };
  if (n === 19) return { ...BLACK_PEN };
  return null;
};
const isPen = (o: any): o is Pen => o && 'cosmetic' in o;
const isBrush = (o: any): o is Brush => o && 'hatch' in o;
const isFont = (o: any): o is Font => o && 'face' in o;
const CHARSETS: Record<number, string> = { 128: 'shift_jis', 129: 'euc-kr', 130: 'euc-kr', 134: 'gbk', 136: 'big5', 161: 'windows-1253', 162: 'windows-1254', 163: 'windows-1258', 177: 'windows-1255', 178: 'windows-1256', 186: 'windows-1257', 204: 'windows-1251', 222: 'windows-874', 238: 'windows-1250' };
const FACES: Record<string, string> = { arial: '"Arial", "Liberation Sans", Helvetica, sans-serif', helvetica: '"Helvetica", "Liberation Sans", Arial, sans-serif', 'times new roman': '"Times New Roman", "Liberation Serif", Times, serif', times: '"Times New Roman", "Liberation Serif", serif', 'courier new': '"Courier New", "Liberation Mono", Courier, monospace', courier: '"Courier New", "Liberation Mono", monospace', 'ms sans serif': '"Microsoft Sans Serif", "Liberation Sans", sans-serif', 'ms serif': '"Liberation Serif", serif', symbol: '"Symbol", "OpenSymbol", serif', wingdings: '"Wingdings", "OpenSymbol", sans-serif' };
const fontFamily = (face: string) => FACES[face.toLowerCase()] || `"${face.replace(/"/g, '')}", "Liberation Sans", sans-serif`;

// DIB (device-independent bitmap) to a canvas image source. ---------------------------------------
async function dibImage(u8: Uint8Array, bmi: number, bits: number, usage = 0): Promise<CanvasImageSource | null> {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const hs = dv.getUint32(bmi, true);
  let w: number, h: number, bpp: number, comp = 0, clrUsed = 0, palOff: number, palEntry = 4;
  if (hs === 12) { w = dv.getUint16(bmi + 4, true); h = dv.getInt16(bmi + 6, true); bpp = dv.getUint16(bmi + 10, true); palOff = bmi + 12; palEntry = 3; }
  else { w = dv.getInt32(bmi + 4, true); h = dv.getInt32(bmi + 8, true); bpp = dv.getUint16(bmi + 14, true); comp = dv.getUint32(bmi + 16, true); clrUsed = dv.getUint32(bmi + 32, true); palOff = bmi + hs; }
  if (comp === 4 || comp === 5) { // JPEG or PNG inside
    const size = hs >= 24 ? dv.getUint32(bmi + 20, true) : u8.length - bits;
    try { return await createImageBitmap(new Blob([u8.slice(bits, bits + size) as BlobPart], { type: comp === 4 ? 'image/jpeg' : 'image/png' })); } catch { return null; }
  }
  const bottomUp = h > 0, H = Math.abs(h);
  if (!w || !H || w * H > 50_000_000) return null;
  let masks = [0xff0000, 0xff00, 0xff, 0];
  if (comp === 3 || comp === 6) { masks = [dv.getUint32(palOff, true), dv.getUint32(palOff + 4, true), dv.getUint32(palOff + 8, true), comp === 6 || hs >= 56 ? dv.getUint32(palOff + 12, true) : 0]; if (hs === 40) palOff += comp === 6 ? 16 : 12; }
  const nPal = bpp <= 8 ? Math.min(clrUsed || 1 << bpp, 1 << bpp) : 0; // a palette has at most as many entries as the bit depth can index, whatever the header says
  const pal: number[][] = []; for (let i = 0; i < nPal; i++) { const o = palOff + i * palEntry; pal.push(usage === 1 ? [0, 0, 0] : [u8[o + 2], u8[o + 1], u8[o]]); }
  const img = new ImageData(w, H), d = img.data;
  const rowBytes = Math.floor((w * bpp + 31) / 32) * 4;
  let src = u8, srcBase = bits;
  if (comp === 1 || comp === 2) { src = rleDecode(u8.subarray(bits), w, H, comp === 1 ? 8 : 4, rowBytes); srcBase = 0; }
  const shift = (m: number) => { let s = 0; if (!m) return [0, 0]; while (!(m & 1)) { m >>>= 1; s++; } let n = 0; while (m & 1) { m >>>= 1; n++; } return [s, n]; };
  const sh = masks.map(shift);
  let anyAlpha = false;
  for (let y = 0; y < H; y++) {
    const row = srcBase + (bottomUp ? H - 1 - y : y) * rowBytes;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (bpp <= 8) { const idx = bpp === 8 ? src[row + x] : bpp === 4 ? (src[row + (x >> 1)] >> (x & 1 ? 0 : 4)) & 15 : bpp === 2 ? (src[row + (x >> 2)] >> (6 - 2 * (x & 3))) & 3 : (src[row + (x >> 3)] >> (7 - (x & 7))) & 1; const c = pal[idx] || [0, 0, 0]; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255; }
      else if (bpp === 24) { const p = row + x * 3; d[o] = src[p + 2]; d[o + 1] = src[p + 1]; d[o + 2] = src[p]; d[o + 3] = 255; }
      else if (bpp === 16 || bpp === 32) {
        const v = bpp === 16 ? src[row + x * 2] | (src[row + x * 2 + 1] << 8) : (src[row + x * 4] | (src[row + x * 4 + 1] << 8) | (src[row + x * 4 + 2] << 16) | (src[row + x * 4 + 3] << 24)) >>> 0;
        if (bpp === 16 && comp !== 3) { d[o] = ((v >> 10) & 31) * 255 / 31; d[o + 1] = ((v >> 5) & 31) * 255 / 31; d[o + 2] = (v & 31) * 255 / 31; d[o + 3] = 255; }
        else { for (let k = 0; k < 3; k++) { const [s, n] = sh[k]; d[o + k] = n ? (((v >>> s) & ((1 << n) - 1)) * 255) / ((1 << n) - 1) : 0; } const [as, an] = sh[3]; d[o + 3] = an ? (((v >>> as) & ((1 << an) - 1)) * 255) / ((1 << an) - 1) : bpp === 32 && comp === 0 ? src[row + x * 4 + 3] : 255; if (bpp === 32 && comp === 0 && d[o + 3]) anyAlpha = true; }
      }
    }
  }
  // 32-bit BI_RGB: the fourth byte is alpha only when some pixel uses it (otherwise it is padding).
  if (bpp === 32 && comp === 0 && !anyAlpha) for (let i = 3; i < d.length; i += 4) d[i] = 255;
  const c = document.createElement('canvas'); c.width = w; c.height = H; c.getContext('2d')!.putImageData(img, 0, 0);
  return c;
}
function rleDecode(src: Uint8Array, w: number, h: number, bpp: number, rowBytes: number): Uint8Array {
  const out = new Uint8Array(rowBytes * h); let x = 0, y = 0, p = 0;
  const put = (v: number) => { if (y >= h || x >= w) { x++; return; } const row = y * rowBytes; if (bpp === 8) out[row + x] = v; else out[row + (x >> 1)] |= (x & 1 ? v & 15 : (v & 15) << 4); x++; };
  while (p + 1 < src.length) {
    const n = src[p++], v = src[p++];
    if (n) { for (let i = 0; i < n; i++) put(bpp === 8 ? v : i & 1 ? v & 15 : v >> 4); continue; }
    if (v === 0) { x = 0; y++; } else if (v === 1) break; else if (v === 2) { x += src[p++]; y += src[p++]; }
    else { for (let i = 0; i < v; i++) put(bpp === 8 ? src[p + i] : i & 1 ? src[p + (i >> 1)] & 15 : src[p + (i >> 1)] >> 4); const bytes = bpp === 8 ? v : (v + 1) >> 1; p += bytes + (bytes & 1); }
  }
  return out;
}

const ROP_BLEND: Record<number, GlobalCompositeOperation> = { 0x008800c6: 'multiply', 0x00ee0086: 'lighten', 0x00660046: 'difference', 0x00bb0226: 'multiply', 0x00440328: 'source-over', 0x00330008: 'difference' };
function hatchPattern(ctx: CanvasRenderingContext2D, style: number, fg: string, bg: string | null): CanvasPattern | string {
  const c = document.createElement('canvas'); c.width = c.height = 8; const g = c.getContext('2d')!;
  if (bg) { g.fillStyle = bg; g.fillRect(0, 0, 8, 8); }
  g.fillStyle = fg;
  for (let i = 0; i < 8; i++) {
    if (style === 0 || style === 4) g.fillRect(i, 4, 1, 1);
    if (style === 1 || style === 4) g.fillRect(4, i, 1, 1);
    if (style === 2 || style === 5) g.fillRect(i, i, 1, 1);
    if (style === 3 || style === 5) g.fillRect(7 - i, i, 1, 1);
  }
  return ctx.createPattern(c, 'repeat') || fg;
}

/** The GDI drawing machine shared by WMF and EMF. */
class Gdi {
  dc: DC; stack: DC[] = []; objects: (Pen | Brush | Font | null | object)[] = [];
  path: Path2D | null = null; pathStart: [number, number] | null = null; inPath = false;
  device: M = I; // reference device (or WMF viewport) → canvas
  constructor(public ctx: CanvasRenderingContext2D, public emf: boolean) {
    this.dc = { winOrg: [0, 0], winExt: [1, 1], vpOrg: [0, 0], vpExt: [1, 1], mapMode: 1, world: I, pen: { ...BLACK_PEN }, brush: { style: 0, color: '#fff', hatch: 0 }, font: STOCK(13) as Font, textColor: '#000', bkColor: '#fff', bkMode: 2, textAlign: 0, fill: 'evenodd', pos: [0, 0], clips: [], arcCW: false, rop2: 13 };
  }
  // logical → canvas
  pageToDevice(): M {
    const d = this.dc;
    if (!this.emf) return [1 / d.winExt[0], 0, 0, 1 / d.winExt[1], -d.winOrg[0] / d.winExt[0], -d.winOrg[1] / d.winExt[1]]; // WMF: window → unit square (the device maps that to the canvas)
    let sx = 1, sy = 1;
    if (d.mapMode === 7 || d.mapMode === 8) { sx = d.vpExt[0] / d.winExt[0]; sy = d.vpExt[1] / d.winExt[1]; if (d.mapMode === 7) { const s = Math.min(Math.abs(sx), Math.abs(sy)); sx = Math.sign(sx) * s; sy = Math.sign(sy) * s; } }
    else if (d.mapMode > 1) { const mm = [0, 0, 0.1, 0.01, 0.254, 0.0254, 25.4 / 1440][d.mapMode]; sx = mm * this.pxPerMm[0]; sy = -mm * this.pxPerMm[1]; }
    return [sx, 0, 0, sy, d.vpOrg[0] - d.winOrg[0] * sx, d.vpOrg[1] - d.winOrg[1] * sy];
  }
  pxPerMm: [number, number] = [96 / 25.4, 96 / 25.4];
  get m(): M { return mul(this.device, mul(this.pageToDevice(), this.dc.world)); }
  pt(x: number, y: number): [number, number] { const m = this.m; return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
  scale(): number { const m = this.m; return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1; }
  // State
  save(): void { this.stack.push({ ...this.dc, clips: [...this.dc.clips] }); }
  restore(n: number): void { let k = n < 0 ? -n : this.stack.length - n; while (k-- > 0 && this.stack.length) this.dc = this.stack.pop()!; }
  addObject(o: object | null, index?: number): void { if (index !== undefined) { this.objects[index] = o; return; } let i = 0; while (this.objects[i] !== undefined && this.objects[i] !== null) i++; this.objects[i] = o ?? {}; }
  select(i: number): void {
    const o = i & 0x80000000 ? STOCK(i & 0x7fffffff) : this.objects[i];
    if (isPen(o)) this.dc.pen = o; else if (isBrush(o)) this.dc.brush = o; else if (isFont(o)) this.dc.font = o;
  }
  remove(i: number): void { if (!(i & 0x80000000)) this.objects[i] = null; }
  // Drawing
  private withClip(fn: () => void): void {
    const c = this.ctx; c.save();
    for (const p of this.dc.clips) c.clip(p);
    if (this.dc.rop2 === 6) c.globalCompositeOperation = 'difference'; // R2_NOT approximated
    fn(); c.restore();
  }
  private fillStyle(): string | CanvasPattern | null {
    const b = this.dc.brush;
    if (b.style === 1) return null;
    if (b.style === 2) return hatchPattern(this.ctx, b.hatch, b.color, this.dc.bkMode === 2 ? this.dc.bkColor : null);
    if ((b.style === 3 || b.style === 5) && b.image) return this.ctx.createPattern(b.image, 'repeat');
    return b.color;
  }
  private strokeSetup(): boolean {
    const p = this.dc.pen, c = this.ctx;
    if ((p.style & 15) === 5) return false;
    const w = p.cosmetic || !p.width ? 1 : Math.max(1, p.width * this.scale());
    c.lineWidth = w; c.strokeStyle = p.color;
    c.lineCap = (['round', 'square', 'butt'] as const)[(p.caps >> 8) & 3] || 'round';
    c.lineJoin = (['round', 'bevel', 'miter'] as const)[(p.join >> 12) & 3] || 'round';
    const u = Math.max(1, w), s = p.style & 15;
    c.setLineDash(s === 1 ? [18 * u / 3, 6 * u / 3] : s === 2 ? [3 * u / 3, 3 * u / 3] : s === 3 ? [9, 6, 3, 6].map((v) => (v * u) / 3) : s === 4 ? [9, 3, 3, 3, 3, 3].map((v) => (v * u) / 3) : []);
    return true;
  }
  /** Draws (or, inside BeginPath, records) a shape. */
  shape(build: (p: Path2D) => void, fill: boolean, stroke = true): void {
    if (this.inPath) { build(this.path ??= new Path2D()); return; }
    const p = new Path2D(); build(p);
    this.withClip(() => {
      const fs = fill ? this.fillStyle() : null;
      if (fs) { this.ctx.fillStyle = fs; this.ctx.fill(p, this.dc.fill); }
      if (stroke && this.strokeSetup()) this.ctx.stroke(p);
    });
  }
  poly(points: [number, number][], close: boolean, p: Path2D): void {
    points.forEach(([x, y], i) => { const q = this.pt(x, y); if (i) p.lineTo(q[0], q[1]); else p.moveTo(q[0], q[1]); });
    if (close && points.length) p.closePath();
  }
  bezier(points: [number, number][], p: Path2D, from?: [number, number]): void {
    const start = from ?? points.shift(); if (!start) return;
    const s = this.pt(start[0], start[1]);
    if (!from) p.moveTo(s[0], s[1]);
    for (let i = 0; i + 2 < points.length; i += 3) { const a = this.pt(...points[i]), b = this.pt(...points[i + 1]), c = this.pt(...points[i + 2]); p.bezierCurveTo(a[0], a[1], b[0], b[1], c[0], c[1]); }
  }
  /** Ellipse or elliptic arc in logical space, through the transform, as points. */
  ellipsePoints(l: number, t: number, r: number, b: number, from?: [number, number], to?: [number, number]): [number, number][] {
    const cx = (l + r) / 2, cy = (t + b) / 2, rx = Math.abs(r - l) / 2, ry = Math.abs(b - t) / 2, m = this.m;
    const det = m[0] * m[3] - m[1] * m[2];
    // Arcs go counterclockwise as seen (clockwise with SetArcDirection), whichever way the axes point.
    let a0 = 0, a1 = 2 * Math.PI, dir = 1;
    if (from && to) {
      a0 = Math.atan2((from[1] - cy) / (ry || 1), (from[0] - cx) / (rx || 1)); a1 = Math.atan2((to[1] - cy) / (ry || 1), (to[0] - cx) / (rx || 1));
      dir = (det > 0) !== this.dc.arcCW ? -1 : 1;
      if (dir > 0) { while (a1 <= a0) a1 += 2 * Math.PI; } else { while (a1 >= a0) a1 -= 2 * Math.PI; }
      if (Math.abs(a1 - a0) < 1e-9) a1 = a0 + dir * 2 * Math.PI;
    }
    const n = Math.max(16, Math.min(256, Math.ceil(Math.abs(a1 - a0) * Math.sqrt(rx * ry * this.scale()) / 2)));
    const pts: [number, number][] = [];
    for (let i = 0; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n; pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); }
    return pts;
  }
  roundRect(l: number, t: number, r: number, b: number, w: number, h: number, p: Path2D): void {
    const rx = Math.min(Math.abs(w) / 2, Math.abs(r - l) / 2), ry = Math.min(Math.abs(h) / 2, Math.abs(b - t) / 2), [x0, x1] = [Math.min(l, r), Math.max(l, r)], [y0, y1] = [Math.min(t, b), Math.max(t, b)];
    const pts: [number, number][] = [], corner = (cx: number, cy: number, a: number) => { for (let i = 0; i <= 8; i++) { const q = a + (Math.PI / 2) * (i / 8); pts.push([cx + rx * Math.cos(q), cy + ry * Math.sin(q)]); } };
    corner(x1 - rx, y0 + ry, -Math.PI / 2); corner(x1 - rx, y1 - ry, 0); corner(x0 + rx, y1 - ry, Math.PI / 2); corner(x0 + rx, y0 + ry, Math.PI);
    this.poly(pts, true, p);
  }
  clipRect(l: number, t: number, r: number, b: number): void { const p = new Path2D(); this.poly([[l, t], [r, t], [r, b], [l, b]], true, p); this.dc.clips = [...this.dc.clips, p]; }
  text(x: number, y: number, s: string, dx: number[] | null, opaque: number[] | null, clipRect: number[] | null): void {
    if (!s) return;
    const d = this.dc, f = d.font, c = this.ctx, m = this.m;
    if (d.textAlign & 1) [x, y] = d.pos; // TA_UPDATECP
    const ySc = Math.hypot(m[2], m[3]), xSc = Math.hypot(m[0], m[1]);
    let em = Math.abs(f.height || 12) * ySc; if (f.height > 0) em *= 0.86; // a positive height is the cell, not the em
    const flip = m[0] * m[3] - m[1] * m[2] < 0;
    const angle = (-(f.esc || 0) / 10) * (Math.PI / 180);
    const p = this.pt(x, y);
    this.withClip(() => {
      if (clipRect) { const q = new Path2D(); this.poly([[clipRect[0], clipRect[1]], [clipRect[2], clipRect[1]], [clipRect[2], clipRect[3]], [clipRect[0], clipRect[3]]], true, q); c.clip(q); }
      if (opaque) { const q = new Path2D(); this.poly([[opaque[0], opaque[1]], [opaque[2], opaque[1]], [opaque[2], opaque[3]], [opaque[0], opaque[3]]], true, q); c.fillStyle = d.bkColor; c.fill(q); }
      c.translate(p[0], p[1]); c.rotate(angle);
      c.font = `${f.italic ? 'italic ' : ''}${Math.min(900, Math.max(100, Math.round((f.weight || 400) / 100) * 100))} ${em}px ${fontFamily(f.face)}`;
      const ha = d.textAlign & 6, va = d.textAlign & 24;
      c.textBaseline = va === 24 ? 'alphabetic' : va === 8 ? 'bottom' : 'top';
      const widths = dx ? dx.map((v) => v * xSc) : null;
      const total = widths ? widths.reduce((a, b) => a + b, 0) : c.measureText(s).width;
      let x0 = ha === 2 ? -total : ha === 6 ? -total / 2 : 0;
      if (d.bkMode === 2 && !opaque) { const top = va === 24 ? -em * 0.8 : va === 8 ? -em : 0; c.fillStyle = d.bkColor; c.fillRect(x0, top, total, em); }
      c.fillStyle = d.textColor; c.textAlign = 'left';
      if (widths) { const chars = [...s]; for (let i = 0; i < chars.length; i++) { c.fillText(chars[i], x0, 0); x0 += widths[i] ?? 0; } x0 -= total; }
      else c.fillText(s, x0, 0);
      if (f.underline || f.strike) { c.fillStyle = d.textColor; const base = va === 24 ? 0 : va === 8 ? -em * 0.2 : em * 0.8; const th = Math.max(1, em / 16); if (f.underline) c.fillRect(x0, base + em * 0.1, total, th); if (f.strike) c.fillRect(x0, base - em * 0.3, total, th); }
    });
    if (d.textAlign & 1) { const adv = dx ? dx.reduce((a, b) => a + b, 0) : this.ctx.measureText(s).width / xSc; d.pos = [x + (flip ? adv : adv), y]; }
  }
  async bitmap(img: CanvasImageSource | null, dl: number, dt: number, dw: number, dh: number, sx: number, sy: number, sw: number, sh: number, rop: number): Promise<void> {
    const c = this.ctx, m = this.m;
    const fillRop = rop === 0x00000042 ? '#000' : rop === 0x00ff0062 ? '#fff' : rop === 0x00f00021 ? this.fillStyle() : null;
    this.withClip(() => {
      c.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
      if (fillRop) { c.fillStyle = fillRop; c.fillRect(dl, dt, dw, dh); return; }
      if (!img) return;
      const blend = ROP_BLEND[rop]; if (blend) c.globalCompositeOperation = blend;
      c.imageSmoothingQuality = 'high';
      const iw = (img as HTMLCanvasElement).width, ih = (img as HTMLCanvasElement).height;
      // Source rectangles count rows from the top of the bitmap.
      try { c.drawImage(img, sx, sy, sw || iw, sh || ih, dl, dt, dw, dh); } catch { /* an empty source rectangle */ }
    });
  }
}

// WMF -------------------------------------------------------------------------------------------------
export async function renderWmf(u8: Uint8Array, o: { maxSide?: number } = {}): Promise<{ canvas: HTMLCanvasElement; notes: string[]; warnings: string[] }> {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), warnings: string[] = [];
  let p = 0, bbox: number[] | null = null, inch = 1440;
  if (dv.getUint32(0, true) === 0x9ac6cdd7) { bbox = [dv.getInt16(6, true), dv.getInt16(8, true), dv.getInt16(10, true), dv.getInt16(12, true)]; inch = dv.getUint16(14, true) || 1440; p = 22; }
  const hdrWords = dv.getUint16(p + 2, true); p += hdrWords * 2;
  // Find the window (first SetWindowOrg/Ext) when there is no placeable header.
  let win: number[] | null = null;
  { let q = p, org = [0, 0]; while (q + 6 <= u8.length) { const size = dv.getUint32(q, true), fn = dv.getUint16(q + 4, true); if (!size || fn === 0) break; if (fn === 0x020b) org = [dv.getInt16(q + 8, true), dv.getInt16(q + 6, true)]; if (fn === 0x020c) { win = [org[0], org[1], dv.getInt16(q + 8, true), dv.getInt16(q + 6, true)]; break; } q += size * 2; } }
  const frame = bbox ? [bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]] : win ? win : [0, 0, 1000, 1000];
  const unitsPerInch = bbox ? inch : 1440;
  let W = Math.abs(frame[2]) / unitsPerInch * 96, H = Math.abs(frame[3]) / unitsPerInch * 96;
  if (!bbox && win && (W < 16 || H < 16)) { W = Math.abs(frame[2]); H = Math.abs(frame[3]); }
  const max = o.maxSide || 4096, k = Math.min(1, max / Math.max(W, H, 1)); W = Math.max(1, Math.ceil(W * k - 1e-6)); H = Math.max(1, Math.ceil(H * k - 1e-6)); // rounded up, as LibreOffice sizes them
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const g = new Gdi(ctx, false);
  // The window defaults to the frame; the device maps the window's unit square onto the canvas.
  g.dc.winOrg = [frame[0], frame[1]]; g.dc.winExt = [frame[2] || 1, frame[3] || 1];
  g.device = [W, 0, 0, H, 0, 0];
  const str = (q: number, n: number, charset: number) => { try { return new TextDecoder(CHARSETS[charset] || 'windows-1252').decode(u8.subarray(q, q + n)); } catch { return new TextDecoder('windows-1252').decode(u8.subarray(q, q + n)); } };
  let count = 0;
  while (p + 6 <= u8.length) {
    const size = dv.getUint32(p, true), fn = dv.getUint16(p + 4, true), a = p + 6;
    if (size < 3 || p + size * 2 > u8.length) { if (fn !== 0) warnings.push('The metafile ends early'); break; }
    if (fn === 0) break;
    const s16 = (i: number) => dv.getInt16(a + i * 2, true), u16 = (i: number) => dv.getUint16(a + i * 2, true);
    const pts = (off: number, n: number) => { const r: [number, number][] = []; for (let i = 0; i < n; i++) r.push([s16(off + 2 * i), s16(off + 2 * i + 1)]); return r; };
    const rgb = (i: number) => color(u16(i) | (u16(i + 1) << 16));
    try {
      switch (fn) {
        case 0x0103: g.dc.mapMode = u16(0); break;
        case 0x0104: g.dc.rop2 = u16(0); break;
        case 0x0106: g.dc.fill = u16(0) === 2 ? 'nonzero' : 'evenodd'; break;
        case 0x0102: g.dc.bkMode = u16(0); break;
        case 0x0201: g.dc.bkColor = rgb(0); break;
        case 0x0209: g.dc.textColor = rgb(0); break;
        case 0x012e: g.dc.textAlign = u16(0); break;
        case 0x020b: g.dc.winOrg = [s16(1), s16(0)]; break;
        case 0x020c: g.dc.winExt = [s16(1) || 1, s16(0) || 1]; break;
        case 0x020f: g.dc.winOrg = [g.dc.winOrg[0] + s16(1), g.dc.winOrg[1] + s16(0)]; break;
        case 0x0410: g.dc.winExt = [g.dc.winExt[0] * s16(3) / (s16(2) || 1), g.dc.winExt[1] * s16(1) / (s16(0) || 1)]; break;
        case 0x020d: case 0x020e: case 0x0211: case 0x0412: break; // the viewport is the output
        case 0x0214: g.dc.pos = [s16(1), s16(0)]; break;
        case 0x0213: { const to: [number, number] = [s16(1), s16(0)], from = g.dc.pos; g.shape((pp) => g.poly([from, to], false, pp), false); g.dc.pos = to; break; }
        case 0x0324: g.shape((pp) => g.poly(pts(1, s16(0)), true, pp), true); break;
        case 0x0325: g.shape((pp) => g.poly(pts(1, s16(0)), false, pp), false); break;
        case 0x0538: { const n = s16(0); let off = 1 + n; g.shape((pp) => { for (let i = 0; i < n; i++) { const c = s16(1 + i); g.poly(pts(off, c), true, pp); off += 2 * c; } off = 1 + n; }, true); break; }
        case 0x041b: { const [b, r, t, l] = [s16(0), s16(1), s16(2), s16(3)]; g.shape((pp) => g.poly([[l, t], [r, t], [r, b], [l, b]], true, pp), true); break; }
        case 0x061c: { const [h, w, b, r, t, l] = [s16(0), s16(1), s16(2), s16(3), s16(4), s16(5)]; g.shape((pp) => g.roundRect(l, t, r, b, w, h, pp), true); break; }
        case 0x0418: { const [b, r, t, l] = [s16(0), s16(1), s16(2), s16(3)]; g.shape((pp) => g.poly(g.ellipsePoints(l, t, r, b), true, pp), true); break; }
        case 0x0817: case 0x081a: case 0x0830: {
          const ye = s16(0), xe = s16(1), ys = s16(2), xs = s16(3), b = s16(4), r = s16(5), t = s16(6), l = s16(7);
          const arc = g.ellipsePoints(l, t, r, b, [xs, ys], [xe, ye]);
          if (fn === 0x0817) g.shape((pp) => g.poly(arc, false, pp), false);
          else g.shape((pp) => g.poly(fn === 0x081a ? [[(l + r) / 2, (t + b) / 2], ...arc] : arc, true, pp), true);
          break;
        }
        case 0x001e: g.save(); break;
        case 0x0127: g.restore(s16(0)); break;
        case 0x012d: g.select(u16(0)); break;
        case 0x01f0: g.remove(u16(0)); break;
        case 0x02fa: g.addObject({ style: u16(0), width: s16(1), color: rgb(3), cosmetic: s16(1) === 0, caps: u16(0) & 0x0f00, join: u16(0) & 0xf000 } as Pen); break;
        case 0x02fc: g.addObject({ style: u16(0), color: rgb(1), hatch: u16(3) } as Brush); break;
        case 0x02fb: { let face = ''; for (let i = 18; i < 50 && a + i < p + size * 2 && u8[a + i]; i++) face += String.fromCharCode(u8[a + i]); g.addObject({ height: s16(0), width: s16(1), esc: s16(2), weight: s16(4), italic: !!u8[a + 10], underline: !!u8[a + 11], strike: !!u8[a + 12], charset: u8[a + 13], face } as Font); break; }
        case 0x0142: { // DIB pattern brush
          const img = await dibImage(u8, a + 4, a + 4 + bmiSize(dv, a + 4), u16(1)); g.addObject({ style: 3, color: '#000', hatch: 0, image: img } as Brush); break;
        }
        case 0x00f7: case 0x06ff: case 0x01f9: g.addObject({}); break; // palettes, regions, old pattern brushes take a slot
        case 0x0416: { const [b, r, t, l] = [s16(0), s16(1), s16(2), s16(3)]; g.clipRect(l, t, r, b); break; }
        case 0x0415: break; // ExcludeClipRect: not applied
        case 0x0521: { const n = s16(0), off = a + 2, sp = 1 + ((n + 1) >> 1); g.text(s16(sp + 1), s16(sp), str(off, n, g.dc.font.charset), null, null, null); break; }
        case 0x0a32: {
          const y = s16(0), x = s16(1), n = s16(2), opts = u16(3); let q = 4; let rect: number[] | null = null;
          if (opts & 6) { rect = [s16(4), s16(5), s16(6), s16(7)]; q = 8; }
          const s = str(a + q * 2, n, g.dc.font.charset), dxOff = q + ((n + 1) >> 1);
          const words = (size * 2 - 6) / 2;
          const dx = words >= dxOff + n ? Array.from({ length: n }, (_, i) => s16(dxOff + i)) : null;
          g.text(x, y, s, dx, opts & 2 && rect ? rect : null, opts & 4 && rect ? rect : null); break;
        }
        case 0x0940: case 0x0b41: { // DIBBITBLT, DIBSTRETCHBLT
          const stretch = fn === 0x0b41, rop = u16(0) | (u16(1) << 16), hasBmp = size * 2 > (stretch ? 26 : 22) + 2;
          const v = (i: number) => s16(i + 2);
          const [sh, sw] = stretch ? [v(0), v(1)] : [0, 0];
          const base = stretch ? 2 : 0, sy = v(base), sx = v(base + 1), dh = v(base + 2), dw = v(base + 3), dy = v(base + 4), dx = v(base + 5);
          // DIBBITBLT without a bitmap has an extra reserved word.
          if (!hasBmp) { const r = rop, w2 = s16(stretch ? 6 : 5), h2 = s16(stretch ? 5 : 4); await g.bitmap(null, s16(stretch ? 8 : 7), s16(stretch ? 7 : 6), w2, h2, 0, 0, 0, 0, r); break; }
          const bmi = a + (stretch ? 20 : 16), img = await dibImage(u8, bmi, bmi + bmiSize(dv, bmi));
          await g.bitmap(img, dx, dy, dw, dh, sx, sy, stretch ? sw : dw, stretch ? sh : dh, rop); break;
        }
        case 0x0f43: { // STRETCHDIB
          const rop = u16(0) | (u16(1) << 16), usage = u16(2), sh = s16(3), sw = s16(4), sy = s16(5), sx = s16(6), dh = s16(7), dw = s16(8), dy = s16(9), dx = s16(10);
          const bmi = a + 22, img = await dibImage(u8, bmi, bmi + bmiSize(dv, bmi), usage);
          const ih = img ? (img as HTMLCanvasElement).height : 0;
          await g.bitmap(img, dx, dy, dw, dh, sx, Math.max(0, ih - sy - sh), sw, sh, rop); break;
        }
        case 0x0626: case 0x0035: case 0x0234: case 0x0231: case 0x0107: case 0x012c: case 0x0220: case 0x0037: break;
        default: count++;
      }
    } catch (e) { warnings.push(`Record ${fn.toString(16)}: ${(e as Error).message}`); }
    p += size * 2;
  }
  return { canvas, notes: [`Windows Metafile${bbox ? ' (placeable)' : ''}, ${Math.abs(frame[2])} × ${Math.abs(frame[3])} units at ${unitsPerInch} per inch`, 'drawn by Anne\'s Lens\'s own GDI interpreter'], warnings: count ? [...warnings, `${count} records of kinds not drawn were skipped`] : warnings };
}
function bmiSize(dv: DataView, bmi: number): number {
  const hs = dv.getUint32(bmi, true);
  if (hs === 12) { const bpp = dv.getUint16(bmi + 10, true); return 12 + (bpp <= 8 ? 3 << bpp : 0); }
  const bpp = dv.getUint16(bmi + 14, true), comp = dv.getUint32(bmi + 16, true), used = dv.getUint32(bmi + 32, true);
  return hs + (comp === 3 && hs === 40 ? 12 : comp === 6 && hs === 40 ? 16 : 0) + (bpp <= 8 ? (used || 1 << bpp) * 4 : 0);
}

// EMF -------------------------------------------------------------------------------------------------
export async function renderEmf(u8: Uint8Array, o: { maxSide?: number } = {}): Promise<{ canvas: HTMLCanvasElement; notes: string[]; warnings: string[] }> {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), warnings: string[] = [];
  const i32 = (q: number) => dv.getInt32(q, true), u32 = (q: number) => dv.getUint32(q, true);
  const bounds = [i32(8), i32(12), i32(16), i32(20)], fr = [i32(24), i32(28), i32(32), i32(36)];
  const dev = [i32(72), i32(76)], mm = [i32(80), i32(84)];
  const pxPerMm: [number, number] = [dev[0] / (mm[0] || 1), dev[1] / (mm[1] || 1)];
  // The frame (0.01 mm) in reference-device pixels, and the picture at 96 dpi.
  let fx0 = fr[0] / 100 * pxPerMm[0], fy0 = fr[1] / 100 * pxPerMm[1], fx1 = fr[2] / 100 * pxPerMm[0], fy1 = fr[3] / 100 * pxPerMm[1];
  let W = (fr[2] - fr[0]) / 2540 * 96, H = (fr[3] - fr[1]) / 2540 * 96;
  if (!(W > 0 && H > 0)) { fx0 = bounds[0]; fy0 = bounds[1]; fx1 = bounds[2] + 1; fy1 = bounds[3] + 1; W = fx1 - fx0; H = fy1 - fy0; }
  const max = o.maxSide || 4096, k = Math.min(1, max / Math.max(W, H, 1)); W = Math.max(1, Math.ceil(W * k - 1e-6)); H = Math.max(1, Math.ceil(H * k - 1e-6)); // rounded up, as LibreOffice sizes them
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const g = new Gdi(ctx, true); g.pxPerMm = pxPerMm;
  const sx = W / (fx1 - fx0 || 1), sy = H / (fy1 - fy0 || 1);
  g.device = [sx, 0, 0, sy, -fx0 * sx, -fy0 * sy];
  let p = 0, emfPlus = false, skipped = 0;
  const pointsL = (q: number, n: number) => { const r: [number, number][] = []; for (let i = 0; i < n; i++) r.push([i32(q + 8 * i), i32(q + 8 * i + 4)]); return r; };
  const points16 = (q: number, n: number) => { const r: [number, number][] = []; for (let i = 0; i < n; i++) r.push([dv.getInt16(q + 4 * i, true), dv.getInt16(q + 4 * i + 2, true)]); return r; };
  while (p + 8 <= u8.length) {
    const type = u32(p), size = u32(p + 4), a = p + 8;
    if (size < 8 || p + size > u8.length) { warnings.push('The metafile ends early'); break; }
    if (type === 14) break;
    try {
      switch (type) {
        case 1: break;
        case 2: case 3: case 4: case 85: case 86: case 87: { // POLYBEZIER, POLYGON, POLYLINE (+16)
          const is16 = type >= 85, n = u32(a + 16), pts = is16 ? points16(a + 20, n) : pointsL(a + 20, n), kind = is16 ? type - 83 : type;
          if (kind === 2) g.shape((pp) => g.bezier(pts, pp), false);
          else g.shape((pp) => g.poly(pts, kind === 3, pp), kind === 3, true);
          break;
        }
        case 5: case 6: case 88: case 89: { // POLYBEZIERTO, POLYLINETO (+16)
          const is16 = type >= 88, n = u32(a + 16), pts = is16 ? points16(a + 20, n) : pointsL(a + 20, n), bez = type === 5 || type === 88, from = g.dc.pos;
          g.shape((pp) => {
            // Outside a path, or at the start of one, the figure begins at the current position.
            if (!g.inPath || !g.pathStart) { const s = g.pt(...from); pp.moveTo(s[0], s[1]); if (g.inPath) g.pathStart = from; }
            if (bez) g.bezier([...pts], pp, from); else for (const q of pts) { const t = g.pt(...q); pp.lineTo(t[0], t[1]); }
          }, false);
          if (pts.length) g.dc.pos = pts[pts.length - 1];
          break;
        }
        case 7: case 8: case 90: case 91: { // POLYPOLYLINE, POLYPOLYGON (+16)
          const is16 = type >= 90, n = u32(a + 16), counts = Array.from({ length: n }, (_, i) => u32(a + 24 + 4 * i));
          let q = a + 24 + 4 * n; const polys = counts.map((c) => { const r = is16 ? points16(q, c) : pointsL(q, c); q += c * (is16 ? 4 : 8); return r; });
          const closed = type === 8 || type === 91;
          g.shape((pp) => polys.forEach((poly) => g.poly(poly, closed, pp)), closed);
          break;
        }
        case 9: g.dc.winExt = [i32(a) || 1, i32(a + 4) || 1]; break;
        case 10: g.dc.winOrg = [i32(a), i32(a + 4)]; break;
        case 11: g.dc.vpExt = [i32(a) || 1, i32(a + 4) || 1]; break;
        case 12: g.dc.vpOrg = [i32(a), i32(a + 4)]; break;
        case 17: g.dc.mapMode = u32(a); break;
        case 18: g.dc.bkMode = u32(a); break;
        case 19: g.dc.fill = u32(a) === 2 ? 'nonzero' : 'evenodd'; break;
        case 20: g.dc.rop2 = u32(a); break;
        case 22: g.dc.textAlign = u32(a); break;
        case 24: g.dc.textColor = color(u32(a)); break;
        case 25: g.dc.bkColor = color(u32(a)); break;
        case 27: g.dc.pos = [i32(a), i32(a + 4)]; if (g.inPath) { g.path ??= new Path2D(); const t = g.pt(i32(a), i32(a + 4)); g.path.moveTo(t[0], t[1]); g.pathStart = [i32(a), i32(a + 4)]; } break;
        case 54: { const to: [number, number] = [i32(a), i32(a + 4)], from = g.dc.pos; if (g.inPath) { g.path ??= new Path2D(); const t = g.pt(...to); g.path.lineTo(t[0], t[1]); } else g.shape((pp) => g.poly([from, to], false, pp), false); g.dc.pos = to; break; }
        case 30: g.clipRect(i32(a), i32(a + 4), i32(a + 8), i32(a + 12)); break;
        case 29: break;
        case 31: g.dc.vpExt = [g.dc.vpExt[0] * i32(a) / (i32(a + 4) || 1), g.dc.vpExt[1] * i32(a + 8) / (i32(a + 12) || 1)]; break;
        case 32: g.dc.winExt = [g.dc.winExt[0] * i32(a) / (i32(a + 4) || 1), g.dc.winExt[1] * i32(a + 8) / (i32(a + 12) || 1)]; break;
        case 33: g.save(); break;
        case 34: g.restore(i32(a)); break;
        case 35: case 36: {
          const x: M = [dv.getFloat32(a, true), dv.getFloat32(a + 4, true), dv.getFloat32(a + 8, true), dv.getFloat32(a + 12, true), dv.getFloat32(a + 16, true), dv.getFloat32(a + 20, true)];
          const mode = type === 35 ? 4 : u32(a + 24);
          g.dc.world = mode === 1 ? I : mode === 2 ? mul(g.dc.world, x) : mode === 3 ? mul(x, g.dc.world) : x;
          break;
        }
        case 37: g.select(u32(a)); break;
        case 40: g.remove(u32(a)); break;
        case 38: { const ih = u32(a), style = u32(a + 4), w = i32(a + 8); g.addObject({ style, width: w, color: color(u32(a + 16)), cosmetic: w === 0, caps: style & 0x0f00, join: style & 0xf000 } as Pen, ih); break; }
        case 95: { const ih = u32(a), style = u32(a + 20), w = u32(a + 24); g.addObject({ style, width: w, color: color(u32(a + 32)), cosmetic: !(style & 0x10000) || w === 0, caps: style & 0x0f00, join: style & 0xf000 } as Pen, ih); break; }
        case 39: g.addObject({ style: u32(a + 4), color: color(u32(a + 8)), hatch: u32(a + 12) } as Brush, u32(a)); break;
        case 94: case 93: { const ih = u32(a), usage = u32(a + 4), offBmi = u32(a + 8), offBits = u32(a + 16); g.addObject({ style: 3, color: '#000', hatch: 0, image: await dibImage(u8, p + offBmi, p + offBits, usage) } as Brush, ih); break; }
        case 82: {
          const ih = u32(a), q = a + 4; let face = '';
          for (let i = 0; i < 32; i++) { const ch = dv.getUint16(q + 28 + i * 2, true); if (!ch) break; face += String.fromCharCode(ch); }
          g.addObject({ height: i32(q), width: i32(q + 4), esc: i32(q + 8), weight: i32(q + 16), italic: !!u8[q + 20], underline: !!u8[q + 21], strike: !!u8[q + 22], charset: u8[q + 23], face } as Font, ih);
          break;
        }
        case 42: { const [l, t, r, b] = [i32(a), i32(a + 4), i32(a + 8), i32(a + 12)]; g.shape((pp) => g.poly(g.ellipsePoints(l, t, r, b), true, pp), true); break; }
        case 43: { const [l, t, r, b] = [i32(a), i32(a + 4), i32(a + 8), i32(a + 12)]; g.shape((pp) => g.poly([[l, t], [r, t], [r, b], [l, b]], true, pp), true); break; }
        case 44: { const [l, t, r, b] = [i32(a), i32(a + 4), i32(a + 8), i32(a + 12)]; g.shape((pp) => g.roundRect(l, t, r, b, i32(a + 16), i32(a + 20), pp), true); break; }
        case 45: case 46: case 47: case 55: {
          const [l, t, r, b] = [i32(a), i32(a + 4), i32(a + 8), i32(a + 12)], arc = g.ellipsePoints(l, t, r, b, [i32(a + 16), i32(a + 20)], [i32(a + 24), i32(a + 28)]);
          if (type === 45) g.shape((pp) => g.poly(arc, false, pp), false);
          else if (type === 55) { g.shape((pp) => g.poly([g.dc.pos, ...arc], false, pp), false); g.dc.pos = arc[arc.length - 1]; }
          else g.shape((pp) => g.poly(type === 47 ? [[(l + r) / 2, (t + b) / 2], ...arc] : arc, true, pp), true);
          break;
        }
        case 57: g.dc.arcCW = u32(a) === 2; break;
        case 59: g.inPath = true; g.path = new Path2D(); g.pathStart = null; break;
        case 60: g.inPath = false; break;
        case 61: g.path?.closePath(); break;
        case 68: g.inPath = false; g.path = null; break;
        case 62: case 63: case 64: {
          const path = g.path; if (!path) break;
          g.inPath = false;
          g.shape((pp) => pp.addPath(path), type !== 64, type !== 62);
          g.path = null; break;
        }
        case 67: { if (g.path) { const mode = u32(a); const path = g.path; g.dc.clips = mode === 5 ? [path] : [...g.dc.clips, path]; g.path = null; } break; }
        case 75: { // EXTSELECTCLIPRGN
          const cb = u32(a), mode = u32(a + 4);
          if (mode === 5 && cb === 0) { g.dc.clips = []; break; }
          const n = u32(a + 8 + 8), rp = new Path2D(); const dm = g.device; // region rectangles are in device units
          for (let i = 0; i < n; i++) { const q = a + 8 + 32 + i * 16, l = i32(q), t = i32(q + 4), r = i32(q + 8), b = i32(q + 12); rp.rect(dm[0] * l + dm[4], dm[3] * t + dm[5], dm[0] * (r - l), dm[3] * (b - t)); }
          g.dc.clips = mode === 5 ? [rp] : [...g.dc.clips, rp]; break;
        }
        case 84: case 83: { // EXTTEXTOUTW / A
          const t = a + 28, x = i32(t), y = i32(t + 4), n = u32(t + 8), offStr = u32(t + 12), opts = u32(t + 16), rect = [i32(t + 20), i32(t + 24), i32(t + 28), i32(t + 32)], offDx = u32(t + 36);
          let s = ''; if (type === 84) { for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint16(p + offStr + i * 2, true)); } else s = new TextDecoder(CHARSETS[g.dc.font.charset] || 'windows-1252').decode(u8.subarray(p + offStr, p + offStr + n));
          if (opts & 0x10) { s = ''; warnings.push('Text drawn by glyph indexes is not shown'); }
          const dx = offDx ? Array.from({ length: n }, (_, i) => i32(p + offDx + i * (opts & 0x2000 ? 8 : 4))) : null;
          const hasRect = rect[2] > rect[0] && rect[3] > rect[1];
          g.text(x, y, s, dx, opts & 2 && hasRect ? rect : null, opts & 4 && hasRect ? rect : null);
          break;
        }
        case 81: { // STRETCHDIBITS
          const xD = i32(a + 16), yD = i32(a + 20), xS = i32(a + 24), yS = i32(a + 28), cxS = i32(a + 32), cyS = i32(a + 36), offBmi = u32(a + 40), offBits = u32(a + 48), usage = u32(a + 56), rop = u32(a + 60), cxD = i32(a + 64), cyD = i32(a + 68);
          const img = u32(a + 44) ? await dibImage(u8, p + offBmi, p + offBits, usage) : null, ih = img ? (img as HTMLCanvasElement).height : 0;
          await g.bitmap(img, xD, yD, cxD, cyD, xS, Math.max(0, ih - yS - cyS), cxS, cyS, rop); break;
        }
        case 76: case 77: case 114: { // BITBLT, STRETCHBLT, ALPHABLEND
          const xD = i32(a + 16), yD = i32(a + 20), cxD = i32(a + 24), cyD = i32(a + 28), rop = u32(a + 32), xS = i32(a + 36), yS = i32(a + 40), offBmi = u32(a + 72), cbBmi = u32(a + 76), offBits = u32(a + 80);
          const cxS = type === 76 ? cxD : i32(a + 88), cyS = type === 76 ? cyD : i32(a + 92);
          const img = cbBmi ? await dibImage(u8, p + offBmi, p + offBits, u32(a + 68)) : null;
          if (type === 114) { const alpha = ((rop >> 16) & 255) / 255; ctx.save(); ctx.globalAlpha = alpha; await g.bitmap(img, xD, yD, cxD, cyD, xS, yS, cxS, cyS, 0x00cc0020); ctx.restore(); }
          else await g.bitmap(img, xD, yD, cxD, cyD, xS, yS, cxS, cyS, rop);
          break;
        }
        case 80: { // SETDIBITSTODEVICE
          const xD = i32(a + 16), yD = i32(a + 20), xS = i32(a + 24), yS = i32(a + 28), cx = i32(a + 32), cy = i32(a + 36), offBmi = u32(a + 40), offBits = u32(a + 48), usage = u32(a + 56);
          const img = await dibImage(u8, p + offBmi, p + offBits, usage), ih = img ? (img as HTMLCanvasElement).height : 0;
          await g.bitmap(img, xD, yD, cx, cy, xS, Math.max(0, ih - yS - cy), cx, cy, 0x00cc0020); break;
        }
        case 70: { if (u32(a + 4) === 0x2b464d45) emfPlus = true; break; } // "EMF+" comments
        case 13: case 15: case 16: case 21: case 23: case 48: case 49: case 50: case 51: case 52: case 58: case 98: case 99: case 100: case 101: case 102: case 103: case 104: case 105: case 106: case 107: case 110: case 115: case 120: case 121: case 122: break;
        default: skipped++;
      }
    } catch (e) { warnings.push(`Record ${type}: ${(e as Error).message}`); }
    p += size;
  }
  const notes = [`Enhanced Metafile, ${((fr[2] - fr[0]) / 100).toFixed(1)} × ${((fr[3] - fr[1]) / 100).toFixed(1)} mm`, 'drawn by Anne\'s Lens\'s own GDI interpreter'];
  if (emfPlus) notes.push('EMF+ records are skipped; the EMF records are drawn');
  if (skipped) warnings.push(`${skipped} records of kinds not drawn were skipped`);
  return { canvas, notes, warnings };
}
