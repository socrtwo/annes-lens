/**
 * Baseline TIFF reader: every IFD (page) with 1, 2, 4, 8 or 16 bits per sample, bilevel, grayscale,
 * palette, RGB and RGBA (associated or unassociated alpha), uncompressed, PackBits, LZW (with the
 * horizontal predictor) or Deflate, CCITT RLE, Group 3 (1D and 2D) and Group 4, in strips or tiles, chunky
 * or planar, both byte orders and BigTIFF; 32-bit, signed and floating-point samples (with the
 * floating-point predictor) shown as 8 bits; CMYK through its embedded profile (else simply). Anything else is reported in the warnings and
 * the page is skipped, so a file with one unreadable page still shows the others.
 */
import { makeRaster, type DecodeResult, type DecodedPage } from './raster';
import { decodeCcitt } from './ccitt';
import { decompress as zstdDecompress } from 'fzstd';
import { xzDecode } from './lzma';
import { labToXyz } from '../color/transform';
import { rgbToD50, inv3, SPACES } from '../color/spaces';
import { parseIcc } from '../color/icc';
import { colorFn } from '../color/transform';
import { spaceProfile } from '../color/spaces';
import { decodeLimits, latin1 } from './limits';

export function isTiff(u8: Uint8Array): boolean {
  if (u8.length < 8) return false;
  const le = u8[0] === 0x49 && u8[1] === 0x49, be = u8[0] === 0x4d && u8[1] === 0x4d;
  if (!le && !be) return false;
  const magic = le ? u8[2] | (u8[3] << 8) : (u8[2] << 8) | u8[3];
  return magic === 42 || magic === 43;
}

export interface IfdEntry { tag: number; type: number; count: number; values: number[] }

/** Reads one IFD into a map of tag → values (the first 1M values of each). Shared with the EXIF reader. */
export function readIfd(u8: Uint8Array, offset: number, le: boolean, big = false): { tags: Map<number, IfdEntry>; next: number } {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const u16 = (o: number) => dv.getUint16(o, le);
  const u32 = (o: number) => dv.getUint32(o, le);
  const u64 = (o: number) => Number(dv.getBigUint64(o, le));
  const tags = new Map<number, IfdEntry>();
  if (offset + (big ? 8 : 2) > u8.length) return { tags, next: 0 };
  const n = big ? u64(offset) : u16(offset);
  const entrySize = big ? 20 : 12;
  const base0 = offset + (big ? 8 : 2);
  const sizes: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8 };
  // Values are kept as numbers: a directory may hold at most this many in all, so that a small file whose tags all point
  // at the same megabyte cannot unfold into gigabytes. (Real directories hold thousands: strip tables, a profile.)
  let budget = 4 << 20;
  for (let k = 0; k < Math.min(n, 4096); k++) {
    const e = base0 + k * entrySize;
    if (e + entrySize > u8.length) break;
    const tag = u16(e), type = u16(e + 2), count = big ? u64(e + 4) : u32(e + 4);
    const size = sizes[type] || 1;
    const inlineMax = big ? 8 : 4;
    const vo = e + (big ? 12 : 8);
    const base = size * count <= inlineMax ? vo : big ? u64(vo) : u32(vo);
    const values: number[] = [];
    const max = Math.min(count, 1 << 20, budget);
    for (let i = 0; i < max; i++) {
      const o = base + i * size;
      if (o + size > u8.length) break;
      switch (type) {
        case 3: case 8: values.push(type === 3 ? u16(o) : dv.getInt16(o, le)); break;
        case 4: case 13: values.push(u32(o)); break;
        case 9: values.push(dv.getInt32(o, le)); break;
        case 5: { const d = u32(o + 4); values.push(d ? u32(o) / d : 0); break; }
        case 10: { const d = dv.getInt32(o + 4, le); values.push(d ? dv.getInt32(o, le) / d : 0); break; }
        case 11: values.push(dv.getFloat32(o, le)); break;
        case 12: values.push(dv.getFloat64(o, le)); break;
        case 16: case 17: case 18: values.push(u64(o)); break;
        default: values.push(u8[o]);
      }
    }
    budget -= values.length;
    tags.set(tag, { tag, type, count, values });
  }
  const nextAt = base0 + n * entrySize;
  const next = nextAt + (big ? 8 : 4) <= u8.length ? (big ? u64(nextAt) : u32(nextAt)) : 0;
  return { tags, next };
}

