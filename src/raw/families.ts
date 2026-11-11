/**
 * Camera RAW families other than DNG, read into the same record the DNG developer uses (DngRaw), so
 * Develop RAW works on them: the sensor data at its full size, the Bayer pattern, black and white
 * levels, the as-shot white balance where the file carries one, the maker's crop and the orientation.
 *
 * Readers. A maker's name here does not mean every file of that maker: each coding below was checked against LibRaw's
 * reading of one real file (named), and a layout that was not checked is refused rather than guessed at.
 *   TIFF-based files (NEF, NRW, PEF, ERF, ORF, SR2, ARW, SRW, CR2, MOS, DCR): the sensor IFD, with
 *     - 16-bit words (Olympus E-10, Sony DSC-R1, Samsung EX1, Nikon Coolpix P330);
 *     - 12-bit samples packed most significant bit first in big-endian NEF and PEF files (Nikon D1H, Pentax *ist DL)
 *       and Epson's padded rows (R-D1); other packed layouts (Samsung's, Olympus's, Nikon's little-endian) are refused;
 *     - lossless JPEG (CR2 with Canon's slices: EOS 350D, PowerShot S2 IS; Leaf's 16-bit tiles: Aptus 22);
 *     - Sony's ARW2 curve coding (ILCE-7S), Nikon's Huffman coding (D2H) and small-size YCbCr NEFs (D4S), Kodak's
 *       65000 coding (DCS760C);
 *     white balance from the Nikon, Pentax, Olympus, Epson, Canon, Sony (decrypted SR2 block) and Leaf maker data.
 *     Not read, and said so before Develop RAW is offered: Pentax's compressed PEF (K10D and later), Olympus's
 *     compressed ORF (nearly every camera after the E-10 and E-20), Samsung's compressed SRW, Canon's sRAW and mRAW.
 *   MRW (Minolta): PRD/WBG/TTW blocks, packed or unpacked data.
 *   RAF (Fujifilm, Bayer sensors): the CFA header and the CFA TIFF; X-Trans is refused.
 *   RW2/RWL (Panasonic, Leica): the version-4 bit-packed coding of 12-bit files.
 * Color: these files carry no color matrices. Development treats the sensor's channels as sRGB
 * primaries (the sRGB matrix stands in for the camera matrix), which keeps neutrals neutral and
 * exposure right; saturated colors are approximate. Files whose coding is not handled (CR3, CRW, X3F,
 * IIQ, 3FR/FFF, SRF, newer RW2, Sony ARW1, X-Trans RAF) are refused with a plain reason.
 */
import { readIfd, type IfdEntry } from '../codecs/tiff';
import { readDng, isDng, type DngRaw } from './dng';
import { decodeLjpeg } from './ljpeg';
import { checkSensor } from './limits';
import { latin1 } from '../codecs/limits';

type Tags = Map<number, IfdEntry>;

export interface RawSupport { ok: boolean; family: string; why?: string }

/** The sRGB (D65) XYZ → RGB matrix, standing in for the camera matrix of files that carry none. */
export const GENERIC_COLOR_MATRIX = [3.2406, -1.5372, -0.4986, -0.9689, 1.8758, 0.0415, 0.0557, -0.204, 1.057];

const v = (m: Tags | undefined, t: number) => m?.get(t)?.values;
const n1 = (m: Tags | undefined, t: number, d = 0) => v(m, t)?.[0] ?? d;
const text = (m: Tags | undefined, t: number) => { const x = v(m, t); return x ? latin1(x.filter((c) => c)).trim() : ''; };
const bytesOf = (m: Tags | undefined, t: number) => { const x = v(m, t); return x ? Uint8Array.from(x) : null; };
const ext = (name: string) => (name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
const dvOf = (u8: Uint8Array) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
const isTiff = (u8: Uint8Array) => u8.length > 16 && ((u8[0] === 0x49 && u8[1] === 0x49 && u8[2] === 42 && u8[3] === 0) || (u8[0] === 0x4d && u8[1] === 0x4d && u8[2] === 0 && u8[3] === 42));
const starts = (u8: Uint8Array, s: string, o = 0) => { if (o + s.length > u8.length) return false; for (let i = 0; i < s.length; i++) if (u8[o + i] !== s.charCodeAt(i)) return false; return true; };

interface Fields {
  width: number; height: number; data: Uint16Array; samples?: 1 | 3; cfa: number[] | null;
  /** Black per color (R, G, B, G2) or one value. */ black: number[]; white: number;
  /** Camera multipliers R, G, B (as shot), or null when the file carries none (gray-world then). */ wb: number[] | null;
  crop?: { x: number; y: number; w: number; h: number } | null; orientation?: number; make: string; model: string;
}

/** The DngRaw record for a family reader's fields. */
function record(f: Fields): DngRaw {
  const cfa = f.cfa, spp = f.samples || 1;
  const black = new Float32Array(cfa ? 4 : spp);
  if (cfa) { // per color → per position; the second green takes the fourth value when there is one
    let g2 = false;
    for (let p = 0; p < 4; p++) { const c = cfa[p]; let b = f.black[Math.min(c, f.black.length - 1)]; if (c === 1) { if (g2 && f.black.length >= 4) b = f.black[3]; g2 = true; } black[p] = b; }
  } else for (let s = 0; s < spp; s++) black[s] = f.black[Math.min(s, f.black.length - 1)];
  const wb = f.wb && f.wb.length >= 3 && f.wb[0] > 0 && f.wb[1] > 0 && f.wb[2] > 0 ? f.wb : null;
  return {
    width: f.width, height: f.height, data: f.data, samples: spp, cfa, black, blackDim: cfa ? [2, 2] : [1, 1], blackRow: null, blackCol: null, white: [f.white],
    crop: f.crop || null, colorMatrix1: GENERIC_COLOR_MATRIX, colorMatrix2: null, illuminant1: 21, illuminant2: 0, cameraCalibration1: null, cameraCalibration2: null, analogBalance: null,
    asShotNeutral: wb ? [wb[1] / wb[0], 1, wb[1] / wb[2]] : null, asShotWhiteXY: null, baselineExposure: 0, orientation: f.orientation || 1, make: f.make, model: f.model,
  };
}

// Bit unpacking ---------------------------------------------------------------------------------------
/** Packed samples, `bps` bits each, most significant bit first (the TIFF way). `pad` > 0 skips one byte after every `pad` samples (Epson). */
export function unpackBe(src: Uint8Array, count: number, bps: number, pad = 0): Uint16Array {
  const out = new Uint16Array(count); let acc = 0, bits = 0, p = 0;
  for (let i = 0; i < count; i++) {
    while (bits < bps) { acc = ((acc << 8) | (src[p++] ?? 0)) >>> 0; bits += 8; }
    out[i] = (acc >>> (bits - bps)) & ((1 << bps) - 1); bits -= bps; acc &= (1 << bits) - 1;
    if (pad && i % pad === pad - 1) { p++; acc = 0; bits = 0; }
  }
  return out;
}
/** Packed samples, least significant bits first within little-endian byte groups (Nikon's and Fujifilm's 12-bit packing). */
export function unpackLe(src: Uint8Array, count: number, bps: number): Uint16Array {
  const out = new Uint16Array(count); let acc = 0, bits = 0, p = 0;
  for (let i = 0; i < count; i++) {
    while (bits < bps) { acc |= (src[p++] ?? 0) << bits; bits += 8; }
    out[i] = acc & ((1 << bps) - 1); acc >>>= bps; bits -= bps;
  }
  return out;
}
/** 16-bit samples in the given byte order, shifted down by `shift`. */
export function unpack16(src: Uint8Array, count: number, le: boolean, shift = 0): Uint16Array {
  const out = new Uint16Array(count);
  for (let i = 0, p = 0; i < count; i++, p += 2) out[i] = (le ? src[p] | (src[p + 1] << 8) : (src[p] << 8) | src[p + 1]) >> shift;
  return out;
}
/** How far 16-bit samples that all share zero low bits were shifted up (Olympus and Nikon store 10/12-bit values that way). */
export function commonShift(data: Uint16Array, max = 8): number {
  if (!max) return 0;
  const counts = new Float64Array(max); let any = 0;
  for (let i = 0; i < data.length; i++) { const x = data[i]; any |= x; for (let b = 0; b < max; b++) if (x & (1 << b)) counts[b]++; }
  if (!any) return 0;
  // The shift is the highest bit below which fewer than one sample in a thousand has anything set (a few stray bits do not count).
  let s = 0, below = 0; const limit = data.length / 1000;
  while (s < max && below + counts[s] <= limit) { below += counts[s]; s++; }
  return s;
}

// Maker-specific codings -----------------------------------------------------------------------------
/** Sony's ARW2 coding: 16 pixels of one color in 128 bits (11-bit max and min, their positions, fourteen 7-bit deltas), through the camera's curve. */
export function decodeArw2(src: Uint8Array, width: number, height: number, curveTag: number[] | undefined): Uint16Array {
  const sony = [0, 0, 0, 0, 0, 4095]; if (curveTag) for (let c = 0; c < 4; c++) sony[c + 1] = (curveTag[c] >> 2) & 0xfff;
  const curve = new Uint16Array(0x4001); for (let i = 0; i <= 0x4000; i++) curve[i] = i;
  for (let i = 0; i < 5; i++) for (let j = sony[i] + 1; j <= sony[i + 1]; j++) curve[j] = curve[j - 1] + (1 << i);
  const padded = new Uint8Array(src.length + 2); padded.set(src); // the last 7-bit field may be read as a 16-bit word
  const out = new Uint16Array(width * height), dv = dvOf(padded), pix = new Uint16Array(16);
  let dp = 0;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width - 30; dp += 16) {
      if (dp + 16 > src.length) return out;
      const head = dv.getUint32(dp, true), max = head & 0x7ff, min = (head >>> 11) & 0x7ff, imax = (head >>> 22) & 0xf, imin = (head >>> 26) & 0xf;
      let sh = 0; while (sh < 4 && (0x80 << sh) <= max - min) sh++;
      for (let i = 0, bit = 30; i < 16; i++) {
        if (i === imax) pix[i] = max;
        else if (i === imin) pix[i] = min;
        else { pix[i] = Math.min(0x7ff, (((dv.getUint16(dp + (bit >> 3), true) >> (bit & 7)) & 0x7f) << sh) + min); bit += 7; }
      }
      for (let i = 0; i < 16; i++, col += 2) if (col < width) out[row * width + col] = curve[pix[i] << 1];
      col -= col & 1 ? 1 : 31;
    }
  }
  return out;
}

