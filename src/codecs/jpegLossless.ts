/**
 * Lossless JPEG transformations: the file's entropy-coded data is decoded to its quantized DCT
 * coefficients (baseline, extended sequential and progressive Huffman JPEGs), the blocks are permuted
 * and their coefficients adjusted (rotate, flip, transpose, transverse, crop at the block grid,
 * grayscale), and the result is written back as a baseline JPEG with optimized Huffman tables. No pixel
 * is ever decoded or re-quantized. Partial edge blocks are left in place as jpegtran does, unless the
 * edges are trimmed to the block grid first (then every transform is exact).
 */

export interface JpegComponent { id: number; h: number; v: number; tq: number; /** DC/AC Huffman table ids of the last scan (used for re-encoding when not optimizing). */ td: number; ta: number; blocksPerLine: number; blocksPerColumn: number; coefs: Int16Array }
export interface JpegSegment { marker: number; data: Uint8Array }
export interface JpegCoefficients {
  width: number; height: number; precision: number;
  progressive: boolean; arithmetic: boolean;
  components: JpegComponent[];
  /** Quantization tables by id (64 entries, zigzag order). */
  qt: (Uint16Array | null)[];
  /** APPn and COM segments in file order (metadata). */
  segments: JpegSegment[];
  adobeTransform: number | null;
  restartInterval: number;
  /** What the file holds after the picture's end marker (a gain map or other second picture, a motion photo's video); empty when nothing. */
  trailer?: Uint8Array;
  warnings: string[];
  /** How much of the first full scan was decoded (MCUs or blocks), for recovery reports. */
  decodedUnits: number; totalUnits: number;
}

export const ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];

interface Huff { lookup: Int32Array /* 65536 entries: (len << 8) | value, 0 = invalid */ }

function buildHuffman(bits: Uint8Array, vals: Uint8Array): Huff {
  const lookup = new Int32Array(65536);
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++) {
      const v = vals[k++];
      const start = code << (16 - len), n = 1 << (16 - len);
      for (let j = 0; j < n; j++) lookup[start + j] = (len << 8) | v;
      code++;
    }
    code <<= 1;
  }
  return { lookup };
}

class BitReader {
  bits = 0; nbits = 0; p: number;
  /** A marker was met: no more data until the scan loop handles it. */
  markerHit = false;
  /** Zero bits fed past the end of the data (a marker or the end of the file). */
  padded = 0;
  constructor(public u8: Uint8Array, start: number) { this.p = start; }
  /** The decoder has consumed bits that were never in the file. */
  get exhausted(): boolean { return this.padded > this.nbits; }
  private fill(): void {
    while (this.nbits <= 24) {
      let b = 0, real = false;
      if (!this.markerHit && this.p < this.u8.length) {
        b = this.u8[this.p];
        if (b === 0xff) {
          const n = this.u8[this.p + 1];
          if (n === 0) { this.p += 2; real = true; }
          else if (n === 0xff) { this.p++; continue; }
          else { this.markerHit = true; b = 0; }
        } else { this.p++; real = true; }
      }
      if (!real) this.padded += 8;
      this.bits = (this.bits << 8) | b; this.nbits += 8;
    }
  }
  peek16(): number { if (this.nbits < 16) this.fill(); return (this.bits >>> (this.nbits - 16)) & 0xffff; }
  skip(n: number): void { this.nbits -= n; this.bits &= (1 << this.nbits) - 1; }
  receive(n: number): number { if (!n) return 0; if (this.nbits < n) this.fill(); const v = (this.bits >>> (this.nbits - n)) & ((1 << n) - 1); this.skip(n); return v; }
  bit(): number { return this.receive(1); }
  decode(h: Huff): number {
    const e = h.lookup[this.peek16()];
    if (!e) throw new Error('Invalid Huffman code in the scan data');
    this.skip(e >> 8);
    return e & 255;
  }
  /** Byte-aligns and consumes an RSTn marker (or any marker) that follows. Returns the marker code or -1. */
  restart(): number {
    this.bits = 0; this.nbits = 0; this.padded = 0;
    if (this.markerHit) { const m = this.u8[this.p + 1]; this.p += 2; this.markerHit = false; return m; }
    // Not at a marker (corrupt stream): look for the next one.
    while (this.p + 1 < this.u8.length && !(this.u8[this.p] === 0xff && this.u8[this.p + 1] !== 0 && this.u8[this.p + 1] !== 0xff)) this.p++;
    if (this.p + 1 < this.u8.length) { const m = this.u8[this.p + 1]; this.p += 2; return m; }
    return -1;
  }
  /** Position of the next marker after the entropy-coded data. */
  end(): number { if (this.markerHit) return this.p; while (this.p + 1 < this.u8.length && !(this.u8[this.p] === 0xff && this.u8[this.p + 1] !== 0 && !(this.u8[this.p + 1] >= 0xd0 && this.u8[this.p + 1] <= 0xd7))) this.p++; return this.p; }
}

