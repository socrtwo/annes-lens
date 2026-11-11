/**
 * Editing metadata inside containers without touching the pixels: replacing the XMP packet, the JPEG
 * comment (COM) or PNG Comment text, stripping metadata with a choice of what to keep, removing the
 * GPS IFD from EXIF, rewriting EXIF dates in place, building a minimal EXIF block, detecting Content
 * Credentials (C2PA/JUMBF) boxes, and checksums.
 */
import { extractMeta, injectWebpMeta, crc32, type PictureMeta } from './metaWrite';
import { jpegSegments } from './iptc';
import { latin1 } from '../codecs/limits';

const str = (u8: Uint8Array, o: number, n: number) => latin1(u8, o, o + n);
const ascii = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 255));
export function concat(parts: Uint8Array[]): Uint8Array { const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }
const seg = (marker: number, body: Uint8Array) => { const len = body.length + 2; return concat([Uint8Array.from([0xff, marker, len >> 8, len & 255]), body]); };
export const XMP_HEAD = 'http://ns.adobe.com/xap/1.0/\0';

/** True for the formats whose files can carry XMP in place. */
export const canEmbed = (format: string): boolean => format === 'jpeg' || format === 'png' || format === 'webp';

export const decodeText = (u8: Uint8Array): string => { try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch { return new TextDecoder('latin1').decode(u8); } };

// PNG chunks ---------------------------------------------------------------------------------------
export interface PngChunk { type: string; data: Uint8Array }
export function pngChunks(u8: Uint8Array): PngChunk[] | null {
  if (u8[0] !== 0x89 || u8[1] !== 0x50) return null;
  const out: PngChunk[] = []; let p = 8;
  while (p + 12 <= u8.length) { const len = ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0; const type = str(u8, p + 4, 4); out.push({ type, data: u8.subarray(p + 8, p + 8 + len) }); p += 12 + len; if (type === 'IEND') break; }
  return out;
}
export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length); const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length); out.set(ascii(type), 4); out.set(data, 8); dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}
export function buildPng(chunks: PngChunk[]): Uint8Array { return concat([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks.map((c) => pngChunk(c.type, c.data))]); }
const isXmpItxt = (c: PngChunk) => c.type === 'iTXt' && str(c.data, 0, 17) === 'XML:com.adobe.xmp';
const pngTextKey = (c: PngChunk) => { let i = 0; while (i < c.data.length && c.data[i]) i++; return str(c.data, 0, i); };

// XMP ----------------------------------------------------------------------------------------------
/** A copy of the file with its XMP packet replaced (removed when null). JPEG, PNG and WebP only. */
export function setXmp(u8: Uint8Array, format: string, xmp: Uint8Array | null): Uint8Array {
  if (format === 'jpeg') {
    const segs = jpegSegments(u8);
    const old = segs.find((s) => s.marker === 0xe1 && str(u8, s.start + 4, 29) === XMP_HEAD);
    const neu = xmp && xmp.length + 31 <= 65535 ? seg(0xe1, concat([ascii(XMP_HEAD), xmp])) : new Uint8Array(0);
    if (old) return concat([u8.subarray(0, old.start), neu, u8.subarray(old.start + 2 + old.len)]);
    if (!neu.length) return u8;
    let at = 2; for (const s of segs) { if (s.marker === 0xe0 || (s.marker === 0xe1 && str(u8, s.start + 4, 4) === 'Exif')) at = s.start + 2 + s.len; else break; }
    return concat([u8.subarray(0, at), neu, u8.subarray(at)]);
  }
  if (format === 'png') {
    const chunks = pngChunks(u8); if (!chunks) return u8;
    const kept = chunks.filter((c) => !isXmpItxt(c));
    if (xmp) { const idx = kept.findIndex((c) => c.type === 'IDAT' || c.type === 'IEND'); kept.splice(idx < 0 ? kept.length : idx, 0, { type: 'iTXt', data: concat([ascii('XML:com.adobe.xmp\0\0\0\0\0'), xmp]) }); }
    return buildPng(kept);
  }
  if (format === 'webp') { const m = extractMeta(u8); const next: PictureMeta = { exif: m.exif, icc: m.icc, xmp: xmp || undefined }; return (next.exif || next.icc || next.xmp) ? injectWebpMeta(u8, next) : stripWebp(u8, {}); }
  return u8;
}