/** Panasonic's version-4 coding (12-bit RW2/RWL): 14-pixel groups with shared shifts, in 16 KB blocks whose halves are swapped. */
export function decodePanasonic(src: Uint8Array, width: number, height: number, split = 0x2008): Uint16Array {
  const buf = new Uint8Array(0x4001); let vbits = 0, sp = 0;
  const bits = (nbits: number): number => {
    if (!vbits) {
      buf.set(src.subarray(sp, sp + 0x4000 - split), split); buf.set(src.subarray(sp + 0x4000 - split, sp + 0x4000), 0); sp += 0x4000;
      if (sp > src.length + 0x4000) throw new Error('Panasonic data ends early');
    }
    vbits = (vbits - nbits) & 0x1ffff;
    const byte = (vbits >> 3) ^ 0x3ff0;
    return ((buf[byte] | (buf[byte + 1] << 8)) >> (vbits & 7)) & ((1 << nbits) - 1);
  };
  const out = new Uint16Array(width * height), pred = [0, 0], nonz = [0, 0];
  let sh = 0;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const i = col % 14;
      if (i === 0) pred[0] = pred[1] = nonz[0] = nonz[1] = 0;
      if (i % 3 === 2) sh = 4 >> (3 - bits(2));
      if (nonz[i & 1]) {
        const j = bits(8);
        if (j) {
          if ((pred[i & 1] -= 0x80 << sh) < 0 || sh === 4) pred[i & 1] &= ~(-1 << sh);
          pred[i & 1] += j << sh;
        }
      } else if ((nonz[i & 1] = bits(8)) || i > 11) pred[i & 1] = (nonz[i & 1] << 4) | bits(4);
      out[row * width + col] = pred[col & 1];
    }
  }
  return out;
}

/** Kodak's 65000 coding: 256-pixel runs of 4-bit code lengths and differences, or a plain 12-bit fallback run. */
export function decodeKodak65000(src: Uint8Array, width: number, height: number, curve?: Uint16Array): Uint16Array {
  const out = new Uint16Array(width * height), buf = new Int16Array(256), blen = new Uint8Array(768); let sp = 0;
  const run = (bsize: number): boolean => {
    const save = sp, bs = (bsize + 3) & -4;
    for (let i = 0; i < bs; i += 2) {
      const c = src[sp++] ?? 0;
      if ((blen[i] = c & 15) > 12 || (blen[i + 1] = c >> 4) > 12) {
        sp = save;
        for (let k = 0; k < bs; k += 8) {
          const raw: number[] = []; for (let j = 0; j < 6; j++) { raw.push((src[sp] << 8) | src[sp + 1]); sp += 2; }
          buf[k] = ((raw[0] >> 12) << 8) | ((raw[2] >> 12) << 4) | (raw[4] >> 12); buf[k + 1] = ((raw[1] >> 12) << 8) | ((raw[3] >> 12) << 4) | (raw[5] >> 12);
          for (let j = 0; j < 6; j++) buf[k + 2 + j] = raw[j] & 0xfff;
        }
        return true;
      }
    }
    let bitbuf = 0, bits = 0; // at most 48 bits: exact in a double
    if ((bs & 7) === 4) { bitbuf = (src[sp] << 8) | src[sp + 1]; sp += 2; bits = 16; }
    for (let i = 0; i < bs; i++) {
      const len = blen[i];
      if (bits < len) { for (let j = 0; j < 32; j += 8) bitbuf += (src[sp++] ?? 0) * 2 ** (bits + (j ^ 8)); bits += 32; }
      const m = 2 ** len; let diff = bitbuf % m; bitbuf = Math.floor(bitbuf / m); bits -= len;
      if (len && (diff & (1 << (len - 1))) === 0) diff -= (1 << len) - 1;
      buf[i] = diff;
    }
    return false;
  };
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col += 256) {
      const len = Math.min(256, width - col), pred = [0, 0], raw = run(len);
      for (let i = 0; i < len; i++) { const x = raw ? buf[i] : (pred[i & 1] += buf[i]); const c = Math.max(0, Math.min(0xfff, x)); out[row * width + col + i] = curve ? curve[c] : c; }
    }
  }
  return out;
}