const extend = (v: number, n: number) => (v < 1 << (n - 1) ? v - (1 << n) + 1 : v);

export function isJpeg(u8: Uint8Array): boolean { return u8.length > 4 && u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff; }

/** Decodes a JPEG's entropy-coded data into quantized coefficients. Throws for arithmetic, lossless and hierarchical files. */
export function readJpegCoefficients(u8: Uint8Array): JpegCoefficients {
  if (!isJpeg(u8)) throw new Error('Not a JPEG file');
  const out: JpegCoefficients = { width: 0, height: 0, precision: 8, progressive: false, arithmetic: false, components: [], qt: [null, null, null, null], segments: [], adobeTransform: null, restartInterval: 0, warnings: [], decodedUnits: 0, totalUnits: 0 };
  const dc: (Huff | null)[] = [null, null, null, null], ac: (Huff | null)[] = [null, null, null, null];
  let hmax = 1, vmax = 1, mcusPerLine = 0, mcusPerColumn = 0;
  let p = 2;
  let frameSeen = false;
  const eobrunRef = { v: 0 };
  while (p + 4 <= u8.length) {
    if (u8[p] !== 0xff) { out.warnings.push(`Unexpected byte at ${p}; skipping to the next marker`); while (p < u8.length && u8[p] !== 0xff) p++; continue; }
    const m = u8[p + 1];
    if (m === 0xff) { p++; continue; }
    if (m === 0xd9) { out.trailer = u8.subarray(p + 2); break; }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { p += 2; continue; }
    const len = (u8[p + 2] << 8) | u8[p + 3];
    const seg = u8.subarray(p + 4, p + 2 + len);
    if (m === 0xdb) { // DQT
      let q = 0;
      while (q < seg.length) {
        const pq = seg[q] >> 4, tq = seg[q] & 3; q++;
        const t = new Uint16Array(64);
        for (let i = 0; i < 64; i++) { t[i] = pq ? (seg[q] << 8) | seg[q + 1] : seg[q]; q += pq ? 2 : 1; }
        out.qt[tq] = t;
      }
    } else if (m === 0xc4) { // DHT
      let q = 0;
      while (q + 17 <= seg.length) {
        const tc = seg[q] >> 4, th = seg[q] & 3; q++;
        const bits = seg.subarray(q, q + 16); q += 16;
        let n = 0; for (let i = 0; i < 16; i++) n += bits[i];
        const vals = seg.subarray(q, q + n); q += n;
        (tc ? ac : dc)[th] = buildHuffman(bits, vals);
      }
    } else if (m === 0xdd) { out.restartInterval = (seg[0] << 8) | seg[1]; }
    else if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { // SOFn
      if (m === 0xc3 || m === 0xc7 || m === 0xcb || m === 0xcf) throw new Error('Lossless JPEG (SOF3/7/11/15) files cannot be transformed');
      if (m >= 0xc5 && m <= 0xc7) throw new Error('Hierarchical JPEG files cannot be transformed');
      if (m >= 0xc9) { out.arithmetic = true; throw new Error('Arithmetic-coded JPEG files cannot be transformed yet (only Huffman-coded ones)'); }
      out.progressive = m === 0xc2 || m === 0xc6 || m === 0xca;
      out.precision = seg[0];
      out.height = (seg[1] << 8) | seg[2]; out.width = (seg[3] << 8) | seg[4];
      const nc = seg[5];
      if (!out.width || !out.height) throw new Error('The frame header has no size (DNL files are not supported)');
      for (let i = 0; i < nc; i++) { const id = seg[6 + i * 3], hv = seg[7 + i * 3], tq = seg[8 + i * 3]; out.components.push({ id, h: hv >> 4, v: hv & 15, tq, td: 0, ta: 0, blocksPerLine: 0, blocksPerColumn: 0, coefs: new Int16Array(0) }); }
      hmax = Math.max(...out.components.map((c) => c.h)); vmax = Math.max(...out.components.map((c) => c.v));
      mcusPerLine = Math.ceil(out.width / (8 * hmax)); mcusPerColumn = Math.ceil(out.height / (8 * vmax));
      if (mcusPerLine * mcusPerColumn * 64 * nc > 400_000_000) throw new Error('The picture is too large to transform in memory');
      for (const c of out.components) { c.blocksPerLine = mcusPerLine * c.h; c.blocksPerColumn = mcusPerColumn * c.v; c.coefs = new Int16Array(c.blocksPerLine * c.blocksPerColumn * 64); }
      frameSeen = true;
    } else if (m === 0xda) { // SOS
      if (!frameSeen) throw new Error('A scan precedes the frame header');
      const ns = seg[0];
      const scomp: JpegComponent[] = [];
      for (let i = 0; i < ns; i++) {
        const id = seg[1 + i * 2], t = seg[2 + i * 2];
        const c = out.components.find((x) => x.id === id);
        if (!c) throw new Error(`Scan refers to an unknown component ${id}`);
        c.td = t >> 4; c.ta = t & 15;
        scomp.push(c);
      }
      const ss = seg[1 + ns * 2], se = seg[2 + ns * 2], ah = seg[3 + ns * 2] >> 4, al = seg[3 + ns * 2] & 15;
      const r = new BitReader(u8, p + 2 + len);
      decodeScan(r, out, scomp, ss, se, ah, al, dc, ac, hmax, vmax, mcusPerLine, mcusPerColumn, eobrunRef);
      p = r.end();
      continue;
    } else if ((m >= 0xe0 && m <= 0xef) || m === 0xfe) {
      out.segments.push({ marker: m, data: seg.slice() });
      if (m === 0xee && seg.length >= 12 && String.fromCharCode(...seg.subarray(0, 5)) === 'Adobe') out.adobeTransform = seg[11];
    } else if (m === 0xdc) { /* DNL */ }
    p += 2 + len;
  }
  if (!frameSeen) throw new Error('No frame header found');
  return out;
}

