import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { readJpegCoefficients, writeJpegCoefficients, transformCoefficients, cropCoefficients, trimToGrid, isPerfect, toGrayscale, optimalTable, opForOrientation, losslessTransform, ZIGZAG, type JpegCoefficients } from '../../src/codecs/jpegLossless';
import { readExif } from '../../src/meta/exif';

/** Synthetic coefficients: 4:2:0 color (or gray) picture of the given size with a deterministic pattern. */
function synth(width: number, height: number, color = true, seed = 7): JpegCoefficients {
  const comps = color ? [{ id: 1, h: 2, v: 2, tq: 0 }, { id: 2, h: 1, v: 1, tq: 1 }, { id: 3, h: 1, v: 1, tq: 1 }] : [{ id: 1, h: 1, v: 1, tq: 0 }];
  const hmax = Math.max(...comps.map((c) => c.h)), vmax = Math.max(...comps.map((c) => c.v));
  const mpl = Math.ceil(width / (8 * hmax)), mpc = Math.ceil(height / (8 * vmax));
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s; };
  const qt = new Uint16Array(64).fill(2); qt[0] = 1;
  const f: JpegCoefficients = { width, height, precision: 8, progressive: false, arithmetic: false, components: [], qt: [qt, qt, null, null], segments: [], adobeTransform: null, restartInterval: 0, warnings: [], decodedUnits: 0, totalUnits: 0 };
  for (const c of comps) {
    const bpl = mpl * c.h, bpc = mpc * c.v;
    const coefs = new Int16Array(bpl * bpc * 64);
    for (let b = 0; b < bpl * bpc; b++) {
      coefs[b * 64] = (rnd() % 400) - 200;
      for (let k = 1; k < 64; k++) if (rnd() % 5 === 0) coefs[b * 64 + ZIGZAG[k]] = (rnd() % 60) - 30;
    }
    f.components.push({ ...c, td: 0, ta: 0, blocksPerLine: bpl, blocksPerColumn: bpc, coefs });
  }
  return f;
}
const clone = (f: JpegCoefficients): JpegCoefficients => ({ ...f, components: f.components.map((c) => ({ ...c, coefs: c.coefs.slice() })), segments: f.segments.map((s) => ({ ...s })) });
const same = (a: JpegCoefficients, b: JpegCoefficients) => a.width === b.width && a.height === b.height && a.components.length === b.components.length && a.components.every((c, i) => c.h === b.components[i].h && c.v === b.components[i].v && c.blocksPerLine === b.components[i].blocksPerLine && c.coefs.length === b.components[i].coefs.length && c.coefs.every((v, k) => v === b.components[i].coefs[k]));

