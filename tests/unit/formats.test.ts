import { describe, it, expect } from 'vitest';
import { decodeTga, encodeTga, isTga } from '../../src/codecs/tga';
import { decodePnm, encodePnm, isPnm } from '../../src/codecs/pnm';
import { decodeQoi, encodeQoi, isQoi } from '../../src/codecs/qoi';
import { decodePcx, isPcx, isDcx } from '../../src/codecs/pcx';
import { decodeXpm, decodeXbm, isXpm, isXbm } from '../../src/codecs/xpm';
import { decodeWbmp, encodeWbmp, isWbmp } from '../../src/codecs/wbmp';
import { decodePsd, isPsd } from '../../src/codecs/psd';
import { readIcns, decodeIcnsClassic, isIcns } from '../../src/codecs/icns';
import { decodeDds, isDds } from '../../src/codecs/dds';
import { decodeHdr, isHdr } from '../../src/codecs/hdr';
import { identifyRaw, findEmbeddedJpegs } from '../../src/codecs/rawpreview';
import { sniff, ENCODERS, encoderFor, encodeRaster } from '../../src/codecs/registry';
import type { Raster } from '../../src/codecs/raster';

const raster = (w: number, h: number, px: number[][]): Raster => ({ width: w, height: h, data: Uint8ClampedArray.from(px.flat()) as Uint8ClampedArray<ArrayBuffer> });
const pixel = (r: Raster, x: number, y: number) => [...r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4)];
const text = (s: string) => new TextEncoder().encode(s);
const RED = [255, 0, 0, 255], GREEN = [0, 255, 0, 255], BLUE = [0, 0, 255, 255], CLEAR = [0, 0, 0, 0], GRAY = [128, 128, 128, 255];

describe('TGA', () => {
  it('round-trips 24-bit and 32-bit, uncompressed and RLE', () => {
    const opaque = raster(3, 2, [RED, GREEN, BLUE, BLUE, GREEN, RED]);
    for (const rle of [false, true]) {
      const bytes = encodeTga(opaque, { rle });
      expect(isTga(bytes)).toBe(true);
      const d = decodeTga(bytes);
      expect(d.pages[0].bitDepth).toBe(24);
      expect(d.pages[0].hasAlpha).toBe(false);
      expect([...d.pages[0].frames[0].raster.data]).toEqual([...opaque.data]);
      expect(d.pages[0].notes[0]).toContain(rle ? 'RLE' : 'true color');
    }
    const alpha = raster(2, 2, [RED, [0, 255, 0, 128], CLEAR, BLUE]);
    const d = decodeTga(encodeTga(alpha, { rle: true }));
    expect(d.pages[0].bitDepth).toBe(32);
    expect(d.pages[0].hasAlpha).toBe(true);
    expect(pixel(d.pages[0].frames[0].raster, 1, 0)).toEqual([0, 255, 0, 128]);
  });
  it('reads color-mapped, 16-bit and bottom-up files and reports truncation', () => {
    // 2×2 color-mapped 8-bit, 2-entry 24-bit map (BGR), bottom-up (descriptor 0).
    const cm = Uint8Array.from([0, 1, 1, 0, 0, 2, 0, 24, 0, 0, 0, 0, 2, 0, 2, 0, 8, 0, /* map */ 0, 0, 255, 255, 0, 0, /* rows bottom-up */ 1, 1, 0, 0]);
    const d = decodeTga(cm);
    expect(pixel(d.pages[0].frames[0].raster, 0, 0)).toEqual(RED); // top row = second row in the file = index 0 = red
    expect(pixel(d.pages[0].frames[0].raster, 0, 1)).toEqual(BLUE);
    expect(d.pages[0].paletteSize).toBe(2);
    // 16-bit true color, 1×1, top-down: 0x7c00 = red
    const tc16 = Uint8Array.from([0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 16, 0x20, 0x00, 0x7c]);
    expect(pixel(decodeTga(tc16).pages[0].frames[0].raster, 0, 0)).toEqual(RED);
    const cut = encodeTga(raster(4, 4, Array(16).fill(RED))).subarray(0, 18 + 3 * 5);
    const t = decodeTga(cut);
    expect(t.warnings[0]).toMatch(/truncated/);
    expect(pixel(t.pages[0].frames[0].raster, 0, 0)).toEqual(RED);
    expect(pixel(t.pages[0].frames[0].raster, 3, 3)).toEqual([0, 0, 0, 255]); // top-down file: the missing tail is the bottom, left black
  });
  it('reads the 2.0 footer and extension area', () => {
    const base = encodeTga(raster(1, 1, [RED]));
    const ext = new Uint8Array(495); ext[0] = 495 & 255; ext[1] = 495 >> 8;
    ext.set(text('Jane Doe'), 2); ext.set(text('Hello'), 43); ext[367] = 5; ext[369] = 17; ext[371] = 2026 & 255; ext[372] = 2026 >> 8;
    const out = new Uint8Array(base.length - 26 + ext.length + 26);
    out.set(base.subarray(0, base.length - 26)); out.set(ext, base.length - 26); out.set(base.subarray(base.length - 26), base.length - 26 + ext.length);
    const dv = new DataView(out.buffer); dv.setUint32(out.length - 26, base.length - 26, true);
    const d = decodeTga(out);
    expect(d.info.Author).toBe('Jane Doe'); expect(d.info.Comments).toBe('Hello'); expect(d.info.Date).toBe('2026-05-17');
  });
});