function decodeScan(r: BitReader, f: JpegCoefficients, comps: JpegComponent[], ss: number, se: number, ah: number, al: number, dc: (Huff | null)[], ac: (Huff | null)[], hmax: number, vmax: number, mcusPerLine: number, mcusPerColumn: number, eobrunRef: { v: number }): void {
  const pred = new Int32Array(4);
  let eobrun = 0;
  const single = comps.length === 1;
  const c0 = comps[0];
  // Non-interleaved scans cover the component's own block grid, which may be smaller than the padded one.
  const bpl = single ? Math.ceil(Math.ceil((f.width * c0.h) / hmax) / 8) : 0;
  const bpc = single ? Math.ceil(Math.ceil((f.height * c0.v) / vmax) / 8) : 0;
  const total = single ? bpl * bpc : mcusPerLine * mcusPerColumn;
  const restart = f.restartInterval;
  // A missing table (Motion JPEG frames, some cameras, damaged headers) is replaced by the standard one (Annex K.3).
  const std = (tc: 0 | 1, id: number) => { const t = standardTable(tc, id === 0 ? 0 : 1); f.warnings.push(`${tc ? 'AC' : 'DC'} Huffman table ${id} is missing; the standard table was used`); return t; };
  const needDc = !f.progressive || (ss === 0 && ah === 0), needAc = !f.progressive || ss > 0;
  const dcTab = comps.map((c) => (needDc ? dc[c.td] || (dc[c.td] = std(0, c.td)) : null)), acTab = comps.map((c) => (needAc ? ac[c.ta] || (ac[c.ta] = std(1, c.ta)) : null));

  const decodeBlock = (ci: number, c: JpegComponent, off: number): void => {
    const b = c.coefs;
    if (!f.progressive) {
      const t = r.decode(dcTab[ci]!);
      const diff = t ? extend(r.receive(t), t) : 0;
      pred[ci] += diff;
      b[off] = pred[ci];
      let k = 1;
      while (k < 64) {
        const rs = r.decode(acTab[ci]!);
        const s = rs & 15, run = rs >> 4;
        if (s === 0) { if (run < 15) break; k += 16; continue; }
        k += run;
        if (k > 63) break;
        b[off + ZIGZAG[k]] = extend(r.receive(s), s);
        k++;
      }
      return;
    }
    if (ss === 0) {
      if (ah === 0) { const t = r.decode(dcTab[ci]!); const diff = t ? extend(r.receive(t), t) : 0; pred[ci] += diff; b[off] = pred[ci] << al; }
      else if (r.bit()) b[off] |= 1 << al;
      return;
    }
    if (ah === 0) { // AC first
      if (eobrun > 0) { eobrun--; return; }
      let k = ss;
      while (k <= se) {
        const rs = r.decode(acTab[0]!);
        const s = rs & 15, run = rs >> 4;
        if (s === 0) {
          if (run < 15) { eobrun = (1 << run) - 1; if (run) eobrun += r.receive(run); break; }
          k += 16; continue;
        }
        k += run;
        if (k > 63) break;
        b[off + ZIGZAG[k]] = extend(r.receive(s), s) * (1 << al);
        k++;
      }
      return;
    }
    // AC refinement (after libjpeg's decode_mcu_AC_refine).
    const p1 = 1 << al, m1 = -1 << al;
    let k = ss;
    if (eobrun === 0) {
      for (; k <= se; k++) {
        const rs = r.decode(acTab[0]!);
        let s = rs & 15, run = rs >> 4;
        if (s) { s = r.bit() ? p1 : m1; }
        else if (run !== 15) { eobrun = 1 << run; if (run) eobrun += r.receive(run); break; }
        do {
          const z = off + ZIGZAG[k];
          const coef = b[z];
          if (coef !== 0) { if (r.bit() && (coef & p1) === 0) b[z] = coef >= 0 ? coef + p1 : coef + m1; }
          else { if (--run < 0) break; }
          k++;
        } while (k <= se);
        if (s && k <= se) b[off + ZIGZAG[k]] = s;
      }
    }
    if (eobrun > 0) {
      for (; k <= se; k++) { const z = off + ZIGZAG[k]; const coef = b[z]; if (coef !== 0 && r.bit() && (coef & p1) === 0) b[z] = coef >= 0 ? coef + p1 : coef + m1; }
      eobrun--;
    }
  };

  let n = 0;
  try {
    for (let i = 0; i < total; i++) {
      if (restart && i > 0 && i % restart === 0) {
        const m = r.restart();
        if (m < 0 || m < 0xd0 || m > 0xd7) { f.warnings.push('A restart marker is missing; the rest of the scan was skipped'); return; }
        pred.fill(0); eobrun = 0;
      }
      if (single) {
        const by = Math.floor(i / bpl), bx = i % bpl;
        decodeBlock(0, c0, (by * c0.blocksPerLine + bx) * 64);
      } else {
        const my = Math.floor(i / mcusPerLine), mx = i % mcusPerLine;
        for (let ci = 0; ci < comps.length; ci++) {
          const c = comps[ci];
          for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) decodeBlock(ci, c, ((my * c.v + v) * c.blocksPerLine + mx * c.h + h) * 64);
        }
      }
      n = i + 1;
      if (r.exhausted && i + 1 < total) { f.warnings.push(`The scan data ends early: ${n} of ${total} ${single ? 'blocks' : 'MCUs'} decoded`); break; }
    }
  } catch (e: any) {
    f.warnings.push(`Scan data damaged after ${n} of ${total} ${single ? 'blocks' : 'MCUs'}: ${e?.message || e}`);
  }
  if (!f.totalUnits || (!f.progressive || (ss === 0 && ah === 0))) { if (!f.totalUnits || n < f.decodedUnits || f.decodedUnits === f.totalUnits) { f.decodedUnits = n; f.totalUnits = total; } }
  eobrunRef.v = eobrun;
}