/** Nikon's Huffman trees (dcraw's table): code lengths by count for 16 lengths, then the symbols. */
const NIKON_TREES: number[][] = [
  [0, 1, 5, 1, 1, 1, 1, 1, 1, 2, 0, 0, 0, 0, 0, 0, 5, 4, 3, 6, 2, 7, 1, 0, 8, 9, 11, 10, 12], // 12-bit lossy
  [0, 1, 5, 1, 1, 1, 1, 1, 1, 2, 0, 0, 0, 0, 0, 0, 0x39, 0x5a, 0x38, 0x27, 0x16, 5, 4, 3, 2, 1, 0, 11, 12, 12], // 12-bit lossy after the split
  [0, 1, 4, 2, 3, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 4, 6, 3, 7, 2, 8, 1, 9, 0, 10, 11, 12], // 12-bit lossless
  [0, 1, 4, 3, 1, 1, 1, 1, 1, 2, 0, 0, 0, 0, 0, 0, 5, 6, 4, 7, 8, 3, 9, 2, 1, 0, 10, 11, 12, 13, 14], // 14-bit lossy
  [0, 1, 5, 1, 1, 1, 1, 1, 1, 1, 2, 0, 0, 0, 0, 0, 8, 0x5c, 0x4b, 0x3a, 0x29, 7, 6, 5, 4, 3, 2, 1, 0, 13, 14], // 14-bit lossy after the split
  [0, 1, 4, 2, 2, 3, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 7, 6, 8, 5, 9, 4, 10, 3, 11, 12, 2, 0, 1, 13, 14], // 14-bit lossless
];
/** A canonical Huffman table as a 16-bit lookup: entry = length << 8 | symbol. */
function huffTable(tree: number[]): Uint16Array {
  const lut = new Uint16Array(65536); let code = 0, k = 16;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < tree[len - 1]; i++, k++) { const sym = tree[k], start = code << (16 - len), count = 1 << (16 - len); lut.fill((len << 8) | sym, start, start + count); code++; }
    code <<= 1;
  }
  return lut;
}
class Bits {
  p = 0; acc = 0; n = 0;
  constructor(private src: Uint8Array, p = 0) { this.p = p; }
  peek16(): number { while (this.n < 16) { this.acc = ((this.acc << 8) | (this.src[this.p++] ?? 0)) >>> 0; this.n += 8; } return (this.acc >>> (this.n - 16)) & 0xffff; }
  skip(k: number) { this.n -= k; this.acc &= this.n ? (2 ** this.n - 1) : 0; }
  get(k: number): number { if (!k) return 0; const x = this.peek16() >>> (16 - k); this.skip(k); return x; }
}
/** Nikon's Huffman-coded NEF data (lossy type 1 and lossless, 12 and 14 bits) with the maker note's linearization block. */
export function decodeNikon(src: Uint8Array, width: number, height: number, bps: number, meta: Uint8Array): Uint16Array {
  const ver0 = meta[0], ver1 = meta[1]; let mp = 2;
  if (ver0 === 0x49 || ver1 === 0x58) mp += 2110;
  let tree = ver0 === 0x46 ? 2 : 0; if (bps === 14) tree += 3;
  const vpred = [[0, 0], [0, 0]]; for (let i = 0; i < 4; i++) { vpred[i >> 1][i & 1] = (meta[mp] << 8) | meta[mp + 1]; mp += 2; }
  let max = (1 << bps) & 0x7fff, split = 0;
  const curve = new Uint16Array(0x10000); for (let i = 0; i < 0x10000; i++) curve[i] = i;
  const csize = (meta[mp] << 8) | meta[mp + 1]; mp += 2;
  const step = csize > 1 ? Math.floor(max / (csize - 1)) : 0;
  if (ver0 === 0x44 && ver1 === 0x20 && step > 0) {
    for (let i = 0; i < csize; i++) { curve[i * step] = (meta[mp] << 8) | meta[mp + 1]; mp += 2; }
    for (let i = 0; i < max; i++) curve[i] = Math.floor((curve[i - (i % step)] * (step - (i % step)) + curve[i - (i % step) + step] * (i % step)) / step);
    split = (meta[562] << 8) | meta[563];
  } else if (ver0 !== 0x46 && csize <= 0x4001) { max = csize; for (let i = 0; i < csize; i++) { curve[i] = (meta[mp] << 8) | meta[mp + 1]; mp += 2; } }
  while (max > 2 && curve[max - 2] === curve[max - 1]) max--;
  let lut = huffTable(NIKON_TREES[tree]);
  const out = new Uint16Array(width * height), bits = new Bits(src), hpred = [0, 0];
  let min = 0;
  for (let row = 0; row < height; row++) {
    if (split && row === split) { lut = huffTable(NIKON_TREES[tree + 1]); max += (min = 16) << 1; }
    for (let col = 0; col < width; col++) {
      const e = lut[bits.peek16()]; bits.skip(e >> 8);
      const i = e & 255, len = i & 15, shl = i >> 4;
      let diff = ((bits.get(len - shl) << 1) + 1) << shl >> 1;
      if ((diff & (1 << (len - 1))) === 0) diff -= (1 << len) - (shl ? 0 : 1);
      if (col < 2) hpred[col] = vpred[row & 1][col] += diff; else hpred[col & 1] += diff;
      out[row * width + col] = curve[Math.max(0, Math.min(0x3fff, hpred[col & 1] << 16 >> 16))];
    }
  }
  return out;
}

/** Nikon's small-size NEF: 12-bit YCbCr 4:2:2 pairs in 6 bytes, to linear RGB (the camera's sRGB curve undone) with the white balance taken back out. */
export function decodeNikonYuv(src: Uint8Array, width: number, height: number, wb: number[] | null): Uint16Array {
  const out = new Uint16Array(width * height * 3), yuv = [0, 0, 0, 0], mul = wb && wb.length >= 3 ? [wb[0] / wb[1], 1, wb[2] / wb[1]] : [1, 1, 1];
  const curve = new Uint16Array(4096); // sRGB-style encoding undone: dcraw's gamma_curve(1/2.4, 12.92, 1, 4095)
  for (let i = 0; i < 4096; i++) { const x = i / 4095; const lin = x < 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; curve[i] = Math.round(lin * 4095); }
  let p = 0;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const b = col & 1;
      if (!b) {
        const lo = src[p] | (src[p + 1] << 8) | (src[p + 2] << 16), hi = src[p + 3] | (src[p + 4] << 8) | (src[p + 5] << 16); p += 6;
        yuv[0] = lo & 0xfff; yuv[1] = (lo >> 12) & 0xfff; yuv[2] = (hi & 0xfff) - 2048; yuv[3] = ((hi >> 12) & 0xfff) - 2048;
      }
      const rgb = [yuv[b] + 1.370705 * yuv[3], yuv[b] - 0.337633 * yuv[2] - 0.698001 * yuv[3], yuv[b] + 1.732446 * yuv[2]];
      const o = (row * width + col) * 3;
      for (let c = 0; c < 3; c++) out[o + c] = Math.min(4095, Math.round(curve[Math.max(0, Math.min(4095, Math.round(rgb[c])))] / mul[c]));
    }
  }
  return out;
}

/** Sony's SR2 block cipher (a 127-word lagged shift register), used on the private IFD that holds white balance and black levels. */
export function sonyDecrypt(data: Uint8Array, key: number): Uint8Array {
  const pad = new Uint32Array(128); let k = key >>> 0;
  for (let p = 0; p < 4; p++) { k = (Math.imul(k, 48828125) + 1) >>> 0; pad[p] = k; }
  pad[3] = ((pad[3] << 1) | ((pad[0] ^ pad[2]) >>> 31)) >>> 0;
  for (let p = 4; p < 127; p++) pad[p] = (((pad[p - 4] ^ pad[p - 2]) << 1) | ((pad[p - 3] ^ pad[p - 1]) >>> 31)) >>> 0;
  const out = new Uint8Array(data), dv = dvOf(out); let p = 127;
  for (let i = 0; i + 4 <= out.length; i += 4) { p++; const w = (pad[(p - 1) & 127] = (pad[p & 127] ^ pad[(p + 64) & 127]) >>> 0); dv.setUint32(i, (dv.getUint32(i, false) ^ w) >>> 0, false); }
  return out;
}

