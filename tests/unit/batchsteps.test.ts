import { describe, it, expect } from 'vitest';
import { applyAction } from '../../src/commands/batch';
import { describeAction, resolveActions } from '../../src/commands/batchSteps';
import type { Raster } from '../../src/codecs/raster';

const raster = (w: number, h: number, f: (x: number, y: number) => number[]): Raster => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = f(x, y); d.set([p[0], p[1], p[2], 255], (y * w + x) * 4); } return { width: w, height: h, data: d as Uint8ClampedArray<ArrayBuffer> }; };
const px = (r: Raster, x: number, y: number) => [...r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 3)];
const ctx = { name: 'a.png', index: 0 };

describe('batch steps', () => {
  it('applies raster steps in a known order', async () => {
    const r = raster(40, 20, (x) => [x * 6, 50, 50]);
    const resized = await applyAction(r, { kind: 'resize', mode: 'long', value: 20, kernel: 'bilinear', onlyShrink: true }, ctx); expect([resized.width, resized.height]).toEqual([20, 10]);
    expect((await applyAction(r, { kind: 'resize', mode: 'long', value: 80, kernel: 'bilinear', onlyShrink: true }, ctx)).width).toBe(40);
    const cropped = await applyAction(r, { kind: 'crop', x: 50, y: 0, w: 50, h: 100 }, ctx); expect([cropped.width, cropped.height]).toEqual([20, 20]); expect(px(cropped, 0, 0)[0]).toBe(120);
    const flipped = await applyAction(r, { kind: 'flip', dir: 'h' }, ctx); expect(px(flipped, 0, 0)[0]).toBe(234);
    const rot = await applyAction(r, { kind: 'rotate', angle: 90, expand: true, bg: '#000000' }, ctx); expect([rot.width, rot.height]).toEqual([20, 40]);
    const cv = await applyAction(r, { kind: 'canvas', w: 50, h: 30, anchor: 'tl', bg: '#00ff00', transparent: false }, ctx); expect([cv.width, cv.height]).toEqual([50, 30]); expect(px(cv, 49, 29)).toEqual([0, 255, 0]);
    const bd = await applyAction(r, { kind: 'border', size: 3, color: '#0000ff' }, ctx); expect([bd.width, bd.height]).toEqual([46, 26]); expect(px(bd, 0, 0)).toEqual([0, 0, 255]);
    expect(px(await applyAction(r, { kind: 'grayscale' }, ctx), 0, 0)[0]).toBe(px(await applyAction(r, { kind: 'grayscale' }, ctx), 0, 0)[1]);
    expect(px(await applyAction(r, { kind: 'negative' }, ctx), 0, 0)).toEqual([255, 205, 205]);
    expect(px(await applyAction(r, { kind: 'color', brightness: 10, contrast: 0, gamma: 1, saturation: 0 }, ctx), 1, 0)[1]).toBe(60);
    expect((await applyAction(r, { kind: 'metadata', patch: { rights: 'x' } }, ctx))).toBe(r);
    for (const what of ['adjust', 'levels', 'contrast', 'color'] as const) expect((await applyAction(r, { kind: 'auto', what }, ctx)).width).toBe(40);
    expect((await applyAction(r, { kind: 'sharpen', amount: 100 }, ctx)).width).toBe(40); expect((await applyAction(r, { kind: 'blur', radius: 2 }, ctx)).width).toBe(40); expect((await applyAction(r, { kind: 'colors', n: 2 }, ctx)).width).toBe(40);
  });
  it('describes steps and resolves relative text sizes', () => {
    expect(describeAction({ kind: 'resize', mode: 'long', value: 1600, kernel: 'lanczos3', onlyShrink: true })).toBe('Resize long 1600 px, shrink only');
    expect(describeAction({ kind: 'metadata', patch: { rights: 'x', keywords: ['a'] } })).toBe('Metadata: rights, keywords');
    const [t] = resolveActions([{ kind: 'text', text: 'x', size: 5, color: '#fff', anchor: 'br', margin: 2, opacity: 1, outline: 0, font: 'serif' }], 1000) as any[];
    expect([t.size, t.margin]).toEqual([50, 20]);
  });
});

describe('batch names take EXIF date, camera and size from the files (W22)', () => {
  const entryOf = async (path: string, name: string) => { const { readFileSync, statSync } = await import('node:fs'); const b = readFileSync(path); return { name, size: b.length, mtime: statSync(path).mtimeMs, uri: null, read: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) } as any; };
  it('{exifdate} {exiftime} {make} {model} {w} {h}', async () => {
    const { nameFacts, planNames, exifFallbackNote } = await import('../../src/commands/batch');
    const jpg = await entryOf('tests/fixtures/meta/tagged.jpg', 'tagged.jpg');
    const job: any = { inputs: [jpg], format: 'keep', names: { pattern: '{exifdate}_{exiftime} {make} {model}' } };
    const facts = await nameFacts(job.inputs, job.names.pattern);
    expect(planNames(job, facts)).toEqual(['2020-05-06_070809 TestMake TestModel.jpg']);
    expect(exifFallbackNote(job.names.pattern, facts)).toBe('');
    const png = await entryOf('tests/fixtures/png/gray1.ppm', 'tagged.ppm'); // decoded by the app's own reader (no platform decoder in the test DOM)
    const sized: any = { inputs: [png], format: 'keep', names: { pattern: '{name} {w}x{h} {exifdate}' } };
    // The app decodes the picture for its size; the test DOM has no canvas, so the PNM reader stands in for that decode.
    const { decodePnm } = await import('../../src/codecs/pnm');
    const f2 = await nameFacts(sized.inputs, sized.names.pattern, async (u8) => { const r: any = decodePnm(u8); const pg = r.pages ? r.pages[0] : r; return { width: pg.width, height: pg.height }; });
    expect([f2[0].width, f2[0].height]).toEqual([23, 17]);
    expect(f2[0].width).toBeGreaterThan(0);
    expect(planNames(sized, f2)[0]).toMatch(new RegExp(`^tagged ${f2[0].width}x${f2[0].height} \\d{4}-\\d{2}-\\d{2}\\.ppm$`));
    expect(exifFallbackNote(sized.names.pattern, f2)).toMatch(/1 file has no EXIF date/);
    // Patterns without these fields read nothing.
    let reads = 0; const counted = { ...jpg, read: async () => { reads++; return jpg.read(); } };
    await nameFacts([counted], '{name}_{n}'); expect(reads).toBe(0);
  });
});

it('Multipage ▸ Split to TIFF writes TIFF pages that read back (W25)', async () => {
  const { encodePage } = await import('../../src/commands/batchSteps');
  const { decodeTiff } = await import('../../src/codecs/tiff');
  const data = new Uint8ClampedArray(3 * 2 * 4); for (let i = 0; i < 6; i++) data.set([i * 40, 255 - i * 40, 7, i === 5 ? 128 : 255], i * 4);
  const canvas: any = { width: 3, height: 2, getContext: () => ({ getImageData: () => ({ data }) }) };
  const bytes = await encodePage(canvas, 'tiff');
  expect([bytes[0], bytes[1]]).toEqual([0x49, 0x49]);
  const r: any = await decodeTiff(bytes);
  const pg = r.pages[0], px = pg.frames[0].raster.data;
  expect([pg.width, pg.height, pg.hasAlpha]).toEqual([3, 2, true]);
  expect([...px.subarray(20, 24)]).toEqual([200, 55, 7, 128]);
});
