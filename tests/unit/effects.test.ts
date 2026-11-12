import { describe, it, expect } from 'vitest';
import * as E from '../../src/picture/effects';
import type { Raster } from '../../src/codecs/raster';

const raster = (w: number, h: number, f: (x: number, y: number) => number[]): Raster => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = f(x, y); d.set([p[0], p[1], p[2], p[3] ?? 255], (y * w + x) * 4); } return { width: w, height: h, data: d as Uint8ClampedArray<ArrayBuffer> }; };
const px = (r: Raster, x: number, y: number) => [...r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4)];
const flat = (v: number) => raster(16, 16, () => [v, v, v]);
const gradient = raster(32, 32, (x) => [x * 8, x * 8, x * 8]);
const photo = raster(40, 30, (x, y) => [(x * 6) & 255, (y * 8) & 255, ((x + y) * 3) & 255]);
const sameSize = (a: Raster, b: Raster) => a.width === b.width && a.height === b.height && a.data.length === b.data.length;

describe('seeded randomness', () => {
  it('rng is deterministic and in [0,1)', () => { const a = E.rng(5), b = E.rng(5); const xs = Array.from({ length: 50 }, () => a()); expect(xs).toEqual(Array.from({ length: 50 }, () => b())); expect(xs.every((v) => v >= 0 && v < 1)).toBe(true); });
  it('noise, grain, spread and tiles reproduce with the same seed', () => {
    expect(E.noise(photo, 30).data).toEqual(E.noise(photo, 30).data);
    expect(E.noise(photo, 30, true, true, 1).data).not.toEqual(E.noise(photo, 30, true, true, 2).data);
    expect(E.filmGrain(photo, 30, 2).data).toEqual(E.filmGrain(photo, 30, 2).data);
    expect(E.spread(photo, 4).data).toEqual(E.spread(photo, 4).data);
    expect(E.tiles(photo, 8, 2).data).toEqual(E.tiles(photo, 8, 2).data);
  });
});

describe('artistic', () => {
  it('emboss of a flat picture is mid-gray; an edge gets relief', () => {
    expect(px(E.emboss(flat(100)), 5, 5)).toEqual([128, 128, 128, 255]);
    const e = E.emboss(raster(16, 16, (x) => (x < 8 ? [0, 0, 0] : [255, 255, 255])), 2, 0);
    expect(px(e, 7, 8)[0]).not.toBe(128); expect(px(e, 2, 8)[0]).toBe(128);
  });
  it('edge detect finds the step and nothing on flat areas', () => {
    const step = raster(16, 16, (x) => (x < 8 ? [0, 0, 0] : [255, 255, 255]));
    for (const mode of ['sobel', 'prewitt', 'laplacian'] as const) { const e = E.edgeDetect(step, mode); expect(px(e, 2, 8)[0]).toBe(0); expect(px(e, 7, 8)[0]).toBeGreaterThan(100); }
    expect(px(E.edgeDetect(step, 'sobel', true), 2, 8)[0]).toBe(255);
  });
  it('median removes a single speck; oil paint and sketch keep the size', () => {
    const speck = raster(9, 9, (x, y) => (x === 4 && y === 4 ? [255, 255, 255] : [10, 10, 10]));
    expect(px(E.median(speck, 1), 4, 4)).toEqual([10, 10, 10, 255]);
    expect(px(E.median(gradient, 2), 16, 16)[0]).toBe(128);
    expect(sameSize(E.oilPaint(photo, 2, 10), photo)).toBe(true);
    expect(px(E.oilPaint(flat(77), 2, 10), 3, 3)).toEqual([77, 77, 77, 255]);
    expect(px(E.pencilSketch(flat(100)), 3, 3)[0]).toBe(255);
    expect(sameSize(E.watercolor(photo), photo)).toBe(true); expect(sameSize(E.cartoon(photo), photo)).toBe(true);
  });
  it('pixelate averages blocks; mosaic adds grout; solarize inverts above the threshold', () => {
    const p = E.pixelize(gradient, 8);
    expect(px(p, 0, 0)).toEqual(px(p, 7, 7)); expect(px(p, 0, 0)[0]).toBe(28);
    expect(px(E.mosaic(gradient, 8, 1, [1, 2, 3]), 8, 3).slice(0, 3)).toEqual([1, 2, 3]);
    expect(px(E.solarize(flat(200), 128), 0, 0)[0]).toBe(55); expect(px(E.solarize(flat(100), 128), 0, 0)[0]).toBe(100);
  });
  it('halftone draws full dots in black and none in white; tiles and 3-D button keep the size', () => {
    expect(px(E.halftone(flat(255), 6), 8, 8).slice(0, 3)).toEqual([255, 255, 255]);
    const dark = E.halftone(flat(0), 6, 0); let black = 0; for (let i = 0; i < dark.data.length; i += 4) if (dark.data[i] === 0) black++;
    expect(black).toBeGreaterThan(150);
    expect(sameSize(E.tiles(photo, 8, 2), photo)).toBe(true);
    const b = E.button3d(flat(100), 4, 0.5); expect(px(b, 0, 8)[0]).toBeGreaterThan(100); expect(px(b, 15, 8)[0]).toBeLessThan(100); expect(px(b, 8, 8)[0]).toBe(100);
  });
});

