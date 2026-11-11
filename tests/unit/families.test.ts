/**
 * The RAW family readers on small files written here: the bit unpackers, Sony's ARW2 blocks, Kodak's
 * 65000 runs, Nikon's Huffman stream and small-size YCbCr, the SR2 cipher, and whole files of the
 * TIFF kind (Pentax, Epson, Nikon, Samsung), Minolta MRW, Fujifilm RAF and Panasonic RW2. The real
 * cameras' files are compared sample by sample with LibRaw in tests/unit/corpus.test.ts when the
 * corpus has been fetched.
 */
import { describe, it, expect } from 'vitest';
import { readRaw, rawSupport, unpackBe, unpackLe, unpack16, commonShift, decodeArw2, decodeKodak65000, decodeNikon, decodeNikonYuv, sonyDecrypt, GENERIC_COLOR_MATRIX } from '../../src/raw/families';
import { develop } from '../../src/raw/develop';
import { decodeLjpeg } from '../../src/raw/ljpeg';

// A small TIFF writer: entries [tag, type, values]; strings and byte blobs as arrays; data blobs placed after the IFD.
type Entry = [number, number, number[]];
function tiff(entries: Entry[], le: boolean, opts: { magic?: number[]; subIfds?: Entry[][]; exif?: Entry[]; blobs?: Uint8Array[] } = {}): Uint8Array {
  const sizes: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 8: 2, 9: 4, 10: 8, 13: 4 };
  let pos = 8;
  const ifdBytes = (es: Entry[]) => 2 + es.length * 12 + 4;
  const place = (n: number) => { const o = pos; pos += n + (n & 1); return o; };
  // Layout: header, IFD0, sub IFDs, EXIF IFD, then every out-of-line value and blob.
  const ifd0At = place(ifdBytes(entries));
  const subAt = (opts.subIfds || []).map((s) => place(ifdBytes(s)));
  const exifAt = opts.exif ? place(ifdBytes(opts.exif)) : 0;
  const blobAt = (opts.blobs || []).map((b) => place(b.length));
  const values = new Map<Entry, number>();
  const allIfds: Entry[][] = [entries, ...(opts.subIfds || []), ...(opts.exif ? [opts.exif] : [])];
  for (const es of allIfds) for (const e of es) { const n = sizes[e[1]] * e[2].length; if (n > 4) values.set(e, place(n)); }
  const out = new Uint8Array(pos), dv = new DataView(out.buffer);
  out[0] = out[1] = le ? 0x49 : 0x4d; const magic = opts.magic || [42, 0]; if (le) { out[2] = magic[0]; out[3] = magic[1]; } else { out[2] = magic[1]; out[3] = magic[0]; }
  dv.setUint32(4, ifd0At, le);
  const writeIfd = (es: Entry[], at: number) => {
    dv.setUint16(at, es.length, le);
    es.forEach((e, k) => {
      const o = at + 2 + k * 12, [tag, type, vals] = e; dv.setUint16(o, tag, le); dv.setUint16(o + 2, type, le); dv.setUint32(o + 4, vals.length, le);
      const n = sizes[type] * vals.length, vo = n > 4 ? values.get(e)! : o + 8; if (n > 4) dv.setUint32(o + 8, vo, le);
      vals.forEach((x, i) => { const p = vo + i * sizes[type]; if (type === 3) dv.setUint16(p, x, le); else if (type === 8) dv.setInt16(p, x, le); else if (type === 4 || type === 13) dv.setUint32(p, x, le); else if (type === 9) dv.setInt32(p, x, le); else if (type === 5) { dv.setUint32(p, Math.round(x * 256), le); dv.setUint32(p + 4, 256, le); } else out[p] = x; });
    });
    dv.setUint32(at + 2 + es.length * 12, 0, le);
  };
  // Pointers to sub IFDs, EXIF and blobs are filled by the caller through placeholder tags: 330 (SubIFDs), 0x8769 (EXIF), and blob offsets as tag values ≥ 0x80000000 | index.
  const fix = (es: Entry[]) => es.map((e): Entry => {
    if (e[0] === 330) return [330, 4, subAt];
    if (e[0] === 0x8769) return [0x8769, 4, [exifAt]];
    return [e[0], e[1], e[2].map((x) => (x >= 0x80000000 && x < 0x80000000 + blobAt.length ? blobAt[x - 0x80000000] : x))];
  });
  // Re-run value placement with fixed entries that keep identity with the originals (same lengths).
  const fixedAll = allIfds.map(fix); fixedAll.forEach((es, i) => es.forEach((e, k) => { const orig = allIfds[i][k]; if (values.has(orig)) values.set(e, values.get(orig)!); }));
  writeIfd(fixedAll[0], ifd0At); (opts.subIfds || []).forEach((_, i) => writeIfd(fixedAll[1 + i], subAt[i])); if (opts.exif) writeIfd(fixedAll[fixedAll.length - 1], exifAt);
  (opts.blobs || []).forEach((b, i) => out.set(b, blobAt[i]));
  return out;
}
const str = (s: string) => [...s].map((c) => c.charCodeAt(0)).concat(0);
const packBe = (vals: number[], bps: number) => { const out: number[] = []; let acc = 0, n = 0; for (const v of vals) { acc = (acc << bps) | v; n += bps; while (n >= 8) { out.push((acc >> (n - 8)) & 255); n -= 8; acc &= (1 << n) - 1; } } if (n) out.push((acc << (8 - n)) & 255); return Uint8Array.from(out); };
const packLe = (vals: number[], bps: number) => { const out: number[] = []; let acc = 0, n = 0; for (const v of vals) { acc |= v << n; n += bps; while (n >= 8) { out.push(acc & 255); acc >>>= 8; n -= 8; } } if (n) out.push(acc & 255); return Uint8Array.from(out); };
const be16 = (vals: number[]) => { const out = new Uint8Array(vals.length * 2); vals.forEach((v, i) => { out[i * 2] = v >> 8; out[i * 2 + 1] = v & 255; }); return out; };
const le16 = (vals: number[]) => { const out = new Uint8Array(vals.length * 2); vals.forEach((v, i) => { out[i * 2] = v & 255; out[i * 2 + 1] = v >> 8; }); return out; };
const ramp = (n: number, f = (i: number) => (i * 37 + 11) & 0xfff) => Array.from({ length: n }, (_, i) => f(i));

