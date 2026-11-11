/**
 * GIF decoder (GIF87a and GIF89a): every frame with its delay, disposal and transparency composed onto the
 * logical screen, plus the loop count from the NETSCAPE2.0 extension. Tolerant: a truncated file yields
 * the frames that were complete and a warning.
 */
import { makeRaster, type DecodeResult, type Raster } from './raster';
import { framesWithin } from './limits';

export function isGif(u8: Uint8Array): boolean {
  return u8.length > 6 && u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x38 && (u8[4] === 0x37 || u8[4] === 0x39) && u8[5] === 0x61;
}

interface GifFrame { raster: Raster; delay: number }

export function decodeGif(u8: Uint8Array): DecodeResult {
  if (!isGif(u8)) throw new Error('Not a GIF file');
  const warnings: string[] = [];
  const info: Record<string, string> = { version: String.fromCharCode(...u8.subarray(3, 6)) };
  const w = u8[6] | (u8[7] << 8), h = u8[8] | (u8[9] << 8);
  const packed = u8[10];
  const bgIndex = u8[11];
  let p = 13;
  let gct: Uint8Array | null = null;
  const gctSize = packed & 0x80 ? 1 << ((packed & 7) + 1) : 0;
  if (gctSize) { gct = u8.subarray(p, p + gctSize * 3); p += gctSize * 3; }
  info.colors = gctSize ? `${gctSize} (global palette)` : 'local palettes';
  const frames: GifFrame[] = [], maxFrames = framesWithin(w, h);
  let loops = 1;
  let loopSeen = false;
  const comments: string[] = [];
  // Canvas state
  let canvas = makeRaster(w, h);
  let prev: Uint8ClampedArray<ArrayBuffer> | null = null;
  let delay = 100, disposal = 0, transparent = -1;
  const subBlocks = (): Uint8Array[] => {
    const parts: Uint8Array[] = [];
    while (p < u8.length) {
      const n = u8[p++];
      if (n === 0) break;
      parts.push(u8.subarray(p, p + n));
      p += n;
    }
    return parts;
  };
  const concat = (parts: Uint8Array[]): Uint8Array => { let n = 0; for (const x of parts) n += x.length; const out = new Uint8Array(n); let o = 0; for (const x of parts) { out.set(x, o); o += x.length; } return out; };
  try {
    while (p < u8.length) {
      const b = u8[p++];
      if (b === 0x3b) break; // trailer
      if (b === 0x21) { // extension
        const label = u8[p++];
        if (label === 0xf9) { // graphic control
          const n = u8[p++];
          const flags = u8[p];
          disposal = (flags >> 2) & 7;
          delay = (u8[p + 1] | (u8[p + 2] << 8)) * 10;
          transparent = flags & 1 ? u8[p + 3] : -1;
          p += n;
          if (u8[p] === 0) p++;
        } else if (label === 0xff) {
          const parts = subBlocks();
          const app = parts[0] ? String.fromCharCode(...parts[0].subarray(0, 11)) : '';
          if ((app === 'NETSCAPE2.0' || app === 'ANIMEXTS1.0') && parts[1] && parts[1][0] === 1) { loops = parts[1][1] | (parts[1][2] << 8); loopSeen = true; }
          else if (app.startsWith('XMP Data')) info.xmp = 'yes';
        } else if (label === 0xfe) {
          comments.push(new TextDecoder('latin1').decode(concat(subBlocks())));
        } else {
          subBlocks();
        }
        continue;
      }
      if (b !== 0x2c) { warnings.push(`Unexpected block 0x${b.toString(16)} at ${p - 1}; stopped reading`); break; }
      // Every frame is kept as a whole picture: no more of them than the budget holds.
      if (frames.length >= maxFrames) { warnings.push(`Only the first ${maxFrames} frames are shown: together the frames are larger than is kept in memory at once`); break; }
      // Image descriptor
      const ix = u8[p] | (u8[p + 1] << 8), iy = u8[p + 2] | (u8[p + 3] << 8);
      const iw = u8[p + 4] | (u8[p + 5] << 8), ih = u8[p + 6] | (u8[p + 7] << 8);
      const ipacked = u8[p + 8];
      p += 9;
      let ct = gct;
      if (ipacked & 0x80) { const n = 1 << ((ipacked & 7) + 1); ct = u8.subarray(p, p + n * 3); p += n * 3; }
      const interlaced = !!(ipacked & 0x40);
      const minCode = u8[p++];
      const data = concat(subBlocks());
      if (!ct) { warnings.push('Frame without a palette skipped'); continue; }
      // A file cut off before the frame's data still shows what came before it (and says so); a code size that is there but out of range is a damaged file.
      const indexes = minCode === undefined ? new Uint8Array(0) : lzwDecode(data, minCode, iw * ih);
      if (indexes.length < iw * ih) warnings.push(`Frame ${frames.length + 1} is truncated`);
      // Compose
      if (disposal === 3) prev = canvas.data.slice() as Uint8ClampedArray<ArrayBuffer>;
      const out = canvas.data;
      for (let srcRow = 0; srcRow < ih; srcRow++) {
        // Interlaced data comes in four passes (every 8th row from 0, from 4, every 4th from 2, every 2nd from 1): data row → picture row.
        const y = iy + (interlaced ? deinterlace(srcRow, ih) : srcRow);
        if (y >= h) { if (interlaced) continue; break; }
        for (let x = 0; x < iw; x++) {
          const xx = ix + x;
          if (xx >= w) break;
          const si = srcRow * iw + x;
          if (si >= indexes.length) break;
          const idx = indexes[si];
          if (idx === transparent) continue;
          const o = (y * w + xx) * 4;
          out[o] = ct[idx * 3]; out[o + 1] = ct[idx * 3 + 1]; out[o + 2] = ct[idx * 3 + 2]; out[o + 3] = 255;
        }
      }
      frames.push({ raster: { width: w, height: h, data: canvas.data.slice() as Uint8ClampedArray<ArrayBuffer> }, delay: delay <= 10 ? 100 : delay });
      // Dispose for the next frame
      if (disposal === 2) {
        for (let y = iy; y < Math.min(h, iy + ih); y++) for (let x = ix; x < Math.min(w, ix + iw); x++) { const o = (y * w + x) * 4; out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; }
      } else if (disposal === 3 && prev) {
        canvas = { width: w, height: h, data: prev };
      }
      delay = 100; disposal = 0; transparent = -1;
    }
  } catch (e: any) {
    warnings.push(`Stopped reading: ${e?.message || e}`);
  }
  if (!frames.length) throw new Error('The GIF has no complete frame');
  if (frames.length === 1) frames[0].delay = 0;
  if (comments.length) info.comment = comments.join('\n');
  info.background = String(bgIndex);
  const hasAlpha = frames.some((f) => { const d = f.raster.data; for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return true; return false; });
  return {
    pages: [{ width: w, height: h, frames, loops: loopSeen ? loops : frames.length > 1 ? 1 : 0, bitDepth: 8, paletteSize: gctSize || undefined, hasAlpha, notes: [frames.length > 1 ? `${frames.length} frames` : 'single frame', 'LZW'] }],
    info, warnings,
  };
}

