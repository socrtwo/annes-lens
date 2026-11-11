/**
 * Picture formats of Unix workstations, read by the app's own code from their published descriptions:
 * - Sun raster (.ras, .sun, .im1/.im8/.im24/.im32): 1, 8, 24 and 32 bits, the old, standard, byte-encoded
 *   (RLE) and RGB types, with or without a color map. 32-bit files keep their pad byte as transparency when it
 *   varies (ImageMagick writes the alpha there).
 * - SGI (.sgi, .rgb, .rgba, .bw, .int, .inta): verbatim or RLE, 8 or 16 bits per sample, gray, gray with
 *   alpha, RGB and RGBA.
 * - Utah Raster Toolkit RLE (.rle): its run and literal operations, any number of channels with alpha, color
 *   maps, the background color, and the picture's position (rows are stored bottom up).
 */
import { makeRaster, type DecodeResult } from './raster';

const be16 = (u: Uint8Array, o: number) => (u[o] << 8) | u[o + 1];
const be32 = (u: Uint8Array, o: number) => ((u[o] << 24) | (u[o + 1] << 16) | (u[o + 2] << 8) | u[o + 3]) >>> 0;
const le16 = (u: Uint8Array, o: number) => u[o] | (u[o + 1] << 8);
const MAX_PIXELS = 200e6;
const page = (r: ReturnType<typeof makeRaster>, bitDepth: number, hasAlpha: boolean, notes: string[], paletteSize?: number) =>
  ({ width: r.width, height: r.height, frames: [{ raster: r, delay: 0 }], loops: 0, bitDepth, hasAlpha, notes, paletteSize });
function size(w: number, h: number, what: string) {
  if (!(w > 0 && h > 0) || w * h > MAX_PIXELS) throw new Error(`This ${what} file has an impossible size (${w} × ${h})`);
}

// Sun raster -----------------------------------------------------------------------------------------
export const isSunRaster = (u8: Uint8Array): boolean => u8.length >= 32 && be32(u8, 0) === 0x59a66a95;
const SUN_TYPES: Record<number, string> = { 0: 'old', 1: 'standard', 2: 'byte-encoded (RLE)', 3: 'RGB', 4: 'TIFF', 5: 'IFF', 0xffff: 'experimental' };
export function decodeSun(u8: Uint8Array): DecodeResult {
  const w = be32(u8, 4), h = be32(u8, 8), depth = be32(u8, 12), type = be32(u8, 20), mapType = be32(u8, 24), mapLen = be32(u8, 28);
  size(w, h, 'Sun raster');
  if (![1, 8, 24, 32].includes(depth)) throw new Error(`Sun raster files with ${depth} bits per pixel are not supported`);
  if (type === 4 || type === 5 || type === 0xffff) throw new Error(`Sun raster files of the ${SUN_TYPES[type]} type are not supported`);
  const warnings: string[] = [];
  let p = 32;
  let map: Uint8Array | null = null, mapN = 0;
  if (mapType === 1 && mapLen) { mapN = Math.floor(mapLen / 3); map = u8.subarray(p, p + mapN * 3); }
  else if (mapType === 2 && mapLen) warnings.push('The raw color map is not used');
  p += mapLen;
  const rowBytes = (((w * depth + 15) >> 4) << 1), need = rowBytes * h;
  let data = u8.subarray(p);
  if (type === 2) { // 0x80 escape: 0x80 0 = a literal 0x80, 0x80 n v = n + 1 copies of v
    const o = new Uint8Array(need); let i = p, k = 0;
    while (k < need && i < u8.length) {
      const b = u8[i++];
      if (b !== 0x80) o[k++] = b;
      else { const n = u8[i++] ?? 0; if (n === 0) o[k++] = 0x80; else { const v = u8[i++] ?? 0; o.fill(v, k, Math.min(need, k + n + 1)); k += n + 1; } }
    }
    data = o;
  }
  if (data.length < need) warnings.push(`The picture data is cut short (${data.length} of ${need} bytes)`);
  const r = makeRaster(w, h), d = r.data, rgbOrder = type === 3;
  let alpha = false;
  if (depth === 32) { // pad (or alpha) byte first; transparency only when it varies
    const first = data[0]; for (let y = 0; y < h && !alpha; y++) for (let x = 0; x < w; x++) { if (data[y * rowBytes + x * 4] !== first) { alpha = true; break; } }
  }
  for (let y = 0; y < h; y++) {
    const row = y * rowBytes;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let R = 0, G = 0, B = 0, A = 255;
      if (depth === 1) {
        const bit = (data[row + (x >> 3)] >> (7 - (x & 7))) & 1;
        if (map && mapN >= 2) { R = map[bit]; G = map[mapN + bit]; B = map[2 * mapN + bit]; } else R = G = B = bit ? 0 : 255;
      } else if (depth === 8) {
        const v = data[row + x] ?? 0;
        if (map && mapN) { const i = Math.min(v, mapN - 1); R = map[i]; G = map[mapN + i]; B = map[2 * mapN + i]; } else R = G = B = v;
      } else {
        const q = row + x * (depth >> 3) + (depth === 32 ? 1 : 0);
        if (depth === 32 && alpha) A = data[q - 1] ?? 255;
        const a = data[q] ?? 0, b = data[q + 1] ?? 0, c = data[q + 2] ?? 0;
        if (rgbOrder) { R = a; G = b; B = c; } else { R = c; G = b; B = a; }
        if (map && mapN) { R = map[Math.min(R, mapN - 1)]; G = map[mapN + Math.min(G, mapN - 1)]; B = map[2 * mapN + Math.min(B, mapN - 1)]; }
      }
      d[o] = R; d[o + 1] = G; d[o + 2] = B; d[o + 3] = A;
    }
  }
  const notes = [`Sun raster, ${SUN_TYPES[type] ?? `type ${type}`}, ${depth} bit${depth === 1 ? '' : 's'}${map ? `, ${mapN}-color map` : ''}${depth === 32 ? (alpha ? ', transparency in the pad byte' : '') : ''}`];
  return { pages: [page(r, depth, alpha, notes, depth <= 8 && map ? mapN : undefined)], info: {}, warnings };
}

