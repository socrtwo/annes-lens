import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { isZip, readZip, readZipEntry } from '../../src/codecs/zip';
import { isEps, epsPreview } from '../../src/codecs/eps';
import { decodeTiff } from '../../src/codecs/tiff';
import { sniff } from '../../src/codecs/registry';

/** A ZIP with the given entries (name → bytes), deflated or stored, written like a simple archiver would. */
function makeZip(entries: [string, Uint8Array, boolean][]): Uint8Array {
  const parts: number[] = [];
  const central: number[] = [];
  const le16 = (v: number) => [v & 255, (v >> 8) & 255], le32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc = (u8: Uint8Array) => { let c = 0xffffffff; for (const b of u8) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  for (const [name, data, deflate] of entries) {
    const body = deflate ? new Uint8Array(deflateRawSync(data)) : data;
    const nm = [...new TextEncoder().encode(name)];
    const offset = parts.length;
    const common = [...le16(20), ...le16(0), ...le16(deflate ? 8 : 0), ...le16(0x6000), ...le16(0x5a21), ...le32(crc(data)), ...le32(body.length), ...le32(data.length), ...le16(nm.length)];
    parts.push(...le32(0x04034b50), ...common, ...le16(0), ...nm, ...body);
    central.push(...le32(0x02014b50), ...le16(20), ...common, ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(offset), ...nm);
  }
  const cdAt = parts.length;
  const eocd = [...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(entries.length), ...le16(entries.length), ...le32(central.length), ...le32(cdAt), ...le16(0)];
  return Uint8Array.from([...parts, ...central, ...eocd]);
}

describe('ZIP archives as folders', () => {
  it('lists entries from the central directory and inflates them', () => {
    const a = new TextEncoder().encode('hello picture bytes '.repeat(50)), b = Uint8Array.from([1, 2, 3, 4]);
    const z = makeZip([['comic/page 10.jpg', a, true], ['comic/page 2.png', b, false], ['comic/', new Uint8Array(0), false]]);
    expect(isZip(z)).toBe(true);
    expect(sniff(z)?.id).toBe('zip');
    const { entries, warnings } = readZip(z);
    expect(warnings).toEqual([]);
    expect(entries.map((e) => e.name)).toEqual(['comic/page 10.jpg', 'comic/page 2.png']);
    expect(entries[0].method).toBe(8); expect(entries[0].size).toBe(a.length);
    expect([...readZipEntry(z, entries[0])]).toEqual([...a]);
    expect([...readZipEntry(z, entries[1])]).toEqual([1, 2, 3, 4]);
    expect(new Date(entries[0].mtime).getFullYear()).toBe(2025);
  });
  it('scans local headers when the central directory is gone, and refuses encrypted entries', () => {
    const a = Uint8Array.from([9, 8, 7]);
    const z = makeZip([['x.png', a, false], ['y.png', a, true]]);
    const cut = z.subarray(0, z.length - 60);
    const { entries, warnings } = readZip(cut);
    expect(warnings[0]).toMatch(/truncated/);
    expect(entries.map((e) => e.name)).toEqual(['x.png', 'y.png']);
    expect([...readZipEntry(cut, entries[1])]).toEqual([9, 8, 7]);
    const enc = z.slice(); enc[6] |= 1; // encryption flag of the first local header
    const e = readZip(enc).entries[0]; e.encrypted = true;
    expect(() => readZipEntry(enc, e)).toThrow(/encrypted/);
  });
});

describe('EPS previews', () => {
  it('reads the TIFF preview of a DOS EPS and the header comments', async () => {
    const u8 = new Uint8Array(readFileSync('tests/fixtures/eps/dos-tiff.eps'));
    expect(isEps(u8)).toBe(true);
    expect(sniff(u8)?.id).toBe('eps');
    const pv = epsPreview(u8);
    expect(pv.kind).toBe('tiff');
    expect(pv.info.Title).toBe('Two pixels');
    expect(pv.info['Bounding box (points)']).toBe('0 0 20 10');
    const t = await decodeTiff(pv.bytes!);
    expect([t.pages[0].width, t.pages[0].height]).toEqual([2, 1]);
    expect([...t.pages[0].frames[0].raster.data]).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
  });
  it('decodes a %%BeginPreview bitmap', () => {
    const u8 = new Uint8Array(readFileSync('tests/fixtures/eps/bitmap.eps'));
    const pv = epsPreview(u8);
    expect(pv.kind).toBe('raster');
    const r = pv.raster!.pages[0];
    expect([r.width, r.height]).toEqual([8, 2]);
    expect(r.frames[0].raster.data[0]).toBe(0); // first pixel set = black
    expect(r.frames[0].raster.data[4]).toBe(255);
    expect(r.frames[0].raster.data[(8 + 7) * 4]).toBe(0); // last pixel of row 2
    expect(epsPreview(new TextEncoder().encode('%!PS-Adobe-3.0\n%%Title: none\nshowpage\n')).kind).toBe('none');
  });
});

describe('damaged compressed tars (R17)', () => {
  // A tar of six 60 KB text files, compressed with Python's bz2 (level 1: 100 KB blocks), lzma (xz) and gzip; then cut at 60%.
  for (const n of ['damage.tar.bz2', 'damage.tar.xz', 'damage.tar.gz']) it(`${n} cut short lists the files before the damage`, async () => {
    const { untarable, readTar } = await import('../../src/codecs/tar');
    const whole = new Uint8Array(readFileSync(`tests/fixtures/archives/${n}`));
    const full = await untarable(whole); expect(readTar(full!.tar).entries.length).toBe(6); expect(full!.warning).toBeUndefined();
    const cut = whole.slice(0, Math.floor(whole.length * 0.6));
    const t = await untarable(cut);
    expect(t?.warning, n).toMatch(/damaged after \d+ KB/);
    const r = readTar(t!.tar), ok = r.entries.length;
    expect(ok, n).toBeGreaterThanOrEqual(2); expect(ok).toBeLessThan(6);
    const text = new TextDecoder().decode(t!.tar.subarray(r.entries[0].offset, r.entries[0].offset + 40));
    expect(text).toMatch(/^file 0 line 0 value/);
  });
});
