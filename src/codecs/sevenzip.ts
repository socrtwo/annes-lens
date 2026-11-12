/**
 * 7z archives: the headers (also when they are themselves compressed), folders of chained coders
 * (Copy, LZMA, LZMA2, BZip2, Deflate, PPMd; one input and one output each), solid folders holding many files,
 * empty files and folders, names and modification times. A folder is decompressed when one of its
 * files is first read. Encrypted archives and executable filters (BCJ) are refused with a message.
 */
import { lzmaDecode, lzma2Decode } from './lzma';
import { bzip2Decode } from './bzip2';
import { Ppmd7, Range7z } from './ppmd';
import { checkUnpacked, MAX_SOLID, partialOf } from './limits';

export interface SevenEntry { name: string; size: number; mtime: number; folder: number; offset: number }
interface Coder { id: string; props: Uint8Array; nIn: number; nOut: number }
interface Folder { coders: Coder[]; bind: [number, number][]; packed: number[]; unpackSizes: number[] }
interface Streams { packPos: number; packSizes: number[]; folders: Folder[]; subCounts: number[]; subSizes: number[][] }

export const isSevenZip = (u8: Uint8Array): boolean => u8.length > 32 && u8[0] === 0x37 && u8[1] === 0x7a && u8[2] === 0xbc && u8[3] === 0xaf && u8[4] === 0x27 && u8[5] === 0x1c;

class Reader {
  constructor(public u8: Uint8Array, public p = 0) {}
  byte(): number { if (this.p >= this.u8.length) throw new Error('Truncated 7z header'); return this.u8[this.p++]; }
  /** 7z's variable-length NUMBER. */
  num(): number {
    const first = this.byte(); let mask = 0x80, v = 0;
    for (let i = 0; i < 8; i++) {
      if (!(first & mask)) return v + (first & (mask - 1)) * 2 ** (8 * i);
      v += this.byte() * 2 ** (8 * i); mask >>= 1;
    }
    return v;
  }
  u32(): number { const v = (this.u8[this.p] | (this.u8[this.p + 1] << 8) | (this.u8[this.p + 2] << 16) | (this.u8[this.p + 3] << 24)) >>> 0; this.p += 4; return v; }
  u64(): number { const lo = this.u32(), hi = this.u32(); return hi * 4294967296 + lo; }
  bits(n: number): boolean[] { const out: boolean[] = []; let b = 0, m = 0; for (let i = 0; i < n; i++) { if (!m) { b = this.byte(); m = 0x80; } out.push(!!(b & m)); m >>= 1; } return out; }
  /** A count the rest of the header could not describe (each item takes at least a bit of it) means a damaged or crafted file: refused before anything is allocated for it. */
  count(n: number): number { if (!(n >= 0) || n > (this.u8.length - this.p) * 8 + 8) throw new Error('Bad 7z header: a count larger than the header itself'); return n; }
  defined(n: number): boolean[] { this.count(n); const all = this.byte(); return all ? new Array(n).fill(true) : this.bits(n); }
}

