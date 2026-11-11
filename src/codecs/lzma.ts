/**
 * LZMA and LZMA2 decoding (as in 7z archives and .xz files), written from the LZMA specification's
 * reference decoder (Igor Pavlov, public domain), and the .xz container (LZMA2 blocks; checks not
 * verified). The decoder writes into a growable buffer that is also its dictionary.
 */
import { MAX_SOLID } from './limits';

class Out {
  buf: Uint8Array; pos = 0;
  // A size from a header is a hint: the buffer starts no larger than 16 MB and grows, up to the most a stream may hold.
  constructor(size: number) { this.buf = new Uint8Array(Math.max(16, Math.min(Number.isFinite(size) ? size : 0, 16 << 20))); }
  ensure(n: number): void { if (this.pos + n <= this.buf.length) return; if (this.pos + n > MAX_SOLID) throw new Error(`The data unpacks to more than ${MAX_SOLID >> 20} MB`); let s = this.buf.length * 2; while (s < this.pos + n) s *= 2; s = Math.min(s, MAX_SOLID); const b = new Uint8Array(s); b.set(this.buf.subarray(0, this.pos)); this.buf = b; }
  put(b: number): void { if (this.pos >= this.buf.length) this.ensure(1); this.buf[this.pos++] = b; }
  done(): Uint8Array { return this.buf.subarray(0, this.pos); }
}

class Range {
  range = 0xffffffff; code = 0; p: number;
  constructor(private u8: Uint8Array, pos: number) {
    this.p = pos;
    if (u8[this.p++] !== 0) throw new Error('Corrupt LZMA data');
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this.byte()) >>> 0;
  }
  byte(): number { if (this.p >= this.u8.length) throw new Error('Truncated LZMA data'); return this.u8[this.p++]; }
  norm(): void { if (this.range < 0x1000000) { this.range = (this.range << 8) >>> 0; this.code = ((this.code << 8) | this.byte()) >>> 0; } }
  bit(probs: Uint16Array, i: number): number {
    const p = probs[i], bound = ((this.range >>> 11) * p) >>> 0;
    if (this.code < bound) { this.range = bound; probs[i] = p + ((2048 - p) >> 5); this.norm(); return 0; }
    this.range = (this.range - bound) >>> 0; this.code = (this.code - bound) >>> 0; probs[i] = p - (p >> 5); this.norm(); return 1;
  }
  direct(n: number): number {
    let res = 0;
    do {
      this.range >>>= 1; this.code = (this.code - this.range) >>> 0;
      const t = this.code >>> 31 ? 0xffffffff : 0;
      this.code = (this.code + (this.range & t)) >>> 0;
      this.norm(); res = ((res << 1) | (t ? 0 : 1)) >>> 0;
    } while (--n);
    return res;
  }
  tree(probs: Uint16Array, base: number, n: number): number { let m = 1; for (let i = 0; i < n; i++) m = (m << 1) + this.bit(probs, base + m); return m - (1 << n); }
  reverse(probs: Uint16Array, base: number, n: number): number { let m = 1, s = 0; for (let i = 0; i < n; i++) { const b = this.bit(probs, base + m); m = (m << 1) + b; s |= b << i; } return s; }
}

class LenDecoder {
  choice = new Uint16Array(2).fill(1024); low = new Uint16Array(16 << 3).fill(1024); mid = new Uint16Array(16 << 3).fill(1024); high = new Uint16Array(256).fill(1024);
  reset(): void { this.choice.fill(1024); this.low.fill(1024); this.mid.fill(1024); this.high.fill(1024); }
  decode(rc: Range, posState: number): number {
    if (!rc.bit(this.choice, 0)) return rc.tree(this.low, posState << 3, 3);
    if (!rc.bit(this.choice, 1)) return 8 + rc.tree(this.mid, posState << 3, 3);
    return 16 + rc.tree(this.high, 0, 8);
  }
}

