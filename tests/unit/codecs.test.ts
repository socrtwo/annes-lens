import { describe, it, expect } from 'vitest';
import { decodeGif, isGif, lzwDecode } from '../../src/codecs/gif';
import { decodeTiff, isTiff, packBits, lzwTiff } from '../../src/codecs/tiff';
import { decodeBmp, encodeBmp, isBmp } from '../../src/codecs/bmp';
import { isIco, readIco, decodeIcoDibs } from '../../src/codecs/ico';
import { parseExifBlock, readExif } from '../../src/meta/exif';
import { jpegInfo, pngInfo } from '../../src/codecs/info';
import { sniff } from '../../src/codecs/registry';
import { planKeyToCanonical, parseKeyList, sanitizePrefs } from '../../src/prefs';

// ---------------------------------------------------------------------------------------------
// Builders for tiny files

/** A GIF with one or two 2×2 frames, written with an LZW stream of literal codes (clear + each index). */
function makeGif(frames: number[][], opts: { delay?: number; loops?: number; transparent?: number } = {}): Uint8Array {
  const out: number[] = [...'GIF89a'].map((c) => c.charCodeAt(0)), w = 2, h = 2;
  out.push(w, 0, h, 0, 0x80 | 1, 0, 0); // global color table of 4 colors
  out.push(255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255);
  if (opts.loops !== undefined) out.push(0x21, 0xff, 11, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 3, 1, opts.loops, 0, 0);
  for (const idx of frames) {
    const delay = opts.delay ?? 10;
    out.push(0x21, 0xf9, 4, opts.transparent !== undefined ? 1 : 0, delay & 255, delay >> 8, opts.transparent ?? 0, 0);
    out.push(0x2c, 0, 0, 0, 0, w, 0, h, 0, 0);
    const minCode = 2;
    const codes = [1 << minCode, ...idx, (1 << minCode) + 1]; // clear, literals, end (3-bit codes)
    const bits: number[] = [];
    let size = minCode + 1;
    let n = (1 << minCode) + 2;
    for (const c of codes) { for (let b = 0; b < size; b++) bits.push((c >> b) & 1); if (c !== (1 << minCode) && c !== (1 << minCode) + 1) { n++; if (n === 1 << size && size < 12) size++; } }
    const bytes: number[] = [];
    for (let i = 0; i < bits.length; i += 8) { let v = 0; for (let b = 0; b < 8; b++) v |= (bits[i + b] || 0) << b; bytes.push(v); }
    out.push(minCode, bytes.length, ...bytes, 0);
  }
  out.push(0x3b);
  return Uint8Array.from(out);
}

function tiffFile(opts: { comp?: number; bits?: number; spp?: number; photo?: number; pixels: number[]; pages?: number; w?: number; h?: number; predictor?: number; palette?: number[] }): Uint8Array {
  const w = opts.w ?? 2, h = opts.h ?? 2, bits = opts.bits ?? 8, spp = opts.spp ?? 1, comp = opts.comp ?? 1, photo = opts.photo ?? 1, pages = opts.pages ?? 1;
  const rowBytes = Math.ceil((w * spp * bits) / 8);
  const raw = Uint8Array.from(opts.pixels);
  const strip = comp === 32773 ? packBitsEncode(raw) : raw;
  const chunks: number[] = [0x49, 0x49, 42, 0, 8, 0, 0, 0];
  let ifdAt = 8;
  const entries: [number, number, number, number[]][] = [[256, 3, 1, [w]], [257, 3, 1, [h]], [258, 3, spp, Array(spp).fill(bits)], [259, 3, 1, [comp]], [262, 3, 1, [photo]], [273, 4, 1, [0]], [277, 3, 1, [spp]], [278, 3, 1, [h]], [279, 4, 1, [strip.length]]];
  if (opts.predictor) entries.push([317, 3, 1, [opts.predictor]]);
  if (opts.palette) entries.push([320, 3, opts.palette.length, opts.palette]);
  entries.sort((a, b) => a[0] - b[0]);
  for (let pg = 0; pg < pages; pg++) {
    const n = entries.length;
    const ifdSize = 2 + n * 12 + 4;
    const dataAt = ifdAt + ifdSize;
    let extra = dataAt;
    const extraBytes: number[] = [];
    const le16 = (v: number) => [v & 255, v >> 8];
    const le32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
    const ifd: number[] = [...le16(n)];
    const stripAt = () => extra + extraBytes.length;
    for (const [tag, type, count, vals] of entries) {
      const size = type === 3 ? 2 : 4;
      let values = vals;
      if (tag === 273) { values = [stripAt() + (entries.find((e) => e[0] === 320) ? opts.palette!.length * 2 : 0)]; }
      const enc = values.flatMap((v) => (type === 3 ? le16(v) : le32(v)));
      if (enc.length <= 4) ifd.push(...le16(tag), ...le16(type), ...le32(count), ...enc, ...Array(4 - enc.length).fill(0));
      else { ifd.push(...le16(tag), ...le16(type), ...le32(count), ...le32(extra + extraBytes.length)); extraBytes.push(...enc); }
    }
    const next = pg < pages - 1 ? dataAt + extraBytes.length + strip.length : 0;
    ifd.push(...le32(next));
    chunks.push(...ifd, ...extraBytes, ...strip);
    ifdAt = next;
    void rowBytes;
  }
  return Uint8Array.from(chunks);
}

