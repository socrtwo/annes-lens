/**
 * RAR archives (RAR 1.5–4.x headers with the 1.5, 2.0 and 2.9 coders, and RAR 5.0): the file list (names, sizes,
 * times, folders, links), stored and compressed files, solid archives (a file is unpacked after the ones
 * before it in the same stream; reading in order keeps that cheap) and CRC-32 checks. Encrypted archives
 * and files and multi-volume archives are refused with a message.
 */
import { Unpack3, Unpack5, UnpackOld, RarError, crc32 } from './rarunpack';
import { checkUnpacked } from './limits';

export interface RarEntry {
  name: string; size: number; packed: number; mtime: number; dir: boolean; link: boolean;
  method: number; version: number; solid: boolean; encrypted: boolean; split: boolean;
  dict: number; crc: number | null; offset: number; index: number;
}

const SIG4 = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00], SIG5 = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00];
const at = (u8: Uint8Array, sig: number[], p = 0) => sig.every((b, i) => u8[p + i] === b);
export const isRar = (u8: Uint8Array): boolean => u8.length > 20 && (at(u8, SIG4) || at(u8, SIG5));

const dosTime = (t: number) => new Date(((t >>> 25) & 127) + 1980, ((t >>> 21) & 15) - 1, (t >>> 16) & 31, (t >>> 11) & 31, (t >>> 5) & 63, (t & 31) * 2).getTime();

/** RAR 2.x–4.x Unicode names: an OEM name, a zero, then the Unicode name coded against it. */
function decodeUnicodeName(name: Uint8Array, enc: Uint8Array): string {
  const out: number[] = []; let ep = 0, flags = 0, flagBits = 0;
  const high = enc[ep++] ?? 0;
  while (ep < enc.length) {
    if (flagBits === 0) { flags = enc[ep++]; flagBits = 8; }
    switch (flags >> 6) {
      case 0: out.push(enc[ep++]); break;
      case 1: out.push(enc[ep++] + (high << 8)); break;
      case 2: out.push(enc[ep] + (enc[ep + 1] << 8)); ep += 2; break;
      default: {
        let len = enc[ep++];
        if (len & 0x80) { const corr = enc[ep++]; for (len = (len & 0x7f) + 2; len > 0; len--) { const d = out.length; out.push(((name[d] + corr) & 0xff) + (high << 8)); } }
        else for (len += 2; len > 0; len--) out.push(name[out.length]);
      }
    }
    flags = (flags << 2) & 0xff; flagBits -= 2;
  }
  return String.fromCharCode(...out.filter((c) => c !== undefined && !Number.isNaN(c)));
}
function plainName(b: Uint8Array): string {
  if (b.every((c) => c < 0x80)) return String.fromCharCode(...b);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return new TextDecoder('windows-1252').decode(b); }
}

export class Rar {
  entries: RarEntry[] = []; warnings: string[] = []; format: 4 | 5 = 4;
  solid = false; volume = false; headersEncrypted = false;
  private u3: Unpack3 | null = null; private u5: Unpack5 | null = null; private uOld: UnpackOld | null = null; private next = -1; // index of the next file in the current solid stream
  /** Files unpacked while replaying a solid stream, kept (up to 64 MB) so reading out of order stays cheap. */
  private cache = new Map<number, Uint8Array>(); private cached = 0;

  constructor(private u8: Uint8Array) {
    if (at(u8, SIG5)) { this.format = 5; this.parse5(); } else if (at(u8, SIG4)) this.parse4(); else throw new RarError('Not a RAR archive');
  }
  get encrypted(): boolean { return this.headersEncrypted || this.entries.some((e) => e.encrypted); }

