/**
 * FITS (Flexible Image Transport System, the astronomy format; .fits, .fit, .fts), read by the app's own code from
 * the FITS standard: the primary array and every IMAGE extension as pages, with NAXIS = 2 pictures and NAXIS = 3
 * cubes (each plane a page); BITPIX 8, 16, 32, 64, −32 and −64, BZERO and BSCALE, BLANK (undefined pixels, left
 * transparent), the first stored row at the bottom as astronomy displays it. Values are stretched linearly between
 * the 0.5th and 99.5th percentiles for display (DATAMIN/DATAMAX are not used, as they are often wrong); the real
 * values are available to tools through fitsData. Tile-compressed images (the tiled image convention of the standard,
 * section 10: RICE_1, GZIP_1, GZIP_2, PLIO_1, HCOMPRESS_1 and NOCOMPRESS tiles in a binary table, quantized floats
 * with or without the subtractive dither, per-tile scaling, lossless fallback tiles, nulls) are decompressed; other
 * tables are skipped. Gzip-compressed files (.fits.gz) are inflated first.
 */
import { makeRaster, type DecodeResult, type DecodedPage } from './raster';
import { inflate } from './inflate';
import { decodeRice, decodePlio, decodeHcompress, unshuffleBytes, ditherSequence } from './fitsTiles';
import { parseWcs, formatWorld, pixelToWorld, type Wcs } from './wcs';
import { latin1 } from './limits';

export const isFits = (u8: Uint8Array): boolean => u8.length >= 2880 && String.fromCharCode(...u8.subarray(0, 9)) === 'SIMPLE  =';
export const isGzipFits = (u8: Uint8Array, name: string): boolean => u8.length > 10 && u8[0] === 0x1f && u8[1] === 0x8b && /\.(fits?|fts)\.gz$/i.test(name);

export interface FitsColumn { name: string; form: string; repeat: number; type: string; offset: number; size: number }
export interface FitsTable { rowLen: number; rows: number; heap: number; columns: FitsColumn[] }
export interface FitsHdu {
  cards: Map<string, string>; comments: string[]; dataStart: number; dataLength: number; bitpix: number; axes: number[]; kind: 'image' | 'table' | 'compressed' | 'empty';
  /** The binary table holding a tile-compressed image (kind 'compressed'); bitpix and axes then describe the image. */
  table?: FitsTable;
}
export interface FitsPlane { hdu: number; plane: number; width: number; height: number; values: Float64Array; blank: Uint8Array | null }

const text = (u8: Uint8Array, o: number, n: number) => latin1(u8, o, o + n);
/** A card's value as the standard writes it: a quoted string, a logical, or a number. */
function cardValue(raw: string): string {
  const s = raw.trimStart();
  if (s.startsWith("'")) { let i = 1, out = ''; while (i < s.length) { if (s[i] === "'") { if (s[i + 1] === "'") { out += "'"; i += 2; continue; } break; } out += s[i++]; } return out.trimEnd(); }
  const slash = s.indexOf('/');
  return (slash >= 0 ? s.slice(0, slash) : s).trim();
}
const SIZES: Record<string, number> = { L: 1, X: 1, B: 1, I: 2, J: 4, K: 8, A: 1, E: 4, D: 8, C: 8, M: 16, P: 8, Q: 16 };