// SGI ------------------------------------------------------------------------------------------------
export const isSgi = (u8: Uint8Array): boolean => u8.length >= 512 && be16(u8, 0) === 474 && u8[2] <= 1 && (u8[3] === 1 || u8[3] === 2) && be16(u8, 4) >= 1 && be16(u8, 4) <= 3;
export function decodeSgi(u8: Uint8Array): DecodeResult {
  const rle = u8[2] === 1, bpc = u8[3], dim = be16(u8, 4);
  const w = be16(u8, 6), h = dim === 1 ? 1 : be16(u8, 8), z = dim < 3 ? 1 : be16(u8, 10);
  const colormap = be32(u8, 104);
  size(w, h, 'SGI');
  if (z < 1) throw new Error('This SGI file has no channels');
  if (colormap !== 0) throw new Error('SGI color-map and screen files are not supported');
  const name = new TextDecoder('latin1').decode(u8.subarray(24, 104)).replace(/\0.*$/s, '').trim();
  const warnings: string[] = [];
  const chans = Math.min(z, 4), planes: Uint16Array[] = [];
  const rd = (o: number) => (bpc === 2 ? be16(u8, o) : u8[o]);
  for (let c = 0; c < chans; c++) planes.push(new Uint16Array(w * h));
  let short = false;
  for (let c = 0; c < chans; c++) {
    const pl = planes[c];
    for (let y = 0; y < h; y++) {
      const out = (h - 1 - y) * w; // bottom row first
      if (!rle) {
        const base = 512 + ((c * h + y) * w) * bpc;
        if (base + w * bpc > u8.length) { short = true; continue; }
        for (let x = 0; x < w; x++) pl[out + x] = rd(base + x * bpc);
        continue;
      }
      const ti = 512 + (c * h + y) * 4;
      if (ti + 4 > u8.length) { short = true; continue; }
      let p = be32(u8, ti), x = 0;
      while (x < w && p + bpc <= u8.length) {
        const cnt = rd(p); p += bpc;
        const n = cnt & 0x7f; if (!n) break;
        if (cnt & 0x80) { for (let i = 0; i < n && x < w; i++, p += bpc) pl[out + x++] = rd(p); }
        else { const v = rd(p); p += bpc; for (let i = 0; i < n && x < w; i++) pl[out + x++] = v; }
      }
      if (x < w) short = true;
    }
  }
  if (short) warnings.push('The picture data is cut short');
  const r = makeRaster(w, h), d = r.data, s = bpc === 2 ? 8 : 0;
  for (let i = 0; i < w * h; i++) {
    const o = i * 4, v = (k: number) => planes[k][i] >> s;
    if (chans <= 2) { d[o] = d[o + 1] = d[o + 2] = v(0); d[o + 3] = chans === 2 ? v(1) : 255; }
    else { d[o] = v(0); d[o + 1] = v(1); d[o + 2] = v(2); d[o + 3] = chans === 4 ? v(3) : 255; }
  }
  const kind = ['', 'gray', 'gray with alpha', 'RGB', 'RGBA'][chans];
  const notes = [`SGI image, ${rle ? 'RLE' : 'verbatim'}, ${kind}, ${bpc * 8} bits per sample${name ? `, "${name}"` : ''}`];
  return { pages: [page(r, chans * bpc * 8, chans === 2 || chans === 4, notes)], info: name ? { name } : {}, warnings };
}

