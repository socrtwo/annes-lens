/**
 * Windows and OS/2 bitmaps (BMP/DIB) and the DIBs inside ICO and CUR files: 1, 4, 8, 16, 24 and 32 bits
 * per pixel, RLE4 and RLE8, bit-field masks, top-down and bottom-up rows, with an optional AND mask
 * (icons). Also a 24/32-bit BMP writer.
 */
import { makeRaster, type DecodeResult, type Raster } from './raster';

export function isBmp(u8: Uint8Array): boolean {
  return u8.length > 26 && u8[0] === 0x42 && u8[1] === 0x4d;
}

export function decodeBmp(u8: Uint8Array): DecodeResult {
  if (!isBmp(u8)) throw new Error('Not a BMP file');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const pixelOffset = dv.getUint32(10, true);
  const r = decodeDib(u8.subarray(14), pixelOffset - 14, false);
  return { pages: [{ width: r.raster.width, height: r.raster.height, frames: [{ raster: r.raster, delay: 0 }], loops: 0, bitDepth: r.bpp, paletteSize: r.palette || undefined, hasAlpha: r.hasAlpha, dpi: r.dpi, notes: r.notes }], info: {}, warnings: r.warnings };
}

export interface DibResult { raster: Raster; bpp: number; palette: number; hasAlpha: boolean; dpi?: [number, number]; notes: string[]; warnings: string[] }

/**
 * Decodes a DIB (BITMAPINFOHEADER and successors, or BITMAPCOREHEADER) at the start of `u8`.
 * `pixelOffset` (relative to u8) locates the pixels when a file header said so; otherwise they follow the
 * header and palette. `icon`: the height field counts the XOR and AND masks together.
 */
export function decodeDib(u8: Uint8Array, pixelOffset: number | null, icon: boolean): DibResult {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const hdr = dv.getUint32(0, true);
  const warnings: string[] = [];
  let w: number, h: number, bpp: number, comp = 0, colors = 0, xppm = 0, yppm = 0;
  let masks: [number, number, number, number] | null = null;
  if (hdr === 12) { w = dv.getUint16(4, true); h = dv.getInt16(6, true); bpp = dv.getUint16(10, true); }
  else {
    w = dv.getInt32(4, true); h = dv.getInt32(8, true); bpp = dv.getUint16(14, true); comp = dv.getUint32(16, true);
    xppm = dv.getInt32(24, true); yppm = dv.getInt32(28, true); colors = dv.getUint32(32, true);
    if (hdr >= 52 && (comp === 3 || comp === 6)) masks = [dv.getUint32(40, true), dv.getUint32(44, true), dv.getUint32(48, true), hdr >= 56 ? dv.getUint32(52, true) : 0];
    else if (hdr === 40 && comp === 3) masks = [dv.getUint32(40, true), dv.getUint32(44, true), dv.getUint32(48, true), 0];
  }
  const topDown = h < 0;
  h = Math.abs(h);
  if (icon) h = Math.floor(h / 2);
  if (!w || !h || w * h > 80_000_000) throw new Error('bad DIB dimensions');
  const paletteAt = hdr + (hdr === 40 && comp === 3 ? 12 : 0);
  const entrySize = hdr === 12 ? 3 : 4;
  const palCount = bpp <= 8 ? Math.min(colors || 1 << bpp, 1 << bpp) : 0; // never more entries than the depth can index, whatever the header says
  const palette = new Uint8Array(palCount * 3);
  for (let i = 0; i < palCount; i++) { const o = paletteAt + i * entrySize; palette[i * 3] = u8[o + 2]; palette[i * 3 + 1] = u8[o + 1]; palette[i * 3 + 2] = u8[o]; }
  let px = pixelOffset ?? paletteAt + palCount * entrySize;
  if (pixelOffset != null && pixelOffset < paletteAt) px = paletteAt + palCount * entrySize;
  const stride = Math.ceil((w * bpp) / 32) * 4;
  const out = makeRaster(w, h);
  const d = out.data;
  const notes: string[] = [];
  let pixels: Uint8Array = u8.subarray(px);
  if (comp === 1 || comp === 2) { pixels = unRle(u8.subarray(px), w, h, comp === 1 ? 8 : 4, stride); notes.push(comp === 1 ? 'RLE8' : 'RLE4'); }
  const rowAt = (y: number) => (topDown ? y : h - 1 - y) * stride;
  const shiftOf = (m: number) => { if (!m) return [0, 0]; let s = 0; while (s < 32 && !((m >>> s) & 1)) s++; let b = 0; while (s + b < 32 && ((m >>> (s + b)) & 1)) b++; return [s, b]; }; // shift counts wrap at 32: a full mask must stop there
  const dmask = masks || (bpp === 16 ? [0x7c00, 0x3e0, 0x1f, 0] : [0xff0000, 0xff00, 0xff, bpp === 32 ? 0xff000000 : 0]);
  const sh = dmask.map(shiftOf);
  const scaleTo8 = (v: number, bits: number) => (bits >= 8 ? v >> (bits - 8) : bits ? Math.round((v * 255) / ((1 << bits) - 1)) : 0);
  let anyAlpha = false;
  for (let y = 0; y < h; y++) {
    const row = rowAt(y);
    if (row + stride > pixels.length && comp === 0) { warnings.push(`Pixel data is truncated at row ${y + 1}`); break; }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (bpp <= 8) {
        const bit = x * bpp;
        const byte = pixels[row + (bit >> 3)] ?? 0;
        const idx = bpp === 8 ? byte : (byte >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
        d[o] = palette[idx * 3]; d[o + 1] = palette[idx * 3 + 1]; d[o + 2] = palette[idx * 3 + 2]; d[o + 3] = 255;
      } else if (bpp === 24) {
        const i = row + x * 3;
        d[o] = pixels[i + 2]; d[o + 1] = pixels[i + 1]; d[o + 2] = pixels[i]; d[o + 3] = 255;
      } else {
        const i = row + x * (bpp / 8);
        const v = bpp === 16 ? pixels[i] | (pixels[i + 1] << 8) : (pixels[i] | (pixels[i + 1] << 8) | (pixels[i + 2] << 16) | (pixels[i + 3] << 24)) >>> 0;
        d[o] = scaleTo8((v & dmask[0]) >>> sh[0][0], sh[0][1]); d[o + 1] = scaleTo8((v & dmask[1]) >>> sh[1][0], sh[1][1]); d[o + 2] = scaleTo8((v & dmask[2]) >>> sh[2][0], sh[2][1]);
        if (dmask[3]) { d[o + 3] = scaleTo8((v & dmask[3]) >>> sh[3][0], sh[3][1]); if (d[o + 3] !== 255) anyAlpha = true; } else d[o + 3] = 255;
      }
    }
  }
  // 32-bit DIBs without an alpha mask often still carry alpha in the top byte (icons); a top byte that is zero in every
  // pixel means there is none (what the clipboard and most programs write), not a picture that is transparent throughout.
  if (bpp === 32 && dmask[3] && anyAlpha) {
    let allZero = true; for (let i = 3; i < d.length; i += 4) if (d[i]) { allZero = false; break; }
    if (allZero) { for (let i = 3; i < d.length; i += 4) d[i] = 255; anyAlpha = false; }
  }
  let hasAlpha = anyAlpha;
  if (icon && !(bpp === 32 && anyAlpha)) {
    const maskStride = Math.ceil(w / 32) * 4;
    const maskAt = px + stride * h;
    for (let y = 0; y < h; y++) {
      const row = maskAt + (h - 1 - y) * maskStride;
      for (let x = 0; x < w; x++) { const byte = u8[row + (x >> 3)]; if (byte === undefined) break; if ((byte >> (7 - (x & 7))) & 1) { d[(y * w + x) * 4 + 3] = 0; hasAlpha = true; } }
    }
  }
  const dpi: [number, number] | undefined = xppm > 0 && yppm > 0 ? [Math.round(xppm * 0.0254), Math.round(yppm * 0.0254)] : undefined;
  notes.unshift(`${bpp} bpp${masks ? ' (bit fields)' : ''}${topDown ? ', top-down' : ''}`);
  return { raster: out, bpp, palette: palCount, hasAlpha, dpi, notes, warnings };
}