const STD_BITS = {
  dc0: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], dc1: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
  ac0: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d], ac1: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
};
const STD_VALS = {
  dc: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  ac0: [0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa],
  ac1: [0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa],
};
/** The standard Huffman tables of JPEG Annex K.3 (0: luminance, 1: chrominance). */
function standardTable(tc: 0 | 1, which: 0 | 1): Huff {
  if (tc === 0) return buildHuffman(Uint8Array.from(which ? STD_BITS.dc1 : STD_BITS.dc0), Uint8Array.from(STD_VALS.dc));
  return buildHuffman(Uint8Array.from(which ? STD_BITS.ac1 : STD_BITS.ac0), Uint8Array.from(which ? STD_VALS.ac1 : STD_VALS.ac0));
}

/** Repair: decodes what the scan data holds and writes a complete baseline file (missing blocks are mid-gray). */
export function repairJpeg(u8: Uint8Array): { bytes: Uint8Array; warnings: string[]; decodedUnits: number; totalUnits: number; width: number; height: number } {
  const f = readJpegCoefficients(u8);
  const bytes = writeJpegCoefficients(f);
  return { bytes, warnings: f.warnings, decodedUnits: f.decodedUnits, totalUnits: f.totalUnits, width: f.width, height: f.height };
}

// ------------------------------------------------------------------------------------------
// Transforms

export type LosslessOp = 'none' | 'rot90' | 'rot180' | 'rot270' | 'flipH' | 'flipV' | 'transpose' | 'transverse';

const hmaxOf = (f: JpegCoefficients) => Math.max(...f.components.map((c) => c.h));
const vmaxOf = (f: JpegCoefficients) => Math.max(...f.components.map((c) => c.v));

/** Whether `op` is exact for these dimensions without trimming (a partial edge block is left in place otherwise). */
export function isPerfect(f: JpegCoefficients, op: LosslessOp): boolean {
  const mw = 8 * hmaxOf(f), mh = 8 * vmaxOf(f);
  const wOk = f.width % mw === 0, hOk = f.height % mh === 0;
  switch (op) {
    case 'none': return true;
    case 'flipH': return wOk;
    case 'flipV': return hOk;
    case 'transpose': return true;
    case 'rot90': return hOk; // transpose, then flip horizontally: the new width is the old height
    case 'rot270': return wOk;
    case 'rot180': case 'transverse': return wOk && hOk;
  }
}

/** Trims the right and bottom edges to whole MCUs so every transform is exact. Returns the trimmed size. */
export function trimToGrid(f: JpegCoefficients): { width: number; height: number } {
  const mw = 8 * hmaxOf(f), mh = 8 * vmaxOf(f);
  const w = Math.max(mw, Math.floor(f.width / mw) * mw), h = Math.max(mh, Math.floor(f.height / mh) * mh);
  if (w !== f.width || h !== f.height) cropCoefficients(f, 0, 0, w, h);
  return { width: f.width, height: f.height };
}