export async function decodeTiff(u8: Uint8Array): Promise<DecodeResult> {
  if (!isTiff(u8)) throw new Error('Not a TIFF file');
  const le = u8[0] === 0x49;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const big = dv.getUint16(2, le) === 43;
  let ifd = big ? Number(dv.getBigUint64(8, le)) : dv.getUint32(4, le);
  const pages: DecodedPage[] = [];
  const warnings: string[] = [];
  const info: Record<string, string> = { byteOrder: le ? 'little-endian (II)' : 'big-endian (MM)', bigTiff: big ? 'yes' : 'no' };
  const seen = new Set<number>();
  let n = 0, kept = 0;
  while (ifd && !seen.has(ifd) && n < 500) {
    seen.add(ifd);
    n++;
    const { tags, next } = readIfd(u8, ifd, le, big);
    ifd = next;
    if (n === 1) {
      const str = (t: number) => { const e = tags.get(t); return e && e.type === 2 ? latin1(e.values.filter((c) => c)).trim() : ''; };
      for (const [t, k] of [[270, 'description'], [271, 'make'], [272, 'model'], [305, 'software'], [306, 'dateTime'], [315, 'artist'], [33432, 'copyright']] as [number, string][]) { const v = str(t); if (v) info[k] = v; }
      if (tags.has(34665)) info.exif = 'yes';
      if (tags.has(700)) info.xmp = 'yes';
      if (tags.has(33723)) info.iptc = 'yes';
      if (tags.has(34675)) info.icc = 'yes';
    }
    const sub = tags.get(254)?.values[0] || 0;
    if (sub & 1 && pages.length) continue; // reduced-resolution copy of an earlier page
    // Every page is kept decoded: together they may not take more than the budget (a 40-page fax is over a gigabyte).
    const area = (tags.get(256)?.values[0] || 0) * (tags.get(257)?.values[0] || 0);
    if (pages.length && kept + area > decodeLimits.totalPixels) { warnings.push(`Page ${n} and the pages after it are not shown: together the pages are larger than is kept in memory at once (${pages.length} shown)`); break; }
    kept += area;
    try {
      pages.push(await decodePage(u8, tags, le, warnings, n));
    } catch (e: any) {
      warnings.push(`Page ${n}: ${e?.message || e}`);
    }
  }
  if (!pages.length) throw new Error(warnings[0] || 'No readable page');
  return { pages, info, warnings };
}

