/**
 * Formats from the 1980s and 1990s, read by the app's own code from their published descriptions:
 * - MacPaint (.mac, .pntg): 576 × 720, 1 bit, PackBits rows; a MacBinary header in front is skipped.
 * - IFF ILBM and PBM (Amiga, Deluxe Paint): 1–8 bitplanes with a palette, Extra Half-Brite, HAM6 and HAM8,
 *   24- and 32-bit (deep) ILBM, the chunky PBM of Deluxe Paint II, ByteRun1 compression, masks and transparent
 *   colors, 4-bit (OCS) palettes widened to 8 bits, and color cycling (CRNG/CCRT) played as an animation.
 * - Kodak Photo CD (.pcd): the Base image (768 × 512) from its Photo YCC samples (4:2:0) with Kodak's
 *   conversion, turned as the disc's orientation says. The higher resolutions (4Base, 16Base, Huffman-coded
 *   residuals) are not decoded.
 */
import { makeRaster, type DecodeResult, type DecodedPage, type Raster } from './raster';
import { framesWithin, decodeLimits } from './limits';

const be16 = (u: Uint8Array, o: number) => (u[o] << 8) | u[o + 1];
const be32 = (u: Uint8Array, o: number) => ((u[o] << 24) | (u[o + 1] << 16) | (u[o + 2] << 8) | u[o + 3]) >>> 0;
const tag = (u: Uint8Array, o: number) => String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]);

/** PackBits / ByteRun1: n ≥ 0 copies n + 1 bytes, −127…−1 repeats the next byte 1 − n times, −128 is a no-op. */
function unpackBits(src: Uint8Array, p: number, out: Uint8Array, o: number, n: number): number {
  const end = o + n;
  while (o < end && p < src.length) {
    const c = (src[p++] << 24) >> 24;
    if (c >= 0) { const k = Math.min(c + 1, end - o, src.length - p); out.set(src.subarray(p, p + k), o); o += k; p += c + 1; }
    else if (c !== -128) { const k = Math.min(1 - c, end - o); out.fill(src[p++] ?? 0, o, o + k); o += k; }
  }
  return p;
}