function flipH(f: JpegCoefficients): void {
  const fullMcus = Math.floor(f.width / (8 * hmaxOf(f)));
  for (const c of f.components) {
    const full = fullMcus * c.h, bpl = c.blocksPerLine;
    const tmp = new Int16Array(64);
    for (let by = 0; by < c.blocksPerColumn; by++) {
      for (let bx = 0; bx * 2 < full; bx++) {
        const a = (by * bpl + bx) * 64, b = (by * bpl + (full - 1 - bx)) * 64;
        tmp.set(c.coefs.subarray(a, a + 64));
        for (let i = 0; i < 64; i++) { const sign = i & 1 ? -1 : 1; c.coefs[a + i] = c.coefs[b + i] * sign; c.coefs[b + i] = tmp[i] * sign; }
      }
    }
  }
}

function flipV(f: JpegCoefficients): void {
  const fullMcus = Math.floor(f.height / (8 * vmaxOf(f)));
  for (const c of f.components) {
    const full = fullMcus * c.v, bpl = c.blocksPerLine;
    const tmp = new Int16Array(64);
    for (let by = 0; by * 2 < full; by++) {
      for (let bx = 0; bx < bpl; bx++) {
        const a = (by * bpl + bx) * 64, b = ((full - 1 - by) * bpl + bx) * 64;
        tmp.set(c.coefs.subarray(a, a + 64));
        for (let i = 0; i < 64; i++) { const sign = (i >> 3) & 1 ? -1 : 1; c.coefs[a + i] = c.coefs[b + i] * sign; c.coefs[b + i] = tmp[i] * sign; }
      }
    }
  }
}

function transpose(f: JpegCoefficients): void {
  // The quantization tables are not symmetric: a coefficient that moves from (v,u) to (u,v) must keep its quantizer.
  f.qt = f.qt.map((t) => {
    if (!t) return t;
    const nat = new Uint16Array(64);
    for (let i = 0; i < 64; i++) nat[ZIGZAG[i]] = t[i];
    const out = new Uint16Array(64);
    for (let i = 0; i < 64; i++) { const n = ZIGZAG[i], v = n >> 3, u = n & 7; out[i] = nat[u * 8 + v]; }
    return out;
  });
  for (const c of f.components) {
    const bpl = c.blocksPerLine, bpc = c.blocksPerColumn;
    const out = new Int16Array(c.coefs.length);
    for (let by = 0; by < bpc; by++) for (let bx = 0; bx < bpl; bx++) {
      const src = (by * bpl + bx) * 64, dst = (bx * bpc + by) * 64;
      for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) out[dst + u * 8 + v] = c.coefs[src + v * 8 + u];
    }
    c.coefs = out; c.blocksPerLine = bpc; c.blocksPerColumn = bpl;
    const h = c.h; c.h = c.v; c.v = h;
  }
  const w = f.width; f.width = f.height; f.height = w;
}

/** Applies a transform in place. */
export function transformCoefficients(f: JpegCoefficients, op: LosslessOp): void {
  switch (op) {
    case 'none': return;
    case 'flipH': flipH(f); return;
    case 'flipV': flipV(f); return;
    case 'transpose': transpose(f); return;
    case 'rot90': transpose(f); flipH(f); return;
    case 'rot270': transpose(f); flipV(f); return;
    case 'rot180': flipH(f); flipV(f); return;
    case 'transverse': transpose(f); flipH(f); flipV(f); return;
  }
}

/** The operation that brings an EXIF orientation upright. */
export function opForOrientation(o: number): LosslessOp {
  return ({ 2: 'flipH', 3: 'rot180', 4: 'flipV', 5: 'transpose', 6: 'rot90', 7: 'transverse', 8: 'rot270' } as Record<number, LosslessOp>)[o] || 'none';
}

/** Crops at the block grid: x and y are snapped down to the MCU size; width and height are free. */
export function cropCoefficients(f: JpegCoefficients, x: number, y: number, width: number, height: number): { x: number; y: number; width: number; height: number } {
  const hmax = hmaxOf(f), vmax = vmaxOf(f), mw = 8 * hmax, mh = 8 * vmax;
  x = Math.max(0, Math.floor(x / mw) * mw); y = Math.max(0, Math.floor(y / mh) * mh);
  width = Math.max(1, Math.min(width, f.width - x)); height = Math.max(1, Math.min(height, f.height - y));
  const mcusPerLine = Math.ceil(width / mw), mcusPerColumn = Math.ceil(height / mh);
  const mx0 = x / mw, my0 = y / mh;
  for (const c of f.components) {
    const nbpl = mcusPerLine * c.h, nbpc = mcusPerColumn * c.v;
    const out = new Int16Array(nbpl * nbpc * 64);
    const bx0 = mx0 * c.h, by0 = my0 * c.v;
    for (let by = 0; by < nbpc; by++) for (let bx = 0; bx < nbpl; bx++) {
      const sx = bx0 + bx, sy = by0 + by;
      if (sx >= c.blocksPerLine || sy >= c.blocksPerColumn) continue;
      out.set(c.coefs.subarray((sy * c.blocksPerLine + sx) * 64, (sy * c.blocksPerLine + sx) * 64 + 64), (by * nbpl + bx) * 64);
    }
    c.coefs = out; c.blocksPerLine = nbpl; c.blocksPerColumn = nbpc;
  }
  f.width = width; f.height = height;
  return { x, y, width, height };
}