/** The header/data units of a file: their cards, data position and kind. */
export function fitsHdus(u8: Uint8Array): FitsHdu[] {
  const out: FitsHdu[] = [];
  let p = 0;
  while (p + 2880 <= u8.length) {
    const cards = new Map<string, string>(), comments: string[] = [];
    let q = p, ended = false;
    while (q + 80 <= u8.length) {
      const card = text(u8, q, 80), key = card.slice(0, 8).trim();
      q += 80;
      if (key === 'END') { ended = true; break; }
      if (key === 'COMMENT' || key === 'HISTORY') { comments.push(`${key}: ${card.slice(8).trim()}`); continue; }
      if (card.slice(8, 10) === '= ' && key) cards.set(key, cardValue(card.slice(10)));
      else if (key && !cards.has(key) && card.slice(8).trim()) comments.push(card.trim());
    }
    if (!ended) break;
    const dataStart = Math.ceil(q / 2880) * 2880;
    let bitpix = +(cards.get('BITPIX') || 0), axes: number[] = [];
    // Sizes are whole and not negative: a negative length would send the reader backwards for ever.
    const whole = (key: string, dflt: number): number => { const v = +(cards.get(key) || dflt); if (!Number.isInteger(v) || v < 0) throw new Error(`Damaged FITS header: ${key} = ${cards.get(key)}`); return v; };
    const naxis = Math.min(whole('NAXIS', 0), 999);
    for (let i = 1; i <= naxis; i++) axes.push(whole(`NAXIS${i}`, 0));
    const gcount = whole('GCOUNT', 1), pcount = whole('PCOUNT', 0);
    const elements = axes.length ? axes.reduce((a, b) => a * b, 1) : 0;
    const dataLength = Math.ceil((Math.abs(bitpix) / 8 * (elements + pcount) * gcount) / 2880) * 2880;
    const xt = (cards.get('XTENSION') || '').trim().toUpperCase();
    const compressed = cards.get('ZIMAGE') === 'T' && xt === 'BINTABLE';
    const kind: FitsHdu['kind'] = compressed ? 'compressed' : xt === 'BINTABLE' || xt === 'TABLE' || xt === 'A3DTABLE' ? 'table' : !elements ? 'empty' : 'image';
    let table: FitsTable | undefined;
    if (compressed) {
      const columns: FitsColumn[] = [];
      let offset = 0;
      for (let i = 1; i <= +(cards.get('TFIELDS') || 0); i++) {
        const form = (cards.get(`TFORM${i}`) || '').trim(), m = /^(\d*)([A-Z])([A-Z])?/.exec(form);
        if (!m) break;
        const repeat = m[1] === '' ? 1 : +m[1], letter = m[2], type = letter === 'P' || letter === 'Q' ? m[3] || 'B' : letter;
        const size = letter === 'P' || letter === 'Q' ? SIZES[letter] * repeat : (SIZES[letter] || 1) * repeat;
        columns.push({ name: (cards.get(`TTYPE${i}`) || '').trim().toUpperCase(), form, repeat, type: letter === 'P' || letter === 'Q' ? letter + type : letter, offset, size });
        offset += size;
      }
      table = { rowLen: axes[0] || offset, rows: axes[1] || 0, heap: +(cards.get('THEAP') || (axes[0] || 0) * (axes[1] || 0)), columns };
      bitpix = +(cards.get('ZBITPIX') || 0);
      axes = [];
      for (let i = 1; i <= +(cards.get('ZNAXIS') || 0); i++) axes.push(+(cards.get(`ZNAXIS${i}`) || 0));
    }
    out.push({ cards, comments, dataStart, dataLength, bitpix, axes, kind, table });
    p = dataStart + dataLength;
    if (!dataLength && !out[0].cards.has('EXTEND') && out.length === 1 && kind === 'empty' && p + 2880 > u8.length) break;
  }
  return out;
}