/** One LZMA decoder whose state can be reset or reconfigured (LZMA2 chunks). */
export class LzmaDecoder {
  lc = 3; lp = 0; pb = 2; dictSize = 1 << 23;
  private lit!: Uint16Array; private state = 0; private reps = [0, 0, 0, 0];
  private isMatch = new Uint16Array(192); private isRep = new Uint16Array(12); private isRepG0 = new Uint16Array(12); private isRepG1 = new Uint16Array(12); private isRepG2 = new Uint16Array(12); private isRep0Long = new Uint16Array(192);
  private posSlot = new Uint16Array(4 << 6); private posDec = new Uint16Array(115); private align = new Uint16Array(16);
  private len = new LenDecoder(); private repLen = new LenDecoder();
  /** Start of the data this decoder may refer back to (a dictionary reset moves it). */
  dictStart = 0;
  constructor(public out: Out) {}
  setProps(b: number): void {
    if (b >= 9 * 5 * 5) throw new Error('Bad LZMA properties');
    this.lc = b % 9; b = (b / 9) | 0; this.lp = b % 5; this.pb = (b / 5) | 0;
    if (this.lc + this.lp > 4 && this.lit === undefined) { /* allowed in LZMA1 */ }
    this.lit = new Uint16Array(0x300 << (this.lc + this.lp));
  }
  resetState(): void {
    this.lit.fill(1024); this.isMatch.fill(1024); this.isRep.fill(1024); this.isRepG0.fill(1024); this.isRepG1.fill(1024); this.isRepG2.fill(1024); this.isRep0Long.fill(1024);
    this.posSlot.fill(1024); this.posDec.fill(1024); this.align.fill(1024); this.len.reset(); this.repLen.reset();
    this.state = 0; this.reps = [0, 0, 0, 0];
  }
  /** Decodes until `outLimit` bytes are in the output (or the end marker); returns where the input stopped. */
  decode(u8: Uint8Array, pos: number, outLimit: number, allowEnd = true): number {
    const rc = new Range(u8, pos), o = this.out, pbMask = (1 << this.pb) - 1, lpMask = (1 << this.lp) - 1;
    if (Number.isFinite(outLimit)) o.ensure(Math.max(0, outLimit - o.pos));
    const buf = () => o.buf;
    while (o.pos < outLimit) {
      const total = o.pos, posState = total & pbMask, s = this.state;
      if (!rc.bit(this.isMatch, (s << 4) + posState)) {
        // Literal
        const prev = total > this.dictStart ? buf()[total - 1] : 0;
        const base = 0x300 * (((total & lpMask) << this.lc) + (prev >> (8 - this.lc)));
        let sym = 1;
        if (s >= 7) {
          let match = buf()[total - this.reps[0] - 1];
          do { const mb = (match >> 7) & 1; match <<= 1; const b = rc.bit(this.lit, base + ((1 + mb) << 8) + sym); sym = (sym << 1) | b; if (mb !== b) break; } while (sym < 0x100);
        }
        while (sym < 0x100) sym = (sym << 1) | rc.bit(this.lit, base + sym);
        o.put(sym - 0x100);
        this.state = s < 4 ? 0 : s < 10 ? s - 3 : s - 6;
        continue;
      }
      let len: number;
      if (rc.bit(this.isRep, s)) {
        if (total === this.dictStart) throw new Error('Corrupt LZMA data');
        if (!rc.bit(this.isRepG0, s)) {
          if (!rc.bit(this.isRep0Long, (s << 4) + posState)) { this.state = s < 7 ? 9 : 11; o.put(buf()[total - this.reps[0] - 1]); continue; }
        } else {
          let dist: number;
          if (!rc.bit(this.isRepG1, s)) dist = this.reps[1];
          else { if (!rc.bit(this.isRepG2, s)) dist = this.reps[2]; else { dist = this.reps[3]; this.reps[3] = this.reps[2]; } this.reps[2] = this.reps[1]; }
          this.reps[1] = this.reps[0]; this.reps[0] = dist;
        }
        len = this.repLen.decode(rc, posState); this.state = s < 7 ? 8 : 11;
      } else {
        this.reps[3] = this.reps[2]; this.reps[2] = this.reps[1]; this.reps[1] = this.reps[0];
        len = this.len.decode(rc, posState); this.state = s < 7 ? 7 : 10;
        // Distance
        const ls = len < 3 ? len : 3, slot = rc.tree(this.posSlot, ls << 6, 6);
        let dist: number;
        if (slot < 4) dist = slot;
        else {
          const nd = (slot >> 1) - 1; dist = ((2 | (slot & 1)) << nd) >>> 0;
          if (slot < 14) dist = (dist + rc.reverse(this.posDec, dist - slot, nd)) >>> 0;
          else { dist = (dist + ((rc.direct(nd - 4) << 4) >>> 0)) >>> 0; dist = (dist + rc.reverse(this.align, 0, 4)) >>> 0; }
        }
        if (dist === 0xffffffff) { if (!allowEnd) throw new Error('Unexpected LZMA end marker'); return rc.p; }
        this.reps[0] = dist;
        if (dist >= total - this.dictStart || dist >= this.dictSize) throw new Error('Corrupt LZMA data (distance)');
      }
      len += 2;
      const d = this.reps[0] + 1, n = Math.min(len, outLimit - o.pos);
      if (d > o.pos - this.dictStart) throw new Error('Corrupt LZMA data (distance)');
      o.ensure(n); const b = o.buf;
      for (let i = 0; i < n; i++) { b[o.pos] = b[o.pos - d]; o.pos++; }
    }
    return rc.p;
  }
}

