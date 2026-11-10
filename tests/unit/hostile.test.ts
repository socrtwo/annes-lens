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