  private parse4(): void {
    const u = this.u8, dv = new DataView(u.buffer, u.byteOffset, u.byteLength); let p = 7;
    while (p + 7 <= u.length) {
      const crc = dv.getUint16(p, true), type = u[p + 2], flags = dv.getUint16(p + 3, true), size = dv.getUint16(p + 5, true);
      if (size < 7 || p + size > u.length) { this.warnings.push('The archive ends early'); break; }
      let add = flags & 0x8000 ? dv.getUint32(p + 7, true) : 0;
      if ((type === 0x74 || type === 0x7a) && flags & 0x100 && size >= 36) add += dv.getUint32(p + 32, true) * 4294967296;
      // RAR 1.5–2.0 wrote a wrong CRC for headers carrying a comment (the main header's, or a file's).
      const oldComment = (type === 0x73 && flags & 2) || (type === 0x74 && flags & 8);
      if (type !== 0x72 && !oldComment && (crc32(u.subarray(p + 2, p + size)) & 0xffff) !== crc) this.warnings.push('A damaged header was found');
      if (type === 0x73) {
        this.volume = !!(flags & 1); this.solid = !!(flags & 8);
        if (flags & 0x80) { this.headersEncrypted = true; break; }
      } else if (type === 0x74 && size >= 32) {
        const packed = add, high = flags & 0x100 ? 8 : 0;
        const unp = dv.getUint32(p + 11, true) + (high ? dv.getUint32(p + 36, true) * 4294967296 : 0);
        const host = u[p + 15], fcrc = dv.getUint32(p + 16, true), time = dv.getUint32(p + 20, true), ver = u[p + 24], method = u[p + 25];
        const nameSize = dv.getUint16(p + 26, true), attr = dv.getUint32(p + 28, true), nameAt = p + 32 + high;
        const raw = u.subarray(nameAt, Math.min(nameAt + nameSize, p + size));
        let name: string;
        if (flags & 0x200) { const z = raw.indexOf(0); name = z >= 0 ? decodeUnicodeName(raw.subarray(0, z), raw.subarray(z + 1)) : plainName(raw); }
        else name = plainName(raw);
        name = name.replace(/\\/g, '/'); // RAR 2.x–4.x stores '\\' as the separator
        const unixType = attr & 0xf000;
        const dir = (flags & 0xe0) === 0xe0 || ((host === 0 || host === 2) && !!(attr & 0x10)) || (host === 3 && unixType === 0x4000);
        this.entries.push({ name, size: unp, packed, mtime: dosTime(time), dir, link: host === 3 && unixType === 0xa000, method: method - 0x30, version: ver, solid: !!(flags & 0x10), encrypted: !!(flags & 4), split: !!(flags & 3), dict: 0x10000 << ((flags >>> 5) & 7), crc: fcrc, offset: p + size, index: this.entries.length });
      } else if (type === 0x7b) break;
      p += size + add;
    }
    // Below version 2.0 the per-file solid flag is never read: in a solid archive every file after the first
    // compressed one continues the stream.
    if (this.solid) {
      let seen = false;
      for (const e of this.entries) if (e.version < 20 && !e.dir && !e.link && e.method !== 0 && e.packed > 0) { e.solid = seen; seen = true; }
    }
  }

  private parse5(): void {
    const u = this.u8, dv = new DataView(u.buffer, u.byteOffset, u.byteLength); let p = 8;
    const vint = (q: { p: number }, end: number) => { let v = 0, s = 0; for (;;) { if (q.p >= end) throw new RarError('Damaged header'); const b = u[q.p++]; v += (b & 0x7f) * 2 ** s; if (!(b & 0x80)) return v; s += 7; if (s > 63) throw new RarError('Damaged header'); } };
    while (p + 6 <= u.length) {
      const crc = dv.getUint32(p, true), q = { p: p + 4 };
      let hsize: number; try { hsize = vint(q, Math.min(u.length, p + 7)); } catch { this.warnings.push('A damaged header was found'); break; }
      const hstart = q.p, hend = hstart + hsize;
      if (hsize < 2 || hsize > 0x200000 || hend > u.length) { this.warnings.push('The archive ends early'); break; }
      if (crc32(u.subarray(p + 4, hend)) !== crc) { this.warnings.push('A damaged header was found'); break; }
      let data = 0;
      try {
        const type = vint(q, hend), flags = vint(q, hend), extra = flags & 1 ? vint(q, hend) : 0; data = flags & 2 ? vint(q, hend) : 0;
        if (hend + data > u.length) this.warnings.push('The archive ends early');
        if (type === 1) { const af = vint(q, hend); this.volume = !!(af & 1); this.solid = !!(af & 4); }
        else if (type === 4) { this.headersEncrypted = true; break; }
        else if (type === 2) {
          const ff = vint(q, hend), unp = vint(q, hend); vint(q, hend);
          let mtime = 0; if (ff & 2) { mtime = dv.getUint32(q.p, true) * 1000; q.p += 4; }
          let fcrc: number | null = null; if (ff & 4) { fcrc = dv.getUint32(q.p, true); q.p += 4; }
          const comp = vint(q, hend); vint(q, hend); const nlen = vint(q, hend);
          if (q.p + nlen > hend) throw new RarError('Damaged header');
          const name = new TextDecoder().decode(u.subarray(q.p, q.p + nlen)); q.p += nlen;
          let encrypted = false, link = false;
          const xEnd = hend; let x = hend - extra;
          while (x < xEnd) {
            const r = { p: x }; const rsize = vint(r, xEnd), rstart = r.p; if (rstart + rsize > xEnd) break;
            const rtype = vint(r, xEnd);
            if (rtype === 1) encrypted = true; else if (rtype === 5) link = true;
            x = rstart + rsize;
          }
          if (ff & 1 && data > 0) throw new RarError('A folder entry holds data');
          this.entries.push({ name, size: ff & 8 ? 0 : unp, packed: data, mtime, dir: !!(ff & 1), link, method: (comp >>> 7) & 7, version: comp & 0x3f, solid: !!(comp & 0x40), encrypted, split: !!(flags & 0x18), dict: 0x20000 * 2 ** ((comp >>> 10) & 0xf), crc: fcrc, offset: hend, index: this.entries.length });
        } else if (type === 5) break;
      } catch (e) { this.warnings.push((e as Error).message); break; }
      p = hend + data;
    }
  }

