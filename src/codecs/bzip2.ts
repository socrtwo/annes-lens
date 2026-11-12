/**
 * bzip2 decoding (tar.bz2, 7z coder 040202): Huffman-coded move-to-front indexes with zero runs,
 * the inverse Burrows–Wheeler transform, then the initial run-length step undone; one stream or
 * several back to back. Randomized blocks (from 0.9.0-era encoders) are refused. CRCs are not checked.
 */
import { withPartial } from './limits';
class Bits {
  p = 0; buf = 0; n = 0;
  constructor(private u8: Uint8Array) {}
  get(k: number): number {
    while (this.n < k) { if (this.p >= this.u8.length) throw new Error('Truncated bzip2 data'); this.buf = ((this.buf << 8) | this.u8[this.p++]) >>> 0; this.n += 8; }
    this.n -= k; const v = (this.buf >>> this.n) & ((1 << k) - 1); this.buf &= (1 << this.n) - 1; return v;
  }
  bit(): number { return this.get(1); }
  get end(): boolean { return this.p >= this.u8.length && this.n === 0; }
}

export const isBzip2 = (u8: Uint8Array): boolean => u8.length > 10 && u8[0] === 0x42 && u8[1] === 0x5a && u8[2] === 0x68 && u8[3] >= 0x31 && u8[3] <= 0x39;