// Comments -----------------------------------------------------------------------------------------
/** The JPEG COM segment or the PNG tEXt/iTXt "Comment" (or "Description") text. */
export function getComment(u8: Uint8Array, format: string): string | undefined {
  if (format === 'jpeg') { const s = jpegSegments(u8).find((x) => x.marker === 0xfe); return s ? decodeText(u8.subarray(s.start + 4, s.start + 2 + s.len)) : undefined; }
  if (format === 'png') {
    for (const c of pngChunks(u8) || []) {
      if (c.type !== 'tEXt' && c.type !== 'iTXt') continue;
      const key = pngTextKey(c); if (key !== 'Comment' && key !== 'Description') continue;
      if (c.type === 'tEXt') return decodeText(c.data.subarray(key.length + 1));
      let q = key.length + 1; const comp = c.data[q]; q += 2; while (q < c.data.length && c.data[q]) q++; q++; while (q < c.data.length && c.data[q]) q++; q++;
      if (!comp) return decodeText(c.data.subarray(q));
    }
  }
  return undefined;
}
/** A copy with the comment replaced (removed when empty). */
export function setComment(u8: Uint8Array, format: string, text: string): Uint8Array {
  if (format === 'jpeg') {
    const segs = jpegSegments(u8); const olds = segs.filter((x) => x.marker === 0xfe);
    const body = new TextEncoder().encode(text).subarray(0, 65000);
    const neu = text ? seg(0xfe, body) : new Uint8Array(0);
    if (olds.length) { const parts: Uint8Array[] = []; let p = 0; for (const o of olds) { parts.push(u8.subarray(p, o.start)); if (o === olds[0]) parts.push(neu); p = o.start + 2 + o.len; } parts.push(u8.subarray(p)); return concat(parts); }
    if (!neu.length) return u8;
    let at = 2; for (const s of segs) { if (s.marker >= 0xe0 && s.marker <= 0xef) at = s.start + 2 + s.len; else break; }
    return concat([u8.subarray(0, at), neu, u8.subarray(at)]);
  }
  if (format === 'png') {
    const chunks = pngChunks(u8); if (!chunks) return u8;
    const kept = chunks.filter((c) => !((c.type === 'tEXt' || c.type === 'iTXt' || c.type === 'zTXt') && pngTextKey(c) === 'Comment'));
    if (text) { const idx = kept.findIndex((c) => c.type === 'IDAT' || c.type === 'IEND'); kept.splice(idx < 0 ? kept.length : idx, 0, { type: 'iTXt', data: concat([ascii('Comment\0\0\0\0\0'), new TextEncoder().encode(text)]) }); }
    return buildPng(kept);
  }
  return u8;
}