function readFolder(r: Reader): Folder {
  const coders: Coder[] = [], n = r.num();
  let totalIn = 0, totalOut = 0;
  for (let i = 0; i < n; i++) {
    const flag = r.byte(), idSize = flag & 0x0f;
    if (flag & 0x80) throw new Error('7z alternative coder methods are not supported');
    let id = ''; for (let k = 0; k < idSize; k++) id += r.byte().toString(16).padStart(2, '0');
    let nIn = 1, nOut = 1; if (flag & 0x10) { nIn = r.num(); nOut = r.num(); }
    let props = new Uint8Array(0); if (flag & 0x20) { const s = r.num(); props = r.u8.slice(r.p, r.p + s); r.p += s; }
    coders.push({ id, props, nIn, nOut }); totalIn += nIn; totalOut += nOut;
  }
  const bind: [number, number][] = []; for (let i = 0; i < totalOut - 1; i++) bind.push([r.num(), r.num()]);
  const nPacked = totalIn - bind.length, packed: number[] = [];
  if (nPacked === 1) { for (let i = 0; i < totalIn; i++) if (!bind.some((b) => b[0] === i)) { packed.push(i); break; } }
  else for (let i = 0; i < nPacked; i++) packed.push(r.num());
  return { coders, bind, packed, unpackSizes: [] };
}
function readStreams(r: Reader): Streams {
  const s: Streams = { packPos: 0, packSizes: [], folders: [], subCounts: [], subSizes: [] };
  for (;;) {
    const id = r.byte();
    if (id === 0x00) break;
    if (id === 0x06) { // PackInfo
      s.packPos = r.num(); const n = r.num();
      for (;;) { const t = r.byte(); if (t === 0) break; if (t === 0x09) for (let i = 0; i < n; i++) s.packSizes.push(r.num()); else if (t === 0x0a) { const d = r.defined(n); d.forEach((x) => x && r.u32()); } else throw new Error('Bad 7z pack info'); }
    } else if (id === 0x07) { // Coders (UnPackInfo)
      if (r.byte() !== 0x0b) throw new Error('Bad 7z coders info');
      const n = r.num(); if (r.byte() !== 0) throw new Error('External 7z coder info is not supported');
      for (let i = 0; i < n; i++) s.folders.push(readFolder(r));
      if (r.byte() !== 0x0c) throw new Error('Bad 7z coders info');
      for (const f of s.folders) { const outs = f.coders.reduce((a, c) => a + c.nOut, 0); for (let i = 0; i < outs; i++) f.unpackSizes.push(r.num()); }
      for (;;) { const t = r.byte(); if (t === 0) break; if (t === 0x0a) { const d = r.defined(n); d.forEach((x) => x && r.u32()); } else throw new Error('Bad 7z coders info'); }
    } else if (id === 0x08) { // SubStreamsInfo
      s.subCounts = s.folders.map(() => 1);
      let t = r.byte();
      if (t === 0x0d) { s.subCounts = s.folders.map(() => r.num()); t = r.byte(); }
      s.subSizes = s.folders.map((f, i) => { const total = folderSize(f), n = s.subCounts[i]; if (!n) return []; const sizes: number[] = []; let sum = 0; if (t === 0x09) for (let k = 0; k < n - 1; k++) { const v = r.num(); sizes.push(v); sum += v; } sizes.push(total - sum); return sizes; });
      if (t === 0x09) t = r.byte();
      while (t !== 0) {
        if (t === 0x0a) { const unknown = s.folders.reduce((a, f, i) => a + (s.subCounts[i] === 1 ? 0 : s.subCounts[i]), 0) + s.folders.filter((_, i) => s.subCounts[i] === 1).length; const d = r.defined(unknown); d.forEach((x) => x && r.u32()); }
        else throw new Error('Bad 7z substreams info');
        t = r.byte();
      }
    } else throw new Error(`Unexpected 7z header item ${id}`);
  }
  if (!s.subCounts.length) { s.subCounts = s.folders.map(() => 1); s.subSizes = s.folders.map((f) => [folderSize(f)]); }
  return s;
}
/** A folder's final output size: the out stream no bind pair consumes. */
function folderSize(f: Folder): number {
  const outs = f.coders.reduce((a, c) => a + c.nOut, 0);
  for (let i = 0; i < outs; i++) if (!f.bind.some((b) => b[1] === i)) return f.unpackSizes[i];
  return f.unpackSizes[f.unpackSizes.length - 1];
}

