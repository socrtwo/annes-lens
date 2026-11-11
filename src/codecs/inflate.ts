/**
 * A tolerant DEFLATE (RFC 1951) decoder for damaged pictures: stored, fixed and dynamic Huffman blocks,
 * optional zlib (RFC 1950) and gzip headers, no checksum enforcement. When the stream is truncated or
 * corrupt it returns everything decoded up to that point and says why it stopped.
 */
import { MAX_UNPACKED } from './limits';

export interface InflateResult { data: Uint8Array; complete: boolean; error?: string }

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Tree { counts: Uint16Array; symbols: Uint16Array }

function buildTree(lengths: Uint8Array | number[], n: number): Tree {
  const counts = new Uint16Array(16), symbols = new Uint16Array(n);
  for (let i = 0; i < n; i++) counts[lengths[i]]++;
  counts[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
  for (let i = 0; i < n; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
  return { counts, symbols };
}

class In {
  p: number; bit = 0;
  constructor(public u8: Uint8Array, start: number) { this.p = start; }
  get eof(): boolean { return this.p >= this.u8.length; }
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (this.p >= this.u8.length) throw new Error('unexpected end of data');
      v |= ((this.u8[this.p] >> this.bit) & 1) << i;
      if (++this.bit === 8) { this.bit = 0; this.p++; }
    }
    return v;
  }
  decode(t: Tree): number {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= this.bits(1);
      const count = t.counts[len];
      if (code - count < first) return t.symbols[index + (code - first)];
      index += count; first += count; first <<= 1; code <<= 1;
    }
    throw new Error('invalid Huffman code');
  }
  align(): void { if (this.bit) { this.bit = 0; this.p++; } }
}

let fixedLit: Tree | null = null, fixedDist: Tree | null = null;

/**
 * Inflates raw deflate data, or a zlib/gzip stream (detected by its header). `expected` is a hint for the output
 * buffer (it is not believed beyond a multiple of the input, and the buffer grows as needed); `limit` is the most the
 * stream may produce: past it the result is what was produced, marked incomplete with an error.
 */
export function inflate(src: Uint8Array, expected = 0, limit = MAX_UNPACKED): InflateResult {
  let start = 0;
  if (src.length >= 2 && (src[0] & 0x0f) === 8 && ((src[0] << 8) | src[1]) % 31 === 0) start = 2; // zlib
  else if (src.length >= 10 && src[0] === 0x1f && src[1] === 0x8b) { // gzip
    start = 10;
    const flg = src[3];
    if (flg & 4) start += 2 + (src[start] | (src[start + 1] << 8));
    if (flg & 8) { while (start < src.length && src[start]) start++; start++; }
    if (flg & 16) { while (start < src.length && src[start]) start++; start++; }
    if (flg & 2) start += 2;
  }
  let out = new Uint8Array(Math.max(1024, Math.min(expected || src.length * 4, limit, src.length * 64 + 65536)));
  let o = 0;
  const grow = (need: number) => {
    if (o + need > limit) throw new Error(`the data unpacks to more than ${limit >= 1048576 ? `${Math.floor(limit / 1048576)} MB` : `${limit} bytes`}`);
    if (o + need > out.length) { const n = new Uint8Array(Math.min(limit, Math.max(out.length * 2, o + need))); n.set(out.subarray(0, o)); out = n; }
  };
  const r = new In(src, start);
  let complete = false, error: string | undefined;
  try {
    for (;;) {
      const last = r.bits(1), type = r.bits(2);
      if (type === 0) {
        r.align();
        if (r.p + 4 > src.length) throw new Error('unexpected end of data');
        const len = src[r.p] | (src[r.p + 1] << 8), nlen = src[r.p + 2] | (src[r.p + 3] << 8);
        r.p += 4;
        if ((len ^ 0xffff) !== nlen) throw new Error('stored block length check failed');
        const n = Math.min(len, src.length - r.p);
        grow(n); out.set(src.subarray(r.p, r.p + n), o); o += n; r.p += n;
        if (n < len) throw new Error('unexpected end of data');
      } else if (type === 1 || type === 2) {
        let lit: Tree, dist: Tree;
        if (type === 1) {
          if (!fixedLit) { const l = new Uint8Array(288); l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288); fixedLit = buildTree(l, 288); fixedDist = buildTree(new Uint8Array(30).fill(5), 30); }
          lit = fixedLit; dist = fixedDist!;
        } else {
          const hlit = r.bits(5) + 257, hdist = r.bits(5) + 1, hclen = r.bits(4) + 4;
          const cl = new Uint8Array(19);
          for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = r.bits(3);
          const clTree = buildTree(cl, 19);
          const lengths = new Uint8Array(hlit + hdist);
          for (let i = 0; i < hlit + hdist;) {
            const sym = r.decode(clTree);
            if (sym < 16) lengths[i++] = sym;
            else if (sym === 16) { if (!i) throw new Error('bad code lengths'); const prev = lengths[i - 1]; for (let k = r.bits(2) + 3; k > 0 && i < lengths.length; k--) lengths[i++] = prev; }
            else if (sym === 17) { for (let k = r.bits(3) + 3; k > 0 && i < lengths.length; k--) lengths[i++] = 0; }
            else { for (let k = r.bits(7) + 11; k > 0 && i < lengths.length; k--) lengths[i++] = 0; }
          }
          lit = buildTree(lengths.subarray(0, hlit), hlit); dist = buildTree(lengths.subarray(hlit), hdist);
        }
        for (;;) {
          const sym = r.decode(lit);
          if (sym < 256) { grow(1); out[o++] = sym; }
          else if (sym === 256) break;
          else {
            const li = sym - 257;
            if (li >= 29) throw new Error('bad length code');
            const len = LEN_BASE[li] + r.bits(LEN_EXTRA[li]);
            const di = r.decode(dist);
            if (di >= 30) throw new Error('bad distance code');
            const d = DIST_BASE[di] + r.bits(DIST_EXTRA[di]);
            if (d > o) throw new Error('distance beyond the start of the output');
            grow(len);
            for (let k = 0; k < len; k++) { out[o] = out[o - d]; o++; }
          }
        }
      } else throw new Error('reserved block type');
      if (last) { complete = true; break; }
    }
  } catch (e: any) { error = e?.message || String(e); }
  return { data: out.subarray(0, o), complete, error };
}
