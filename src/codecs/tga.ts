/**
 * Truevision TGA (Targa): color-mapped, true-color and grayscale pictures, uncompressed or run-length
 * encoded, 8/15/16/24/32 bits, either row order and either column order, with the version 2 footer and
 * its extension area (author, comments, date) when present. Also a 24/32-bit writer.
 */
import { makeRaster, type DecodeResult, type Raster } from './raster';

const FOOTER = 'TRUEVISION-XFILE.\0';

/** TGA has no magic number at the start; the v2 footer is certain, otherwise the header must be plausible. */
export function isTga(u8: Uint8Array, name = ''): boolean {
  if (u8.length < 18) return false;
  if (u8.length >= 26 && footerAt(u8)) return true;
  const type = u8[2], cmap = u8[1], depth = u8[16];
  const w = u8[12] | (u8[13] << 8), h = u8[14] | (u8[15] << 8);
  const plausible = (cmap === 0 || cmap === 1) && [1, 2, 3, 9, 10, 11].includes(type) && [8, 15, 16, 24, 32].includes(depth) && w > 0 && h > 0 && (u8[17] & 0xc0) === 0;
  if (!plausible) return false;
  if (type === 1 || type === 9) return cmap === 1 && depth === 8 && [15, 16, 24, 32].includes(u8[7]);
  if (type === 3 || type === 11) return depth === 8 || depth === 16;
  if (/\.(tga|tpic|icb|vda|vst)$/i.test(name)) return true;
  // Uncompressed true color: the data length must fit.
  if (type === 2) { const need = 18 + u8[0] + (cmap ? (u8[5] | (u8[6] << 8)) * Math.ceil(u8[7] / 8) : 0) + w * h * Math.ceil(depth / 8); return u8.length >= need && u8.length <= need + 2048; }
  return depth >= 15;
}

function footerAt(u8: Uint8Array): boolean {
  const o = u8.length - 18;
  for (let i = 0; i < FOOTER.length; i++) if (u8[o + i] !== FOOTER.charCodeAt(i)) return false;
  return true;
}