describe('photographic', () => {
  it('soft focus blends toward the blur; glow only lifts bright areas', () => {
    expect(px(E.softFocus(flat(90), 4, 50), 4, 4)[0]).toBe(90);
    const g = E.glow(raster(32, 32, (x) => (x < 16 ? [20, 20, 20] : [250, 250, 250])), 4, 100, 160);
    expect(px(g, 2, 16)[0]).toBe(20); expect(px(g, 29, 16)[0]).toBeGreaterThanOrEqual(250);
    expect(sameSize(E.orton(photo), photo)).toBe(true);
  });
  it('focal black and white keeps color in the center only', () => {
    const red = raster(40, 40, () => [200, 40, 40]);
    const f = E.focalBW(red, 0.5, 0.5, 0.3, 0);
    expect(px(f, 20, 20).slice(0, 3)).toEqual([200, 40, 40]);
    const c = px(f, 0, 0); expect(c[0]).toBe(c[1]); expect(c[1]).toBe(c[2]);
    const s = px(E.focalBW(red, 0.5, 0.5, 0.3, 0, 'sepia'), 0, 0); expect(s[0]).toBeGreaterThan(s[2]);
  });
  it('graduated tint colors the top edge and leaves the bottom', () => {
    const t = E.graduatedTint(flat(100), [255, 0, 0], 0, 100, 0.5);
    expect(px(t, 8, 0)[0]).toBeGreaterThan(240); expect(px(t, 8, 15).slice(0, 3)).toEqual([100, 100, 100]);
  });
  it('duotone maps black and white to the two colors; cross process, toy camera and tilt-shift run', () => {
    const d = E.duotone(raster(2, 1, (x) => (x ? [255, 255, 255] : [0, 0, 0])), [10, 20, 30], [200, 210, 220]);
    expect(px(d, 0, 0).slice(0, 3)).toEqual([10, 20, 30]); expect(px(d, 1, 0).slice(0, 3)).toEqual([200, 210, 220]);
    expect(sameSize(E.crossProcess(photo), photo)).toBe(true); expect(sameSize(E.toyCamera(photo), photo)).toBe(true);
    const ts = E.tiltShift(raster(32, 32, (x, y) => ((x + y) & 1 ? [255, 255, 255] : [0, 0, 0])), 0.5, 0.3, 0.1, 4, 0);
    expect(Math.abs(px(ts, 16, 16)[0] - px(ts, 17, 16)[0])).toBe(255);
    expect(Math.abs(px(ts, 16, 1)[0] - px(ts, 17, 1)[0])).toBeLessThan(40);
  });
  it('noise changes pixels by about the requested amount', () => {
    const n = E.noise(flat(128), 20); let sum = 0; for (let i = 0; i < n.data.length; i += 4) sum += Math.abs(n.data[i] - 128);
    const mean = sum / (n.data.length / 4); expect(mean).toBeGreaterThan(5); expect(mean).toBeLessThan(40);
  });
});

describe('distortions', () => {
  it('remap with identity returns the picture; transparent outside works', () => {
    expect(E.remap(photo, () => {}).data).toEqual(photo.data);
    expect(px(E.remap(photo, (x, y, p) => { p[0] = x - 100; }, true), 0, 0)[3]).toBe(0);
  });
  it('swirl, pinch and ripple leave the center and the far corners alone', () => {
    for (const f of [E.swirl(photo, 90, 0.5), E.pinch(photo, 0.5, 0.5), E.ripple(photo, 4, 10)]) { expect(px(f, 20, 15)).toEqual(px(photo, 20, 15)); }
    expect(px(E.swirl(photo, 90, 0.5), 0, 0)).toEqual(px(photo, 0, 0));
    expect(E.swirl(photo, 90).data).not.toEqual(photo.data);
  });
  it('wave, glass, shift lines, spread, fragment, explosion and rain keep the size', () => {
    for (const f of [E.wave(photo), E.glass(photo), E.shiftLines(photo), E.shiftLines(photo, 5, 2, true), E.spread(photo), E.fragment(photo), E.explosion(photo), E.rain(photo, 5, 8)]) expect(sameSize(f, photo)).toBe(true);
    expect(px(E.wave(photo, 0), 5, 5)).toEqual(px(photo, 5, 5));
  });
  it('blurs smooth a checkerboard; fisheye and polar keep the size', () => {
    const check = raster(32, 32, (x, y) => ((x + y) & 1 ? [255, 255, 255] : [0, 0, 0]));
    expect(Math.abs(px(E.radialBlur(check, 30), 4, 4)[0] - 128)).toBeLessThan(60);
    expect(Math.abs(px(E.zoomBlur(check, 0.3), 4, 4)[0] - 128)).toBeLessThan(60);
    expect(sameSize(E.fishEye(photo, 0.5), photo)).toBe(true); expect(sameSize(E.fishEye(photo, -0.5), photo)).toBe(true);
    expect(sameSize(E.polar(photo), photo)).toBe(true); expect(sameSize(E.polar(photo, false), photo)).toBe(true);
    expect(px(E.fishEye(photo, 0.5), 20, 15)).toEqual(px(photo, 20, 15));
  });
});