describe('RAW families: unpacking', () => {
  it('unpacks big-endian, little-endian and padded bit streams and 16-bit words', () => {
    const vals = ramp(20);
    expect([...unpackBe(packBe(vals, 12), 20, 12)]).toEqual(vals);
    expect([...unpackLe(packLe(vals, 12), 20, 12)]).toEqual(vals);
    expect([...unpackBe(packBe(vals.map((v) => v >> 2), 10), 20, 10)]).toEqual(vals.map((v) => v >> 2));
    expect([...unpackBe(packBe(vals.map((v) => v << 2), 14), 20, 14)]).toEqual(vals.map((v) => v << 2));
    // Epson: a pad byte after every 10 pixels (15 bytes).
    const padded = new Uint8Array(32); padded.set(packBe(vals.slice(0, 10), 12), 0); padded[15] = 0xee; padded.set(packBe(vals.slice(10), 12), 16); padded[31] = 0xee;
    expect([...unpackBe(padded, 20, 12, 10)]).toEqual(vals);
    expect([...unpack16(be16(vals), 20, false)]).toEqual(vals); expect([...unpack16(le16(vals), 20, true)]).toEqual(vals);
    expect([...unpack16(be16(vals.map((v) => v << 4)), 20, false, 4)]).toEqual(vals);
  });
  it('finds how far 16-bit words were shifted up, ignoring a few stray low bits', () => {
    const data = Uint16Array.from(ramp(4000).map((v) => v << 4));
    expect(commonShift(data, 4)).toBe(4); expect(commonShift(data, 8)).toBe(4);
    data[7] |= 2; expect(commonShift(data, 8)).toBe(4); // one stray bit does not count
    for (let i = 0; i < 40; i++) data[i * 50] |= 1; expect(commonShift(data, 8)).toBe(0); // one percent does
    expect(commonShift(new Uint16Array(100), 8)).toBe(0);
  });
});

