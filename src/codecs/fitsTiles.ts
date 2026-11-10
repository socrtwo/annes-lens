/**
 * The tile compression algorithms of the FITS standard (version 4.0, section 10, "the tiled image convention"), as
 * CFITSIO's fpack writes them: RICE_1 (Rice coding of differences, BLOCKSIZE 32, BYTEPIX 1/2/4), PLIO_1 (IRAF line
 * lists for integer masks), HCOMPRESS_1 (the H-transform wavelet, quadtree-coded bit planes, optional smoothing on
 * reconstruction), GZIP_2's byte shuffle, and the random sequence of the subtractive dither used for quantized floats.
 * Written from the standard's description and the published algorithms (White, Postman & Lattanzi 1992 for
 * H-compress; Rice, Yeh & Miller 1993), with CFITSIO (NASA's open-source library) as the reference for the exact
 * bit-level conventions.
 */

/** Big-endian bit reader. */
class Bits {
  p: number; acc = 0; n = 0;
  constructor(private u8: Uint8Array, start = 0) { this.p = start; }
  bit(): number { if (this.n === 0) { this.acc = this.p < this.u8.length ? this.u8[this.p++] : 0; this.n = 8; } this.n--; return (this.acc >> this.n) & 1; }
  read(k: number): number { let v = 0; for (let i = 0; i < k; i++) v = v * 2 + this.bit(); return v; }
  /** Zeros until a one (the one consumed). */
  zeros(): number { let z = 0; while (!this.bit()) { if (++z > 100000) throw new Error('Rice: damaged data'); } return z; }
}

/** RICE_1: `n` samples of `bytepix` bytes each, as signed values (unsigned for bytepix 1). */
export function decodeRice(src: Uint8Array, n: number, bytepix: number, blocksize = 32): Int32Array {
  if (!Number.isInteger(blocksize) || blocksize < 1) throw new Error(`Rice: bad block size ${blocksize}`); // 0 would never advance
  const fsbits = bytepix === 1 ? 3 : bytepix === 2 ? 4 : 5, fsmax = bytepix === 1 ? 6 : bytepix === 2 ? 14 : 25, bbits = bytepix * 8;
  const wrap = 2 ** bbits, out = new Int32Array(n);
  let last = 0;
  for (let i = 0; i < bytepix; i++) last = last * 256 + src[i];
  const bits = new Bits(src, bytepix);
  const toSigned = (v: number) => (bytepix === 1 ? v : v >= wrap / 2 ? v - wrap : v);
  for (let i = 0; i < n;) {
    const fs = bits.read(fsbits) - 1, imax = Math.min(i + blocksize, n);
    if (fs < 0) { for (; i < imax; i++) out[i] = toSigned(last); continue; }
    for (; i < imax; i++) {
      let diff: number;
      if (fs === fsmax) diff = bits.read(bbits);
      else { const z = bits.zeros(); diff = z * 2 ** fs + bits.read(fs); }
      const d = diff % 2 === 0 ? diff / 2 : -Math.floor(diff / 2) - 1;
      last = (((last + d) % wrap) + wrap) % wrap;
      out[i] = toSigned(last);
    }
  }
  return out;
}

/** PLIO_1: an IRAF line list (16-bit big-endian words) to `n` integer pixels. */
export function decodePlio(src: Uint8Array, n: number): Int32Array {
  const words = src.length >> 1, ll = new Int16Array(words + 1); // 1-based like the reference
  for (let i = 0; i < words; i++) ll[i + 1] = ((src[i * 2] << 8) | src[i * 2 + 1]) << 16 >> 16;
  const out = new Int32Array(n);
  let lllen: number, first: number;
  if (ll[3] > 0) { lllen = ll[3]; first = 4; } else { lllen = (ll[5] << 15) + ll[4]; first = ll[2] + 1; }
  let op = 0, x1 = 1, pv = 1, skip = false;
  const xe = n;
  for (let ip = first; ip <= lllen && ip <= words; ip++) {
    if (skip) { skip = false; continue; }
    const word = ll[ip], opcode = word >> 12, data = word & 4095;
    switch (opcode) {
      case 0: case 4: case 5: { // zeros, pixels of the current value, zeros then one pixel of it
        const x2 = x1 + data - 1, i1 = Math.max(x1, 1), i2 = Math.min(x2, xe), np = i2 - i1 + 1;
        if (np > 0) {
          const otop = op + np - 1;
          if (opcode === 4) for (let i = op; i <= otop; i++) out[i] = pv;
          else { for (let i = op; i <= otop; i++) out[i] = 0; if (opcode === 5 && i2 === x2) out[otop] = pv; }
          op = otop + 1;
        }
        x1 = x2 + 1;
        break;
      }
      case 1: pv = (ll[ip + 1] << 12) + data; skip = true; break; // the value from two words
      case 2: pv += data; break;
      case 3: pv -= data; break;
      case 6: case 7: // the value changes, and one pixel of it
        pv += opcode === 6 ? data : -data;
        if (x1 >= 1 && x1 <= xe) out[op++] = pv;
        x1++;
        break;
    }
    if (x1 > xe) break;
  }
  return out;
}