// EXIF edits ---------------------------------------------------------------------------------------
function tiffView(exif: Uint8Array): { le: boolean; dv: DataView; ifd0: number } | null {
  if (exif.length < 10) return null;
  const le = exif[0] === 0x49; if (!le && exif[0] !== 0x4d) return null;
  const dv = new DataView(exif.buffer, exif.byteOffset, exif.byteLength);
  if (dv.getUint16(2, le) !== 42) return null;
  const ifd0 = dv.getUint32(4, le); if (ifd0 + 2 > exif.length) return null;
  return { le, dv, ifd0 };
}
function findEntry(exif: Uint8Array, ifd: number, tag: number): number {
  const t = tiffView(exif); if (!t) return -1;
  const n = t.dv.getUint16(ifd, t.le);
  for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (e + 12 > exif.length) break; if (t.dv.getUint16(e, t.le) === tag) return e; }
  return -1;
}
/** A copy of the EXIF block without the GPS IFD entry in IFD0 (the IFD's bytes stay but are unreachable). */
export function removeGpsFromExif(exif: Uint8Array): Uint8Array {
  const out = exif.slice(); const t = tiffView(out); if (!t) return out;
  const e = findEntry(out, t.ifd0, 0x8825); if (e < 0) return out;
  const n = t.dv.getUint16(t.ifd0, t.le), end = t.ifd0 + 2 + n * 12;
  out.copyWithin(e, e + 12, end + 4); // shift the later entries and the next-IFD pointer up
  out.fill(0, end - 12 + 4, end + 4);
  t.dv.setUint16(t.ifd0, n - 1, t.le);
  return out;
}
export const hasGpsIfd = (exif: Uint8Array): boolean => { const t = tiffView(exif); return !!t && findEntry(exif, t.ifd0, 0x8825) >= 0; };

/** The EXIF dates ("YYYY:MM:DD HH:MM:SS"): DateTime (IFD0), DateTimeOriginal and DateTimeDigitized (Exif IFD). */
export function exifDates(exif: Uint8Array): { dateTime?: string; original?: string; digitized?: string } {
  const t = tiffView(exif); if (!t) return {};
  const read = (ifd: number, tag: number) => { const e = findEntry(exif, ifd, tag); if (e < 0) return undefined; const count = t.dv.getUint32(e + 4, t.le); const o = count <= 4 ? e + 8 : t.dv.getUint32(e + 8, t.le); return str(exif, o, Math.min(count, 20)).replace(/\0+$/, '') || undefined; };
  const ep = findEntry(exif, t.ifd0, 0x8769); const exifIfd = ep >= 0 ? t.dv.getUint32(ep + 8, t.le) : 0;
  return { dateTime: read(t.ifd0, 0x132), original: exifIfd ? read(exifIfd, 0x9003) : undefined, digitized: exifIfd ? read(exifIfd, 0x9004) : undefined };
}
/** A copy with every present EXIF date tag rewritten in place by `fn(old)` (values must stay 19 characters). */
export function mapExifDates(exif: Uint8Array, fn: (old: string) => string): Uint8Array {
  const out = exif.slice(); const t = tiffView(out); if (!t) return out;
  const write = (ifd: number, tag: number) => { const e = findEntry(out, ifd, tag); if (e < 0) return; const count = t.dv.getUint32(e + 4, t.le); if (count < 20) return; const o = t.dv.getUint32(e + 8, t.le); if (o + 20 > out.length) return; const old = str(out, o, 19); const v = fn(old); if (v.length !== 19) return; out.set(ascii(v), o); };
  const ep = findEntry(out, t.ifd0, 0x8769); const exifIfd = ep >= 0 ? t.dv.getUint32(ep + 8, t.le) : 0;
  write(t.ifd0, 0x132); if (exifIfd) { write(exifIfd, 0x9003); write(exifIfd, 0x9004); }
  return out;
}
export const parseExifDate = (s: string): Date | null => { const m = s.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null; };
export const formatExifDate = (d: Date): string => { const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };

/** A minimal little-endian EXIF block with Orientation and optional Artist/Copyright/Description. */
export function minimalExif(o: { orientation?: number; artist?: string; copyright?: string; description?: string; software?: string }): Uint8Array | null {
  const entries: { tag: number; type: number; data: Uint8Array | number }[] = [];
  const utf8 = (t: string) => new TextEncoder().encode(t + '\0');
  if (o.description) entries.push({ tag: 0x10e, type: 2, data: utf8(o.description) });
  if (o.orientation && o.orientation !== 1) entries.push({ tag: 0x112, type: 3, data: o.orientation });
  if (o.software) entries.push({ tag: 0x131, type: 2, data: utf8(o.software) });
  if (o.artist) entries.push({ tag: 0x13b, type: 2, data: utf8(o.artist) });
  if (o.copyright) entries.push({ tag: 0x8298, type: 2, data: utf8(o.copyright) });
  if (!entries.length) return null;
  entries.sort((a, b) => a.tag - b.tag);
  const ifdLen = 2 + entries.length * 12 + 4; let extra = 0;
  for (const e of entries) if (typeof e.data !== 'number' && e.data.length > 4) extra += e.data.length + (e.data.length & 1);
  const out = new Uint8Array(8 + ifdLen + extra); const dv = new DataView(out.buffer);
  out.set(ascii('II')); dv.setUint16(2, 42, true); dv.setUint32(4, 8, true); dv.setUint16(8, entries.length, true);
  let dataAt = 8 + ifdLen;
  entries.forEach((e, i) => {
    const at = 10 + i * 12; dv.setUint16(at, e.tag, true); dv.setUint16(at + 2, e.type, true);
    if (typeof e.data === 'number') { dv.setUint32(at + 4, 1, true); dv.setUint16(at + 8, e.data, true); }
    else { dv.setUint32(at + 4, e.data.length, true); if (e.data.length <= 4) out.set(e.data, at + 8); else { dv.setUint32(at + 8, dataAt, true); out.set(e.data, dataAt); dataAt += e.data.length + (e.data.length & 1); } }
  });
  return out;
}

// Strip --------------------------------------------------------------------------------------------
export interface KeepOptions { exif?: boolean; orientation?: boolean; icc?: boolean; xmp?: boolean; iptc?: boolean; comment?: boolean; copyright?: boolean; /** An XMP packet to write instead of the original (e.g. one with only dc:rights). */ xmpReplacement?: Uint8Array | null; exifReplacement?: Uint8Array | null }

function stripWebp(u8: Uint8Array, keep: KeepOptions): Uint8Array {
  const m = extractMeta(u8);
  const next: PictureMeta = { exif: keep.exif ? m.exif : keep.exifReplacement || undefined, icc: keep.icc ? m.icc : undefined, xmp: keep.xmp ? m.xmp : keep.xmpReplacement || undefined };
  // Rebuild from the chunks, dropping metadata; injectWebpMeta re-adds what is kept.
  const chunks: Uint8Array[] = []; let p = 12;
  while (p + 8 <= u8.length) { const type = str(u8, p, 4); const len = (u8[p + 4] | (u8[p + 5] << 8) | (u8[p + 6] << 16) | (u8[p + 7] << 24)) >>> 0; if (!['EXIF', 'XMP ', 'ICCP'].includes(type)) chunks.push(u8.subarray(p, p + 8 + len + (len & 1))); p += 8 + len + (len & 1); }
  const payload = concat(chunks); const out = new Uint8Array(12 + payload.length); out.set(u8.subarray(0, 12)); out.set(payload, 12);
  const size = payload.length + 4; out[4] = size & 255; out[5] = (size >> 8) & 255; out[6] = (size >> 16) & 255; out[7] = (size >>> 24) & 255;
  if (out[12] === 0x56 && out[13] === 0x50 && out[14] === 0x38 && out[15] === 0x58) out[20] &= ~0x2c; // clear ICC/EXIF/XMP flags in VP8X
  return next.exif || next.icc || next.xmp ? injectWebpMeta(out, next) : out;
}