describe('RAW families: codings', () => {
  it('decodes Sony ARW2 blocks through the camera curve', () => {
    // One row of 32 pixels: two blocks (even columns, then odd), 11-bit values with a shift of 1.
    const even = ramp(16, (i) => 1000 + i * 2), odd = ramp(16, (i) => 500 + i * 8);
    const block = (pix: number[]) => {
      const max = Math.max(...pix), min = Math.min(...pix), imax = pix.indexOf(max), imin = pix.indexOf(min);
      let sh = 0; while (sh < 4 && (0x80 << sh) <= max - min) sh++;
      const b = new Uint8Array(16), dv = new DataView(b.buffer); dv.setUint32(0, (max | (min << 11) | (imax << 22) | (imin << 26)) >>> 0, true);
      let bit = 30; for (let i = 0; i < 16; i++) { if (i === imax || i === imin) continue; const f = (pix[i] - min) >> sh; for (let k = 0; k < 7; k++, bit++) if ((f >> k) & 1) b[bit >> 3] |= 1 << (bit & 7); }
      return b;
    };
    const src = new Uint8Array(32); src.set(block(even), 0); src.set(block(odd), 16);
    const tag = [8000, 10400, 12900, 14100], knots = [0, ...tag.map((t) => (t >> 2) & 0xfff), 4095];
    const out = decodeArw2(src, 32, 1, tag);
    // Expected through the same piecewise curve: slope 1 up to 2000, 2 to 2600, 4 to 3225, 8 to 3525, 16 to 4095.
    const expectCurve = (x: number) => { let acc = 0; for (let i = 0; i < 5; i++) { const lo = knots[i], hi = knots[i + 1]; if (x > lo) acc += (Math.min(x, hi) - lo) * (1 << i); } return acc; };
    for (let i = 0; i < 16; i++) { expect(out[i * 2]).toBe(expectCurve(even[i] << 1)); expect(out[i * 2 + 1]).toBe(expectCurve(odd[i] << 1)); }
    expect(expectCurve(2 * 1000)).toBe(2000); expect(expectCurve(2 * 1500)).toBe(2000 + 600 * 2 + 400 * 4);
  });
  it('decodes Kodak 65000 runs, coded and plain', () => {
    // Plain run: when the first byte's nibbles are not both code lengths (≤ 12), six 16-bit words carry eight 12-bit values.
    const want = [0xd23, 0x456, 0x789, 0xabc, 0xdef, 0x012, 0x345, 0x678]; // 0xd in the first word's top nibble triggers it
    const raw = want.slice(2); raw[0] |= (want[0] >> 8) << 12; raw[2] |= ((want[0] >> 4) & 15) << 12; raw[4] |= (want[0] & 15) << 12; raw[1] |= (want[1] >> 8) << 12; raw[3] |= ((want[1] >> 4) & 15) << 12; raw[5] |= (want[1] & 15) << 12;
    expect([...decodeKodak65000(be16(raw), 8, 1)]).toEqual(want);
    // Coded run of four: lengths 4,4,4,4 then the 16 preloaded bits hold the four differences (low nibble first).
    const d = [9, 10, 11, 12]; // 4-bit codes with the top bit set are positive
    const src = Uint8Array.from([0x44, 0x44, (d[3] << 4) | d[2], (d[1] << 4) | d[0]]);
    expect([...decodeKodak65000(src, 4, 1)]).toEqual([9, 10, 20, 22]);
    // A negative difference: code 3 in 4 bits is 3 − 15 = −12.
    const neg = Uint8Array.from([0x44, 0x44, (d[3] << 4) | d[2], (d[1] << 4) | 3]);
    expect([...decodeKodak65000(neg, 4, 1)]).toEqual([0, 10, 0, 22]); // clamped at 0 (−12 + 11 → −1 → 0)
  });
  it('decodes Nikon Huffman data with the 12-bit lossy tree and the maker note block', () => {
    // meta: version 0x44 0x10, vertical predictors 100, then an empty curve (identity).
    const meta = Uint8Array.from([0x44, 0x10, 0, 100, 0, 100, 0, 100, 0, 100, 0, 0]);
    // Differences +3 (symbol 2: code 101, bits 11) and −5 (symbol 3: code 011, bits 010) → 10111011 01000000.
    const out = decodeNikon(Uint8Array.from([0xbb, 0x40]), 2, 1, 12, meta);
    expect([...out]).toEqual([103, 95]);
    // A third pixel predicts from the first of its column parity.
    const out3 = decodeNikon(Uint8Array.from([0xbb, 0x5e]), 3, 1, 12, meta); // then symbol 0 (code 11110): no change
    expect([...out3]).toEqual([103, 95, 103]);
  });
  it('turns small-size NEF YCbCr pairs into linear RGB with the white balance taken back out', () => {
    const pack = (y0: number, y1: number, cb: number, cr: number) => packLe([y0, y1, cb + 2048, cr + 2048], 12);
    const gray = decodeNikonYuv(pack(4095, 2048, 0, 0), 2, 1, [2, 1, 1]);
    expect([...gray]).toEqual([2048, 4095, 4095, Math.round(Math.round(((2048 / 4095 + 0.055) / 1.055) ** 2.4 * 4095) / 2), Math.round(((2048 / 4095 + 0.055) / 1.055) ** 2.4 * 4095), Math.round(((2048 / 4095 + 0.055) / 1.055) ** 2.4 * 4095)]);
    const red = decodeNikonYuv(pack(2000, 2000, -200, 300), 2, 1, null);
    expect(red[0]).toBeGreaterThan(red[1]); expect(red[2]).toBeLessThan(red[1]);
  });
  it('applies the SR2 cipher symmetrically and differently for different keys', () => {
    const data = Uint8Array.from(ramp(64, (i) => (i * 73) & 255));
    const a = sonyDecrypt(data, 0x44332211), b = sonyDecrypt(data, 0x44332212);
    expect(a).not.toEqual(data); expect(a).not.toEqual(b);
    expect(sonyDecrypt(a, 0x44332211)).toEqual(data);
  });
});