  /** The unpacked bytes of one file; checks its CRC-32 when the archive stores one. */
  read(e: RarEntry): Uint8Array {
    if (e.dir || e.link) return new Uint8Array(0);
    if (this.headersEncrypted || e.encrypted) throw new RarError('This RAR archive is encrypted, which Anne\'s Lens does not open');
    if (e.split) throw new RarError(`${e.name} continues in another volume of a multi-volume archive, which Anne's Lens does not join`);
    if (e.offset + e.packed > this.u8.length) throw new RarError(`${e.name}: the archive is cut short`);
    const hit = this.cache.get(e.index); if (hit) return hit;
    try { checkUnpacked(e.size, e.name); } catch (err) { throw new RarError((err as Error).message); } // the header's size is what the unpackers allocate
    const packed = this.u8.subarray(e.offset, e.offset + e.packed);
    let out: Uint8Array;
    if (e.method === 0 || (e.packed === 0 && e.size === 0)) out = packed.slice(0, e.size);
    else if (this.format === 4) {
      if (e.version === 15 || e.version === 20 || e.version === 26) out = this.solidRun(e, () => (this.uOld ??= new UnpackOld()), (u, x, s) => (u as UnpackOld).unpack(this.u8.subarray(x.offset, x.offset + x.packed), x.size, x.dict, s, x.version));
      else if (e.version === 29 || e.version === 36) out = this.solidRun(e, () => (this.u3 ??= new Unpack3()), (u, x, s) => (u as Unpack3).unpack(this.u8.subarray(x.offset, x.offset + x.packed), x.size, x.dict, s));
      else throw new RarError(`${e.name} was packed by a RAR version (${e.version}) whose compression Anne's Lens does not know`);
    } else {
      if (e.version !== 0) throw new RarError(`${e.name} uses a newer RAR compression (version ${e.version}) than Anne's Lens unpacks`);
      out = this.solidRun(e, () => (this.u5 ??= new Unpack5()), (u, x, s) => (u as Unpack5).unpack(this.u8.subarray(x.offset, x.offset + x.packed), x.size, x.dict, s));
    }
    if (e.crc !== null && crc32(out) !== e.crc) throw new RarError(`${e.name} is damaged (CRC mismatch)`);
    return out;
  }

  /** Unpacks `e`, first replaying the files before it in its solid stream unless the decoder is already there. */
  private solidRun(e: RarEntry, make: () => Unpack3 | Unpack5 | UnpackOld, run: (u: Unpack3 | Unpack5 | UnpackOld, x: RarEntry, solid: boolean) => Uint8Array): Uint8Array {
    const compressed = (x: RarEntry) => !x.dir && !x.link && x.method !== 0 && x.packed > 0;
    if (!e.solid) { const u = make(); this.next = e.index + 1; return run(u, e, false); }
    let first = e.index;
    while (first > 0 && !(compressed(this.entries[first]) && !this.entries[first].solid)) first--;
    const from = this.next >= first && this.next <= e.index ? this.next : first;
    if (from === first && this.next !== first) { this.u3 = null; this.u5 = null; this.uOld = null; }
    const u = make();
    let out: Uint8Array = new Uint8Array(0);
    for (let i = from; i <= e.index; i++) {
      const x = this.entries[i]; if (!compressed(x)) continue;
      out = run(u, x, i !== first && x.solid);
      if (i !== e.index && !this.cache.has(i) && this.cached + out.length <= 64 * 1048576 && (x.crc === null || crc32(out) === x.crc)) { this.cache.set(i, out); this.cached += out.length; }
    }
    this.next = e.index + 1;
    return out;
  }
}
export { RarError };