/** GZIP_2's shuffle undone: the bytes of each value were spread as all first bytes, then all second bytes… */
export function unshuffleBytes(src: Uint8Array, bytepix: number): Uint8Array {
  const n = Math.floor(src.length / bytepix), out = new Uint8Array(n * bytepix);
  for (let k = 0; k < bytepix; k++) for (let i = 0; i < n; i++) out[i * bytepix + k] = src[k * n + i];
  return out;
}

/** The 10000 numbers of the subtractive dither (the Park–Miller sequence from seed 1, as single-precision values). */
let randoms: Float32Array | null = null;
export function ditherSequence(): Float32Array {
  if (randoms) return randoms;
  const r = new Float32Array(10000), a = 16807, m = 2147483647;
  let seed = 1;
  for (let i = 0; i < 10000; i++) { const t = a * seed; seed = t - m * Math.floor(t / m); r[i] = seed / m; }
  return (randoms = r);
}

// ---- HCOMPRESS_1 ----------------------------------------------------------------------------------------------
// The integers are kept in doubles with exact integer arithmetic (floor division and modulus instead of shifts and
// masks), which is the 64-bit decoder of the reference: quantized floats and 32-bit integers need it (their transform
// coefficients outrun 32 bits), and for 8- and 16-bit data the two decoders agree.

export interface HcompressResult { nx: number; ny: number; scale: number; data: Float64Array }

const shr = (v: number, s: number) => Math.floor(v / 2 ** s);
/** v & -bit: rounded down to a multiple of `bit` (a power of two). */
const floorTo = (v: number, bit: number) => v - (((v % bit) + bit) % bit);
/** v & bit, for a power of two. */
const bitOf = (v: number, bit: number) => (((Math.floor(v / bit) % 2) + 2) % 2 ? bit : 0);

/** Decodes one H-compressed tile: the coded array (nx rows of ny values), undigitized and inverse-transformed. */
export function decodeHcompress(src: Uint8Array, smooth: boolean): HcompressResult {
  if (src.length < 25 || src[0] !== 0xdd || src[1] !== 0x99) throw new Error('H-compress: bad magic number');
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const nx = dv.getInt32(2), ny = dv.getInt32(6), scale = dv.getInt32(10);
  if (nx <= 0 || ny <= 0 || nx * ny > 100e6) throw new Error('H-compress: bad tile size');
  const sumall = Number(dv.getBigInt64(14));
  const nbit = [src[22], src[23], src[24]];
  const a = new Float64Array(nx * ny);
  const bits = new Bits(src, 25);
  dodecode(bits, a, nx, ny, nbit);
  a[0] = sumall;
  if (scale > 1) for (let i = 0; i < a.length; i++) a[i] *= scale;
  hinv(a, nx, ny, smooth, scale);
  return { nx, ny, scale, data: a };
}

function dodecode(bits: Bits, a: Float64Array, nx: number, ny: number, nbit: number[]): void {
  const nx2 = (nx + 1) >> 1, ny2 = (ny + 1) >> 1;
  qtreeDecode(bits, a, 0, ny, nx2, ny2, nbit[0]);
  qtreeDecode(bits, a, ny2, ny, nx2, ny >> 1, nbit[1]);
  qtreeDecode(bits, a, ny * nx2, ny, nx >> 1, ny2, nbit[1]);
  qtreeDecode(bits, a, ny * nx2 + ny2, ny, nx >> 1, ny >> 1, nbit[2]);
  if (bits.read(4) !== 0) throw new Error('H-compress: bad bit plane values');
  bits.n = 0; // the sign bits start on a byte boundary
  for (let i = 0; i < a.length; i++) if (a[i] && bits.bit()) a[i] = -a[i];
}

function inputHuffman(bits: Bits): number {
  let c = bits.read(3);
  if (c < 4) return 1 << c;
  c = bits.bit() | (c << 1);
  if (c < 13) return [3, 5, 10, 12, 15][c - 8];
  c = bits.bit() | (c << 1);
  if (c < 31) return [6, 7, 9, 11, 13][c - 26];
  c = bits.bit() | (c << 1);
  return c === 62 ? 0 : 14;
}