const METHODS: Record<string, string> = { '00': 'Copy', '21': 'LZMA2', '030101': 'LZMA', '040108': 'Deflate', '040202': 'BZip2', '03030103': 'BCJ', '0303011b': 'BCJ2', '06f10701': 'AES', '030401': 'PPMd', '03': 'Delta' };
async function inflateRaw(u8: Uint8Array, size: number): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw'), w = ds.writable.getWriter();
  void w.write(u8.slice()).catch(() => undefined); void w.close().catch(() => undefined);
  const out = new Uint8Array(size); const r = ds.readable.getReader(); let o = 0;
  for (;;) { const { done, value } = await r.read(); if (done) break; const n = Math.min(value.length, size - o); out.set(value.subarray(0, n), o); o += n; }
  return out;
}
/** 7z PPMd: properties are the model order and its memory size; the stream ends after `size` bytes. */
export const ppmdStats = { restarts: 0, glues: 0 };
function ppmd(input: Uint8Array, props: Uint8Array, size: number): Uint8Array {
  if (props.length < 5) throw new Error('Damaged 7z PPMd properties');
  const order = props[0], mem = (props[1] | (props[2] << 8) | (props[3] << 16) | (props[4] << 24)) >>> 0;
  if (order < 2 || order > 64) throw new Error('Damaged 7z PPMd properties');
  let p = 0; const rc = new Range7z(() => (p < input.length ? input[p++] : (p++, 0)));
  const model = new Ppmd7(mem); model.init(order);
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    const c = model.decodeSymbol(rc);
    if (c < 0 || p > input.length + 4) throw new Error('The 7z PPMd data is damaged');
    out[i] = c;
  }
  ppmdStats.restarts = model.restarts; ppmdStats.glues = model.glues;
  return out;
}
async function runCoder(c: Coder, input: Uint8Array, size: number): Promise<Uint8Array> {
  switch (c.id) {
    case '00': return input.subarray(0, size);
    case '21': return lzma2Decode(input, c.props[0], size).data.subarray(0, size);
    case '030101': return lzmaDecode(input, c.props, size);
    case '040202': return bzip2Decode(input).subarray(0, size);
    case '040108': return inflateRaw(input, size);
    case '030401': return ppmd(input, c.props, size);
    case '06f10701': throw new Error('This 7z archive is encrypted (AES), which Anne\'s Lens does not open');
    default: throw new Error(`7z method ${METHODS[c.id] || c.id} is not supported`);
  }
}