export function decodeTga(u8: Uint8Array): DecodeResult {
  if (u8.length < 18) throw new Error('Not a TGA file');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const idLen = u8[0], cmapType = u8[1], type = u8[2];
  const cmapFirst = dv.getUint16(3, true), cmapLen = dv.getUint16(5, true), cmapBits = u8[7];
  const w = dv.getUint16(12, true), h = dv.getUint16(14, true), depth = u8[16], desc = u8[17];
  const alphaBits = desc & 15, rightToLeft = !!(desc & 16), topDown = !!(desc & 32);
  const rle = type >= 9;
  const base = type & 7; // 1 color-mapped, 2 true color, 3 grayscale
  if (![1, 2, 3].includes(base) || !w || !h || w * h > 80_000_000) throw new Error('Unsupported or damaged TGA header');
  const warnings: string[] = [];
  const notes: string[] = [];
  let p = 18 + idLen;
  const imageId = idLen ? new TextDecoder('latin1').decode(u8.subarray(18, 18 + idLen)).replace(/\0+$/, '') : '';
  // Color map (present even for true-color files sometimes: skip it then).
  const cmapBytes = Math.ceil(cmapBits / 8);
  let palette: Uint8Array | null = null;
  if (cmapType === 1 && cmapLen) {
    palette = new Uint8Array(cmapLen * 4);
    for (let i = 0; i < cmapLen; i++) { const o = p + i * cmapBytes; const px = readPixel(u8, o, cmapBits, 0); palette[i * 4] = px[0]; palette[i * 4 + 1] = px[1]; palette[i * 4 + 2] = px[2]; palette[i * 4 + 3] = px[3]; }
    p += cmapLen * cmapBytes;
  }
  const bpp = Math.ceil(depth / 8);
  const out = makeRaster(w, h);
  const d = out.data;
  const total = w * h;
  let i = 0;
  let truncated = false;
  const put = (n: number, px: [number, number, number, number]) => {
    const y = Math.floor(n / w), x = n % w;
    const yy = topDown ? y : h - 1 - y, xx = rightToLeft ? w - 1 - x : x;
    const o = (yy * w + xx) * 4;
    d[o] = px[0]; d[o + 1] = px[1]; d[o + 2] = px[2]; d[o + 3] = px[3];
  };
  const pixelAt = (o: number): [number, number, number, number] => {
    if (base === 1) { const idx = (depth === 16 ? u8[o] | (u8[o + 1] << 8) : u8[o]) - cmapFirst; if (palette && idx >= 0 && idx < cmapLen) return [palette[idx * 4], palette[idx * 4 + 1], palette[idx * 4 + 2], palette[idx * 4 + 3]]; return [0, 0, 0, 255]; }
    if (base === 3) { const g = u8[o]; return [g, g, g, depth === 16 ? u8[o + 1] : 255]; }
    return readPixel(u8, o, depth, alphaBits);
  };
  if (!rle) {
    for (; i < total; i++) { const o = p + i * bpp; if (o + bpp > u8.length) { truncated = true; break; } put(i, pixelAt(o)); }
  } else {
    while (i < total && p < u8.length) {
      const head = u8[p++];
      const count = (head & 127) + 1;
      if (head & 128) {
        if (p + bpp > u8.length) { truncated = true; break; }
        const px = pixelAt(p); p += bpp;
        for (let k = 0; k < count && i < total; k++) put(i++, px);
      } else {
        for (let k = 0; k < count && i < total; k++) { if (p + bpp > u8.length) { truncated = true; break; } put(i++, pixelAt(p)); p += bpp; }
        if (truncated) break;
      }
    }
    if (i < total && !truncated) truncated = true;
  }
  if (truncated) { warnings.push(`Pixel data is truncated: ${i.toLocaleString()} of ${total.toLocaleString()} pixels read; the rest is left black`); for (let k = i; k < total; k++) put(k, [0, 0, 0, 255]); }
  let hasAlpha = false;
  // 32-bit files carry alpha whether or not the descriptor counts its bits (many writers leave them 0).
  const alphaUsed = base === 2 ? depth === 32 || (depth === 16 && alphaBits > 0) : base === 3 ? depth === 16 : !!palette && cmapBits === 32;
  // A 32-bit file whose alpha channel is zero in every pixel is meant to be opaque (the writer left the channel
  // unused); alpha counts only when some pixel has any and some pixel is not fully opaque.
  if (alphaUsed) { let some = false, notOpaque = false; for (let k = 3; k < d.length; k += 4) { if (d[k]) some = true; if (d[k] !== 255) notOpaque = true; if (some && notOpaque) break; } hasAlpha = some && notOpaque; }
  if (!hasAlpha) for (let k = 3; k < d.length; k += 4) d[k] = 255;
  notes.push(`${base === 1 ? 'color-mapped' : base === 3 ? 'grayscale' : 'true color'} ${depth}-bit${rle ? ', RLE' : ''}${topDown ? ', top-down' : ''}${rightToLeft ? ', right-to-left' : ''}`);
  const info: Record<string, string> = {};
  if (imageId) info['Image ID'] = imageId;
  // Version 2 footer: extension area.
  if (u8.length >= 26 && footerAt(u8)) {
    notes.push('TGA 2.0');
    const extAt = dv.getUint32(u8.length - 26, true);
    if (extAt && extAt + 495 <= u8.length && dv.getUint16(extAt, true) >= 495) {
      const str = (o: number, n: number) => new TextDecoder('latin1').decode(u8.subarray(extAt + o, extAt + o + n)).replace(/\0.*$/s, '').trim();
      const author = str(2, 41), comments = [str(43, 81), str(124, 81), str(205, 81), str(286, 81)].filter(Boolean).join(' ');
      const month = dv.getUint16(extAt + 367, true), day = dv.getUint16(extAt + 369, true), year = dv.getUint16(extAt + 371, true);
      const job = str(379, 41), software = str(426, 41);
      const attr = u8[extAt + 494];
      if (author) info.Author = author;
      if (comments) info.Comments = comments;
      if (year) info.Date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (job) info['Job name'] = job;
      if (software) info.Software = software;
      if (attr === 4) { notes.push('premultiplied alpha'); for (let k = 0; k < d.length; k += 4) { const a = d[k + 3]; if (a && a < 255) { d[k] = Math.min(255, Math.round((d[k] * 255) / a)); d[k + 1] = Math.min(255, Math.round((d[k + 1] * 255) / a)); d[k + 2] = Math.min(255, Math.round((d[k + 2] * 255) / a)); } } }
    }
  }
  return { pages: [{ width: w, height: h, frames: [{ raster: out, delay: 0 }], loops: 0, bitDepth: depth, paletteSize: palette ? cmapLen : undefined, hasAlpha, notes }], info, warnings };
}

