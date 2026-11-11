/**
 * DNG reading for Develop RAW: finds the raw image (IFD0, its chain or SubIFDs; full-size, not a
 * reduced copy), reads CFA or linear data that is uncompressed (8 or 16 bits, or packed 10/12/14 bits)
 * or lossless-JPEG compressed, in strips or tiles, and collects what development needs: CFA pattern,
 * linearization table, black levels (per CFA position, with row and column deltas), white level,
 * active area, default crop, color matrices, calibration illuminants, camera calibration, analog
 * balance, as-shot neutral or white point, baseline exposure and orientation.
 */
import { readIfd, type IfdEntry } from '../codecs/tiff';
import { checkSensor } from './limits';
import { decodeLjpeg } from './ljpeg';
import { latin1 } from '../codecs/limits';

export interface DngRaw {
  width: number; height: number;
  /** CFA mosaic (one sample per pixel) or linear RGB (three per pixel), linearized, before black subtraction. */
  data: Uint16Array; samples: 1 | 3;
  /** Color index (0 R, 1 G, 2 B) of each position of the 2×2 pattern (row-major); CFA only. */
  cfa: number[] | null;
  black: Float32Array; // per pixel position in the repeat (row-major blackDim)
  blackDim: [number, number];
  blackRow: Float32Array | null; blackCol: Float32Array | null;
  white: number[];
  crop: { x: number; y: number; w: number; h: number } | null;
  colorMatrix1: number[] | null; colorMatrix2: number[] | null; illuminant1: number; illuminant2: number;
  cameraCalibration1: number[] | null; cameraCalibration2: number[] | null; analogBalance: number[] | null;
  asShotNeutral: number[] | null; asShotWhiteXY: number[] | null;
  baselineExposure: number; orientation: number; make: string; model: string;
}

const tag = (m: Map<number, IfdEntry>, t: number) => m.get(t)?.values;
const text = (m: Map<number, IfdEntry>, t: number) => { const v = m.get(t)?.values; return v ? latin1(v.filter((c) => c)).trim() : ''; };

export function isDng(u8: Uint8Array): boolean {
  if (u8.length < 16) return false;
  const le = u8[0] === 0x49 && u8[1] === 0x49; if (!le && !(u8[0] === 0x4d && u8[1] === 0x4d)) return false;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  try { return readIfd(u8, dv.getUint32(4, le), le).tags.has(50706); } catch { return false; }
}

/** All IFDs: the chain from the header and every SubIFD (depth-first), with IFD0 first. */
function allIfds(u8: Uint8Array, le: boolean): Map<number, IfdEntry>[] {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), out: Map<number, IfdEntry>[] = [], seen = new Set<number>();
  const visit = (off: number, depth: number) => {
    while (off && off < u8.length && !seen.has(off) && out.length < 64) {
      seen.add(off);
      const { tags, next } = readIfd(u8, off, le); out.push(tags);
      if (depth < 3) for (const s of tags.get(330)?.values || []) visit(s, depth + 1);
      off = next;
    }
  };
  visit(dv.getUint32(4, le), 0);
  return out;
}