/** Raw LZMA (7z coder 030101: 5 property bytes) of a known size. */
export function lzmaDecode(data: Uint8Array, props: Uint8Array, outSize: number): Uint8Array {
  const out = new Out(outSize), d = new LzmaDecoder(out);
  d.setProps(props[0]); d.dictSize = Math.max(4096, props[1] | (props[2] << 8) | (props[3] << 16) | (props[4] << 24)) >>> 0;
  d.resetState(); d.decode(data, 0, outSize);
  return out.done();
}
/** The .lzma ("LZMA alone") format: properties, dictionary size, 64-bit size (or unknown), stream. */
export function lzmaAloneDecode(u8: Uint8Array): Uint8Array {
  const lo = (u8[5] | (u8[6] << 8) | (u8[7] << 16) | (u8[8] << 24)) >>> 0, hi = (u8[9] | (u8[10] << 8) | (u8[11] << 16) | (u8[12] << 24)) >>> 0;
  const known = !(lo === 0xffffffff && hi === 0xffffffff), size = known ? hi * 4294967296 + lo : Infinity;
  const out = new Out(known ? size : u8.length * 4), d = new LzmaDecoder(out);
  d.setProps(u8[0]); d.dictSize = Math.max(4096, u8[1] | (u8[2] << 8) | (u8[3] << 16) | (u8[4] << 24)) >>> 0;
  d.resetState(); d.decode(u8, 13, size);
  return out.done();
}