/** The planes of the image HDUs: values with BZERO/BSCALE applied, rows as stored (the first row is the bottom). */
export function fitsData(u8: Uint8Array, o: { maxPixels?: number; maxPlanes?: number } = {}): { planes: FitsPlane[]; hdus: FitsHdu[]; warnings: string[] } {
  const hdus = fitsHdus(u8), planes: FitsPlane[] = [], warnings: string[] = [];
  const maxPixels = o.maxPixels ?? 200e6, maxPlanes = o.maxPlanes ?? 200;
  let budget = maxPixels;
  hdus.forEach((h, hi) => {
    if (h.kind !== 'image' && h.kind !== 'compressed') return;
    const [w, hgt = 1] = h.axes, depth = h.axes.slice(2).reduce((a, b) => a * b, 1) || 1;
    if (!(w > 0 && hgt > 0) || ![8, 16, 32, 64, -32, -64].includes(h.bitpix)) { warnings.push(`HDU ${hi + 1}: BITPIX ${h.bitpix} or axes ${h.axes.join(' × ')} are not supported`); return; }
    const bzero = +(h.cards.get('BZERO') || 0), bscale = +(h.cards.get('BSCALE') || 1), blankCard = h.cards.get('BLANK') ?? (h.kind === 'compressed' && h.bitpix > 0 ? h.cards.get('ZBLANK') : undefined), blank = blankCard !== undefined && h.bitpix > 0 ? +blankCard : null;
    const per = w * hgt;
    if (h.kind === 'compressed') {
      if (per * depth > budget) { warnings.push(`HDU ${hi + 1}: left out (too many pixels)`); return; }
      let tiles: { values: Float64Array; nulls: Uint8Array | null };
      try { tiles = decodeTiles(u8, h, warnings, hi); } catch (e) { warnings.push(`HDU ${hi + 1}: ${(e as Error).message}`); return; }
      for (let z = 0; z < depth && planes.length < maxPlanes; z++) {
        budget -= per;
        const values = tiles.values.subarray(z * per, (z + 1) * per).slice(), mask = tiles.nulls ? tiles.nulls.subarray(z * per, (z + 1) * per).slice() : blank !== null ? new Uint8Array(per) : null;
        for (let i = 0; i < per; i++) {
          if (mask && (mask[i] || (blank !== null && values[i] === blank))) { mask[i] = 1; values[i] = NaN; continue; }
          values[i] = bzero + bscale * values[i];
        }
        planes.push({ hdu: hi, plane: z, width: w, height: hgt, values, blank: mask });
      }
      return;
    }
    const bytes = Math.abs(h.bitpix) / 8, dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    for (let z = 0; z < depth && planes.length < maxPlanes; z++) {
      if (per > budget) { warnings.push(`HDU ${hi + 1}: plane ${z + 1} and the rest are left out (too many pixels)`); break; }
      budget -= per;
      const base = h.dataStart + z * per * bytes;
      // A plane cut short is shown with what there is, unless hardly any of it is there (a header claiming far more than the file holds).
      if (base + per * bytes > u8.length) { warnings.push(`HDU ${hi + 1}: the data is cut short`); if (base >= u8.length || (u8.length - base) * 16 < per * bytes) break; }
      const values = new Float64Array(per), mask = blank !== null ? new Uint8Array(per) : null;
      for (let i = 0; i < per; i++) {
        const at = base + i * bytes;
        if (at + bytes > u8.length) { values[i] = NaN; continue; }
        let v: number;
        switch (h.bitpix) {
          case 8: v = u8[at]; break;
          case 16: v = dv.getInt16(at); break;
          case 32: v = dv.getInt32(at); break;
          case 64: v = Number(dv.getBigInt64(at)); break;
          case -32: v = dv.getFloat32(at); break;
          default: v = dv.getFloat64(at);
        }
        if (mask && v === blank) { mask[i] = 1; values[i] = NaN; continue; }
        values[i] = bzero + bscale * v;
      }
      planes.push({ hdu: hi, plane: z, width: w, height: hgt, values, blank: mask });
    }
  });
  return { planes, hdus, warnings };
}