// TIFF-based families --------------------------------------------------------------------------------
/** Every IFD of a TIFF: the chain and the SubIFDs, plus the EXIF IFD (tagged separately). */
function allIfds(u8: Uint8Array, le: boolean): { ifds: Tags[]; exif: Tags | null } {
  const dv = dvOf(u8), ifds: Tags[] = [], seen = new Set<number>(); let exif: Tags | null = null;
  const visit = (off: number, depth: number) => {
    while (off && off + 2 < u8.length && !seen.has(off) && ifds.length < 64) {
      seen.add(off); const { tags, next } = readIfd(u8, off, le); ifds.push(tags);
      if (depth < 3) for (const s of v(tags, 330) || []) visit(s, depth + 1);
      const ex = n1(tags, 0x8769); if (ex && !exif && ex + 2 < u8.length) exif = readIfd(u8, ex, le).tags;
      off = next;
    }
  };
  visit(dv.getUint32(4, le), 0);
  return { ifds, exif };
}

interface Maker { kind: string; tags: Tags; base: Uint8Array; le: boolean }
/** The EXIF maker note as an IFD, by maker layout. */
function makerNote(u8: Uint8Array, le: boolean, exif: Tags | null): Maker | null {
  const e = exif?.get(0x927c); if (!e || e.count < 12) return null;
  // Its offset: readIfd gives values, so find the entry again for the data position.
  const dv = dvOf(u8);
  let off = -1;
  const exOff = findIfdOffset(u8, le, 0x8769); if (exOff < 0) return null;
  const n = dv.getUint16(exOff, le);
  for (let k = 0; k < n; k++) { const at = exOff + 2 + k * 12; if (dv.getUint16(at, le) === 0x927c) { off = e.count <= 4 ? at + 8 : dv.getUint32(at + 8, le); break; } }
  if (off < 0 || off + 12 > u8.length) return null;
  try {
    if (starts(u8, 'Nikon\0', off) && u8[off + 6] === 2) { const b = u8.subarray(off + 10); const l = b[0] === 0x49; return { kind: 'nikon', tags: readIfd(b, dvOf(b).getUint32(4, l), l).tags, base: b, le: l }; }
    if (starts(u8, 'OLYMP\0', off)) return { kind: 'olympus', tags: readIfd(u8, off + 8, le).tags, base: u8, le };
    if (starts(u8, 'OLYMPUS\0', off)) { const b = u8.subarray(off); const l = b[8] === 0x49; return { kind: 'olympus', tags: readIfd(b, 12, l).tags, base: b, le: l }; }
    if (starts(u8, 'EPSON\0', off)) return { kind: 'epson', tags: readIfd(u8, off + 8, le).tags, base: u8, le };
    if (starts(u8, 'AOC\0', off)) { const l = u8[off + 4] === 0x49; return { kind: 'pentax', tags: readIfd(u8, off + 6, l).tags, base: u8, le: l }; }
    if (starts(u8, 'PENTAX \0', off)) { const b = u8.subarray(off); const l = b[8] === 0x49; return { kind: 'pentax', tags: readIfd(b, 10, l).tags, base: b, le: l }; }
    if (starts(u8, 'SONY DSC \0', off) || starts(u8, 'SONY CAM \0', off)) return { kind: 'sony', tags: readIfd(u8, off + 12, le).tags, base: u8, le };
    const tags = readIfd(u8, off, le).tags; // bare IFDs: Nikon's oldest, Canon, Sony, Samsung
    return { kind: 'bare', tags, base: u8, le };
  } catch { return null; }
}
function findIfdOffset(u8: Uint8Array, le: boolean, pointerTag: number): number {
  const dv = dvOf(u8); let off = dv.getUint32(4, le); const seen = new Set<number>();
  while (off && off + 2 < u8.length && !seen.has(off)) {
    seen.add(off); const n = dv.getUint16(off, le);
    for (let k = 0; k < n && off + 2 + k * 12 + 12 <= u8.length; k++) { const at = off + 2 + k * 12; if (dv.getUint16(at, le) === pointerTag) return dv.getUint32(at + 8, le); }
    const nx = off + 2 + n * 12; if (nx + 4 > u8.length) break; off = dv.getUint32(nx, le);
  }
  return -1;
}

/** Sony's private IFD (DNGPrivateData → SR2Private → encrypted SR2SubIFD): white balance and black levels. */
function sonyPrivate(u8: Uint8Array, le: boolean, ifd0: Tags): { wb: number[] | null; black: number[] | null; white: number | null } {
  const none = { wb: null, black: null, white: null };
  const priv = v(ifd0, 0xc634); if (!priv || priv.length < 4) return none;
  const off = priv[0] | (priv[1] << 8) | (priv[2] << 16) | (priv[3] << 24); if (off <= 0 || off + 2 > u8.length) return none;
  try {
    const sr2 = readIfd(u8, off, le).tags, so = n1(sr2, 0x7200), sl = n1(sr2, 0x7201), key = v(sr2, 0x7221);
    if (!so || !sl || !key || so + sl > u8.length) return none;
    const k = key[0] | (key[1] << 8) | (key[2] << 16) | (key[3] << 24);
    const dec = sonyDecrypt(u8.subarray(so, so + sl), k);
    // The decrypted block is an IFD whose offsets are relative to the file; place it at its file offset.
    const view = new Uint8Array(so + sl); view.set(u8.subarray(0, so)); view.set(dec, so);
    const t = readIfd(view, so, le).tags;
    let wb: number[] | null = null;
    const rggb = v(t, 0x7313), grbg = v(t, 0x7303);
    if (rggb && rggb.length >= 4 && rggb[0] > 0) wb = [rggb[0], rggb[1], rggb[3]]; else if (grbg && grbg.length >= 4 && grbg[1] > 0) wb = [grbg[1], grbg[0], grbg[2]];
    const bl = v(t, 0x7310) || v(t, 0x7300); const black = bl && bl.length >= 4 ? [bl[0], bl[1], bl[3], bl[2]] : null;
    return { wb, black, white: null }; // 0x787f is the linear maximum, not the white level
  } catch { return none; }
}

/** The sensor IFD of a TIFF-based RAW: the largest single-sample image, or Canon's fourth IFD. */
function sensorIfd(ifds: Tags[], family: string): Tags | null {
  if (family === 'CR2') return ifds.find((t) => t.has(0xc640)) || ifds[3] || null;
  let best: Tags | null = null, area = 0;
  for (const t of ifds) {
    const w = n1(t, 256), h = n1(t, 257), spp = n1(t, 277, 1), photo = n1(t, 262, 1), sub = n1(t, 254, 0);
    if (!w || !h || (spp !== 1 && !t.has(33422)) || (sub & 1) || n1(t, 258, 1) < 8) continue;
    if (photo !== 32803 && photo !== 1 && photo !== 0) continue;
    if (w * h > area) { area = w * h; best = t; }
  }
  return best;
}

const CFA_CODES: Record<number, number[]> = { 1: [0, 1, 1, 2], 2: [1, 0, 2, 1], 3: [1, 2, 0, 1], 4: [2, 1, 1, 0] };
const cfaOf = (pattern: number[] | undefined): number[] | null => pattern && pattern.length >= 4 && pattern.slice(0, 4).every((c) => c <= 2) && new Set(pattern.slice(0, 4)).size === 3 ? pattern.slice(0, 4) : null;

/**
 * Reads a TIFF-based family. With `probe`, stops once the headers have said which coding the data is in and that it
 * is one this reader handles (throwing the reason when it is not), without touching the sensor data: rawSupport uses
 * that, so that what it reports and what a read then does cannot differ.
 */