/** The quadtree-coded bit planes of one quadrant, from the highest plane down, added into `a` (offset `base`, row stride `n`). */
function qtreeDecode(bits: Bits, a: Float64Array, base: number, n: number, nqx: number, nqy: number, nbitplanes: number): void {
  const nqmax = Math.max(nqx, nqy);
  let log2n = Math.round(Math.log(nqmax) / Math.log(2));
  if (nqmax > 1 << log2n) log2n++;
  const nqx2 = (nqx + 1) >> 1, nqy2 = (nqy + 1) >> 1;
  const scratch = new Uint8Array(Math.max(1, nqx2 * nqy2));
  for (let bit = nbitplanes - 1; bit >= 0; bit--) {
    const b = bits.read(4);
    if (b === 0) { // the plane's quadtree leaves written directly as nybbles
      for (let i = 0; i < nqx2 * nqy2; i++) scratch[i] = bits.read(4);
      bitins(scratch, nqx, nqy, a, base, n, bit);
    } else if (b !== 0xf) throw new Error('H-compress: bad format code');
    else {
      scratch[0] = inputHuffman(bits);
      let nx = 1, ny = 1, nfx = nqx, nfy = nqy, c = 1 << log2n;
      for (let k = 1; k < log2n; k++) {
        c >>= 1; nx <<= 1; ny <<= 1;
        if (nfx <= c) nx--; else nfx -= c;
        if (nfy <= c) ny--; else nfy -= c;
        qtreeExpand(bits, scratch, nx, ny);
      }
      bitins(scratch, nqx, nqy, a, base, n, bit);
    }
  }
}

/** One level of the quadtree expanded in place: each nonzero leaf becomes a 2×2 block of 4 flags (then re-coded). */
function qtreeExpand(bits: Bits, b: Uint8Array, nx: number, ny: number): void {
  qtreeCopy(b, nx, ny, ny);
  for (let i = nx * ny - 1; i >= 0; i--) if (b[i]) b[i] = inputHuffman(bits);
}

/** The compact (nx2 × ny2) array of 4-bit codes at the start of `b` spread to nx × ny single bits (stride `n`), in place. */
function qtreeCopy(b: Uint8Array, nx: number, ny: number, n: number): void {
  const nx2 = (nx + 1) >> 1, ny2 = (ny + 1) >> 1;
  let k = ny2 * (nx2 - 1) + ny2 - 1;
  for (let i = nx2 - 1; i >= 0; i--) { let s00 = 2 * (n * i + ny2 - 1); for (let j = ny2 - 1; j >= 0; j--) { b[s00] = b[k]; k--; s00 -= 2; } }
  let i = 0;
  for (; i < nx - 1; i += 2) {
    let s00 = n * i, s10 = s00 + n, j = 0;
    for (; j < ny - 1; j += 2) { const v = b[s00]; b[s10 + 1] = v & 1; b[s10] = (v >> 1) & 1; b[s00 + 1] = (v >> 2) & 1; b[s00] = (v >> 3) & 1; s00 += 2; s10 += 2; }
    if (j < ny) { const v = b[s00]; b[s10] = (v >> 1) & 1; b[s00] = (v >> 3) & 1; }
  }
  if (i < nx) {
    let s00 = n * i, j = 0;
    for (; j < ny - 1; j += 2) { const v = b[s00]; b[s00 + 1] = (v >> 2) & 1; b[s00] = (v >> 3) & 1; s00 += 2; }
    if (j < ny) b[s00] = (b[s00] >> 3) & 1;
  }
}

/** The 4-bit codes of a plane added into the array as bit `bit` (each code covers a 2×2 block; a plane's bit is set once). */
function bitins(codes: Uint8Array, nx: number, ny: number, b: Float64Array, base: number, n: number, bit: number): void {
  const pv = 2 ** bit;
  let k = 0, i = 0;
  for (; i < nx - 1; i += 2) {
    let s00 = base + n * i, j = 0;
    for (; j < ny - 1; j += 2) { const v = codes[k++]; if (v & 1) b[s00 + n + 1] += pv; if (v & 2) b[s00 + n] += pv; if (v & 4) b[s00 + 1] += pv; if (v & 8) b[s00] += pv; s00 += 2; }
    if (j < ny) { const v = codes[k++]; if (v & 2) b[s00 + n] += pv; if (v & 8) b[s00] += pv; }
  }
  if (i < nx) {
    let s00 = base + n * i, j = 0;
    for (; j < ny - 1; j += 2) { const v = codes[k++]; if (v & 4) b[s00 + 1] += pv; if (v & 8) b[s00] += pv; s00 += 2; }
    if (j < ny) { const v = codes[k++]; if (v & 8) b[s00] += pv; }
  }
}