/** A tile-compressed image: every tile decoded and placed; values as stored (before BZERO/BSCALE), nulls flagged. */
function decodeTiles(u8: Uint8Array, h: FitsHdu, warnings: string[], hi: number): { values: Float64Array; nulls: Uint8Array | null } {
  const t = h.table!, c = h.cards, dims = h.axes, cmp = (c.get('ZCMPTYPE') || 'RICE_1').trim().toUpperCase();
  if (dims.length > 3) throw new Error(`a tile-compressed image with ${dims.length} axes is not supported`);
  const total = dims.reduce((a, b) => a * b, 1), values = new Float64Array(total);
  let nulls: Uint8Array | null = null;
  const col = (name: string) => t.columns.find((x) => x.name === name);
  const data = col('COMPRESSED_DATA'), gz = col('GZIP_COMPRESSED_DATA'), raw = col('UNCOMPRESSED_DATA'), zs = col('ZSCALE'), zz = col('ZZERO'), zb = col('ZBLANK');
  if (!data) throw new Error('the compressed table has no COMPRESSED_DATA column');
  const zval: Record<string, string> = {};
  for (let i = 1; c.has(`ZNAME${i}`); i++) zval[(c.get(`ZNAME${i}`) || '').trim().toUpperCase()] = (c.get(`ZVAL${i}`) || '').trim();
  const tiles = dims.map((d, i) => +(c.get(`ZTILE${i + 1}`) || (i === 0 ? d : 1)) || (i === 0 ? d : 1));
  if (tiles.some((t) => !Number.isInteger(t) || t < 1)) throw new Error(`HDU ${hi + 1}: bad tile size (ZTILE)`);
  const nt = dims.map((d, i) => Math.ceil(d / tiles[i])), ntiles = Math.min(nt.reduce((a, b) => a * b, 1), t.rows); // never more tiles than the table has rows
  if (ntiles !== t.rows) warnings.push(`HDU ${hi + 1}: ${t.rows} table rows for ${ntiles} tiles`);
  const quantized = h.bitpix < 0 && (!!col('ZSCALE') || c.has('ZSCALE')), bytepix = +(zval.BYTEPIX || (quantized ? 4 : Math.abs(h.bitpix) / 8)), blocksize = +(zval.BLOCKSIZE || 32), smooth = +(zval.SMOOTH || 0) > 0;
  const quantiz = (c.get('ZQUANTIZ') || 'NO_DITHER').trim().toUpperCase(), dither = quantiz === 'SUBTRACTIVE_DITHER_1' ? 1 : quantiz === 'SUBTRACTIVE_DITHER_2' ? 2 : 0, dither0 = +(c.get('ZDITHER0') || 1);
  const nullKeyword = c.has('ZBLANK') ? +c.get('ZBLANK')! : quantized ? -2147483647 : null;
  const randoms = dither ? ditherSequence() : null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), heap = h.dataStart + t.heap;
  /** The bytes of a variable-length cell (P or Q descriptor), or null when empty. */
  const cell = (column: FitsColumn | undefined, row: number): Uint8Array | null => {
    if (!column) return null;
    const at = h.dataStart + row * t.rowLen + column.offset;
    let n: number, off: number;
    if (column.type.startsWith('Q')) { n = Number(dv.getBigInt64(at)); off = Number(dv.getBigInt64(at + 8)); }
    else if (column.type.startsWith('P')) { n = dv.getUint32(at); off = dv.getUint32(at + 4); }
    else return u8.subarray(at, at + column.size);
    if (!n) return null;
    const size = SIZES[column.type[1]] || 1;
    if (heap + off + n * size > u8.length) throw new Error(`tile ${row + 1} lies outside the file`);
    return u8.subarray(heap + off, heap + off + n * size);
  };
  const number = (column: FitsColumn | undefined, row: number, fallback: number): number => {
    if (!column) return fallback;
    const at = h.dataStart + row * t.rowLen + column.offset;
    return column.type === 'D' ? dv.getFloat64(at) : column.type === 'E' ? dv.getFloat32(at) : column.type === 'J' ? dv.getInt32(at) : column.type === 'I' ? dv.getInt16(at) : fallback;
  };
  /** Raw big-endian samples of the image's type (or 32-bit integers for quantized floats) as numbers. */
  const samples = (bytes: Uint8Array, n: number, bitpix: number): Float64Array | Int32Array => {
    const b = Math.abs(bitpix) / 8, out = new Float64Array(n), d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < n; i++) {
      const at = i * b;
      if (at + b > bytes.length) { out[i] = NaN; continue; }
      out[i] = bitpix === 8 ? bytes[at] : bitpix === 16 ? d.getInt16(at) : bitpix === 32 ? d.getInt32(at) : bitpix === 64 ? Number(d.getBigInt64(at)) : bitpix === -32 ? d.getFloat32(at) : d.getFloat64(at);
    }
    return out;
  };
  const stride = [1, dims[0], dims[0] * (dims[1] || 1)];
  let reported = 0;
  for (let r = 0; r < ntiles; r++) {
    const tc = [r % nt[0], Math.floor(r / nt[0]) % (nt[1] || 1), Math.floor(r / (nt[0] * (nt[1] || 1)))];
    const size = dims.map((d, i) => Math.min(tiles[i], d - tc[i] * tiles[i])), n = size.reduce((a, b) => a * b, 1);
    const origin = dims.map((_, i) => tc[i] * tiles[i]);
    let vals: ArrayLike<number> | null = null, ints: Int32Array | Float64Array | null = null, lossless = false;
    try {
      const bytes = cell(data, r);
      if (bytes) {
        const storedBitpix = quantized ? 32 : h.bitpix;
        if (cmp === 'RICE_1') ints = decodeRice(bytes, n, bytepix, blocksize);
        else if (cmp === 'PLIO_1') ints = decodePlio(bytes, n);
        else if (cmp === 'HCOMPRESS_1') { const hc = decodeHcompress(bytes, smooth); if (hc.nx * hc.ny !== n) throw new Error(`tile ${r + 1}: H-compress size ${hc.nx} × ${hc.ny} for ${n} pixels`); ints = hc.data; }
        else if (cmp === 'GZIP_1' || cmp === 'GZIP_2') { let inf = inflate(bytes).data; if (cmp === 'GZIP_2') inf = unshuffleBytes(inf, Math.abs(storedBitpix) / 8); vals = samples(inf, n, storedBitpix); }
        else if (cmp === 'NOCOMPRESS') vals = samples(bytes, n, storedBitpix);
        else throw new Error(`${cmp} tiles are not supported`);
      } else {
        const g = cell(gz, r), u = cell(raw, r);
        if (g) { vals = samples(inflate(g).data, n, h.bitpix); lossless = true; }
        else if (u) { vals = samples(u, n, h.bitpix); lossless = true; }
        else throw new Error(`tile ${r + 1} is empty`);
      }
    } catch (e) {
      if (reported++ < 3) warnings.push(`HDU ${hi + 1}: ${(e as Error).message}`);
      continue;
    }
    const src: ArrayLike<number> = ints || vals!;
    // Place the tile; quantized integers become floats through ZSCALE/ZZERO (with the dither undone), nulls flagged.
    const scale = number(zs, r, +(c.get('ZSCALE') || 1)), zero = number(zz, r, +(c.get('ZZERO') || 0)), nullValue = zb ? number(zb, r, nullKeyword ?? NaN) : nullKeyword;
    let iseed = 0, next = 0;
    if (dither && quantized && !lossless) { iseed = (r + dither0 - 1) % 10000; next = Math.floor(Math.fround(randoms![iseed] * 500)); }
    const nz = size[2] || 1, ny = size[1] || 1, nx = size[0];
    let k = 0;
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) {
      const base = (origin[0] || 0) + stride[1] * ((origin[1] || 0) + y) + stride[2] * ((origin[2] || 0) + z);
      for (let x = 0; x < nx; x++, k++) {
        let v = src[k];
        if (quantized && !lossless) {
          if (nullValue !== null && v === nullValue) { v = NaN; }
          else if (dither === 2 && v === -2147483646) v = 0;
          else if (dither) v = (v - randoms![next] + 0.5) * scale + zero;
          else v = v * scale + zero;
          if (dither) { next++; if (next === 10000) { iseed = (iseed + 1) % 10000; next = Math.floor(Math.fround(randoms![iseed] * 500)); } }
        } else if (nullValue !== null && !quantized && v === nullValue) v = NaN;
        if (v !== v) { nulls ??= new Uint8Array(total); nulls[base + x] = 1; }
        values[base + x] = v;
      }
    }
  }
  return { values, nulls };
}

