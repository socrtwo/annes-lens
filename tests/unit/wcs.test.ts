import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fitsHdus, decodeFits } from '../../src/codecs/fits';
import { parseWcs, pixelToWorld, angularSeparation, formatWorld, formatRa, formatDec, formatAngle, pixelScale } from '../../src/codecs/wcs';
import { readout } from '../../src/picture/measure';

const DIR = 'tests/fixtures/fits/';
const fx = (n: string) => new Uint8Array(readFileSync(DIR + n));
const cases: Record<string, { note: string; pixels: number[][]; world: (number | null)[][]; separation01: number | null; celestial: boolean }> = JSON.parse(readFileSync(DIR + 'wcs.json', 'utf8'));
const wcsOf = (n: string) => { const h = fitsHdus(fx(n)).find((x) => x.kind === 'image' || x.kind === 'compressed')!; return { w: parseWcs(h.cards, h.axes[0], h.axes[1])!, W: h.axes[0], H: h.axes[1] }; };

describe('FITS world coordinates (files written with astropy; wcslib\'s positions)', () => {
  for (const [n, c] of Object.entries(cases)) {
    it(`${n}: ${c.note}`, () => {
      const { w, H } = wcsOf(n);
      expect(w).toBeTruthy();
      c.pixels.forEach(([px, py], i) => {
        const got = pixelToWorld(w, px + 0.5, H - py - 0.5); // astropy's 0-based pixel centers → the app's y-down coordinates
        if (c.world[i][0] === null) { expect(got, `pixel ${i} is outside the projection`).toBeNull(); return; }
        expect(got, `pixel ${i}`).toBeTruthy();
        if (n === 'wcs-linear.fits') { expect(got![0]).toBeCloseTo(500 + 0.25 * px, 9); expect(got![1]).toBeCloseTo(2 * py, 9); return; }
        const exp = (n === 'wcs-swapped.fits' ? [c.world[i][1], c.world[i][0]] : c.world[i]) as [number, number];
        expect(angularSeparation(got!, exp) * 3600, `pixel ${i}`).toBeLessThan(1e-5); // 10 µas, CSC included: its single-precision polynomial is evaluated in wcslib's order
      });
      if (c.separation01 !== null) {
        const a = pixelToWorld(w, c.pixels[0][0] + 0.5, H - c.pixels[0][1] - 0.5)!, b = pixelToWorld(w, c.pixels[1][0] + 0.5, H - c.pixels[1][1] - 0.5)!;
        expect(angularSeparation(a, b)).toBeCloseTo(c.separation01, 8);
      }
    });
  }
  it('rejects points outside a projection\'s domain and the hidden side of a perspective', () => {
    const { w: azp } = wcsOf('wcs-azp.fits');
    expect(pixelToWorld(azp, 20.5, 15.5)).toBeTruthy();
    expect(pixelToWorld(azp, 20.5 + 200 / 0.02, 15.5)).toBeNull(); // 200° from the center: beyond the horizon of a μ = 2 perspective
    const { w: tsc } = wcsOf('wcs-tsc.fits');
    expect(pixelToWorld(tsc, 60.5 + 100, 40.5 + 100)).toBeNull(); // off the cross-shaped layout
    const { w: zpn } = wcsOf('wcs-zpn.fits');
    expect(pixelToWorld(zpn, 20.5, 15.5)).toBeTruthy();
    const { w: mol } = wcsOf('wcs-mol.fits');
    expect(pixelToWorld(mol, 20.5 + 400, 15.5)).toBeNull(); // outside the ellipse
  });
  it('formats positions: equatorial sexagesimal with the frame, galactic in degrees, linear axes with units', () => {
    expect(formatRa(150.1)).toBe('10:00:24.00');
    expect(formatRa(359.99999)).toBe('00:00:00.00');
    expect(formatDec(-20.5)).toBe('−20:30:00.0');
    expect(formatDec(0.00001)).toBe('+00:00:00.0');
    expect(formatAngle(2.5)).toBe('2.5°');
    expect(formatAngle(0.5)).toBe('30′');
    expect(formatAngle(0.0014709)).toBe('5.3″');
    const { w } = wcsOf('wcs-tan-cd.fits');
    expect(formatWorld(w, [150.1, -20.5])).toBe('RA 10:00:24.00 Dec −20:30:00.0 (ICRS J2000)');
    expect(formatWorld(wcsOf('wcs-ait.fits').w, [20.006084, -14.48422])).toBe('l 20.00608° b −14.48422°');
    expect(formatWorld(wcsOf('wcs-linear.fits').w, [500.25, 4])).toBe('WAVE 500.25 nm, TIME 4 s');
    expect(pixelScale(w, 20, 15)! * 3600).toBeCloseTo(1.1, 0); // ≈ 0.0003°/px ≈ 1.1″/px
  });
  it('the FITS page carries it, with a note; the measure readout adds sky separations', () => {
    const d = decodeFits(fx('wcs-tan-cd.fits'));
    expect(d.pages[0].world?.proj).toBe('TAN');
    expect(d.pages[0].notes.some((n) => /^TAN projection: the center is at RA 10:00:24\.00 Dec −20:30:00\.0 \(ICRS J2000\); the pixel readout and Measure show sky positions$/.test(n))).toBe(true);
    expect(decodeFits(fx('wcs-compressed.fits')).pages[0].world?.proj).toBe('TAN');
    expect(decodeFits(fx('rice-i16.fits')).pages[0].world).toBeUndefined();
    const lines = readout([[10, 10], [30, 25]], false, null, d.pages[0].world);
    expect(lines[0]).toBe('Distance 25 px');
    expect(lines[2]).toMatch(/^On the sky 2\d\.\d+″, from RA 10:00:\d\d\.\d\d Dec −20:\d\d:\d\d\.\d to RA 10:00:\d\d\.\d\d Dec −20:\d\d:\d\d\.\d \(ICRS J2000\)$/);
    expect(readout([[10, 10]], false, null, d.pages[0].world)[0]).toMatch(/^At RA /);
  });
  it('ignores headers without a usable system', () => {
    expect(parseWcs(new Map(), 10, 10)).toBeNull();
    expect(parseWcs(new Map([['CTYPE1', 'RA---XYZ'], ['CTYPE2', 'DEC--XYZ'], ['CRVAL1', '1'], ['CD1_1', '0.1']]), 10, 10)).toBeNull(); // an unknown projection code
  });
});