/** The inverse H-transform, with the standard's rounding and optional smoothing, in place. */
function hinv(a: Float64Array, nx: number, ny: number, smooth: boolean, scale: number): void {
  const nmax = Math.max(nx, ny);
  let log2n = Math.round(Math.log(nmax) / Math.log(2));
  if (nmax > 1 << log2n) log2n++;
  const tmp = new Float64Array(((nmax + 1) >> 1) + 1);
  let shift = 1, bit0 = 2 ** (log2n - 1), bit1 = bit0 * 2, bit2 = bit0 * 4;
  let prnd0 = bit0 / 2, prnd1 = bit1 / 2, prnd2 = bit2 / 2, nrnd0 = prnd0 - 1, nrnd1 = prnd1 - 1;
  const nrnd2 = prnd2 - 1;
  a[0] = floorTo(a[0] + (a[0] >= 0 ? prnd2 : nrnd2), bit2);
  let nxtop = 1, nytop = 1, nxf = nx, nyf = ny, c = 1 << log2n;
  for (let k = log2n - 1; k >= 0; k--) {
    c >>= 1; nxtop <<= 1; nytop <<= 1;
    if (nxf <= c) nxtop--; else nxf -= c;
    if (nyf <= c) nytop--; else nyf -= c;
    if (k === 0) { nrnd0 = 0; shift = 2; }
    for (let i = 0; i < nxtop; i++) unshuffle(a, ny * i, nytop, 1, tmp);
    for (let j = 0; j < nytop; j++) unshuffle(a, j, nxtop, ny, tmp);
    if (smooth) hsmooth(a, nxtop, nytop, ny, scale);
    const oddx = nxtop & 1, oddy = nytop & 1;
    let i = 0;
    for (; i < nxtop - oddx; i += 2) {
      let s00 = ny * i, s10 = s00 + ny, j = 0;
      for (; j < nytop - oddy; j += 2) {
        let h0 = a[s00], hx = a[s10], hy = a[s00 + 1], hc = a[s10 + 1];
        hx = floorTo(hx + (hx >= 0 ? prnd1 : nrnd1), bit1);
        hy = floorTo(hy + (hy >= 0 ? prnd1 : nrnd1), bit1);
        hc = floorTo(hc + (hc >= 0 ? prnd0 : nrnd0), bit0);
        const lowbit0 = bitOf(hc, bit0);
        hx = hx >= 0 ? hx - lowbit0 : hx + lowbit0;
        hy = hy >= 0 ? hy - lowbit0 : hy + lowbit0;
        const lowbit1 = (bitOf(hc, bit1) ? 1 : 0) ^ (bitOf(hx, bit1) ? 1 : 0) ^ (bitOf(hy, bit1) ? 1 : 0) ? bit1 : 0;
        h0 = h0 >= 0 ? h0 + lowbit0 - lowbit1 : h0 + (lowbit0 === 0 ? lowbit1 : lowbit0 - lowbit1);
        a[s10 + 1] = shr(h0 + hx + hy + hc, shift);
        a[s10] = shr(h0 + hx - hy - hc, shift);
        a[s00 + 1] = shr(h0 - hx + hy - hc, shift);
        a[s00] = shr(h0 - hx - hy + hc, shift);
        s00 += 2; s10 += 2;
      }
      if (oddy) {
        let h0 = a[s00], hx = a[s10];
        hx = floorTo(hx >= 0 ? hx + prnd1 : hx + nrnd1, bit1);
        const lowbit1 = bitOf(hx, bit1);
        h0 = h0 >= 0 ? h0 - lowbit1 : h0 + lowbit1;
        a[s10] = shr(h0 + hx, shift);
        a[s00] = shr(h0 - hx, shift);
      }
    }
    if (oddx) {
      let s00 = ny * i, j = 0;
      for (; j < nytop - oddy; j += 2) {
        let h0 = a[s00], hy = a[s00 + 1];
        hy = floorTo(hy >= 0 ? hy + prnd1 : hy + nrnd1, bit1);
        const lowbit1 = bitOf(hy, bit1);
        h0 = h0 >= 0 ? h0 - lowbit1 : h0 + lowbit1;
        a[s00 + 1] = shr(h0 + hy, shift);
        a[s00] = shr(h0 - hy, shift);
        s00 += 2;
      }
      if (oddy) a[s00] = shr(a[s00], shift);
    }
    bit2 = bit1; bit1 = bit0; bit0 /= 2;
    prnd1 = prnd0; prnd0 /= 2;
    nrnd1 = nrnd0; nrnd0 = prnd0 - 1;
  }
}

