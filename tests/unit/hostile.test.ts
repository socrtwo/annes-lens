/**
 * Small crafted files that used to hang or exhaust memory: each must now end quickly, with a picture or a plain
 * error. Also the two wrong-result fixes that came with them (interlaced GIF rows, median cut on a dominant color).
 */
import { describe, it, expect } from 'vitest';
import { SevenZip } from '../../src/codecs/sevenzip';
import { xzDecode } from '../../src/codecs/lzma';
import { readTar } from '../../src/codecs/tar';
import { decodeExr } from '../../src/codecs/exr';
import { decodeFits } from '../../src/codecs/fits';
import { decodeRice } from '../../src/codecs/fitsTiles';
import { decodeBmp } from '../../src/codecs/bmp';
import { decodeDds } from '../../src/codecs/dds';
import { decodeGif, lzwDecode } from '../../src/codecs/gif';
import { medianCut } from '../../src/codecs/palette';

const within = async <T>(ms: number, f: () => T | Promise<T>): Promise<{ ok: boolean; value?: T; error?: string; ms: number }> => { const t = Date.now(); try { const value = await f(); return { ok: true, value, ms: Date.now() - t }; } catch (e: any) { return { ok: false, error: String(e?.message || e), ms: Date.now() - t }; } finally { expect(Date.now() - t, 'time').toBeLessThan(ms); } };
const le32 = (v: number) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
const card = (k: string, v: string) => `${k.padEnd(8)}= ${v.padStart(20)}`.padEnd(80);
const fitsHeader = (cards: string[]) => { const text = [...cards, 'END'.padEnd(80)].join(''); const u = new Uint8Array(Math.ceil(text.length / 2880) * 2880).fill(32); for (let i = 0; i < text.length; i++) u[i] = text.charCodeAt(i); return u; };