function readPixel(u8: Uint8Array, o: number, bits: number, alphaBits: number): [number, number, number, number] {
  if (bits === 24) return [u8[o + 2], u8[o + 1], u8[o], 255];
  if (bits === 32) return [u8[o + 2], u8[o + 1], u8[o], u8[o + 3]];
  if (bits === 15 || bits === 16) {
    const v = u8[o] | (u8[o + 1] << 8);
    const r = (v >> 10) & 31, g = (v >> 5) & 31, b = v & 31;
    const a = bits === 16 && alphaBits ? (v & 0x8000 ? 255 : 0) : 255;
    return [(r << 3) | (r >> 2), (g << 3) | (g >> 2), (b << 3) | (b >> 2), a];
  }
  const g = u8[o];
  return [g, g, g, 255];
}

/** Writes an uncompressed true-color TGA (24-bit when opaque, 32-bit with 8 alpha bits otherwise), top-down, with the 2.0 footer. */
export function encodeTga(r: Raster, opts: { rle?: boolean } = {}): Uint8Array {
  const { width: w, height: h, data } = r;
  let alpha = false;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { alpha = true; break; }
  const bpp = alpha ? 4 : 3;
  const body: number[] = [];
  const px = (i: number) => (alpha ? [data[i + 2], data[i + 1], data[i], data[i + 3]] : [data[i + 2], data[i + 1], data[i]]);
  if (opts.rle) {
    for (let y = 0; y < h; y++) {
      let x = 0;
      while (x < w) {
        const i0 = (y * w + x) * 4;
        let run = 1;
        while (x + run < w && run < 128 && same(data, i0, i0 + run * 4)) run++;
        if (run > 1) { body.push(0x80 | (run - 1), ...px(i0)); x += run; continue; }
        let lit = 1;
        while (x + lit < w && lit < 128 && !(x + lit + 1 < w && same(data, i0 + lit * 4, i0 + (lit + 1) * 4))) lit++;
        body.push(lit - 1);
        for (let k = 0; k < lit; k++) body.push(...px(i0 + k * 4));
        x += lit;
      }
    }
  } else {
    for (let i = 0; i < data.length; i += 4) body.push(...px(i));
  }
  const out = new Uint8Array(18 + body.length + 26);
  out[2] = opts.rle ? 10 : 2;
  out[12] = w & 255; out[13] = w >> 8; out[14] = h & 255; out[15] = h >> 8;
  out[16] = bpp * 8; out[17] = 0x20 | (alpha ? 8 : 0);
  out.set(body, 18);
  for (let i = 0; i < FOOTER.length; i++) out[18 + body.length + 8 + i] = FOOTER.charCodeAt(i);
  return out;
}

const same = (d: Uint8ClampedArray, a: number, b: number) => d[a] === d[b] && d[a + 1] === d[b + 1] && d[a + 2] === d[b + 2] && d[a + 3] === d[b + 3];