export class SevenZip {
  entries: SevenEntry[] = []; warnings: string[] = [];
  private streams!: Streams; private cache = new Map<number, Promise<Uint8Array>>(); private damage = new Map<number, string>();
  constructor(private u8: Uint8Array) {}
  static async open(u8: Uint8Array): Promise<SevenZip> { const z = new SevenZip(u8); await z.parse(); return z; }
  private async parse(): Promise<void> {
    const u8 = this.u8; if (!isSevenZip(u8)) throw new Error('Not a 7z archive');
    const hr = new Reader(u8, 12), off = hr.u64(), size = hr.u64();
    if (32 + off + size > u8.length) throw new Error('The 7z archive is cut off');
    let r = new Reader(u8.subarray(32 + off, 32 + off + size));
    let id = r.byte();
    for (let depth = 0; id === 0x17; depth++) { // the header is itself packed
      if (depth >= 4) throw new Error('Bad 7z archive: its packed header unpacks to another packed header, again and again');
      const s = readStreams(r); this.streams = s;
      const data = await this.decodeFolder(0, s); // the header's own folder: not cached with the files'
      r = new Reader(data); id = r.byte();
    }
    if (id !== 0x01) throw new Error('Bad 7z header');
    let s: Streams = { packPos: 0, packSizes: [], folders: [], subCounts: [], subSizes: [] };
    let t = r.byte();
    if (t === 0x02) { for (;;) { const k = r.byte(); if (k === 0) break; r.p += r.num(); } t = r.byte(); }
    if (t === 0x03) { readStreams(r); t = r.byte(); }
    if (t === 0x04) { s = readStreams(r); t = r.byte(); }
    this.streams = s;
    const names: string[] = [], mtimes: number[] = [];
    let empty: boolean[] = [], emptyFile: boolean[] = [], n = 0;
    if (t === 0x05) {
      n = r.count(r.num());
      for (;;) {
        const pid = r.byte(); if (pid === 0) break;
        const psize = r.num(), end = r.p + psize;
        if (pid === 0x0e) empty = r.bits(n);
        else if (pid === 0x0f) emptyFile = r.bits(empty.filter(Boolean).length);
        else if (pid === 0x11) { if (r.byte() !== 0) throw new Error('External 7z names are not supported'); let cur = ''; while (r.p + 1 < end) { const c = r.u8[r.p] | (r.u8[r.p + 1] << 8); r.p += 2; if (c === 0) { names.push(cur); cur = ''; } else cur += String.fromCharCode(c); } }
        else if (pid === 0x14) { const d = r.defined(n); if (r.byte() !== 0) throw new Error('External 7z times are not supported'); d.forEach((x, i) => { mtimes[i] = x ? (r.u64() / 10000 - 11644473600000) : 0; }); }
        r.p = end;
      }
    }
    // Files with data take the folders' substreams in order.
    let folder = 0, sub = 0, offset = 0, ei = 0;
    for (let i = 0; i < n; i++) {
      const name = (names[i] || `file ${i + 1}`).replace(/\\/g, '/');
      if (empty[i]) { const isFile = emptyFile[ei++]; if (isFile) this.entries.push({ name, size: 0, mtime: mtimes[i] || 0, folder: -1, offset: 0 }); continue; }
      while (folder < s.folders.length && sub >= s.subCounts[folder]) { folder++; sub = 0; offset = 0; }
      if (folder >= s.folders.length) { this.warnings.push('The 7z archive lists more files than it holds'); break; }
      const size = s.subSizes[folder][sub];
      this.entries.push({ name, size, mtime: mtimes[i] || 0, folder, offset });
      offset += size; sub++;
    }
  }
  /** A folder's decompressed bytes (kept while files from it are read). */
  private folderData(i: number): Promise<Uint8Array> {
    let hit = this.cache.get(i);
    if (!hit) {
      hit = this.decodeFolder(i, this.streams);
      if (this.cache.size > 2) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(i, hit);
      hit.catch(() => this.cache.delete(i));
    }
    return hit;
  }
  private decodeFolder(i: number, s: Streams): Promise<Uint8Array> {
    return (async () => {
      const f = s.folders[i];
      if (f.coders.some((c) => c.nIn !== 1 || c.nOut !== 1) || f.packed.length !== 1) throw new Error('This 7z archive uses a coder arrangement Anne\'s Lens does not support (for example BCJ2)');
      // Pack streams follow each other; folder i's stream comes after the earlier folders' streams.
      const packIndex = s.folders.slice(0, i).reduce((a, x) => a + x.packed.length, 0);
      const packStart = 32 + s.packPos + s.packSizes.slice(0, packIndex).reduce((a, b) => a + b, 0);
      let data = this.u8.subarray(packStart, packStart + s.packSizes[packIndex]);
      // Follow the chain from the coder that reads the packed stream to the one whose output is unbound.
      for (const size of f.unpackSizes) checkUnpacked(size, 'A block of this 7z archive', MAX_SOLID); // sizes from the header size the buffers below
      let coder = f.packed[0];
      for (let guard = 0; guard < f.coders.length; guard++) {
        const next = f.bind.find((b) => b[1] === coder);
        try { data = await runCoder(f.coders[coder], data, f.unpackSizes[coder]); }
        catch (e) {
          // The last coder's output up to the damage still holds the files that lie before it (R17).
          const part = partialOf(e);
          if (next || !part) throw e;
          this.damage.set(i, (e as Error)?.message || String(e));
          return part;
        }
        if (!next) break;
        coder = next[0];
      }
      return data;
    })();
  }
  /** True when any file's data is encrypted (AES): the names may be readable, the pictures are not. */
  get encrypted(): boolean { return !!this.streams?.folders.some((f) => f.coders.some((c) => c.id === '06f10701')); }
  async read(e: SevenEntry): Promise<Uint8Array> {
    if (e.folder < 0) return new Uint8Array(0);
    const d = await this.folderData(e.folder);
    if (e.offset + e.size > d.length) throw new Error(`This file lies in a damaged part of the archive (${this.damage.get(e.folder) || 'the data ends early'})`);
    return d.subarray(e.offset, e.offset + e.size);
  }
}
