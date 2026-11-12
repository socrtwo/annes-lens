import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeFits, fitsData, fitsHdus, isFits, fitsCards, fitsPageHdus } from '../../src/codecs/fits';
import { splitValue } from '../../src/commands/scientific';
import { sniff } from '../../src/codecs/registry';

const DIR = 'tests/fixtures/fits/';
const fx = (n: string) => new Uint8Array(readFileSync(DIR + n));
const expected: Record<string, any> = JSON.parse(readFileSync(DIR + 'expected.json', 'utf8'));
const at = (r: { width: number; data: Uint8ClampedArray }, x: number, y: number) => Array.from(r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4));

describe('FITS (files written from the standard with numpy)', () => {
  it('is recognized, also gzipped by name', () => {
    expect(isFits(fx('int16-bzero.fits'))).toBe(true);
    expect(isFits(fx('int16-bzero.fits.gz'))).toBe(false);
    expect(sniff(fx('float32-star.fits'), 'x')?.id).toBe('fits');
    expect(sniff(fx('int16-bzero.fits.gz'), 'sky.fits.gz')?.id).toBe('fits');
    expect(sniff(fx('int16-bzero.fits.gz'), 'sky.svgz')?.id).toBe('fits'); // what the stream holds wins over the name (W15)
  });
  for (const [name, e] of Object.entries(expected)) {
    it(`${name}: HDUs, planes and values (BZERO/BSCALE applied)`, () => {
      const { planes, hdus } = fitsData(fx(name));
      expect(hdus.length).toBe(e.hdus);
      expect(planes.map((p) => [p.hdu, p.width, p.height])).toEqual(e.planes);
      for (const [y, x, v] of e.samples) { const got = planes[0].values[y * planes[0].width + x]; if (v === null) expect(got).toBeNaN(); else expect(got).toBeCloseTo(v, 6); }
      if (e.plane2) { const pl = planes[planes.length - 1]; for (const [y, x, v] of e.plane2) expect(pl.values[y * pl.width + x]).toBeCloseTo(v, 6); }
      if (e.blank) { const [z, y, x] = e.blank; expect(planes[z].values[y * planes[z].width + x]).toBeNaN(); expect(planes[z].blank![y * planes[z].width + x]).toBe(1); }
    });
  }
  it('shows the first stored row at the bottom, stretched between the 0.5th and 99.5th percentiles', () => {
    const d = decodeFits(fx('int16-bzero.fits'));
    const r = d.pages[0].frames[0].raster;
    expect([r.width, r.height]).toEqual([30, 20]);
    expect(at(r, 0, 19)).toEqual([0, 0, 0, 255]); // stored row 0, value 0
    expect(at(r, 29, 0)).toEqual([255, 255, 255, 255]); // the brightest, 38290
    expect(at(r, 0, 9)[0]).toBeGreaterThan(at(r, 0, 10)[0]); // brighter upwards
    expect(d.pages[0].notes[1]).toMatch(/^shown stretched linearly from \d+ to \d+ ADU \(the 0.5th and 99.5th percentiles\); the first stored row is at the bottom$/);
    expect(d.info.object).toBe('Gradient field');
    expect(d.info.telescope).toBe("Anne's 8-inch");
    expect(d.info['exposure (s)']).toBe('30.0');
    expect(d.info.comments).toBe('A test picture written by scripts/gen-fits-fixtures.py');
    expect(d.info.HDUs).toBe('1');
    const gz = decodeFits(fx('int16-bzero.fits.gz'), 'sky.fits.gz');
    expect(gz.pages[0].frames[0].raster.data).toEqual(r.data);
  });
  it('a float image: NaN pixels are transparent and the star saturates while the sky stays dark', () => {
    const d = decodeFits(fx('float32-star.fits'));
    const r = d.pages[0].frames[0].raster;
    expect(d.pages[0].hasAlpha).toBe(true);
    expect(at(r, 4, 39 - 4)[3]).toBe(0); // stored row 4, column 4 is NaN
    expect(at(r, 30, 39 - 12)).toEqual([255, 255, 255, 255]); // the star's peak
    expect(at(r, 2, 39 - 30)[0]).toBeLessThan(20); // sky
    expect(d.pages[0].notes[0]).toBe('FITS primary image, 32-bit floating-point');
    expect(d.pages[0].bitDepth).toBe(32);
  });
  it('a cube becomes pages; extensions become pages (the table is skipped); BLANK pixels are transparent', () => {
    const c = decodeFits(fx('cube-int64.fits'));
    expect(c.pages.length).toBe(3);
    expect(c.pages[1].notes[0]).toBe('FITS primary image, plane 2 of 3, 64-bit integer (BZERO/BSCALE applied)');
    expect(c.pages[1].notes).toContain('undefined (BLANK) pixels are transparent');
    expect(at(c.pages[1].frames[0].raster, 3, 11 - 2)[3]).toBe(0);
    expect(c.pages[0].hasAlpha).toBe(false);
    const x = decodeFits(fx('extensions.fits'));
    expect(x.pages.length).toBe(2);
    expect(x.pages[0].notes[0]).toBe('FITS image extension 1 "SCI", 8-bit integer');
    expect(x.pages[1].notes[0]).toBe('FITS image extension 3 "ERR", 64-bit floating-point');
    expect(x.pages[1].notes[1]).toContain(' e- ');
    expect(x.info.HDUs).toBe('4');
    expect(x.info.origin).toBe('fixture');
    expect(fitsHdus(fx('extensions.fits')).map((h) => h.kind)).toEqual(['empty', 'image', 'table', 'image']);
  });
  describe('tile-compressed images (written by astropy; the values astropy reads back)', () => {
    const tiled: Record<string, { shape: number[]; compression: string; zbitpix: number; tiles: number[]; quantiz: string | null; lossy: boolean }> = JSON.parse(readFileSync(DIR + 'tiled.json', 'utf8'));
    for (const [n, c] of Object.entries(tiled)) {
      it(`${n}: ${c.compression}, ZBITPIX ${c.zbitpix}, tiles ${c.tiles.join(' × ')}${c.quantiz ? `, ${c.quantiz}` : ''}`, () => {
        const { planes, hdus, warnings } = fitsData(fx(n));
        expect(warnings).toEqual([]);
        expect(hdus[1].kind).toBe('compressed');
        const exp = new Float64Array(new Uint8Array(readFileSync(DIR + n.replace('.fits', '.bin'))).buffer);
        const [w, h] = c.shape.length === 3 ? [c.shape[2], c.shape[1]] : [c.shape[1], c.shape[0]];
        expect(planes.map((p) => [p.width, p.height])).toEqual(new Array(c.shape.length === 3 ? c.shape[0] : 1).fill([w, h]));
        let k = 0, bad = 0;
        for (const p of planes) for (let i = 0; i < p.values.length; i++, k++) { const a = p.values[i], b = exp[k]; if (!((a !== a && b !== b) || Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)))) bad++; }
        expect(k).toBe(exp.length);
        expect(bad).toBe(0);
      });
    }
    it('shows them like any other image, with the compression in the notes and details; nulls transparent', () => {
      const d = decodeFits(fx('rice-f32-dither1.fits'));
      expect(d.pages[0].notes[0]).toBe('FITS image extension 1 "COMPRESSED_IMAGE", 32-bit floating-point, RICE_1 tiles (quantized with dither)');
      expect(d.info.compression).toBe('RICE_1 tiles of 100 × 1, SUBTRACTIVE_DITHER_1');
      expect(d.pages[0].hasAlpha).toBe(true); // the NaN block
      expect(at(d.pages[0].frames[0].raster, 12, 59 - 6)[3]).toBe(0);
      const b = decodeFits(fx('rice-i16-blank.fits'));
      expect(b.pages[0].notes).toContain('undefined (BLANK) pixels are transparent');
      expect(at(b.pages[0].frames[0].raster, 4, 59 - 4)[3]).toBe(0);
      expect(at(b.pages[0].frames[0].raster, 40, 20)[3]).toBe(255);
      const c = decodeFits(fx('rice-i32-cube.fits'));
      expect(c.pages.length).toBe(3);
      expect(c.pages[2].notes[0]).toBe('FITS image extension 1 "COMPRESSED_IMAGE", plane 3 of 3, 32-bit integer, RICE_1 tiles');
      expect(decodeFits(fx('hcomp-i32-lossy.fits')).info.compression).toBe('HCOMPRESS_1 tiles of 64 × 16');
    });
  });
  it('refuses files without an image', () => {
    const hdr = fx('extensions.fits').subarray(0, 2880);
    expect(() => decodeFits(hdr)).toThrow(/holds no image/);
    expect(() => decodeFits(new Uint8Array(3000))).toThrow(/not a FITS file/);
  });
  it('FITS Stretch: the mapping and its limits', () => {
    const lin = decodeFits(fx('extensions.fits')), g = (d: typeof lin, i: number) => d.pages[0].frames[0].raster.data[i * 4];
    const log = decodeFits(fx('extensions.fits'), 'extensions.fits', { mode: 'log' }), sq = decodeFits(fx('extensions.fits'), 'extensions.fits', { mode: 'sqrt' }), sqr = decodeFits(fx('extensions.fits'), 'extensions.fits', { mode: 'square' }), as = decodeFits(fx('extensions.fits'), 'extensions.fits', { mode: 'asinh' });
    let brighterLog = 0, brighterSqrt = 0, darkerSquare = 0, n = 0;
    for (let i = 0; i < lin.pages[0].width * lin.pages[0].height; i++) { const l = g(lin, i); if (l === 0 || l === 255) continue; n++; if (g(log, i) > l) brighterLog++; if (g(sq, i) > l) brighterSqrt++; if (g(sqr, i) < l) darkerSquare++; expect(g(as, i)).toBeGreaterThanOrEqual(l); }
    expect(n).toBeGreaterThan(0); expect(brighterLog).toBe(n); expect(brighterSqrt).toBe(n); expect(darkerSquare).toBe(n);
    expect(log.pages[0].notes.some((x) => /^shown stretched logarithmically from .* \(the 0\.5th and 99\.5th percentiles\)/.test(x))).toBe(true);
    const pct = decodeFits(fx('extensions.fits'), 'extensions.fits', { percentiles: [10, 90] });
    expect(pct.pages[0].notes.some((x) => /\(the 10th and 90th percentiles\)/.test(x))).toBe(true);
    let clipped = 0; for (let i = 0; i < pct.pages[0].width * pct.pages[0].height; i++) { const v = g(pct, i); if (v === 0 || v === 255) clipped++; }
    expect(clipped).toBeGreaterThan(0);
    const fixed = decodeFits(fx('extensions.fits'), 'extensions.fits', { lo: 0, hi: 1e9 });
    expect(fixed.pages[0].notes.some((x) => /from 0 to 1\.000e\+9 .*\(FITS Stretch limits\)/.test(x))).toBe(true);
    expect(Math.max(...Array.from({ length: fixed.pages[0].width * fixed.pages[0].height }, (_, i) => g(fixed, i)))).toBeLessThan(3);
  });
  it('FITS Header: the cards of every HDU, the HDU of each page, values split from comments', () => {
    const u8 = fx('extensions.fits'), hdus = fitsHdus(u8);
    expect(hdus.length).toBeGreaterThan(1);
    const c0 = fitsCards(u8, 0), c1 = fitsCards(u8, 1);
    expect(c0[0]).toMatch(/^SIMPLE  =\s+T/); expect(c0.at(-1)).toBe('END');
    expect(c1[0]).toMatch(/^XTENSION= 'IMAGE   '/); expect(c1.at(-1)).toBe('END');
    expect(c1.length).toBe(hdus[1].cards.size + hdus[1].comments.length + 1);
    expect(fitsPageHdus(u8)).toEqual(decodeFits(u8).pages.map((_, i) => [1, 2][i] ?? 0).slice(0, decodeFits(u8).pages.length).map((_, i) => fitsPageHdus(u8)[i]));
    expect(fitsPageHdus(u8).length).toBe(decodeFits(u8).pages.length);
    const gz = fx('int16-bzero.fits.gz');
    expect(fitsCards(gz, 0, 'int16-bzero.fits.gz')[0]).toMatch(/^SIMPLE/);
    expect(splitValue("'string / not a comment' / the comment")).toEqual(["'string / not a comment'", 'the comment']);
    expect(splitValue('  12.5 / a value')).toEqual(['12.5', 'a value']);
    expect(splitValue("'it''s'")).toEqual(["'it''s'", '']);
  });
});