/** LZMA2 chunks (7z coder 21, .xz filter 0x21), from `pos`; returns the output and where the input ended. */
export function lzma2Decode(u8: Uint8Array, dictProp: number, sizeHint = 0, pos = 0, into?: Out): { data: Uint8Array; end: number } {
  if (dictProp > 40) throw new Error('Bad LZMA2 dictionary size');
  const dictSize = dictProp === 40 ? 0xffffffff : ((2 | (dictProp & 1)) << ((dictProp >> 1) + 11)) >>> 0;
  const out = into || new Out(sizeHint || u8.length * 3), d = new LzmaDecoder(out); d.dictSize = dictSize;
  let needProps = true, needDict = true;
  for (;;) {
    if (pos >= u8.length) throw new Error('Truncated LZMA2 data');
    const c = u8[pos++];
    if (c === 0) break;
    if (c === 1 || c === 2) {
      // Uncompressed chunk (1: with a dictionary reset).
      if (c === 1) { d.dictStart = out.pos; needDict = false; } else if (needDict) throw new Error('Corrupt LZMA2 data');
      const n = ((u8[pos] << 8) | u8[pos + 1]) + 1; pos += 2;
      out.ensure(n); out.buf.set(u8.subarray(pos, pos + n), out.pos); out.pos += n; pos += n;
      continue;
    }
    if (c < 0x80) throw new Error('Corrupt LZMA2 data (control byte)');
    const unpacked = (((c & 0x1f) << 16) | (u8[pos] << 8) | u8[pos + 1]) + 1, packed = ((u8[pos + 2] << 8) | u8[pos + 3]) + 1; pos += 4;
    const reset = (c >> 5) & 3;
    if (reset === 3) { d.dictStart = out.pos; needDict = false; } else if (needDict) throw new Error('Corrupt LZMA2 data');
    if (reset >= 2) { d.setProps(u8[pos++]); needProps = false; } else if (needProps) throw new Error('Corrupt LZMA2 data');
    if (reset >= 1) d.resetState();
    d.decode(u8.subarray(0, pos + packed), pos, out.pos + unpacked, false);
    pos += packed;
  }
  return { data: out.done(), end: pos };
}

const readVli = (u8: Uint8Array, p: number): [number, number] => { let v = 0, m = 1; for (let i = 0; i < 9; i++) { if (p >= u8.length) throw new Error('The .xz file is cut off'); const b = u8[p++]; v += (b & 0x7f) * m; m *= 128; if (!(b & 0x80)) return [v, p]; } throw new Error('Bad .xz number'); };
export const isXz = (u8: Uint8Array): boolean => u8.length > 12 && u8[0] === 0xfd && u8[1] === 0x37 && u8[2] === 0x7a && u8[3] === 0x58 && u8[4] === 0x5a && u8[5] === 0;
/** An .xz file (one or more streams of LZMA2 blocks; delta and branch filters are refused). */
export function xzDecode(u8: Uint8Array): Uint8Array {
  if (!isXz(u8)) throw new Error('Not an .xz file');
  const out = new Out(u8.length * 4);
  let p = 0;
  while (p + 12 <= u8.length) {
    if (!isXz(u8.subarray(p))) { if (u8.subarray(p).every((b) => b === 0)) break; throw new Error('Corrupt .xz stream'); }
    const check = u8[p + 7] & 0x0f, checkSize = check === 0 ? 0 : check <= 3 ? 4 : check <= 6 ? 8 : check <= 9 ? 16 : check <= 12 ? 32 : 64;
    p += 12;
    for (;;) {
      if (p >= u8.length) throw new Error('The .xz file is cut off');
      const hs = u8[p];
      if (hs === 0) break; // the index
      const hEnd = p + (hs + 1) * 4, flags = u8[p + 1], nf = (flags & 3) + 1; let q = p + 2;
      if (flags & 0x40) [, q] = readVli(u8, q);
      if (flags & 0x80) [, q] = readVli(u8, q);
      let dictProp = -1;
      for (let f = 0; f < nf; f++) {
        let id, sz; [id, q] = readVli(u8, q); [sz, q] = readVli(u8, q);
        if (id === 0x21) dictProp = u8[q]; else throw new Error(`.xz filter ${id.toString(16)} is not supported`);
        q += sz;
      }
      if (dictProp < 0) throw new Error('.xz block without LZMA2');
      const r = lzma2Decode(u8, dictProp, 0, hEnd, out);
      p = r.end; while (p & 3) p++;
      p += checkSize;
    }
    // Skip the index and the stream footer.
    let q = p + 1, n; [n, q] = readVli(u8, q);
    if (n > (u8.length - q) / 2) throw new Error('Corrupt .xz index'); // each record takes at least two bytes
    for (let i = 0; i < n; i++) { [, q] = readVli(u8, q); [, q] = readVli(u8, q); }
    while (q & 3) q++;
    p = q + 4 + 12;
  }
  return out.done();
}
export { Out as LzmaOut };
