import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseXmp, updateXmp, scrubXmp, emptyXmp, parseXmpGps, formatXmpGps } from '../../src/meta/xmp';
import { readIptc, writeIptc, parseIim, buildIim } from '../../src/meta/iptc';
import { setXmp, getComment, setComment, stripMeta, removeGpsFromExif, hasGpsIfd, exifDates, mapExifDates, minimalExif, detectProvenance, md5, sha, parseExifDate, formatExifDate } from '../../src/meta/metaEdit';
import { extractMeta, exifOrientation } from '../../src/meta/metaWrite';
import { readExif } from '../../src/meta/exif';
import { sniff } from '../../src/codecs/registry';
import { jpegInfo, pngInfo } from '../../src/codecs/info';
const sizeOf = (u8: Uint8Array, format: string) => { const id = sniff(u8)?.id; if (id !== format) return null; if (format === 'jpeg') { const i = jpegInfo(u8) as any; return [i.width, i.height]; } if (format === 'png') { const i = pngInfo(u8) as any; return [i.width, i.height]; } const dv = new DataView(u8.buffer, u8.byteOffset); return [(dv.getUint32(24, true) & 0xffffff) + 1, (dv.getUint32(27, true) & 0xffffff) + 1]; };

const fx = (n: string) => new Uint8Array(readFileSync(`tests/fixtures/meta/${n}`));
const txt = (u8: Uint8Array | undefined) => (u8 ? new TextDecoder().decode(u8) : '');

describe('xmp', () => {
  it('reads the fixture packet (attributes, alt, bag, seq)', () => {
    const p = parseXmp(txt(extractMeta(fx('tagged.jpg')).xmp));
    expect(p.rating).toBe(3); expect(p.city).toBe('Bath'); expect(p.title).toBe('A title & more'); expect(p.keywords).toEqual(['one', 'two']); expect(p.creator).toEqual(['Jane Doe']); expect(p.personInImage).toEqual(['Bob']);
    expect(p.digitalSourceType).toContain('trainedAlgorithmicMedia');
  });
  it('updates properties in place and keeps the rest', () => {
    const orig = txt(extractMeta(fx('tagged.jpg')).xmp);
    const out = updateXmp(orig, { rating: 5, keywords: ['three'], title: 'New <title>', label: 'Red', favorite: true, flag: 'pick', lat: 51.5, lon: -0.125, citation: { repository: 'Somerset Archives', page: '12' } });
    const p = parseXmp(out);
    expect(p.rating).toBe(5); expect(p.keywords).toEqual(['three']); expect(p.title).toBe('New <title>'); expect(p.label).toBe('Red'); expect(p.favorite).toBe(true); expect(p.flag).toBe('pick');
    expect(p.lat).toBeCloseTo(51.5, 5); expect(p.lon).toBeCloseTo(-0.125, 5); expect(p.citation).toEqual({ repository: 'Somerset Archives', page: '12' });
    expect(p.city).toBe('Bath'); expect(p.creator).toEqual(['Jane Doe']); expect(p.personInImage).toEqual(['Bob']); // untouched
    expect(out.match(/<xmp:Rating>/g)!.length).toBe(1); expect(out).not.toMatch(/xmp:Rating=/);
    const cleared = parseXmp(updateXmp(out, { rating: undefined, keywords: [], favorite: false, lat: undefined, lon: undefined, citation: {} }));
    expect(cleared.rating).toBeUndefined(); expect(cleared.keywords).toBeUndefined(); expect(cleared.favorite).toBeUndefined(); expect(cleared.lat).toBeUndefined(); expect(cleared.citation).toBeUndefined();
  });
  it('creates a packet from nothing and scrubs location, people and history', () => {
    const p = parseXmp(updateXmp(null, { description: 'Caption', rights: '© 2026', creator: ['A', 'B'] }));
    expect(p).toMatchObject({ description: 'Caption', rights: '© 2026', creator: ['A', 'B'] });
    expect(parseXmp(emptyXmp())).toEqual({});
    const s = parseXmp(scrubXmp(updateXmp(txt(extractMeta(fx('tagged.jpg')).xmp), { lat: 1, lon: 2 }), { location: true, people: true, history: true }));
    expect(s.city).toBeUndefined(); expect(s.lat).toBeUndefined(); expect(s.personInImage).toBeUndefined(); expect(s.rating).toBe(3);
  });
  it('GPS forms', () => { expect(parseXmpGps('51,30N')).toBeCloseTo(51.5); expect(parseXmpGps('0,7,30W')).toBeCloseTo(-0.125); expect(parseXmpGps(formatXmpGps(-33.8688, true))).toBeCloseTo(-33.8688, 5); expect(formatXmpGps(51.5, true)).toBe('51,30N'); });
});