describe('lossless JPEG', () => {
  it('writes and reads back the same quantized coefficients (color 4:2:0 and grayscale, odd sizes)', () => {
    for (const [w, h, color] of [[37, 21, true], [16, 16, true], [9, 70, false], [1, 1, true]] as [number, number, boolean][]) {
      const f = synth(w, h, color);
      const bytes = writeJpegCoefficients(f, { comment: 'test' });
      expect(bytes[0]).toBe(0xff); expect(bytes[1]).toBe(0xd8); expect(bytes[bytes.length - 1]).toBe(0xd9);
      const g = readJpegCoefficients(bytes);
      expect(g.width).toBe(w); expect(g.height).toBe(h);
      expect(g.warnings).toEqual([]);
      expect(g.segments.some((s) => s.marker === 0xfe)).toBe(true);
      // Padded blocks outside the picture are not written for single-component scans; compare the real grid.
      for (let i = 0; i < f.components.length; i++) {
        const a = f.components[i], b = g.components[i];
        const bpl = color ? a.blocksPerLine : Math.ceil(w / 8), bpc = color ? a.blocksPerColumn : Math.ceil(h / 8);
        for (let by = 0; by < bpc; by++) for (let bx = 0; bx < bpl; bx++) {
          const oa = (by * a.blocksPerLine + bx) * 64, ob = (by * b.blocksPerLine + bx) * 64;
          expect(Array.from(b.coefs.subarray(ob, ob + 64)), `${w}x${h} comp ${i} block ${bx},${by}`).toEqual(Array.from(a.coefs.subarray(oa, oa + 64)));
        }
      }
    }
  });
  it('transforms are reversible: flips twice, transpose twice, four quarter turns, and rot180 = flipH + flipV', () => {
    const f = synth(64, 48);
    for (const op of ['flipH', 'flipV', 'transpose'] as const) { const g = clone(f); transformCoefficients(g, op); expect(same(g, f), op).toBe(false); transformCoefficients(g, op); expect(same(g, f), op).toBe(true); }
    const r = clone(f); for (let i = 0; i < 4; i++) transformCoefficients(r, 'rot90'); expect(same(r, f)).toBe(true);
    const a = clone(f); transformCoefficients(a, 'rot180');
    const b = clone(f); transformCoefficients(b, 'flipH'); transformCoefficients(b, 'flipV');
    expect(same(a, b)).toBe(true);
    const c = clone(f); transformCoefficients(c, 'rot90'); transformCoefficients(c, 'rot270'); expect(same(c, f)).toBe(true);
    const t = clone(f); transformCoefficients(t, 'rot90'); expect([t.width, t.height]).toEqual([48, 64]); expect(t.components[0].h).toBe(2);
  });
  it('flips change coefficient signs the way the DCT requires', () => {
    const f = synth(16, 16, false);
    const c = f.components[0];
    c.coefs.fill(0);
    // Two blocks side by side; left block has a single horizontal-frequency coefficient (u = 1), right block a vertical one (v = 1).
    c.coefs[0 * 64 + 1] = 10; c.coefs[1 * 64 + 8] = 20;
    const g = clone(f); transformCoefficients(g, 'flipH');
    expect(g.components[0].coefs[0 * 64 + 8]).toBe(20); // the right block moved left, its v = 1 coefficient unchanged
    expect(g.components[0].coefs[1 * 64 + 1]).toBe(-10); // the left block moved right, its u = 1 coefficient negated
    const v = clone(f); transformCoefficients(v, 'flipV');
    expect(v.components[0].coefs[2 * 64 + 1]).toBe(10); // moved to the bottom row (blocksPerLine = 2)
    expect(v.components[0].coefs[3 * 64 + 8]).toBe(-20);
    const t = clone(f); transformCoefficients(t, 'transpose');
    expect(t.components[0].coefs[0 * 64 + 8]).toBe(10); // (v,u) = (0,1) becomes (1,0)
    expect(t.components[0].coefs[2 * 64 + 1]).toBe(20); // block (1,0) becomes (0,1)
  });
  it('knows which transforms are exact, and trimming makes all of them exact', () => {
    const f = synth(37, 21);
    expect(isPerfect(f, 'flipH')).toBe(false); expect(isPerfect(f, 'transpose')).toBe(true); expect(isPerfect(f, 'rot90')).toBe(false);
    expect(trimToGrid(f)).toEqual({ width: 32, height: 16 });
    for (const op of ['flipH', 'flipV', 'rot90', 'rot180', 'rot270', 'transverse'] as const) expect(isPerfect(f, op), op).toBe(true);
    const g = synth(48, 32);
    for (const op of ['flipH', 'flipV', 'rot90', 'rot180', 'rot270', 'transverse'] as const) expect(isPerfect(g, op), op).toBe(true);
  });
  it('an imperfect flip leaves the partial edge column in place', () => {
    const f = synth(40, 16); // 2 full MCUs (32 px) + a partial one
    const y = f.components[0];
    const edge = y.coefs.slice(4 * 64, 5 * 64); // block column 4 (x 32–39) in row 0
    const g = clone(f); transformCoefficients(g, 'flipH');
    expect(Array.from(g.components[0].coefs.subarray(4 * 64, 5 * 64))).toEqual(Array.from(edge));
    expect(Array.from(g.components[0].coefs.subarray(0, 64))).toEqual(Array.from(y.coefs.subarray(3 * 64, 4 * 64)).map((v, i) => (i & 1 ? 0 - v : v)));
  });
  it('crops at the block grid and keeps the picture bytes readable', () => {
    const f = synth(64, 64);
    const r = cropCoefficients(f, 20, 17, 30, 30);
    expect(r).toEqual({ x: 16, y: 16, width: 30, height: 30 });
    expect(f.components[0].blocksPerLine).toBe(4);
    const bytes = writeJpegCoefficients(f);
    const g = readJpegCoefficients(bytes);
    expect([g.width, g.height]).toEqual([30, 30]);
  });
  it('converts to grayscale by dropping the chroma components', () => {
    const f = synth(37, 21);
    toGrayscale(f);
    expect(f.components.length).toBe(1);
    expect([f.components[0].h, f.components[0].v, f.components[0].blocksPerLine]).toEqual([1, 1, 5]);
    const g = readJpegCoefficients(writeJpegCoefficients(f));
    expect(g.components.length).toBe(1);
    expect(g.width).toBe(37);
  });
  it('builds valid optimal Huffman tables (no code longer than 16 bits, every symbol present once)', () => {
    const freq = new Uint32Array(256);
    for (let i = 0; i < 256; i++) freq[i] = 1 << (i % 24); // very skewed
    const t = optimalTable(freq);
    expect(t.vals.length).toBe(256);
    expect(new Set(t.vals).size).toBe(256);
    expect(Array.from(t.bits).reduce((s, v) => s + v, 0)).toBe(256);
    let code = 0; for (let len = 1; len <= 16; len++) { code += t.bits[len - 1]; expect(code, `prefix-free at ${len}`).toBeLessThanOrEqual(1 << len); code <<= 1; }
    expect(optimalTable(new Uint32Array(256)).vals.length).toBe(0);
  });
  it('maps EXIF orientations to operations and resets the tag through losslessTransform', () => {
    expect(opForOrientation(6)).toBe('rot90'); expect(opForOrientation(1)).toBe('none'); expect(opForOrientation(7)).toBe('transverse');
    const f = synth(32, 16);
    const le16 = (v: number) => [v & 255, v >> 8], le32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
    const exif = Uint8Array.from([0x49, 0x49, 42, 0, 8, 0, 0, 0, ...le16(1), ...le16(0x112), ...le16(3), ...le32(1), ...le16(6), 0, 0, ...le32(0)]);
    f.segments.push({ marker: 0xe1, data: Uint8Array.from([0x45, 0x78, 0x69, 0x66, 0, 0, ...exif]) });
    const bytes = writeJpegCoefficients(f);
    expect(readExif(bytes)?.orientation).toBe(6);
    const r = losslessTransform(bytes, 'rot90', { orientation: 1 });
    expect(readExif(r.bytes)?.orientation).toBe(1);
    expect([r.width, r.height]).toEqual([16, 32]);
    expect(r.perfect).toBe(true);
    expect(losslessTransform(bytes, 'none', { stripMetadata: true }).bytes.length).toBeLessThan(bytes.length);
    expect(readExif(losslessTransform(bytes, 'none', { stripMetadata: true }).bytes)).toBeNull();
  });
  it('reports damaged scan data instead of failing', () => {
    const f = synth(64, 64);
    const bytes = writeJpegCoefficients(f);
    const cut = bytes.subarray(0, bytes.length - Math.floor(bytes.length / 3));
    const g = readJpegCoefficients(cut);
    expect(g.warnings.length).toBeGreaterThan(0);
    expect(g.width).toBe(64);
  });
});

