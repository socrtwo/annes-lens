/**
 * Netpbm: PBM (P1/P4 bitmaps), PGM (P2/P5 gray), PPM (P3/P6 color), PAM (P7, any depth with a tuple
 * type) and PFM (Pf/PF floating point), up to 16 bits per sample, several pictures per raw file as
 * pages. Also writers for PGM, PPM and PAM.
 */
import { makeRaster, type DecodeResult, type DecodedPage, type Raster } from './raster';
import { latin1 } from './limits';

export function isPnm(u8: Uint8Array): boolean {
  if (u8.length < 3 || u8[0] !== 0x50) return false;
  const c = u8[1];
  const ws = u8[2] === 0x20 || u8[2] === 0x0a || u8[2] === 0x0d || u8[2] === 0x09 || u8[2] === 0x23;
  return ((c >= 0x31 && c <= 0x37) || c === 0x66 || c === 0x46) && ws;
}

class Tok {
  constructor(public u8: Uint8Array, public p = 0) {}
  /** Next whitespace-separated token, skipping comments. */
  next(): string {
    const u8 = this.u8;
    for (;;) {
      while (this.p < u8.length && isWs(u8[this.p])) this.p++;
      if (u8[this.p] === 0x23) { while (this.p < u8.length && u8[this.p] !== 0x0a && u8[this.p] !== 0x0d) this.p++; continue; }
      break;
    }
    const s = this.p;
    while (this.p < u8.length && !isWs(u8[this.p]) && u8[this.p] !== 0x23) this.p++;
    return latin1(u8, s, this.p);
  }
  int(): number { const t = this.next(); const v = parseInt(t, 10); if (!Number.isFinite(v)) throw new Error(`Bad number "${t}" in the header`); return v; }
  /** After the header of a raw format exactly one whitespace byte precedes the data. */
  skipOne(): void { if (this.p < this.u8.length && isWs(this.u8[this.p])) this.p++; }
  line(): string { const s = this.p; while (this.p < this.u8.length && this.u8[this.p] !== 0x0a) this.p++; const t = latin1(this.u8, s, this.p); this.p++; return t; }
}
const isWs = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0b || c === 0x0c;

export function decodePnm(u8: Uint8Array): DecodeResult {
  if (!isPnm(u8)) throw new Error('Not a Netpbm file');
  const warnings: string[] = [];
  const pages: DecodedPage[] = [];
  const t = new Tok(u8);
  let guard = 0;
  while (t.p < u8.length && guard++ < 10000) {
    const magic = t.next();
    if (!magic) break;
    if (!/^P[1-7fF]$/.test(magic)) { if (pages.length) break; throw new Error('Not a Netpbm file'); }
    const page = magic === 'P7' ? readPam(t, warnings) : magic === 'Pf' || magic === 'PF' ? readPfm(t, magic, warnings) : readPnm(t, magic, warnings);
    if (!page) break;
    pages.push(page);
    if (/^P[123]$/.test(magic)) break; // plain formats hold one picture
    while (t.p < u8.length && isWs(u8[t.p])) t.p++;
  }
  if (!pages.length) throw new Error('No picture in the file');
  return { pages, info: { kind: pages[0].notes[0] }, warnings };
}

