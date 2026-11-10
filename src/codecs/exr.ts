/**
 * OpenEXR: scanline and tiled images (the full-resolution level of mip and rip maps), single or
 * multi-part (each part a page), HALF, FLOAT and UINT channels with subsampling, compressed with
 * NONE, RLE, ZIPS, ZIP, PIZ (Huffman + wavelet), PXR24, B44, B44A, DWAA or DWAB (dwa.ts), ZSTD, or
 * HTJ2K256/HTJ2K32 (OpenJPH, openjph.ts; HALF channels), written from the file layout as OpenEXR's
 * compressors define it. RGB(A), luminance (Y) and luminance/chroma (Y, RY, BY) are shown;
 * other channel sets show their first layer or channel. Linear values are tone-mapped like Radiance
 * HDR (exposure 1, clipped, sRGB curve); premultiplied alpha is undone. LJ2K, HTJ2K with FLOAT or UINT
 * channels, and deep data are refused with a message.
 */
import { makeRaster, type DecodeResult, type DecodedPage } from './raster';
import { inflate } from './inflate';
import { decodeDwa } from './dwa';
import { decompress as zstdDecompress } from 'fzstd';
import { exrHtHeader, decodeHtj2k16 } from './openjph';

export const isExr = (u8: Uint8Array): boolean => u8.length > 8 && u8[0] === 0x76 && u8[1] === 0x2f && u8[2] === 0x31 && u8[3] === 0x01;

const HALF = new Float32Array(65536);
{ for (let v = 0; v < 65536; v++) { const s = v & 0x8000 ? -1 : 1, e = (v >> 10) & 31, f = v & 1023; HALF[v] = e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15); } }

interface Channel { name: string; type: number; linear: boolean; xs: number; ys: number }
interface Header { channels: Channel[]; compression: number; x0: number; y0: number; x1: number; y1: number; tiled: boolean; tileW: number; tileH: number; levelMode: number; name?: string; type?: string; chunkCount?: number; attrs: Record<string, string> }
const COMPRESSION = ['none', 'RLE', 'ZIPS', 'ZIP', 'PIZ', 'PXR24', 'B44', 'B44A', 'DWAA', 'DWAB', 'HTJ2K256', 'HTJ2K32', 'LJ2K', 'ZSTD'];
const LINES = [1, 1, 1, 16, 32, 16, 32, 32, 32, 256, 256, 32, 256, 1];
const BYTES = [4, 2, 4]; // UINT, HALF, FLOAT