describe('what follows the picture in the file', () => {
  const base = () => new Uint8Array(readFileSync('tests/fixtures/jpeg/base-420.jpg'));
  const join = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
  const ends = (hay: Uint8Array, tail: Uint8Array) => hay.length >= tail.length && tail.every((v, i) => hay[hay.length - tail.length + i] === v);
  it('keeps a motion photo\'s video and says so', () => {
    const video = Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, ...Array(4000).fill(7)]);
    const r = losslessTransform(join(base(), video), 'rot90');
    expect(ends(r.bytes, video)).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/4 KB stored after the picture .* were kept as they were/);
    const plain = losslessTransform(base(), 'rot90');
    expect(r.bytes.length).toBe(plain.bytes.length + video.length); expect(plain.warnings).toEqual([]);
    expect(readJpegCoefficients(r.bytes).width).toBe(plain.width);                           // the picture itself is the same turned picture
  });
  it('leaves out a second picture (a gain map) with its index, and says so', () => {
    const b = base(), second = b.slice();
    // An MPF index segment after SOI, as an HDR photo carries for its gain map.
    const mpf = Uint8Array.from([0xff, 0xe2, 0, 18, 0x4d, 0x50, 0x46, 0, 0x49, 0x49, 42, 0, 8, 0, 0, 0, 0, 0, 0, 0]);
    const hdr = join(b.subarray(0, 2), mpf, b.subarray(2), second);
    const r = losslessTransform(hdr, 'flipH');
    expect(r.warnings.join(' ')).toMatch(/A second picture stored after the main one .* was left out/);
    expect(r.bytes.length).toBe(losslessTransform(b, 'flipH').bytes.length);                 // no gain map, no index
    let has = false; for (let i = 0; i + 4 < r.bytes.length; i++) if (r.bytes[i] === 0x4d && r.bytes[i + 1] === 0x50 && r.bytes[i + 2] === 0x46 && r.bytes[i + 3] === 0) has = true;
    expect(has).toBe(false);
    // Padding after the end marker is neither kept nor mentioned.
    expect(losslessTransform(join(b, new Uint8Array(64)), 'none').warnings).toEqual([]);
  });
});
