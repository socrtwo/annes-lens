import { describe, it, expect } from 'vitest';
import { seamCarve, findSeam } from '../../src/picture/seam';
import { parsePalette } from '../../src/codecs/palette';
import type { Raster } from '../../src/codecs/raster';

const raster = (w: number, h: number, f: (x: number, y: number) => number[]): Raster => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = f(x, y); d.set([p[0], p[1], p[2], 255], (y * w + x) * 4); } return { width: w, height: h, data: d as Uint8ClampedArray<ArrayBuffer> }; };
const px = (r: Raster, x: number, y: number) => [...r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 3)];

describe('seam carving', () => {
  it('removes seams through the plain area and keeps the detailed columns', () => {
    // Columns 0–4 noisy (high energy), 5–14 flat gray, 15–19 noisy.
    const r = raster(20, 10, (x, y) => (x < 5 || x >= 15 ? [(x * 97 + y * 31) % 256, (x * 13) % 256, (y * 57) % 256] : [128, 128, 128]));
    const e = new Float32Array(20 * 10); for (let y = 0; y < 10; y++) for (let x = 0; x < 20; x++) e[y * 20 + x] = x < 5 || x >= 15 ? 100 : 1;
    const s = findSeam(e, 20, 10); for (const x of s) { expect(x).toBeGreaterThanOrEqual(5); expect(x).toBeLessThan(15); }
    const out = seamCarve(r, 14, 10);
    expect([out.width, out.height]).toEqual([14, 10]);
    for (let x = 0; x < 5; x++) expect(px(out, x, 3)).toEqual(px(r, x, 3)); // left detail intact
    for (let x = 0; x < 5; x++) expect(px(out, 13 - x, 3)).toEqual(px(r, 19 - x, 3)); // right detail intact
    expect(seamCarve(r, 20, 7).height).toBe(7);
    const wider = seamCarve(r, 24, 10); expect(wider.width).toBe(24); expect(px(wider, 0, 0)).toEqual(px(r, 0, 0));
  });
  it('protect keeps a column, remove pulls seams through it', () => {
    const r = raster(12, 6, () => [100, 100, 100]);
    const protect = new Uint8Array(12 * 6); for (let y = 0; y < 6; y++) protect[y * 12 + 3] = 255;
    const marker = raster(12, 6, (x) => (x === 3 ? [255, 0, 0] : [100, 100, 100]));
    const kept = seamCarve(marker, 11, 6, protect); let reds = 0; for (let x = 0; x < 11; x++) if (px(kept, x, 2)[0] === 255) reds++; expect(reds).toBe(1);
    const removed = seamCarve(marker, 11, 6, null, protect); reds = 0; for (let x = 0; x < 11; x++) if (px(removed, x, 2)[0] === 255) reds++; expect(reds).toBe(0);
  });
});

describe('palette files', () => {
  it('reads GIMP, JASC, ACT, ACO and hex lists', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(parsePalette(enc('GIMP Palette\nName: t\nColumns: 2\n#\n255   0   0\tred\n  0 255   0\tgreen\n'), 'a.gpl').colors).toEqual([[255, 0, 0], [0, 255, 0]]);
    expect(parsePalette(enc('JASC-PAL\n0100\n2\n1 2 3\n4 5 6\n'), 'a.pal').colors).toEqual([[1, 2, 3], [4, 5, 6]]);
    const act = new Uint8Array(772); act.set([9, 8, 7, 6, 5, 4]); act[769] = 2; expect(parsePalette(act, 'a.act').colors).toEqual([[9, 8, 7], [6, 5, 4]]);
    const aco = new Uint8Array(4 + 10); const dv = new DataView(aco.buffer); dv.setUint16(0, 1); dv.setUint16(2, 1); dv.setUint16(4, 0); dv.setUint16(6, 0xff00); dv.setUint16(8, 0x8000); dv.setUint16(10, 0); expect(parsePalette(aco, 'a.aco').colors).toEqual([[255, 128, 0]]);
    expect(parsePalette(enc(':root{--a:#102030;--b:#ffffff}'), 'a.css').colors).toEqual([[16, 32, 48], [255, 255, 255]]);
  });
});

describe('seam insertion (W20)', () => {
  it('maps seams back to the original columns by undoing removals latest first', async () => {
    const { seamsToOriginal } = await import('../../src/picture/seam');
    let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
    for (let trial = 0; trial < 50; trial++) {
      const w = 12, h = 5, n = 6, cols = Array.from({ length: h }, () => Array.from({ length: w }, (_, x) => x)), taken: Int32Array[] = [], want: number[][] = [];
      for (let i = 0; i < n; i++) { const s = new Int32Array(h), o: number[] = []; for (let y = 0; y < h; y++) { s[y] = Math.floor(rnd() * cols[y].length); o.push(cols[y][s[y]]); cols[y].splice(s[y], 1); } taken.push(s); want.push(o); }
      expect(seamsToOriginal(taken).map((s) => [...s])).toEqual(want);
    }
  });
  it('keeps the seam pixel and puts the blended one after it', async () => {
    const { insertSeams } = await import('../../src/picture/seam');
    const { makeRaster } = await import('../../src/codecs/raster');
    const r = makeRaster(3, 1); r.data.set([0, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255]);
    const o = insertSeams(r, [Int32Array.of(0)]);
    expect([0, 1, 2, 3].map((x) => o.data[x * 4])).toEqual([0, 50, 100, 200]);
  });
});