// MacPaint --------------------------------------------------------------------------------------------
/** True when a MacBinary header names a MacPaint document (type PNTG). */
export const isMacBinaryPaint = (u8: Uint8Array): boolean => u8.length > 640 && u8[0] === 0 && u8[1] > 0 && u8[1] < 64 && tag(u8, 65) === 'PNTG';
export function decodeMacPaint(u8: Uint8Array): DecodeResult {
  const mb = isMacBinaryPaint(u8), start = mb ? 128 : 0;
  const version = be32(u8, start), rows = new Uint8Array(720 * 72);
  unpackBits(u8, start + 512, rows, 0, rows.length);
  const r = makeRaster(576, 720), d = r.data;
  for (let i = 0; i < 576 * 720; i++) { const v = (rows[i >> 3] >> (7 - (i & 7))) & 1 ? 0 : 255; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
  const name = mb ? new TextDecoder('macintosh').decode(u8.subarray(2, 2 + u8[1])) : '';
  return { pages: [{ width: 576, height: 720, frames: [{ raster: r, delay: 0 }], loops: 0, bitDepth: 1, hasAlpha: false, dpi: [72, 72], notes: [`MacPaint document${version ? ` (version ${version})` : ''}${mb ? `, in a MacBinary file "${name}"` : ''}`] }], info: {}, warnings: [] };
}

// IFF ILBM / PBM -------------------------------------------------------------------------------------
export const isIff = (u8: Uint8Array): boolean => u8.length > 12 && tag(u8, 0) === 'FORM' && (tag(u8, 8) === 'ILBM' || tag(u8, 8) === 'PBM ');

interface Crng { low: number; high: number; rate: number; reverse: boolean }
export function decodeIff(u8: Uint8Array): DecodeResult {
  const pbm = tag(u8, 8) === 'PBM ', warnings: string[] = [];
  let w = 0, h = 0, planes = 0, masking = 0, compression = 0, transparent = 0, xAsp = 1, yAsp = 1;
  let cmap: number[][] = [], camg = 0, body: Uint8Array | null = null, fourBit = false;
  const ranges: Crng[] = [];
  const end = Math.min(u8.length, 8 + be32(u8, 4));
  for (let p = 12; p + 8 <= end;) {
    const id = tag(u8, p), len = be32(u8, p + 4), a = p + 8;
    if (a + len > u8.length) { warnings.push(`The ${id.trim()} chunk is cut short`); }
    const b = u8.subarray(a, Math.min(a + len, u8.length));
    if (id === 'BMHD' && b.length >= 20) { w = be16(b, 0); h = be16(b, 2); planes = b[8]; masking = b[9]; compression = b[10]; transparent = be16(b, 12); xAsp = b[14] || 1; yAsp = b[15] || 1; }
    else if (id === 'CMAP') { cmap = []; for (let i = 0; i + 2 < b.length; i += 3) cmap.push([b[i], b[i + 1], b[i + 2]]); }
    else if (id === 'CAMG' && b.length >= 4) camg = be32(b, 0);
    else if (id === 'BODY') body = b;
    else if (id === 'CRNG' && b.length >= 8) { const rate = be16(b, 2), flags = be16(b, 4); if (flags & 1 && rate) ranges.push({ low: b[6], high: b[7], rate, reverse: !!(flags & 2) }); }
    else if (id === 'CCRT' && b.length >= 14) { const dir = (be16(b, 0) << 16) >> 16, secs = be32(b, 4), micros = be32(b, 8); if (dir && (secs || micros)) ranges.push({ low: b[2], high: b[3], rate: Math.max(1, Math.round(16384 / ((secs + micros / 1e6) * 60))), reverse: dir < 0 }); }
    p = a + len + (len & 1);
  }
  if (!w || !h || !body) throw new Error('This IFF picture has no BMHD or BODY chunk');
  if (w * h > 100e6) throw new Error('IFF picture too large');
  // Old (OCS) palettes keep 4 bits in the high nibble: widen them.
  if (cmap.length && cmap.every((c) => c.every((v) => (v & 15) === 0))) { fourBit = true; cmap = cmap.map((c) => c.map((v) => v | (v >> 4))); }
  const ham = !pbm && !!(camg & 0x800) && (planes === 6 || planes === 8), ehb = !pbm && !!(camg & 0x80) && planes === 6 && !ham;
  if (ehb && cmap.length < 64) { const half = cmap.slice(0, 32).map((c) => c.map((v) => v >> 1)); cmap = [...cmap.slice(0, 32), ...half]; }
  // Rows of indexes (or deep RGB) out of the BODY.
  const rowBytes = ((w + 15) >> 4) << 1, nPlanes = planes + (masking === 1 ? 1 : 0);
  const idx = new Uint32Array(w * h), mask = masking === 1 ? new Uint8Array(w * h) : null;
  let p = 0;
  const row = new Uint8Array(pbm ? w + (w & 1) : rowBytes * nPlanes);
  for (let y = 0; y < h; y++) {
    if (compression === 1) {
      if (pbm) p = unpackBits(body, p, row, 0, row.length);
      else for (let k = 0; k < nPlanes; k++) p = unpackBits(body, p, row, k * rowBytes, rowBytes);
    } else if (compression === 0) { row.set(body.subarray(p, p + row.length)); p += row.length; }
    else throw new Error(`IFF compression ${compression} is not supported`);
    if (pbm) { for (let x = 0; x < w; x++) idx[y * w + x] = row[x]; continue; }
    for (let x = 0; x < w; x++) {
      const byte = x >> 3, bit = 7 - (x & 7); let v = 0;
      for (let k = 0; k < planes; k++) v |= ((row[k * rowBytes + byte] >> bit) & 1) << k;
      idx[y * w + x] = v >>> 0;
      if (mask) mask[y * w + x] = (row[planes * rowBytes + byte] >> bit) & 1;
    }
  }
  if (p < body.length - 2 && compression === 1) { /* extra data after the rows is harmless */ }
  const deep = !pbm && (planes === 24 || planes === 32);
  const color = (i: number): number[] => cmap[i] ?? [i * 255 / Math.max(1, (1 << Math.min(planes, 8)) - 1), i * 255 / Math.max(1, (1 << Math.min(planes, 8)) - 1), i * 255 / Math.max(1, (1 << Math.min(planes, 8)) - 1)].map(Math.round);
  const paint = (pal: number[][] | null): Raster => {
    const r = makeRaster(w, h), d = r.data;
    for (let y = 0; y < h; y++) {
      let cur = pal ? pal[0] ?? [0, 0, 0] : [0, 0, 0];
      for (let x = 0; x < w; x++) {
        const i = y * w + x, v = idx[i]; let c: number[];
        if (deep) c = [v & 255, (v >>> 8) & 255, (v >>> 16) & 255];
        else if (ham) {
          const bits = planes - 2, ctl = v >> bits, val = v & ((1 << bits) - 1);
          const ext = (val << (8 - bits)) | (bits === 4 ? val : val >> (2 * bits - 8)); // widen 4 or 6 bits to 8
          if (ctl === 0) c = (pal ?? cmap)[val] ?? [0, 0, 0];
          else { c = cur.slice(); c[ctl === 1 ? 2 : ctl === 2 ? 0 : 1] = ext; }
          cur = c;
        } else c = pal ? pal[v] ?? [0, 0, 0] : color(v);
        d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2];
        d[i * 4 + 3] = deep && planes === 32 ? (v >>> 24) & 255 : mask ? (mask[i] ? 255 : 0) : masking === 2 && !deep && !ham && v === transparent ? 0 : 255;
      }
    }
    return r;
  };
  const kind = pbm ? 'PBM (Deluxe Paint II, chunky)' : deep ? `${planes}-bit deep ILBM` : ham ? `HAM${planes}` : ehb ? 'Extra Half-Brite' : `${planes} bitplanes`;
  const notes = [`IFF ${pbm ? 'PBM' : 'ILBM'} (Amiga): ${kind}, ${compression ? 'ByteRun1' : 'uncompressed'}${cmap.length ? `, palette of ${cmap.length}${fourBit ? ' (4-bit, widened)' : ''}` : ''}`];
  if (camg & 0x8004) notes.push(`${camg & 0x8000 ? 'hi-res' : ''}${camg & 0x8000 && camg & 4 ? ' ' : ''}${camg & 4 ? 'interlaced' : ''} screen mode; pixel aspect ${xAsp}:${yAsp}`);
  const frames: { raster: Raster; delay: number }[] = [];
  const cycling = !deep && ranges.filter((r) => r.high > r.low && r.high < cmap.length);
  if (cycling && cycling.length) {
    // One frame per step of the slowest-moving range's full turn would be too many: step every active range once per
    // frame (up to 256 frames), timed by the fastest range (rate 16384 = 60 steps a second).
    // These frames are made here, not stored in the file: a large picture gets fewer of them (or none) rather than a gigabyte.
    const steps = Math.min(256, framesWithin(w, h, decodeLimits.synthPixels), Math.max(...cycling.map((r) => r.high - r.low + 1)));
    const delay = Math.max(20, Math.round(1000 * 16384 / (60 * Math.max(...cycling.map((r) => r.rate)))));
    let pal = cmap.map((c) => c.slice());
    for (let s = 0; s < steps; s++) {
      frames.push({ raster: paint(pal), delay });
      pal = pal.map((c) => c.slice());
      for (const r of cycling) {
        const seg = pal.slice(r.low, r.high + 1);
        const turned = r.reverse ? [...seg.slice(1), seg[0]] : [seg[seg.length - 1], ...seg.slice(0, -1)];
        turned.forEach((c, k) => { pal[r.low + k] = c; });
      }
    }
    notes.push(frames.length > 1 ? `color cycling: ${cycling.length} range${cycling.length > 1 ? 's' : ''}, played as an animation of ${frames.length} frames` : `color cycling: ${cycling.length} range${cycling.length > 1 ? 's' : ''}, not played (the picture is too large to animate)`);
  } else frames.push({ raster: paint(null), delay: 0 });
  const alpha = !!mask || masking === 2 || (deep && planes === 32);
  const page: DecodedPage = { width: w, height: h, frames, loops: 0, bitDepth: deep ? planes : Math.min(planes, 8), paletteSize: deep || ham ? undefined : cmap.length || undefined, hasAlpha: alpha, notes };
  return { pages: [page], info: {}, warnings };
}