async function decodePage(u8: Uint8Array, tags: Map<number, IfdEntry>, le: boolean, warnings: string[], pageNo: number): Promise<DecodedPage> {
  const g = (t: number, d: number) => tags.get(t)?.values[0] ?? d;
  const w = g(256, 0), h = g(257, 0);
  if (!w || !h) throw new Error('no dimensions');
  if (w * h > 80_000_000) throw new Error('too large');
  const bps = tags.get(258)?.values || [1];
  const comp = g(259, 1), photo = g(262, bps[0] === 1 ? 0 : 1), spp = g(277, bps.length || 1), planar = g(284, 1), pred = g(317, 1);
  const extra = tags.get(338)?.values || [];
  const sampleFormat = g(339, 1);
  let bits = bps[0];
  const ccitt = comp === 2 || comp === 3 || comp === 4;
  if (ccitt && (bits !== 1 || spp !== 1)) throw new Error('CCITT compression with more than one bit per pixel');
  if (![1, 2, 4, 8, 16, 24, 32, 64].includes(bits) || (bits === 64 && sampleFormat !== 3) || (bits === 24 && sampleFormat !== 3)) throw new Error(`${bits}-bit samples are not supported yet`);
  if (sampleFormat === 3 && ![16, 24, 32, 64].includes(bits)) throw new Error(`${bits}-bit floating-point samples are not supported`);
  if (planar === 2 && bits < 8 && spp > 1) throw new Error('planar (separate) samples under 8 bits are not supported');
  if (photo === 5 && (tags.get(332)?.values[0] ?? 1) !== 1) throw new Error('separated data that is not CMYK (InkSet) is not supported');
  if (photo === 10) throw new Error('ITU L*a*b* (fax color) is not supported yet');
  if ((photo === 8 || photo === 9) && (spp < 3 || (bits !== 8 && bits !== 16))) throw new Error('only 8- and 16-bit three-channel L*a*b* is supported');
  const compressionName: Record<number, string> = { 1: 'uncompressed', 2: 'CCITT RLE', 3: 'CCITT G3', 4: 'CCITT G4', 5: 'LZW', 6: 'old JPEG', 7: 'JPEG', 8: 'Deflate', 32773: 'PackBits', 32946: 'Deflate', 34712: 'JPEG 2000', 34925: 'LZMA', 50000: 'ZSTD', 50001: 'WebP', 50002: 'JPEG XL' };
  if (comp === 7 || comp === 6) return decodeJpegPage(u8, tags, w, h, spp, photo, extra, warnings, pageNo, g);
  if (![1, 2, 3, 4, 5, 8, 32773, 32946, 34925, 50000, 50001].includes(comp)) throw new Error(`${compressionName[comp] || 'compression ' + comp} is not supported yet`);
  const t4 = g(292, 0), t6 = g(293, 0), lsbFirst = g(266, 1) === 2;
  // One strip or tile of `pw` pixels × `rows` rows with `n` samples per pixel, decompressed and with predictors undone.
  const piece = async (src: Uint8Array, pw: number, rows: number, n: number): Promise<Uint8Array> => {
    const rb = Math.ceil((pw * n * bits) / 8);
    if (ccitt) {
      // The codes T.4 calls white and black are the bit values 0 and 1; PhotometricInterpretation says how they look (as in libtiff).
      return decodeCcitt(src, pw, rows, { compression: comp as 2 | 3 | 4, t4Options: t4, t6Options: t6, lsbFirst });
    }
    if (comp === 50001) return webpPiece(src, pw, rows, n);
    const dec = await inflateChunk(src, comp, rb * rows);
    if (pred === 3) return undoFloatPredictor(dec, bits / 8, n, pw, rows, le);
    undoPredictor(dec, pred, bits, n, pw, rows, rb);
    return dec;
  };
  // Reads every strip or tile of one plane (planar files) or of the whole page.
  const readPlane = async (plane: number, n: number): Promise<Uint8Array> => {
    const rowBytes = Math.ceil((w * n * bits) / 8), out = new Uint8Array(rowBytes * h);
    if (tags.has(324)) {
      const tw = g(322, w), th = g(323, h), across = Math.ceil(w / tw), per = across * Math.ceil(h / th);
      const offsets = tags.get(324)!.values.slice(plane * per, (plane + 1) * per), counts = (tags.get(325)?.values || []).slice(plane * per, (plane + 1) * per);
      const tileRowBytes = Math.ceil((tw * n * bits) / 8);
      for (let t = 0; t < offsets.length; t++) {
        const tx = (t % across) * tw, ty = Math.floor(t / across) * th;
        if (ty >= h) break;
        const dec = await piece(u8.subarray(offsets[t], offsets[t] + (counts[t] ?? 0)), tw, th, n);
        const xBytes = Math.floor((tx * n * bits) / 8), copyBytes = Math.min(tileRowBytes, rowBytes - xBytes);
        for (let y = 0; y < th && ty + y < h; y++) out.set(dec.subarray(y * tileRowBytes, y * tileRowBytes + copyBytes), (ty + y) * rowBytes + xBytes);
      }
    } else {
      const rps = Math.min(g(278, h), h), per = Math.ceil(h / rps);
      const all = tags.get(273)?.values || [], allCounts = tags.get(279)?.values || [];
      const offsets = planar === 2 ? all.slice(plane * per, (plane + 1) * per) : all, counts = planar === 2 ? allCounts.slice(plane * per, (plane + 1) * per) : allCounts;
      if (!offsets.length) throw new Error('no strips');
      let o = 0;
      for (let s = 0; s < offsets.length && o < out.length; s++) {
        const rows = Math.min(rps, h - Math.floor(o / rowBytes)), want = rows * rowBytes;
        const cnt = counts[s] ?? (comp === 1 ? want : u8.length - offsets[s]);
        if (offsets[s] + cnt > u8.length) warnings.push(`Page ${pageNo}: strip ${s + 1} is truncated`);
        const dec = await piece(u8.subarray(offsets[s], Math.min(u8.length, offsets[s] + cnt)), w, rows, n);
        out.set(dec.subarray(0, Math.min(want, out.length - o)), o);
        o += want;
      }
    }
    return out;
  };
  let raw: Uint8Array;
  if (planar === 2 && spp > 1) {
    // Separate planes, interleaved here into one chunky buffer.
    const B = bits / 8, planes: Uint8Array[] = []; for (let p = 0; p < spp; p++) planes.push(await readPlane(p, 1));
    raw = new Uint8Array(w * h * spp * B);
    for (let i = 0; i < w * h; i++) for (let p = 0; p < spp; p++) for (let k = 0; k < B; k++) raw[(i * spp + p) * B + k] = planes[p][i * B + k];
  } else raw = await readPlane(0, spp);
  // Float, signed or 32-bit samples become 8-bit: 0…1 as is (floats), otherwise their range in this page.
  let rangeNote = '';
  if (sampleFormat === 3 || sampleFormat === 2 || bits === 32) {
    const r = toEightBit(raw, bits, sampleFormat, pred === 3 ? true : le, w * h, spp, extra.length);
    raw = r.data; rangeNote = r.note; bits = 8;
  }
  const rowBytes = Math.ceil((w * spp * bits) / 8);
  const tiled = tags.has(324);
  const map = tags.get(320)?.values;
  const out = makeRaster(w, h);
  const d = out.data;
  const hasAlpha = extra.includes(1) || extra.includes(2) || (photo === 2 && spp === 4 && !extra.length);
  const icc = tags.get(34675)?.values;
  const cmyk = photo === 5 && icc ? cmykConverter(Uint8Array.from(icc), warnings, pageNo) : null;
  const assocAlpha = extra.includes(1);
  const maxv = (1 << bits) - 1;
  const sample = (row: number, i: number): number => {
    // sample index i within the row (0-based across samples)
    if (bits === 8) return raw[row + i];
    if (bits === 16) return le ? (raw[row + i * 2] | (raw[row + i * 2 + 1] << 8)) >> 8 : (raw[row + i * 2] << 8 | raw[row + i * 2 + 1]) >> 8;
    const bitPos = i * bits;
    const byte = raw[row + (bitPos >> 3)];
    return (byte >> (8 - bits - (bitPos & 7))) & maxv;
  };
  const scale = bits === 16 ? 1 : 255 / maxv; // 16-bit samples come back as their high byte already
  const full16 = (row: number, i: number) => (le ? raw[row + i * 2] | (raw[row + i * 2 + 1] << 8) : (raw[row + i * 2] << 8) | raw[row + i * 2 + 1]);
  const lab = photo === 8 || photo === 9 ? labToSrgb8() : null;
  for (let y = 0; y < h; y++) {
    const row = y * rowBytes;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const s0 = x * spp;
      if (lab) {
        // CIELab (8): a and b signed; ICCLab (9): a and b offset by 128 (32768 in 16 bits).
        let L, A, B;
        if (bits === 16) { L = full16(row, s0) / 65535 * 100; const a = full16(row, s0 + 1), b = full16(row, s0 + 2); A = photo === 9 ? (a - 32768) / 256 : ((a << 16) >> 16) / 256; B = photo === 9 ? (b - 32768) / 256 : ((b << 16) >> 16) / 256; }
        else { L = raw[row + s0] / 255 * 100; const a = raw[row + s0 + 1], b = raw[row + s0 + 2]; A = photo === 9 ? a - 128 : (a << 24) >> 24; B = photo === 9 ? b - 128 : (b << 24) >> 24; }
        lab(L, A, B, d, o); d[o + 3] = hasAlpha && spp >= 4 ? sample(row, s0 + 3) * scale : 255;
      } else if (photo === 3 && map) {
        const k = sample(row, s0), m = map.length / 3;
        d[o] = map[k] >> 8; d[o + 1] = map[m + k] >> 8; d[o + 2] = map[2 * m + k] >> 8; d[o + 3] = 255;
      } else if (photo === 2 || (spp >= 3 && photo !== 5)) {
        d[o] = sample(row, s0) * scale; d[o + 1] = sample(row, s0 + 1) * scale; d[o + 2] = sample(row, s0 + 2) * scale;
        d[o + 3] = hasAlpha && spp >= 4 ? sample(row, s0 + 3) * scale : 255;
        if (assocAlpha && d[o + 3] && d[o + 3] < 255) { const a = 255 / d[o + 3]; d[o] = Math.min(255, d[o] * a); d[o + 1] = Math.min(255, d[o + 1] * a); d[o + 2] = Math.min(255, d[o + 2] * a); }
      } else if (photo === 5 && spp >= 4) {
        const c = sample(row, s0) * scale, m = sample(row, s0 + 1) * scale, yy = sample(row, s0 + 2) * scale, k = sample(row, s0 + 3) * scale;
        if (cmyk) cmyk(c, m, yy, k, d, o);
        else { d[o] = 255 - Math.min(255, c + k); d[o + 1] = 255 - Math.min(255, m + k); d[o + 2] = 255 - Math.min(255, yy + k); }
        d[o + 3] = hasAlpha && spp >= 5 ? sample(row, s0 + 4) * scale : 255;
      } else {
        let v = sample(row, s0) * scale;
        if (photo === 0) v = 255 - v;
        d[o] = d[o + 1] = d[o + 2] = v;
        d[o + 3] = hasAlpha && spp >= 2 ? sample(row, s0 + 1) * scale : 255;
      }
    }
  }
  const unit = g(296, 2);
  const xr = g(282, 0), yr = g(283, 0);
  const dpi: [number, number] | undefined = xr && yr ? (unit === 3 ? [Math.round(xr * 2.54), Math.round(yr * 2.54)] : [Math.round(xr), Math.round(yr)]) : undefined;
  const notes = [compressionName[comp] || `compression ${comp}`, photo === 3 ? 'palette' : photo === 2 ? (spp >= 4 ? 'RGBA' : 'RGB') : photo === 5 ? (cmyk ? `CMYK through the embedded profile ${cmyk.profile}` : 'CMYK (no profile: converted simply)') : bits === 1 ? 'bilevel' : 'grayscale', pred === 2 ? 'horizontal predictor' : pred === 3 ? 'floating-point predictor' : '', planar === 2 ? 'planar' : '', rangeNote, tiled ? 'tiled' : 'strips'].filter(Boolean);
  return { width: w, height: h, frames: [{ raster: out, delay: 0 }], loops: 0, bitDepth: (bps[0] || bits) * spp, paletteSize: photo === 3 && map ? map.length / 3 : undefined, hasAlpha, dpi, notes };
}

