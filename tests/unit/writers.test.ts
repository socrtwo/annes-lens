import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { medianCut, mapToPalette, encodePalette } from '../../src/codecs/palette';
import { encodeGif, lzwEncode } from '../../src/codecs/gifenc';
import { decodeGif, lzwDecode } from '../../src/codecs/gif';
import { encodePng, encodeApng, encodeIco, encodeIcns, deflate } from '../../src/codecs/pngenc';
import { decodePngTolerant } from '../../src/codecs/png';
import { readIco } from '../../src/codecs/ico';
import { readIcns } from '../../src/codecs/icns';
import type { Raster } from '../../src/codecs/raster';

const raster = (w: number, h: number, px: number[][]): Raster => ({ width: w, height: h, data: Uint8ClampedArray.from(px.flat()) as Uint8ClampedArray<ArrayBuffer> });
const RED = [255, 0, 0, 255], GREEN = [0, 255, 0, 255], BLUE = [0, 0, 255, 255], CLEAR = [0, 0, 0, 0];

describe('palettes', () => {
  it('median cut keeps few colors exactly and reduces many to the requested count', () => {
    const few = medianCut(raster(2, 2, [RED, GREEN, BLUE, RED]).data, 16);
    expect(few.colors.length).toBe(3);
    const px: number[][] = [];
    for (let i = 0; i < 4096; i++) px.push([i & 255, (i >> 4) & 255, (i * 7) & 255, 255]);
    const many = medianCut(raster(64, 64, px).data, 8);
    expect(many.colors.length).toBe(8);
    const idx = mapToPalette(raster(2, 1, [RED, CLEAR]).data, few, 3);
    expect(idx[0]).toBe(few.colors.findIndex((c) => c[0] === 255 && c[1] === 0));
    expect(idx[1]).toBe(3);
  });
  it('writes every palette format', () => {
    const pal = { colors: [[255, 0, 0], [0, 255, 0]] as [number, number, number][] };
    const gpl = new TextDecoder().decode(encodePalette(pal, 'gpl').bytes);
    expect(gpl).toMatch(/^GIMP Palette/); expect(gpl).toContain('255   0   0\t#ff0000');
    expect(new TextDecoder().decode(encodePalette(pal, 'pal').bytes)).toMatch(/^JASC-PAL\r\n0100\r\n2\r\n255 0 0/);
    expect(new TextDecoder().decode(encodePalette(pal, 'css').bytes)).toContain('--color-2: #00ff00;');
    const act = encodePalette(pal, 'act').bytes; expect(act.length).toBe(772); expect([...act.subarray(0, 6)]).toEqual([255, 0, 0, 0, 255, 0]); expect(act[769]).toBe(2);
    const aco = encodePalette(pal, 'aco').bytes; expect([...aco.subarray(0, 4)]).toEqual([0, 1, 0, 2]); expect(aco.length).toBeGreaterThan(4 + 2 * 10 + 4);
  });
});

describe('GIF writer', () => {
  it('LZW round-trips through the reader', () => {
    const src = Uint8Array.from(Array.from({ length: 3000 }, (_, i) => (i * 31 + (i >> 5)) % 7));
    const packed = lzwEncode(src, 3);
    const back = lzwDecode(packed, 3, src.length);
    expect([...back]).toEqual([...src]);
    const longRun = new Uint8Array(70000).fill(1); for (let i = 0; i < 70000; i += 97) longRun[i] = (i / 97) % 4;
    expect([...lzwDecode(lzwEncode(longRun, 2), 2, longRun.length)]).toEqual([...longRun]);
  });
  it('writes an animation the app decodes back with the same pixels, delays, loops and transparency', () => {
    const pal = { colors: [[255, 0, 0], [0, 255, 0], [0, 0, 255]] as [number, number, number][] };
    const f1 = Uint8Array.from([0, 1, 2, 0]), f2 = Uint8Array.from([2, 3, 1, 0]);
    const gif = encodeGif(2, 2, pal, [{ indexes: f1, delay: 120 }, { indexes: f2, delay: 40 }], { loops: 0, transparent: 3 });
    const d = decodeGif(gif);
    expect(d.pages[0].frames.length).toBe(2);
    expect(d.pages[0].loops).toBe(0);
    expect(d.pages[0].frames[0].delay).toBe(120);
    expect([...d.pages[0].frames[0].raster.data]).toEqual([...RED, ...GREEN, ...BLUE, ...RED]);
    expect([...d.pages[0].frames[1].raster.data.subarray(4, 8)]).toEqual(CLEAR);
    expect(d.pages[0].frames[1].raster.data[8 + 1]).toBe(255);
  });
});

