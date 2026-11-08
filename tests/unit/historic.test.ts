import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodePngTolerant } from '../../src/codecs/png';
import type { Raster, DecodeResult } from '../../src/codecs/raster';
import { decodeSun, decodeSgi, decodeUtahRle, isSunRaster, isSgi, isUtahRle } from '../../src/codecs/workstation';

const fx = (n: string) => new Uint8Array(readFileSync(`tests/fixtures/historic/${n}`));
const ref = (n: string) => decodePngTolerant(fx(n)).pages[0].frames[0].raster;
const first = (r: DecodeResult) => r.pages[0].frames[0].raster;
/** Largest difference (RGB, and alpha when `alpha`); the sizes must match. */
function diff(a: Raster, b: Raster, alpha = false): number {
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  let max = 0;
  for (let i = 0; i < a.data.length; i += 4) for (let c = 0; c < (alpha ? 4 : 3); c++) max = Math.max(max, Math.abs(a.data[i + c] - b.data[i + c]));
  return max;
}

describe('Sun raster (ImageMagick and netpbm files)', () => {
  it('is recognized', () => { expect(isSunRaster(fx('sun8.ras'))).toBe(true); expect(isSunRaster(fx('gray.sgi'))).toBe(false); });
  for (const n of ['sun1', 'sun8', 'sun24', 'sun8-rle', 'sun1-rle']) it(`${n} is as the reference reads it`, () => { expect(diff(first(decodeSun(fx(`${n}.ras`))), ref(`${n}.png`))).toBe(0); });
  it('32 bits: the pad byte carries ImageMagick\'s transparency', () => {
    const d = decodeSun(fx('sun32.ras')); expect(diff(first(d), ref('sun32.png'), true)).toBe(0); expect(d.pages[0].hasAlpha).toBe(true);
  });
});

describe('SGI (netpbm and Pillow files)', () => {
  it('is recognized', () => { expect(isSgi(fx('sgi-rle.sgi'))).toBe(true); expect(isSgi(fx('sun8.ras'))).toBe(false); });
  for (const n of ['sgi-rle', 'sgi-verbatim', 'gray']) it(`${n} is as ImageMagick reads it`, () => { expect(diff(first(decodeSgi(fx(`${n}.sgi`))), ref(`${n}.png`))).toBe(0); });
  it('16 bits per sample', () => { const d = decodeSgi(fx('sgi16.sgi')); expect(diff(first(d), ref('sgi16.png'))).toBeLessThanOrEqual(1); expect(d.pages[0].bitDepth).toBe(48); });
  it('RGBA', () => { const d = decodeSgi(fx('rgba.sgi')); expect(diff(first(d), ref('rgba.png'), true)).toBe(0); expect(d.pages[0].hasAlpha).toBe(true); });
});

describe('Utah RLE (netpbm files)', () => {
  it('is recognized', () => { expect(isUtahRle(fx('urt.rle'))).toBe(true); });
  it('RGB and gray are as rletopnm reads them', () => {
    const d = decodeUtahRle(fx('urt.rle'));
    expect(diff(first(d), ref('urt.png'))).toBe(0);
    expect(d.info.comments).toMatch(/HISTORY=pnmtorle/);
    expect(diff(first(decodeUtahRle(fx('urt-gray.rle'))), ref('urt-gray.png'))).toBe(0);
  });
});