describe('crafted files end quickly', () => {
  it('7z: a count far larger than the header, and a packed header that unpacks to itself', async () => {
    // Signature, version, CRCs, next-header offset 0 and size 11; the header declares 0xFFFFFFF0 files.
    const head = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const big = Uint8Array.from([...head, 0x01, 0x05, 0xf0, 0xff, 0xff, 0xff, 0xf0, 0x14, 0x05, 0x01, 0x00]);
    const r = await within(2000, () => SevenZip.open(big));
    expect(r.ok).toBe(false); expect(r.error).toMatch(/count larger than the header|Truncated|Bad 7z/);
    // An encoded header: one Copy-coded folder whose packed stream is the header itself (pack position 0, size 23).
    const hdr = [0x17, 0x06, 0x00, 0x01, 0x09, 23, 0x00, 0x07, 0x0b, 0x01, 0x00, 0x01, 0x01, 0x00, 0x0c, 23, 0x00, 0x00];
    const self = Uint8Array.from([...head.slice(0, 20), hdr.length, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...hdr, 0, 0, 0, 0, 0]);
    const s = await within(3000, () => SevenZip.open(self));
    expect(s.ok).toBe(false);
  });
  it('xz: an index that claims more records than the file holds', async () => {
    const u = Uint8Array.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x00, 0x00, 0, 0, 0, 0, /* index */ 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f, 0, 0]);
    const r = await within(2000, () => xzDecode(u));
    expect(r.ok).toBe(false); expect(r.error).toMatch(/Corrupt \.xz index|cut off|Bad \.xz/);
  });
  it('tar: a negative size does not send the reader backwards', async () => {
    const block = (name: string, size: string) => { const b = new Uint8Array(512); for (let i = 0; i < name.length; i++) b[i] = name.charCodeAt(i); for (let i = 0; i < size.length; i++) b[124 + i] = size.charCodeAt(i); b[156] = 48; 'ustar'.split('').forEach((c, i) => { b[257 + i] = c.charCodeAt(0); }); let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : b[i]; const cs = sum.toString(8).padStart(6, '0'); for (let i = 0; i < 6; i++) b[148 + i] = cs.charCodeAt(i); b[154] = 0; b[155] = 32; return b; };
    const u = new Uint8Array(2048); u.set(block('a.txt', '00000000000'), 0); u.set(block('b.txt', '-0002000'), 512);
    const r = await within(2000, () => readTar(u));
    expect(r.ok).toBe(true); expect(r.value!.entries.length).toBeLessThanOrEqual(2); expect(r.value!.warnings.join(' ')).toMatch(/damaged/);
  });
  it('OpenEXR: a negative attribute size', async () => {
    const u = Uint8Array.from([0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0, 0x61, 0, 0x62, 0, ...le32(-8 >>> 0), 0, 0, 0, 0, 0, 0, 0, 0]);
    const r = await within(2000, () => decodeExr(u));
    expect(r.ok).toBe(false);
  });
  it('FITS: a negative axis length, and a Rice block size of zero', async () => {
    const neg = new Uint8Array(5760); neg.set(fitsHeader([card('SIMPLE', 'T'), card('BITPIX', '8'), card('NAXIS', '1'), card('NAXIS1', '-5760')]), 0); neg.set(fitsHeader([card('XTENSION', "'IMAGE   '")]), 2880);
    const r = await within(2000, () => decodeFits(neg, 'neg.fits'));
    expect(r.ok).toBe(false); expect(r.error).toMatch(/NAXIS1/);
    expect(() => decodeRice(new Uint8Array(16), 100, 2, 0)).toThrow(/block size/);
    expect(() => decodeRice(new Uint8Array(16), 100, 2, -3)).toThrow(/block size/);
    expect(decodeRice(new Uint8Array(16), 8, 2, 32).length).toBe(8);
  });
  it('BMP and DDS: a channel mask of all ones', async () => {
    // BITMAPINFOHEADER, 2 × 1, 32 bits, BI_BITFIELDS with the red mask 0xFFFFFFFF.
    const bmp = Uint8Array.from([0x42, 0x4d, ...le32(74), 0, 0, 0, 0, ...le32(66), ...le32(40), ...le32(2), ...le32(1), 1, 0, 32, 0, ...le32(3), ...le32(8), ...le32(0), ...le32(0), ...le32(0), ...le32(0), ...le32(0xffffffff), ...le32(0), ...le32(0), 1, 2, 3, 4, 5, 6, 7, 8]);
    const b = await within(2000, () => decodeBmp(bmp));
    expect(b.ok).toBe(true); expect([b.value!.pages[0].width, b.value!.pages[0].height]).toEqual([2, 1]);
    const dds = new Uint8Array(128 + 16); dds.set([0x44, 0x44, 0x53, 0x20, ...le32(124), ...le32(0x1007), ...le32(2), ...le32(2), ...le32(8), ...le32(0), ...le32(0xffffffff)], 0);
    dds.set([...le32(32), ...le32(0x40), ...le32(0), ...le32(32), ...le32(0xffffffff), ...le32(0xff00), ...le32(0xff), ...le32(0)], 76);
    const d = await within(3000, () => decodeDds(dds));
    expect(d.ms).toBeLessThan(3000);
  });
  it('GIF: an LZW code size outside the table', () => {
    expect(() => lzwDecode(Uint8Array.from([0, 0]), 30, 4)).toThrow(/code size/);
    expect(() => lzwDecode(Uint8Array.from([0, 0]), 0, 4)).toThrow(/code size/);
  });
});

