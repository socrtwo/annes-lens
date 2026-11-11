/**
 * Carrying metadata across saves: pulls the EXIF block, the XMP packet and the ICC profile out of a
 * JPEG, PNG or WebP file, and writes them into a freshly encoded JPEG (APP1/APP2), PNG (eXIf, iTXt;
 * iCCP separately, through the platform's zlib streams) or WebP (VP8X + EXIF/XMP/ICCP chunks). The EXIF Orientation
 * tag can be reset when the pixels were turned upright before saving.
 */
import { latin1 } from '../codecs/limits';

export interface PictureMeta { exif?: Uint8Array; xmp?: Uint8Array; icc?: Uint8Array }

const str = (u8: Uint8Array, o: number, n: number) => latin1(u8, o, o + n);

/** Metadata found in a JPEG, PNG or WebP file (other formats: none). */
export function extractMeta(u8: Uint8Array): PictureMeta {
  const out: PictureMeta = {};
  if (u8[0] === 0xff && u8[1] === 0xd8) {
    const icc: { n: number; data: Uint8Array }[] = [];
    let p = 2;
    while (p + 4 <= u8.length && u8[p] === 0xff) {
      const m = u8[p + 1];
      if (m === 0xff) { p++; continue; }
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { p += 2; continue; }
      if (m === 0xda || m === 0xd9) break;
      const len = (u8[p + 2] << 8) | u8[p + 3];
      const body = u8.subarray(p + 4, p + 2 + len);
      if (m === 0xe1 && str(body, 0, 6) === 'Exif\0\0' && !out.exif) out.exif = body.slice(6);
      else if (m === 0xe1 && str(body, 0, 29) === 'http://ns.adobe.com/xap/1.0/\0' && !out.xmp) out.xmp = body.slice(29);
      else if (m === 0xe2 && str(body, 0, 12) === 'ICC_PROFILE\0') icc.push({ n: body[12], data: body.slice(14) });
      p += 2 + len;
    }
    if (icc.length) { icc.sort((a, b) => a.n - b.n); const total = icc.reduce((s, c) => s + c.data.length, 0); out.icc = new Uint8Array(total); let o = 0; for (const c of icc) { out.icc.set(c.data, o); o += c.data.length; } }
    return out;
  }
  if (u8[0] === 0x89 && u8[1] === 0x50) {
    let p = 8;
    while (p + 12 <= u8.length) {
      const len = ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0;
      const type = str(u8, p + 4, 4);
      const d = p + 8;
      if (type === 'eXIf' && !out.exif) out.exif = u8.slice(d, d + len);
      else if (type === 'iTXt' && str(u8, d, 17) === 'XML:com.adobe.xmp' && u8[d + 18] === 0) { let q = d + 20; while (q < d + len && u8[q]) q++; q++; while (q < d + len && u8[q]) q++; q++; out.xmp = u8.slice(q, d + len); }
      else if (type === 'IEND') break;
      p += 12 + len;
    }
    return out;
  }
  if (str(u8, 0, 4) === 'RIFF' && str(u8, 8, 4) === 'WEBP') {
    let p = 12;
    while (p + 8 <= u8.length) {
      const type = str(u8, p, 4);
      const len = (u8[p + 4] | (u8[p + 5] << 8) | (u8[p + 6] << 16) | (u8[p + 7] << 24)) >>> 0;
      const body = u8.slice(p + 8, p + 8 + len);
      if (type === 'EXIF') out.exif = str(body, 0, 6) === 'Exif\0\0' ? body.slice(6) : body;
      else if (type === 'XMP ') out.xmp = body;
      else if (type === 'ICCP') out.icc = body;
      p += 8 + len + (len & 1);
    }
    return out;
  }
  return out;
}

export const hasMeta = (m: PictureMeta): boolean => !!(m.exif || m.xmp || m.icc);

/** A copy of the EXIF block with IFD0's Orientation set to `value` (1 = upright). Unchanged when the tag is absent. */
export function setExifOrientation(exif: Uint8Array, value: number): Uint8Array {
  const out = exif.slice();
  if (out.length < 10) return out;
  const le = out[0] === 0x49;
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  if (dv.getUint16(2, le) !== 42) return out;
  const ifd = dv.getUint32(4, le);
  if (ifd + 2 > out.length) return out;
  const n = dv.getUint16(ifd, le);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > out.length) break;
    if (dv.getUint16(e, le) === 0x112 && dv.getUint16(e + 2, le) === 3) { dv.setUint16(e + 8, value, le); break; }
  }
  return out;
}

