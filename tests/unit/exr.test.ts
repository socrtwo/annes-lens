import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { setOpenJph } from '../../src/codecs/openjph';
import { readFileSync } from 'node:fs';
import { decodeExr, exrChannels, isExr } from '../../src/codecs/exr';
import { toHalf } from '../../src/codecs/dwa';
import { decodePngTolerant } from '../../src/codecs/png';

const fx = (n: string) => new Uint8Array(readFileSync(`tests/fixtures/exr/${n}`));
function compare(exr: string, png: string, page = 0) {
  const d = decodeExr(fx(exr)), p = d.pages[page], r = p.frames[0].raster, e = decodePngTolerant(fx(png)).pages[0].frames[0].raster;
  expect([r.width, r.height], exr).toEqual([e.width, e.height]);
  let max = 0;
  for (let i = 0; i < r.data.length; i += 4) for (let c = 0; c < (p.hasAlpha ? 4 : 3); c++) max = Math.max(max, Math.abs(r.data[i + c] - e.data[i + c]));
  return { max, notes: p.notes.join(' | '), pages: d.pages.length, warnings: d.warnings };
}

describe('OpenEXR (written and decoded by the OpenEXR library)', () => {
  for (const c of ['none', 'rle', 'zips', 'zip', 'piz', 'pxr24', 'b44', 'b44a']) it(`half, ${c}`, () => {
    expect(isExr(fx(`half-${c}.exr`))).toBe(true);
    const r = compare(`half-${c}.exr`, `half-${c}.png`); expect(r.max, r.notes).toBeLessThanOrEqual(1);
  });
  for (const c of ['zip', 'piz', 'pxr24']) it(`float, ${c}`, () => { const r = compare(`float-${c}.exr`, `float-${c}.png`); expect(r.max, r.notes).toBeLessThanOrEqual(1); });
  it('premultiplied RGBA, luminance only, layers', () => {
    const a = compare('rgba-piz.exr', 'rgba-piz.png'); expect(a.max, a.notes).toBeLessThanOrEqual(1);
    const y = compare('gray-y.exr', 'gray-y.png'); expect(y.max).toBeLessThanOrEqual(1); expect(y.notes).toMatch(/luminance/);
    const l = compare('layers.exr', 'layers.png'); expect(l.max).toBeLessThanOrEqual(1); expect(l.notes).toMatch(/layer diffuse/);
  });
  it('tiled (16 and 32 pixel tiles, partial ones at the edges)', () => {
    for (const n of ['tiled-zip', 'tiled-piz']) { const r = compare(`${n}.exr`, `${n}.png`); expect(r.max, r.notes).toBeLessThanOrEqual(1); expect(r.notes).toMatch(/tiled/); }
  });
  it('multi-part: each part a page', () => {
    const a = compare('multipart.exr', 'multipart-1.png', 0), b = compare('multipart.exr', 'multipart-2.png', 1);
    expect([a.pages, a.max <= 1, b.max <= 1]).toEqual([2, true, true]);
    expect(b.notes).toMatch(/part 2 \(luma\)/);
  });
});

describe('OpenEXR ZSTD (OpenEXR 3.4+; written and decoded by the OpenEXR library)', () => {
  it('half RGB, one scanline per block', () => { const r = compare('zstd-half.exr', 'zstd-half.png'); expect(r.max, r.notes).toBeLessThanOrEqual(1); expect(r.notes).toMatch(/ZSTD/); });
  it('float and uint channels beside half ones: both segments, exact values', () => {
    const r = compare('zstd-mixed.exr', 'zstd-mixed.png'); expect(r.max).toBeLessThanOrEqual(1);
    const c = exrChannels(fx('zstd-mixed.exr')), Z = c.channels.get('Z')!, id = c.channels.get('id')!;
    for (const [x, y] of [[0, 0], [69, 49], [13, 27]]) { expect(Z[y * 70 + x]).toBe(x * 1.5 + y); expect(id[y * 70 + x]).toBe(x * y); }
  });
  it('tiled', () => { const r = compare('zstd-tiled.exr', 'zstd-tiled.png'); expect(r.max).toBeLessThanOrEqual(1); expect(r.notes).toMatch(/tiled/); });
});