function packBitsEncode(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < src.length; i += 100) { const run = src.subarray(i, i + 100); out.push(run.length - 1, ...run); }
  return Uint8Array.from(out);
}

function bmp24(w: number, h: number, px: number[][]): Uint8Array {
  const stride = Math.ceil((w * 3) / 4) * 4;
  const out = new Uint8Array(54 + stride * h);
  const dv = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d; dv.setUint32(2, out.length, true); dv.setUint32(10, 54, true); dv.setUint32(14, 40, true); dv.setInt32(18, w, true); dv.setInt32(22, h, true); dv.setUint16(26, 1, true); dv.setUint16(28, 24, true);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = px[y * w + x]; const o = 54 + (h - 1 - y) * stride + x * 3; out[o] = b; out[o + 1] = g; out[o + 2] = r; }
  return out;
}

function exifBlock(): Uint8Array {
  // II, 42, IFD0 at 8: Orientation=6, Make="Acme", XResolution=300/1, ExifIFD -> ExposureTime=1/125
  const le16 = (v: number) => [v & 255, v >> 8], le32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  const b: number[] = [0x49, 0x49, 42, 0, 8, 0, 0, 0];
  const n0 = 4;
  const ifd0At = 8, ifd0Size = 2 + n0 * 12 + 4;
  const makeAt = ifd0At + ifd0Size, xresAt = makeAt + 6, exifAt = xresAt + 8;
  b.push(...le16(n0));
  b.push(...le16(0x10f), ...le16(2), ...le32(5), ...le32(makeAt));
  b.push(...le16(0x112), ...le16(3), ...le32(1), ...le16(6), 0, 0);
  b.push(...le16(0x11a), ...le16(5), ...le32(1), ...le32(xresAt));
  b.push(...le16(0x8769), ...le16(4), ...le32(1), ...le32(exifAt));
  b.push(...le32(0));
  b.push(...[...'Acme\0'].map((c) => c.charCodeAt(0)), 0);
  b.push(...le32(300), ...le32(1));
  const n1 = 1;
  const ratAt = exifAt + 2 + n1 * 12 + 4;
  b.push(...le16(n1));
  b.push(...le16(0x829a), ...le16(5), ...le32(1), ...le32(ratAt));
  b.push(...le32(0));
  b.push(...le32(1), ...le32(125));
  return Uint8Array.from(b);
}

// ---------------------------------------------------------------------------------------------