// Kodak Photo CD -------------------------------------------------------------------------------------
export const isPcd = (u8: Uint8Array): boolean => u8.length > 0x30000 + 768 * 512 * 1.5 - 1 && String.fromCharCode(...u8.subarray(2048, 2055)) === 'PCD_IPI';
/** Kodak's Photo YCC → RGB (the Base image's 8-bit Y, C1, C2), clipped to 0…255. */
export function photoYcc(y: number, c1: number, c2: number): [number, number, number] {
  const l = 1.3584 * y, a = 2.2179 * (c1 - 156), b = 1.8215 * (c2 - 137);
  return [l + b, l - 0.194 * a - 0.509 * b, l + a];
}
export function decodePcd(u8: Uint8Array): DecodeResult {
  if (!isPcd(u8)) throw new Error('Not a Kodak Photo CD image (or cut short)');
  const W = 768, H = 512, off = 0x30000;
  const r = makeRaster(W, H), d = r.data;
  for (let y = 0; y < H; y += 2) {
    const p = off + (y >> 1) * W * 3, c1 = p + 2 * W, c2 = c1 + W / 2;
    for (let yy = 0; yy < 2; yy++) for (let x = 0; x < W; x++) {
      const [R, G, B] = photoYcc(u8[p + yy * W + x], u8[c1 + (x >> 1)], u8[c2 + (x >> 1)]);
      const o = ((y + yy) * W + x) * 4; d[o] = R; d[o + 1] = G; d[o + 2] = B; d[o + 3] = 255;
    }
  }
  // Orientation (as Pillow and ImageMagick read it): 1 turns the picture 90° counterclockwise, 3 clockwise; 0 and 2 leave it.
  const orientation = u8[0x0e02] & 3;
  let out: Raster = r;
  if (orientation === 1 || orientation === 3) {
    out = makeRaster(H, W);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const [nx, ny] = orientation === 1 ? [y, W - 1 - x] : [H - 1 - y, x];
      out.data.set(r.data.subarray((y * W + x) * 4, (y * W + x) * 4 + 4), (ny * H + nx) * 4);
    }
  }
  const notes = ['Kodak Photo CD: the Base image (768 × 512) from its Photo YCC samples, Kodak\'s conversion; 4Base and 16Base are not decoded'];
  if (orientation === 1 || orientation === 3) notes.push(`turned ${orientation === 1 ? 'counterclockwise' : 'clockwise'} as the disc's orientation says`);
  return { pages: [{ width: out.width, height: out.height, frames: [{ raster: out, delay: 0 }], loops: 0, bitDepth: 24, hasAlpha: false, notes }], info: {}, warnings: [] };
}
