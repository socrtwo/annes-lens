import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { sniffMedia, readMedia, describeMedia, formatDuration } from '../../src/codecs/media';

const DIR = 'tests/fixtures/media/';
const fx = (n: string) => new Uint8Array(readFileSync(DIR + n));
const expected: Record<string, { note: string; duration: number; streams: { type: string; codec: string; width?: number; height?: number; channels?: number; sampleRate?: number }[]; tags: Record<string, string>; cover: boolean }> = JSON.parse(readFileSync(DIR + 'expected.json', 'utf8'));
const CODEC: Record<string, RegExp> = { vp9: /^VP9$/, vp8: /^VP8$/, h264: /^H\.264/, opus: /^Opus$/, aac: /^AAC$/, flac: /^FLAC$/, mjpeg: /^Motion JPEG$/, pcm_s16le: /^PCM$/, pcm_f32le: /^PCM \(float\)$/, pcm_s16be: /^PCM$/, theora: /^Theora$/, vorbis: /^Vorbis$/, mp3: /^MP3/ };

describe('video and audio containers (ffmpeg files; ffprobe\'s readings)', () => {
  for (const [n, e] of Object.entries(expected)) {
    it(`${n}: ${e.note}`, () => {
      const u8 = fx(n), s = sniffMedia(u8, n);
      expect(s, 'recognized').toBeTruthy();
      expect(s!.kind).toBe(e.streams.some((t) => t.type === 'video') ? 'video' : 'audio');
      const m = readMedia(u8, n)!;
      expect(m.warnings).toEqual([]);
      expect(m.duration, 'duration').toBeDefined();
      expect(Math.abs(m.duration! - e.duration), `duration ${m.duration} vs ${e.duration}`).toBeLessThan(n.endsWith('.mp3') ? 0.08 : 0.011);
      const tracks = m.tracks.filter((t) => t.kind === 'video' || t.kind === 'audio');
      expect(tracks.map((t) => t.kind)).toEqual(e.streams.map((t) => t.type));
      e.streams.forEach((t, i) => {
        const got = tracks[i];
        expect(got.codec, `codec ${t.codec}`).toMatch(CODEC[t.codec]);
        if (t.width) expect([got.width, got.height]).toEqual([t.width, t.height]);
        if (t.sampleRate) expect(got.sampleRate).toBe(t.sampleRate);
        if (t.channels) expect(got.channels).toBe(t.channels);
      });
      for (const [k, v] of Object.entries(e.tags)) expect(m.tags[k], `tag ${k}`).toBe(v);
      expect(!!m.cover, 'cover art').toBe(e.cover);
      if (m.cover) { expect(['image/jpeg', 'image/png']).toContain(m.cover.mime); expect(m.cover.bytes[0]).toBe(m.cover.mime === 'image/png' ? 0x89 : 0xff); }
      const d = describeMedia(m);
      expect(d.container).toBe(m.container);
      expect(d.duration).toMatch(/^1\.0\d s$/);
    });
  }
  it('names what the details show', () => {
    expect(formatDuration(3.456)).toBe('3.46 s');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3725.4)).toBe('1:02:05');
    const d = describeMedia(readMedia(fx('clip-vp9.webm'))!);
    expect(d.video).toBe('VP9, 64 × 48, 10 fps');
    expect(d.audio).toBe('Opus, 48 kHz, mono');
    expect([d.title, d.artist, d.album, d.date]).toEqual(['Fixture Title', 'Anne Lens', 'Test Album', '2024']);
    const a = describeMedia(readMedia(fx('clip-mjpeg.avi'))!);
    expect(a.video).toBe('Motion JPEG, 64 × 48, 10 fps');
    expect(a.audio).toBe('PCM, 44.1 kHz, mono, 16-bit');
    expect(describeMedia(readMedia(fx('tone.mp3'))!).audio).toBe('MP3 64 kbit/s, 44.1 kHz, mono');
    expect(describeMedia(readMedia(fx('tone-vbr.mp3'))!).audio).toBe('MP3 (VBR), 44.1 kHz, mono');
    expect(describeMedia(readMedia(fx('tone.flac'))!)['cover art']).toMatch(/^PNG, [\d.]+ KB$/);
    expect(readMedia(fx('clip-h264.mp4'))!.created).toBe('2024-03-12T10:15:00Z');
    expect(readMedia(fx('clip-h264.mp4'))!.tracks[0].codec).toMatch(/^H\.264 /);
    expect(describeMedia(readMedia(fx('clip-h264.mp4'))!).audio).toBe('AAC, 44.1 kHz, mono');
    expect(readMedia(fx('clip-3gp.3gp'))!.tracks[0].codec).toBe('H.264 Baseline');
  });
  it('leaves pictures and other files alone', () => {
    for (const f of ['tests/fixtures/modern/alpha.avif', 'tests/fixtures/jpx/big.jp2', 'tests/fixtures/dicom/CT_small.dcm', 'tests/fixtures/modern/anim-0.png', 'tests/fixtures/flic/anim.flc', 'tests/fixtures/jpx/icon.icns']) {
      let u8: Uint8Array; try { u8 = new Uint8Array(readFileSync(f)); } catch { continue; }
      expect(sniffMedia(u8, f), f).toBeNull();
    }
    expect(sniffMedia(new Uint8Array(100), 'x.mp3')).toBeNull();
    const cut = fx('clip-h264.mov').subarray(0, 200); // its movie header is at the end
    expect(sniffMedia(cut)?.kind).toBe('video');
    expect(readMedia(cut)!.warnings[0]).toMatch(/No movie header/);
  });
});

