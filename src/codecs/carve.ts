/**
 * Carving pictures out of any file: JPEG, PNG, GIF, WebP, BMP and TIFF signatures found anywhere in
 * the bytes (disk images, caches, documents, damaged archives), each cut at its own end marker or
 * declared size; TIFF runs to the next signature or the end of the file.
 */
import { findEmbeddedJpegs } from './rawpreview';

export interface Carved { offset: number; length: number; format: 'jpeg' | 'png' | 'gif' | 'webp' | 'bmp' | 'tiff'; width?: number; height?: number }

const be32 = (u8: Uint8Array, o: number) => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
const le32 = (u8: Uint8Array, o: number) => (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0;
const le16 = (u8: Uint8Array, o: number) => u8[o] | (u8[o + 1] << 8);

function pngAt(u8: Uint8Array, i: number): Carved | null {
  if (!(u8[i] === 0x89 && u8[i + 1] === 0x50 && u8[i + 2] === 0x4e && u8[i + 3] === 0x47 && u8[i + 4] === 0x0d && u8[i + 5] === 0x0a && u8[i + 6] === 0x1a && u8[i + 7] === 0x0a)) return null;
  let p = i + 8, width = 0, height = 0;
  while (p + 12 <= u8.length) {
    const len = be32(u8, p); const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
    if (!/^[A-Za-z]{4}$/.test(type) || len > 1 << 30) return null;
    if (type === 'IHDR') { width = be32(u8, p + 8); height = be32(u8, p + 12); }
    p += 12 + len;
    if (type === 'IEND') return width ? { offset: i, length: p - i, format: 'png', width, height } : null;
  }
  return null;
}
function gifAt(u8: Uint8Array, i: number): Carved | null {
  if (!(u8[i] === 0x47 && u8[i + 1] === 0x49 && u8[i + 2] === 0x46 && u8[i + 3] === 0x38 && (u8[i + 4] === 0x37 || u8[i + 4] === 0x39) && u8[i + 5] === 0x61)) return null;
  const width = le16(u8, i + 6), height = le16(u8, i + 8); let p = i + 13;
  if (u8[i + 10] & 0x80) p += 3 << ((u8[i + 10] & 7) + 1);
  const skipBlocks = () => { while (p < u8.length) { const n = u8[p++]; if (!n) return true; p += n; } return false; };
  for (let guard = 0; guard < 100000 && p < u8.length; guard++) {
    const b = u8[p];
    if (b === 0x3b) return width ? { offset: i, length: p + 1 - i, format: 'gif', width, height } : null;
    if (b === 0x21) { p += 2; if (!skipBlocks()) return null; }
    else if (b === 0x2c) { const flags = u8[p + 9]; p += 10; if (flags & 0x80) p += 3 << ((flags & 7) + 1); p++; if (!skipBlocks()) return null; }
    else return null;
  }
  return null;
}
function webpAt(u8: Uint8Array, i: number): Carved | null {
  if (!(u8[i] === 0x52 && u8[i + 1] === 0x49 && u8[i + 2] === 0x46 && u8[i + 3] === 0x46 && u8[i + 8] === 0x57 && u8[i + 9] === 0x45 && u8[i + 10] === 0x42 && u8[i + 11] === 0x50)) return null;
  const size = le32(u8, i + 4) + 8; if (size < 20 || i + size > u8.length) return null;
  return { offset: i, length: size, format: 'webp' };
}
function bmpAt(u8: Uint8Array, i: number): Carved | null {
  if (!(u8[i] === 0x42 && u8[i + 1] === 0x4d)) return null;
  const size = le32(u8, i + 2), dib = le32(u8, i + 14);
  if (size < 26 || i + size > u8.length || ![12, 40, 52, 56, 108, 124].includes(dib)) return null;
  return { offset: i, length: size, format: 'bmp', width: dib === 12 ? le16(u8, i + 18) : le32(u8, i + 18), height: Math.abs(dib === 12 ? le16(u8, i + 20) : le32(u8, i + 22) | 0) };
}
const tiffAt = (u8: Uint8Array, i: number): boolean => (u8[i] === 0x49 && u8[i + 1] === 0x49 && u8[i + 2] === 42 && u8[i + 3] === 0) || (u8[i] === 0x4d && u8[i + 1] === 0x4d && u8[i + 2] === 0 && u8[i + 3] === 42);
const isSig = (u8: Uint8Array, i: number) => (u8[i] === 0xff && u8[i + 1] === 0xd8 && u8[i + 2] === 0xff) || (u8[i] === 0x89 && u8[i + 1] === 0x50) || (u8[i] === 0x47 && u8[i + 1] === 0x49 && u8[i + 2] === 0x46) || (u8[i] === 0x52 && u8[i + 1] === 0x49 && u8[i + 2] === 0x46 && u8[i + 3] === 0x46) || tiffAt(u8, i);

/** Every picture found in the bytes, in file order. */
export function carvePictures(u8: Uint8Array, limit = 500): Carved[] {
  const out: Carved[] = [];
  for (const j of findEmbeddedJpegs(u8, limit)) out.push({ offset: j.offset, length: j.length, format: 'jpeg', width: j.width, height: j.height });
  // The JPEGs in file order, passed with one cursor: the scan skips each one whole (was a search of every JPEG at every byte; R18).
  const jpegs = out.map((c) => [c.offset, c.offset + c.length] as const).sort((a, b) => a[0] - b[0]);
  let i = 0, k = 0;
  while (i + 12 <= u8.length && out.length < limit) {
    while (k < jpegs.length && jpegs[k][1] <= i) k++;
    if (k < jpegs.length && i >= jpegs[k][0]) { i = jpegs[k][1]; continue; }
    const hit = pngAt(u8, i) || gifAt(u8, i) || webpAt(u8, i) || bmpAt(u8, i);
    if (hit) { out.push(hit); i = hit.offset + hit.length; continue; }
    if (tiffAt(u8, i)) { let end = i + 8; while (end + 4 <= u8.length && !isSig(u8, end)) end++; if (end - i > 64) { out.push({ offset: i, length: end - i, format: 'tiff' }); i = end; continue; } }
    i++;
  }
  return out.sort((a, b) => a.offset - b.offset);
}