function undoPredictor(dec: Uint8Array, pred: number, bits: number, spp: number, w: number, rows: number, rowBytes: number): void {
  if (pred !== 2) return;
  if (bits === 8) {
    for (let y = 0; y < rows; y++) { const r = y * rowBytes; for (let x = spp; x < w * spp && r + x < dec.length; x++) dec[r + x] = (dec[r + x] + dec[r + x - spp]) & 255; }
  } else if (bits === 16) {
    for (let y = 0; y < rows; y++) { const r = y * rowBytes; for (let x = spp; x < w * spp; x++) { const i = r + x * 2, j = r + (x - spp) * 2; if (i + 1 >= dec.length) break; const v = (dec[i] | (dec[i + 1] << 8)) + (dec[j] | (dec[j + 1] << 8)); dec[i] = v & 255; dec[i + 1] = (v >> 8) & 255; } }
  }
}

/** JPEG in TIFF (compression 7, and the old style 6 where each strip is a whole JPEG): every strip or tile is a JPEG, decoded by the platform, with the JPEGTables segments inserted after its SOI. */
async function decodeJpegPage(u8: Uint8Array, tags: Map<number, IfdEntry>, w: number, h: number, spp: number, photo: number, extra: number[], warnings: string[], pageNo: number, g: (t: number, d: number) => number): Promise<DecodedPage> {
  if (typeof document === 'undefined') throw new Error('JPEG-compressed TIFF needs the platform decoder');
  const tables = tags.get(347)?.values;
  let tableSegs: Uint8Array | null = null;
  if (tables && tables.length > 4) { const t = Uint8Array.from(tables); tableSegs = t.subarray(2, t.length - 2); } // between SOI and EOI
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const tiled = tags.has(324);
  const offsets = (tiled ? tags.get(324) : tags.get(273))?.values || [], counts = (tiled ? tags.get(325) : tags.get(279))?.values || [];
  if (!offsets.length) throw new Error('no strips');
  const tw = tiled ? g(322, w) : w, th = tiled ? g(323, h) : Math.min(g(278, h), h);
  const across = tiled ? Math.ceil(w / tw) : 1;
  let decoded = 0;
  for (let i = 0; i < offsets.length; i++) {
    const x = (i % across) * tw, y = Math.floor(i / across) * th;
    if (y >= h) break;
    const cnt = counts[i] ?? u8.length - offsets[i];
    let strip = u8.subarray(offsets[i], Math.min(u8.length, offsets[i] + cnt));
    if (strip.length < 4 || strip[0] !== 0xff || strip[1] !== 0xd8) { warnings.push(`Page ${pageNo}: ${tiled ? 'tile' : 'strip'} ${i + 1} is not a JPEG stream`); continue; }
    if (tableSegs) { const merged = new Uint8Array(2 + tableSegs.length + strip.length - 2); merged.set(strip.subarray(0, 2)); merged.set(tableSegs, 2); merged.set(strip.subarray(2), 2 + tableSegs.length); strip = merged; }
    try {
      const bmp = await createImageBitmap(new Blob([strip as BlobPart], { type: 'image/jpeg' }), { imageOrientation: 'none' as any, premultiplyAlpha: 'none' as any });
      ctx.drawImage(bmp, x, y);
      bmp.close();
      decoded++;
    } catch (e: any) { warnings.push(`Page ${pageNo}: ${tiled ? 'tile' : 'strip'} ${i + 1} could not be decoded (${e?.message || e})`); }
  }
  if (!decoded) throw new Error('no JPEG strip could be decoded');
  const id = ctx.getImageData(0, 0, w, h);
  const hasAlpha = extra.includes(1) || extra.includes(2);
  return { width: w, height: h, frames: [{ raster: { width: w, height: h, data: id.data as Uint8ClampedArray<ArrayBuffer> }, delay: 0 }], loops: 0, bitDepth: 8 * spp, hasAlpha, dpi: dpiOf(tags), notes: [`JPEG-compressed ${tiled ? 'tiles' : 'strips'} (${decoded} of ${offsets.length})`, photo === 6 ? 'YCbCr' : photo === 5 ? 'CMYK' : photo === 2 ? 'RGB' : 'grayscale'] };
}

