/**
 * PNG and APNG writer with the platform's CompressionStream (RGBA 8-bit, no filtering): the frames of
 * an animation become fcTL/fdAT chunks after a single IHDR, so every browser's PNG encoder differences
 * stay out of the way. Also ICO (PNG entries) and ICNS (PNG elements) writers for Export as Icon.
 */
import { crc32 } from '../meta/metaWrite';
import type { Raster } from './raster';

const ascii = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length); out.set(ascii(type), 4); out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}
function concat(parts: Uint8Array[]): Uint8Array { const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }

export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    // Stored deflate blocks (no compression) when the platform has no compressor.
    const parts: Uint8Array[] = [Uint8Array.from([0x78, 0x01])];
    for (let i = 0; i < data.length || i === 0; i += 65535) { const n = Math.min(65535, data.length - i); parts.push(Uint8Array.from([i + n >= data.length ? 1 : 0, n & 255, n >> 8, ~n & 255, (~n >> 8) & 255]), data.subarray(i, i + n)); if (!data.length) break; }
    let a = 1, b = 0; for (const v of data) { a = (a + v) % 65521; b = (b + a) % 65521; }
    parts.push(Uint8Array.from([(b >> 8) & 255, b & 255, (a >> 8) & 255, a & 255]));
    return concat(parts);
  }
  const cs = new CompressionStream('deflate');
  const w = cs.writable.getWriter();
  void w.write(data.slice()); void w.close();
  const r = cs.readable.getReader();
  const parts: Uint8Array[] = [];
  for (;;) { const { done, value } = await r.read(); if (done) break; parts.push(value); }
  return concat(parts);
}

const rows = (r: Raster): Uint8Array => { const out = new Uint8Array((r.width * 4 + 1) * r.height); for (let y = 0; y < r.height; y++) { out[y * (r.width * 4 + 1)] = 0; out.set(r.data.subarray(y * r.width * 4, (y + 1) * r.width * 4), y * (r.width * 4 + 1) + 1); } return out; };

export async function encodePng(r: Raster): Promise<Uint8Array> {
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer); dv.setUint32(0, r.width); dv.setUint32(4, r.height); ihdr[8] = 8; ihdr[9] = 6;
  return concat([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', await deflate(rows(r))), chunk('IEND', new Uint8Array(0))]);
}

/** APNG: every frame full-size, delays in milliseconds, loops 0 = forever. */
/** A frame delay in milliseconds as fcTL's 16-bit fraction of a second: the finest denominator that holds it (W26: over 65.5 s, ms wrapped). */
export function apngDelay(delayMs: number): [number, number] {
  const ms = Math.max(1, Math.round(delayMs || 0));
  for (const den of [1000, 100, 10]) { const num = Math.round((ms * den) / 1000); if (num <= 0xffff) return [Math.max(1, num), den]; }
  return [Math.min(0xffff, Math.round(ms / 1000)), 1];
}

export async function encodeApng(frames: { raster: Raster; delay: number }[], loops = 0): Promise<Uint8Array> {
  const w = frames[0].raster.width, h = frames[0].raster.height;
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer); dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6;
  const actl = new Uint8Array(8); new DataView(actl.buffer).setUint32(0, frames.length); new DataView(actl.buffer).setUint32(4, loops);
  const parts: Uint8Array[] = [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('acTL', actl)];
  let seq = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const fctl = new Uint8Array(26); const d = new DataView(fctl.buffer);
    d.setUint32(0, seq++); d.setUint32(4, f.raster.width); d.setUint32(8, f.raster.height); d.setUint32(12, 0); d.setUint32(16, 0);
    const [num, den] = apngDelay(f.delay); d.setUint16(20, num); d.setUint16(22, den); fctl[24] = 0; fctl[25] = 0;
    parts.push(chunk('fcTL', fctl));
    const z = await deflate(rows(f.raster));
    if (i === 0) parts.push(chunk('IDAT', z));
    else { const fd = new Uint8Array(4 + z.length); new DataView(fd.buffer).setUint32(0, seq++); fd.set(z, 4); parts.push(chunk('fdAT', fd)); }
  }
  parts.push(chunk('IEND', new Uint8Array(0)));
  return concat(parts);
}

/** ICO with PNG-compressed entries (sizes up to 256). */
export function encodeIco(entries: { size: number; png: Uint8Array }[]): Uint8Array {
  const head: number[] = [0, 0, 1, 0, entries.length & 255, entries.length >> 8];
  let offset = 6 + entries.length * 16;
  const dir: number[] = [];
  for (const e of entries) { dir.push(e.size >= 256 ? 0 : e.size, e.size >= 256 ? 0 : e.size, 0, 0, 1, 0, 32, 0, e.png.length & 255, (e.png.length >> 8) & 255, (e.png.length >> 16) & 255, (e.png.length >>> 24) & 255, offset & 255, (offset >> 8) & 255, (offset >> 16) & 255, (offset >>> 24) & 255); offset += e.png.length; }
  return concat([Uint8Array.from([...head, ...dir]), ...entries.map((e) => e.png)]);
}

const ICNS_TYPES: Record<number, string> = { 16: 'icp4', 32: 'icp5', 64: 'icp6', 128: 'ic07', 256: 'ic08', 512: 'ic09', 1024: 'ic10' };
/** ICNS with PNG elements for the standard sizes (others are skipped). */
export function encodeIcns(entries: { size: number; png: Uint8Array }[]): Uint8Array {
  const els: Uint8Array[] = [];
  for (const e of entries) { const t = ICNS_TYPES[e.size]; if (!t) continue; const hd = new Uint8Array(8); hd.set(ascii(t)); new DataView(hd.buffer).setUint32(4, 8 + e.png.length); els.push(hd, e.png); }
  const total = 8 + els.reduce((s, p) => s + p.length, 0);
  const hd = new Uint8Array(8); hd.set(ascii('icns')); new DataView(hd.buffer).setUint32(4, total);
  return concat([hd, ...els]);
}