function readPnm(t: Tok, magic: string, warnings: string[]): DecodedPage | null {
  const kind = magic[1];
  const bitmap = kind === '1' || kind === '4';
  const plain = kind <= '3';
  const w = t.int(), h = t.int();
  const maxval = bitmap ? 1 : t.int();
  if (!w || !h || w * h > 80_000_000) throw new Error('Bad dimensions');
  if (maxval < 1 || maxval > 65535) throw new Error(`Unsupported maxval ${maxval}`);
  const channels = kind === '3' || kind === '6' ? 3 : 1;
  const out = makeRaster(w, h);
  const d = out.data;
  const scale = (v: number) => (maxval === 255 ? v : Math.round((Math.min(v, maxval) * 255) / maxval));
  let truncated = false;
  if (plain) {
    if (bitmap) {
      // P1 digits may run together without spaces.
      let n = 0;
      const total = w * h;
      while (n < total && t.p < t.u8.length) {
        const c = t.u8[t.p++];
        if (c === 0x23) { while (t.p < t.u8.length && t.u8[t.p] !== 0x0a) t.p++; continue; }
        if (c !== 0x30 && c !== 0x31) continue;
        const v = c === 0x31 ? 0 : 255;
        const o = n++ * 4; d[o] = d[o + 1] = d[o + 2] = v; d[o + 3] = 255;
      }
      truncated = n < total;
    } else {
      const total = w * h * channels;
      let n = 0;
      for (; n < total; n++) {
        const tok = t.next();
        if (!tok) break;
        const v = scale(parseInt(tok, 10) || 0);
        const px = Math.floor(n / channels), ch = n % channels, o = px * 4;
        if (channels === 1) { d[o] = d[o + 1] = d[o + 2] = v; } else d[o + ch] = v;
        d[o + 3] = 255;
      }
      truncated = n < total;
    }
  } else {
    t.skipOne();
    const u8 = t.u8;
    if (bitmap) {
      const stride = Math.ceil(w / 8);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const b = u8[t.p + y * stride + (x >> 3)];
          if (b === undefined) { truncated = true; break; }
          const v = (b >> (7 - (x & 7))) & 1 ? 0 : 255;
          const o = (y * w + x) * 4; d[o] = d[o + 1] = d[o + 2] = v; d[o + 3] = 255;
        }
        if (truncated) break;
      }
      t.p += stride * h;
    } else {
      const bytes = maxval > 255 ? 2 : 1;
      const total = w * h;
      for (let i = 0; i < total; i++) {
        const o = i * 4, s = t.p + i * channels * bytes;
        if (s + channels * bytes > u8.length) { truncated = true; break; }
        const sample = (k: number) => (bytes === 2 ? scale((u8[s + k * 2] << 8) | u8[s + k * 2 + 1]) : scale(u8[s + k]));
        if (channels === 1) { d[o] = d[o + 1] = d[o + 2] = sample(0); } else { d[o] = sample(0); d[o + 1] = sample(1); d[o + 2] = sample(2); }
        d[o + 3] = 255;
      }
      t.p += total * channels * bytes;
    }
  }
  if (truncated) warnings.push('Pixel data is truncated; the rest is left black');
  const name = bitmap ? 'PBM bitmap' : channels === 1 ? 'PGM grayscale' : 'PPM color';
  return { width: w, height: h, frames: [{ raster: out, delay: 0 }], loops: 0, bitDepth: bitmap ? 1 : channels * (maxval > 255 ? 16 : 8), hasAlpha: false, notes: [`${name} (${plain ? 'plain text' : 'raw'}${maxval > 255 ? `, ${maxval + 1} levels` : ''})`] };
}

function readPam(t: Tok, warnings: string[]): DecodedPage | null {
  let w = 0, h = 0, depth = 0, maxval = 255, tupl = '';
  for (;;) {
    const line = t.line().trim();
    if (!line || line.startsWith('#')) { if (t.p >= t.u8.length) throw new Error('PAM header is incomplete'); continue; }
    const [k, ...rest] = line.split(/\s+/);
    const v = rest.join(' ');
    if (k === 'ENDHDR') break;
    else if (k === 'WIDTH') w = +v; else if (k === 'HEIGHT') h = +v; else if (k === 'DEPTH') depth = +v; else if (k === 'MAXVAL') maxval = +v; else if (k === 'TUPLTYPE') tupl = (tupl ? tupl + ' ' : '') + v;
    if (t.p >= t.u8.length) throw new Error('PAM header is incomplete');
  }
  if (!w || !h || !depth || w * h > 80_000_000) throw new Error('Bad PAM header');
  const bytes = maxval > 255 ? 2 : 1;
  const u8 = t.u8;
  const out = makeRaster(w, h);
  const d = out.data;
  const scale = (v: number) => (maxval === 255 ? v : Math.round((Math.min(v, maxval) * 255) / maxval));
  const total = w * h;
  const alpha = /ALPHA/.test(tupl) || depth === 2 || depth === 4;
  const bw = /BLACKANDWHITE/.test(tupl);
  let truncated = false;
  for (let i = 0; i < total; i++) {
    const s = t.p + i * depth * bytes, o = i * 4;
    if (s + depth * bytes > u8.length) { truncated = true; break; }
    const sample = (k: number) => { const v = bytes === 2 ? (u8[s + k * 2] << 8) | u8[s + k * 2 + 1] : u8[s + k]; return bw ? (v ? 255 : 0) : scale(v); };
    if (depth >= 3) { d[o] = sample(0); d[o + 1] = sample(1); d[o + 2] = sample(2); d[o + 3] = depth >= 4 ? sample(3) : 255; }
    else { d[o] = d[o + 1] = d[o + 2] = sample(0); d[o + 3] = depth === 2 ? sample(1) : 255; }
  }
  t.p += total * depth * bytes;
  if (truncated) warnings.push('Pixel data is truncated; the rest is left black');
  return { width: w, height: h, frames: [{ raster: out, delay: 0 }], loops: 0, bitDepth: depth * bytes * 8, hasAlpha: alpha, notes: [`PAM ${tupl || `${depth} channels`} (maxval ${maxval})`] };
}