function dpiOf(tags: Map<number, IfdEntry>): [number, number] | undefined {
  const unit = tags.get(296)?.values[0] ?? 2, xr = tags.get(282)?.values[0], yr = tags.get(283)?.values[0];
  if (!xr || unit === 1) return undefined;
  const y = yr || xr;
  return unit === 3 ? [Math.round(xr * 2.54), Math.round(y * 2.54)] : [Math.round(xr), Math.round(y)];
}

async function inflateChunk(src: Uint8Array, comp: number, want: number): Promise<Uint8Array> {
  if (comp === 50000 || comp === 34925) {
    let dec: Uint8Array;
    try { dec = comp === 50000 ? zstdDecompress(src) : xzDecode(src); }
    catch (e) { throw new Error(`${comp === 50000 ? 'ZSTD' : 'LZMA'} data could not be read (${(e as Error).message})`); }
    if (dec.length >= want) return dec.subarray(0, want);
    const out = new Uint8Array(want); out.set(dec); return out;
  }
  if (comp === 1) { if (src.length >= want) return src; const out = new Uint8Array(want); out.set(src); return out; }
  if (comp === 32773) return packBits(src, want);
  if (comp === 5) return lzwTiff(src, want);
  // Deflate (zlib stream)
  const out = new Uint8Array(want);
  try {
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    void writer.write(src.slice()).catch(() => undefined);
    void writer.close().catch(() => undefined);
    const reader = ds.readable.getReader();
    let o = 0;
    for (;;) { const { done, value } = await reader.read(); if (done || !value) break; const n = Math.min(value.length, want - o); out.set(value.subarray(0, n), o); o += n; if (o >= want) { void reader.cancel().catch(() => undefined); break; } }
  } catch (e: any) {
    throw new Error(`Deflate data could not be read (${e?.message || e})`);
  }
  return out;
}

