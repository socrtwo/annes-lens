import { describe, it, expect } from 'vitest';
import { exposureFusion, focusStack, fusionWeights, alignRasters, alignmentTo, ghostWeights, exposureFusionRefined, focusStackRefined, warpSimilarity } from '../../src/picture/merge';
import { apply3 } from '../../src/picture/stitch';
import type { Raster } from '../../src/codecs/raster';

const raster = (w: number, h: number, f: (x: number, y: number) => number[]): Raster => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = f(x, y); d.set([p[0], p[1], p[2], 255], (y * w + x) * 4); } return { width: w, height: h, data: d as Uint8ClampedArray<ArrayBuffer> }; };
const px = (r: Raster, x: number, y: number) => [...r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 3)];

describe('merging', () => {
  it('exposure fusion prefers the well-exposed source per region', () => {
    // Left half: dark picture is right (bright one clips); right half: bright picture is right (dark one is black).
    const dark = raster(64, 32, (x) => (x < 32 ? [120, 110, 100] : [5, 5, 5]));
    const bright = raster(64, 32, (x) => (x < 32 ? [255, 255, 255] : [130, 120, 110]));
    const w = fusionWeights([dark, bright]);
    expect(w[0][16]).toBeGreaterThan(w[1][16]); expect(w[1][48]).toBeGreaterThan(w[0][48]);
    const out = exposureFusion([dark, bright], { levels: 3 });
    expect(out.width).toBe(64); expect(px(out, 8, 16)[0]).toBeLessThan(200); expect(px(out, 8, 16)[0]).toBeGreaterThan(90); expect(px(out, 56, 16)[0]).toBeGreaterThan(60);
    expect(exposureFusion([dark])).toBe(dark);
  });
  it('focus stack takes the sharp half of each source', () => {
    const chk = (x: number, y: number) => ((x + y) & 1 ? 255 : 0);
    const a = raster(40, 20, (x, y) => (x < 20 ? [chk(x, y), chk(x, y), chk(x, y)] : [128, 128, 128])); // sharp left, flat right
    const b = raster(40, 20, (x, y) => (x >= 20 ? [chk(x, y), chk(x, y), chk(x, y)] : [128, 128, 128])); // sharp right
    const { raster: out, map } = focusStack([a, b], 2);
    expect(map[10 * 40 + 5]).toBe(0); expect(map[10 * 40 + 35]).toBe(1);
    expect(px(out, 5, 10)[0]).toBe(chk(5, 10)); expect(px(out, 35, 10)[0]).toBe(chk(35, 10));
  });
  // A textured scene (deterministic noise blobs) and a copy shifted by a known amount.
  const seeded = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const scene = (w: number, h: number, dx: number, dy: number, gain = 1) => { const rnd = seeded(7); const blobs = Array.from({ length: 60 }, () => [rnd() * w, rnd() * h, 4 + rnd() * 10, rnd() * 200 + 40]); return raster(w, h, (x, y) => { let v = 30; for (const [bx, by, r, a] of blobs) { const d = Math.hypot(x - dx - bx, y - dy - by); if (d < r) v += a * (1 - d / r); } v = Math.min(255, v * gain); return [v, v * 0.9, v * 0.8]; }); };
  it('alignment recovers a shift between two pictures of the same scene and warps the second onto the first', () => {
    const a = scene(160, 120, 0, 0), b = scene(160, 120, 6, -4);
    const M = alignmentTo(a, b)!;
    expect(M).toBeTruthy();
    const [px0, py0] = apply3(M, 80, 60); // where b's center lands in a: shifted back by (−6, +4)
    expect(Math.abs(px0 - 74)).toBeLessThan(1); expect(Math.abs(py0 - 64)).toBeLessThan(1);
    const { rasters, moved, failed } = alignRasters([a, b]);
    expect(moved.length).toBe(1); expect(failed.length).toBe(0); expect(moved[0].shift).toBeGreaterThan(6);
    let diff = 0, n = 0; for (let y = 20; y < 100; y++) for (let x = 20; x < 140; x++) { diff += Math.abs(px(rasters[1], x, y)[0] - px(a, x, y)[0]); n++; }
    expect(diff / n).toBeLessThan(3);
    expect(alignRasters([a, raster(160, 120, () => [40, 40, 40])]).failed).toEqual([1]); // a flat picture has nothing to match
    expect(warpSimilarity(a, [1, 0, 0, 0, 1, 0, 0, 0, 1], 160, 120).data).toEqual(a.data);
  });
  it('ghost weights drop where one exposure shows something the reference does not', () => {
    const base = scene(96, 64, 0, 0), dark = scene(96, 64, 0, 0, 0.5), bright = scene(96, 64, 0, 0, 1.6);
    const ghost = raster(96, 64, (x, y) => (x > 60 && x < 80 && y > 20 && y < 40 ? [250, 250, 250] : px(dark, x, y)));
    const { weights, reference } = ghostWeights([ghost, base, bright]);
    expect(reference).toBe(1); // the middle exposure
    expect(weights[1].every((w) => w === 1)).toBe(true);
    const inside = weights[0][30 * 96 + 70], outside = weights[0][10 * 96 + 10];
    expect(inside).toBeLessThan(0.1); expect(outside).toBeGreaterThan(0.8);
    const out = exposureFusionRefined([ghost, base, bright], { levels: 3, align: false, deghost: true });
    expect(px(out.raster, 70, 30)[0]).toBeLessThan(200); // the white square did not come through
    expect(out.reference).toBe(1);
  });
  it('refined focus stacking lines pictures up and blends the seams', () => {
    const chk = (x: number, y: number) => ((x + y) & 1 ? 255 : 0);
    const left = raster(96, 64, (x, y) => (x < 48 ? [chk(x, y), chk(x, y), chk(x, y)] : [128, 128, 128])), right = raster(96, 64, (x, y) => (x >= 48 ? [chk(x, y), chk(x, y), chk(x, y)] : [128, 128, 128]));
    const r = focusStackRefined([left, right], { radius: 3, align: false, feather: 1 });
    expect(r.map[32 * 96 + 10]).toBe(0); expect(r.map[32 * 96 + 86]).toBe(1);
    expect(Math.abs(px(r.raster, 10, 32)[0] - chk(10, 32))).toBeLessThan(2); expect(Math.abs(px(r.raster, 86, 32)[0] - chk(86, 32))).toBeLessThan(2);
    expect(focusStackRefined([left], {}).raster).toBe(left);
  });
});