describe('OpenEXR HTJ2K (OpenEXR 3.4+, lossless; OpenJPH)', () => {
  beforeAll(async () => {
    const factory = createRequire(import.meta.url)(process.cwd() + '/node_modules/@cornerstonejs/codec-openjph/dist/openjphjs.js'); // by file (package exports hide it)
    setOpenJph(await factory({ wasmBinary: readFileSync('node_modules/@cornerstonejs/codec-openjph/dist/openjphjs.wasm') }));
  });
  it('256- and 32-line blocks of half RGB, exact', () => {
    for (const n of ['htj2k256', 'htj2k32']) { const r = compare(`${n}.exr`, `${n}.png`); expect(r.max, n).toBe(0); expect(r.notes, n).toMatch(/HTJ2K/); }
  });
  it('premultiplied RGBA', () => { const r = compare('htj2k-rgba.exr', 'htj2k-rgba.png'); expect(r.max).toBeLessThanOrEqual(1); });
  it('the half values are the library\'s bit for bit', () => {
    const z = exrChannels(fx('zstd-half.exr')), h = exrChannels(fx('htj2k256.exr'));
    for (const k of ['R', 'G', 'B']) expect(h.channels.get(k)).toEqual(z.channels.get(k));
  });
  it('a FLOAT channel is refused with a message', () => {
    expect(() => decodeExr(fx('htj2k-float.exr'))).toThrow(/HTJ2K blocks with FLOAT or UINT channels/);
  });
});

describe('OpenEXR DWAA and DWAB (lossy DCT; the library\'s own decoding as the reference)', () => {
  for (const [n, what] of [['dwaa', 'DWAA, half RGB'], ['dwab', 'DWAB, half RGB'], ['dwaa-float', 'FLOAT RGB'], ['dwaa-y', 'a lone Y channel'],
    ['dwaa-rgba', 'alpha stored with RLE'], ['dwaa-layers', 'a layer, with a FLOAT depth channel stored as is'], ['dwaa-tiled', '32 × 32 tiles'],
    ['dwab-tall', 'three 256-line blocks'], ['dwaa-linear', 'a perceptually linear channel (no curve)']]) it(what, () => {
    const r = compare(`${n}.exr`, `${n}.png`); expect(r.max, r.notes).toBeLessThanOrEqual(1); expect(r.warnings).toEqual([]);
    expect(r.notes).toMatch(n.startsWith('dwab') ? /DWAB/ : /DWAA/);
  });
  it('the values match the library\'s to a few half-float steps', () => {
    for (const [n, keys] of [['dwaa', ['B', 'G', 'R']], ['dwaa-y', ['Y']]] as const) {
      const b = fx(`${n}.f16`), ref = new Uint16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
      const c = exrChannels(fx(`${n}.exr`));
      let i = 0, differ = 0, max = 0;
      for (const k of keys) for (const v of c.channels.get(k)!) { const d = Math.abs(toHalf(v) - ref[i++]); if (d) differ++; max = Math.max(max, d); }
      expect(i).toBe(ref.length);
      // OpenEXR's SIMD inverse DCT adds in a different order from its scalar one; a handful of values land a step or two apart.
      expect(differ / i, n).toBeLessThan(0.001); expect(max, n).toBeLessThanOrEqual(4);
    }
  });
  it('the depth channel of the layered file is kept exactly', () => {
    const c = exrChannels(fx('dwaa-layers.exr')), z = c.channels.get('depth.Z')!;
    expect([z[0], z[69], z[70 * 49 + 13]]).toEqual([0, 69, 13]);
  });
  it('damaged DWA data is reported', () => {
    // The first block's header: version 2, then sizes; claim far more AC data than the block holds.
    const u = fx('dwaa.exr').slice(), sig = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const at = u.findIndex((_, i) => sig.every((b, k) => u[i + k] === b));
    expect(at).toBeGreaterThan(300);
    new DataView(u.buffer).setUint32(at + 24, 0x7fffffff, true);
    // The damaged block is left black and reported; the picture's other blocks still show (R17).
    const r = decodeExr(u);
    expect(r.warnings.join(' ')).toMatch(/chunks are damaged or missing and are left black \(DWA data is damaged/);
    expect(r.pages.length).toBe(1);
  });
});

describe('damaged chunks (R17)', () => {
  it('a damaged OpenEXR chunk is left black and reported; the rest of the picture decodes', () => {
    const good = new Uint8Array(readFileSync('tests/fixtures/exr/float-zip.exr'));
    const ref = decodeExr(good).pages[0];
    const bad = good.slice(); for (let i = Math.floor(bad.length * 0.7); i < bad.length; i++) bad[i] = (i * 37) & 255;
    const r = decodeExr(bad), pg = r.pages[0];
    expect([pg.width, pg.height]).toEqual([ref.width, ref.height]);
    expect(r.warnings.join(' ')).toMatch(/chunks are damaged or missing and are left black/);
    const a = (pg.frames[0] as any).raster.data, b = (ref.frames[0] as any).raster.data;
    expect([...a.subarray(0, ref.width * 4)]).toEqual([...b.subarray(0, ref.width * 4)]); // the first lines are intact
  });
});