export function packBits(src: Uint8Array, want: number): Uint8Array {
  const out = new Uint8Array(want);
  let i = 0, o = 0;
  while (i < src.length && o < want) {
    const n = (src[i++] << 24) >> 24;
    if (n >= 0) { for (let k = 0; k <= n && o < want && i < src.length; k++) out[o++] = src[i++]; }
    else if (n !== -128) { const v = src[i++]; for (let k = 0; k < 1 - n && o < want; k++) out[o++] = v; }
  }
  return out;
}

/** TIFF LZW: big-endian bit packing, early change. */
export function lzwTiff(src: Uint8Array, want: number): Uint8Array {
  const out = new Uint8Array(want);
  let o = 0, bitPos = 0, width = 9;
  const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), lens = new Uint16Array(4096);
  let next = 258;
  const reset = () => { next = 258; width = 9; };
  for (let i = 0; i < 256; i++) { prefix[i] = -1; suffix[i] = i; lens[i] = 1; }
  let prev = -1;
  const total = src.length * 8;
  const read = () => {
    let v = 0;
    for (let k = 0; k < width; k++) { const bp = bitPos + k; v = (v << 1) | ((src[bp >> 3] >> (7 - (bp & 7))) & 1); }
    bitPos += width;
    return v;
  };
  const stack = new Uint8Array(4097);
  const emit = (code: number): number => {
    let n = 0, c = code;
    while (c >= 0) { stack[n++] = suffix[c]; c = prefix[c]; }
    for (let k = n - 1; k >= 0 && o < want; k--) out[o++] = stack[k];
    return stack[n - 1];
  };
  while (bitPos + width <= total && o < want) {
    const code = read();
    if (code === 256) { reset(); prev = -1; continue; }
    if (code === 257) break;
    let first: number;
    if (code < next) {
      first = emit(code);
    } else if (code === next && prev >= 0) {
      let c = prev; while (prefix[c] >= 0) c = prefix[c];
      first = suffix[c];
      emit(prev); if (o < want) out[o++] = first;
    } else break;
    if (prev >= 0 && next < 4096) { prefix[next] = prev; suffix[next] = first; lens[next] = lens[prev] + 1; next++; }
    prev = code;
    if (next + 1 >= 1 << width && width < 12) width++;
  }
  return out;
}