// Utah RLE -------------------------------------------------------------------------------------------
export const isUtahRle = (u8: Uint8Array): boolean => u8.length >= 16 && u8[0] === 0x52 && u8[1] === 0xcc && u8[12] === 8;
export function decodeUtahRle(u8: Uint8Array): DecodeResult {
  const xpos = (le16(u8, 2) << 16) >> 16, ypos = (le16(u8, 4) << 16) >> 16, w = le16(u8, 6), h = le16(u8, 8);
  const flags = u8[10], ncolors = u8[11], ncmap = u8[13], cmapLen = 1 << u8[14];
  size(w, h, 'Utah RLE');
  if (u8[14] > 16 || 15 + ncmap * cmapLen * 2 > u8.length) throw new Error('This Utah RLE file has a color map larger than the file itself');
  const hasAlpha = !!(flags & 4), noBg = !!(flags & 2), warnings: string[] = [];
  let p = 15;
  const bg: number[] = [];
  if (!noBg) { for (let i = 0; i < ncolors; i++) bg.push(u8[p + i]); p += ncolors | 1; } else p += 1;
  const cmap: number[] = [];
  if (ncmap) { for (let i = 0; i < ncmap * cmapLen; i++) cmap.push(le16(u8, p + i * 2) >> 8); p += ncmap * cmapLen * 2; }
  const comments: string[] = [];
  if (flags & 8) {
    const n = le16(u8, p); p += 2;
    comments.push(...new TextDecoder('latin1').decode(u8.subarray(p, p + n)).split('\0').filter(Boolean));
    p += n + (n & 1);
  }
  const chans = Math.max(1, ncolors);
  const planes: Uint8Array[] = [];
  for (let c = 0; c < chans; c++) planes.push(new Uint8Array(w * h).fill(bg[c] ?? 0));
  const alphaPlane = new Uint8Array(w * h).fill(hasAlpha ? 0 : 255);
  let y = 0, x = 0, ch = 0;
  const put = (v: number) => {
    const px = x - xpos, row = h - 1 - y;
    if (px >= 0 && px < w && row >= 0 && row < h) { if (ch === 255) alphaPlane[row * w + px] = v; else if (ch < chans) planes[ch][row * w + px] = v; }
    x++;
  };
  ops: while (p + 2 <= u8.length) {
    const op = u8[p] & 0x3f, long = !!(u8[p] & 0x40);
    let datum = u8[p + 1]; p += 2;
    if (long) { datum = le16(u8, p); p += 2; }
    switch (op) {
      case 1: y += datum; x = xpos; break; // skip lines
      case 2: ch = datum; x = xpos; break; // set color
      case 3: x += datum; break; // skip pixels
      case 5: { const n = datum + 1; for (let i = 0; i < n; i++) put(u8[p + i] ?? 0); p += n + (n & 1); break; } // byte data
      case 6: { const n = datum + 1, v = u8[p] ?? 0; p += 2; for (let i = 0; i < n; i++) put(v); break; } // run data
      case 7: break ops;
      default: warnings.push(`Unknown Utah RLE operation ${op}; the rest is not read`); break ops;
    }
  }
  const r = makeRaster(w, h), d = r.data;
  const look = (c: number, v: number) => (ncmap ? (cmap[Math.min(c, ncmap - 1) * cmapLen + v] ?? v) : v);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (chans >= 3) { d[o] = look(0, planes[0][i]); d[o + 1] = look(1, planes[1][i]); d[o + 2] = look(2, planes[2][i]); }
    else if (ncmap >= 3) { const v = planes[0][i]; d[o] = cmap[v] ?? v; d[o + 1] = cmap[cmapLen + v] ?? v; d[o + 2] = cmap[2 * cmapLen + v] ?? v; }
    else d[o] = d[o + 1] = d[o + 2] = look(0, planes[0][i]);
    d[o + 3] = alphaPlane[i];
  }
  const notes = [`Utah RLE, ${chans} channel${chans === 1 ? '' : 's'}${hasAlpha ? ' and alpha' : ''}${ncmap ? `, ${ncmap}-channel color map of ${cmapLen}` : ''}${xpos || ypos ? `, placed at ${xpos}, ${ypos}` : ''}`];
  const info: Record<string, string> = {};
  if (comments.length) info.comments = comments.join('; ');
  return { pages: [page(r, chans * 8 + (hasAlpha ? 8 : 0), hasAlpha, notes)], info, warnings };
}