/** The Orientation tag of an EXIF block (1 when absent). */
export function exifOrientation(exif: Uint8Array): number {
  if (exif.length < 10) return 1;
  const le = exif[0] === 0x49;
  const dv = new DataView(exif.buffer, exif.byteOffset, exif.byteLength);
  const ifd = dv.getUint32(4, le);
  if (ifd + 2 > exif.length) return 1;
  const n = dv.getUint16(ifd, le);
  for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (e + 12 > exif.length) break; if (dv.getUint16(e, le) === 0x112) return dv.getUint16(e + 8, le) || 1; }
  return 1;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const ascii = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

/** Inserts the metadata segments into a JPEG, after SOI (and after an APP0 JFIF segment when present). */
export function injectJpegMeta(jpeg: Uint8Array, m: PictureMeta): Uint8Array {
  if (!hasMeta(m) || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg;
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + ((jpeg[4] << 8) | jpeg[5]);
  const seg = (marker: number, body: Uint8Array) => { const len = body.length + 2; return concat([Uint8Array.from([0xff, marker, len >> 8, len & 255]), body]); };
  const parts: Uint8Array[] = [jpeg.subarray(0, at)];
  if (m.exif && m.exif.length + 8 <= 65535) parts.push(seg(0xe1, concat([ascii('Exif\0\0'), m.exif])));
  if (m.xmp && m.xmp.length + 31 <= 65535) parts.push(seg(0xe1, concat([ascii('http://ns.adobe.com/xap/1.0/\0'), m.xmp])));
  if (m.icc) {
    const chunk = 65519;
    const count = Math.ceil(m.icc.length / chunk);
    if (count <= 255) for (let i = 0; i < count; i++) parts.push(seg(0xe2, concat([ascii('ICC_PROFILE\0'), Uint8Array.from([i + 1, count]), m.icc.subarray(i * chunk, (i + 1) * chunk)])));
  }
  parts.push(jpeg.subarray(at));
  return concat(parts);
}

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(u8: Uint8Array, start = 0, end = u8.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ u8[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(ascii(type), 4); out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** Inserts eXIf and an XMP iTXt chunk before the first IDAT. (The ICC profile goes in with injectPngIcc.) */
export function injectPngMeta(png: Uint8Array, m: PictureMeta): Uint8Array {
  if (!(m.exif || m.xmp) || png[0] !== 0x89 || png[1] !== 0x50) return png;
  let p = 8, at = -1;
  while (p + 12 <= png.length) {
    const len = ((png[p] << 24) | (png[p + 1] << 16) | (png[p + 2] << 8) | png[p + 3]) >>> 0;
    const type = str(png, p + 4, 4);
    if (type === 'IDAT' || type === 'IEND') { at = p; break; }
    p += 12 + len;
  }
  if (at < 0) return png;
  const parts: Uint8Array[] = [png.subarray(0, at)];
  if (m.exif) parts.push(pngChunk('eXIf', m.exif));
  if (m.xmp) parts.push(pngChunk('iTXt', concat([ascii('XML:com.adobe.xmp\0\0\0\0\0'), m.xmp])));
  parts.push(png.subarray(at));
  return concat(parts);
}

/** Adds EXIF, XMP and ICCP chunks to a WebP, creating the VP8X header when the encoder wrote a simple file. */
export function injectWebpMeta(webp: Uint8Array, m: PictureMeta): Uint8Array {
  if (!hasMeta(m) || str(webp, 0, 4) !== 'RIFF' || str(webp, 8, 4) !== 'WEBP') return webp;
  const chunks: { type: string; body: Uint8Array }[] = [];
  let p = 12;
  while (p + 8 <= webp.length) {
    const type = str(webp, p, 4);
    const len = (webp[p + 4] | (webp[p + 5] << 8) | (webp[p + 6] << 16) | (webp[p + 7] << 24)) >>> 0;
    if (!['EXIF', 'XMP ', 'ICCP'].includes(type)) chunks.push({ type, body: webp.subarray(p + 8, p + 8 + len) });
    p += 8 + len + (len & 1);
  }
  let vp8x = chunks.find((c) => c.type === 'VP8X');
  let width = 0, height = 0, alpha = !!chunks.find((c) => c.type === 'ALPH');
  if (!vp8x) {
    const vp8 = chunks.find((c) => c.type === 'VP8 '), vp8l = chunks.find((c) => c.type === 'VP8L');
    if (vp8 && vp8.body.length >= 10) { width = (vp8.body[6] | (vp8.body[7] << 8)) & 0x3fff; height = (vp8.body[8] | (vp8.body[9] << 8)) & 0x3fff; }
    else if (vp8l && vp8l.body.length >= 5) { const b = vp8l.body[1] | (vp8l.body[2] << 8) | (vp8l.body[3] << 16) | (vp8l.body[4] << 24); width = (b & 0x3fff) + 1; height = ((b >>> 14) & 0x3fff) + 1; alpha = alpha || !!((b >>> 28) & 1); }
    else return webp;
    const body = new Uint8Array(10);
    body[4] = (width - 1) & 255; body[5] = ((width - 1) >> 8) & 255; body[6] = ((width - 1) >> 16) & 255;
    body[7] = (height - 1) & 255; body[8] = ((height - 1) >> 8) & 255; body[9] = ((height - 1) >> 16) & 255;
    vp8x = { type: 'VP8X', body };
    chunks.unshift(vp8x);
  } else vp8x.body = vp8x.body.slice();
  vp8x.body[0] = (vp8x.body[0] | (m.icc ? 0x20 : 0) | (alpha ? 0x10 : 0) | (m.exif ? 0x08 : 0) | (m.xmp ? 0x04 : 0)) & 0xff;
  const ordered: { type: string; body: Uint8Array }[] = [vp8x];
  if (m.icc) ordered.push({ type: 'ICCP', body: m.icc });
  for (const c of chunks) if (c !== vp8x) ordered.push(c);
  if (m.exif) ordered.push({ type: 'EXIF', body: m.exif });
  if (m.xmp) ordered.push({ type: 'XMP ', body: m.xmp });
  const parts: Uint8Array[] = [];
  for (const c of ordered) {
    const hdr = new Uint8Array(8); hdr.set(ascii(c.type)); const l = c.body.length; hdr[4] = l & 255; hdr[5] = (l >> 8) & 255; hdr[6] = (l >> 16) & 255; hdr[7] = (l >>> 24) & 255;
    parts.push(hdr, c.body); if (l & 1) parts.push(new Uint8Array(1));
  }
  const payload = concat(parts);
  const out = new Uint8Array(12 + payload.length);
  out.set(ascii('RIFF')); const size = payload.length + 4; out[4] = size & 255; out[5] = (size >> 8) & 255; out[6] = (size >> 16) & 255; out[7] = (size >>> 24) & 255; out.set(ascii('WEBP'), 8); out.set(payload, 12);
  return out;
}

/** Writes the metadata into an encoded file of the given format; other formats are returned unchanged. */
export function injectMeta(bytes: Uint8Array, format: string, m: PictureMeta): Uint8Array {
  if (format === 'jpeg') return injectJpegMeta(bytes, m);
  if (format === 'png') return injectPngMeta(bytes, m);
  if (format === 'webp') return injectWebpMeta(bytes, m);
  return bytes;
}

async function zlib(data: Uint8Array, mode: 'compress' | 'decompress'): Promise<Uint8Array> {
  const cs = mode === 'compress' ? new CompressionStream('deflate') : new DecompressionStream('deflate'), w = cs.writable.getWriter();
  const done = Promise.all([w.write(data as BufferSource), w.close()]);
  const [out] = await Promise.all([new Response(cs.readable).arrayBuffer(), done]);
  return new Uint8Array(out);
}
const pngChunks = (png: Uint8Array) => { const out: { type: string; at: number; len: number }[] = []; let p = 8; while (p + 12 <= png.length) { const len = ((png[p] << 24) | (png[p + 1] << 16) | (png[p + 2] << 8) | png[p + 3]) >>> 0; const type = str(png, p + 4, 4); out.push({ type, at: p, len }); if (type === 'IEND') break; p += 12 + len; } return out; };

/** The ICC profile in a PNG's iCCP chunk (inflated), or null. */
export async function pngIcc(png: Uint8Array): Promise<Uint8Array | null> {
  if (png[0] !== 0x89 || png[1] !== 0x50) return null;
  const c = pngChunks(png).find((k) => k.type === 'iCCP'); if (!c) return null;
  const d = c.at + 8; let q = d; while (q < d + c.len && png[q]) q++;
  try { return await zlib(png.subarray(q + 2, d + c.len), 'decompress'); } catch { return null; }
}

/** Puts an iCCP chunk after IHDR, replacing any iCCP, sRGB, gAMA and cHRM chunk (the profile supersedes them). */
export async function injectPngIcc(png: Uint8Array, icc: Uint8Array, name = 'ICC profile'): Promise<Uint8Array> {
  if (png[0] !== 0x89 || png[1] !== 0x50) return png;
  const chunks = pngChunks(png), ihdr = chunks[0]; if (!ihdr || ihdr.type !== 'IHDR') return png;
  const label = name.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 79) || 'ICC profile';
  const parts: Uint8Array[] = [png.subarray(0, ihdr.at + 12 + ihdr.len), pngChunk('iCCP', concat([ascii(label), Uint8Array.from([0, 0]), await zlib(icc, 'compress')]))];
  for (const c of chunks.slice(1)) if (!['iCCP', 'sRGB', 'gAMA', 'cHRM'].includes(c.type)) parts.push(png.subarray(c.at, c.at + 12 + c.len));
  return concat(parts);
}