/** The elements at `off`, `off + n2`, … (n of them) reordered from [lows…, highs…] to interleaved. */
function unshuffle(a: Float64Array, off: number, n: number, n2: number, tmp: Float64Array): void {
  const nhalf = (n + 1) >> 1;
  let pt = 0, p1 = off + n2 * nhalf;
  for (let i = nhalf; i < n; i++) { tmp[pt++] = a[p1]; p1 += n2; }
  let p2 = off + n2 * (nhalf - 1); p1 = off + 2 * n2 * (nhalf - 1);
  for (let i = nhalf - 1; i >= 0; i--) { a[p1] = a[p2]; p2 -= n2; p1 -= n2 + n2; }
  pt = 0; p1 = off + n2;
  for (let i = 1; i < n; i += 2) { a[p1] = tmp[pt++]; p1 += n2 + n2; }
}

function hsmooth(a: Float64Array, nxtop: number, nytop: number, ny: number, scale: number): void {
  const smax = scale >> 1;
  if (smax <= 0) return;
  const ny2 = ny << 1;
  const clamp = (s: number) => Math.max(Math.min(s, smax), -smax);
  for (let i = 2; i < nxtop - 2; i += 2) {
    let s00 = ny * i, s10 = s00 + ny;
    for (let j = 0; j < nytop; j += 2) {
      const hm = a[s00 - ny2], h0 = a[s00], hp = a[s00 + ny2];
      let diff = hp - hm;
      const dmax = Math.max(Math.min(hp - h0, h0 - hm), 0) * 4, dmin = Math.min(Math.max(hp - h0, h0 - hm), 0) * 4;
      if (dmin < dmax) { diff = Math.max(Math.min(diff, dmax), dmin); const s = diff - a[s10] * 8; a[s10] += clamp(s >= 0 ? shr(s, 3) : shr(s + 7, 3)); }
      s00 += 2; s10 += 2;
    }
  }
  for (let i = 0; i < nxtop; i += 2) {
    let s00 = ny * i + 2;
    for (let j = 2; j < nytop - 2; j += 2) {
      const hm = a[s00 - 2], h0 = a[s00], hp = a[s00 + 2];
      let diff = hp - hm;
      const dmax = Math.max(Math.min(hp - h0, h0 - hm), 0) * 4, dmin = Math.min(Math.max(hp - h0, h0 - hm), 0) * 4;
      if (dmin < dmax) { diff = Math.max(Math.min(diff, dmax), dmin); const s = diff - a[s00 + 1] * 8; a[s00 + 1] += clamp(s >= 0 ? shr(s, 3) : shr(s + 7, 3)); }
      s00 += 2;
    }
  }
  for (let i = 2; i < nxtop - 2; i += 2) {
    let s00 = ny * i + 2, s10 = s00 + ny;
    for (let j = 2; j < nytop - 2; j += 2) {
      const hmm = a[s00 - ny2 - 2], hpm = a[s00 + ny2 - 2], hmp = a[s00 - ny2 + 2], hpp = a[s00 + ny2 + 2], h0 = a[s00];
      let diff = hpp + hmm - hmp - hpm;
      const hx2 = a[s10] * 2, hy2 = a[s00 + 1] * 2;
      let m1 = Math.min(Math.max(hpp - h0, 0) - hx2 - hy2, Math.max(h0 - hpm, 0) + hx2 - hy2);
      let m2 = Math.min(Math.max(h0 - hmp, 0) - hx2 + hy2, Math.max(hmm - h0, 0) + hx2 + hy2);
      const dmax = Math.min(m1, m2) * 16;
      m1 = Math.max(Math.min(hpp - h0, 0) - hx2 - hy2, Math.min(h0 - hpm, 0) + hx2 - hy2);
      m2 = Math.max(Math.min(h0 - hmp, 0) - hx2 + hy2, Math.min(hmm - h0, 0) + hx2 + hy2);
      const dmin = Math.max(m1, m2) * 16;
      if (dmin < dmax) { diff = Math.max(Math.min(diff, dmax), dmin); const s = diff - a[s10 + 1] * 64; a[s10 + 1] += clamp(s >= 0 ? shr(s, 6) : shr(s + 63, 6)); }
      s00 += 2; s10 += 2;
    }
  }
}