class R {
  dv: DataView;
  constructor(public u8: Uint8Array, public p = 0) { this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }
  str(): string { let e = this.p; while (e < this.u8.length && this.u8[e]) e++; const s = new TextDecoder().decode(this.u8.subarray(this.p, e)); this.p = e + 1; return s; }
  i32(): number { const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
  u32(): number { const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  u64(): number { const lo = this.u32(), hi = this.u32(); return hi * 4294967296 + lo; }
}

function readHeader(r: R): Header | null {
  const h: Header = { channels: [], compression: 0, x0: 0, y0: 0, x1: -1, y1: -1, tiled: false, tileW: 0, tileH: 0, levelMode: 0, attrs: {} };
  let any = false;
  for (;;) {
    const name = r.str(); if (!name) break;
    any = true;
    const type = r.str(), size = r.i32(), end = r.p + size, v = new R(r.u8, r.p);
    if (size < 0 || end > r.u8.length) throw new Error('Damaged OpenEXR header: an attribute larger than the file'); // a negative size would rewind the reader for ever
    if (name === 'channels') {
      while (v.p < end - 1) { const n = v.str(); if (!n) break; const t = v.i32(), lin = v.u8[v.p]; v.p += 4; const xs = v.i32(), ys = v.i32(); h.channels.push({ name: n, type: t, linear: !!lin, xs, ys }); }
    } else if (name === 'compression') h.compression = r.u8[r.p];
    else if (name === 'dataWindow') { h.x0 = v.i32(); h.y0 = v.i32(); h.x1 = v.i32(); h.y1 = v.i32(); }
    else if (name === 'tiles') { h.tiled = true; h.tileW = v.u32(); h.tileH = v.u32(); h.levelMode = r.u8[v.p] & 15; }
    else if (name === 'name' && type === 'string') h.name = new TextDecoder().decode(r.u8.subarray(r.p, end));
    else if (name === 'type' && type === 'string') h.type = new TextDecoder().decode(r.u8.subarray(r.p, end));
    else if (name === 'chunkCount') h.chunkCount = v.i32();
    else if (type === 'string') h.attrs[name] = new TextDecoder().decode(r.u8.subarray(r.p, end));
    r.p = end;
  }
  return any ? h : null;
}

// Decompressors: each returns the block in the uncompressed layout (per scanline, channels in order). ---
function predictReorder(t: Uint8Array): Uint8Array {
  for (let i = 1; i < t.length; i++) t[i] = (t[i - 1] + t[i] - 128) & 255;
  const out = new Uint8Array(t.length), half = (t.length + 1) >> 1;
  for (let i = 0, a = 0, b = half; i < t.length; i++) out[i] = i & 1 ? t[b++] : t[a++];
  return out;
}
function rle(src: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size); let i = 0, o = 0;
  while (i < src.length && o < size) {
    const c = (src[i] << 24) >> 24; i++;
    if (c < 0) { const n = -c; out.set(src.subarray(i, i + n), o); o += n; i += n; }
    else { out.fill(src[i++], o, o + c + 1); o += c + 1; }
  }
  return out;
}
function zip(src: Uint8Array, size: number): Uint8Array {
  const r = inflate(src, size); if (!r.complete && r.data.length < size) throw new Error(`ZIP data is damaged (${r.error || 'short'})`);
  const t = new Uint8Array(size); t.set(r.data.subarray(0, size)); return t;
}

// PIZ: Huffman-coded 16-bit values through a lookup table, then a 2-D Haar-like wavelet per channel.
const HUF_DECBITS = 14, HUF_ENCSIZE = 65537;
/** OpenEXR's Huffman stream: a header, the code lengths (6 bits each, runs of zeros), then nBits of codes. */
function hufDecode(u8: Uint8Array, p: number, n: number, nRaw: number): Uint16Array {
  if (n < 20 || p + n > u8.length) throw new Error('Corrupt PIZ data (size)');
  const dv = new DataView(u8.buffer, u8.byteOffset + p, n);
  const im = dv.getUint32(0, true), iM = dv.getUint32(4, true), nBits = dv.getUint32(12, true);
  if (im >= HUF_ENCSIZE || iM >= HUF_ENCSIZE) throw new Error('Corrupt PIZ data (table)');
  // A bit reader over bytes from q; c holds the unread low `lc` bits.
  let q = p + 20, c = 0, lc = 0;
  const pull = () => { c = c * 256 + u8[q++]; lc += 8; };
  const take = (k: number) => { while (lc < k) pull(); lc -= k; const v = Math.floor(c / 2 ** lc); c -= v * 2 ** lc; return v; };
  const hlen = new Uint8Array(HUF_ENCSIZE);
  for (let i = im; i <= iM; i++) {
    const l = take(6);
    if (l === 63 || l >= 59) {
      const z = l === 63 ? take(8) + 6 : l - 59 + 2;
      if (i + z > iM + 1) throw new Error('Corrupt PIZ data (run)');
      i += z - 1; // those symbols stay at length 0
    } else hlen[i] = l;
  }
  // Canonical codes: longest first, as hufCanonicalCodeTable assigns them.
  const cnt = new Float64Array(59); for (let i = 0; i < HUF_ENCSIZE; i++) cnt[hlen[i]]++;
  let cc = 0; for (let i = 58; i > 0; i--) { const nc = Math.floor((cc + cnt[i]) / 2); cnt[i] = cc; cc = nc; }
  const code = new Float64Array(HUF_ENCSIZE);
  for (let i = 0; i < HUF_ENCSIZE; i++) if (hlen[i]) code[i] = cnt[hlen[i]]++;
  const dLen = new Uint8Array(1 << HUF_DECBITS), dLit = new Int32Array(1 << HUF_DECBITS), dLong: (number[] | undefined)[] = new Array(1 << HUF_DECBITS);
  for (let s = im; s <= iM; s++) {
    const l = hlen[s]; if (!l) continue; const cd = code[s];
    if (cd >= 2 ** l) throw new Error('Corrupt PIZ data (code)');
    if (l > HUF_DECBITS) { const k = Math.floor(cd / 2 ** (l - HUF_DECBITS)); if (dLen[k]) throw new Error('Corrupt PIZ data'); (dLong[k] ??= []).push(s); }
    else { const k0 = cd * 2 ** (HUF_DECBITS - l), m = 2 ** (HUF_DECBITS - l); for (let k = 0; k < m; k++) { dLen[k0 + k] = l; dLit[k0 + k] = s; } }
  }
  // The codes start at the next whole byte.
  c = 0; lc = 0;
  const out = new Uint16Array(nRaw); let o = 0;
  const bitEnd = q + Math.ceil(nBits / 8);
  if (bitEnd > p + n) throw new Error('Corrupt PIZ data (bits)');
  const emit = (s: number) => {
    if (s === iM) { // a run of the previous value
      if (lc < 8) pull();
      const run = take(8); if (!o || o + run > nRaw) throw new Error('Corrupt PIZ data (run length)');
      const prev = out[o - 1]; for (let k = 0; k < run; k++) out[o++] = prev;
    } else { if (o >= nRaw) throw new Error('Corrupt PIZ data (too long)'); out[o++] = s; }
  };
  while (q < bitEnd) {
    pull();
    while (lc >= HUF_DECBITS) {
      const k = Math.floor(c / 2 ** (lc - HUF_DECBITS));
      if (dLen[k]) { take(dLen[k]); emit(dLit[k]); continue; }
      const cands = dLong[k]; if (!cands) throw new Error('Corrupt PIZ data (code)');
      let found = false;
      for (const s of cands) {
        const l = hlen[s];
        while (lc < l && q < bitEnd) pull();
        if (lc >= l && Math.floor(c / 2 ** (lc - l)) === code[s]) { take(l); emit(s); found = true; break; }
      }
      if (!found) throw new Error('Corrupt PIZ data (long code)');
    }
  }
  // The last byte's unused bits, then what is left in the reader.
  const extra = (8 - nBits) & 7; c = Math.floor(c / 2 ** extra); lc -= extra;
  while (lc > 0) {
    const k = Math.floor(c * 2 ** (HUF_DECBITS - lc));
    if (!dLen[k] || dLen[k] > lc) throw new Error('Corrupt PIZ data (tail)');
    take(dLen[k]); emit(dLit[k]);
  }
  if (o !== nRaw) throw new Error('Corrupt PIZ data (length)');
  return out;
}
function wdec14(l: number, h: number): [number, number] {
  const ls = (l << 16) >> 16, hs = (h << 16) >> 16, ai = ls + (hs & 1) + (hs >> 1);
  return [ai & 0xffff, (ai - hs) & 0xffff];
}
function wdec16(l: number, h: number): [number, number] {
  const bb = (l - (h >> 1)) & 0xffff, aa = (h + bb - 0x8000) & 0xffff;
  return [aa, bb];
}
function wav2Decode(b: Uint16Array, base: number, nx: number, ox: number, ny: number, oy: number, mx: number): void {
  const w14 = mx < 1 << 14, dec = w14 ? wdec14 : wdec16, n = Math.min(nx, ny);
  let p = 1; while (p <= n) p <<= 1; p >>= 1;
  let p2 = p; p >>= 1;
  while (p >= 1) {
    let py = base;
    const ey = base + oy * (ny - p2), oy1 = oy * p, oy2 = oy * p2, ox1 = ox * p, ox2 = ox * p2;
    for (; py <= ey; py += oy2) {
      let px = py;
      const ex = py + ox * (nx - p2);
      for (; px <= ex; px += ox2) {
        const p01 = px + ox1, p10 = px + oy1, p11 = p10 + ox1;
        const [i00, i10] = dec(b[px], b[p10]), [i01, i11] = dec(b[p01], b[p11]);
        [b[px], b[p01]] = dec(i00, i01); [b[p10], b[p11]] = dec(i10, i11);
      }
      if (nx & p) { const p10 = px + oy1; const [i00, i10] = dec(b[px], b[p10]); b[p10] = i10; b[px] = i00; }
    }
    if (ny & p) {
      let px = py; const ex = py + ox * (nx - p2);
      for (; px <= ex; px += ox2) { const p01 = px + ox1; const [i00, i01] = dec(b[px], b[p01]); b[p01] = i01; b[px] = i00; }
    }
    p2 = p; p >>= 1;
  }
}
interface Plane { ch: Channel; nx: number; ny: number; size: number }
function planesOf(chs: Channel[], x0: number, y0: number, w: number, h: number): Plane[] {
  const count = (start: number, n: number, s: number) => { let k = 0; for (let i = start; i < start + n; i++) if (((i % s) + s) % s === 0) k++; return k; };
  return chs.map((ch) => ({ ch, nx: count(x0, w, ch.xs), ny: count(y0, h, ch.ys), size: BYTES[ch.type] / 2 }));
}
/** From channel-planar 16-bit words back to the per-scanline layout. */
function interleave(words: Uint16Array, planes: Plane[], y0: number, h: number): Uint8Array {
  const total = planes.reduce((a, p) => a + p.nx * p.ny * p.size, 0), out = new Uint8Array(total * 2);
  const starts: number[] = []; let s = 0; for (const p of planes) { starts.push(s); s += p.nx * p.ny * p.size; }
  const rowIdx = planes.map(() => 0); let o = 0;
  for (let y = y0; y < y0 + h; y++) planes.forEach((p, i) => {
    if (((y % p.ch.ys) + p.ch.ys) % p.ch.ys) return;
    const n = p.nx * p.size, from = starts[i] + rowIdx[i] * n; rowIdx[i]++;
    for (let k = 0; k < n; k++) { const v = words[from + k]; out[o++] = v & 255; out[o++] = v >> 8; }
  });
  return out;
}
function piz(src: Uint8Array, planes: Plane[], y0: number, h: number): Uint8Array {
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const total = planes.reduce((a, p) => a + p.nx * p.ny * p.size, 0);
  const minNZ = dv.getUint16(0, true), maxNZ = dv.getUint16(2, true);
  if (maxNZ >= 8192) throw new Error('Corrupt PIZ data (bitmap)');
  const bitmap = new Uint8Array(8192); let q = 4;
  if (minNZ <= maxNZ) { bitmap.set(src.subarray(q, q + maxNZ - minNZ + 1), minNZ); q += maxNZ - minNZ + 1; }
  const lut = new Uint16Array(65536); let k = 0;
  for (let i = 0; i < 65536; i++) if (i === 0 || bitmap[i >> 3] & (1 << (i & 7))) lut[k++] = i;
  const maxValue = k - 1;
  const len = dv.getInt32(q, true); q += 4;
  const words = hufDecode(src, q, len, total);
  let base = 0;
  for (const p of planes) { for (let j = 0; j < p.size; j++) wav2Decode(words, base + j, p.nx, p.size, p.ny, p.nx * p.size, maxValue); base += p.nx * p.ny * p.size; }
  for (let i = 0; i < words.length; i++) words[i] = lut[words[i]];
  return interleave(words, planes, y0, h);
}
function pxr24(src: Uint8Array, planes: Plane[], y0: number, h: number): Uint8Array {
  const total = planes.reduce((a, p) => a + p.nx * p.ny * (p.ch.type === 1 ? 2 : p.ch.type === 2 ? 3 : 4), 0);
  const t = zip(src, total), outSize = planes.reduce((a, p) => a + p.nx * p.ny * p.size * 2, 0), out = new Uint8Array(outSize);
  let ti = 0, o = 0;
  for (let y = y0; y < y0 + h; y++) for (const p of planes) {
    if (((y % p.ch.ys) + p.ch.ys) % p.ch.ys) continue;
    const n = p.nx;
    if (p.ch.type === 1) { let px = 0; for (let j = 0; j < n; j++) { px = (px + ((t[ti + j] << 8) | t[ti + n + j])) & 0xffff; out[o++] = px & 255; out[o++] = px >> 8; } ti += 2 * n; }
    else { const k = p.ch.type === 2 ? 3 : 4; let px = 0; for (let j = 0; j < n; j++) { const d = ((t[ti + j] << 24) | (t[ti + n + j] << 16) | (t[ti + 2 * n + j] << 8) | (k === 4 ? t[ti + 3 * n + j] : 0)) >>> 0; px = (px + d) >>> 0; out[o++] = px & 255; out[o++] = (px >> 8) & 255; out[o++] = (px >> 16) & 255; out[o++] = px >>> 24; } ti += k * n; }
  }
  return out;
}
function b44(src: Uint8Array, planes: Plane[], y0: number, h: number): Uint8Array {
  const total = planes.reduce((a, p) => a + p.nx * p.ny * p.size, 0), words = new Uint16Array(total);
  let q = 0, base = 0;
  const s = new Uint16Array(16);
  for (const p of planes) {
    if (p.ch.type !== 1) { // stored as they are
      const n = p.nx * p.ny * p.size; for (let i = 0; i < n; i++) words[base + i] = src[q + 2 * i] | (src[q + 2 * i + 1] << 8); q += 2 * n; base += n; continue;
    }
    for (let by = 0; by < p.ny; by += 4) for (let bx = 0; bx < p.nx; bx += 4) {
      const b = src.subarray(q);
      if (b[2] >= 13 << 2) { // flat block (B44A)
        let v = (b[0] << 8) | b[1]; v = v & 0x8000 ? v & 0x7fff : ~v & 0xffff; s.fill(v); q += 3;
      } else {
        s[0] = (b[0] << 8) | b[1];
        const shift = b[2] >> 2, bias = 0x20 << shift, d = (x: number) => (x << shift) - bias;
        s[4] = s[0] + d((((b[2] << 4) | (b[3] >> 4)) & 0x3f)); s[8] = s[4] + d((((b[3] << 2) | (b[4] >> 6)) & 0x3f)); s[12] = s[8] + d(b[4] & 0x3f);
        s[1] = s[0] + d(b[5] >> 2); s[5] = s[4] + d((((b[5] << 4) | (b[6] >> 4)) & 0x3f)); s[9] = s[8] + d((((b[6] << 2) | (b[7] >> 6)) & 0x3f)); s[13] = s[12] + d(b[7] & 0x3f);
        s[2] = s[1] + d(b[8] >> 2); s[6] = s[5] + d((((b[8] << 4) | (b[9] >> 4)) & 0x3f)); s[10] = s[9] + d((((b[9] << 2) | (b[10] >> 6)) & 0x3f)); s[14] = s[13] + d(b[10] & 0x3f);
        s[3] = s[2] + d(b[11] >> 2); s[7] = s[6] + d((((b[11] << 4) | (b[12] >> 4)) & 0x3f)); s[11] = s[10] + d((((b[12] << 2) | (b[13] >> 6)) & 0x3f)); s[15] = s[14] + d(b[13] & 0x3f);
        for (let i = 0; i < 16; i++) s[i] = s[i] & 0x8000 ? s[i] & 0x7fff : ~s[i] & 0xffff;
        q += 14;
      }
      for (let yy = 0; yy < 4 && by + yy < p.ny; yy++) for (let xx = 0; xx < 4 && bx + xx < p.nx; xx++) words[base + (by + yy) * p.nx + bx + xx] = s[yy * 4 + xx];
    }
    base += p.nx * p.ny;
  }
  return interleave(words, planes, y0, h);
}

/**
 * ZSTD (OpenEXR 3.4+): a 24-byte prefix ("zstd-exr", wire version, flags, payload size), then a Zstandard frame
 * holding one or two segments (the 16-bit channels' rows, then the 32-bit ones), each a 64-bit length and its
 * bytes split into planes (all first bytes, then all second bytes, …). Version 2 with flag 1 also stored each
 * channel row as differences between neighbouring samples. Undone in reverse, back to the scanline layout.
 */
function zstdExr(src: Uint8Array, planes: Plane[], y0: number, h: number): Uint8Array {
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  if (src.length < 24 || String.fromCharCode(...src.subarray(0, 8)) !== 'zstd-exr') throw new Error('Damaged OpenEXR ZSTD block');
  const format = dv.getUint32(8, true), flags = dv.getUint32(12, true), size = dv.getUint32(16, true) + dv.getUint32(20, true) * 4294967296;
  if ((format !== 1 && format !== 2) || 24 + size > src.length) throw new Error('Damaged OpenEXR ZSTD block');
  const inner = zstdDecompress(src.subarray(24, 24 + size)), iv = new DataView(inner.buffer, inner.byteOffset, inner.byteLength);
  // Rows of the block in file order, and where each sits in the sorted layout (2-byte rows first, then 4-byte).
  type Row = { y: number; p: number; n: number; bpe: number; sorted: number };
  const rows: Row[] = [];
  for (let y = y0; y < y0 + h; y++) planes.forEach((pl, p) => { if (!(((y % pl.ch.ys) + pl.ch.ys) % pl.ch.ys)) rows.push({ y, p, n: pl.nx, bpe: BYTES[pl.ch.type], sorted: 0 }); });
  let at = 0;
  for (const r of rows) if (r.bpe === 2) { r.sorted = at; at += r.n * 2; }
  const split = at;
  for (const r of rows) if (r.bpe === 4) { r.sorted = at; at += r.n * 4; }
  const total = at, sorted = new Uint8Array(total);
  const segs: [number, number][] = split > 0 && total > split ? [[split, 2], [total - split, 4]] : [[total, split === 0 ? 4 : 2]];
  let q = 0, t = 0;
  for (const [len, el] of segs) {
    if (q + 8 > inner.length || iv.getUint32(q, true) !== len || iv.getUint32(q + 4, true) !== 0 || q + 8 + len > inner.length) throw new Error('Damaged OpenEXR ZSTD block (segment)');
    q += 8;
    const n = len / el;
    for (let i = 0; i < n; i++) for (let b = 0; b < el; b++) sorted[t + i * el + b] = inner[q + b * n + i];
    q += len; t += len;
  }
  if (format === 2 && flags & 1) { // per-row prefix sums of 16- and 32-bit samples
    const sv = new DataView(sorted.buffer);
    for (const r of rows) {
      if (r.bpe === 2) for (let k = 1; k < r.n; k++) sv.setUint16(r.sorted + k * 2, sv.getUint16(r.sorted + k * 2, true) + sv.getUint16(r.sorted + k * 2 - 2, true), true);
      else for (let k = 1; k < r.n; k++) sv.setUint32(r.sorted + k * 4, (sv.getUint32(r.sorted + k * 4, true) + sv.getUint32(r.sorted + k * 4 - 4, true)) >>> 0, true);
    }
  }
  const out = new Uint8Array(total); let o = 0;
  for (const r of rows) { out.set(sorted.subarray(r.sorted, r.sorted + r.n * r.bpe), o); o += r.n * r.bpe; }
  return out;
}

/**
 * HTJ2K256 / HTJ2K32 (OpenEXR 3.4+): an 'HT' header mapping codestream components to channels, then a lossless
 * High-Throughput JPEG 2000 codestream (decoded by OpenJPH) whose 16-bit samples are the HALF values' bits.
 */
function htj2kExr(src: Uint8Array, planes: Plane[], h: number): Uint8Array {
  if (planes.some((p) => p.ch.type !== 1)) throw new Error('OpenEXR HTJ2K blocks with FLOAT or UINT channels are not supported yet');
  if (planes.some((p) => p.ch.xs !== 1 || p.ch.ys !== 1)) throw new Error('OpenEXR HTJ2K with subsampled channels is not supported yet');
  const { map, codestream } = exrHtHeader(src);
  if (map.length !== planes.length) throw new Error('Damaged OpenEXR HTJ2K block (channel map)');
  const d = decodeHtj2k16(codestream), w = planes[0].nx;
  if (d.components !== planes.length || d.width < w || d.height < h) throw new Error('Damaged OpenEXR HTJ2K block (size)');
  const compOf: number[] = []; map.forEach((c, k) => { compOf[c] = k; });
  const n = d.components, out = new Uint8Array(h * planes.length * w * 2); let o = 0;
  for (let y = 0; y < h; y++) for (let c = 0; c < planes.length; c++) {
    const k = compOf[c];
    for (let x = 0; x < w; x++) { const v = d.samples[(y * d.width + x) * n + k]; out[o++] = v & 255; out[o++] = v >> 8; }
  }
  return out;
}

/** True when a part of the file is HTJ2K-compressed (the decoder must be loaded first). */
export function exrNeedsHtj2k(u8: Uint8Array): boolean { try { return parse(u8).headers.some((h) => h.compression === 10 || h.compression === 11); } catch { return false; } }

/** Decodes one block (or tile) of `w` × `h` pixels starting at (x0, y0) into the uncompressed layout. */
function decompress(comp: number, src: Uint8Array, chs: Channel[], x0: number, y0: number, w: number, h: number): Uint8Array {
  const planes = planesOf(chs, x0, y0, w, h), size = planes.reduce((a, p) => a + p.nx * p.ny * p.size * 2, 0);
  if (src.length === size && comp !== 0) return src; // stored uncompressed when compression would not help
  switch (comp) {
    case 0: return src;
    case 1: return predictReorder(rle(src, size));
    case 2: case 3: return predictReorder(zip(src, size));
    case 4: return piz(src, planes, y0, h);
    case 5: return pxr24(src, planes, y0, h);
    case 6: case 7: return b44(src, planes, y0, h);
    case 13: return zstdExr(src, planes, y0, h);
    case 10: case 11: return htj2kExr(src, planes, h);
    case 8: case 9: return decodeDwa(src, planes, y0, h, { half: HALF, huffman: hufDecode, zlib: zip, rle, predictReorder });
    default: throw new Error(`OpenEXR ${COMPRESSION[comp] || comp} compression is not supported yet`);
  }
}

/** Full-resolution float planes of one part. */
function decodePart(u8: Uint8Array, h: Header, offsets: number[], multipart: boolean): { w: number; ht: number; data: Map<string, Float32Array> } {
  const w = h.x1 - h.x0 + 1, ht = h.y1 - h.y0 + 1;
  if (w <= 0 || ht <= 0 || w * ht > 100_000_000) throw new Error('Bad or too large OpenEXR data window');
  const data = new Map<string, Float32Array>(); for (const c of h.channels) data.set(c.name, new Float32Array(w * ht));
  const put = (raw: Uint8Array, bx: number, by: number, bw: number, bh: number) => {
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength); let o = 0;
    for (let y = by; y < by + bh; y++) for (const c of h.channels) {
      if (((y % c.ys) + c.ys) % c.ys) continue;
      const plane = data.get(c.name)!, row = (y - h.y0) * w;
      for (let x = bx; x < bx + bw; x++) {
        if (((x % c.xs) + c.xs) % c.xs) continue;
        if (o + BYTES[c.type] > raw.length) return;
        const v = c.type === 1 ? HALF[dv.getUint16(o, true)] : c.type === 2 ? dv.getFloat32(o, true) : dv.getUint32(o, true);
        o += BYTES[c.type];
        // Subsampled channels fill their whole cell.
        for (let yy = y; yy < Math.min(y + c.ys, by + bh); yy++) for (let xx = x; xx < Math.min(x + c.xs, bx + bw); xx++) plane[(yy - h.y0) * w + (xx - h.x0)] = v;
        void row;
      }
    }
  };
  for (const off of offsets) {
    if (!off || off >= u8.length) continue;
    const r = new R(u8, off); if (multipart) r.i32();
    if (h.tiled) {
      const tx = r.i32(), ty = r.i32(), lx = r.i32(), ly = r.i32(), n = r.i32();
      if (lx || ly) continue; // reduced levels
      const bx = h.x0 + tx * h.tileW, by = h.y0 + ty * h.tileH, bw = Math.min(h.tileW, h.x1 - bx + 1), bh = Math.min(h.tileH, h.y1 - by + 1);
      put(decompress(h.compression, u8.subarray(r.p, r.p + n), h.channels, bx, by, bw, bh), bx, by, bw, bh);
    } else {
      const y = r.i32(), n = r.i32(), bh = Math.min(LINES[h.compression], h.y1 - y + 1);
      put(decompress(h.compression, u8.subarray(r.p, r.p + n), h.channels, h.x0, y, w, bh), h.x0, y, w, bh);
    }
  }
  return { w, ht: ht, data };
}