describe('frames', () => {
  it('drop shadow grows the canvas and darkens below-right', () => {
    const s = E.dropShadow(flat(100), 6, 2, 1, [0, 0, 0], [255, 255, 255]);
    expect([s.width, s.height]).toEqual([16 + 8 + 6, 16 + 8 + 6]);
    expect(px(s, 4 + 8, 4 + 8)[0]).toBe(100); expect(px(s, s.width - 6, s.height - 6)[0]).toBeLessThan(100); expect(px(s, 0, 0)[0]).toBe(255);
  });
  it('reflection appends a fading mirror', () => {
    const r = E.reflection(raster(4, 4, (_x, y) => (y === 3 ? [0, 0, 0] : [200, 200, 200])), 0.5, 0, 1, [255, 255, 255]);
    expect(r.height).toBe(6); expect(px(r, 0, 4)[0]).toBe(0); expect(px(r, 0, 5)[0]).toBeGreaterThan(200);
  });
  it('round corners clear the corners only; frames add borders', () => {
    const rc = E.roundCorners(flat(100), 6); expect(px(rc, 0, 0)[3]).toBe(0); expect(px(rc, 8, 8)[3]).toBe(255); expect(px(rc, 8, 0)[3]).toBe(255);
    expect(px(E.roundCorners(flat(100), 6, [1, 2, 3]), 0, 0).slice(0, 3)).toEqual([1, 2, 3]);
    const f = E.instantFrame(flat(100), 0.1, 0.3, [250, 250, 250]); expect([f.width, f.height]).toEqual([16 + 4, 16 + 2 + 5]); expect(px(f, 0, 0)[0]).toBe(250); expect(px(f, 2, 2)[0]).toBe(100);
    const v = E.vignetteFrame(flat(100), 0.5, [255, 255, 255]); expect(px(v, 8, 8)[0]).toBe(100); expect(px(v, 0, 0)[0]).toBeGreaterThan(200);
  });
  it('custom convolution: identity, sum divisor and bias', () => {
    expect(E.convolve(photo, [0, 0, 0, 0, 1, 0, 0, 0, 0], 3).data).toEqual(photo.data);
    expect(px(E.convolve(flat(100), [1, 1, 1, 1, 1, 1, 1, 1, 1], 3), 5, 5)[0]).toBe(100);
    expect(px(E.convolve(flat(100), [0, 0, 0, 0, 1, 0, 0, 0, 0], 3, 2, 10), 5, 5)[0]).toBe(60);
  });
});

describe('alpha-weighted blur and sampling (W21)', () => {
  // A red square on fully transparent black: no blurred or resampled pixel may turn darker than the red it comes from.
  const cut = async () => { const { makeRaster } = await import('../../src/codecs/raster'); const r = makeRaster(20, 20); for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) r.data.set([255, 0, 0, 255], (y * 20 + x) * 4); return r; };
  const darkest = (r: { data: Uint8ClampedArray }) => { let m = 255; for (let i = 0; i < r.data.length; i += 4) if (r.data[i + 3] > 8) m = Math.min(m, r.data[i]); return m; };
  it('blur', async () => {
    const { gaussianBlur, boxBlur } = await import('../../src/picture/adjust');
    const r = await cut();
    for (const out of [gaussianBlur(r, 3), boxBlur(r, 2)]) { expect(darkest(out)).toBeGreaterThanOrEqual(254); expect(out.data[(10 * 20 + 3) * 4 + 3]).toBeGreaterThan(0); }
  });
  it('rotation, warping and remapping', async () => {
    const { rotateRaster } = await import('../../src/picture/geometry');
    const { remap } = await import('../../src/picture/effects');
    const { warpSimilarity } = await import('../../src/picture/merge');
    const r = await cut();
    expect(darkest(rotateRaster(r, 17, true, null))).toBeGreaterThanOrEqual(254);
    expect(darkest(remap(r, (x, y, p) => { p[0] = x * 0.93 + 0.37; p[1] = y * 0.93 + 0.41; }))).toBeGreaterThanOrEqual(254);
    expect(darkest(warpSimilarity(r, [0.95, 0.1, 0.3, -0.1, 0.95, 0.6, 0, 0, 1] as any, 20, 20))).toBeGreaterThanOrEqual(254);
  });
});