function readTiffFamily(u8: Uint8Array, family: string, probe = false): DngRaw | null {
  const le = u8[0] === 0x49, { ifds, exif } = allIfds(u8, le), ifd0 = ifds[0];
  const make = text(ifd0, 271), model = text(ifd0, 272), o0 = n1(ifd0, 274, 1), orientation = o0 >= 1 && o0 <= 8 ? o0 : 1;
  const r = sensorIfd(ifds, family); if (!r) throw new Error(`${family}: no sensor image found in the file`);
  const comp = n1(r, 259, 1), mk = makerNote(u8, le, exif);
  let bps = n1(r, 258, 16), width = n1(r, 256), height = n1(r, 257);
  let cfa = cfaOf(v(r, 33422)), black: number[] = [0], white = 0, wb: number[] | null = null, crop: Fields['crop'] = null, samples: 1 | 3 = 1;
  // Maker data.
  let nikonMeta: Uint8Array | null = null;
  if (mk) {
    const t = mk.tags;
    if (family === 'NEF' || family === 'NRW') {
      const w = v(t, 0x0c); if (w && w.length >= 2 && w[0] > 0) wb = [w[0], 1, w[1]];
      const cb = v(t, 0x97); if (!wb && cb && cb.length > 14) { const ver = String.fromCharCode(...cb.slice(0, 4)); const sh = (o: number) => mk.le ? cb[o] | (cb[o + 1] << 8) : (cb[o] << 8) | cb[o + 1]; if (ver === '0102') wb = [sh(10), sh(12), sh(16)]; else if (ver === '0103') wb = [sh(20), sh(22), sh(24)]; else if (ver === '0100') wb = [sh(72), sh(76), sh(74)]; }
      const bl = v(t, 0x3d); if (bl && bl.length >= 4) black = [bl[0] >> (14 - bps), bl[1] >> (14 - bps), bl[3] >> (14 - bps), bl[2] >> (14 - bps)];
      nikonMeta = bytesOf(t, 0x96) || bytesOf(t, 0x8c);
    } else if (family === 'PEF') {
      const bl = v(t, 0x200); if (bl && bl.length >= 4) black = [bl[0], bl[1], bl[3], bl[2]];
      const w = v(t, 0x201); if (w && w.length >= 4) wb = [w[0], w[1], w[3]];
    } else if (family === 'ORF') {
      const rb = v(t, 0x1017), bb = v(t, 0x1018); if (rb && bb && rb[0] && bb[0]) wb = [rb[0] / 256, 1, bb[0] / 256];
      const bl = v(t, 0x1012); if (bl && bl.length >= 4) black = [bl[0], bl[1], bl[3], bl[2]];
      const ip = t.get(0x2040); // newer files: an ImageProcessing IFD with 0x0100 (WB R, B ×256) and 0x0600 (black ×4)
      if (ip) { try { const off = ip.type === 13 || ip.type === 4 ? ip.values[0] : -1; if (off > 0) { const s = readIfd(mk.base, off, mk.le).tags; const w = v(s, 0x100); if (w && w.length >= 2 && !wb) wb = [w[0] / 256, 1, w[1] / 256]; const b = v(s, 0x600); if (b && b.length >= 4) black = [b[0], b[1], b[3], b[2]]; } } catch { /* leave */ } }
    } else if (family === 'ERF') {
      const e = v(t, 0xe80); if (e && e.length >= 52) { const r0 = (e[48] << 8) | e[49], b0 = (e[50] << 8) | e[51]; wb = [(r0 * 508 * 1.078) / 0x10000, 1, (b0 * 382 * 1.173) / 0x10000]; }
    } else if (family === 'CR2') {
      const cd = v(t, 0x4001); if (cd && cd.length > 30) { const i = cd.length === 582 ? 25 : cd.length === 653 ? 34 : cd.length === 5120 ? 71 : 63; wb = [cd[i], cd[i + 1], cd[i + 3]]; }
      const si = v(t, 0xe0); if (si && si.length >= 9 && si[5] < si[7] && si[6] < si[8]) crop = { x: si[5], y: si[6], w: si[7] - si[5] + 1, h: si[8] - si[6] + 1 };
    }
  }
  if (family === 'ARW' || family === 'SR2') { const s = sonyPrivate(u8, le, ifd0); if (s.wb) wb = s.wb; if (s.black) black = s.black; if (s.white) white = s.white; }
  if (family === 'MOS') { const m = leafMeta(u8); if (m.cfa) cfa = m.cfa; if (m.wb) wb = m.wb; }
  // Pieces of data: strips or tiles, concatenated (the sensor is one image; strip boundaries fall on row boundaries).
  const tw = n1(r, 322), tl = n1(r, 323), offs = (tw ? v(r, 324) : v(r, 273)) || [], lens = (tw ? v(r, 325) : v(r, 279)) || [];
  if (!offs.length) throw new Error(`${family}: the sensor image has no data offsets`);
  let total = 0; for (let k = 0; k < offs.length; k++) total += Math.min(lens[k] || 0, Math.max(0, u8.length - offs[k]));
  if (tw && (tw !== width || tl < height) && comp !== 99 && comp !== 7) throw new Error(`${family}: tiled sensor data (${tw}×${tl}) is not handled`);
  const fileLe = le;
  // Which coding the data is in, from the headers alone. Every size is checked against the data present before anything is allocated.
  type Coding = 'cr2' | 'ljpeg' | 'nikon' | 'nikonYuv' | 'arw2' | 'kodak' | 'bytes' | 'words' | 'epson' | 'packedBe';
  let coding: Coding;
  const count = family === 'CR2' ? 0 : checkSensor(family, width, height); // a CR2's size comes from its lossless JPEG frame
  const rowBytes = total / height, plain = Math.ceil((width * bps) / 8);
  if (family === 'CR2') {
    if (ljpegSubsampled(u8.subarray(offs[0], offs[0] + Math.min(lens[0] || 0, 65536)))) throw new Error('CR2: sRAW and mRAW files (subsampled YCbCr) are not supported');
    coding = 'cr2';
  } else if (comp === 7 || comp === 99 || comp === 6) { checkSensor(family, width, height, 1, total, 1); coding = 'ljpeg'; }
  else if (comp === 34713 && total < count * 1.5 && total !== count && nikonMeta) { checkSensor(family, width, height, 1, total, 1); coding = 'nikon'; }
  else if (comp === 34713 && total === count * 3) { checkSensor(family, width, height, 3); coding = 'nikonYuv'; }
  else if (comp === 32767 && total === count) coding = 'arw2';
  else if (comp === 65000) { checkSensor(family, width, height, 1, total, 1); coding = 'kodak'; }
  else if ([1, 32769, 32770, 32773, 34713, 32767].includes(comp)) {
    if (bps === 8 && total >= count) coding = 'bytes';
    else if (total >= count * 2) coding = 'words';
    // Packed samples: only the layouts checked against a real file. The same header fields describe other makers' packings
    // (Samsung's, Olympus's, Nikon's little-endian one), which differ and would decode to noise without any error.
    else if (family === 'ERF' && bps === 12 && comp === 32769 && rowBytes >= plain * 16 / 15 - 1 && Number.isInteger(rowBytes)) coding = 'epson';
    else if (!fileLe && (family === 'NEF' || family === 'PEF') && bps === 12 && Math.abs(rowBytes - plain) < 1 && total >= plain * height) coding = 'packedBe';
    else if (family === 'ORF') throw new Error('ORF: this file uses Olympus\'s packed or compressed coding, which is not decoded; only the uncompressed 16-bit files of the early cameras (E-10, E-20) are');
    else if (family === 'SRW') throw new Error('SRW: this file uses one of Samsung\'s packed or compressed codings, which are not decoded; only uncompressed 16-bit files are');
    else if (bps > 8 && bps < 16 && total >= Math.floor((width * bps) / 8) * height) throw new Error(`${family}: this packed ${bps}-bit layout has not been checked against a sample file, so it is not read`);
    else throw new Error(`${family}: ${bps}-bit data of ${total} bytes for ${width}×${height} is not a layout this reader knows`);
  } else if (family === 'PEF' && comp === 65535) throw new Error('PEF: this file uses Pentax\'s compressed coding (K10D and later cameras), which is not decoded; only the uncompressed files of earlier cameras are');
  else throw new Error(`${family}: compression ${comp} is not handled`);
  if (probe) return null;
  let src: Uint8Array;
  if (offs.length === 1) src = u8.subarray(offs[0], offs[0] + total);
  else { src = new Uint8Array(total); let p = 0; for (let k = 0; k < offs.length; k++) { const n = Math.min(lens[k] || 0, Math.max(0, u8.length - offs[k])); src.set(u8.subarray(offs[k], offs[k] + n), p); p += n; } }
  let data: Uint16Array;
  if (coding === 'cr2') {
    let f; try { f = decodeLjpeg(src); } catch (e: any) { throw new Error(/Subsampled/.test(e?.message) ? 'CR2: sRAW and mRAW files (subsampled YCbCr) are not supported' : `CR2: ${e?.message || e}`); }
    const slices = v(r, 0xc640);
    const jwide = f.width * f.comps;
    if (slices && slices.length >= 3 && slices[0]) {
      // The slices cut the frame's samples into columns: together they are exactly as wide as the frame.
      if (slices[0] * slices[1] + slices[2] !== jwide) throw new Error('CR2: the slice table does not match the lossless JPEG frame');
      width = jwide; height = f.height;
      data = new Uint16Array(width * height);
      const perSlice = slices[1] * height;
      for (let jidx = 0, n = jwide * f.height; jidx < n; jidx++) {
        let i = Math.floor(jidx / perSlice); const j = i >= slices[0] ? 1 : 0; if (j) i = slices[0];
        const rem = jidx - i * perSlice, sw = slices[1 + j], row = Math.floor(rem / sw), col = (rem % sw) + i * slices[1];
        if (row < height && col < width) data[row * width + col] = f.data[jidx];
      }
    } else { width = jwide; height = f.height; data = f.data; }
    bps = f.precision; if (!cfa) cfa = [0, 1, 1, 2];
    // Canon's black level: the median of the masked columns left of the active area, per Bayer position.
    if (crop && crop.x >= 8 && black.length === 1 && !black[0]) black = maskedBlack(data, width, height, 2, crop.x - 2, cfa);
  } else if (coding === 'ljpeg') {
    if (tw && offs.length > 1) { // tiles of lossless JPEG
      data = new Uint16Array(width * height); const across = Math.ceil(width / tw);
      for (let k = 0; k < offs.length; k++) { const f = decodeLjpeg(u8.subarray(offs[k], offs[k] + lens[k])); const x0 = (k % across) * tw, y0 = Math.floor(k / across) * tl; const fw = f.width * f.comps; for (let y = 0; y < f.height && y0 + y < height; y++) for (let x = 0; x < fw && x0 + x < width; x++) data[(y0 + y) * width + x0 + x] = f.data[y * fw + x]; }
    } else { const f = decodeLjpeg(src); const fw = f.width * f.comps; data = fw === width && f.height >= height ? f.data.subarray(0, width * height) : rebox(f.data, fw, f.height, width, height); bps = f.precision; }
  } else if (coding === 'nikon') {
    data = decodeNikon(src, width, height, bps, nikonMeta!);
  } else if (coding === 'nikonYuv') {
    data = decodeNikonYuv(src, width, height, wb); samples = 3; cfa = null; bps = 12; black = [0];
  } else if (coding === 'arw2') {
    data = decodeArw2(src, width, height, v(r, 0x7010)); bps = 14;
  } else if (coding === 'kodak') {
    data = decodeKodak65000(src, width, height); bps = 12;
  } else if (coding === 'bytes') {
    data = Uint16Array.from(src.subarray(0, width * height));
  } else if (coding === 'words') {
    const be = family === 'SRW' ? false : !fileLe || comp === 34713 || family === 'SR2'; // Nikon and Sony's SR2 write these big-endian whatever the file says; Samsung the other way
    data = unpack16(src, width * height, !be); const sh = bps < 16 ? commonShift(data, 16 - bps) : commonShift(data, 6); if (sh) { for (let i = 0; i < data.length; i++) data[i] >>= sh; if (bps === 16) bps = 16 - sh; }
  } else if (coding === 'epson') { // a pad byte after every 10 pixels
    data = new Uint16Array(width * height);
    for (let y = 0; y < height; y++) data.set(unpackBe(src.subarray(y * rowBytes, (y + 1) * rowBytes), width, 12, 10), y * width);
  } else data = unpackBe(src, width * height, bps); // packedBe
  if (!white) white = family === 'MOS' ? (bps === 15 ? 0x1fff : 0x3fff) : (1 << bps) - 1; // Leaf backs fill 14 bits of their 16-bit words
  if (!cfa && samples === 1) cfa = [0, 1, 1, 2];
  return record({ width, height, data, samples, cfa, black, white, wb, crop, orientation, make: make || family, model });
}
/** Whether a lossless JPEG's frame header declares subsampled components (Canon's sRAW and mRAW), from the header alone. */
function ljpegSubsampled(u8: Uint8Array): boolean {
  for (let p = 2; p + 4 <= u8.length && u8[p] === 0xff;) {
    const m = u8[p + 1], len = (u8[p + 2] << 8) | u8[p + 3];
    if (m === 0xc3) { const n = u8[p + 9]; if (n > 1) for (let i = 0; i < n; i++) if (u8[p + 11 + i * 3] !== 0x11) return true; return false; }
    if (m === 0xda || len < 2) break;
    p += 2 + len;
  }
  return false;
}
/** The black level from a masked column band [x0, x1): the median per Bayer position, returned per color (R, G, B, G2). */
function maskedBlack(data: Uint16Array, width: number, height: number, x0: number, x1: number, cfa: number[]): number[] {
  const per: number[][] = [[], [], [], []];
  for (let y = 0; y < height; y += 3) for (let x = x0; x < x1; x++) per[(y & 1) * 2 + (x & 1)].push(data[y * width + x]);
  const med = per.map((a) => { a.sort((p, q) => p - q); return a.length ? a[a.length >> 1] : 0; });
  const out = [0, 0, 0, 0]; let g2 = false;
  for (let p = 0; p < 4; p++) { const c = cfa[p]; if (c === 1 && g2) out[3] = med[p]; else out[c] = med[p]; if (c === 1) g2 = true; }
  return out;
}
/** Re-lays samples when the lossless JPEG frame is declared with another width (components interleaved as columns). */
function rebox(data: Uint16Array, fw: number, fh: number, width: number, height: number): Uint16Array {
  if (fw * fh < width * height) throw new Error(`Lossless JPEG holds ${fw}×${fh} samples, fewer than the ${width}×${height} sensor`);
  const out = new Uint16Array(width * height); out.set(data.subarray(0, width * height)); return out;
}