/** Reads the raw image of a DNG. */
export function readDng(u8: Uint8Array): DngRaw {
  const le = u8[0] === 0x49;
  const ifds = allIfds(u8, le); if (!ifds.length || !ifds[0].has(50706)) throw new Error('Not a DNG file');
  const ifd0 = ifds[0];
  const raws = ifds.filter((t) => (tag(t, 254)?.[0] ?? 0) === 0 && [32803, 34892].includes(tag(t, 262)?.[0] ?? 0));
  if (!raws.length) throw new Error('No raw image in this DNG');
  const r = raws.reduce((a, b) => ((tag(b, 256)?.[0] || 0) * (tag(b, 257)?.[0] || 0) > (tag(a, 256)?.[0] || 0) * (tag(a, 257)?.[0] || 0) ? b : a));
  const get = (t: number) => tag(r, t) ?? tag(ifd0, t);
  const width = tag(r, 256)![0], height = tag(r, 257)![0], bps = tag(r, 258)?.[0] || 16, comp = tag(r, 259)?.[0] || 1, photometric = tag(r, 262)![0];
  const spp = (tag(r, 277)?.[0] || 1) as number;
  if (photometric === 32803 && spp !== 1) throw new Error('CFA data with several samples per pixel is not supported');
  if (photometric === 34892 && spp !== 3) throw new Error(`Linear raw with ${spp} samples is not supported`);
  if ((tag(r, 339)?.[0] || 1) === 3) throw new Error('Floating-point DNG is not supported');
  if (comp !== 1 && comp !== 7) throw new Error(comp === 34892 ? 'Lossy-compressed DNG is not supported yet' : comp === 8 ? 'Deflate-compressed (floating-point) DNG is not supported yet' : `DNG compression ${comp} is not supported`);
  if ((tag(r, 284)?.[0] || 1) !== 1 && spp > 1) throw new Error('Planar DNG data is not supported');
  checkSensor('DNG', width, height, spp, u8.length, 1); // no coding here holds a sample in less than a bit
  const data = new Uint16Array(width * height * spp);
  // Pieces: strips (full width) or tiles.
  const tw = tag(r, 322)?.[0], tl = tag(r, 323)?.[0];
  const offs = tw ? tag(r, 324)! : tag(r, 273)!, lens = tw ? tag(r, 325)! : tag(r, 279)!;
  const pw = tw || width, ph = tw ? tl! : tag(r, 278)?.[0] || height, across = Math.ceil(width / pw);
  for (let k = 0; k < offs.length; k++) {
    const x0 = (k % across) * pw, y0 = Math.floor(k / across) * ph; if (y0 >= height) break;
    const src = u8.subarray(offs[k], offs[k] + lens[k]);
    const put = (seq: ArrayLike<number>, rowLen: number) => {
      // Samples in order fill the piece row by row (rowLen samples per row).
      const rows = Math.min(ph, Math.ceil(seq.length / rowLen));
      for (let y = 0; y < rows && y0 + y < height; y++) {
        const n = Math.min(rowLen, (width - x0) * spp);
        const dst = ((y0 + y) * width + x0) * spp;
        for (let i = 0; i < n; i++) data[dst + i] = seq[y * rowLen + i];
      }
    };
    if (comp === 7) {
      const f = decodeLjpeg(src);
      put(f.data, pw * spp);
    } else if (bps === 16) {
      const n = Math.floor(src.length / 2), v = new Uint16Array(n);
      for (let i = 0; i < n; i++) v[i] = le ? src[i * 2] | (src[i * 2 + 1] << 8) : (src[i * 2] << 8) | src[i * 2 + 1];
      put(v, pw * spp);
    } else if (bps === 8) {
      put(src, pw * spp);
    } else if (bps > 8 && bps < 16) {
      // Packed big-endian bits, rows starting on byte boundaries.
      const rowSamples = pw * spp, rowBytes = Math.ceil((rowSamples * bps) / 8), rows = Math.floor(src.length / rowBytes), v = new Uint16Array(rows * rowSamples);
      for (let y = 0; y < rows; y++) { let bit = y * rowBytes * 8; for (let i = 0; i < rowSamples; i++, bit += bps) { let s = 0; for (let b = 0; b < bps; b++) { const q = bit + b; s = (s << 1) | ((src[q >> 3] >> (7 - (q & 7))) & 1); } v[y * rowSamples + i] = s; } }
      put(v, rowSamples);
    } else throw new Error(`${bps}-bit DNG data is not supported`);
  }
  // Linearization.
  const lin = tag(r, 50712);
  if (lin && lin.length > 1) { const last = lin.length - 1; for (let i = 0; i < data.length; i++) data[i] = lin[Math.min(last, data[i])]; }
  // CFA pattern: 2×2 only (Bayer); the colors come from CFAPlaneColor (default R, G, B).
  let cfa: number[] | null = null;
  if (photometric === 32803) {
    const dim = tag(r, 33421) || [2, 2], pat = tag(r, 33422), planes = tag(r, 50710) || [0, 1, 2];
    if (dim[0] !== 2 || dim[1] !== 2 || !pat || pat.length < 4) throw new Error(dim[0] === 6 ? 'X-Trans sensors (6×6 pattern) are not supported' : 'Only 2×2 Bayer patterns are supported');
    cfa = pat.slice(0, 4).map((c) => planes.indexOf(c));
    if (cfa.some((c) => c < 0 || c > 2) || new Set(cfa).size !== 3) throw new Error('Only red, green and blue Bayer sensors are supported');
  }
  const bdim = (tag(r, 50713) || [1, 1]) as number[], bl = tag(r, 50714) || [0];
  const nb = bdim[0] * bdim[1] * spp, black = new Float32Array(nb);
  for (let i = 0; i < nb; i++) black[i] = bl[Math.min(i, bl.length - 1)];
  const dh = tag(r, 50715), dvv = tag(r, 50716);
  const white = (tag(r, 50717) || [(1 << bps) - 1]).slice();
  const area = tag(r, 50829), co = tag(r, 50719), cs = tag(r, 50720);
  let crop: DngRaw['crop'] = null;
  // ActiveArea (top, left, bottom, right) is applied here; DefaultCrop is relative to it.
  let out = data, W = width, Hh = height, blackRow = dvv ? Float32Array.from(dvv) : null, blackCol = dh ? Float32Array.from(dh) : null;
  // An ActiveArea outside the image is ignored (the whole image is then the active one).
  if (area && area.length === 4 && area[0] >= 0 && area[1] >= 0 && area[2] > area[0] && area[3] > area[1] && area[2] <= height && area[3] <= width && (area[0] || area[1] || area[2] !== height || area[3] !== width)) {
    const [t, l, b, rr] = area; W = rr - l; Hh = b - t; out = new Uint16Array(W * Hh * spp);
    for (let y = 0; y < Hh; y++) out.set(data.subarray(((t + y) * width + l) * spp, ((t + y) * width + l + W) * spp), y * W * spp);
  }
  if (co && cs) crop = { x: Math.round(co[0]), y: Math.round(co[1]), w: Math.round(cs[0]), h: Math.round(cs[1]) };
  return {
    width: W, height: Hh, data: out, samples: spp as 1 | 3, cfa, black, blackDim: [bdim[0], bdim[1]], blackRow, blackCol, white,
    crop, colorMatrix1: get(50721) || null, colorMatrix2: get(50722) || null, illuminant1: get(50778)?.[0] ?? 0, illuminant2: get(50779)?.[0] ?? 0,
    cameraCalibration1: get(50723) || null, cameraCalibration2: get(50724) || null, analogBalance: get(50727) || null,
    asShotNeutral: get(50728) || null, asShotWhiteXY: get(50729) || null, baselineExposure: get(50730)?.[0] ?? 0,
    orientation: tag(ifd0, 274)?.[0] || 1, make: text(ifd0, 271), model: text(ifd0, 272) || text(ifd0, 50708),
  };
}