describe('Netpbm', () => {
  it('reads every plain and raw variant', () => {
    const p1 = decodePnm(text('P1\n# comment\n2 2\n10\n01\n'));
    expect(pixel(p1.pages[0].frames[0].raster, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(p1.pages[0].frames[0].raster, 1, 0)).toEqual([255, 255, 255, 255]);
    const p2 = decodePnm(text('P2 2 1 15\n0 15\n'));
    expect(pixel(p2.pages[0].frames[0].raster, 1, 0)).toEqual([255, 255, 255, 255]);
    const p3 = decodePnm(text('P3\n1 1\n255\n255 0 0\n'));
    expect(pixel(p3.pages[0].frames[0].raster, 0, 0)).toEqual(RED);
    const p4 = decodePnm(Uint8Array.from([...text('P4\n9 1\n'), 0b10000000, 0b10000000]));
    expect(pixel(p4.pages[0].frames[0].raster, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(p4.pages[0].frames[0].raster, 8, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(p4.pages[0].frames[0].raster, 1, 0)).toEqual([255, 255, 255, 255]);
    const p5 = decodePnm(Uint8Array.from([...text('P5\n1 1\n65535\n'), 0x80, 0x00]));
    expect(pixel(p5.pages[0].frames[0].raster, 0, 0)).toEqual(GRAY);
    expect(p5.pages[0].bitDepth).toBe(16);
    const p6 = decodePnm(Uint8Array.from([...text('P6\n2 1\n255\n'), 255, 0, 0, 0, 0, 255]));
    expect(pixel(p6.pages[0].frames[0].raster, 1, 0)).toEqual(BLUE);
    const pam = decodePnm(Uint8Array.from([...text('P7\nWIDTH 1\nHEIGHT 1\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n'), 0, 255, 0, 77]));
    expect(pixel(pam.pages[0].frames[0].raster, 0, 0)).toEqual([0, 255, 0, 77]);
    expect(pam.pages[0].hasAlpha).toBe(true);
    const pf = new Uint8Array([...text('PF\n1 2\n-1.0\n'), ...new Uint8Array(new Float32Array([1, 1, 1, 0, 0, 0]).buffer)]);
    const pfm = decodePnm(pf);
    expect(pixel(pfm.pages[0].frames[0].raster, 0, 1)).toEqual([255, 255, 255, 255]); // bottom row first in the file
    expect(pixel(pfm.pages[0].frames[0].raster, 0, 0)).toEqual([0, 0, 0, 255]);
  });
  it('reads several raw pictures as pages and round-trips the writers', () => {
    const two = Uint8Array.from([...text('P5\n1 1\n255\n'), 9, ...text('P5\n1 1\n255\n'), 200]);
    expect(decodePnm(two).pages.length).toBe(2);
    const r = raster(2, 1, [RED, [0, 0, 255, 128]]);
    expect(pixel(decodePnm(encodePnm(r, 'ppm')).pages[0].frames[0].raster, 0, 0)).toEqual(RED);
    expect(pixel(decodePnm(encodePnm(r, 'pam')).pages[0].frames[0].raster, 1, 0)).toEqual([0, 0, 255, 128]);
    expect(pixel(decodePnm(encodePnm(r, 'pgm')).pages[0].frames[0].raster, 0, 0)).toEqual([54, 54, 54, 255]);
    expect(isPnm(text('P6 '))).toBe(true); expect(isPnm(text('PX '))).toBe(false);
  });
});

describe('QOI', () => {
  it('round-trips runs, index hits, diffs and alpha', () => {
    const px: number[][] = [];
    for (let i = 0; i < 70; i++) px.push(RED); // long run (> 62)
    px.push(GREEN, RED, [254, 1, 0, 255], [250, 10, 2, 255], [0, 0, 0, 0], [9, 8, 7, 6], GREEN, BLUE, CLEAR);
    const r = raster(px.length, 1, px);
    const bytes = encodeQoi(r);
    expect(isQoi(bytes)).toBe(true);
    const d = decodeQoi(bytes);
    expect([...d.pages[0].frames[0].raster.data]).toEqual([...r.data]);
    expect(d.pages[0].hasAlpha).toBe(true);
    expect(d.pages[0].bitDepth).toBe(32);
    const opaque = encodeQoi(raster(2, 2, [RED, GREEN, BLUE, RED]));
    expect(opaque[12]).toBe(3);
    expect(decodeQoi(opaque.subarray(0, 18)).warnings[0]).toMatch(/early/);
  });
});

describe('PCX', () => {
  function pcx(opts: { bpp: number; planes: number; w: number; h: number; lines: number[]; vga?: number[]; ega?: number[]; version?: number }): Uint8Array {
    const bytesPerLine = Math.ceil((opts.w * opts.bpp) / 8) + (Math.ceil((opts.w * opts.bpp) / 8) & 1);
    const head = new Uint8Array(128);
    head[0] = 0x0a; head[1] = opts.version ?? 5; head[2] = 1; head[3] = opts.bpp;
    const dv = new DataView(head.buffer);
    dv.setUint16(8, opts.w - 1, true); dv.setUint16(10, opts.h - 1, true); dv.setUint16(12, 72, true); dv.setUint16(14, 72, true);
    if (opts.ega) head.set(opts.ega, 16);
    head[65] = opts.planes; dv.setUint16(66, bytesPerLine, true);
    const body: number[] = [];
    for (const v of opts.lines) body.push((v & 0xc0) === 0xc0 ? 0xc1 : 0, v); // every byte as a length-1 run when needed
    const out = [...head];
    for (let i = 0; i < body.length; i += 2) { if (body[i]) out.push(body[i], body[i + 1]); else out.push(body[i + 1]); }
    if (opts.vga) out.push(0x0c, ...opts.vga);
    return Uint8Array.from(out);
  }
  it('reads 8-bit VGA palette, 24-bit planar and 1-bit files, and DCX', () => {
    const pal = new Array(768).fill(0); pal[3] = 255; pal[7] = 255; // index 1 red, 2 green
    const f8 = pcx({ bpp: 8, planes: 1, w: 2, h: 1, lines: [1, 2], vga: pal });
    expect(isPcx(f8)).toBe(true);
    const d8 = decodePcx(f8);
    expect(pixel(d8.pages[0].frames[0].raster, 0, 0)).toEqual(RED);
    expect(pixel(d8.pages[0].frames[0].raster, 1, 0)).toEqual(GREEN);
    expect(d8.pages[0].dpi).toEqual([72, 72]);
    const f24 = pcx({ bpp: 8, planes: 3, w: 2, h: 1, lines: [255, 0, 0, 255, 0, 0] }); // R plane, G plane, B plane (2 bytes each, padded)
    const d24 = decodePcx(f24);
    expect(pixel(d24.pages[0].frames[0].raster, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(d24.pages[0].frames[0].raster, 1, 0)).toEqual([0, 255, 0, 255]);
    const f1 = pcx({ bpp: 1, planes: 1, w: 8, h: 1, lines: [0b10000000, 0] });
    expect(pixel(decodePcx(f1).pages[0].frames[0].raster, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(decodePcx(f1).pages[0].frames[0].raster, 1, 0)).toEqual([0, 0, 0, 255]);
    // 4-plane EGA 16 colors with the header palette: pixel 0 = index 3 (planes 0 and 1 set)
    const ega = new Array(48).fill(0); ega[9] = 255; // index 3 = red
    const f4 = pcx({ bpp: 1, planes: 4, w: 8, h: 1, lines: [0x80, 0, 0x80, 0, 0, 0, 0, 0], ega });
    expect(pixel(decodePcx(f4).pages[0].frames[0].raster, 0, 0)).toEqual(RED);
    const dcx = Uint8Array.from([0xb1, 0x68, 0xde, 0x3a, 12, 0, 0, 0, 0, 0, 0, 0, ...f8]);
    expect(isDcx(dcx)).toBe(true);
    expect(decodePcx(dcx).pages.length).toBe(1);
    expect(decodePcx(dcx).info.container).toBe('DCX');
  });
});

describe('XPM and XBM', () => {
  it('reads XPM 3 with hex, named and transparent colors, and XPM 2', () => {
    const xpm = text('/* XPM */\nstatic char * x_xpm[] = {\n"3 2 3 1",\n"  c None",\n". c #FF0000",\n"x c navy blue",\n/* pixels */\n" .x",\n"x. "\n};\n');
    expect(isXpm(xpm)).toBe(true);
    const d = decodeXpm(xpm);
    expect(d.pages[0].width).toBe(3);
    expect(pixel(d.pages[0].frames[0].raster, 0, 0)).toEqual(CLEAR);
    expect(pixel(d.pages[0].frames[0].raster, 1, 0)).toEqual(RED);
    expect(pixel(d.pages[0].frames[0].raster, 2, 0)).toEqual([0, 0, 128, 255]);
    expect(d.pages[0].hasAlpha).toBe(true);
    const two = decodeXpm(text('! XPM2\n2 1 2 2\naa c #f00\nbb c #00ff00\naabb\n'));
    expect(pixel(two.pages[0].frames[0].raster, 1, 0)).toEqual(GREEN);
    const bad = decodeXpm(text('/* XPM */\nstatic char *a[] = {"1 1 1 1", "a c wobble", "a"};'));
    expect(bad.warnings[0]).toMatch(/wobble/);
  });
  it('reads XBM (LSB first, 1 = black) with a hotspot', () => {
    const xbm = text('#define t_width 9\n#define t_height 1\n#define t_x_hot 2\n#define t_y_hot 0\nstatic unsigned char t_bits[] = {\n   0x01, 0x01 };\n');
    expect(isXbm(xbm)).toBe(true);
    const d = decodeXbm(xbm);
    expect(pixel(d.pages[0].frames[0].raster, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(d.pages[0].frames[0].raster, 1, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(d.pages[0].frames[0].raster, 8, 0)).toEqual([0, 0, 0, 255]);
    expect(d.info.Hotspot).toBe('2, 0');
  });
});

describe('WBMP', () => {
  it('round-trips with multi-byte dimensions', () => {
    const w = 130, px: number[][] = [];
    for (let i = 0; i < w; i++) px.push(i % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]);
    const bytes = encodeWbmp(raster(w, 1, px));
    expect(bytes[2]).toBe(0x81); expect(bytes[3]).toBe(0x02); // 130 as uintvar
    expect(isWbmp(bytes)).toBe(true);
    const d = decodeWbmp(bytes);
    expect(d.pages[0].width).toBe(130);
    expect(pixel(d.pages[0].frames[0].raster, 1, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(d.pages[0].frames[0].raster, 128, 0)).toEqual([0, 0, 0, 255]);
  });
});

describe('PSD', () => {
  function psd(opts: { mode: number; channels: number; depth: number; planes: number[][]; rle?: boolean; w: number; h: number; layers?: string[]; mergedAlpha?: boolean }): Uint8Array {
    const be16 = (v: number) => [v >> 8, v & 255], be32 = (v: number) => [(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255];
    const out = [...text('8BPS'), ...be16(1), 0, 0, 0, 0, 0, 0, ...be16(opts.channels), ...be32(opts.h), ...be32(opts.w), ...be16(opts.depth), ...be16(opts.mode)];
    out.push(...be32(0)); // color mode data
    // Resolution resource: 300 dpi.
    const res = [...text('8BIM'), ...be16(0x03ed), 0, 0, ...be32(16), ...be32(300 << 16), ...be16(1), ...be16(1), ...be32(300 << 16), ...be16(1), ...be16(1)];
    out.push(...be32(res.length), ...res);
    if (opts.layers) {
      const rec: number[] = [];
      for (const name of opts.layers) {
        rec.push(...be32(0), ...be32(0), ...be32(1), ...be32(1), ...be16(1), ...be16(0), ...be32(2), ...text('8BIM'), ...text('norm'), 255, 0, 0, 0);
        const extra = [...be32(0), ...be32(0), name.length, ...text(name)];
        while ((extra.length - 8) % 4) extra.push(0);
        rec.push(...be32(extra.length), ...extra);
      }
      const li = [...be16((opts.mergedAlpha ? -opts.layers.length : opts.layers.length) & 0xffff), ...rec]; // a negative count: the first extra channel is the composite's transparency
      const lm = [...be32(li.length), ...li];
      out.push(...be32(lm.length), ...lm);
    } else out.push(...be32(0));
    out.push(...be16(opts.rle ? 1 : 0));
    if (opts.rle) {
      const rowBytes = opts.w * (opts.depth / 8);
      const rows: number[][] = [];
      for (const pl of opts.planes) for (let y = 0; y < opts.h; y++) { const row = pl.slice(y * rowBytes, (y + 1) * rowBytes); rows.push([row.length - 1, ...row]); }
      for (const r of rows) out.push(...be16(r.length));
      for (const r of rows) out.push(...r);
    } else for (const pl of opts.planes) out.push(...pl);
    return Uint8Array.from(out);
  }
  it('reads RGB, RGBA (RLE), grayscale, 16-bit and CMYK composites with resolution and layer names', () => {
    const rgb = psd({ mode: 3, channels: 3, depth: 8, w: 2, h: 1, planes: [[255, 0], [0, 255], [0, 0]] });
    expect(isPsd(rgb)).toBe(true);
    const d = decodePsd(rgb);
    expect(pixel(d.pages[0].frames[0].raster, 0, 0)).toEqual(RED);
    expect(pixel(d.pages[0].frames[0].raster, 1, 0)).toEqual(GREEN);
    expect(d.pages[0].dpi).toEqual([300, 300]);
    const rgba = decodePsd(psd({ mode: 3, channels: 4, depth: 8, w: 1, h: 2, planes: [[0, 0], [0, 0], [255, 255], [255, 10]], rle: true, layers: ['Background', 'Text'], mergedAlpha: true }));
    expect(pixel(rgba.pages[0].frames[0].raster, 0, 1)).toEqual([0, 0, 255, 10]);
    expect(rgba.pages[0].hasAlpha).toBe(true);
    expect(rgba.info.Layers).toBe('2: Background, Text');
    const gray16 = decodePsd(psd({ mode: 1, channels: 1, depth: 16, w: 1, h: 1, planes: [[0x80, 0x00]] }));
    expect(pixel(gray16.pages[0].frames[0].raster, 0, 0)).toEqual(GRAY);
    const cmyk = decodePsd(psd({ mode: 4, channels: 4, depth: 8, w: 1, h: 1, planes: [[255], [0], [0], [255]] })); // inverted: C=0, M=100%, Y=100%, K=0 → red
    expect(pixel(cmyk.pages[0].frames[0].raster, 0, 0)).toEqual(RED);
    const bitmap = decodePsd(psd({ mode: 0, channels: 1, depth: 1, w: 8, h: 1, planes: [[0x80]] }));
    expect(pixel(bitmap.pages[0].frames[0].raster, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(bitmap.pages[0].frames[0].raster, 1, 0)).toEqual([255, 255, 255, 255]);
  });
});

describe('ICNS', () => {
  it('lists elements and decodes classic packed RGB with a mask and 1-bit icons', () => {
    const be32 = (v: number) => [(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255];
    const n = 16 * 16;
    // is32: three channels, each a run of 256 bytes → packed as repeats (max 130 per packet): 0xff = 130 copies, then 126 more
    const chan = (v: number) => [130 + 125, v, 126 + 125, v];
    const is32 = [...chan(255), ...chan(0), ...chan(0)];
    const s8mk = new Array(n).fill(255); s8mk[0] = 0;
    const icon1 = new Array(128).fill(0); icon1[0] = 0x80; // ICON 32×32 1-bit: first pixel black
    const el = (type: string, body: number[]) => [...text(type), ...be32(8 + body.length), ...body];
    const png = [0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0];
    const body = [...el('is32', is32), ...el('s8mk', s8mk), ...el('ICON', icon1), ...el('ic07', png), ...el('TOC ', [1, 2, 3, 4])];
    const file = Uint8Array.from([...text('icns'), ...be32(8 + body.length), ...body]);
    expect(isIcns(file)).toBe(true);
    const { elements, warnings } = readIcns(file);
    expect(warnings).toEqual([]);
    expect(elements.map((e) => e.type)).toEqual(['is32', 's8mk', 'ICON', 'ic07']);
    expect(elements[3].png).toBe(true);
    expect(elements[3].size).toBe(128);
    const d = decodeIcnsClassic(elements);
    expect(d.pages.length).toBe(2);
    expect(pixel(d.pages[0].frames[0].raster, 0, 0)).toEqual([255, 0, 0, 0]);
    expect(pixel(d.pages[0].frames[0].raster, 1, 0)).toEqual(RED);
    expect(d.pages[0].hasAlpha).toBe(true);
    expect(d.pages[1].width).toBe(32);
    expect(pixel(d.pages[1].frames[0].raster, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(d.pages[1].frames[0].raster, 1, 0)).toEqual([255, 255, 255, 255]);
  });
});

describe('DDS', () => {
  function dds(opts: { w: number; h: number; fourcc?: string; bpp?: number; masks?: number[]; body: number[]; caps2?: number; dx10?: number }): Uint8Array {
    const out = new Uint8Array(128 + (opts.dx10 ? 20 : 0) + opts.body.length);
    const dv = new DataView(out.buffer);
    out.set(text('DDS ')); dv.setUint32(4, 124, true); dv.setUint32(12, opts.h, true); dv.setUint32(16, opts.w, true); dv.setUint32(28, 1, true);
    dv.setUint32(76, 32, true);
    if (opts.fourcc) { dv.setUint32(80, 4, true); out.set(text(opts.fourcc), 84); }
    else { dv.setUint32(80, 0x40 | (opts.masks![3] ? 1 : 0), true); dv.setUint32(88, opts.bpp!, true); for (let i = 0; i < 4; i++) dv.setUint32(92 + i * 4, opts.masks![i], true); }
    dv.setUint32(112, opts.caps2 || 0, true);
    if (opts.dx10) dv.setUint32(128, opts.dx10, true);
    out.set(opts.body, 128 + (opts.dx10 ? 20 : 0));
    return out;
  }
  it('reads uncompressed BGRA, DXT1, DXT5 and the DX10 header', () => {
    const u = decodeDds(dds({ w: 2, h: 1, bpp: 32, masks: [0xff0000, 0xff00, 0xff, 0xff000000], body: [0, 0, 255, 255, 255, 0, 0, 128] }));
    expect(isDds(u as any)).toBe(false);
    expect(pixel(u.pages[0].frames[0].raster, 0, 0)).toEqual(RED);
    expect(pixel(u.pages[0].frames[0].raster, 1, 0)).toEqual([0, 0, 255, 128]);
    // DXT1 block: c0 = red (0xf800), c1 = blue (0x001f), indices: pixel 0 → c0, pixel 1 → c1, pixel 2 → 2/3 red
    const dxt1 = dds({ w: 4, h: 4, fourcc: 'DXT1', body: [0x00, 0xf8, 0x1f, 0x00, 0b00100100, 0, 0, 0] });
    const d1 = decodeDds(dxt1);
    expect(pixel(d1.pages[0].frames[0].raster, 0, 0)).toEqual(RED);
    expect(pixel(d1.pages[0].frames[0].raster, 1, 0)).toEqual(BLUE);
    expect(pixel(d1.pages[0].frames[0].raster, 2, 0)).toEqual([170, 0, 85, 255]);
    expect(d1.pages[0].notes[0]).toContain('DXT1');
    // DXT5: alpha a0 = 255, a1 = 0, all indices 1 (→ a1) except pixel 0 (index 0 → 255); color block all red.
    let abits = 0n; for (let i = 1; i < 16; i++) abits |= 1n << BigInt(3 * i);
    const alphaBits = [0, 1, 2, 3, 4, 5].map((i) => Number((abits >> BigInt(8 * i)) & 255n));
    const d5 = decodeDds(dds({ w: 4, h: 4, fourcc: 'DXT5', body: [255, 0, ...alphaBits, 0x00, 0xf8, 0x00, 0xf8, 0, 0, 0, 0] }));
    expect(pixel(d5.pages[0].frames[0].raster, 0, 0)).toEqual(RED);
    expect(pixel(d5.pages[0].frames[0].raster, 1, 0)).toEqual([255, 0, 0, 0]);
    expect(d5.pages[0].hasAlpha).toBe(true);
    const dx10 = decodeDds(dds({ w: 1, h: 1, fourcc: 'DX10', dx10: 28, body: [0, 255, 0, 255] }));
    expect(pixel(dx10.pages[0].frames[0].raster, 0, 0)).toEqual(GREEN);
    expect(dx10.info['DXGI format']).toBe('28');
  });
});

describe('Radiance HDR', () => {
  it('reads flat and new-style RLE scanlines with the exposure and orientation', () => {
    const header = text('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\nEXPOSURE=1\nSOFTWARE=test\n\n-Y 1 +X 2\n');
    // Two flat pixels: (1,0,0) at exponent 129 → 1.0 (white-level red), and black.
    const flat = Uint8Array.from([...header, 128, 0, 0, 129, 0, 0, 0, 0]);
    expect(isHdr(flat)).toBe(true);
    const d = decodeHdr(flat);
    expect(pixel(d.pages[0].frames[0].raster, 0, 0)[0]).toBeGreaterThan(250);
    expect(pixel(d.pages[0].frames[0].raster, 0, 0).slice(1)).toEqual([0, 0, 255]);
    expect(pixel(d.pages[0].frames[0].raster, 1, 0)).toEqual([0, 0, 0, 255]);
    expect(d.info.SOFTWARE).toBe('test');
    // New RLE: 8 pixels wide, each channel a run of 8 (0x88 = 136 → run of 8).
    const rle = Uint8Array.from([...text('#?RADIANCE\n\n+Y 1 -X 8\n'), 2, 2, 0, 8, 136, 0, 136, 128, 136, 0, 136, 129]);
    const r = decodeHdr(rle);
    expect(r.pages[0].width).toBe(8);
    expect(pixel(r.pages[0].frames[0].raster, 3, 0).slice(0, 2)).toEqual([0, 255]);
    expect(decodeHdr(flat.subarray(0, flat.length - 2)).warnings[0]).toMatch(/truncated/);
  });
});

describe('camera RAW previews', () => {
  const jpeg = (w: number, h: number) => [0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0, 0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0x00, 4, 0xff, 0xd9];
  it('finds every embedded JPEG, largest first, skipping stuffed bytes', () => {
    const file = Uint8Array.from([0x49, 0x49, 42, 0, 8, 0, 0, 0, 0, 0, 0, 0, ...jpeg(160, 120), 1, 2, 3, ...jpeg(1024, 768), 0xff, 0xd8, 0xff, 0x12]);
    const found = findEmbeddedJpegs(file);
    expect(found.map((f) => [f.width, f.height])).toEqual([[1024, 768], [160, 120]]);
    expect(found[0].length).toBe(jpeg(1, 1).length);
  });
  it('identifies RAW files by signature, DNG tag, CFA photometric or extension', () => {
    expect(identifyRaw(text('FUJIFILMCCD-RAW 0201FF393103'))?.family).toBe('RAF');
    expect(identifyRaw(Uint8Array.from([0, 0, 0, 24, ...text('ftypcrx '), 0, 0, 0, 0, 0, 0, 0, 0]))?.make).toBe('Canon');
    const le16 = (v: number) => [v & 255, v >> 8], le32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
    const tiff = (tags: [number, number, number][]) => Uint8Array.from([0x49, 0x49, 42, 0, 8, 0, 0, 0, ...le16(tags.length), ...tags.flatMap(([t, type, v]) => [...le16(t), ...le16(type), ...le32(1), ...(type === 3 ? [...le16(v), 0, 0] : le32(v))]), 0, 0, 0, 0, ...new Array(8).fill(0)]);
    expect(identifyRaw(tiff([[0x100, 3, 1], [0xc612, 1, 1]]))?.family).toBe('DNG');
    expect(identifyRaw(tiff([[0x106, 3, 32803]]))?.family).toBe('RAW');
    expect(identifyRaw(tiff([[0x106, 3, 2]]), 'x.tif')).toBeNull();
    expect(identifyRaw(tiff([[0x106, 3, 2]]), 'x.nef')?.make).toBe('Nikon');
    expect(identifyRaw(Uint8Array.from([0x49, 0x49, 42, 0, 16, 0, 0, 0, ...text('CR\x02\0'), 0, 0, 0, 0, 0, 0, 0, 0, 0]))?.family).toBe('CR2');
  });
});

describe('sniffing and encoders', () => {
  it('recognizes every new format by content, and TGA/WBMP by a plausible header', () => {
    expect(sniff(encodeTga(raster(1, 1, [RED])))?.id).toBe('tga');
    expect(sniff(encodePnm(raster(2, 2, Array(4).fill(RED)), 'ppm'))?.id).toBe('pnm');
    expect(sniff(encodeQoi(raster(2, 2, Array(4).fill(RED))))?.id).toBe('qoi');
    expect(sniff(encodeWbmp(raster(64, 2, Array(128).fill(RED))))?.id).toBe('wbmp');
    expect(sniff(text('/* XPM */\nstatic char *a[] = {"1 1 1 1", "a c red", "a"};'))?.id).toBe('xpm');
    expect(sniff(text('#define a_width 8\n#define a_height 1\nstatic unsigned char a_bits[] = { 0x00 };\n'))?.id).toBe('xbm');
    expect(sniff(Uint8Array.from([...text('8BPS'), 0, 1, ...new Array(30).fill(0)]))?.id).toBe('psd');
    expect(sniff(Uint8Array.from([...text('icns'), 0, 0, 0, 8, ...new Array(8).fill(0)]))?.id).toBe('icns');
    expect(sniff(Uint8Array.from([...text('DDS '), ...new Array(130).fill(0)]))?.id).toBe('dds');
    expect(sniff(text('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n'))?.id).toBe('hdr');
    expect(sniff(Uint8Array.from([0x0a, 5, 1, 8, ...new Array(61).fill(0), 1, ...new Array(70).fill(0)]))?.id).toBe('pcx');
    expect(sniff(text('FUJIFILMCCD-RAW 0201FF393103'))?.id).toBe('raw');
    expect(sniff(Uint8Array.from([0x49, 0x49, 42, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 'img.tif')?.id).toBe('tiff');
    expect(sniff(Uint8Array.from([0x49, 0x49, 42, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 'img.arw')?.id).toBe('raw');
    expect(sniff(text('this is not a picture at all, just text'))).toBeNull();
  });
  it('maps read formats to writers and the raster encoders agree with the decoders', async () => {
    expect(encoderFor('pnm')).toBe('ppm'); expect(encoderFor('tiff')).toBeUndefined();
    expect(Object.keys(ENCODERS)).toContain('qoi');
    const r = raster(2, 1, [RED, BLUE]);
    expect(pixel(decodeTga(await encodeRaster(r, 'tga')).pages[0].frames[0].raster, 1, 0)).toEqual(BLUE);
    expect(pixel(decodeQoi(await encodeRaster(r, 'qoi')).pages[0].frames[0].raster, 1, 0)).toEqual(BLUE);
  });
});

describe('alpha channels that are not transparency', () => {
  const le16 = (v: number) => [v & 255, v >> 8], le32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  const be16 = (v: number) => [v >> 8, v & 255], be32 = (v: number) => [(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255];
  /** A 2 × 1, 32-bit BI_RGB bitmap (what the Windows clipboard writes) with the given top bytes. */
  const bmp32 = (a0: number, a1: number) => Uint8Array.from([0x42, 0x4d, ...le32(62), 0, 0, 0, 0, ...le32(54), ...le32(40), ...le32(2), ...le32(1), ...le16(1), ...le16(32), ...le32(0), ...le32(8), ...le32(2835), ...le32(2835), ...le32(0), ...le32(0), 10, 20, 30, a0, 40, 50, 60, a1]);
  /** A 2 × 1, 32-bit uncompressed true-color TGA (descriptor: 8 alpha bits, top-left origin). */
  const tga32 = (a0: number, a1: number) => Uint8Array.from([0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 1, 0, 32, 0x28, 10, 20, 30, a0, 40, 50, 60, a1]);
  it('32-bit BMP and TGA whose alpha is zero in every pixel are opaque; real alpha is kept', async () => {
    const { decodeBmp } = await import('../../src/codecs/bmp');
    const b = decodeBmp(bmp32(0, 0)).pages[0];
    expect([...b.frames[0].raster.data]).toEqual([30, 20, 10, 255, 60, 50, 40, 255]); expect(b.hasAlpha).toBe(false);
    const b2 = decodeBmp(bmp32(0, 128)).pages[0];
    expect([b2.frames[0].raster.data[3], b2.frames[0].raster.data[7], b2.hasAlpha]).toEqual([0, 128, true]);
    const t = decodeTga(tga32(0, 0)).pages[0];
    expect([...t.frames[0].raster.data]).toEqual([30, 20, 10, 255, 60, 50, 40, 255]); expect(t.hasAlpha).toBe(false);
    const t2 = decodeTga(tga32(0, 128)).pages[0];
    expect([t2.frames[0].raster.data[3], t2.frames[0].raster.data[7], t2.hasAlpha]).toEqual([0, 128, true]);
    const t3 = decodeTga(tga32(255, 255)).pages[0]; expect(t3.hasAlpha).toBe(false);
  });
  it('PSD: the extra channel of a file with layers is a saved selection unless the layer count is negative', () => {
    // 2 × 1 RGB, 8 bits, 4 channels; layer section: a layer count and nothing else (the reader only needs its sign).
    const psd = (count: number) => Uint8Array.from([0x38, 0x42, 0x50, 0x53, 0, 1, 0, 0, 0, 0, 0, 0, ...be16(4), ...be32(1), ...be32(2), ...be16(8), ...be16(3), ...be32(0), ...be32(0),
      ...be32(6), ...be32(2), ...be16(count & 0xffff), ...be16(0), 200, 100, 150, 50, 25, 75, 0, 255]);
    const sel = decodePsd(psd(1));       // one layer: the fourth channel is a selection
    expect([...sel.pages[0].frames[0].raster.data]).toEqual([200, 150, 25, 255, 100, 50, 75, 255]); expect(sel.pages[0].hasAlpha).toBe(false);
    expect(sel.info['Extra channel']).toMatch(/saved selection/);
    const tr = decodePsd(psd(-1));       // negative count: it is the composite's transparency
    expect([tr.pages[0].frames[0].raster.data[3], tr.pages[0].frames[0].raster.data[7]]).toEqual([0, 255]);
    const flat = decodePsd(psd(0));      // no layers: as before, the channel is taken as transparency (what most writers mean)
    expect(flat.pages[0].frames[0].raster.data[3]).toBe(0);
  });
});