/** Leaf MOS metadata: text PKTS blocks with the mosaic pattern and the neutral (white balance). */
function leafMeta(u8: Uint8Array): { cfa: number[] | null; wb: number[] | null } {
  let cfa: number[] | null = null, wb: number[] | null = null;
  const dv = dvOf(u8);
  for (let p = 0, k = 0; p + 52 <= u8.length && k < 400; k++) {
    let q = -1; for (let i = p; i + 4 <= u8.length; i++) if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x54 && u8[i + 3] === 0x53) { q = i; break; }
    if (q < 0 || q + 52 > u8.length) break;
    const name = String.fromCharCode(...u8.subarray(q + 8, q + 48)).replace(/\0.*$/s, ''), len = dv.getUint32(q + 48, false), body = String.fromCharCode(...u8.subarray(q + 52, q + 52 + Math.min(len, 200))).replace(/\0.*$/s, '');
    if (name === 'CaptProf_mosaic_pattern') { const pat = body.trim().split(/\s+/).map(Number); if (pat.length >= 4) { const frot = pat.indexOf(1) >= 0 ? pat.indexOf(1) ^ (pat.indexOf(1) >> 1) : 0; cfa = [[0, 1, 1, 2], [1, 0, 2, 1], [1, 2, 0, 1], [2, 1, 1, 0]][frot & 3]; } }
    else if (name === 'NeutObj_neutrals') { const nn = body.trim().split(/\s+/).map(Number); if (nn.length >= 4 && nn[1] && nn[2] && nn[3]) wb = [nn[0] / nn[1], nn[0] / nn[2], nn[0] / nn[3]]; }
    p = q + 52;
  }
  return { cfa, wb };
}