/** Keeps only the first (luminance) component. */
export function toGrayscale(f: JpegCoefficients): void {
  if (f.components.length < 2) return;
  const y = f.components[0];
  // With the chroma gone the component's own grid is the padded grid for factors 1×1: rebuild it.
  const hmax = hmaxOf(f), vmax = vmaxOf(f);
  const bpl = Math.ceil(f.width / 8), bpc = Math.ceil(f.height / 8);
  if (y.h !== hmax || y.v !== vmax) throw new Error('The luminance component is subsampled; grayscale conversion needs the full-resolution channel');
  const out = new Int16Array(bpl * bpc * 64);
  for (let by = 0; by < bpc; by++) out.set(y.coefs.subarray(by * y.blocksPerLine * 64, (by * y.blocksPerLine + bpl) * 64), by * bpl * 64);
  y.coefs = out; y.blocksPerLine = bpl; y.blocksPerColumn = bpc; y.h = 1; y.v = 1;
  f.components = [y];
  f.adobeTransform = null;
  f.segments = f.segments.filter((s) => s.marker !== 0xee);
}

// ------------------------------------------------------------------------------------------
// Encoder (baseline sequential Huffman, optimized tables)

class BitWriter {
  out: number[] = [];
  acc = 0; n = 0;
  write(code: number, len: number): void {
    this.acc = (this.acc << len) | code; this.n += len;
    while (this.n >= 8) { const b = (this.acc >>> (this.n - 8)) & 255; this.out.push(b); if (b === 0xff) this.out.push(0); this.n -= 8; this.acc &= (1 << this.n) - 1; }
  }
  flush(): void { if (this.n) { this.write((1 << (8 - this.n)) - 1, 8 - this.n); } }
}

/** Optimal Huffman code lengths and values for symbol frequencies (JPEG Annex K.2, after libjpeg's jpeg_gen_optimal_table). */
export function optimalTable(freqIn: Uint32Array): { bits: Uint8Array; vals: Uint8Array } {
  const freq = new Float64Array(257);
  for (let i = 0; i < 256; i++) freq[i] = freqIn[i];
  freq[256] = 1; // reserved code point so no real symbol gets an all-ones code
  const codesize = new Int32Array(257), others = new Int32Array(257).fill(-1);
  for (;;) {
    let c1 = -1, v = Infinity;
    for (let i = 0; i <= 256; i++) if (freq[i] && freq[i] <= v) { v = freq[i]; c1 = i; }
    let c2 = -1; v = Infinity;
    for (let i = 0; i <= 256; i++) if (freq[i] && freq[i] <= v && i !== c1) { v = freq[i]; c2 = i; }
    if (c2 < 0) break;
    freq[c1] += freq[c2]; freq[c2] = 0;
    codesize[c1]++;
    while (others[c1] >= 0) { c1 = others[c1]; codesize[c1]++; }
    others[c1] = c2;
    codesize[c2]++;
    while (others[c2] >= 0) { c2 = others[c2]; codesize[c2]++; }
  }
  const bits = new Int32Array(33);
  for (let i = 0; i <= 256; i++) if (codesize[i]) { if (codesize[i] > 32) throw new Error('Huffman code too long'); bits[codesize[i]]++; }
  for (let i = 32; i > 16; i--) {
    while (bits[i] > 0) {
      let j = i - 2;
      while (bits[j] === 0) j--;
      bits[i] -= 2; bits[i - 1]++; bits[j + 1] += 2; bits[j]--;
    }
  }
  let i = 16; while (bits[i] === 0) i--;
  bits[i]--; // drop the reserved symbol
  const outBits = new Uint8Array(16);
  for (let k = 1; k <= 16; k++) outBits[k - 1] = bits[k];
  const vals: number[] = [];
  for (let len = 1; len <= 32; len++) for (let s = 0; s < 256; s++) if (codesize[s] === len) vals.push(s);
  return { bits: outBits, vals: Uint8Array.from(vals) };
}

function codesFrom(bits: Uint8Array, vals: Uint8Array): { code: Uint16Array; size: Uint8Array } {
  const code = new Uint16Array(256), size = new Uint8Array(256);
  let c = 0, k = 0;
  for (let len = 1; len <= 16; len++) { for (let i = 0; i < bits[len - 1]; i++) { code[vals[k]] = c; size[vals[k]] = len; k++; c++; } c <<= 1; }
  return { code, size };
}