/** The floating-point predictor (TIFF predictor 3): bytes differenced across the row, then grouped by significance. Returns little-endian samples. */
function undoFloatPredictor(dec: Uint8Array, B: number, spp: number, w: number, rows: number, _le: boolean): Uint8Array {
  const wc = w * spp, rb = wc * B, out = new Uint8Array(rb * rows);
  for (let y = 0; y < rows; y++) {
    const row = dec.subarray(y * rb, (y + 1) * rb), t = Uint8Array.from(row);
    for (let i = spp; i < rb; i++) t[i] = (t[i] + t[i - spp]) & 255;
    for (let i = 0; i < wc; i++) for (let b = 0; b < B; b++) out[y * rb + i * B + b] = t[(B - b - 1) * wc + i];
  }
  return out;
}
const half = (v: number) => { const s = v >> 15 ? -1 : 1, e = (v >> 10) & 31, f = v & 1023; return e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15); };
/** Wide, signed or floating-point samples to 8 bits. Floats within 0…1 map directly; anything else is stretched from its lowest to highest value (alpha samples are scaled alone). */
function toEightBit(raw: Uint8Array, bits: number, fmt: number, le: boolean, pixels: number, spp: number, extras: number): { data: Uint8Array; note: string } {
  const B = bits / 8, n = pixels * spp, dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength), v = new Float64Array(n);
  for (let i = 0; i < n && (i + 1) * B <= raw.length; i++) {
    const o = i * B;
    if (fmt === 3) v[i] = B === 2 ? half(dv.getUint16(o, le)) : B === 4 ? dv.getFloat32(o, le) : B === 8 ? dv.getFloat64(o, le) : (() => { const b0 = le ? raw[o + 2] : raw[o], b1 = raw[o + 1], b2 = le ? raw[o] : raw[o + 2]; const x = (b0 << 16) | (b1 << 8) | b2; const s = x >> 23 ? -1 : 1, e = (x >> 16) & 127, f = x & 0xffff; return e === 0 ? s * f * 2 ** -78 : s * (1 + f / 65536) * 2 ** (e - 63); })();
    else if (fmt === 2) v[i] = B === 1 ? dv.getInt8(o) : B === 2 ? dv.getInt16(o, le) : dv.getInt32(o, le);
    else v[i] = B === 1 ? raw[o] : B === 2 ? dv.getUint16(o, le) : dv.getUint32(o, le);
  }
  const colors = spp - extras;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) if (i % spp < colors && Number.isFinite(v[i])) { if (v[i] < lo) lo = v[i]; if (v[i] > hi) hi = v[i]; }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  const unit = fmt === 3 && lo >= 0 && hi <= 1;
  const a = unit ? 0 : lo, k = unit ? 255 : hi > lo ? 255 / (hi - lo) : 0;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const x = v[i];
    if (i % spp >= colors) out[i] = fmt === 3 ? Math.round(Math.max(0, Math.min(1, x)) * 255) : Math.round(((x - (fmt === 2 ? -(2 ** (bits - 1)) : 0)) / (2 ** bits - 1)) * 255);
    else out[i] = Number.isFinite(x) ? Math.round(Math.max(0, Math.min(255, (x - a) * k))) : x > 0 ? 255 : 0;
  }
  const kind = fmt === 3 ? `${bits}-bit floating point` : `${bits}-bit ${fmt === 2 ? 'signed' : 'unsigned'} integers`;
  const fmtN = (x: number) => (Math.abs(x) >= 1e5 || (Math.abs(x) < 1e-3 && x !== 0) ? x.toExponential(3) : +x.toPrecision(5));
  return { data: out, note: unit ? `${kind} (0…1)` : `${kind}, ${fmtN(lo)}…${fmtN(hi)} shown as black…white` };
}