function unRle(src: Uint8Array, w: number, h: number, bits: 4 | 8, stride: number): Uint8Array {
  const out = new Uint8Array(stride * h);
  let i = 0, x = 0, y = 0;
  const put = (v: number) => { if (x >= w || y >= h) return; if (bits === 8) out[y * stride + x] = v; else { const o = y * stride + (x >> 1); out[o] = x & 1 ? (out[o] & 0xf0) | (v & 15) : (out[o] & 0x0f) | ((v & 15) << 4); } x++; };
  while (i + 1 < src.length && y < h) {
    const n = src[i++], v = src[i++];
    if (n > 0) {
      for (let k = 0; k < n; k++) put(bits === 8 ? v : k & 1 ? v & 15 : v >> 4);
    } else if (v === 0) { x = 0; y++; }
    else if (v === 1) break;
    else if (v === 2) { x += src[i++]; y += src[i++]; }
    else {
      const count = v;
      const bytes = bits === 8 ? count : Math.ceil(count / 2);
      for (let k = 0; k < count; k++) { const b = src[i + (bits === 8 ? k : k >> 1)]; put(bits === 8 ? b : k & 1 ? b & 15 : b >> 4); }
      i += bytes + (bytes & 1);
    }
  }
  return out;
}

/** Writes a bottom-up BMP: 24-bit when the raster is opaque, 32-bit BGRA (BITMAPV4HEADER) otherwise. */
export function encodeBmp(r: Raster): Uint8Array {
  const { width: w, height: h, data } = r;
  let alpha = false;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { alpha = true; break; }
  const bpp = alpha ? 32 : 24;
  const hdr = alpha ? 108 : 40;
  const stride = Math.ceil((w * bpp) / 32) * 4;
  const out = new Uint8Array(14 + hdr + stride * h);
  const dv = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d;
  dv.setUint32(2, out.length, true); dv.setUint32(10, 14 + hdr, true);
  dv.setUint32(14, hdr, true); dv.setInt32(18, w, true); dv.setInt32(22, h, true); dv.setUint16(26, 1, true); dv.setUint16(28, bpp, true);
  dv.setUint32(30, alpha ? 3 : 0, true); dv.setUint32(34, stride * h, true); dv.setInt32(38, 2835, true); dv.setInt32(42, 2835, true);
  if (alpha) { dv.setUint32(54, 0x00ff0000, true); dv.setUint32(58, 0x0000ff00, true); dv.setUint32(62, 0x000000ff, true); dv.setUint32(66, 0xff000000, true); dv.setUint32(70, 0x73524742, true); }
  for (let y = 0; y < h; y++) {
    const row = 14 + hdr + (h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, o = row + x * (bpp / 8);
      out[o] = data[i + 2]; out[o + 1] = data[i + 1]; out[o + 2] = data[i];
      if (alpha) out[o + 3] = data[i + 3];
    }
  }
  return out;
}
