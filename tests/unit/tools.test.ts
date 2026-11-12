import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { encodeQr, qrRaster, qrSvg } from '../../src/codecs/qr';
import { carvePictures } from '../../src/codecs/carve';
import { encryptPicture, decryptPicture, isQlpe } from '../../src/codecs/encrypt';

describe('qr', () => {
  it('encodes at the smallest version, with valid structure (verified against zxing-cpp during development)', () => {
    const q = encodeQr('Hello, World!', 'M', { boost: false });
    expect([q.version, q.size, q.ecl]).toEqual([1, 21, 'M']);
    const at = (x: number, y: number) => q.modules[y * q.size + x];
    for (let i = 0; i < 7; i++) { expect(at(i, 0)).toBe(1); expect(at(0, i)).toBe(1); expect(at(q.size - 1 - i, 0)).toBe(1); expect(at(0, q.size - 1 - i)).toBe(1); } // finder rings
    expect(at(7, 0)).toBe(0); expect(at(8, 6)).toBe(1); expect(at(9, 6)).toBe(0); expect(at(8, q.size - 8)).toBe(1); // separator, timing, dark module
    expect(encodeQr('x'.repeat(260), 'L', { boost: false }).version).toBe(10); expect(encodeQr('z'.repeat(2900), 'L').version).toBe(40);
    expect(() => encodeQr('z'.repeat(3000), 'L')).toThrow();
    expect(encodeQr('hi', 'L').ecl).toBe('H'); // boosted when room allows
    const r = qrRaster(q, 2, 1); expect(r.width).toBe((21 + 2) * 2); expect(r.data[3]).toBe(255);
    expect(qrSvg(q)).toContain('<svg'); expect(qrSvg(q).length).toBeGreaterThan(500);
  });
});

describe('carving', () => {
  it('finds JPEG, PNG and GIF pictures inside junk', () => {
    const jpg = new Uint8Array(readFileSync('tests/fixtures/meta/tagged.jpg')), png = new Uint8Array(readFileSync('tests/fixtures/meta/tagged.png'));
    const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 2, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255, 0x2c, 0, 0, 0, 0, 2, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0, 0x3b]);
    const junk = new Uint8Array(100).fill(0x41);
    const all = new Uint8Array([...junk, ...jpg, ...junk, ...png, ...gif, ...junk]);
    const found = carvePictures(all);
    expect(found.map((f) => f.format)).toEqual(['jpeg', 'png', 'gif']);
    expect(found[0].offset).toBe(100); expect(found[0].length).toBe(jpg.length); expect(found[1].length).toBe(png.length); expect([found[1].width, found[1].height]).toEqual([24, 16]); expect(found[2].length).toBe(gif.length); expect([found[2].width, found[2].height]).toEqual([2, 1]);
    expect(carvePictures(junk)).toEqual([]);
  });
});

describe('encrypted pictures', () => {
  it('round-trips with the right password and rejects a wrong one', async () => {
    const bytes = new Uint8Array(readFileSync('tests/fixtures/meta/tagged.jpg'));
    const pkg = await encryptPicture(bytes, 'scan-of-id.jpg', 'correct horse', 2000);
    expect(isQlpe(pkg)).toBe(true); expect(pkg.length).toBe(39 + 'scan-of-id.jpg'.length + bytes.length + 16);
    const back = await decryptPicture(pkg, 'correct horse'); expect(back.name).toBe('scan-of-id.jpg'); expect([...back.bytes]).toEqual([...bytes]);
    await expect(decryptPicture(pkg, 'wrong')).rejects.toThrow(/Wrong password/);
    const tampered = pkg.slice(); tampered[tampered.length - 5] ^= 1; await expect(decryptPicture(tampered, 'correct horse')).rejects.toThrow();
    await expect(decryptPicture(bytes, 'x')).rejects.toThrow(/Not an/);
  }, 20000);
});

it('carving 32 MB with 400 JPEGs passes each JPEG once (it took about 30 s; R18)', async () => {
  const { carvePictures } = await import('../../src/codecs/carve');
  // A minimal JPEG: SOI, SOF0 (8×8), SOS with one byte of data, EOI.
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 8, 0, 8, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0x12, 0xff, 0xd9]);
  const size = 32 * 1024 * 1024, u8 = new Uint8Array(size), gap = Math.floor(size / 400);
  for (let n = 0; n < 400; n++) u8.set(jpeg, n * gap + 7);
  const t0 = performance.now(); const found = carvePictures(u8, 1000); const ms = performance.now() - t0;
  expect(found.filter((c) => c.format === 'jpeg').length).toBe(400);
  expect(ms).toBeLessThan(5000);
});