describe('iptc', () => {
  it('round-trips fields through APP13 and parses IIM', () => {
    const f = { title: 'Title', keywords: ['k1', 'k2'], byline: 'Jane Dóe', caption: 'A caption', copyright: '© Jane', city: 'Bath', dateCreated: '20200506' };
    const out = writeIptc(fx('tagged.jpg'), f);
    expect(readIptc(fx('tagged.jpg'))).toBeUndefined();
    expect(readIptc(out)).toEqual(f);
    expect(parseIim(buildIim(f))).toEqual(f);
    const again = writeIptc(out, { title: 'Only' });
    expect(readIptc(again)).toEqual({ title: 'Only' });
    expect(readIptc(writeIptc(again, null))).toBeUndefined();
    expect(readExif(out)?.model).toBe('TestModel'); // EXIF untouched
    expect(parseXmp(txt(extractMeta(out).xmp)).rating).toBe(3);
  });
});

describe('container edits', () => {
  for (const [name, format] of [['tagged.jpg', 'jpeg'], ['tagged.png', 'png'], ['tagged.webp', 'webp']] as const) {
    it(`replaces and removes the XMP packet in ${format} and keeps the picture decodable`, async () => {
      const src = fx(name);
      const out = setXmp(src, format, new TextEncoder().encode(updateXmp(txt(extractMeta(src).xmp), { rating: 1 })));
      expect(parseXmp(txt(extractMeta(out).xmp)).rating).toBe(1);
      expect(readExif(out)?.orientation).toBe(6);
      const gone = setXmp(out, format, null);
      expect(extractMeta(gone).xmp).toBeUndefined(); expect(readExif(gone)?.orientation).toBe(6);
      const fresh = setXmp(gone, format, new TextEncoder().encode(updateXmp(null, { rating: 2 })));
      expect(parseXmp(txt(extractMeta(fresh).xmp)).rating).toBe(2);
      expect(sizeOf(fresh, format)).toEqual([24, 16]);
    });
    it(`strips ${format} keeping the orientation only`, async () => {
      const src0 = fx(name), src = extractMeta(src0).xmp ? src0 : setXmp(src0, format, extractMeta(fx('tagged.jpg')).xmp!);
      const out = stripMeta(src, format, { orientation: true, exifReplacement: minimalExif({ orientation: 6 }) });
      const m = extractMeta(out);
      expect(m.xmp).toBeUndefined(); expect(readExif(out)?.orientation).toBe(6); expect(readExif(out)?.model).toBeUndefined();
      expect(getComment(out, format)).toBeUndefined();
      const bare = stripMeta(src, format, {});
      expect(extractMeta(bare).exif).toBeUndefined(); expect(bare.length).toBeLessThan(src.length);
      expect(sizeOf(bare, format)).toEqual([24, 16]);
      const keep = stripMeta(src, format, { exif: true, xmp: true });
      expect(readExif(keep)?.model).toBe('TestModel'); expect(parseXmp(txt(extractMeta(keep).xmp)).rating).toBe(3);
    });
  }
  it('comments in JPEG and PNG', () => {
    expect(getComment(fx('tagged.jpg'), 'jpeg')).toBe('A comment');
    const j = setComment(fx('tagged.jpg'), 'jpeg', 'Changed ✓'); expect(getComment(j, 'jpeg')).toBe('Changed ✓'); expect(getComment(setComment(j, 'jpeg', ''), 'jpeg')).toBeUndefined();
    const p = setComment(fx('tagged.png'), 'png', 'PNG note'); expect(getComment(p, 'png')).toBe('PNG note'); expect(readExif(p)?.orientation).toBe(6);
  });
  it('EXIF: GPS removal, dates in place, minimal block', () => {
    const exif = extractMeta(fx('tagged.jpg')).exif!;
    expect(hasGpsIfd(exif)).toBe(true); expect(readExif(fx('tagged.jpg'))?.gps?.lat).toBeCloseTo(51.5);
    const noGps = removeGpsFromExif(exif);
    expect(hasGpsIfd(noGps)).toBe(false); expect(noGps.length).toBe(exif.length);
    const parsed = (() => { const j = fx('tagged.jpg'); const { setXmp: _s } = { setXmp }; void _s; return readExif(stripMeta(j, 'jpeg', { exifReplacement: noGps, xmp: true, comment: true })); })();
    expect(parsed?.gps).toBeUndefined(); expect(parsed?.model).toBe('TestModel'); expect(parsed?.orientation).toBe(6);
    expect(exifDates(exif)).toEqual({ dateTime: '2020:05:06 07:08:09', original: '2020:05:06 07:08:09', digitized: '2020:05:06 07:08:10' });
    const shifted = mapExifDates(exif, (old) => formatExifDate(new Date(parseExifDate(old)!.getTime() + 3600e3)));
    expect(exifDates(shifted)).toEqual({ dateTime: '2020:05:06 08:08:09', original: '2020:05:06 08:08:09', digitized: '2020:05:06 08:08:10' });
    expect(shifted.length).toBe(exif.length);
    const min = minimalExif({ orientation: 8, artist: 'Me', copyright: '© Me' })!;
    expect(exifOrientation(min)).toBe(8); const r = readExif(stripMeta(fx('tagged.jpg'), 'jpeg', { exifReplacement: min })); expect(r?.artist).toBe('Me'); expect(r?.copyright).toBe('© Me');
    expect(minimalExif({ orientation: 1 })).toBeNull();
  });
  it('detects content credentials boxes and reads the digital source type', () => {
    expect(detectProvenance(fx('tagged.jpg')).c2pa).toBe(false);
    const box = new TextEncoder().encode('JP\0\0\0\0\0\x20jumbc2pa.manifest');
    const withC2pa = new Uint8Array([0xff, 0xd8, 0xff, 0xeb, (box.length + 2) >> 8, (box.length + 2) & 255, ...box, ...fx('tagged.jpg').subarray(2)]);
    const p = detectProvenance(withC2pa); expect(p.c2pa).toBe(true); expect(p.where).toEqual(['JPEG APP11 JUMBF']); expect(p.jumbfLabels).toContain('c2pa.manifest');
  });
  it('checksums', async () => {
    expect(md5(new Uint8Array(0))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5(new TextEncoder().encode('The quick brown fox jumps over the lazy dog'))).toBe('9e107d9d372bb6826bd81d3542a419d6');
    expect(md5(new Uint8Array(100).fill(97))).toBe('36a92cc94a9e0fa21f625f8bfb007adf');
    expect(await sha(new Uint8Array(0), 'SHA-256')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

// ---- Edits that must not lose or leave behind what they are not about ----------------------------------------------
import { writeRegions, readRegions } from '../../src/meta/xmp';
import { replaceExif, pngChunks, buildPng } from '../../src/meta/metaEdit';
import { clipUtf8 } from '../../src/meta/iptc';
import { jpegSegments } from '../../src/meta/iptc';

describe('XMP attributes and people', () => {
  const packet = (attrs: string, body = '') => `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"${attrs}>${body}</rdf:Description></rdf:RDF></x:xmpmeta>`;
  it('an attribute value ends at the quote it began with', () => {
    const xml = packet(` photoshop:City="Coeur d'Alene" photoshop:State='Idaho "the Gem State"'`);
    const p = parseXmp(xml);
    expect([p.city, p.state]).toEqual(["Coeur d'Alene", 'Idaho "the Gem State"']);
    // Writing another field, and replacing this one, leaves a packet that still reads whole.
    const next = updateXmp(xml, { rating: 4 }), p2 = parseXmp(next);
    expect([p2.city, p2.state, p2.rating]).toEqual(["Coeur d'Alene", 'Idaho "the Gem State"', 4]);
    const moved = updateXmp(xml, { city: 'Boise' });
    expect(parseXmp(moved).city).toBe('Boise'); expect(moved).not.toMatch(/Alene/);
    expect((moved.match(/</g) || []).length).toBe((moved.match(/>/g) || []).length);
  });
  it('writing regions keeps the people who are named without a region', () => {
    const xml = packet('', '<Iptc4xmpExt:PersonInImage><rdf:Bag><rdf:li>Bob</rdf:li><rdf:li>Carol</rdf:li></rdf:Bag></Iptc4xmpExt:PersonInImage>');
    const area = { x: 0.5, y: 0.5, w: 0.1, h: 0.1 };
    const one = writeRegions(xml, [{ name: 'Alice', type: 'Face', area }], { w: 100, h: 100 });
    expect(parseXmp(one).personInImage).toEqual(['Bob', 'Carol', 'Alice']);
    // Renaming the region replaces its name; removing every region leaves the others.
    const renamed = writeRegions(one, [{ name: 'Alicia', type: 'Face', area }], { w: 100, h: 100 });
    expect(parseXmp(renamed).personInImage).toEqual(['Bob', 'Carol', 'Alicia']); expect(readRegions(renamed).regions.map((r) => r.name)).toEqual(['Alicia']);
    const none = writeRegions(renamed, [], null);
    expect(parseXmp(none).personInImage).toEqual(['Bob', 'Carol']); expect(readRegions(none).regions).toEqual([]);
  });
});

describe('Remove Location, Shift Dates and Strip', () => {
  const find = (hay: Uint8Array, needle: number[]) => { outer: for (let i = 0; i + needle.length <= hay.length; i++) { for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer; return i; } return -1; };
  it('Remove Location erases the coordinates, not only the pointer to them', () => {
    const exif = extractMeta(fx('tagged.jpg')).exif!, le = exif[0] === 0x49;
    const r = (n: number, d: number) => (le ? [n, 0, 0, 0, d, 0, 0, 0] : [0, 0, 0, n, 0, 0, 0, d]);
    const lat = [...r(51, 1), ...r(30, 1)], lon = [...r(0, 1), ...r(7, 1), ...r(30, 1)];     // 51°30′N, 0°7′30″W as the file stores them
    expect(find(exif, lat)).toBeGreaterThan(0); expect(find(exif, lon)).toBeGreaterThan(0);
    const out = removeGpsFromExif(exif);
    expect(out.length).toBe(exif.length); expect(hasGpsIfd(out)).toBe(false);
    expect(find(out, lat)).toBe(-1); expect(find(out, lon)).toBe(-1);
    expect(exifDates(out).dateTime).toBe('2020:05:06 07:08:09');                                    // the rest still reads
    expect(readExif(replaceExif(fx('tagged.jpg'), 'jpeg', out))?.make).toBe('TestMake');
  });
  it('an EXIF edit leaves every other part of the file where it was', () => {
    const jpg = fx('tagged.jpg'), segs = jpegSegments(jpg), last = segs[segs.length - 1], at = last.start + 2 + last.len;
    const app = (marker: number, text: string) => { const b = [...text].map((c) => c.charCodeAt(0) & 255); return Uint8Array.from([0xff, marker, (b.length + 2) >> 8, (b.length + 2) & 255, ...b]); };
    const mpf = app(0xe2, 'MPF\0II*\0 index of a gain map'), ext = app(0xe1, 'http://ns.adobe.com/xmp/extension/\0' + '0123456789ABCDEF0123456789ABCDEF' + 'more xmp'), c2 = app(0xeb, 'JP\0\0 jumb c2pa'), tail = Uint8Array.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9, 9, 9]);
    const rich = new Uint8Array(jpg.length + mpf.length + ext.length + c2.length + tail.length);
    rich.set(jpg.subarray(0, at)); rich.set(mpf, at); rich.set(ext, at + mpf.length); rich.set(c2, at + mpf.length + ext.length); rich.set(jpg.subarray(at), at + mpf.length + ext.length + c2.length); rich.set(tail, rich.length - tail.length);
    const out = replaceExif(rich, 'jpeg', removeGpsFromExif(extractMeta(rich).exif!));
    expect(out.length).toBe(rich.length);
    for (const part of [mpf, ext, c2, tail]) expect(find(out, [...part])).toBe(find(rich, [...part]));
    expect(hasGpsIfd(extractMeta(out).exif!)).toBe(false);
    // Strip, by contrast, is for removing: it takes those parts out.
    const stripped = stripMeta(rich, 'jpeg', {});
    expect(find(stripped, [...mpf])).toBe(-1); expect(find(stripped, [...c2])).toBe(-1);
  });
  it('Strip removes content credentials from PNG and WebP (they carry the prompt and a thumbnail of the source)', () => {
    const chunks = pngChunks(fx('tagged.png'))!, idat = chunks.findIndex((c) => c.type === 'IDAT');
    chunks.splice(idat, 0, { type: 'caBX', data: new TextEncoder().encode('jumb c2pa.claim prompt: a secret') });
    const png = buildPng(chunks);
    expect(detectProvenance(png).c2pa).toBe(true);
    const cleanPng = stripMeta(png, 'png', {});
    expect(detectProvenance(cleanPng).c2pa).toBe(false); expect(sizeOf(cleanPng, 'png')).toEqual(sizeOf(png, 'png'));
    const webp = fx('tagged.webp'), body = new TextEncoder().encode('jumb c2pa.claim prompt: a secret!'), chunk = Uint8Array.from([0x43, 0x32, 0x50, 0x41, body.length, 0, 0, 0, ...body, ...(body.length & 1 ? [0] : [])]);
    const withC2 = new Uint8Array(webp.length + chunk.length); withC2.set(webp); withC2.set(chunk, webp.length);
    new DataView(withC2.buffer).setUint32(4, withC2.length - 8, true);
    expect(detectProvenance(withC2).c2pa).toBe(true);
    const cleanWebp = stripMeta(withC2, 'webp', {});
    expect(detectProvenance(cleanWebp).c2pa).toBe(false); expect(sizeOf(cleanWebp, 'webp')).toEqual(sizeOf(webp, 'webp'));
  });
  it('an XMP packet too large for a JPEG is refused aloud, not written as nothing', () => {
    const jpg = fx('tagged.jpg'), huge = new TextEncoder().encode(`<x:xmpmeta>${'k'.repeat(70000)}</x:xmpmeta>`);
    expect(() => setXmp(jpg, 'jpeg', huge)).toThrow(/larger than the 64 KB a JPEG holds/);
    expect(txt(extractMeta(jpg).xmp)).toContain('Bath');                                       // the file in hand is untouched
    expect(extractMeta(setXmp(fx('tagged.png'), 'png', huge)).xmp!.length).toBe(huge.length);   // PNG has no such limit
  });
});

describe('IPTC: what the app has no field for is kept', () => {
  it('carries unknown datasets over, converts old text to UTF-8, and never cuts inside a character', () => {
    const ds = (rec: number, n: number, bytes: number[]) => [0x1c, rec, n, bytes.length >> 8, bytes.length & 255, ...bytes];
    const latin = (s: string) => [...s].map((c) => c.charCodeAt(0));
    // An old block without the UTF-8 marker: urgency (2:10), a subject code (2:12), a contact (2:118) in Latin-1, a program's record (2:221), and a caption.
    const old = Uint8Array.from([...ds(1, 20, latin('ENV')), ...ds(2, 10, latin('5')), ...ds(2, 12, latin('IPTC:04000000')), ...ds(2, 118, latin('Agence Générale')), ...ds(2, 221, [1, 2, 3]), ...ds(2, 120, latin('Vieux café'))]);
    const withOld = writeIptc(fx('tagged.jpg'), null);                                        // start from a file without IPTC
    const app13 = (iim: Uint8Array) => { const res = [...latin('Photoshop 3.0\0'), ...latin('8BIM'), 0x04, 0x04, 0, 0, (iim.length >>> 24) & 255, (iim.length >> 16) & 255, (iim.length >> 8) & 255, iim.length & 255, ...iim, ...(iim.length & 1 ? [0] : [])]; return Uint8Array.from([0xff, 0xed, (res.length + 2) >> 8, (res.length + 2) & 255, ...res]); };
    const seg = app13(old), base = new Uint8Array(withOld.length + seg.length); base.set(withOld.subarray(0, 2)); base.set(seg, 2); base.set(withOld.subarray(2), 2 + seg.length);
    expect(readIptc(base)!.caption).toBe('Vieux café');
    const out = writeIptc(base, { ...readIptc(base)!, title: 'é'.repeat(200) });
    const iim = (() => { for (const s of jpegSegments(out)) if (s.marker === 0xed) { const b = out.subarray(s.start + 4, s.start + 2 + s.len); const at = 14 + 4 + 2 + 2 + 4; return b.subarray(at); } throw new Error('no APP13'); })();
    const text = new TextDecoder().decode(iim);
    const f = readIptc(out)!;
    expect(f.caption).toBe('Vieux café');
    expect(f.title).toBe('é'.repeat(127));                                                    // 255 bytes hold 127 two-byte characters: cut between characters
    expect(text).toContain('IPTC:04000000'); expect(text).toContain('Agence Générale'); expect(text).toContain('ENV');
    expect([...iim].join(',')).toContain([0x1c, 2, 221, 0, 3, 1, 2, 3].join(','));              // the binary record, byte for byte
    expect([...iim].join(',')).toContain([0x1c, 2, 10, 0, 1, 0x35].join(','));
    expect([...clipUtf8(new TextEncoder().encode('a€b'), 3)]).toEqual([0x61]);                  // € is three bytes: it does not fit, so it is left out whole
  });
});