describe('PNG, APNG, ICO and ICNS writers', () => {
  it('writes a PNG the tolerant reader (and zlib) accept', async () => {
    const r = raster(3, 2, [RED, GREEN, BLUE, CLEAR, RED, [10, 20, 30, 40]]);
    const png = await encodePng(r);
    const d = decodePngTolerant(png);
    expect(d.warnings).toEqual([]);
    expect([...d.pages[0].frames[0].raster.data]).toEqual([...r.data]);
    const z = await deflate(Uint8Array.from([1, 2, 3, 4, 4, 4, 4]));
    expect([...inflateSync(Buffer.from(z))]).toEqual([1, 2, 3, 4, 4, 4, 4]);
  });
  it('writes an APNG with acTL, fcTL and fdAT chunks whose first frame reads as a PNG', async () => {
    const a = raster(2, 1, [RED, GREEN]), b = raster(2, 1, [BLUE, BLUE]);
    const apng = await encodeApng([{ raster: a, delay: 100 }, { raster: b, delay: 250 }], 3);
    const types: string[] = [];
    let p = 8; while (p + 12 <= apng.length) { const len = (apng[p] << 24 | apng[p + 1] << 16 | apng[p + 2] << 8 | apng[p + 3]) >>> 0; types.push(String.fromCharCode(...apng.subarray(p + 4, p + 8))); p += 12 + len; }
    expect(types).toEqual(['IHDR', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'IEND']);
    const d = decodePngTolerant(apng);
    expect([...d.pages[0].frames[0].raster.data]).toEqual([...RED, ...GREEN]);
    const { pngInfo } = await import('../../src/codecs/info');
    const info = pngInfo(apng);
    expect(info.animated).toBe(true); expect(info.frames).toBe(2); expect(info.loops).toBe(3);
  });
  it('writes ICO and ICNS files the readers list', async () => {
    const png16 = await encodePng(raster(1, 1, [RED])), png32 = await encodePng(raster(1, 1, [BLUE]));
    const ico = encodeIco([{ size: 16, png: png16 }, { size: 256, png: png32 }]);
    const { entries, cursor } = readIco(ico);
    expect(cursor).toBe(false);
    expect(entries.length).toBe(2);
    expect(entries.every((e) => e.png)).toBe(true);
    const big = entries.find((e) => e.width === 256)!, small = entries.find((e) => e.width === 16)!;
    expect([...big.bytes]).toEqual([...png32]);
    expect([...small.bytes]).toEqual([...png16]);
    const icns = encodeIcns([{ size: 16, png: png16 }, { size: 24, png: png16 }, { size: 512, png: png32 }]);
    const r = readIcns(icns);
    expect(r.warnings).toEqual([]);
    expect(r.elements.map((e) => e.type)).toEqual(['icp4', 'ic09']);
    expect(r.elements[1].png).toBe(true);
  });
});

describe('APNG delays and the TGA writer (W26)', () => {
  it('delays over 65.5 s keep their length', async () => {
    const { apngDelay } = await import('../../src/codecs/pngenc');
    expect(apngDelay(100)).toEqual([100, 1000]);
    expect(apngDelay(65535)).toEqual([65535, 1000]);
    const check = (ms: number) => { const [n, d] = apngDelay(ms); expect(n).toBeLessThanOrEqual(0xffff); expect(Math.abs((n / d) * 1000 - ms)).toBeLessThanOrEqual(ms * 0.001 + 50); };
    for (const ms of [70000, 120000, 600000, 3600000]) check(ms);
    expect(apngDelay(0)).toEqual([1, 1000]);
  });
  it('TGA, plain and RLE, round-trips a picture with runs and literals; large sizes are refused plainly', async () => {
    const { encodeTga, decodeTga } = await import('../../src/codecs/tga');
    const w = 300, h = 7, data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { const x = i % w; data.set(x < 150 ? [10, 20, 30, 255] : [x & 255, (x * 7) & 255, i & 255, 200], i * 4); }
    for (const rle of [false, true]) {
      const bytes = encodeTga({ width: w, height: h, data } as any, { rle });
      const r: any = decodeTga(bytes);
      const back = (r.pages ? r.pages[0].frames[0].raster : r).data;
      expect([...back]).toEqual([...data]);
    }
    expect(() => encodeTga({ width: 70000, height: 1, data: new Uint8ClampedArray(70000 * 4) } as any)).toThrow(/65535/);
  });
});