/** CMYK → sRGB through an embedded CMYK profile (relative colorimetric), on a 17⁴ lattice with quadrilinear interpolation. */
type CmykConv = ((c: number, m: number, y: number, k: number, d: Uint8ClampedArray, o: number) => void) & { profile: string };
const cmykCache = new Map<string, CmykConv>(); // a folder of pictures usually shares one profile
function cmykConverter(iccBytes: Uint8Array, warnings: string[], pageNo: number): CmykConv | null {
  let hsh = 2166136261; for (let i = 0; i < iccBytes.length; i++) hsh = Math.imul(hsh ^ iccBytes[i], 16777619);
  const key = `${iccBytes.length}:${hsh >>> 0}`, hit = cmykCache.get(key); if (hit) return hit;
  const made = buildCmyk(iccBytes, warnings, pageNo);
  if (made) { if (cmykCache.size >= 4) cmykCache.delete(cmykCache.keys().next().value!); cmykCache.set(key, made); }
  return made;
}
function buildCmyk(iccBytes: Uint8Array, warnings: string[], pageNo: number): CmykConv | null {
  let prof; try { prof = parseIcc(iccBytes); } catch (e) { warnings.push(`Page ${pageNo}: the embedded color profile could not be read (${(e as Error).message}); CMYK converted simply`); return null; }
  if (prof.colorSpace !== 'CMYK') return null;
  let fn: (v: number[]) => number[];
  try { fn = colorFn(prof, spaceProfile('srgb'), { intent: 1 }); fn([0, 0, 0, 0]); } catch (e) { warnings.push(`Page ${pageNo}: the CMYK profile cannot be used (${(e as Error).message}); converted simply`); return null; }
  const N = 17, lat = new Float32Array(N ** 4 * 3);
  for (let c = 0; c < N; c++) for (let m = 0; m < N; m++) for (let y = 0; y < N; y++) for (let k = 0; k < N; k++) {
    const r = fn([c / (N - 1), m / (N - 1), y / (N - 1), k / (N - 1)]), i = (((c * N + m) * N + y) * N + k) * 3;
    lat[i] = r[0]; lat[i + 1] = r[1]; lat[i + 2] = r[2];
  }
  const s = (N - 1) / 255, S3 = 3, S2 = N * 3, S1 = N * N * 3, S0 = N * N * N * 3;
  const conv = (c: number, m: number, y: number, k: number, d: Uint8ClampedArray, o: number) => {
    const f = [c * s, m * s, y * s, k * s], i0 = f.map((x) => Math.min(N - 2, Math.max(0, Math.floor(x)))), t = f.map((x, j) => x - i0[j]);
    const base = i0[0] * S0 + i0[1] * S1 + i0[2] * S2 + i0[3] * S3;
    for (let ch = 0; ch < 3; ch++) {
      let acc = 0;
      for (let corner = 0; corner < 16; corner++) {
        let wgt = 1, off = base + ch;
        for (let j = 0; j < 4; j++) { const bit = (corner >> (3 - j)) & 1; wgt *= bit ? t[j] : 1 - t[j]; off += bit ? [S0, S1, S2, S3][j] : 0; }
        if (wgt) acc += wgt * lat[off];
      }
      d[o + ch] = Math.round(Math.max(0, Math.min(1, acc)) * 255);
    }
  };
  return Object.assign(conv, { profile: prof.description || 'CMYK' });
}

/** L*a*b* (D50) → 8-bit sRGB through XYZ and the Bradford-adapted sRGB matrix (as an ICC v4 sRGB profile). */
function labToSrgb8(): (L: number, a: number, b: number, d: Uint8ClampedArray, o: number) => void {
  const s = SPACES[0], m = inv3(rgbToD50(s.primaries!, s.white!));
  const enc = (v: number) => Math.round(255 * (v <= 0 ? 0 : v >= 1 ? 1 : v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
  return (L, a, b, d, o) => {
    const x = labToXyz([L, a, b]);
    d[o] = enc(m[0] * x[0] + m[1] * x[1] + m[2] * x[2]); d[o + 1] = enc(m[3] * x[0] + m[4] * x[1] + m[5] * x[2]); d[o + 2] = enc(m[6] * x[0] + m[7] * x[1] + m[8] * x[2]);
  };
}
/** A WebP strip or tile (libtiff compression 50001), decoded by the platform into TIFF's sample order. */
async function webpPiece(src: Uint8Array, pw: number, rows: number, n: number): Promise<Uint8Array> {
  if (typeof createImageBitmap === 'undefined') throw new Error('WebP-compressed TIFF needs the platform\'s WebP decoder');
  const bmp = await createImageBitmap(new Blob([src as BlobPart], { type: 'image/webp' }));
  const c: any = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  const g = c.getContext('2d'); g.drawImage(bmp, 0, 0); bmp.close();
  const rgba = g.getImageData(0, 0, c.width, c.height).data as Uint8ClampedArray, out = new Uint8Array(pw * rows * n);
  for (let y = 0; y < Math.min(rows, c.height); y++) for (let x = 0; x < Math.min(pw, c.width); x++) for (let k = 0; k < n; k++) out[(y * pw + x) * n + k] = rgba[(y * c.width + x) * 4 + k];
  return out;
}
