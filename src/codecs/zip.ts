/**
 * ZIP archives (and CBZ comics, EPUB pictures) as folders: the central directory is read, picture
 * entries are listed in natural order, and each entry is inflated on demand with the app's own
 * inflater (stored and deflate methods; encrypted and other methods are listed as unreadable).
 */
import { inflate } from './inflate';
import { checkUnpacked } from './limits';

export interface ZipEntry { name: string; size: number; compressed: number; method: number; offset: number; mtime: number; encrypted: boolean }

export const isZip = (u8: Uint8Array): boolean => u8.length > 22 && u8[0] === 0x50 && u8[1] === 0x4b && (u8[2] === 3 || u8[2] === 5 || u8[2] === 7) && (u8[3] === 4 || u8[3] === 6 || u8[3] === 8);

export function readZip(u8: Uint8Array): { entries: ZipEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // End of central directory: scan backwards (the comment may follow it).
  let eocd = -1;
  for (let p = u8.length - 22; p >= Math.max(0, u8.length - 65557); p--) if (u8[p] === 0x50 && u8[p + 1] === 0x4b && u8[p + 2] === 5 && u8[p + 3] === 6) { eocd = p; break; }
  const entries: ZipEntry[] = [];
  const dec = new TextDecoder('utf-8');
  const dosTime = (t: number, d: number) => new Date(1980 + (d >> 9), ((d >> 5) & 15) - 1, d & 31, (t >> 11) & 31, (t >> 5) & 63, (t & 31) * 2).getTime();
  if (eocd >= 0) {
    let count = dv.getUint16(eocd + 10, true), cdAt = dv.getUint32(eocd + 16, true);
    if (count === 0xffff || cdAt === 0xffffffff) { // ZIP64
      const loc = eocd - 20;
      if (loc >= 0 && dv.getUint32(loc, true) === 0x07064b50) {
        const z64 = Number(dv.getBigUint64(loc + 8, true));
        if (z64 + 56 <= u8.length && dv.getUint32(z64, true) === 0x06064b50) { count = Number(dv.getBigUint64(z64 + 32, true)); cdAt = Number(dv.getBigUint64(z64 + 48, true)); }
      }
    }
    let p = cdAt;
    for (let i = 0; i < count && p + 46 <= u8.length; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) { warnings.push('The central directory is damaged; listing stopped there'); break; }
      const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true), t = dv.getUint16(p + 12, true), d = dv.getUint16(p + 14, true);
      let compressed = dv.getUint32(p + 20, true), size = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
      let offset = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
      // ZIP64 extra field
      let e = p + 46 + nameLen;
      const extraEnd = e + extraLen;
      while (e + 4 <= extraEnd) {
        const id = dv.getUint16(e, true), len = dv.getUint16(e + 2, true);
        if (id === 1) { let q = e + 4; if (size === 0xffffffff) { size = Number(dv.getBigUint64(q, true)); q += 8; } if (compressed === 0xffffffff) { compressed = Number(dv.getBigUint64(q, true)); q += 8; } if (offset === 0xffffffff) offset = Number(dv.getBigUint64(q, true)); }
        e += 4 + len;
      }
      if (!name.endsWith('/')) entries.push({ name, size, compressed, method, offset, mtime: dosTime(t, d), encrypted: !!(flags & 1) });
      p += 46 + nameLen + extraLen + commentLen;
    }
  } else {
    // No central directory (truncated download): walk the local headers.
    warnings.push('No central directory (the archive is truncated); entries were found by scanning');
    let p = 0;
    while (p + 30 <= u8.length && dv.getUint32(p, true) === 0x04034b50) {
      const flags = dv.getUint16(p + 6, true), method = dv.getUint16(p + 8, true), t = dv.getUint16(p + 10, true), d = dv.getUint16(p + 12, true);
      const compressed = dv.getUint32(p + 18, true), size = dv.getUint32(p + 22, true), nameLen = dv.getUint16(p + 26, true), extraLen = dv.getUint16(p + 28, true);
      const name = dec.decode(u8.subarray(p + 30, p + 30 + nameLen));
      if (flags & 8 || !compressed) break; // sizes in a data descriptor: cannot walk further safely
      if (!name.endsWith('/')) entries.push({ name, size, compressed, method, offset: p, mtime: dosTime(t, d), encrypted: !!(flags & 1) });
      p += 30 + nameLen + extraLen + compressed;
    }
  }
  return { entries, warnings };
}

/** The bytes of one entry. Throws for encrypted or unsupported methods; a truncated entry yields what could be read. */
export function readZipEntry(u8: Uint8Array, e: ZipEntry): Uint8Array {
  if (e.encrypted) throw new Error(`${e.name} is encrypted`);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (e.offset + 30 > u8.length || dv.getUint32(e.offset, true) !== 0x04034b50) throw new Error(`${e.name}: local header not found`);
  const nameLen = dv.getUint16(e.offset + 26, true), extraLen = dv.getUint16(e.offset + 28, true);
  const start = e.offset + 30 + nameLen + extraLen;
  const data = u8.subarray(start, Math.min(u8.length, start + e.compressed));
  if (e.method === 0) return data;
  if (e.method === 8) { checkUnpacked(e.size, e.name); const r = inflate(data, e.size, e.size > 0 ? e.size : undefined); return r.data; } // no more than the entry says it holds
  throw new Error(`${e.name}: compression method ${e.method} is not supported (only stored and deflate)`);
}