const nbitsOf = (v: number): number => { v = Math.abs(v); let n = 0; while (v) { n++; v >>= 1; } return n; };

export interface WriteOptions { /** Drop every APPn/COM segment. */ stripMetadata?: boolean; /** Keep only EXIF, ICC and XMP (drop thumbnails in other APPn, comments). */ keepEssential?: boolean; comment?: string }

/** Writes coefficients as a baseline sequential JPEG with optimized Huffman tables. */
export function writeJpegCoefficients(f: JpegCoefficients, opts: WriteOptions = {}): Uint8Array {
  if (f.precision !== 8) throw new Error(`${f.precision}-bit JPEGs cannot be written as baseline`);
  const comps = f.components;
  const hmax = hmaxOf(f), vmax = vmaxOf(f);
  const mcusPerLine = Math.ceil(f.width / (8 * hmax)), mcusPerColumn = Math.ceil(f.height / (8 * vmax));
  const single = comps.length === 1;
  const bpl1 = Math.ceil(f.width / 8), bpc1 = Math.ceil(f.height / 8);
  // Table ids: component 0 uses tables 0, the others table 1 (chroma share), as the common writers do.
  const tabOf = (ci: number) => (ci === 0 ? 0 : 1);
  // Pass 1: statistics.
  const dcFreq = [new Uint32Array(256), new Uint32Array(256)], acFreq = [new Uint32Array(256), new Uint32Array(256)];
  const forEachBlock = (fn: (ci: number, c: JpegComponent, off: number) => void) => {
    if (single) { const c = comps[0]; for (let by = 0; by < bpc1; by++) for (let bx = 0; bx < bpl1; bx++) fn(0, c, (by * c.blocksPerLine + bx) * 64); return; }
    for (let my = 0; my < mcusPerColumn; my++) for (let mx = 0; mx < mcusPerLine; mx++) for (let ci = 0; ci < comps.length; ci++) { const c = comps[ci]; for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) fn(ci, c, ((my * c.v + v) * c.blocksPerLine + mx * c.h + h) * 64); }
  };
  const pred = new Int32Array(4);
  forEachBlock((ci, c, off) => {
    const t = tabOf(ci);
    const b = c.coefs;
    const diff = b[off] - pred[ci]; pred[ci] = b[off];
    dcFreq[t][nbitsOf(diff)]++;
    let run = 0;
    for (let k = 1; k < 64; k++) {
      const v = b[off + ZIGZAG[k]];
      if (v === 0) { run++; continue; }
      while (run > 15) { acFreq[t][0xf0]++; run -= 16; }
      acFreq[t][(run << 4) | nbitsOf(v)]++; run = 0;
    }
    if (run) acFreq[t][0]++;
  });
  const used = single ? [0] : [0, 1];
  const dcT = used.map((t) => optimalTable(dcFreq[t])), acT = used.map((t) => optimalTable(acFreq[t]));
  const dcC = dcT.map((t) => codesFrom(t.bits, t.vals)), acC = acT.map((t) => codesFrom(t.bits, t.vals));
  // Headers.
  const out: number[] = [0xff, 0xd8];
  const seg = (marker: number, body: number[] | Uint8Array) => { const len = body.length + 2; out.push(0xff, marker, len >> 8, len & 255); for (let i = 0; i < body.length; i++) out.push(body[i]); };
  const keepSeg = (s: JpegSegment) => {
    if (opts.stripMetadata) return false;
    if (!opts.keepEssential) return true;
    const head = String.fromCharCode(...s.data.subarray(0, 12));
    return (s.marker === 0xe1 && (head.startsWith('Exif') || head.startsWith('http:'))) || (s.marker === 0xe2 && head.startsWith('ICC_PROFILE')) || s.marker === 0xe0 || s.marker === 0xee;
  };
  const kept = f.segments.filter(keepSeg);
  if (!kept.some((s) => s.marker === 0xe0) && !kept.some((s) => s.marker === 0xee) && !single && comps.length === 3) seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  for (const s of kept) if (s.marker === 0xe0) seg(s.marker, s.data);
  for (const s of kept) if (s.marker !== 0xe0) seg(s.marker, s.data);
  if (opts.comment) seg(0xfe, Array.from(new TextEncoder().encode(opts.comment)));
  for (let q = 0; q < 4; q++) {
    const t = f.qt[q];
    if (!t || !comps.some((c) => c.tq === q)) continue;
    const wide = t.some((v) => v > 255);
    const body: number[] = [(wide ? 16 : 0) | q];
    for (let i = 0; i < 64; i++) { if (wide) body.push(t[i] >> 8); body.push(t[i] & 255); }
    seg(0xdb, body);
  }
  const sof: number[] = [8, f.height >> 8, f.height & 255, f.width >> 8, f.width & 255, comps.length];
  for (const c of comps) sof.push(c.id, (c.h << 4) | c.v, c.tq);
  seg(0xc0, sof);
  for (const t of used) { seg(0xc4, [0x00 | t, ...dcT[t].bits, ...dcT[t].vals]); seg(0xc4, [0x10 | t, ...acT[t].bits, ...acT[t].vals]); }
  const sos: number[] = [comps.length];
  for (let ci = 0; ci < comps.length; ci++) sos.push(comps[ci].id, (tabOf(ci) << 4) | tabOf(ci));
  sos.push(0, 63, 0);
  seg(0xda, sos);
  // Pass 2: the scan.
  const w = new BitWriter();
  pred.fill(0);
  forEachBlock((ci, c, off) => {
    const t = tabOf(ci);
    const b = c.coefs;
    const diff = b[off] - pred[ci]; pred[ci] = b[off];
    const s = nbitsOf(diff);
    w.write(dcC[t].code[s], dcC[t].size[s]);
    if (s) w.write(diff < 0 ? (diff - 1) & ((1 << s) - 1) : diff, s);
    let run = 0;
    for (let k = 1; k < 64; k++) {
      const v = b[off + ZIGZAG[k]];
      if (v === 0) { run++; continue; }
      while (run > 15) { w.write(acC[t].code[0xf0], acC[t].size[0xf0]); run -= 16; }
      const sz = nbitsOf(v), sym = (run << 4) | sz;
      w.write(acC[t].code[sym], acC[t].size[sym]);
      w.write(v < 0 ? (v - 1) & ((1 << sz) - 1) : v, sz);
      run = 0;
    }
    if (run) w.write(acC[t].code[0], acC[t].size[0]);
  });
  w.flush();
  const scan = w.out;
  const result = new Uint8Array(out.length + scan.length + 2);
  result.set(out); result.set(scan, out.length);
  result[result.length - 2] = 0xff; result[result.length - 1] = 0xd9;
  return result;
}