// Minolta MRW -----------------------------------------------------------------------------------------
function readMrw(u8: Uint8Array, probe = false): DngRaw | null {
  const dv = dvOf(u8), dataOff = dv.getUint32(4, false) + 8;
  let width = 0, height = 0, bits = 12, packed = false, wb: number[] | null = null, orientation = 1, make = 'Minolta', model = '';
  for (let p = 8; p + 8 <= dataOff && p + 8 <= u8.length;) {
    const tag = String.fromCharCode(u8[p + 1], u8[p + 2], u8[p + 3]), len = dv.getUint32(p + 4, false), b = p + 8;
    if (tag === 'PRD') { height = dv.getUint16(b + 8, false); width = dv.getUint16(b + 10, false); bits = u8[b + 17]; packed = u8[b + 18] === 0x59; }
    else if (tag === 'WBG') { const r = dv.getUint16(b + 4, false), g = dv.getUint16(b + 6, false), b2 = dv.getUint16(b + 10, false); if (r && g && b2) wb = [r, g, b2]; }
    else if (tag === 'TTW') { try { const t = u8.subarray(b, b + len), tl = t[0] === 0x49, ifd0 = readIfd(t, dvOf(t).getUint32(4, tl), tl).tags; orientation = n1(ifd0, 274, 1); make = text(ifd0, 271) || make; model = text(ifd0, 272); } catch { /* keep defaults */ } }
    p = b + len;
  }
  if (!width || !height) throw new Error('MRW: no PRD block with the sensor size');
  if (bits < 8 || bits > 16) throw new Error(`MRW: ${bits}-bit data is not a layout this reader knows`);
  const src = u8.subarray(Math.min(dataOff, u8.length)), count = checkSensor('MRW', width, height, 1, src.length, packed ? bits : 16);
  if (probe) return null;
  const data = packed ? unpackBe(src, count, bits) : unpack16(src, count, false);
  return record({ width, height, data, cfa: [0, 1, 1, 2], black: [0], white: (1 << bits) - 1, wb, orientation, make, model });
}

// Fujifilm RAF ----------------------------------------------------------------------------------------
function readRaf(u8: Uint8Array, probe = false): DngRaw | null {
  const dv = dvOf(u8), model = String.fromCharCode(...u8.subarray(28, 60)).replace(/\0.*$/s, '').trim();
  const hdrOff = dv.getUint32(92, false), cfaOff = dv.getUint32(100, false), cfaLen = dv.getUint32(104, false);
  let rawW = 0, rawH = 0, outW = 0, outH = 0, wb: number[] | null = null, layout = 0;
  if (hdrOff && hdrOff + 4 < u8.length) {
    const n = dv.getUint32(hdrOff, false); let p = hdrOff + 4;
    for (let i = 0; i < n && p + 4 <= u8.length; i++) {
      const tag = dv.getUint16(p, false), len = dv.getUint16(p + 2, false), b = p + 4;
      if (tag === 0x100) { rawH = dv.getUint16(b, false); rawW = dv.getUint16(b + 2, false); }
      else if (tag === 0x121) { outH = dv.getUint16(b, false); outW = dv.getUint16(b + 2, false); }
      else if (tag === 0x130) layout = u8[b] >> 7;
      else if (tag === 0x131) throw new Error('RAF: X-Trans sensors (6×6 pattern) are not supported');
      else if (tag === 0x2ff0) { const g = dv.getUint16(b, false), r = dv.getUint16(b + 2, false), g2 = dv.getUint16(b + 4, false), bl = dv.getUint16(b + 6, false); void g2; if (r && g && bl) wb = [r, g, bl]; }
      else if (tag === 0xc000 && rawW) { for (let q = b; q + 8 <= b + len; q += 4) { const w = dv.getUint32(q, true); if (w <= rawW && w > 0) { outW = w; outH = dv.getUint32(q + 4, true); break; } } }
      p = b + len;
    }
  }
  if (layout) throw new Error('RAF: the rotated (SuperCCD) sensor layout is not supported');
  if (!cfaOff || cfaOff + 16 > u8.length) throw new Error('RAF: no CFA section');
  // The CFA section is a TIFF whose IFD 0xf000 describes the sensor data.
  const sec = u8.subarray(cfaOff, cfaOff + cfaLen), sl = sec[0] === 0x49;
  let width = rawW, height = rawH, bps = 12, dataOff = 0, dataLen = 0, black: number[] = [0];
  if (isTiff(sec)) {
    const top = readIfd(sec, dvOf(sec).getUint32(4, sl), sl).tags, sub = n1(top, 0xf000);
    if (sub) {
      const t = readIfd(sec, sub, sl).tags;
      width = n1(t, 0xf001, width); height = n1(t, 0xf002, height); bps = n1(t, 0xf003, 12); dataOff = n1(t, 0xf007); dataLen = n1(t, 0xf008);
      const bl = v(t, 0xf00a); if (bl && bl.length >= 4) black = [bl[0], bl[1], bl[3], bl[2]];
      const w = v(t, 0xf00d); if (w && w.length >= 3 && w[0] && !wb) wb = [w[1], w[0], w[2]]; // G, R, B
    }
  } else { dataOff = 0; dataLen = cfaLen; }
  if (!width || !height) throw new Error('RAF: the sensor size is missing');
  if (bps < 8 || bps > 16) throw new Error(`RAF: ${bps}-bit data is not a layout this reader knows`);
  const src = sec.subarray(dataOff, dataLen ? dataOff + dataLen : undefined), count = checkSensor('RAF', width, height);
  if (src.length < Math.floor((count * bps) / 8)) throw new Error(`RAF: ${src.length} bytes of sensor data for ${width}×${height}`);
  if (probe) return null;
  let data: Uint16Array;
  if (src.length >= count * 2) { data = unpack16(src, count, sl); const sh = commonShift(data, 16 - bps); if (sh) for (let i = 0; i < count; i++) data[i] >>= sh; }
  else data = sl ? unpackLe(src, count, bps) : unpackBe(src, count, bps);
  // Fujifilm's Bayer order and margins (dcraw's rule): BGGR on the 2848- and 3664-pixel sensors, RGGB otherwise; the margins center the output size.
  const cfa = outW === 2848 || outW === 3664 ? [2, 1, 1, 0] : [0, 1, 1, 2];
  const crop = outW && outH && outW <= width && outH <= height ? { x: ((width - outW) >> 2) << 1, y: ((height - outH) >> 2) << 1, w: outW, h: outH } : null;
  return record({ width, height, data, cfa, black, white: (1 << bps) - 1, wb, crop, make: 'Fujifilm', model });
}