const srgb = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
function parse(u8: Uint8Array): { headers: Header[]; tables: number[][]; multipart: boolean } {
  if (!isExr(u8)) throw new Error('Not an OpenEXR file');
  const flags = u8[5] | (u8[6] << 8) | (u8[7] << 16);
  if (flags & 0x8) throw new Error('Deep OpenEXR data is not supported');
  const multipart = !!(flags & 0x10), singleTiled = !!(flags & 0x2);
  const r = new R(u8, 8), headers: Header[] = [];
  for (;;) { const h = readHeader(r); if (!h) break; if (singleTiled) h.tiled = true; headers.push(h); if (!multipart) break; }
  if (!headers.length) throw new Error('OpenEXR file without a header');
  // Offset tables, one per part.
  const tables = headers.map((h) => {
    let n = h.chunkCount ?? 0;
    if (!n) {
      if (h.tiled) {
        const w = h.x1 - h.x0 + 1, ht = h.y1 - h.y0 + 1; n = 0;
        if (h.levelMode === 0) n = Math.ceil(w / h.tileW) * Math.ceil(ht / h.tileH);
        else { // mip map: halve until 1 × 1 (rounding down); the first level is all that is read, but the table counts them all
          let lw = w, lh = ht; for (;;) { n += Math.ceil(lw / h.tileW) * Math.ceil(lh / h.tileH); if (lw === 1 && lh === 1) break; lw = Math.max(1, lw >> 1); lh = Math.max(1, lh >> 1); }
          if (h.levelMode === 2) n = n * 4; // rip maps: generous; offsets past the table are skipped as zero/invalid
        }
      } else n = Math.ceil((h.y1 - h.y0 + 1) / LINES[h.compression]);
    }
    const t: number[] = []; for (let i = 0; i < n; i++) t.push(r.u64());
    return t;
  });
  return { headers, tables, multipart };
}