/** One call: read, transform (optionally trimming and converting), write. */
export function losslessTransform(u8: Uint8Array, op: LosslessOp, opts: WriteOptions & { trim?: boolean; grayscale?: boolean; crop?: { x: number; y: number; width: number; height: number }; orientation?: number } = {}): { bytes: Uint8Array; perfect: boolean; warnings: string[]; width: number; height: number } {
  const f = readJpegCoefficients(u8);
  if (opts.crop) cropCoefficients(f, opts.crop.x, opts.crop.y, opts.crop.width, opts.crop.height);
  if (opts.trim) trimToGrid(f);
  const perfect = isPerfect(f, op);
  transformCoefficients(f, op);
  if (opts.grayscale) toGrayscale(f);
  if (opts.orientation !== undefined) {
    for (const s of f.segments) if (s.marker === 0xe1 && s.data[0] === 0x45 && s.data[1] === 0x78) { const exif = s.data.subarray(6); patchOrientation(exif, opts.orientation); }
  }
  // What followed the picture in the file. A second picture (an HDR gain map, a depth map) would have to be turned and
  // cropped with the first to stay in register, which this does not do: it is left out, with its index, and the result
  // says so. Anything else (a motion photo's video, found from the end of the file) is carried over as it was.
  const t = f.trailer, kb = t ? Math.max(1, Math.round(t.length / 1024)) : 0;
  const second = !!t && t.length > 4 && t[0] === 0xff && t[1] === 0xd8, other = !!t && !second && t.some((b) => b !== 0);
  if (second) {
    f.segments = f.segments.filter((s) => !(s.marker === 0xe2 && s.data[0] === 0x4d && s.data[1] === 0x50 && s.data[2] === 0x46 && s.data[3] === 0)); // the MPF index pointing at it
    f.warnings.push(`A second picture stored after the main one (an HDR gain map, a depth map or a large preview; ${kb} KB) was left out: it cannot be turned or cropped with the picture`);
  }
  let bytes = writeJpegCoefficients(f, opts);
  if (other) {
    const joined = new Uint8Array(bytes.length + t!.length); joined.set(bytes); joined.set(t!, bytes.length); bytes = joined;
    f.warnings.push(`${kb} KB stored after the picture (a motion photo's video, for example) were kept as they were`);
  }
  return { bytes, perfect, warnings: f.warnings, width: f.width, height: f.height };
}

function patchOrientation(exif: Uint8Array, value: number): void {
  if (exif.length < 10) return;
  const le = exif[0] === 0x49;
  const dv = new DataView(exif.buffer, exif.byteOffset, exif.byteLength);
  if (dv.getUint16(2, le) !== 42) return;
  const ifd = dv.getUint32(4, le);
  if (ifd + 2 > exif.length) return;
  const n = dv.getUint16(ifd, le);
  for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (e + 12 > exif.length) break; if (dv.getUint16(e, le) === 0x112 && dv.getUint16(e + 2, le) === 3) { dv.setUint16(e + 8, value, le); return; } }
}
