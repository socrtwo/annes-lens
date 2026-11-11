import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeTiff } from '../../src/codecs/tiff';
import { decodePngTolerant } from '../../src/codecs/png';
import { decodeCcitt } from '../../src/codecs/ccitt';

const fx = (n: string) => new Uint8Array(readFileSync(`tests/fixtures/tiff/${n}`));
const png = (n: string) => decodePngTolerant(fx(n)).pages[0].frames[0].raster;
async function compare(tif: string, ref: string) {
  const d = await decodeTiff(fx(tif)), page = d.pages[0], r = page.frames[0].raster, e = png(ref);
  expect([r.width, r.height], tif).toEqual([e.width, e.height]);
  let max = 0, sum = 0;
  for (let i = 0; i < r.data.length; i += 4) for (let c = 0; c < 3; c++) { const v = Math.abs(r.data[i + c] - e.data[i + c]); max = Math.max(max, v); sum += v; }
  return { max, mean: sum / (r.data.length / 4 * 3), notes: page.notes.join(', '), warnings: d.warnings };
}

describe('TIFF: CCITT fax compression (against libtiff)', () => {
  for (const n of ['rle', 'g3', 'g3-2d', 'g4', 'g4-lsb']) it(`fax-${n}`, async () => {
    const r = await compare(`fax-${n}.tif`, 'fax.png');
    expect(r.max, r.notes).toBe(0);
  });
  it('runs past 2560 pixels (extended make-up codes)', async () => {
    for (const n of ['g3', 'g4']) expect((await compare(`fax-wide-${n}.tif`, 'fax-wide.png')).max, n).toBe(0);
  });
  it('rejects broken data instead of guessing', () => {
    expect(() => decodeCcitt(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1, 0xff, 0xff]), 8, 2, { compression: 4 })).toThrow(/CCITT/);
  });
});

describe('TIFF: planar, floating-point, signed and CMYK samples', () => {
  it('planar RGB, 8 and 16 bits', async () => {
    for (const n of ['planar-rgb.tif', 'planar-rgb16.tif']) { const r = await compare(n, 'planar-rgb.png'); expect(r.max, n).toBe(0); expect(r.notes).toMatch(/planar/); }
  });
  it('floats (0…1), half floats, the floating-point predictor, and signed heights stretched to their range', async () => {
    for (const [t, p, tol] of [['float-gray.tif', 'float-gray.png', 1], ['half-gray.tif', 'half-gray.png', 1], ['float-pred.tif', 'float-pred.png', 1], ['dem-int16.tif', 'dem-int16.png', 1]] as const) {
      const r = await compare(t, p); expect(r.max, `${t} ${r.notes}`).toBeLessThanOrEqual(tol);
    }
    expect((await compare('dem-int16.tif', 'dem-int16.png')).notes).toMatch(/16-bit signed integers, -120…2300 shown as black…white/);
    expect((await compare('float-pred.tif', 'float-pred.png')).notes).toMatch(/floating-point predictor/);
  });
  it('CMYK through the embedded profile matches LittleCMS; without one, the simple conversion', async () => {
    for (const n of ['cmyk-icc.tif', 'cmyk16-icc.tif']) { const r = await compare(n, 'cmyk-icc.png'); expect(r.max, `${n} mean ${r.mean}`).toBeLessThanOrEqual(3); expect(r.mean).toBeLessThan(0.8); expect(r.notes).toMatch(/CMYK through the embedded profile/); }
    const plain = await compare('cmyk-plain.tif', 'cmyk-plain.png'); expect(plain.max).toBe(0); expect(plain.notes).toMatch(/no profile/);
  });
});

describe('TIFF: ZSTD, LZMA and L*a*b* (tifffile + imagecodecs; LittleCMS for Lab)', () => {
  it('ZSTD (with the horizontal predictor, and 16-bit) and LZMA decode exactly', async () => {
    for (const n of ['zstd-rgb.tif', 'zstd-rgb16.tif', 'lzma-rgb.tif']) { const r = await compare(n, 'planar-rgb.png'); expect(r.max, `${n} ${r.notes}`).toBe(0); }
    expect((await compare('zstd-rgb.tif', 'planar-rgb.png')).notes).toMatch(/ZSTD/);
  });
  it('CIELab and ICCLab, 8 and 16 bits, come back to the sRGB picture they were made from', async () => {
    // 8-bit L*a*b* rounds a* and b* to whole units: in a saturated green whose red is 0, one unit of a* is
    // 12 levels of red (the worst pixel here). 16 bits leave only the conversion, within one level.
    for (const [n, tol, mean] of [['lab-cie.tif', 12, 0.6], ['lab-icc.tif', 12, 0.6], ['lab-icc16.tif', 1, 0.01]] as const) { const r = await compare(n, 'planar-rgb.png'); expect(r.max, `${n} mean ${r.mean}`).toBeLessThanOrEqual(tol); expect(r.mean).toBeLessThan(mean); }
  });
});

describe('TIFF: the horizontal predictor (files written with tifffile)', () => {
  it('16-bit samples in either byte order', async () => {
    for (const n of ['pred-le16.tif', 'pred-be16.tif']) { const r = await compare(n, 'pred.png'); expect(r.max, n).toBe(0); expect(r.warnings, n).toEqual([]); }
  });
  it('32-bit samples in either byte order give the picture of the same data stored without the predictor', async () => {
    const plain = (await decodeTiff(fx('nopred-le32.tif'))).pages[0].frames[0].raster;
    expect(new Set(plain.data.filter((_, i) => i % 4 === 0)).size).toBeGreaterThan(100);            // a real picture, not one flat tone
    for (const n of ['pred-le32.tif', 'pred-be32.tif']) {
      const r = (await decodeTiff(fx(n))).pages[0].frames[0].raster;
      expect([r.width, r.height], n).toEqual([plain.width, plain.height]);
      let diff = 0; for (let i = 0; i < r.data.length; i++) if (r.data[i] !== plain.data[i]) diff++;
      expect(diff, n).toBe(0);
    }
  });
  it('uncompressed data with a predictor is decoded without changing the file\'s own bytes', async () => {
    // 4 × 2 gray, 8-bit, uncompressed, Predictor 2: stored differences 10,+1,+1,+1 / 200,-50,-50,-50.
    const le16 = (v: number) => [v & 255, v >> 8], le32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
    const tags: [number, number, number][] = [[256, 3, 4], [257, 3, 2], [258, 3, 8], [259, 3, 1], [262, 3, 1], [273, 4, 0], [277, 3, 1], [278, 3, 2], [279, 4, 8], [317, 3, 2]];
    const dataAt = 8 + 2 + tags.length * 12 + 4;
    const file = Uint8Array.from([0x49, 0x49, 42, 0, 8, 0, 0, 0, ...le16(tags.length), ...tags.flatMap(([t, ty, v]) => [...le16(t), ...le16(ty), ...le32(1), ...le32(t === 273 ? dataAt : v)]), ...le32(0), 10, 1, 1, 1, 200, 206, 206, 206]);
    const before = file.slice();
    const r = (await decodeTiff(file)).pages[0].frames[0].raster;
    expect([...r.data.filter((_, i) => i % 4 === 0)]).toEqual([10, 11, 12, 13, 200, 150, 100, 50]);
    expect([...file]).toEqual([...before]);                                                   // decoding twice gives the same picture
    expect([...(await decodeTiff(file)).pages[0].frames[0].raster.data.filter((_, i) => i % 4 === 0)]).toEqual([10, 11, 12, 13, 200, 150, 100, 50]);
  });
});