describe('wrong results fixed with them', () => {
  it('an interlaced GIF comes out with its rows in order', () => {
    // 1 × 8, eight gray levels, interlaced: the data rows are picture rows 0, 4, 2, 6, 1, 3, 5, 7.
    const w = 1, h = 8, order = [0, 4, 2, 6, 1, 3, 5, 7];
    const palette: number[] = []; for (let i = 0; i < 8; i++) palette.push(i * 30, i * 30, i * 30);
    // LZW with code size 3: clear (8), the eight indexes as literal codes, end (9); 4-bit codes while the table is small.
    const codes = [8, ...order, 9]; const bits: number[] = []; let size = 4, next = 10;
    for (const [k, c] of codes.entries()) { for (let b = 0; b < size; b++) bits.push((c >> b) & 1); if (k >= 2) { next++; if (next === 1 << size && size < 12) size++; } }
    const data: number[] = []; for (let i = 0; i < bits.length; i += 8) { let v = 0; for (let b = 0; b < 8; b++) v |= (bits[i + b] || 0) << b; data.push(v); }
    const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, w, 0, h, 0, 0xf2, 0, 0, ...palette, 0x2c, 0, 0, 0, 0, w, 0, h, 0, 0x40, 3, data.length, ...data, 0, 0x3b]);
    const g = decodeGif(gif);
    const col = Array.from({ length: h }, (_, y) => g.pages[0].frames[0].raster.data[y * 4]);
    expect(col).toEqual([0, 30, 60, 90, 120, 150, 180, 210]);
  });
  it('median cut keeps splitting when one color outweighs all the others', () => {
    // 60 % white and a 4,000-color gradient.
    const n = 100 * 100, d = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) { const o = i * 4; if (i < n * 0.6) { d[o] = d[o + 1] = d[o + 2] = 255; } else { const k = i - n * 0.6; d[o] = k & 255; d[o + 1] = (k >> 4) & 255; d[o + 2] = (k * 7) & 255; } d[o + 3] = 255; }
    const p = medianCut(d, 256);
    expect(p.colors.length).toBeGreaterThan(200);
    expect(p.colors.some((c) => c[0] > 250 && c[1] > 250 && c[2] > 250)).toBe(true);
  });
});

// ---- Memory: what one small file may make the decoders hold ------------------------------------------------------
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { decodeTiff, readIfd } from '../../src/codecs/tiff';
import { decodeUtahRle } from '../../src/codecs/workstation';
import { inflate } from '../../src/codecs/inflate';
import { readZip, readZipEntry } from '../../src/codecs/zip';
import { decodeLimits, latin1, checkUnpacked, MAX_UNPACKED } from '../../src/codecs/limits';
import { decodeDicom } from '../../src/codecs/dicom';
import { decodeIff } from '../../src/codecs/retro';
import { decodePnm } from '../../src/codecs/pnm';

/** A little-endian TIFF of `pages` gray 8-bit pages of w × h (uncompressed), with an optional ImageDescription on the first. */
function grayTiff(pages: number, w: number, h: number, description = ''): Uint8Array {
  const parts: number[] = [0x49, 0x49, 42, 0, 8, 0, 0, 0];
  const le16 = (v: number) => [v & 255, v >> 8];
  for (let p = 0; p < pages; p++) {
    const tags: [number, number, number, number][] = [[256, 3, 1, w], [257, 3, 1, h], [258, 3, 1, 8], [259, 3, 1, 1], [262, 3, 1, 1], [273, 4, 1, 0], [277, 3, 1, 1], [278, 3, 1, h], [279, 4, 1, w * h]];
    if (p === 0 && description) tags.push([270, 2, description.length + 1, 0]);
    tags.sort((a, b) => a[0] - b[0]);
    const ifdAt = parts.length, dataAt = ifdAt + 2 + tags.length * 12 + 4, descAt = dataAt + w * h, next = p === pages - 1 ? 0 : descAt + (p === 0 && description ? description.length + 1 : 0);
    parts.push(...le16(tags.length));
    for (const [tag, type, count, value] of tags) parts.push(...le16(tag), ...le16(type), ...le32(count), ...le32(tag === 273 ? dataAt : tag === 270 ? descAt : value));
    parts.push(...le32(next));
    for (let i = 0; i < w * h; i++) parts.push((p * 40 + i) & 255);
    if (p === 0 && description) { for (let i = 0; i < description.length; i++) parts.push(description.charCodeAt(i)); parts.push(0); }
  }
  return Uint8Array.from(parts);
}