function readPfm(t: Tok, magic: string, warnings: string[]): DecodedPage | null {
  const color = magic === 'PF';
  const w = t.int(), h = t.int();
  const scale = parseFloat(t.next());
  if (!w || !h || w * h > 80_000_000 || !Number.isFinite(scale)) throw new Error('Bad PFM header');
  t.skipOne();
  const little = scale < 0;
  const channels = color ? 3 : 1;
  const dv = new DataView(t.u8.buffer, t.u8.byteOffset, t.u8.byteLength);
  const total = w * h * channels;
  const vals = new Float32Array(total);
  let n = 0;
  for (; n < total; n++) { const o = t.p + n * 4; if (o + 4 > t.u8.length) break; vals[n] = dv.getFloat32(o, little); }
  if (n < total) warnings.push('Pixel data is truncated; the rest is left black');
  t.p += total * 4;
  // Tone map for display: scale by the picture's maximum and apply the sRGB curve (PFM is linear light).
  let max = 0;
  for (let i = 0; i < n; i++) if (vals[i] > max && Number.isFinite(vals[i])) max = vals[i];
  const norm = max > 1 ? 1 / max : 1;
  const out = makeRaster(w, h);
  const d = out.data;
  const srgb = (v: number) => { v = Math.max(0, Math.min(1, v * norm)); return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)); };
  for (let y = 0; y < h; y++) {
    const srcY = h - 1 - y; // PFM rows run bottom to top
    for (let x = 0; x < w; x++) {
      const s = (srcY * w + x) * channels, o = (y * w + x) * 4;
      if (color) { d[o] = srgb(vals[s]); d[o + 1] = srgb(vals[s + 1]); d[o + 2] = srgb(vals[s + 2]); } else d[o] = d[o + 1] = d[o + 2] = srgb(vals[s]);
      d[o + 3] = 255;
    }
  }
  return { width: w, height: h, frames: [{ raster: out, delay: 0 }], loops: 0, bitDepth: channels * 32, hasAlpha: false, notes: [`PFM ${color ? 'color' : 'grayscale'} floating point (${little ? 'little' : 'big'}-endian), tone-mapped${max > 1 ? ` from a maximum of ${max.toPrecision(3)}` : ''}`] };
}

/** Writes PPM (P6), PGM (P5) or PAM (P7 RGB_ALPHA / GRAYSCALE_ALPHA). */
export function encodePnm(r: Raster, kind: 'ppm' | 'pgm' | 'pam'): Uint8Array {
  const { width: w, height: h, data } = r;
  const enc = new TextEncoder();
  let header: string, body: Uint8Array;
  if (kind === 'pgm') {
    header = `P5\n${w} ${h}\n255\n`;
    body = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) body[j] = Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
  } else if (kind === 'ppm') {
    header = `P6\n${w} ${h}\n255\n`;
    body = new Uint8Array(w * h * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) { body[j] = data[i]; body[j + 1] = data[i + 1]; body[j + 2] = data[i + 2]; }
  } else {
    header = `P7\nWIDTH ${w}\nHEIGHT ${h}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`;
    body = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  const head = enc.encode(header);
  const out = new Uint8Array(head.length + body.length);
  out.set(head); out.set(body, head.length);
  return out;
}