describe('RAW families: files', () => {
  const W = 8, H = 6, vals = ramp(W * H, (i) => 200 + ((i * 53) % 3000));
  it('reads a Pentax-style TIFF: packed 12-bit big-endian, black and white balance from the AOC maker note', () => {
    // The AOC maker note is an IFD whose value offsets are file positions: build the file once to learn where the note lands, then again with the offsets filled in.
    const note = (valuesAt: number) => { const b = new Uint8Array(6 + 2 + 24 + 4 + 16), dv = new DataView(b.buffer); b.set(str('AOC').slice(0, 4), 0); b[4] = b[5] = 0x4d; dv.setUint16(6, 2); for (let k = 0; k < 2; k++) { const o = 8 + k * 12; dv.setUint16(o, 0x200 + k); dv.setUint16(o + 2, 3); dv.setUint32(o + 4, 4); dv.setUint32(o + 8, valuesAt + k * 8); } [128, 127, 127, 130, 11840, 8192, 8192, 12224].forEach((x, i) => dv.setUint16(36 + i * 2, x)); return [...b]; };
    const data = packBe(vals, 12);
    const build = (valuesAt: number) => tiff([[256, 4, [W]], [257, 4, [H]], [258, 3, [12]], [259, 3, [32773]], [262, 3, [32803]], [271, 2, str('PENTAX')], [272, 2, str('PENTAX *ist DL')], [273, 4, [0x80000000]], [277, 3, [1]], [278, 4, [H]], [279, 4, [data.length]], [33421, 3, [2, 2]], [33422, 1, [0, 1, 1, 2]], [0x8769, 4, [0]]], false, { exif: [[0x927c, 7, note(valuesAt)]], blobs: [data] });
    const probe = build(0), at = probe.findIndex((_, i) => probe[i] === 0x41 && probe[i + 1] === 0x4f && probe[i + 2] === 0x43 && probe[i + 3] === 0);
    const file = build(at + 36);
    const r = readRaw(file, 'test.pef');
    expect([r.width, r.height, r.samples, r.cfa, r.white[0]]).toEqual([W, H, 1, [0, 1, 1, 2], 4095]);
    expect([...r.data]).toEqual(vals);
    expect([...r.black]).toEqual([128, 127, 127, 130]); // per position: R, G, G2 (third value), B
    expect(r.asShotNeutral!.map((x) => +x.toFixed(4))).toEqual([+(8192 / 11840).toFixed(4), 1, +(8192 / 12224).toFixed(4)]);
    expect(r.make).toBe('PENTAX'); expect(r.model).toBe('PENTAX *ist DL');
    expect(rawSupport(file, 'test.pef')).toEqual({ ok: true, family: 'PEF' });
    expect(readRaw(file).model).toBe('PENTAX *ist DL'); // no name: the Make tag decides the family
  });
  it('reads Epson-padded rows, Nikon 16-bit words, Samsung three-sample CFA and a Sony-style 16-bit file', () => {
    // Epson: 32769 with a pad byte after every 10 pixels; W = 10 keeps one pad per row.
    const ew = 10, eh = 4, ev = ramp(ew * eh, (i) => (i * 97) & 0xfff), erows = new Uint8Array(16 * eh);
    for (let y = 0; y < eh; y++) erows.set(packBe(ev.slice(y * ew, (y + 1) * ew), 12), y * 16);
    const erf = tiff([[256, 4, [ew]], [257, 4, [eh]], [258, 3, [12]], [259, 3, [32769]], [262, 3, [32803]], [271, 2, str('SEIKO EPSON CORP.')], [273, 4, [0x80000000]], [277, 3, [1]], [279, 4, [erows.length]], [33422, 1, [0, 1, 1, 2]]], false, { blobs: [erows] });
    expect([...readRaw(erf, 'a.erf').data]).toEqual(ev);
    // Nikon: 12-bit samples packed most significant bit first in a big-endian file (the D1H's layout).
    const nd = packBe(vals, 12);
    const nef = tiff([[256, 4, [W]], [257, 4, [H]], [258, 3, [12]], [259, 3, [1]], [262, 3, [32803]], [271, 2, str('NIKON CORPORATION')], [273, 4, [0x80000000]], [277, 3, [1]], [279, 4, [nd.length]], [33422, 1, [2, 1, 1, 0]]], false, { blobs: [nd] });
    const n = readRaw(nef, 'a.nef'); expect([...n.data]).toEqual(vals); expect(n.cfa).toEqual([2, 1, 1, 0]);
    // Nikon 16-bit words are big-endian even in a little-endian file, shifted up by four.
    const nd16 = be16(vals.map((v) => v << 4));
    const nef16 = tiff([[256, 4, [W]], [257, 4, [H]], [258, 3, [12]], [259, 3, [34713]], [262, 3, [32803]], [273, 4, [0x80000000]], [277, 3, [1]], [279, 4, [nd16.length]], [33422, 1, [0, 1, 1, 2]]], true, { blobs: [nd16] });
    expect([...readRaw(nef16, 'a.nrw').data]).toEqual(vals);
    // Samsung: SamplesPerPixel 3 on CFA data, 14-bit little-endian words in a big-endian file.
    const sd = le16(vals);
    const srw = tiff([[256, 4, [W]], [257, 4, [H]], [258, 3, [14]], [259, 4, [32769]], [273, 4, [0x80000000]], [277, 3, [3]], [279, 4, [sd.length]], [33421, 3, [2, 2]], [33422, 1, [0, 1, 1, 2]]], false, { blobs: [sd] });
    const s = readRaw(srw, 'a.srw'); expect([...s.data]).toEqual(vals); expect(s.white[0]).toBe(16383);
    // Sony SR2: 14-bit big-endian words in a little-endian file.
    const sr = be16(vals);
    const sr2 = tiff([[254, 4, [1]], [259, 3, [6]], [330, 4, [0]]], true, { subIfds: [[[254, 4, [0]], [256, 4, [W]], [257, 4, [H]], [258, 3, [14]], [259, 3, [1]], [262, 3, [32803]], [273, 4, [0x80000000]], [277, 3, [1]], [279, 4, [sr.length]], [33422, 1, [1, 0, 2, 1]]]], blobs: [sr] });
    const t = readRaw(sr2, 'a.sr2'); expect([...t.data]).toEqual(vals); expect(t.cfa).toEqual([1, 0, 2, 1]);
  });
  it('refuses packed layouts that were never checked against a real file, and says so before Develop RAW is offered', () => {
    // The same header fields describe other makers' packings, which differ: decoding them the Nikon or Pentax way gives noise without any error.
    const packed = (make: string, comp: number, le: boolean, data: Uint8Array) => tiff([[256, 4, [W]], [257, 4, [H]], [258, 3, [12]], [259, 3, [comp]], [262, 3, [32803]], [271, 2, str(make)], [273, 4, [0x80000000]], [277, 3, [1]], [279, 4, [data.length]], [33422, 1, [0, 1, 1, 2]]], le, { blobs: [data] });
    const cases: [Uint8Array, string, RegExp][] = [
      [packed('NIKON CORPORATION', 34713, true, packLe(vals, 12)), 'a.nef', /has not been checked against a sample file/],  // Nikon's little-endian packing
      [packed('SAMSUNG', 32769, true, packBe(vals, 12)), 'a.srw', /Samsung's packed or compressed codings/],                // the NX1000's layout
      [packed('OLYMPUS IMAGING CORP.', 1, true, packBe(vals, 12)), 'a.orf', /Olympus's packed or compressed coding/],
      [packed('OLYMPUS IMAGING CORP.', 1, true, packBe(vals, 12).subarray(0, 40)), 'b.orf', /Olympus's packed or compressed coding/], // compressed: fewer bytes than any packing
      [packed('PENTAX', 65535, false, packBe(vals, 12).subarray(0, 30)), 'a.pef', /Pentax's compressed coding \(K10D and later/],
      [packed('SONY', 1, true, packBe(vals, 12)), 'a.arw', /has not been checked against a sample file/],
    ];
    for (const [file, name, why] of cases) {
      const s = rawSupport(file, name);
      expect(s.ok, name).toBe(false); expect(s.why, name).toMatch(why);
      expect(() => readRaw(file, name), name).toThrow(why);   // the report and the reader say the same
    }
  });
  it('checks every sensor size against the data present before allocating for it', () => {
    const t0 = Date.now();
    // A 48-byte Minolta file claiming 12,000 × 12,000 pixels.
    const mrw = new Uint8Array(48), mdv = new DataView(mrw.buffer); mrw.set([0, 0x4d, 0x52, 0x4d], 0); mdv.setUint32(4, 40); mrw.set([0, 0x50, 0x52, 0x44], 8); mdv.setUint32(12, 24); mdv.setUint16(24, 12000); mdv.setUint16(26, 12000); mrw[33] = 12; mrw[34] = 0x59;
    expect(rawSupport(mrw, 'a.mrw')).toMatchObject({ ok: false }); expect(() => readRaw(mrw, 'a.mrw')).toThrow(/too few for 12000×12000/);
    // A TIFF family file whose header claims more than any sensor holds, and one whose strips are far too short.
    const huge = tiff([[256, 4, [60000]], [257, 4, [60000]], [258, 3, [16]], [259, 3, [1]], [262, 3, [32803]], [273, 4, [8]], [277, 3, [1]], [279, 4, [16]], [33422, 1, [0, 1, 1, 2]]], true);
    expect(() => readRaw(huge, 'a.arw')).toThrow(/larger than this module reads/);
    const short = tiff([[256, 4, [4000]], [257, 4, [3000]], [258, 3, [12]], [259, 3, [7]], [262, 3, [32803]], [273, 4, [8]], [277, 3, [1]], [279, 4, [16]], [33422, 1, [0, 1, 1, 2]]], true);
    expect(() => readRaw(short, 'a.dcr')).toThrow(/too few for 4000×3000/);
    // A lossless JPEG frame header of 65535 × 65535 with a few bytes behind it.
    const lj = Uint8Array.from([0xff, 0xd8, 0xff, 0xc4, 0, 20, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xc3, 0, 11, 12, 0xff, 0xff, 0xff, 0xff, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 1, 0, 0, 1, 2, 3]);
    expect(() => decodeLjpeg(lj)).toThrow(/too few for 65535×65535|larger than this module reads/);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it('refuses the families it cannot decode with a reason, and plain TIFFs named like RAW files', () => {
    expect(rawSupport(Uint8Array.from([0, 0, 0, 0x18, ...str('ftypcrx ').slice(0, 8)]), 'a.cr3')).toMatchObject({ ok: false, family: 'CR3' });
    expect(rawSupport(Uint8Array.from(str('FOVb').slice(0, 4).concat(new Array(20).fill(0))), 'a.x3f').why).toMatch(/Foveon/);
    expect(rawSupport(tiff([[256, 4, [4]]], true), 'a.iiq').why).toMatch(/Phase One/);
    const rgb = tiff([[256, 4, [2]], [257, 4, [2]], [258, 3, [8, 8, 8]], [262, 3, [2]], [273, 4, [8]], [277, 3, [3]], [279, 4, [12]]], true);
    expect(() => readRaw(rgb, 'scan.nef')).toThrow(/no sensor image/); expect(rawSupport(rgb, 'scan.nef')).toMatchObject({ ok: false, why: expect.stringMatching(/no sensor image/) });
  });
  it('reads Minolta MRW blocks', () => {
    const prd = new Uint8Array(24); prd.set(str('27730001').slice(0, 8), 0); prd[8] = H >> 8; prd[9] = H & 255; prd[10] = W >> 8; prd[11] = W & 255; prd[16] = 16; prd[17] = 12; prd[18] = 0x52;
    const wbg = Uint8Array.from([2, 2, 2, 2, 0x01, 0xfb, 0x01, 0x00, 0x01, 0x00, 0x01, 0x43]);
    const ttw = tiff([[271, 2, str('Minolta Co., Ltd.')], [272, 2, str('DiMAGE 5')], [274, 3, [6]]], false);
    const block = (tag: string, body: Uint8Array) => { const b = new Uint8Array(8 + body.length); b.set([0, ...str(tag).slice(0, 3)], 0); new DataView(b.buffer).setUint32(4, body.length, false); b.set(body, 8); return b; };
    const blocks = [block('PRD', prd), block('WBG', wbg), block('TTW', ttw)], head = new Uint8Array(8); head.set([0, 0x4d, 0x52, 0x4d], 0);
    const total = blocks.reduce((a, b) => a + b.length, 0); new DataView(head.buffer).setUint32(4, total, false);
    const data = be16(vals), file = new Uint8Array(8 + total + data.length); file.set(head, 0); let p = 8; for (const b of blocks) { file.set(b, p); p += b.length; } file.set(data, p);
    const r = readRaw(file, 'a.mrw');
    expect([r.width, r.height, r.orientation, r.model, r.white[0]]).toEqual([W, H, 6, 'DiMAGE 5', 4095]);
    expect([...r.data]).toEqual(vals);
    expect(r.asShotNeutral!.map((x) => +x.toFixed(4))).toEqual([+(256 / 507).toFixed(4), 1, +(256 / 323).toFixed(4)]);
    // Packed storage (0x59): 12-bit big-endian.
    const packed = packBe(vals, 12), f2 = new Uint8Array(8 + total + packed.length); f2.set(file.subarray(0, 8 + total), 0); f2.set(packed, 8 + total); f2[16 + 18] = 0x59; // the PRD block's storage method
    expect([...readRaw(f2, 'b.mrw').data]).toEqual(vals);
  });
  it('reads a Fujifilm RAF with a Bayer sensor: header records, the CFA TIFF, margins and white balance', () => {
    const rw = 12, rh = 6, rv = ramp(rw * rh, (i) => (i * 61) & 0xfff), data = packLe(rv, 12);
    // CFA section: a little-endian TIFF whose IFD 0xf000 points at the sensor description; the data follows at 0xf007.
    const sub: Entry[] = [[0xf001, 4, [rw]], [0xf002, 4, [rh]], [0xf003, 4, [12]], [0xf007, 4, [0x80000000]], [0xf008, 4, [data.length]], [0xf00a, 4, [257, 257, 257, 257]], [0xf00d, 4, [321, 526, 632]]];
    const cfaTiff = tiff([[0xf000, 13, [0]]], true, { subIfds: [sub], blobs: [data] });
    // Point 0xf000 at the sub IFD (the writer only links 330): patch the single entry's value.
    const dv = new DataView(cfaTiff.buffer); const ifd0 = dv.getUint32(4, true); dv.setUint32(ifd0 + 2 + 8, dv.getUint32(ifd0 + 2 + 8, true) || 0, true);
    // Find the sub IFD: it is the second IFD written, right after IFD0 (2 + 12 + 4 bytes).
    dv.setUint32(ifd0 + 2 + 8, ifd0 + 18, true);
    const hdrRecords = [[0x100, [rh >> 8, rh & 255, rw >> 8, rw & 255]], [0xc000, [8, 0, 0, 0, rh, 0, 0, 0]]] as [number, number[]][]; // output 8 × rh (little-endian u32s)
    const hdr = new Uint8Array(4 + hdrRecords.reduce((a, [, b]) => a + 4 + b.length, 0)); new DataView(hdr.buffer).setUint32(0, hdrRecords.length, false);
    let hp = 4; for (const [tag, body] of hdrRecords) { new DataView(hdr.buffer).setUint16(hp, tag, false); new DataView(hdr.buffer).setUint16(hp + 2, body.length, false); hdr.set(body, hp + 4); hp += 4 + body.length; }
    const file = new Uint8Array(160 + hdr.length + cfaTiff.length); file.set(str('FUJIFILMCCD-RAW 0201FF').slice(0, 22), 0); file.set(str('X-S1').slice(0, 4), 28);
    const fdv = new DataView(file.buffer); fdv.setUint32(92, 160, false); fdv.setUint32(96, hdr.length, false); fdv.setUint32(100, 160 + hdr.length, false); fdv.setUint32(104, cfaTiff.length, false);
    file.set(hdr, 160); file.set(cfaTiff, 160 + hdr.length);
    const r = readRaw(file, 'a.raf');
    expect([r.width, r.height, r.model, r.white[0]]).toEqual([rw, rh, 'X-S1', 4095]);
    expect([...r.data]).toEqual(rv);
    expect([...r.black]).toEqual([257, 257, 257, 257]);
    expect(r.crop).toEqual({ x: 2, y: 0, w: 8, h: rh });
    expect(r.asShotNeutral!.map((x) => +x.toFixed(3))).toEqual([+(321 / 526).toFixed(3), 1, +(321 / 632).toFixed(3)]);
    expect(rawSupport(file, 'a.raf').family).toBe('RAF');
  });
  it('reads a Panasonic RW2 header and refuses the raw formats it does not decode', () => {
    const data = le16(vals);
    const rw2 = tiff([[2, 3, [W]], [3, 3, [H]], [4, 3, [1]], [5, 3, [0]], [6, 3, [H - 1]], [7, 3, [W]], [9, 3, [2]], [0xa, 3, [12]], [0xb, 3, [1]], [0xe, 3, [4095]], [0x1c, 3, [127]], [0x1d, 3, [127]], [0x1e, 3, [127]], [0x24, 3, [487]], [0x25, 3, [264]], [0x26, 3, [523]], [0x2d, 3, [4]], [0x118, 4, [0x80000000]], [271, 2, str('Panasonic')], [272, 2, str('DMC-LX7')]], true, { magic: [0x55, 0], blobs: [data] });
    const r = readRaw(rw2, 'a.rw2');
    expect([r.width, r.height, r.cfa, r.white[0], r.crop]).toEqual([W, H, [1, 0, 2, 1], 4095, { x: 0, y: 1, w: W, h: H - 2 }]);
    expect([...r.black]).toEqual([142, 142, 142, 142]);
    expect([...r.data]).toEqual(vals);
    expect(r.asShotNeutral!.map((x) => +x.toFixed(4))).toEqual([+(264 / 487).toFixed(4), 1, +(264 / 523).toFixed(4)]);
    const newer = tiff([[2, 3, [W]], [3, 3, [H]], [0xb, 3, [34316]], [0x2d, 3, [6]], [0x118, 4, [0x80000000]]], true, { magic: [0x55, 0], blobs: [data] });
    expect(() => readRaw(newer, 'b.rw2')).toThrow(/raw format 6/);
    expect(rawSupport(newer, 'b.rwl')).toMatchObject({ ok: false, family: 'RWL', why: expect.stringMatching(/raw format 6/) }); // said before Develop RAW is offered, not after
  });
  it('develops a family file through the DNG pipeline with the generic matrix', () => {
    const d = packBe(vals, 12);
    const pef = tiff([[256, 4, [W]], [257, 4, [H]], [258, 3, [12]], [259, 3, [32773]], [262, 3, [32803]], [271, 2, str('PENTAX')], [273, 4, [0x80000000]], [277, 3, [1]], [279, 4, [d.length]], [33422, 1, [0, 1, 1, 2]]], false, { blobs: [d] });
    const r = readRaw(pef, 'a.pef');
    expect(r.colorMatrix1).toBe(GENERIC_COLOR_MATRIX);
    const out = develop(r, { wb: 'auto', demosaic: 'bilinear' });
    expect([out.raster.width, out.raster.height]).toEqual([W, H]);
    expect(out.temp).toBeGreaterThan(1600);
    expect(develop(pef, { wb: 'daylight' }).raster.width).toBe(W); // bytes go through readRaw too
  });
});

describe('RAW orientation from the file\'s own header', () => {
  it('reads IFD0 in TIFF-based files, Olympus and Panasonic headers included, the MRW and CR3 containers, Leaf backs and the preview', async () => {
    const { rawOrientation, leafRotation } = await import('../../src/codecs/rawpreview');
    const ifd0 = (o: number, le = true, magic?: number[]) => tiff([[256, 4, [8]], [257, 4, [6]], [274, 3, [o]]], le, magic ? { magic } : {});
    expect(rawOrientation(ifd0(6))).toBe(6); expect(rawOrientation(ifd0(8, false))).toBe(8);
    expect(rawOrientation(ifd0(3, true, [0x52, 0x4f]))).toBe(3);         // Olympus: II RO
    expect(rawOrientation(ifd0(6, true, [0x55, 0]))).toBe(6);            // Panasonic: II U
    expect(rawOrientation(ifd0(9))).toBe(1); expect(rawOrientation(tiff([[256, 4, [8]]], true))).toBe(1);   // out of range, absent
    // Minolta MRW: a TTW block holding a TIFF.
    const t = ifd0(8, false), mrw = new Uint8Array(16 + t.length), dv = new DataView(mrw.buffer);
    mrw.set([0, 0x4d, 0x52, 0x4d]); dv.setUint32(4, 8 + t.length); mrw.set([0, 0x54, 0x54, 0x57], 8); dv.setUint32(12, t.length); mrw.set(t, 16);
    expect(rawOrientation(mrw)).toBe(8);
    // Canon CR3: the CMT1 box holds IFD0.
    const cmt = ifd0(6), box = new Uint8Array(8 + cmt.length); new DataView(box.buffer).setUint32(0, box.length); box.set([0x43, 0x4d, 0x54, 0x31], 4); box.set(cmt, 8);
    const ftyp = Uint8Array.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x63, 0x72, 0x78, 0x20, 0, 0, 0, 1]), cr3 = new Uint8Array(ftyp.length + 24 + box.length); cr3.set(ftyp); cr3.set(box, ftyp.length + 24);
    expect(rawOrientation(cr3)).toBe(6);
    // A Leaf back: PKTS ImgProf_rotation_angle (degrees, as LibRaw reads it).
    const pkts = (deg: string) => { const b = new Uint8Array(52 + deg.length + 8), d = new DataView(b.buffer); b.set([0x50, 0x4b, 0x54, 0x53, 0, 0, 0, 1]); b.set([...'ImgProf_rotation_angle'].map((c) => c.charCodeAt(0)), 8); d.setUint32(48, deg.length); b.set([...deg].map((c) => c.charCodeAt(0)), 52); return b; };
    expect([leafRotation(pkts('90')), leafRotation(pkts('180')), leafRotation(pkts('270')), leafRotation(pkts('0')), leafRotation(pkts('-90'))]).toEqual([6, 3, 8, 0, 8]);
    // Otherwise the preview's own EXIF (Fujifilm RAF keeps it there).
    const exif = tiff([[274, 3, [6]]], false), app1 = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0, exif.length + 8, 0x45, 0x78, 0x69, 0x66, 0, 0, ...exif, 0xff, 0xd9]);
    const raf = new Uint8Array(100 + app1.length); raf.set([...'FUJIFILMCCD-RAW '].map((c) => c.charCodeAt(0))); raf.set(app1, 100);
    expect(rawOrientation(raf, [{ offset: 100, length: app1.length }])).toBe(6); expect(rawOrientation(raf, [])).toBe(1);
  });
});