describe('HEIF and AVIF brands and gzip streams (W15)', () => {
  const box = (type: string, body: Uint8Array) => { const b = new Uint8Array(8 + body.length); new DataView(b.buffer).setUint32(0, b.length); b.set([...type].map((c) => c.charCodeAt(0)), 4); b.set(body, 8); return b; };
  const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
  const ftyp = (major: string, ...compat: string[]) => box('ftyp', ascii(major + '\0\0\0\0' + compat.join('')));
  const cat = (...parts: Uint8Array[]) => { const o = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let p = 0; for (const x of parts) { o.set(x, p); p += x.length; } return o; };
  it('still-picture brands are not video; a real MP4 still is', async () => {
    const { sniff } = await import('../../src/codecs/registry');
    const meta = box('meta', new Uint8Array(16));
    for (const [major, want] of [['heis', 'heic'], ['hevc', 'heic'], ['avio', 'avif'], ['miaf', 'heic'], ['mif2', 'heic']] as const) {
      const f = cat(ftyp(major, 'mif1'), meta);
      expect(sniffMedia(f), major).toBeNull();
      expect(sniff(f)?.id, major).toBe(want);
    }
    expect(sniff(cat(ftyp('miaf', 'avif', 'mif1'), meta))?.id).toBe('avif');
    // A general major brand listing an image brand, without a movie box, is a picture; with one it stays video.
    expect(sniffMedia(cat(ftyp('isom', 'mif1', 'heic'), meta))).toBeNull();
    expect(sniffMedia(cat(ftyp('isom', 'iso2', 'mp41'), box('moov', new Uint8Array(8))))?.kind).toBe('video');
  });
  it('gzip streams are identified by what they hold; .svgz renders', async () => {
    const { sniff } = await import('../../src/codecs/registry');
    const { gzipSync } = await import('node:zlib');
    const gz = (s: string | Uint8Array) => new Uint8Array(gzipSync(typeof s === 'string' ? Buffer.from(s) : s));
    expect(sniff(gz('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>'), 'x.bin')?.id).toBe('svg');
    expect(sniff(gz('just a log file\n'.repeat(50)), 'server.log.gz')).toBeNull();
    const emf = new Uint8Array(200); emf[0] = 1; emf.set(ascii(' EMF'), 40);
    expect(sniff(gz(emf), 'a.gz')?.id).toBe('emf');
    const fits = ascii('SIMPLE  =                    T'.padEnd(2880, ' '));
    expect(sniff(gz(fits), 'image.gz')?.id).toBe('fits');
  });
});