function deinterlace(row: number, h: number): number {
  const p1 = Math.ceil(h / 8), p2 = Math.ceil((h - 4) / 8), p3 = Math.ceil((h - 2) / 4);
  if (row < p1) return row * 8;
  if (row < p1 + p2) return (row - p1) * 8 + 4;
  if (row < p1 + p2 + p3) return (row - p1 - p2) * 4 + 2;
  return (row - p1 - p2 - p3) * 2 + 1;
}

/** GIF-flavored LZW (little-endian bit packing, clear and end codes). Returns the indexes decoded. */
export function lzwDecode(src: Uint8Array, minCode: number, want: number): Uint8Array {
  if (!(minCode >= 1 && minCode <= 11)) throw new Error(`Bad LZW code size ${minCode}`); // the table holds 4096 codes; anything else is a damaged or crafted file
  const out = new Uint8Array(want);
  let o = 0;
  const clear = 1 << minCode, end = clear + 1;
  let size = minCode + 1, next = end + 1;
  const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), lengths = new Uint16Array(4096);
  for (let i = 0; i < clear; i++) { prefix[i] = -1; suffix[i] = i; lengths[i] = 1; }
  let bits = 0, acc = 0, i = 0;
  let prev = -1;
  const stack = new Uint8Array(4097);
  while (o < want) {
    while (bits < size && i < src.length) { acc |= src[i++] << bits; bits += 8; }
    if (bits < size) break;
    const code = acc & ((1 << size) - 1);
    acc >>>= size; bits -= size;
    if (code === clear) { size = minCode + 1; next = end + 1; prev = -1; continue; }
    if (code === end) break;
    let entry = code;
    let first: number;
    if (code < next) {
      first = firstOf(code, prefix, suffix);
    } else if (code === next && prev >= 0) {
      first = firstOf(prev, prefix, suffix);
    } else break; // corrupt
    // Emit the string for `entry` (or prev + first when code === next)
    let n = 0;
    if (code === next) { stack[n++] = first; entry = prev; }
    while (entry >= 0) { stack[n++] = suffix[entry]; entry = prefix[entry]; }
    for (let k = n - 1; k >= 0 && o < want; k--) out[o++] = stack[k];
    if (prev >= 0 && next < 4096) { prefix[next] = prev; suffix[next] = first; lengths[next] = lengths[prev] + 1; next++; if (next === 1 << size && size < 12) size++; }
    prev = code;
  }
  return o < want ? out.subarray(0, o) : out;
}

function firstOf(code: number, prefix: Int32Array, suffix: Uint8Array): number {
  while (prefix[code] >= 0) code = prefix[code];
  return suffix[code];
}