/** A copy of the file with metadata removed except what `keep` names. Formats: JPEG, PNG, WebP (others unchanged). */
export function stripMeta(u8: Uint8Array, format: string, keep: KeepOptions): Uint8Array {
  if (format === 'jpeg') {
    const segs = jpegSegments(u8); if (!segs.length) return u8;
    const parts: Uint8Array[] = [u8.subarray(0, 2)]; let p = 2;
    const m = extractMeta(u8);
    let exifOut: Uint8Array | undefined = keep.exif ? m.exif : keep.exifReplacement || undefined;
    let xmpOut: Uint8Array | undefined = keep.xmp ? m.xmp : keep.xmpReplacement || undefined;
    for (const s of segs) {
      const body = u8.subarray(s.start + 4, s.start + 2 + s.len);
      const whole = u8.subarray(s.start, s.start + 2 + s.len);
      let out: Uint8Array | null = null;
      if (s.marker === 0xe0 && str(body, 0, 5) === 'JFIF\0') out = whole;
      else if (s.marker === 0xe1 && str(body, 0, 6) === 'Exif\0\0') { if (exifOut) { out = seg(0xe1, concat([ascii('Exif\0\0'), exifOut])); exifOut = undefined; } }
      else if (s.marker === 0xe1 && str(body, 0, 29) === XMP_HEAD) { if (xmpOut) { out = seg(0xe1, concat([ascii(XMP_HEAD), xmpOut])); xmpOut = undefined; } }
      else if (s.marker === 0xe2 && str(body, 0, 12) === 'ICC_PROFILE\0') { if (keep.icc) out = whole; }
      else if (s.marker === 0xed && keep.iptc) out = whole;
      else if (s.marker === 0xfe) out = keep.comment ? whole : null;
      else if (s.marker >= 0xe0 && s.marker <= 0xef) out = null; // other APPn (Adobe APP14 is needed for CMYK: keep it)
      else out = whole; // tables and frame headers
      if (s.marker === 0xee && str(body, 0, 5) === 'Adobe') out = whole;
      if (out) parts.push(out);
      p = s.start + 2 + s.len;
    }
    // Metadata to add that had no segment to replace goes right after SOI/JFIF.
    const extra: Uint8Array[] = [];
    if (exifOut) extra.push(seg(0xe1, concat([ascii('Exif\0\0'), exifOut])));
    if (xmpOut && xmpOut.length + 31 <= 65535) extra.push(seg(0xe1, concat([ascii(XMP_HEAD), xmpOut])));
    if (extra.length) { const idx = parts.length > 1 && parts[1][1] === 0xe0 ? 2 : 1; parts.splice(idx, 0, ...extra); }
    parts.push(u8.subarray(p));
    return concat(parts);
  }
  if (format === 'png') {
    const chunks = pngChunks(u8); if (!chunks) return u8;
    const m = extractMeta(u8);
    const kept: PngChunk[] = [];
    let exifOut: Uint8Array | undefined = keep.exif ? m.exif : keep.exifReplacement || undefined, xmpOut: Uint8Array | undefined = keep.xmp ? m.xmp : keep.xmpReplacement || undefined;
    for (const c of chunks) {
      if (c.type === 'eXIf') { if (exifOut) { kept.push({ type: 'eXIf', data: exifOut }); exifOut = undefined; } continue; }
      if (isXmpItxt(c)) { if (xmpOut) { kept.push({ type: 'iTXt', data: concat([ascii('XML:com.adobe.xmp\0\0\0\0\0'), xmpOut]) }); xmpOut = undefined; } continue; }
      if (c.type === 'iCCP') { if (keep.icc) kept.push(c); continue; }
      if (c.type === 'tEXt' || c.type === 'zTXt' || c.type === 'iTXt') { if (keep.comment && pngTextKey(c) === 'Comment') kept.push(c); continue; }
      if (c.type === 'tIME') continue;
      kept.push(c);
    }
    const idx = kept.findIndex((c) => c.type === 'IDAT' || c.type === 'PLTE' || c.type === 'IEND');
    const add: PngChunk[] = []; if (exifOut) add.push({ type: 'eXIf', data: exifOut }); if (xmpOut) add.push({ type: 'iTXt', data: concat([ascii('XML:com.adobe.xmp\0\0\0\0\0'), xmpOut]) });
    kept.splice(idx < 0 ? kept.length : idx, 0, ...add);
    return buildPng(kept);
  }
  if (format === 'webp') return stripWebp(u8, keep);
  return u8;
}