// Panasonic RW2 / RWL ---------------------------------------------------------------------------------
function readRw2(u8: Uint8Array, probe = false): DngRaw | null {
  const dv = dvOf(u8), t = readIfd(u8, dv.getUint32(4, true), true).tags;
  const width = n1(t, 2), height = n1(t, 3), bps = n1(t, 0xa, 12), comp = n1(t, 0xb), fmt = n1(t, 0x2d, 0), off = n1(t, 0x118) || n1(t, 273);
  if (!width || !height || !off) throw new Error('RW2: the sensor size or data offset is missing');
  if (fmt > 4 || (comp !== 34316 && comp !== 1)) throw new Error(`RW2: raw format ${fmt} (compression ${comp}) is not supported; 12-bit version-4 files are`);
  const src = u8.subarray(Math.min(off, u8.length));
  checkSensor('RW2', width, height, 1, src.length, comp === 34316 ? 9 : 16); // the bit-packed coding holds 14 pixels in 16 bytes
  if (probe) return null;
  const data = comp === 34316 ? decodePanasonic(src, width, height) : unpack16(src, width * height, true, 0);
  const bl = [n1(t, 0x1c), n1(t, 0x1d), n1(t, 0x1e)].map((x) => (x ? x + 15 : 0)); // LibRaw adds 15 to Panasonic's stated levels
  const wb = n1(t, 0x24) && n1(t, 0x25) && n1(t, 0x26) ? [n1(t, 0x24), n1(t, 0x25), n1(t, 0x26)] : null;
  const white = n1(t, 0xe) || (1 << bps) - 1;
  const cropT = n1(t, 4), cropL = n1(t, 5), cropB = n1(t, 6), cropR = n1(t, 7);
  const crop = cropB > cropT && cropR > cropL && cropR <= width && cropB <= height ? { x: cropL, y: cropT, w: cropR - cropL, h: cropB - cropT } : null;
  const cfa = CFA_CODES[n1(t, 9, 1)] || [0, 1, 1, 2];
  return record({ width, height, data, cfa, black: [bl[0], bl[1], bl[2], bl[1]], white, wb, crop, orientation: n1(t, 274, 1), make: text(t, 271) || 'Panasonic', model: text(t, 272) });
}

// Dispatch ----------------------------------------------------------------------------------------------
const TIFF_FAMILIES = new Set(['NEF', 'NRW', 'PEF', 'ERF', 'ORF', 'SR2', 'ARW', 'SRW', 'CR2', 'MOS', 'DCR', 'KDC', 'MEF', 'IIQ', '3FR', 'FFF', 'SRF']);
const UNSUPPORTED: Record<string, string> = {
  CR3: 'Canon CR3 files use the CRX codec, which this module does not decode',
  CRW: 'Canon CRW (CIFF) files use Canon\'s older Huffman coding, which this module does not decode',
  X3F: 'Sigma X3F (Foveon) files are not decoded',
  IIQ: 'Phase One IIQ files use Phase One\'s own coding, which this module does not decode',
  '3FR': 'Hasselblad 3FR files use Hasselblad\'s own coding, which this module does not decode',
  FFF: 'Hasselblad FFF files use Hasselblad\'s own coding, which this module does not decode',
  SRF: 'Sony SRF files are encrypted in a way this module does not decode',
  KDC: 'Kodak KDC files use camera-specific layouts this module does not decode',
  MEF: 'Mamiya MEF files have not been verified against a sample',
};

/** The family of a RAW file from its signature or extension (a small copy of the preview reader's rule, kept here to avoid a cycle). */
function familyOf(u8: Uint8Array, name: string): string {
  if (starts(u8, 'FUJIFILMCCD-RAW')) return 'RAF';
  if (starts(u8, 'IIRO') || starts(u8, 'IIRS') || starts(u8, 'MMOR')) return 'ORF';
  if (starts(u8, 'IIU\0')) return ext(name) === 'rwl' ? 'RWL' : 'RW2';
  if (starts(u8, 'FOVb')) return 'X3F';
  if (starts(u8, 'II\x1a\0\0\0HEAPCCDR')) return 'CRW';
  if (starts(u8, 'ftypcrx ', 4)) return 'CR3';
  if (starts(u8, '\0MRM')) return 'MRW';
  if (isTiff(u8) && starts(u8, 'CR\x02', 8)) return 'CR2';
  const e = ext(name).toUpperCase();
  if (e || !isTiff(u8)) return e;
  // No name (bytes handed over alone): the TIFF's Make tag says whose file it is.
  try {
    const le = u8[0] === 0x49, ifd0 = readIfd(u8, dvOf(u8).getUint32(4, le), le).tags, make = text(ifd0, 271).toUpperCase(), model = text(ifd0, 272).toUpperCase();
    const table: [RegExp, string][] = [[/NIKON/, 'NEF'], [/PENTAX|RICOH/, 'PEF'], [/SONY/, /DSC-R1/.test(model) ? 'SR2' : 'ARW'], [/SAMSUNG/, 'SRW'], [/CANON/, 'CR2'], [/EPSON/, 'ERF'], [/LEAF/, 'MOS'], [/KODAK/, 'DCR'], [/OLYMPUS|OM DIGITAL/, 'ORF'], [/HASSELBLAD/, '3FR'], [/PHASE ONE/, 'IIQ'], [/MAMIYA/, 'MEF']];
    for (const [re, fam] of table) if (re.test(make)) return fam;
  } catch { /* unknown */ }
  return '';
}

/** The reader of a family; with `probe`, the headers only (see readTiffFamily). */
function readFamily(u8: Uint8Array, family: string, probe: boolean): DngRaw | null {
  switch (family) {
    case 'MRW': return readMrw(u8, probe);
    case 'RAF': return readRaf(u8, probe);
    case 'RW2': case 'RWL': return readRw2(u8, probe);
    case 'ORF': return readTiffFamily(orfAsTiff(u8), 'ORF', probe);
    default: return readTiffFamily(u8, family, probe);
  }
}

const supportCache = new WeakMap<ArrayBufferLike, Map<string, RawSupport>>();
/**
 * Whether Develop RAW can read this file, with the reason when it cannot. Headers only, but the same code path the
 * reader then takes, so a file this calls readable is one the reader accepts (it can still turn out damaged while its
 * data is decoded). The answer is kept per file, since the command's enabled state asks often. DNG files are answered
 * by their signature; the DNG reader gives its own reasons.
 */
export function rawSupport(u8: Uint8Array, name = ''): RawSupport {
  const key = `${u8.byteOffset}:${u8.byteLength}:${name}`; let known = supportCache.get(u8.buffer);
  const hit = known?.get(key); if (hit) return hit;
  const s = probeSupport(u8, name);
  if (!known) supportCache.set(u8.buffer, known = new Map());
  known.set(key, s); return s;
}
function probeSupport(u8: Uint8Array, name: string): RawSupport {
  if (isDng(u8)) return { ok: true, family: 'DNG' };
  const family = familyOf(u8, name);
  if (UNSUPPORTED[family]) return { ok: false, family, why: UNSUPPORTED[family] };
  const read = family === 'MRW' || family === 'RAF' || family === 'RW2' || family === 'RWL' || (family === 'ORF' && !isTiff(u8)) // Olympus's IIRO/IIRS/MMOR header: a TIFF with another magic
    || (TIFF_FAMILIES.has(family) && isTiff(u8));
  if (!read) return { ok: false, family: family || 'RAW', why: `${family || 'This'} files are not a RAW kind this module reads` };
  try { readFamily(u8, family, true); return { ok: true, family }; }
  catch (e) { return { ok: false, family, why: (e as Error)?.message || `${family}: the file could not be read` }; }
}

/** Reads the sensor data of a camera RAW file of any supported family (DNG included). */
export function readRaw(u8: Uint8Array, name = ''): DngRaw {
  if (isDng(u8)) return readDng(u8);
  const s = rawSupport(u8, name);
  if (!s.ok) throw new Error(s.why || 'Unsupported RAW file');
  return readFamily(u8, s.family, false)!;
}
/** Olympus files are TIFFs whose magic says RO/RS/OR; the parser wants 42. */
function orfAsTiff(u8: Uint8Array): Uint8Array {
  if (isTiff(u8)) return u8;
  const c = new Uint8Array(u8); if (c[0] === 0x49) { c[2] = 42; c[3] = 0; } else { c[2] = 0; c[3] = 42; } return c;
}