/** The linear channel values of the first part (for tests and tools). */
export function exrChannels(u8: Uint8Array): { width: number; height: number; channels: Map<string, Float32Array> } {
  const { headers, tables, multipart } = parse(u8), { w, ht, data } = decodePart(u8, headers[0], tables[0], multipart);
  return { width: w, height: ht, channels: data };
}

export function decodeExr(u8: Uint8Array, opts: { exposure?: number } = {}): DecodeResult {
  const { headers, tables, multipart } = parse(u8);
  const pages: DecodedPage[] = [], warnings: string[] = [], info: Record<string, string> = {};
  headers.forEach((h, i) => {
    if (h.type && /deep/.test(h.type)) { warnings.push(`Part ${i + 1} (${h.name || 'deep'}) holds deep data, which is not shown`); return; }
    if (h.compression === 12 || h.compression > 13) { warnings.push(`Part ${i + 1}: OpenEXR ${COMPRESSION[h.compression] || h.compression} compression is not supported yet`); return; }
    if (h.levelMode === 2) warnings.push(`Part ${i + 1}: a rip map; its full-resolution level is shown`);
    const { w, ht, data } = decodePart(u8, h, tables[i], multipart);
    // Which channels to show.
    const names = [...data.keys()], has = (n: string) => data.has(n);
    let layer = '';
    if (!has('R') && !has('Y')) { const m = names.find((n) => /\.(R|r|red)$/.test(n)); if (m) layer = m.slice(0, m.lastIndexOf('.') + 1); }
    const get = (c: string) => data.get(layer + c) || data.get(layer + c.toLowerCase());
    let R = get('R'), G = get('G'), B = get('B');
    const A = get('A');
    let mode = 'RGB';
    if (!R && has('Y')) {
      const Y = data.get('Y')!, RY = data.get('RY'), BY = data.get('BY');
      if (RY && BY) {
        // Luminance/chroma (Rec. 709 weights, as OpenEXR's RgbaYca uses by default).
        R = new Float32Array(w * ht); G = new Float32Array(w * ht); B = new Float32Array(w * ht); mode = 'luminance/chroma';
        for (let k = 0; k < w * ht; k++) { const y = Y[k], r = (RY[k] + 1) * y, b = (BY[k] + 1) * y; R[k] = r; B[k] = b; G[k] = (y - r * 0.2126 - b * 0.0722) / 0.7152; }
      } else { R = G = B = Y; mode = 'luminance'; }
    }
    if (!R) { const first = data.get(names[0])!; R = G = B = first; mode = `channel ${names[0]}`; }
    G ??= R; B ??= R;
    const out = makeRaster(w, ht), d = out.data, scale = opts.exposure ?? 1;
    let maxLum = 0;
    for (let k = 0; k < w * ht; k++) {
      const a = A ? Math.max(0, Math.min(1, A[k])) : 1, un = A && a > 0 ? 1 / a : 1; // premultiplied
      const r = R![k] * un * scale, g = G![k] * un * scale, b = B![k] * un * scale;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b; if (lum > maxLum) maxLum = lum;
      const q = k * 4;
      d[q] = Math.round(255 * srgb(Math.max(0, Math.min(1, r || 0)))); d[q + 1] = Math.round(255 * srgb(Math.max(0, Math.min(1, g || 0)))); d[q + 2] = Math.round(255 * srgb(Math.max(0, Math.min(1, b || 0))));
      d[q + 3] = A ? Math.round(a * 255) : 255;
    }
    const types = [...new Set(h.channels.map((c) => ['UINT', 'HALF', 'FLOAT'][c.type]))].join('/');
    pages.push({ width: w, height: ht, frames: [{ raster: out, delay: 0 }], loops: 0, bitDepth: 16 * (A ? 4 : 3), hasAlpha: !!A, notes: [
      `OpenEXR ${h.tiled ? 'tiled' : 'scanline'}${headers.length > 1 ? ` part ${i + 1}${h.name ? ` (${h.name})` : ''}` : ''}, ${COMPRESSION[h.compression]}, ${types}`,
      `${mode}${layer ? ` of layer ${layer.slice(0, -1)}` : ''}; channels ${names.join(', ')}`,
      `tone-mapped at exposure ${scale} (brightest pixel ${maxLum.toPrecision(3)}×)`,
    ] });
  });
  if (!pages.length) throw new Error(warnings[0] || 'No OpenEXR part can be shown');
  Object.assign(info, headers[0].attrs);
  return { pages, info, warnings };
}