import { isAtariSt, decodeAtariSt, isC64, decodeC64, isGemImg, decodeGemImg, isMsp, decodeMsp } from '../../src/codecs/homecomputer';
describe('Atari ST (references: netpbm)', () => {
  it('recognized by extension, size and resolution word', () => {
    expect(isAtariSt(fx('low.pi1'), 'a.pi1')).toBe(true); expect(isAtariSt(fx('low.pi1'), 'a.pi2')).toBe(false);
    expect(isAtariSt(fx('low.pc1'), 'a.pc1')).toBe(true); expect(isAtariSt(fx('neo.neo'), 'x.neo')).toBe(true); expect(isAtariSt(fx('spectrum.spu'), 'x.spu')).toBe(true);
  });
  it('Degas low resolution, plain and Elite-compressed', () => {
    expect(diff(first(decodeAtariSt(fx('low.pi1'), 'low.pi1')), ref('low.png'))).toBe(0);
    expect(diff(first(decodeAtariSt(fx('low.pc1'), 'low.pc1')), ref('low.png'))).toBe(0);
    const cyc = decodeAtariSt(fx('low-cycle.pc1'), 'low-cycle.pc1'), fr = cyc.pages[0].frames; // Degas Elite footer: colors 1–7 to the right, 8 VBLs
    expect(fr.length).toBe(7); expect(fr[0].delay).toBe(133); expect(diff(fr[0].raster, ref('low.png'))).toBe(0); expect(diff(fr[1].raster, ref('low-cycle-f1.png'))).toBe(0);
    expect(cyc.pages[0].notes.some((n) => /color cycling: 1 range \(colors 1–7 right, 8 VBL\), played as an animation of 7 frames/.test(n))).toBe(true);
    const neoC = decodeAtariSt(fx('neo-cycle.neo'), 'neo-cycle.neo').pages[0].frames; // NEOchrome words: the same colors to the left, 4 VBLs
    expect(neoC.length).toBe(7); expect(neoC[0].delay).toBe(67); expect(diff(neoC[1].raster, ref('neo-cycle-f1.png'))).toBe(0);
    expect(decodeAtariSt(fx('neo.neo'), 'neo.neo').pages[0].frames.length).toBe(1);
  });
  it('Degas high and medium resolution', () => {
    expect(diff(first(decodeAtariSt(fx('mono.pi3'), 'mono.pi3')), ref('mono.png'))).toBe(0);
    const m = decodeAtariSt(fx('med.pi2'), 'med.pi2'); expect(diff(first(m), ref('med.png'))).toBe(0); expect(m.pages[0].notes[0]).toMatch(/twice as tall/);
  });
  it('NEOchrome and Spectrum 512', () => {
    expect(diff(first(decodeAtariSt(fx('neo.neo'), 'neo.neo')), ref('neo.png'))).toBe(0);
    expect(diff(first(decodeAtariSt(fx('spectrum.spu'), 'spectrum.spu')), ref('spectrum.png'))).toBe(0);
  });
});
describe('Commodore 64', () => {
  it('Koala, Art Studio and Doodle', () => {
    expect([isC64(fx('koala.koa'), 'k.koa'), isC64(fx('hires.art'), 'h.art'), isC64(fx('doodle.dd'), 'd.dd'), isC64(fx('koala.koa'), 'k.art')]).toEqual([true, true, true, false]);
    expect(diff(first(decodeC64(fx('koala.koa'), 'k.koa')), ref('koala.png'))).toBe(0);
    expect(diff(first(decodeC64(fx('hires.art'), 'h.art')), ref('hires.png'))).toBe(0);
    expect(diff(first(decodeC64(fx('doodle.dd'), 'd.dd')), ref('doodle.png'))).toBe(0);
  });
});
describe('GEM IMG and MS Paint', () => {
  it('GEM IMG: one plane (netpbm) and four planes with an XIMG palette', () => {
    expect(isGemImg(fx('gem1.img'), 'a.img')).toBe(true); expect(isGemImg(fx('ximg4.img'), 'x')).toBe(true);
    expect(diff(first(decodeGemImg(fx('gem1.img'))), ref('gem1.png'))).toBe(0);
    const x = decodeGemImg(fx('ximg4.img')); expect(diff(first(x), ref('ximg4.png'))).toBe(0); expect(x.pages[0].dpi).toEqual([299, 299]);
  });
  it('MS Paint 1.x and 2.x (Pillow)', () => {
    expect(isMsp(fx('msp1.msp')) && isMsp(fx('msp2.msp'))).toBe(true);
    expect(diff(first(decodeMsp(fx('msp1.msp'))), ref('msp1.png'))).toBe(0);
    const d = decodeMsp(fx('msp2.msp')); expect(diff(first(d), ref('msp2.png'))).toBe(0); expect(d.warnings).toEqual([]);
  });
});

import { isPict, decodePict } from '../../src/codecs/pict';
describe('PICT', () => {
  it('is recognized with its 512-byte header, or by name', () => {
    expect(isPict(fx('pict8.pct'), 'x')).toBe(true); expect(isPict(fx('shapes.pct'), 'shapes')).toBe(true); expect(isPict(fx('sun8.ras'), 'x.pct')).toBe(false);
  });
  for (const n of ['pict8', 'pict32', 'ppm']) it(`${n}: the pixel map is as ImageMagick reads it`, () => { const d = decodePict(fx(`${n}.pct`)); expect(diff(first(d), ref(`${n}.png`))).toBe(0); expect(d.warnings).toEqual([]); });
  it('QuickDraw shapes, a 1-bit PackBitsRect and text', () => {
    const d = decodePict(fx('shapes.pct'));
    expect(d.warnings).toEqual([]);
    expect(diff(first(d), ref('shapes.png'))).toBe(0);
    expect(d.texts).toEqual([{ x: 60, y: 70, text: 'Annes', size: 12, face: 0, font: 'sans-serif', color: [30, 160, 30] }]); // the color in force: the triangle's
  });
  it('version 1: old colors, a pattern fill, a region, srcOr bits, a line', () => {
    const d = decodePict(fx('v1.pct')); expect(d.warnings).toEqual([]); expect(diff(first(d), ref('v1.png'))).toBe(0); expect(d.pages[0].notes[0]).toBe('QuickDraw picture (PICT version 1)');
  });
  it('QuickTime JPEG: the JPEG and where it goes', () => {
    const d = decodePict(fx('jpeg.pct'));
    expect(d.jpegs.length).toBe(1);
    const j = d.jpegs[0]; expect([j.x, j.y, j.w, j.h]).toEqual([0, 0, 61, 37]);
    expect([j.bytes[0], j.bytes[1], j.bytes[j.bytes.length - 2], j.bytes[j.bytes.length - 1]]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
  });
});
