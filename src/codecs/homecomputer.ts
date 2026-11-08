/**
 * Pictures from 1980s home computers and early PC paint programs, read by the app's own code from their
 * published descriptions. None of these has a magic number except GEM and MS Paint, so the Atari and C64
 * files are recognized by their extension together with their exact size and header values.
 * - Atari ST: Degas and Degas Elite (.pi1/.pi2/.pi3 plain, .pc1/.pc2/.pc3 PackBits per line and plane) in the
 *   low (320 × 200, 16 colors), medium (640 × 200, 4 colors; pixels twice as tall as wide) and high
 *   (640 × 400, black and white) resolutions; NEOchrome (.neo); Spectrum 512 (.spu, 48 colors on every line).
 *   ST colors have 3 bits per channel, STE colors 4 (when the palette uses the STE's extra bit).
 * - Commodore 64 (shown with the Pepto palette): Koala Painter (.koa, .kla; multicolor, 160 × 200 double-wide
 *   pixels), Art Studio (.art, .aas; hires 320 × 200) and Doodle (.dd; hires).
 * - GEM IMG (.img; GEM Paint, Ventura Publisher, scanners): 1–8 planes, vertical replication, pattern and
 *   solid runs and bit strings, the XIMG palette (else the GEM VDI colors).
 * - Microsoft Paint for Windows 1.x and 2.x (.msp): version 1 (plain) and version 2 (run-length coded rows).
 */
import { makeRaster, type DecodeResult, type Raster } from './raster';