export function bzip2Decode(u8: Uint8Array): Uint8Array {
  const b = new Bits(u8);
  let out = new Uint8Array(Math.max(1024, u8.length * 4)), o = 0;
  const put = (v: number) => { if (o >= out.length) { const n = new Uint8Array(out.length * 2); n.set(out); out = n; } out[o++] = v; };
  // Blocks are independent: a damaged one ends the stream, and the blocks before it are kept for callers that can use them.
  let blockStart = 0;
  try {
  for (;;) {
    if (b.get(8) !== 0x42 || b.get(8) !== 0x5a || b.get(8) !== 0x68) throw new Error('Not bzip2 data');
    const level = b.get(8) - 0x30; if (level < 1 || level > 9) throw new Error('Bad bzip2 block size');
    const max = level * 100000, tt = new Uint32Array(max);
    for (;;) {
      const m1 = b.get(24), m2 = b.get(24);
      blockStart = o; // every block before this one is whole
      if (m1 === 0x177245 && m2 === 0x385090) { b.get(32); break; } // end of stream
      if (m1 !== 0x314159 || m2 !== 0x265359) throw new Error('Corrupt bzip2 data (block header)');
      b.get(32); // block CRC
      if (b.bit()) throw new Error('Randomized bzip2 blocks are not supported');
      const origPtr = b.get(24);
      // Symbols in use.
      const inUse16 = b.get(16), seqToUnseq: number[] = [];
      for (let i = 0; i < 16; i++) if (inUse16 & (0x8000 >> i)) { const w = b.get(16); for (let j = 0; j < 16; j++) if (w & (0x8000 >> j)) seqToUnseq.push(i * 16 + j); }
      if (!seqToUnseq.length) throw new Error('Corrupt bzip2 data (no symbols)');
      const alpha = seqToUnseq.length + 2, nGroups = b.get(3), nSel = b.get(15);
      if (nGroups < 2 || nGroups > 6 || nSel < 1) throw new Error('Corrupt bzip2 data (tables)');
      const mtfG = [...Array(nGroups).keys()], selectors = new Uint8Array(nSel);
      for (let i = 0; i < nSel; i++) { let j = 0; while (b.bit()) { j++; if (j >= nGroups) throw new Error('Corrupt bzip2 data (selector)'); } const v = mtfG[j]; mtfG.splice(j, 1); mtfG.unshift(v); selectors[i] = v; }
      // Huffman tables: canonical codes by length; decoded with limit/base/perm as bzip2 does.
      const tables = [];
      for (let t = 0; t < nGroups; t++) {
        const len = new Uint8Array(alpha); let cur = b.get(5);
        for (let s = 0; s < alpha; s++) { for (;;) { if (cur < 1 || cur > 20) throw new Error('Corrupt bzip2 data (code length)'); if (!b.bit()) break; cur += b.bit() ? -1 : 1; } len[s] = cur; }
        let minL = 32, maxL = 0; for (const l of len) { if (l < minL) minL = l; if (l > maxL) maxL = l; }
        const perm: number[] = []; for (let l = minL; l <= maxL; l++) for (let s = 0; s < alpha; s++) if (len[s] === l) perm.push(s);
        const limit = new Int32Array(maxL + 2), base = new Int32Array(maxL + 2);
        let code = 0, idx = 0;
        for (let l = minL; l <= maxL; l++) { const count = len.filter((x) => x === l).length; base[l] = idx - code; code += count; idx += count; limit[l] = code - 1; code <<= 1; }
        tables.push({ minL, maxL, limit, base, perm });
      }
      // Decode the MTF/zero-run symbols into byte values.
      const mtf = [...Array(256).keys()].map((i) => i), unzftab = new Int32Array(256);
      let n = 0, group = 0, left = 0, tbl = tables[0], runPos = 0, run = 0;
      const flushRun = () => { if (!run) return; const v = seqToUnseq[mtf[0]]; unzftab[v] += run; if (n + run > max) throw new Error('Corrupt bzip2 data (block too long)'); while (run--) tt[n++] = v; run = 0; runPos = 0; };
      for (;;) {
        if (!left) { if (group >= nSel) throw new Error('Corrupt bzip2 data (selectors)'); tbl = tables[selectors[group++]]; left = 50; }
        left--;
        let l = tbl.minL, v = b.get(l);
        while (l <= tbl.maxL && v > tbl.limit[l]) { v = (v << 1) | b.bit(); l++; }
        if (l > tbl.maxL) throw new Error('Corrupt bzip2 data (code)');
        const sym = tbl.perm[v + tbl.base[l]];
        if (sym <= 1) { run += (sym + 1) << runPos; runPos++; if (run > max) throw new Error('Corrupt bzip2 data (run)'); continue; }
        flushRun();
        if (sym === alpha - 1) break; // end of block
        const k = sym - 1, val = mtf[k]; mtf.splice(k, 1); mtf.unshift(val);
        const byte = seqToUnseq[val]; unzftab[byte]++;
        if (n >= max) throw new Error('Corrupt bzip2 data (block too long)');
        tt[n++] = byte;
      }
      if (origPtr >= n) throw new Error('Corrupt bzip2 data (origin)');
      // Inverse BWT.
      const cftab = new Int32Array(257); for (let i = 0; i < 256; i++) cftab[i + 1] = cftab[i] + unzftab[i];
      for (let i = 0; i < n; i++) { const c = tt[i] & 0xff; tt[cftab[c]] |= i << 8; cftab[c]++; }
      let tPos = tt[origPtr] >>> 8, last = -1, same = 0;
      for (let k = 0; k < n; k++) {
        tPos = tt[tPos]; const ch = tPos & 0xff; tPos >>>= 8;
        // Undo the first run-length step: after four equal bytes comes a repeat count.
        if (same === 4) { for (let r = 0; r < ch; r++) put(last); same = 0; last = -1; continue; }
        put(ch);
        if (ch === last) same++; else { last = ch; same = 1; }
      }
    }
    // Another stream may follow, aligned to a byte.
    b.n -= b.n % 8; b.buf &= (1 << b.n) - 1;
    let more = false; try { more = !b.end && (() => { const save = [b.p, b.buf, b.n]; const ok = b.get(8) === 0x42; [b.p, b.buf, b.n] = save; return ok; })(); } catch { more = false; }
    if (!more) break;
  }
  } catch (e) { throw withPartial(e, out.slice(0, blockStart)); }
  return out.subarray(0, o);
}