const INFO_KEYS: [string, string][] = [['OBJECT', 'object'], ['TELESCOP', 'telescope'], ['INSTRUME', 'instrument'], ['OBSERVER', 'observer'], ['DATE-OBS', 'observed'], ['EXPTIME', 'exposure (s)'], ['FILTER', 'filter'], ['BUNIT', 'unit'], ['ORIGIN', 'origin'], ['DATE', 'written'], ['CTYPE1', 'axis 1'], ['CTYPE2', 'axis 2'], ['RA', 'RA'], ['DEC', 'Dec'], ['EQUINOX', 'equinox']];

export type FitsStretchMode = 'linear' | 'sqrt' | 'square' | 'log' | 'asinh';
/** FITS Stretch: the mapping from values to gray and its limits (percentiles of the finite values, or values). */
export interface FitsStretch { mode?: FitsStretchMode; percentiles?: [number, number]; lo?: number; hi?: number }
const STRETCH: Record<FitsStretchMode, (t: number) => number> = { linear: (t) => t, sqrt: Math.sqrt, square: (t) => t * t, log: (t) => Math.log10(1 + 1000 * t) / 3, asinh: (t) => Math.asinh(10 * t) / Math.asinh(10) };
/** The file's bytes with a gzipped file inflated (for the header viewer). */
export function fitsBytes(input: Uint8Array, name = ''): Uint8Array { return isGzipFits(input, name) ? inflate(input).data : input; }
/** The 80-character cards of an HDU's header, in order (a gzipped file inflated first). */
export function fitsCards(input: Uint8Array, hdu: number, name = ''): string[] {
  const u8 = fitsBytes(input, name), hdus = fitsHdus(u8);
  let p = 0;
  for (let i = 0; i < hdus.length && i <= hdu; i++) {
    if (i === hdu) {
      const cards: string[] = [];
      for (let q = p; q + 80 <= u8.length; q += 80) { const c = String.fromCharCode(...u8.subarray(q, q + 80)).replace(/\s+$/, ''); cards.push(c); if (/^END\s*$/.test(c)) break; }
      return cards;
    }
    p = hdus[i].dataStart + Math.ceil(hdus[i].dataLength / 2880) * 2880;
  }
  return [];
}
/** The HDU each page of the decoded file comes from (image HDUs, a page per plane of a cube). */
export function fitsPageHdus(input: Uint8Array, name = ''): number[] {
  const out: number[] = [];
  fitsHdus(fitsBytes(input, name)).forEach((h, i) => { if ((h.kind === 'image' || h.kind === 'compressed') && h.axes.length >= 2 && h.axes[0] > 0 && h.axes[1] > 0) { const depth = h.axes.slice(2).reduce((a, b) => a * b, 1) || 1; for (let k = 0; k < depth; k++) out.push(i); } });
  return out;
}
export function decodeFits(input: Uint8Array, name = '', st: FitsStretch = {}): DecodeResult {
  let u8 = input;
  if (isGzipFits(u8, name)) u8 = inflate(u8).data;
  const mode: FitsStretchMode = st.mode && STRETCH[st.mode] ? st.mode : 'linear', f = STRETCH[mode];
  const pct: [number, number] = st.percentiles && st.percentiles[1] > st.percentiles[0] ? [Math.max(0, st.percentiles[0]), Math.min(100, st.percentiles[1])] : [0.5, 99.5];
  const fixed = Number.isFinite(st.lo) && Number.isFinite(st.hi) && st.hi! > st.lo!;
  if (!isFits(u8)) throw new Error('This is not a FITS file (no SIMPLE card)');
  const { planes, hdus, warnings } = fitsData(u8);
  if (!planes.length) throw new Error(`This FITS file holds no image${hdus.some((h) => h.kind === 'table') ? ' (tables only)' : ''}${warnings.length ? ` (${warnings.join('; ')})` : ''}`);
  const pages: DecodedPage[] = [];
  for (const pl of planes) {
    const { width: w, height: h, values } = pl, hdu = hdus[pl.hdu];
    // The stretch: the 0.5th and 99.5th percentiles of the finite values (sampled when large).
    const finite: number[] = [];
    const step = Math.max(1, Math.floor(values.length / 200000));
    for (let i = 0; i < values.length; i += step) if (Number.isFinite(values[i])) finite.push(values[i]);
    finite.sort((a, b) => a - b);
    let lo = finite.length ? finite[Math.floor(finite.length * (pct[0] / 100))] : 0, hi = finite.length ? finite[Math.min(finite.length - 1, Math.floor(finite.length * (pct[1] / 100)))] : 1;
    if (!(hi > lo)) { lo = finite.length ? finite[0] : 0; hi = finite.length ? finite[finite.length - 1] : 1; if (!(hi > lo)) hi = lo + 1; }
    if (fixed) { lo = st.lo!; hi = st.hi!; }
    const r = makeRaster(w, h), d = r.data;
    let transparent = false;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = values[y * w + x], o = ((h - 1 - y) * w + x) * 4; // the first stored row at the bottom
      if (!Number.isFinite(v)) { d[o + 3] = 0; transparent = true; continue; }
      const g = Math.round(f(Math.max(0, Math.min(1, (v - lo) / (hi - lo)))) * 255);
      d[o] = d[o + 1] = d[o + 2] = g; d[o + 3] = 255;
    }
    const depth = hdu.axes.slice(2).reduce((a, b) => a * b, 1) || 1;
    const kind = `${Math.abs(hdu.bitpix)}-bit ${hdu.bitpix < 0 ? 'floating-point' : 'integer'}`;
    const bunit = hdu.cards.get('BUNIT');
    const cmp = hdu.kind === 'compressed' ? (hdu.cards.get('ZCMPTYPE') || 'RICE_1').trim() : '';
    const quantiz = hdu.kind === 'compressed' && hdu.bitpix < 0 ? ` (quantized${/DITHER/.test(hdu.cards.get('ZQUANTIZ') || '') ? ' with dither' : ''})` : '';
    const notes = [`FITS ${pl.hdu === 0 ? 'primary image' : `image extension ${pl.hdu}${hdu.cards.get('EXTNAME') ? ` "${hdu.cards.get('EXTNAME')}"` : ''}`}${depth > 1 ? `, plane ${pl.plane + 1} of ${depth}` : ''}, ${kind}${hdu.cards.has('BZERO') || hdu.cards.has('BSCALE') ? ' (BZERO/BSCALE applied)' : ''}${cmp ? `, ${cmp} tiles${quantiz}` : ''}`,
      `shown stretched ${mode === 'linear' ? 'linearly' : mode === 'sqrt' ? 'by the square root' : mode === 'square' ? 'by the square' : mode === 'log' ? 'logarithmically' : 'by the inverse hyperbolic sine'} from ${fmt(lo)} to ${fmt(hi)}${bunit ? ` ${bunit}` : ''} (${fixed ? 'FITS Stretch limits' : `the ${pctName(pct[0])} and ${pctName(pct[1])} percentiles`}); the first stored row is at the bottom`];
    if (pl.blank) notes.push('undefined (BLANK) pixels are transparent');
    let world: Wcs | null = null;
    try { world = parseWcs(hdu.cards, w, h); } catch { world = null; }
    if (world) { const center = pixelToWorld(world, w / 2, h / 2); notes.push(`${world.proj ? `${world.proj} projection` : 'linear axes'}: ${center ? `the center is at ${formatWorld(world, center)}` : 'the center lies outside the projection'}; the pixel readout and Measure show sky positions`); }
    pages.push({ width: w, height: h, frames: [{ raster: r, delay: 0 }], loops: 0, bitDepth: Math.abs(hdu.bitpix), hasAlpha: transparent, notes, ...(world ? { world } : {}) });
  }
  const info: Record<string, string> = { HDUs: String(hdus.length), planes: String(planes.length) };
  const primary = hdus[planes[0].hdu].cards;
  for (const [k, label] of INFO_KEYS) { const v = primary.get(k) ?? hdus[0].cards.get(k); if (v !== undefined && v !== '') info[label] = v; }
  const compressed = hdus.find((h) => h.kind === 'compressed');
  if (compressed) info.compression = `${(compressed.cards.get('ZCMPTYPE') || 'RICE_1').trim()} tiles of ${compressed.axes.map((_, i) => compressed.cards.get(`ZTILE${i + 1}`) || (i === 0 ? compressed.axes[0] : 1)).join(' × ')}${compressed.bitpix < 0 ? `, ${(compressed.cards.get('ZQUANTIZ') || 'NO_DITHER').trim()}` : ''}`;
  const comments = hdus[planes[0].hdu].comments.filter((c) => c.startsWith('COMMENT')).map((c) => c.slice(9).trim()).filter(Boolean);
  if (comments.length) info.comments = comments.slice(0, 20).join(' | ');
  return { pages, info, warnings };
}
const pctName = (p: number): string => { const s = +p.toFixed(3) + ''; return s + (/1$/.test(s) && !/11$/.test(s) ? 'st' : /2$/.test(s) && !/12$/.test(s) ? 'nd' : /3$/.test(s) && !/13$/.test(s) ? 'rd' : 'th'); };
const fmt = (v: number) => (Math.abs(v) >= 1e5 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(3) : +v.toFixed(3) + '');