const be16 = (u: Uint8Array, o: number) => (u[o] << 8) | u[o + 1];
const le16 = (u: Uint8Array, o: number) => u[o] | (u[o + 1] << 8);
const ext = (name: string) => (name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
const result = (r: Raster, bitDepth: number, notes: string[], paletteSize?: number, dpi?: [number, number], warnings: string[] = []): DecodeResult =>
  ({ pages: [{ width: r.width, height: r.height, frames: [{ raster: r, delay: 0 }], loops: 0, bitDepth, hasAlpha: false, paletteSize, dpi, notes }], info: {}, warnings });
function paint(r: Raster, x: number, y: number, c: ArrayLike<number>) { const o = (y * r.width + x) * 4; r.data[o] = c[0]; r.data[o + 1] = c[1]; r.data[o + 2] = c[2]; r.data[o + 3] = 255; }

/** PackBits: n ≥ 0 copies n + 1 bytes, −127…−1 repeats the next byte 1 − n times. Returns the position after. */
function unpackBits(src: Uint8Array, p: number, out: Uint8Array, o: number, n: number): number {
  const end = o + n;
  while (o < end && p < src.length) {
    const c = (src[p++] << 24) >> 24;
    if (c >= 0) { const k = Math.min(c + 1, end - o, src.length - p); out.set(src.subarray(p, p + k), o); o += k; p += c + 1; }
    else if (c !== -128) { out.fill(src[p++] ?? 0, o, Math.min(end, o + 1 - c)); o += 1 - c; }
  }
  return p;
}

// Atari ST -------------------------------------------------------------------------------------------
const ST_RES = [{ w: 320, h: 200, planes: 4, label: 'low resolution, 16 colors' }, { w: 640, h: 200, planes: 2, label: 'medium resolution, 4 colors (pixels twice as tall as wide)' }, { w: 640, h: 400, planes: 1, label: 'high resolution, black and white' }];
/** ST palette words (0x0RGB, 3 bits a channel; the STE adds a fourth, low bit as bit 3 of each nibble). */
function stPalette(u8: Uint8Array, o: number, n = 16): { rgb: number[][]; ste: boolean } {
  const words = Array.from({ length: n }, (_, i) => be16(u8, o + i * 2));
  const ste = words.some((w) => w & 0x888);
  const ch = (v: number) => (ste ? ((((v & 7) << 1) | ((v >> 3) & 1)) * 17) : Math.round((v & 7) * 255 / 7));
  return { rgb: words.map((w) => [ch((w >> 8) & 15), ch((w >> 4) & 15), ch(w & 15)]), ste };
}
/** Interleaved bitplanes: each group of 16 pixels is one word per plane. */
function stPlanar(bm: Uint8Array, res: (typeof ST_RES)[number], pal: number[][], mono: boolean, normal: boolean): Raster {
  const r = makeRaster(res.w, res.h), groups = res.w >> 4;
  for (let y = 0; y < res.h; y++) for (let g = 0; g < groups; g++) {
    const at = (y * groups + g) * res.planes * 2;
    for (let b = 0; b < 16; b++) {
      let c = 0;
      for (let p = 0; p < res.planes; p++) c |= ((be16(bm, at + p * 2) >> (15 - b)) & 1) << p;
      paint(r, g * 16 + b, y, mono ? ((c ^ (normal ? 0 : 1)) ? [0, 0, 0] : [255, 255, 255]) : pal[c]);
    }
  }
  return r;
}
export function isAtariSt(u8: Uint8Array, name: string): boolean {
  const e = ext(name), res = be16(u8, 0);
  if (/^pi[123]$/.test(e)) return (u8.length === 32034 || u8.length === 32066) && res === +e[2] - 1;
  if (/^pc[123]$/.test(e)) return u8.length > 34 && u8.length <= 34 + 32000 * 2 + 32 && res === 0x8000 + +e[2] - 1;
  if (e === 'neo') return u8.length === 32128 && be16(u8, 0) === 0 && be16(u8, 2) <= 2;
  if (e === 'spu') return u8.length === 51104;
  return false;
}
export function decodeAtariSt(u8: Uint8Array, name: string): DecodeResult {
  const e = ext(name), warnings: string[] = [];
  if (e === 'spu') return decodeSpectrum(u8);
  const neo = e === 'neo', res = ST_RES[(neo ? be16(u8, 2) : be16(u8, 0)) & 3];
  if (!res) throw new Error('Unknown Atari ST resolution');
  const { rgb, ste } = stPalette(u8, neo ? 4 : 2);
  let bm: Uint8Array, footerAt = 34 + 32000;
  if (/^pc/.test(e)) { // per line, each plane's bytes PackBits-compressed in turn, back into interleaved words
    bm = new Uint8Array(32000);
    const lineBytes = res.w / 8, plane = new Uint8Array(lineBytes);
    let p = 34;
    for (let y = 0; y < res.h; y++) for (let pl = 0; pl < res.planes; pl++) {
      plane.fill(0); p = unpackBits(u8, p, plane, 0, lineBytes);
      for (let g = 0; g < lineBytes / 2; g++) { const o = (y * (res.w >> 4) + g) * res.planes * 2 + pl * 2; bm[o] = plane[g * 2]; bm[o + 1] = plane[g * 2 + 1]; }
    }
    if (p > u8.length) warnings.push('The picture data is cut short');
    footerAt = p;
  } else bm = u8.subarray(neo ? 128 : 34, (neo ? 128 : 34) + 32000);
  const mono = res.planes === 1, normal = (be16(u8, neo ? 4 : 2) & 1) === 1;
  const r = stPlanar(bm, res, rgb, mono, normal);
  const kind = neo ? 'NEOchrome' : /^pc/.test(e) ? 'Degas Elite (compressed)' : 'Degas';
  const notes = [`Atari ST ${kind} picture, ${res.label}${ste && !mono ? ', STE colors' : ''}`];
  if (neo) { const fn = new TextDecoder('latin1').decode(u8.subarray(36, 48)).trim(); if (fn && /^[\x20-\x7e]+$/.test(fn)) notes.push(`saved as ${fn}`); }
  // Color cycling: NEOchrome's animation words, or Degas Elite's four animation channels in the 32-byte footer.
  const cycles = mono ? [] : neo ? neoCycles(u8) : degasCycles(u8, footerAt);
  const active = cycles.filter((c) => c.hi > c.lo && c.hi < rgb.length);
  if (active.length) {
    const steps = Math.max(...active.map((c) => c.hi - c.lo + 1)), delay = Math.max(16, Math.round((1000 / 60) * Math.min(...active.map((c) => c.vbl))));
    const frames: { raster: Raster; delay: number }[] = [];
    let pal = rgb.map((c) => c.slice());
    for (let st = 0; st < steps; st++) {
      frames.push({ raster: stPlanar(bm, res, pal, mono, normal), delay });
      pal = pal.map((c) => c.slice());
      for (const c of active) { const seg = pal.slice(c.lo, c.hi + 1); const turned = c.right ? [seg[seg.length - 1], ...seg.slice(0, -1)] : [...seg.slice(1), seg[0]]; turned.forEach((col, k) => { pal[c.lo + k] = col; }); }
    }
    notes.push(`color cycling: ${active.length} range${active.length > 1 ? 's' : ''} (${active.map((c) => `colors ${c.lo}–${c.hi} ${c.right ? 'right' : 'left'}, ${c.vbl} VBL`).join('; ')}), played as an animation of ${frames.length} frames`);
    return { pages: [{ width: r.width, height: r.height, frames, loops: 0, bitDepth: res.planes, hasAlpha: false, paletteSize: 1 << res.planes, dpi: res.planes === 2 ? [90, 45] : undefined, notes }], info: {}, warnings };
  }
  return result(r, res.planes, notes, mono ? 2 : 1 << res.planes, res.planes === 2 ? [90, 45] : undefined, warnings);
}
interface Cycle { lo: number; hi: number; right: boolean; vbl: number }
/** NEOchrome: word 24 holds the limits (bit 15 = valid, bits 4–7 the upper color, bits 0–3 the lower), word 25 the speed (bit 15 = on; the low byte, signed: VBLs per step, negative = left). */
function neoCycles(u8: Uint8Array): Cycle[] {
  const lim = be16(u8, 48), spd = be16(u8, 50);
  if (!(lim & 0x8000) || !(spd & 0x8000)) return [];
  const speed = (spd & 0xff) << 24 >> 24; // signed
  return [{ lo: lim & 15, hi: (lim >> 4) & 15, right: speed >= 0, vbl: Math.max(1, Math.abs(speed) || 1) }];
}
/** Degas Elite: after the bitmap, four channels: left colors, right colors, directions (0 left, 1 off, 2 right) and delays (128 − delay VBLs per step). */
function degasCycles(u8: Uint8Array, at: number): Cycle[] {
  if (at + 32 > u8.length) return [];
  const out: Cycle[] = [];
  for (let k = 0; k < 4; k++) {
    const lo = be16(u8, at + k * 2), hi = be16(u8, at + 8 + k * 2), dir = be16(u8, at + 16 + k * 2), delay = be16(u8, at + 24 + k * 2);
    if (dir === 1 || dir > 2 || lo > 15 || hi > 15 || hi <= lo || delay > 128) continue;
    out.push({ lo, hi, right: dir === 2, vbl: Math.max(1, 128 - delay) });
  }
  return out;
}
/** Spectrum 512: 199 lines, each with 48 colors in three palettes; the palette a pixel uses depends on x and its index. */
function decodeSpectrum(u8: Uint8Array): DecodeResult {
  const r = makeRaster(320, 200), res = ST_RES[0];
  for (let x = 0; x < 320; x++) paint(r, x, 0, [0, 0, 0]);
  for (let y = 1; y < 200; y++) {
    const { rgb } = stPalette(u8, 32000 + (y - 1) * 96, 48);
    for (let g = 0; g < 20; g++) {
      const at = (y * 20 + g) * 8;
      for (let b = 0; b < 16; b++) {
        let c = 0;
        for (let p = 0; p < 4; p++) c |= ((be16(u8, at + p * 2) >> (15 - b)) & 1) << p;
        const x = g * 16 + b;
        let x1 = 10 * c; if (c & 1) x1 -= 5; else x1++;
        const k = x >= x1 && x < x1 + 160 ? c + 16 : x >= x1 + 160 ? c + 32 : c;
        paint(r, x, y, rgb[k]);
      }
    }
  }
  void res;
  return result(r, 4, ['Atari ST Spectrum 512 picture, 320 × 199 with 48 colors on every line (the first line is not shown)'], 512);
}

// Commodore 64 ---------------------------------------------------------------------------------------
const PEPTO = [0x000000, 0xffffff, 0x68372b, 0x70a4b2, 0x6f3d86, 0x588d43, 0x352879, 0xb8c76f, 0x6f4f25, 0x433900, 0x9a6759, 0x444444, 0x6c6c6c, 0x9ad284, 0x6c5eb5, 0x959595].map((v) => [v >> 16, (v >> 8) & 255, v & 255]);
export function isC64(u8: Uint8Array, name: string): boolean {
  const e = ext(name);
  if (e === 'koa' || e === 'kla') return u8.length === 10003 && u8[0] === 0x00 && u8[1] === 0x60;
  if (e === 'art' || e === 'aas') return u8.length === 9009 && u8[0] === 0x00 && u8[1] === 0x20;
  if (e === 'dd' || e === 'ddl') return u8.length >= 9026 && u8.length <= 9218 && u8[0] === 0x00 && u8[1] === 0x5c;
  return false;
}
function c64Hires(bitmap: Uint8Array, screen: Uint8Array): Raster {
  const r = makeRaster(320, 200);
  for (let cell = 0; cell < 1000; cell++) {
    const cx = (cell % 40) * 8, cy = Math.floor(cell / 40) * 8, fg = PEPTO[screen[cell] >> 4], bg = PEPTO[screen[cell] & 15];
    for (let row = 0; row < 8; row++) { const b = bitmap[cell * 8 + row] ?? 0; for (let px = 0; px < 8; px++) paint(r, cx + px, cy + row, (b >> (7 - px)) & 1 ? fg : bg); }
  }
  return r;
}
export function decodeC64(u8: Uint8Array, name: string): DecodeResult {
  const e = ext(name);
  if (e === 'art' || e === 'aas') return result(c64Hires(u8.subarray(2, 8002), u8.subarray(8002, 9002)), 1, ['Commodore 64 Art Studio picture, hires 320 × 200', `border color ${u8[9002] & 15}`], 16);
  if (e === 'dd' || e === 'ddl') return result(c64Hires(u8.subarray(1026, 9026), u8.subarray(2, 1002)), 1, ['Commodore 64 Doodle picture, hires 320 × 200'], 16);
  const bitmap = u8.subarray(2, 8002), screen = u8.subarray(8002, 9002), color = u8.subarray(9002, 10002), bg = u8[10002] & 15;
  const r = makeRaster(320, 200);
  for (let cell = 0; cell < 1000; cell++) {
    const cx = (cell % 40) * 8, cy = Math.floor(cell / 40) * 8;
    const cols = [PEPTO[bg], PEPTO[screen[cell] >> 4], PEPTO[screen[cell] & 15], PEPTO[color[cell] & 15]];
    for (let row = 0; row < 8; row++) {
      const b = bitmap[cell * 8 + row];
      for (let px = 0; px < 4; px++) { const c = cols[(b >> (6 - px * 2)) & 3]; paint(r, cx + px * 2, cy + row, c); paint(r, cx + px * 2 + 1, cy + row, c); }
    }
  }
  return result(r, 2, ['Commodore 64 Koala Painter picture, multicolor 160 × 200 (pixels shown twice as wide)', `background color ${bg}`], 16);
}

// GEM IMG --------------------------------------------------------------------------------------------
const GEM_VDI = [[255, 255, 255], [0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255], [0, 255, 255], [255, 255, 0], [255, 0, 255], [192, 192, 192], [128, 128, 128], [128, 0, 0], [0, 128, 0], [0, 0, 128], [0, 128, 128], [128, 128, 0], [128, 0, 128]];
export const isGemImg = (u8: Uint8Array, name: string): boolean => {
  if (u8.length < 16) return false;
  const v = be16(u8, 0), hl = be16(u8, 2), planes = be16(u8, 4), pat = be16(u8, 6), w = be16(u8, 12), h = be16(u8, 14);
  const ximg = u8.length > 20 && String.fromCharCode(u8[16], u8[17], u8[18], u8[19]) === 'XIMG';
  return (ximg || /\.img$/i.test(name)) && v >= 1 && v <= 3 && hl >= 8 && hl < 2048 && planes >= 1 && planes <= 8 && pat >= 1 && pat <= 8 && w > 0 && h > 0;
};
export function decodeGemImg(u8: Uint8Array): DecodeResult {
  const hl = be16(u8, 2) * 2, planes = be16(u8, 4), patLen = be16(u8, 6), pw = be16(u8, 8), ph = be16(u8, 10), w = be16(u8, 12), h = be16(u8, 14);
  if (w * h > 200e6) throw new Error(`This GEM IMG file has an impossible size (${w} × ${h})`);
  const ximg = String.fromCharCode(u8[16], u8[17], u8[18], u8[19]) === 'XIMG', warnings: string[] = [];
  let pal: number[][] = planes === 1 ? [[255, 255, 255], [0, 0, 0]] : GEM_VDI.slice();
  if (ximg && be16(u8, 20) === 0) { pal = []; for (let i = 0; i < 1 << planes && 22 + i * 6 + 6 <= hl; i++) pal.push([0, 2, 4].map((k) => Math.round(Math.min(1000, be16(u8, 22 + i * 6 + k)) * 255 / 1000))); }
  while (pal.length < 1 << planes) { const i = pal.length; pal.push([i & 0xff, i & 0xff, i & 0xff]); }
  const bpl = (w + 7) >> 3, lines = new Uint8Array(bpl * planes * h);
  let p = hl, y = 0;
  while (y < h && p < u8.length) {
    let rep = 1;
    if (u8[p] === 0 && u8[p + 1] === 0 && u8[p + 2] === 0xff) { rep = u8[p + 3] || 1; p += 4; }
    const line = new Uint8Array(bpl * planes);
    for (let pl = 0; pl < planes; pl++) {
      let o = pl * bpl; const end = o + bpl;
      while (o < end && p < u8.length) {
        const b = u8[p++];
        if (b === 0) { const n = u8[p++]; for (let i = 0; i < n; i++) for (let k = 0; k < patLen && o < end; k++) line[o++] = u8[p + k]; p += patLen; }
        else if (b === 0x80) { const n = u8[p++]; for (let i = 0; i < n && o < end; i++) line[o++] = u8[p + i]; p += n; }
        else { const n = b & 0x7f, v = b & 0x80 ? 0xff : 0; for (let i = 0; i < n && o < end; i++) line[o++] = v; }
      }
    }
    for (let k = 0; k < rep && y < h; k++, y++) lines.set(line, y * bpl * planes);
  }
  if (y < h) warnings.push(`The picture data is cut short (${y} of ${h} lines)`);
  const r = makeRaster(w, h);
  for (let yy = 0; yy < h; yy++) for (let x = 0; x < w; x++) {
    let c = 0;
    for (let pl = 0; pl < planes; pl++) c |= ((lines[(yy * planes + pl) * bpl + (x >> 3)] >> (7 - (x & 7))) & 1) << pl;
    paint(r, x, yy, pal[c]);
  }
  const dpi: [number, number] | undefined = pw && ph ? [Math.round(25400 / pw), Math.round(25400 / ph)] : undefined;
  return result(r, planes, [`GEM IMG, ${planes} plane${planes === 1 ? '' : 's'}${ximg ? ', XIMG palette' : planes > 1 ? ', GEM VDI colors' : ''}`], 1 << planes, dpi, warnings);
}

// Microsoft Paint ------------------------------------------------------------------------------------
export const isMsp = (u8: Uint8Array): boolean => u8.length >= 32 && (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) === 'DanM' || String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) === 'LinS');
export function decodeMsp(u8: Uint8Array): DecodeResult {
  const v2 = u8[0] === 0x4c, w = le16(u8, 4), h = le16(u8, 6), bpl = (w + 7) >> 3, warnings: string[] = [];
  if (!w || !h) throw new Error('This MS Paint file has no picture');
  let ck = 0; for (let i = 0; i < 32; i += 2) ck ^= le16(u8, i);
  if (ck) warnings.push('The header checksum does not match');
  const bits = new Uint8Array(bpl * h);
  if (!v2) bits.set(u8.subarray(32, 32 + bits.length));
  else {
    let p = 32 + h * 2;
    for (let y = 0; y < h; y++) {
      const len = le16(u8, 32 + y * 2), end = Math.min(u8.length, p + len);
      let o = y * bpl; const rowEnd = o + bpl;
      if (!len) bits.fill(0xff, o, rowEnd);
      for (let q = p; q < end && o < rowEnd;) {
        const t = u8[q++];
        if (t === 0) { const n = u8[q++], val = u8[q++]; for (let i = 0; i < n && o < rowEnd; i++) bits[o++] = val; }
        else { for (let i = 0; i < t && o < rowEnd; i++) bits[o++] = u8[q + i]; q += t; }
      }
      p += len;
    }
    if (p > u8.length) warnings.push('The picture data is cut short');
  }
  const r = makeRaster(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = (bits[y * bpl + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0; paint(r, x, y, [v, v, v]); }
  return result(r, 1, [`Microsoft Paint ${v2 ? '2.x (run-length coded)' : '1.x'} picture`], 2, undefined, warnings);
}