describe('GIF', () => {
  it('decodes frames, delays and the loop count', () => {
    const g = makeGif([[0, 1, 2, 3], [3, 2, 1, 0]], { delay: 20, loops: 0 });
    expect(isGif(g)).toBe(true);
    const r = decodeGif(g);
    expect(r.pages).toHaveLength(1);
    const p = r.pages[0];
    expect([p.width, p.height, p.frames.length, p.loops]).toEqual([2, 2, 2, 0]);
    expect(p.frames[0].delay).toBe(200);
    expect([...p.frames[0].raster.data.subarray(0, 8)]).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
    expect([...p.frames[1].raster.data.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
    expect(r.warnings).toEqual([]);
  });
  it('honors transparency and survives truncation', () => {
    const g = makeGif([[0, 1, 2, 3]], { transparent: 1 });
    const r = decodeGif(g);
    expect(r.pages[0].frames[0].raster.data[7]).toBe(0);
    expect(r.pages[0].hasAlpha).toBe(true);
    const cut = makeGif([[0, 1, 2, 3], [3, 2, 1, 0]]).subarray(0, 40);
    const r2 = decodeGif(cut);
    expect(r2.pages[0].frames.length).toBeGreaterThanOrEqual(1);
  });
  it('LZW round trip with code growth', () => {
    // A stream of literal codes only (clear, 0,1,2,3 ×n, end) at minCode 2 must grow the code size at the right time.
    const idx = [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3];
    const g = makeGif([idx]);
    const r = decodeGif(g);
    expect(r.pages[0].frames[0].raster.data.length).toBe(16);
    expect(lzwDecode(Uint8Array.from([0x04, 0x11]), 2, 1).length).toBeLessThanOrEqual(1);
  });
});

describe('TIFF', () => {
  it('decodes 8-bit grayscale, RGB, bilevel and palette strips', async () => {
    const gray = await decodeTiff(tiffFile({ pixels: [0, 128, 255, 64] }));
    expect(isTiff(tiffFile({ pixels: [0] }))).toBe(true);
    expect([...gray.pages[0].frames[0].raster.data.subarray(4, 8)]).toEqual([128, 128, 128, 255]);
    const rgb = await decodeTiff(tiffFile({ spp: 3, photo: 2, pixels: [255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9] }));
    expect([...rgb.pages[0].frames[0].raster.data.subarray(0, 12)]).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
    const bilevel = await decodeTiff(tiffFile({ bits: 1, photo: 0, pixels: [0b10000000, 0b01000000] }));
    expect([...bilevel.pages[0].frames[0].raster.data].filter((_, i) => i % 4 === 0)).toEqual([0, 255, 255, 0]);
    const pal = await decodeTiff(tiffFile({ photo: 3, pixels: [0, 1, 1, 0], palette: [0, 65535, 65535, 0, 0, 0] }));
    expect([...pal.pages[0].frames[0].raster.data.subarray(0, 8)]).toEqual([0, 255, 0, 255, 255, 0, 0, 255]);
    expect(pal.pages[0].paletteSize).toBe(2);
  });
  it('decodes PackBits and LZW with the horizontal predictor, and every page', async () => {
    const pb = await decodeTiff(tiffFile({ comp: 32773, pixels: [1, 2, 3, 4] }));
    expect([...pb.pages[0].frames[0].raster.data].filter((_, i) => i % 4 === 0)).toEqual([1, 2, 3, 4]);
    expect([...packBits(Uint8Array.from([0xfe, 7, 1, 9, 8]), 5)]).toEqual([7, 7, 7, 9, 8]);
    const two = await decodeTiff(tiffFile({ pixels: [5, 6, 7, 8], pages: 2 }));
    expect(two.pages).toHaveLength(2);
    // LZW: encode "clear, 10, 20, 30, 40, end" as 9-bit big-endian codes.
    const codes = [256, 10, 20, 30, 40, 257];
    const bits: number[] = [];
    for (const c of codes) for (let b = 8; b >= 0; b--) bits.push((c >> b) & 1);
    const bytes = new Uint8Array(Math.ceil(bits.length / 8));
    bits.forEach((v, i) => { bytes[i >> 3] |= v << (7 - (i & 7)); });
    expect([...lzwTiff(bytes, 4)]).toEqual([10, 20, 30, 40]);
  });
  it('reports unsupported compression per page without failing the file', async () => {
    const f = tiffFile({ pixels: [1, 2, 3, 4], pages: 2 });
    // Set the first page's compression tag (259) to JPEG (7).
    const dv = new DataView(f.buffer);
    for (let o = 10; o < 10 + 9 * 12; o += 12) if (dv.getUint16(o, true) === 259) { dv.setUint16(o + 8, 7, true); break; }
    const r = await decodeTiff(f);
    expect(r.pages).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/JPEG/);
  });
});

describe('BMP, ICO', () => {
  it('decodes a 24-bit BMP and round-trips through the writer', () => {
    const f = bmp24(2, 2, [[255, 0, 0], [0, 255, 0], [0, 0, 255], [10, 20, 30]]);
    expect(isBmp(f)).toBe(true);
    const r = decodeBmp(f);
    const d = r.pages[0].frames[0].raster.data;
    expect([...d.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...d.subarray(12, 16)]).toEqual([10, 20, 30, 255]);
    const again = decodeBmp(encodeBmp(r.pages[0].frames[0].raster));
    expect([...again.pages[0].frames[0].raster.data]).toEqual([...d]);
    d[3] = 0;
    const withAlpha = encodeBmp(r.pages[0].frames[0].raster);
    expect(new DataView(withAlpha.buffer).getUint16(28, true)).toBe(32);
    expect(decodeBmp(withAlpha).pages[0].frames[0].raster.data[3]).toBe(0);
  });
  it('reads an ICO with a DIB entry and an AND mask', () => {
    // 2×2, 24-bit DIB with height doubled for the mask; mask hides pixel (1,0).
    const dib = new Uint8Array(40 + 2 * 8 + 2 * 4);
    const dv = new DataView(dib.buffer);
    dv.setUint32(0, 40, true); dv.setInt32(4, 2, true); dv.setInt32(8, 4, true); dv.setUint16(12, 1, true); dv.setUint16(14, 24, true);
    // rows bottom-up: row1 (y=1) then row0 (y=0); 8 bytes per row (6 used + padding)
    dib.set([0, 0, 255, 0, 255, 0], 40); dib.set([255, 0, 0, 9, 9, 9], 48);
    dib[56] = 0b00000000; dib[60] = 0b01000000; // mask rows bottom-up: y=1 none, y=0 hides x=1
    const ico = new Uint8Array(6 + 16 + dib.length);
    const idv = new DataView(ico.buffer);
    idv.setUint16(2, 1, true); idv.setUint16(4, 1, true); ico[6] = 2; ico[7] = 2; idv.setUint16(12, 24, true); idv.setUint32(14, dib.length, true); idv.setUint32(18, 22, true);
    ico.set(dib, 22);
    expect(isIco(ico)).toBe(true);
    const { entries } = readIco(ico);
    const { pages } = decodeIcoDibs(entries);
    const d = pages[0]!.frames[0].raster.data;
    expect([pages[0]!.width, pages[0]!.height]).toEqual([2, 2]);
    expect([...d.subarray(0, 4)]).toEqual([0, 0, 255, 255]);
    expect(d[7]).toBe(0);
    expect(pages[0]!.hasAlpha).toBe(true);
  });
});

describe('EXIF and container info', () => {
  it('parses orientation, make, resolution and the Exif IFD', () => {
    const e = parseExifBlock(exifBlock())!;
    expect(e.orientation).toBe(6);
    expect(e.make).toBe('Acme');
    expect(e.dpi).toEqual([300, 300]);
    expect(e.exposure).toBe('1/125 s');
    expect(e.tags.find((t) => t.name === 'Orientation')?.value).toBe('Rotated 90° CW');
  });
  it('finds the block inside a JPEG and a PNG', () => {
    const block = exifBlock();
    const app1 = [0xff, 0xe1, ...[(block.length + 8) >> 8, (block.length + 8) & 255], ...[...'Exif\0\0'].map((c) => c.charCodeAt(0)), ...block];
    const jpg = Uint8Array.from([0xff, 0xd8, ...app1, 0xff, 0xc0, 0, 11, 8, 0, 4, 0, 6, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
    expect(readExif(jpg)?.make).toBe('Acme');
    const ji = jpegInfo(jpg);
    expect([ji.width, ji.height]).toEqual([6, 4]);
    expect(ji.info.subsampling).toBe('4:2:0');
    expect(sniff(jpg)?.id).toBe('jpeg');
    const chunk = (type: string, data: number[]) => [(data.length >>> 24) & 255, (data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255, ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', [0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0]), ...chunk('eXIf', [...block]), ...chunk('IEND', [])]);
    expect(readExif(png)?.orientation).toBe(6);
    const pi = pngInfo(png);
    expect([pi.width, pi.height, pi.bitDepth, pi.hasAlpha]).toEqual([3, 2, 32, true]);
    expect(sniff(png)?.id).toBe('png');
  });
});

describe('settings', () => {
  it('converts plan-style keys and reads IrfanView-style key lists', () => {
    expect(planKeyToCanonical('Ctrl+Shift+O')).toBe('Mod-Shift-o');
    expect(planKeyToCanonical('Space')).toBe('Space');
    expect(planKeyToCanonical('+')).toBe('+'); // the name a typed + now has, however the keyboard makes it (U4)
    expect(planKeyToCanonical('F11')).toBe('F11');
    const r = parseKeyList('[Keys]\nRotate left=L\nNext file=Space\nview.fullScreen=Ctrl+Shift+F\nFrobnicate=Q\n; comment\n', new Set(['view.fullScreen']));
    expect(r.keymap).toEqual({ l: 'image.rotateLeft', Space: 'view.next', 'Mod-Shift-f': 'view.fullScreen' });
    expect(r.unknown).toEqual(['Frobnicate=Q']);
  });
  it('sanitizes imported preferences', () => {
    const p = sanitizePrefs({ theme: 'purple', menuLayout: 'xnview', qat: ['file.open', 3], keymap: { a: 'x', b: 2 }, jpegQuality: 500, bogus: 1 });
    expect(p).toEqual({ menuLayout: 'xnview', qat: ['file.open'], keymap: { a: 'x' }, jpegQuality: 100 });
  });
});