// Content credentials ------------------------------------------------------------------------------
export interface Provenance { c2pa: boolean; where: string[]; jumbfLabels: string[] }
/** Looks for C2PA manifests: JPEG APP11 JUMBF boxes, PNG caBX chunks, WebP C2PA chunks, HEIF/AVIF 'c2pa' items (by string scan). */
export function detectProvenance(u8: Uint8Array): Provenance {
  const out: Provenance = { c2pa: false, where: [], jumbfLabels: [] };
  const labelsIn = (b: Uint8Array) => { const s = str(b, 0, Math.min(b.length, 4000)); for (const m of s.matchAll(/c2pa(?:\.[a-z_]+)*|adobe\.c2pa|jumb|cbor/gi)) if (!out.jumbfLabels.includes(m[0])) out.jumbfLabels.push(m[0]); };
  if (u8[0] === 0xff && u8[1] === 0xd8) {
    for (const s of jpegSegments(u8)) if (s.marker === 0xeb && str(u8, s.start + 4, 2) === 'JP') { const body = u8.subarray(s.start + 4, s.start + 2 + s.len); if (/c2pa|jumb/i.test(str(body, 0, Math.min(body.length, 200)))) { out.c2pa = true; if (!out.where.includes('JPEG APP11 JUMBF')) out.where.push('JPEG APP11 JUMBF'); labelsIn(body); } }
  } else if (u8[0] === 0x89 && u8[1] === 0x50) {
    for (const c of pngChunks(u8) || []) if (c.type === 'caBX') { out.c2pa = true; out.where.push('PNG caBX chunk'); labelsIn(c.data); }
  } else if (str(u8, 0, 4) === 'RIFF' && str(u8, 8, 4) === 'WEBP') {
    let p = 12; while (p + 8 <= u8.length) { const type = str(u8, p, 4); const len = (u8[p + 4] | (u8[p + 5] << 8) | (u8[p + 6] << 16) | (u8[p + 7] << 24)) >>> 0; if (type === 'C2PA') { out.c2pa = true; out.where.push('WebP C2PA chunk'); labelsIn(u8.subarray(p + 8, p + 8 + len)); } p += 8 + len + (len & 1); }
  } else if (str(u8, 4, 4) === 'ftyp') {
    const head = str(u8, 0, Math.min(u8.length, 1 << 20)); if (/c2pa/.test(head)) { out.c2pa = true; out.where.push('ISO BMFF c2pa item'); labelsIn(u8.subarray(0, Math.min(u8.length, 1 << 20))); }
  }
  return out;
}

// Checksums ----------------------------------------------------------------------------------------
export async function sha(u8: Uint8Array, algo: 'SHA-1' | 'SHA-256' | 'SHA-512'): Promise<string> {
  const buf = await crypto.subtle.digest(algo, u8 as BufferSource);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** MD5 (for older manifests); RFC 1321. */
export function md5(u8: Uint8Array): string {
  const K = new Uint32Array(64); for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const len = u8.length, padded = new Uint8Array(((len + 8) >> 6 << 6) + 64); padded.set(u8); padded[len] = 0x80;
  const dv = new DataView(padded.buffer); dv.setUint32(padded.length - 8, (len * 8) >>> 0, true); dv.setUint32(padded.length - 4, Math.floor((len * 8) / 4294967296), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const rotl = (x: number, c: number) => (x << c) | (x >>> (32 - c));
  for (let off = 0; off < padded.length; off += 64) {
    const M = new Uint32Array(16); for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; } else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; } else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; } else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0; A = D; D = C; C = B; B = (B + rotl(F, S[i])) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const hex = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}