describe('a small file cannot make the decoders hold gigabytes', () => {
  it('TIFF: a megabyte whose 4,096 tags each claim a million values', async () => {
    const u8 = new Uint8Array(1 << 20); u8.set([0x49, 0x49, 42, 0, 8, 0, 0, 0]); const dv = new DataView(u8.buffer);
    dv.setUint16(8, 4096, true);
    for (let k = 0; k < 4096; k++) { const e = 10 + k * 12; dv.setUint16(e, 1000 + k, true); dv.setUint16(e + 2, 1, true); dv.setUint32(e + 4, 1000000, true); dv.setUint32(e + 8, 0, true); }
    const r = await within(4000, () => readIfd(u8, 8, true));
    expect(r.ok).toBe(true);
    let total = 0; for (const t of r.value!.tags.values()) total += t.values.length;
    expect(total).toBeLessThanOrEqual(4 << 20); expect(r.value!.tags.size).toBe(4096);
  });
  it('TIFF: pages beyond the budget are left out and said so; a very long description is read', async () => {
    const keep = decodeLimits.totalPixels;
    try {
      decodeLimits.totalPixels = 250;                                  // 10 × 10 pages: two fit, the third does not
      const d = await decodeTiff(grayTiff(5, 10, 10));
      expect(d.pages.length).toBe(2);
      expect(d.warnings.join(' ')).toMatch(/Page 3 and the pages after it are not shown/);
      decodeLimits.totalPixels = keep;
      expect((await decodeTiff(grayTiff(5, 10, 10))).pages.length).toBe(5);
    } finally { decodeLimits.totalPixels = keep; }
    const long = await decodeTiff(grayTiff(1, 2, 2, 'x'.repeat(300000)));   // OME-TIFF descriptions are this long
    expect(long.info.description.length).toBe(300000); expect(long.pages[0].width).toBe(2);
  });
  it('GIF: frames beyond the budget are left out and said so', () => {
    const frame = [0x21, 0xf9, 4, 0, 5, 0, 0, 0, 0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0, 2, 2, 0x84, 0x51, 0];       // 2 × 2, four literal codes
    const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 2, 0, 2, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255, ...Array(20).fill(frame).flat(), 0x3b]);
    const keep = decodeLimits.totalPixels;
    try {
      expect(decodeGif(gif).pages[0].frames.length).toBe(20);
      decodeLimits.totalPixels = 4 * 6;
      const d = decodeGif(gif);
      expect(d.pages[0].frames.length).toBe(6); expect(d.warnings.join(' ')).toMatch(/Only the first 6 frames are shown/);
    } finally { decodeLimits.totalPixels = keep; }
  });
  it('color cycling makes no more frames than its budget (and none for a picture too large to animate)', () => {
    const iff = new Uint8Array(readFileSync('tests/fixtures/retro/cycle.iff'));
    const full = decodeIff(iff).pages[0], keep = decodeLimits.synthPixels;
    expect(full.frames.length).toBeGreaterThan(2);
    try {
      decodeLimits.synthPixels = full.width * full.height * 3;
      expect(decodeIff(iff).pages[0].frames.length).toBe(3);
      decodeLimits.synthPixels = 1;
      const one = decodeIff(iff).pages[0];
      expect(one.frames.length).toBe(1); expect(one.notes.join(' ')).toMatch(/not played \(the picture is too large to animate\)/);
    } finally { decodeLimits.synthPixels = keep; }
  });
  it('inflate and zip: no more output than the limit, whatever the stream holds or the header says', () => {
    const zeros = new Uint8Array(8 << 20), packed = new Uint8Array(deflateRawSync(zeros));     // 8 MB in about 8 KB
    expect(packed.length).toBeLessThan(20000);
    const all = inflate(packed); expect([all.complete, all.data.length]).toEqual([true, 8 << 20]);
    const cut = inflate(packed, 0, 1 << 20);
    expect(cut.complete).toBe(false); expect(cut.error).toMatch(/unpacks to more than 1 MB/); expect(cut.data.length).toBeLessThanOrEqual(1 << 20);
    // A hint far beyond the input is not allocated up front.
    const hinted = inflate(Uint8Array.from([0x03, 0x00]), 400 << 20); expect(hinted.data.length).toBe(0);
    // A zip entry saying it holds 1 KB gets 1 KB, though its stream goes on for megabytes; one saying a terabyte is refused.
    const name = [...'a.bin'].map((c) => c.charCodeAt(0));
    const local = [0x50, 0x4b, 3, 4, 20, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...le32(packed.length), ...le32(1024), name.length, 0, 0, 0, ...name];
    const central = [0x50, 0x4b, 1, 2, 20, 0, 20, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...le32(packed.length), ...le32(1024), name.length, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...le32(0), ...name];
    const cdAt = local.length + packed.length, end = [0x50, 0x4b, 5, 6, 0, 0, 0, 0, 1, 0, 1, 0, ...le32(central.length), ...le32(cdAt), 0, 0];
    const zip = Uint8Array.from([...local, ...packed, ...central, ...end]);
    const z = readZip(zip); expect(z.entries.map((e) => [e.name, e.size])).toEqual([['a.bin', 1024]]);
    expect(readZipEntry(zip, z.entries[0]).length).toBeLessThanOrEqual(1024);
    expect(() => readZipEntry(zip, { ...z.entries[0], size: 2 ** 40 })).toThrow(/unpacks to more than 512 MB/);
    expect(() => checkUnpacked(MAX_UNPACKED + 1, 'x')).toThrow(); expect(() => checkUnpacked(MAX_UNPACKED, 'x')).not.toThrow();
  });
  it('long runs of bytes become text without overflowing the stack', () => {
    const big = new Uint8Array(1_500_000).fill(65);
    expect(latin1(big).length).toBe(1_500_000);
    expect(latin1(Array.from({ length: 300000 }, () => 66)).length).toBe(300000);
    expect(latin1(Uint8Array.from([72, 105, 0xe9, 0x80]))).toBe('Hié\u0080');                 // one character per byte, unlike a windows-1252 decoder
    expect(latin1(big, 10, 13)).toBe('AAA');
    // A PNM whose comment line is a megabyte long.
    const head = [...'P5\n#'].map((c) => c.charCodeAt(0)), tail = [...'\n2 1\n255\n'].map((c) => c.charCodeAt(0));
    const pnm = new Uint8Array(head.length + 1_000_000 + tail.length + 2); pnm.set(head); pnm.fill(0x61, head.length, head.length + 1_000_000); pnm.set(tail, head.length + 1_000_000); pnm.set([10, 200], pnm.length - 2);
    expect(decodePnm(pnm).pages[0].width).toBe(2);
  });
  it('DICOM and FITS: a header describing far more than the file holds is refused before memory is taken', async () => {
    const dcm = new Uint8Array(readFileSync('tests/fixtures/dicom/CT_small.dcm')), dv = new DataView(dcm.buffer);
    const good = await decodeDicom(dcm.slice()); expect(good.pages[0].width).toBeGreaterThan(0);
    // Rows (0028,0010), explicit VR little endian: 28 00 10 00 'US' 02 00 <value>.
    let at = -1; for (let i = 0; i + 10 < dcm.length; i++) if (dcm[i] === 0x28 && dcm[i + 1] === 0 && dcm[i + 2] === 0x10 && dcm[i + 3] === 0 && dcm[i + 4] === 0x55 && dcm[i + 5] === 0x53) { at = i; break; }
    expect(at).toBeGreaterThan(0);
    dv.setUint16(at + 8, 60000, true);
    const r = await within(3000, () => decodeDicom(dcm));
    expect(r.ok).toBe(false); expect(r.error).toMatch(/far too short for the/);
    // A FITS primary array of 12,000 × 12,000 doubles with one block of data behind it.
    const hdr = fitsHeader([card('SIMPLE', 'T'), card('BITPIX', '-64'), card('NAXIS', '2'), card('NAXIS1', '12000'), card('NAXIS2', '12000')]);
    const fits = new Uint8Array(hdr.length + 2880); fits.set(hdr);
    const f = await within(3000, () => decodeFits(fits));
    expect(f.ok ? f.value!.warnings.join(' ') : f.error).toMatch(/cut short|holds no image|no image/i);
  });
  it('Utah RLE: a color map larger than the file is refused', () => {
    const u = new Uint8Array(64); u.set([0x52, 0xcc, 0, 0, 0, 0, 8, 0, 8, 0, 2, 3, 8, 3, 31]);                // 3 maps of 2^31 entries
    expect(() => decodeUtahRle(u)).toThrow(/color map larger than the file/);
  });
});
