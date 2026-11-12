/**
 * Video and audio files met while browsing: recognized by content, and their containers read by the app's own code
 * for what the details show (duration, picture size, codecs, sample rate and channels, title/artist/album tags,
 * cover art): MP4/MOV/M4A/3GP (ISO base media boxes, iTunes-style tags), WebM and Matroska (EBML: Info, Tracks,
 * Tags, attached cover), Ogg (Vorbis, Opus, Theora, FLAC streams with their comments), FLAC, WAV and AVI (RIFF),
 * AIFF, and MP3 (ID3v2.2–2.4 and ID3v1 tags, Xing/Info and VBRI headers for the duration). Playback is the
 * platform's media element, so which codecs play depends on the platform; the reader describes what is there.
 */
export interface MediaTrack { kind: 'video' | 'audio' | 'subtitle' | 'other'; codec: string; width?: number; height?: number; sampleRate?: number; channels?: number; bits?: number; language?: string; frameRate?: number }
export interface MediaInfo {
  kind: 'video' | 'audio'; container: string; mime: string; duration?: number; tracks: MediaTrack[];
  /** Title, artist, album, date, genre, comment, track... as the file names them (lower case keys). */
  tags: Record<string, string>; cover?: { bytes: Uint8Array; mime: string }; created?: string; warnings: string[];
}
const utf8 = new TextDecoder('utf-8');
const latin1 = { decode: (b: Uint8Array): string => { let s = ''; for (let i = 0; i < b.length; i += 4096) s += String.fromCharCode(...b.subarray(i, i + 4096)); return s; } };
const utf16 = (b: Uint8Array, le: boolean): string => { let s = ''; for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]); return s; };
const utf16be = { decode: (b: Uint8Array): string => utf16(b, false) }, utf16le = { decode: (b: Uint8Array): string => utf16(b, true) };
const str = (u8: Uint8Array, p: number, n: number): string => latin1.decode(u8.subarray(p, p + n));
const u32 = (u8: Uint8Array, p: number): number => ((u8[p] << 24) >>> 0) + ((u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]);
const u16 = (u8: Uint8Array, p: number): number => (u8[p] << 8) | u8[p + 1];
const u64 = (u8: Uint8Array, p: number): number => u32(u8, p) * 4294967296 + u32(u8, p + 4);
const le32 = (u8: Uint8Array, p: number): number => (u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16)) + u8[p + 3] * 16777216;
const le16 = (u8: Uint8Array, p: number): number => u8[p] | (u8[p + 1] << 8);
const clean = (s: string): string => s.replace(/\0+$/g, '').trim();
const imageMime = (b: Uint8Array): string => (b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : b[0] === 0x89 && b[1] === 0x50 ? 'image/png' : b[0] === 0x47 && b[1] === 0x49 ? 'image/gif' : str(b, 8, 4) === 'WEBP' ? 'image/webp' : 'application/octet-stream');

// HEIF and AVIF brands (ISO/IEC 23008-12 and the AV1 image format): still pictures, bursts and image sequences, which open as pictures.
const STILL_BRANDS = /hei[cxms]|hev[cxms]|mif[12]|msf1|miaf|avi[fso]|MiHA|MiHB|MiHE|MiAB|MiAC|MiPr/;
/** Whether a top-level box of this type is among the first 64 at the start of the file. */
function topBox(u8: Uint8Array, type: string): boolean {
  for (let p = 0, n = 0; p + 8 <= u8.length && n < 64; n++) {
    let size = u32(u8, p);
    if (str(u8, p + 4, 4) === type) return true;
    if (size === 1 && p + 16 <= u8.length) size = u32(u8, p + 8) * 2 ** 32 + u32(u8, p + 12);
    if (size < 8) return false;
    p += size;
  }
  return false;
}

/** What kind of media file this is, by content; null for anything else. */
export function sniffMedia(u8: Uint8Array, name = ''): { kind: 'video' | 'audio'; container: string; mime: string } | null {
  if (u8.length < 12) return null;
  const t4 = str(u8, 0, 4), t8 = str(u8, 4, 4), form = str(u8, 8, 4);
  if (t8 === 'ftyp' && u32(u8, 0) >= 8) {
    const brand = str(u8, 8, 4), r = mp4Kind(u8);
    if (brand === 'qt  ') return { kind: r, container: 'QuickTime', mime: r === 'video' ? 'video/quicktime' : 'audio/mp4' };
    if (/^3g/.test(brand)) return { kind: r, container: '3GPP', mime: r === 'video' ? 'video/3gpp' : 'audio/3gpp' };
    if (brand === 'M4A ' || brand === 'M4B ' || r === 'audio') return { kind: 'audio', container: 'MPEG-4', mime: 'audio/mp4' };
    if (STILL_BRANDS.test(brand) || brand === 'crx ' || brand === 'jp2 ' || brand === 'jpx ' || brand === 'jph ') return null; // still pictures in the same box structure
    // An image file under a general major brand: it lists an image brand and has no movie box.
    if (STILL_BRANDS.test(str(u8, 16, Math.max(0, Math.min(u32(u8, 0), 64) - 16))) && !topBox(u8, 'moov')) return null;
    return { kind: 'video', container: 'MPEG-4', mime: 'video/mp4' };
  }
  if (u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) {
    const doc = ebmlDocType(u8), webm = doc === 'webm';
    const video = matroskaHasVideo(u8);
    return { kind: video ? 'video' : 'audio', container: webm ? 'WebM' : 'Matroska', mime: webm ? (video ? 'video/webm' : 'audio/webm') : video ? 'video/x-matroska' : 'audio/x-matroska' };
  }
  if (t4 === 'OggS') { const v = oggStreams(u8).some((s) => s.kind === 'video'); return { kind: v ? 'video' : 'audio', container: 'Ogg', mime: v ? 'video/ogg' : 'audio/ogg' }; }
  if (t4 === 'RIFF') { if (form === 'WAVE') return { kind: 'audio', container: 'WAVE', mime: 'audio/wav' }; if (form === 'AVI ') return { kind: 'video', container: 'AVI', mime: 'video/x-msvideo' }; return null; }
  if (t4 === 'fLaC') return { kind: 'audio', container: 'FLAC', mime: 'audio/flac' };
  if (t4 === 'FORM' && (form === 'AIFF' || form === 'AIFC')) return { kind: 'audio', container: form === 'AIFC' ? 'AIFF-C' : 'AIFF', mime: 'audio/aiff' };
  if (str(u8, 0, 3) === 'ID3' && u8[3] <= 4) return { kind: 'audio', container: 'MPEG audio', mime: 'audio/mpeg' };
  if (mp3FrameAt(u8, 0, true)) return { kind: 'audio', container: 'MPEG audio', mime: 'audio/mpeg' };
  if (/\.(mp3|mp2|mpga)$/i.test(name) && mp3FrameAt(u8, 0, false)) return { kind: 'audio', container: 'MPEG audio', mime: 'audio/mpeg' };
  return null;
}

/** Reads the container: duration, tracks, tags and cover art. Never throws; what cannot be read is a warning. */
export function readMedia(u8: Uint8Array, name = ''): MediaInfo | null {
  const s = sniffMedia(u8, name); if (!s) return null;
  const info: MediaInfo = { ...s, tracks: [], tags: {}, warnings: [] };
  try {
    if (s.container === 'MPEG-4' || s.container === 'QuickTime' || s.container === '3GPP') readMp4(u8, info);
    else if (s.container === 'WebM' || s.container === 'Matroska') readMatroska(u8, info);
    else if (s.container === 'Ogg') readOgg(u8, info);
    else if (s.container === 'WAVE') readWav(u8, info);
    else if (s.container === 'AVI') readAvi(u8, info);
    else if (s.container === 'FLAC') readFlac(u8, 4, info);
    else if (s.container === 'AIFF' || s.container === 'AIFF-C') readAiff(u8, info);
    else readMp3(u8, info);
  } catch (e: any) { info.warnings.push(`The ${s.container} container could not be read fully (${e?.message || e})`); }
  if (info.duration !== undefined && !(info.duration >= 0 && Number.isFinite(info.duration))) delete info.duration;
  return info;
}

/** "3:05", "1:02:03.5"-style text for the details. */
export function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const ss = sec < 60 ? s.toFixed(sec < 10 ? 2 : 1) : String(Math.floor(s)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : sec < 60 ? `${ss} s` : `${m}:${ss}`;
}
/** The details-pane lines for a media file. */
export function describeMedia(m: MediaInfo): Record<string, string> {
  const out: Record<string, string> = { container: m.container };
  if (m.duration !== undefined) out.duration = formatDuration(m.duration);
  const v = m.tracks.filter((t) => t.kind === 'video'), a = m.tracks.filter((t) => t.kind === 'audio'), o = m.tracks.filter((t) => t.kind !== 'video' && t.kind !== 'audio');
  if (v.length) out.video = v.map((t) => `${t.codec}${t.width ? `, ${t.width} × ${t.height}` : ''}${t.frameRate ? `, ${+t.frameRate.toFixed(3)} fps` : ''}`).join('; ');
  if (a.length) out.audio = a.map((t) => `${t.codec}${t.sampleRate ? `, ${t.sampleRate % 1000 ? (t.sampleRate / 1000).toFixed(1) : t.sampleRate / 1000} kHz` : ''}${t.channels ? `, ${t.channels === 1 ? 'mono' : t.channels === 2 ? 'stereo' : `${t.channels} channels`}` : ''}${t.bits ? `, ${t.bits}-bit` : ''}${t.language && t.language !== 'und' ? ` (${t.language})` : ''}`).join('; ');
  if (o.length) out['other tracks'] = o.map((t) => `${t.kind}: ${t.codec}${t.language ? ` (${t.language})` : ''}`).join('; ');
  for (const k of ['title', 'artist', 'album', 'date', 'genre', 'track', 'comment', 'encoder']) if (m.tags[k]) out[k] = m.tags[k];
  if (m.cover) out['cover art'] = `${m.cover.mime.replace('image/', '').toUpperCase()}, ${(m.cover.bytes.length / 1024).toFixed(m.cover.bytes.length < 10240 ? 1 : 0)} KB`;
  if (m.created) out.created = m.created;
  return out;
}

// ---- MP4 / QuickTime ---------------------------------------------------------------------------------------------
interface Box { type: string; start: number; end: number; content: number }
function* boxes(u8: Uint8Array, from: number, to: number): Generator<Box> {
  let p = from;
  while (p + 8 <= to) {
    let size = u32(u8, p), content = p + 8;
    const type = str(u8, p + 4, 4);
    if (size === 1) { size = u64(u8, p + 8); content = p + 16; } else if (size === 0) size = to - p;
    if (size < 8 || !/^[\x20-\x7e©]{4}$/.test(type)) return;
    yield { type, start: p, end: Math.min(to, p + size), content };
    p += size;
  }
}
const CODECS: Record<string, string> = { avc1: 'H.264', avc3: 'H.264', hvc1: 'HEVC', hev1: 'HEVC', vp08: 'VP8', vp09: 'VP9', av01: 'AV1', mp4v: 'MPEG-4 Visual', 'jpeg': 'Motion JPEG', mjpa: 'Motion JPEG', 'apcn': 'ProRes', apch: 'ProRes HQ', 'mp4a': 'AAC', Opus: 'Opus', fLaC: 'FLAC', 'ac-3': 'AC-3', 'ec-3': 'E-AC-3', alac: 'ALAC', twos: 'PCM', sowt: 'PCM', lpcm: 'PCM', 'in24': 'PCM', '.mp3': 'MP3', samr: 'AMR', tx3g: 'timed text', mp4s: 'MPEG-4 system', c608: 'closed captions', wvtt: 'WebVTT', stpp: 'TTML' };
function mp4Kind(u8: Uint8Array): 'video' | 'audio' {
  let video = false, any = false;
  for (const b of boxes(u8, 0, u8.length)) if (b.type === 'moov') for (const t of boxes(u8, b.content, b.end)) if (t.type === 'trak') for (const m of boxes(u8, t.content, t.end)) if (m.type === 'mdia') for (const h of boxes(u8, m.content, m.end)) if (h.type === 'hdlr') { any = true; if (str(u8, h.content + 8, 4) === 'vide') video = true; }
  return video || !any ? 'video' : 'audio';
}
function readMp4(u8: Uint8Array, info: MediaInfo): void {
  let moov: Box | null = null;
  for (const b of boxes(u8, 0, u8.length)) if (b.type === 'moov') moov = b;
  if (!moov) { info.warnings.push('No movie header (moov) found: the file may be cut short or still being written'); return; }
  const mac1904 = (sec: number): string | undefined => (sec ? new Date((sec - 2082844800) * 1000).toISOString().replace(/\.\d+Z$/, 'Z') : undefined);
  for (const b of boxes(u8, moov.content, moov.end)) {
    if (b.type === 'mvhd') {
      const v = u8[b.content], ts = v === 1 ? u32(u8, b.content + 20) : u32(u8, b.content + 12), d = v === 1 ? u64(u8, b.content + 24) : u32(u8, b.content + 16);
      if (ts) info.duration = d / ts;
      info.created = mac1904(v === 1 ? u64(u8, b.content + 4) : u32(u8, b.content + 4));
    } else if (b.type === 'trak') info.tracks.push(readTrak(u8, b));
    else if (b.type === 'udta') readUdta(u8, b, info);
    else if (b.type === 'meta') readIlst(u8, b, info);
  }
}
function readTrak(u8: Uint8Array, trak: Box): MediaTrack {
  const t: MediaTrack = { kind: 'other', codec: '?' };
  let tkw = 0, tkh = 0, mdTs = 0, mdDur = 0;
  for (const b of boxes(u8, trak.content, trak.end)) {
    if (b.type === 'tkhd') { const v = u8[b.content], o = b.content + (v === 1 ? 88 : 76); tkw = u32(u8, o) / 65536; tkh = u32(u8, o + 4) / 65536; }
    if (b.type !== 'mdia') continue;
    for (const m of boxes(u8, b.content, b.end)) {
      if (m.type === 'hdlr') { const h = str(u8, m.content + 8, 4); t.kind = h === 'vide' ? 'video' : h === 'soun' ? 'audio' : h === 'subt' || h === 'sbtl' || h === 'text' || h === 'clcp' ? 'subtitle' : 'other'; }
      else if (m.type === 'mdhd') { const v = u8[m.content]; mdTs = v === 1 ? u32(u8, m.content + 20) : u32(u8, m.content + 12); mdDur = v === 1 ? u64(u8, m.content + 24) : u32(u8, m.content + 16); const lang = u16(u8, m.content + (v === 1 ? 32 : 20)) & 0x7fff; if (lang && lang !== 0x7fff) t.language = String.fromCharCode(((lang >> 10) & 31) + 96, ((lang >> 5) & 31) + 96, (lang & 31) + 96); }
      else if (m.type === 'minf') for (const n of boxes(u8, m.content, m.end)) if (n.type === 'stbl') for (const s of boxes(u8, n.content, n.end)) {
        if (s.type === 'stsd') {
          const e = s.content + 8; if (e + 16 > s.end) continue;
          const fourcc = str(u8, e + 4, 4); t.codec = CODECS[fourcc] || fourcc.trim();
          if (t.kind === 'video') { t.width = u16(u8, e + 32); t.height = u16(u8, e + 34); }
          else if (t.kind === 'audio') { const ver = u16(u8, e + 16); t.channels = u16(u8, e + 24); t.bits = u16(u8, e + 26); t.sampleRate = u32(u8, e + 32) / 65536; if (ver === 2) { t.sampleRate = f64(u8, e + 40); t.channels = u32(u8, e + 48); t.bits = u32(u8, e + 60); } }
          const entryEnd = Math.min(s.end, e + u32(u8, e));
          for (const c of boxes(u8, e + (t.kind === 'video' ? 86 : t.kind === 'audio' ? 36 : 16), entryEnd)) {
            if (c.type === 'esds' && fourcc === 'mp4a') { const oti = esdsObjectType(u8, c); if (oti === 0x6b || oti === 0x69) t.codec = 'MP3'; else if (oti === 0x40 || oti === 0x66 || oti === 0x67 || oti === 0x68) t.codec = 'AAC'; }
            if (c.type === 'avcC') t.codec = `H.264 ${avcProfile(u8[c.content + 1])}`.trim();
            if (c.type === 'dOps' && fourcc === 'Opus') { t.channels = u8[c.content + 1]; t.sampleRate = 48000; }
          }
        } else if (s.type === 'stts' && t.kind === 'video' && mdTs) { const n = u32(u8, s.content + 4); let frames = 0; for (let i = 0; i < n && s.content + 16 + i * 8 <= s.end; i++) frames += u32(u8, s.content + 8 + i * 8); if (frames && mdDur) t.frameRate = frames / (mdDur / mdTs); }
      }
    }
  }
  if (t.kind === 'video' && !t.width && tkw) { t.width = Math.round(tkw); t.height = Math.round(tkh); }
  if (t.kind === 'audio' && !/PCM|FLAC|ALAC/.test(t.codec)) delete t.bits; // lossy codecs: the sample entry's figure says nothing
  return t;
}
const f64 = (u8: Uint8Array, p: number): number => new DataView(u8.buffer, u8.byteOffset + p, 8).getFloat64(0);
const avcProfile = (p: number): string => ({ 66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High', 110: 'High 10', 122: 'High 4:2:2', 244: 'High 4:4:4' } as Record<number, string>)[p] || '';
function esdsObjectType(u8: Uint8Array, c: Box): number {
  let p = c.content + 4; // version/flags, then the ES descriptor
  const tagLen = (): number => { let n = 0; for (let i = 0; i < 4; i++) { const b = u8[p++]; n = (n << 7) | (b & 127); if (!(b & 128)) break; } return n; };
  if (u8[p++] !== 3) return 0; tagLen(); p += 3; // ES_ID, flags
  if (u8[p++] !== 4) return 0; tagLen();
  return u8[p];
}
function readUdta(u8: Uint8Array, udta: Box, info: MediaInfo): void {
  for (const b of boxes(u8, udta.content, udta.end)) {
    if (b.type === 'meta') readIlst(u8, b, info);
    else if (b.type[0] === '©' && b.end - b.content > 4) { // QuickTime international text: size(2) language(2) text
      const n = u16(u8, b.content), text = clean(utf8.decode(u8.subarray(b.content + 4, Math.min(b.end, b.content + 4 + n))));
      const key = ({ '©nam': 'title', '©ART': 'artist', '©alb': 'album', '©day': 'date', '©gen': 'genre', '©cmt': 'comment', '©too': 'encoder', '©swr': 'encoder', '©cpy': 'copyright' } as Record<string, string>)[b.type];
      if (key && text && !info.tags[key]) info.tags[key] = text;
    }
  }
}
function readIlst(u8: Uint8Array, meta: Box, info: MediaInfo): void {
  const start = /^[a-z]{4}$/.test(str(u8, meta.content + 8, 4)) && str(u8, meta.content + 4, 4) !== 'ilst' ? meta.content + 4 : meta.content; // a full box in ISO files, a plain one in QuickTime
  const KEYS: Record<string, string> = { '©nam': 'title', '©ART': 'artist', aART: 'album artist', '©alb': 'album', '©day': 'date', '©gen': 'genre', gnre: 'genre', '©cmt': 'comment', '©too': 'encoder', '©wrt': 'composer', '©cpy': 'copyright', trkn: 'track', desc: 'description', '©lyr': 'lyrics', cprt: 'copyright' };
  for (const b of boxes(u8, start, meta.end)) {
    if (b.type !== 'ilst') continue;
    for (const item of boxes(u8, b.content, b.end)) {
      for (const d of boxes(u8, item.content, item.end)) {
        if (d.type !== 'data') continue;
        const kind = u32(u8, d.content) & 0xffffff, body = u8.subarray(d.content + 8, d.end);
        if (item.type === 'covr') { if (!info.cover && body.length > 16) info.cover = { bytes: body.slice(), mime: kind === 14 ? 'image/png' : kind === 13 ? 'image/jpeg' : imageMime(body) }; continue; }
        const key = KEYS[item.type]; if (!key) continue;
        if (item.type === 'trkn') { info.tags.track = `${u16(u8, d.content + 10)}${u16(u8, d.content + 12) ? ` of ${u16(u8, d.content + 12)}` : ''}`; continue; }
        if (kind === 1 || kind === 0) { const text = clean(utf8.decode(body)); if (text && !info.tags[key]) info.tags[key] = text; }
        else if (kind === 21 || kind === 22) { const n = body.length === 1 ? body[0] : body.length === 2 ? u16(body, 0) : u32(body, 0); if (!info.tags[key]) info.tags[key] = String(n); }
      }
    }
  }
}

// ---- Matroska / WebM --------------------------------------------------------------------------------------------
function vint(u8: Uint8Array, p: number, keepMarker: boolean): { v: number; n: number; unknown: boolean } {
  const b = u8[p]; if (b === undefined) return { v: 0, n: 1, unknown: true };
  let n = 1; while (n <= 8 && !(b & (0x80 >> (n - 1)))) n++;
  if (n > 8) return { v: 0, n: 1, unknown: true };
  let v = keepMarker ? b : b & (0xff >> n), ones = v === (0xff >> n);
  for (let i = 1; i < n; i++) { const c = u8[p + i] ?? 0; v = v * 256 + c; if (c !== 0xff) ones = false; }
  return { v, n, unknown: !keepMarker && ones };
}
interface Elem { id: number; start: number; end: number; data: number; unknown: boolean }
function* elems(u8: Uint8Array, from: number, to: number): Generator<Elem> {
  let p = from;
  while (p < to) {
    const id = vint(u8, p, true); if (id.unknown) return;
    const size = vint(u8, p + id.n, false);
    const data = p + id.n + size.n, end = size.unknown ? to : Math.min(to, data + size.v);
    if (data > to) return;
    yield { id: id.v, start: p, end, data, unknown: size.unknown };
    p = end;
  }
}
const ebmlUint = (u8: Uint8Array, e: Elem): number => { let v = 0; for (let p = e.data; p < e.end; p++) v = v * 256 + u8[p]; return v; };
const ebmlFloat = (u8: Uint8Array, e: Elem): number => { const n = e.end - e.data, dv = new DataView(u8.buffer, u8.byteOffset + e.data, n); return n === 4 ? dv.getFloat32(0) : n === 8 ? dv.getFloat64(0) : 0; };
const ebmlStr = (u8: Uint8Array, e: Elem): string => clean(utf8.decode(u8.subarray(e.data, e.end)));
const EBML = { header: 0x1a45dfa3, docType: 0x4282, segment: 0x18538067, info: 0x1549a966, timecodeScale: 0x2ad7b1, duration: 0x4489, muxingApp: 0x4d80, writingApp: 0x5741, dateUtc: 0x4461, title: 0x7ba9, tracks: 0x1654ae6b, trackEntry: 0xae, trackType: 0x83, codecId: 0x86, trackName: 0x536e, language: 0x22b59c, video: 0xe0, pixelWidth: 0xb0, pixelHeight: 0xba, audio: 0xe1, samplingFrequency: 0xb5, channels: 0x9f, bitDepth: 0x6264, defaultDuration: 0x23e383, cluster: 0x1f43b675, attachments: 0x1941a469, attachedFile: 0x61a7, fileName: 0x466e, fileMime: 0x4660, fileData: 0x465c, tags: 0x1254c367, tag: 0x7373, simpleTag: 0x67c8, tagName: 0x45a3, tagString: 0x4487 };
const MKV_CODECS: Record<string, string> = { V_VP8: 'VP8', V_VP9: 'VP9', V_AV1: 'AV1', 'V_MPEG4/ISO/AVC': 'H.264', 'V_MPEGH/ISO/HEVC': 'HEVC', V_THEORA: 'Theora', 'V_MPEG4/ISO/ASP': 'MPEG-4 Visual', 'V_MS/VFW/FOURCC': 'VfW', V_MJPEG: 'Motion JPEG', A_OPUS: 'Opus', A_VORBIS: 'Vorbis', A_AAC: 'AAC', A_FLAC: 'FLAC', 'A_MPEG/L3': 'MP3', 'A_MPEG/L2': 'MP2', 'A_PCM/INT/LIT': 'PCM', 'A_PCM/INT/BIG': 'PCM', 'A_PCM/FLOAT/IEEE': 'PCM (float)', A_AC3: 'AC-3', A_EAC3: 'E-AC-3', A_DTS: 'DTS', A_TRUEHD: 'TrueHD', A_ALAC: 'ALAC', 'S_TEXT/UTF8': 'SRT', 'S_TEXT/ASS': 'ASS', 'S_TEXT/SSA': 'SSA', 'S_TEXT/WEBVTT': 'WebVTT', S_VOBSUB: 'VobSub', 'S_HDMV/PGS': 'PGS' };
function ebmlDocType(u8: Uint8Array): string {
  for (const e of elems(u8, 0, Math.min(u8.length, 4096))) if (e.id === EBML.header) for (const c of elems(u8, e.data, e.end)) if (c.id === EBML.docType) return ebmlStr(u8, c);
  return 'matroska';
}
function* segmentChildren(u8: Uint8Array): Generator<Elem> {
  for (const e of elems(u8, 0, u8.length)) if (e.id === EBML.segment) {
    for (const c of elems(u8, e.data, e.end)) {
      if (c.id === EBML.cluster) { if (c.unknown) return; continue; }
      yield c;
    }
  }
}
function matroskaHasVideo(u8: Uint8Array): boolean {
  for (const c of segmentChildren(u8)) if (c.id === EBML.tracks) for (const t of elems(u8, c.data, c.end)) if (t.id === EBML.trackEntry) for (const f of elems(u8, t.data, t.end)) if (f.id === EBML.trackType && ebmlUint(u8, f) === 1) return true;
  return false;
}
function readMatroska(u8: Uint8Array, info: MediaInfo): void {
  let scale = 1e6, duration: number | undefined;
  for (const c of segmentChildren(u8)) {
    if (c.id === EBML.info) {
      for (const f of elems(u8, c.data, c.end)) {
        if (f.id === EBML.timecodeScale) scale = ebmlUint(u8, f); else if (f.id === EBML.duration) duration = ebmlFloat(u8, f);
        else if (f.id === EBML.muxingApp) info.tags.encoder = ebmlStr(u8, f); else if (f.id === EBML.title) info.tags.title = ebmlStr(u8, f);
        else if (f.id === EBML.dateUtc) { const ns = ebmlInt64(u8, f); info.created = new Date(978307200000 + ns / 1e6).toISOString().replace(/\.\d+Z$/, 'Z'); }
      }
    } else if (c.id === EBML.tracks) {
      for (const t of elems(u8, c.data, c.end)) {
        if (t.id !== EBML.trackEntry) continue;
        const tr: MediaTrack = { kind: 'other', codec: '?' };
        for (const f of elems(u8, t.data, t.end)) {
          if (f.id === EBML.trackType) { const k = ebmlUint(u8, f); tr.kind = k === 1 ? 'video' : k === 2 ? 'audio' : k === 17 ? 'subtitle' : 'other'; }
          else if (f.id === EBML.codecId) { const id = ebmlStr(u8, f); tr.codec = MKV_CODECS[id] || id; }
          else if (f.id === EBML.language) tr.language = ebmlStr(u8, f);
          else if (f.id === EBML.defaultDuration) { const ns = ebmlUint(u8, f); if (ns) tr.frameRate = 1e9 / ns; }
          else if (f.id === EBML.video) for (const g of elems(u8, f.data, f.end)) { if (g.id === EBML.pixelWidth) tr.width = ebmlUint(u8, g); else if (g.id === EBML.pixelHeight) tr.height = ebmlUint(u8, g); }
          else if (f.id === EBML.audio) for (const g of elems(u8, f.data, f.end)) { if (g.id === EBML.samplingFrequency) tr.sampleRate = ebmlFloat(u8, g); else if (g.id === EBML.channels) tr.channels = ebmlUint(u8, g); else if (g.id === EBML.bitDepth) tr.bits = ebmlUint(u8, g); }
        }
        if (tr.kind === 'audio' && !tr.sampleRate) tr.sampleRate = 8000;
        if (tr.kind === 'audio' && !/PCM|FLAC|ALAC/.test(tr.codec)) delete tr.bits; // lossy codecs: the muxer's figure says nothing
        if (tr.kind !== 'video') delete tr.frameRate;
        info.tracks.push(tr);
      }
    } else if (c.id === EBML.attachments) {
      for (const a of elems(u8, c.data, c.end)) {
        if (a.id !== EBML.attachedFile) continue;
        let name = '', mime = '', data: Uint8Array | null = null;
        for (const f of elems(u8, a.data, a.end)) { if (f.id === EBML.fileName) name = ebmlStr(u8, f); else if (f.id === EBML.fileMime) mime = ebmlStr(u8, f); else if (f.id === EBML.fileData) data = u8.subarray(f.data, f.end); }
        if (data && !info.cover && (/^image\//.test(mime) || /\.(jpe?g|png|webp|gif)$/i.test(name))) info.cover = { bytes: data.slice(), mime: /^image\//.test(mime) ? mime : imageMime(data) };
      }
    } else if (c.id === EBML.tags) {
      for (const t of elems(u8, c.data, c.end)) if (t.id === EBML.tag) for (const s of elems(u8, t.data, t.end)) if (s.id === EBML.simpleTag) {
        let key = '', val = '';
        for (const f of elems(u8, s.data, s.end)) { if (f.id === EBML.tagName) key = ebmlStr(u8, f).toLowerCase(); else if (f.id === EBML.tagString) val = ebmlStr(u8, f); }
        const k = ({ title: 'title', artist: 'artist', album: 'album', date_released: 'date', date: 'date', genre: 'genre', comment: 'comment', encoder: 'encoder', description: 'description', part_number: 'track', composer: 'composer' } as Record<string, string>)[key];
        if (k && val && !info.tags[k]) info.tags[k] = val;
      }
    }
  }
  if (duration !== undefined) info.duration = (duration * scale) / 1e9;
}
const ebmlInt64 = (u8: Uint8Array, e: Elem): number => (e.end - e.data === 8 ? Number(new DataView(u8.buffer, u8.byteOffset + e.data, 8).getBigInt64(0)) : ebmlUint(u8, e));

// ---- Ogg ------------------------------------------------------------------------------------------------------
interface OggStream { serial: number; kind: 'video' | 'audio' | 'other'; codec: string; rate: number; channels: number; width?: number; height?: number; frameRate?: number; granuleShift: number; lastGranule: number; preskip: number; packets: Uint8Array[] }
function oggStreams(u8: Uint8Array): OggStream[] {
  const streams = new Map<number, OggStream>(); let p = 0, pages = 0;
  const pending = new Map<number, number[]>();
  while (p + 27 <= u8.length && str(u8, p, 4) === 'OggS' && pages < 64) {
    const flags = u8[p + 5], serial = le32(u8, p + 14), nseg = u8[p + 26]; let q = p + 27 + nseg;
    const granule = le32(u8, p + 6) + le32(u8, p + 10) * 4294967296;
    let s = streams.get(serial);
    if (flags & 2) { s = { serial, kind: 'other', codec: '?', rate: 0, channels: 0, granuleShift: 0, lastGranule: 0, preskip: 0, packets: [] }; streams.set(serial, s); }
    if (!s) break;
    const buf = pending.get(serial) || [];
    for (let i = 0; i < nseg; i++) { const n = u8[p + 27 + i]; for (let k = 0; k < n; k++) buf.push(u8[q + k]); q += n; if (n < 255) { if (s.packets.length < 3) s.packets.push(Uint8Array.from(buf)); buf.length = 0; } }
    pending.set(serial, buf);
    if (granule !== 0xffffffffffffffff && granule >= 0) s.lastGranule = granule;
    p = q; pages++;
    if ([...streams.values()].every((x) => x.packets.length >= 2) && pages > 8) break;
  }
  for (const s of streams.values()) {
    const h = s.packets[0]; if (!h) continue;
    const tag = str(h, 0, 8);
    if (tag.startsWith('\x01vorbis')) { s.kind = 'audio'; s.codec = 'Vorbis'; s.channels = h[11]; s.rate = le32(h, 12); }
    else if (tag === 'OpusHead') { s.kind = 'audio'; s.codec = 'Opus'; s.channels = h[9]; s.preskip = le16(h, 10); s.rate = 48000; }
    else if (tag.startsWith('\x80theora')) { s.kind = 'video'; s.codec = 'Theora'; s.width = (h[14] << 16) | (h[15] << 8) | h[16]; s.height = (h[17] << 16) | (h[18] << 8) | h[19]; const frn = u32(h, 22), frd = u32(h, 26); if (frd) s.frameRate = frn / frd; s.granuleShift = ((h[40] & 3) << 3) | (h[41] >> 5); }
    else if (tag.startsWith('\x7fFLAC')) { s.kind = 'audio'; s.codec = 'FLAC'; const si = 13 + 4; s.rate = (h[si + 10] << 12) | (h[si + 11] << 4) | (h[si + 12] >> 4); s.channels = ((h[si + 12] >> 1) & 7) + 1; }
    else if (tag.startsWith('Speex   ')) { s.kind = 'audio'; s.codec = 'Speex'; s.rate = le32(h, 36); s.channels = le32(h, 48); }
    else if (tag.startsWith('BBCD')) { s.kind = 'video'; s.codec = 'Dirac'; }
    else if (tag.startsWith('fishead')) { s.kind = 'other'; s.codec = 'Skeleton'; }
    else if (tag.startsWith('\x80kate')) { s.kind = 'other'; s.codec = 'Kate text'; }
  }
  return [...streams.values()];
}
function readOgg(u8: Uint8Array, info: MediaInfo): void {
  const streams = oggStreams(u8);
  // The last granule positions, from the pages at the end of the file.
  const last = new Map<number, number>();
  for (let p = Math.max(0, u8.length - 256 * 1024); p + 27 <= u8.length; p++) {
    if (u8[p] !== 0x4f || str(u8, p, 4) !== 'OggS' || u8[p + 4] !== 0) continue;
    const nseg = u8[p + 26]; if (p + 27 + nseg > u8.length) continue;
    let size = 27 + nseg; for (let i = 0; i < nseg; i++) size += u8[p + 27 + i];
    if (p + size > u8.length) continue;
    const g = le32(u8, p + 6) + le32(u8, p + 10) * 4294967296; if (g >= 0 && g < 2 ** 62) last.set(le32(u8, p + 14), g);
    p += size - 1;
  }
  let duration: number | undefined;
  for (const s of streams) {
    const g = last.get(s.serial) ?? s.lastGranule;
    if (s.kind === 'audio' && s.rate) { const d = (g - s.preskip) / s.rate; if (d > 0 && (duration === undefined || d > duration)) duration = d; }
    if (s.kind === 'video' && s.codec === 'Theora' && s.frameRate && duration === undefined) { const frames = Math.floor(g / 2 ** s.granuleShift) + (g % 2 ** s.granuleShift); duration = frames / s.frameRate; }
    if (s.kind === 'video') info.tracks.push({ kind: 'video', codec: s.codec, width: s.width, height: s.height, frameRate: s.frameRate });
    else if (s.kind === 'audio') info.tracks.push({ kind: 'audio', codec: s.codec, sampleRate: s.rate || undefined, channels: s.channels || undefined });
    else info.tracks.push({ kind: 'other', codec: s.codec });
    const c = s.packets[1];
    if (c) { const at = str(c, 0, 8).startsWith('OpusTags') ? 8 : c[0] === 3 || c[0] === 0x81 ? 7 : -1; if (at >= 0) vorbisComments(c, at, info); }
  }
  if (duration !== undefined) info.duration = duration;
}
/** A Vorbis comment block (also FLAC's): vendor, then key=value pairs; METADATA_BLOCK_PICTURE carries cover art. */
function vorbisComments(c: Uint8Array, p: number, info: MediaInfo): void {
  const vn = le32(c, p); p += 4 + vn;
  const n = le32(c, p); p += 4;
  for (let i = 0; i < n && p + 4 <= c.length; i++) {
    const len = le32(c, p); p += 4; const s = utf8.decode(c.subarray(p, p + len)); p += len;
    const eq = s.indexOf('='); if (eq < 0) continue;
    const key = s.slice(0, eq).toLowerCase(), val = s.slice(eq + 1);
    if (key === 'metadata_block_picture') { try { const b = Uint8Array.from(atob(val), (ch) => ch.charCodeAt(0)); flacPicture(b, 0, info); } catch { /* not base64 */ } continue; }
    const k = ({ title: 'title', artist: 'artist', album: 'album', date: 'date', genre: 'genre', comment: 'comment', description: 'comment', tracknumber: 'track', encoder: 'encoder', composer: 'composer', albumartist: 'album artist' } as Record<string, string>)[key];
    if (k && val && !info.tags[k]) info.tags[k] = val;
  }
}
function flacPicture(b: Uint8Array, p: number, info: MediaInfo): void {
  const type = u32(b, p), ml = u32(b, p + 4), mime = str(b, p + 8, ml); p += 8 + ml;
  const dl = u32(b, p); p += 4 + dl; p += 16; // description, width, height, depth, colors
  const n = u32(b, p); const data = b.subarray(p + 4, p + 4 + n);
  if (data.length && (!info.cover || type === 3)) info.cover = { bytes: data.slice(), mime: mime.startsWith('image/') ? mime : imageMime(data) };
}

// ---- FLAC -----------------------------------------------------------------------------------------------------
function readFlac(u8: Uint8Array, p: number, info: MediaInfo): void {
  for (let last = false; !last && p + 4 <= u8.length;) {
    const h = u8[p], type = h & 0x7f, len = (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]; last = !!(h & 0x80);
    const d = p + 4;
    if (type === 0 && len >= 34) {
      const rate = (u8[d + 10] << 12) | (u8[d + 11] << 4) | (u8[d + 12] >> 4), ch = ((u8[d + 12] >> 1) & 7) + 1, bits = (((u8[d + 12] & 1) << 4) | (u8[d + 13] >> 4)) + 1;
      const total = (u8[d + 13] & 15) * 2 ** 32 + u32(u8, d + 14);
      info.tracks.push({ kind: 'audio', codec: 'FLAC', sampleRate: rate, channels: ch, bits });
      if (rate && total) info.duration = total / rate;
    } else if (type === 4) vorbisComments(u8, d, info);
    else if (type === 6) flacPicture(u8, d, info);
    p = d + len;
  }
}

// ---- RIFF: WAVE and AVI -----------------------------------------------------------------------------------------
function* riff(u8: Uint8Array, from: number, to: number): Generator<{ id: string; data: number; end: number; list: string }> {
  let p = from;
  while (p + 8 <= to) {
    const id = str(u8, p, 4), n = le32(u8, p + 4), data = p + 8, end = Math.min(to, data + n);
    yield { id, data, end, list: id === 'LIST' || id === 'RIFF' ? str(u8, data, 4) : '' };
    p = data + n + (n & 1);
  }
}
const WAVE_TAGS: Record<number, string> = { 1: 'PCM', 2: 'ADPCM', 3: 'PCM (float)', 6: 'A-law', 7: 'µ-law', 0x11: 'IMA ADPCM', 0x50: 'MP2', 0x55: 'MP3', 0xff: 'AAC', 0x2000: 'AC-3', 0xfffe: 'PCM' };
function riffInfo(u8: Uint8Array, from: number, to: number, info: MediaInfo): void {
  for (const c of riff(u8, from, to)) {
    const key = ({ INAM: 'title', IART: 'artist', IPRD: 'album', ICRD: 'date', IGNR: 'genre', ICMT: 'comment', ISFT: 'encoder', ITRK: 'track', IPRT: 'track' } as Record<string, string>)[c.id];
    if (key) { const v = clean(utf8.decode(u8.subarray(c.data, c.end))); if (v && !info.tags[key]) info.tags[key] = v; }
  }
}
function waveFormat(u8: Uint8Array, d: number, end: number): MediaTrack {
  let tag = le16(u8, d); const ch = le16(u8, d + 2), rate = le32(u8, d + 4), bits = le16(u8, d + 14);
  if (tag === 0xfffe && end - d >= 26) tag = le16(u8, d + 24);
  return { kind: 'audio', codec: WAVE_TAGS[tag] || `format 0x${tag.toString(16)}`, sampleRate: rate, channels: ch, bits: bits || undefined };
}
function readWav(u8: Uint8Array, info: MediaInfo): void {
  let byteRate = 0, dataSize = 0;
  for (const c of riff(u8, 12, u8.length)) {
    if (c.id === 'fmt ') { info.tracks.push(waveFormat(u8, c.data, c.end)); byteRate = le32(u8, c.data + 8); }
    else if (c.id === 'data') dataSize = c.end - c.data;
    else if (c.id === 'LIST' && c.list === 'INFO') riffInfo(u8, c.data + 4, c.end, info);
  }
  if (byteRate && dataSize) info.duration = dataSize / byteRate;
}
const AVI_CODECS: Record<string, string> = { MJPG: 'Motion JPEG', 'DIB ': 'uncompressed', XVID: 'MPEG-4 Visual (Xvid)', DIVX: 'MPEG-4 Visual (DivX)', DX50: 'MPEG-4 Visual (DivX 5)', FMP4: 'MPEG-4 Visual', mp4v: 'MPEG-4 Visual', H264: 'H.264', h264: 'H.264', avc1: 'H.264', X264: 'H.264', VP80: 'VP8', VP90: 'VP9', MP42: 'MS MPEG-4 v2', MP43: 'MS MPEG-4 v3', cvid: 'Cinepak', IV50: 'Indeo 5', HFYU: 'HuffYUV', 'YUY2': 'uncompressed YUY2', 'I420': 'uncompressed I420' };
function readAvi(u8: Uint8Array, info: MediaInfo): void {
  let usPerFrame = 0, frames = 0;
  for (const c of riff(u8, 12, u8.length)) {
    if (!(c.id === 'LIST' && c.list === 'hdrl')) { if (c.id === 'LIST' && c.list === 'INFO') riffInfo(u8, c.data + 4, c.end, info); continue; }
    for (const h of riff(u8, c.data + 4, c.end)) {
      if (h.id === 'avih') { usPerFrame = le32(u8, h.data); frames = le32(u8, h.data + 16); }
      else if (h.id === 'LIST' && h.list === 'strl') {
        let t: MediaTrack | null = null, scale = 0, rate = 0, length = 0, fcc = '';
        for (const s of riff(u8, h.data + 4, h.end)) {
          if (s.id === 'strh') { const type = str(u8, s.data, 4); fcc = str(u8, s.data + 4, 4); scale = le32(u8, s.data + 20); rate = le32(u8, s.data + 24); length = le32(u8, s.data + 32); t = { kind: type === 'vids' ? 'video' : type === 'auds' ? 'audio' : type === 'txts' ? 'subtitle' : 'other', codec: fcc.trim() || '?' }; }
          else if (s.id === 'strf' && t) {
            if (t.kind === 'video') { t.width = le32(u8, s.data + 4); t.height = Math.abs(le32(u8, s.data + 8) | 0); const comp = le32(u8, s.data + 16), four = comp ? str(u8, s.data + 16, 4) : 'DIB '; t.codec = AVI_CODECS[four] || AVI_CODECS[fcc] || four.trim(); if (scale && rate) t.frameRate = rate / scale; }
            else if (t.kind === 'audio') Object.assign(t, waveFormat(u8, s.data, s.end));
          }
        }
        if (t) { info.tracks.push(t); if (t.kind === 'audio' && scale && rate && length && info.duration === undefined) info.duration = (length * scale) / rate; }
      }
    }
  }
  if (usPerFrame && frames) info.duration = (frames * usPerFrame) / 1e6;
}

// ---- AIFF -----------------------------------------------------------------------------------------------------
function ext80(u8: Uint8Array, p: number): number { // IEEE 754 80-bit extended, as AIFF stores the sample rate
  const sign = u8[p] & 0x80 ? -1 : 1, exp = (((u8[p] & 0x7f) << 8) | u8[p + 1]) - 16383, hi = u32(u8, p + 2), lo = u32(u8, p + 6);
  if (exp === -16383 && !hi && !lo) return 0;
  return sign * (hi * 2 ** 32 + lo) * 2 ** (exp - 63);
}
function readAiff(u8: Uint8Array, info: MediaInfo): void {
  const aifc = str(u8, 8, 4) === 'AIFC';
  for (const c of riffBig(u8, 12, u8.length)) {
    if (c.id === 'COMM') {
      const ch = u16(u8, c.data), frames = u32(u8, c.data + 2), bits = u16(u8, c.data + 6), rate = ext80(u8, c.data + 8);
      const comp = aifc && c.end - c.data >= 22 ? str(u8, c.data + 18, 4) : 'NONE';
      info.tracks.push({ kind: 'audio', codec: ({ NONE: 'PCM', sowt: 'PCM', twos: 'PCM', fl32: 'PCM (float)', FL32: 'PCM (float)', fl64: 'PCM (float)', alaw: 'A-law', ulaw: 'µ-law', ima4: 'IMA ADPCM' } as Record<string, string>)[comp] || comp, sampleRate: rate, channels: ch, bits });
      if (rate) info.duration = frames / rate;
    } else { const key = ({ NAME: 'title', AUTH: 'artist', ANNO: 'comment', '(c) ': 'copyright' } as Record<string, string>)[c.id]; if (key) { const v = clean(utf8.decode(u8.subarray(c.data, c.end))); if (v && !info.tags[key]) info.tags[key] = v; } }
  }
}
function* riffBig(u8: Uint8Array, from: number, to: number): Generator<{ id: string; data: number; end: number }> {
  let p = from;
  while (p + 8 <= to) { const id = str(u8, p, 4), n = u32(u8, p + 4), data = p + 8; yield { id, data, end: Math.min(to, data + n) }; p = data + n + (n & 1); }
}

// ---- MP3 ------------------------------------------------------------------------------------------------------
const BITRATES = { v1: [[0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]], v2: [[0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]] };
const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] } as Record<number, number[]>;
interface Mp3Frame { length: number; bitrate: number; rate: number; channels: number; layer: number; version: number; samples: number; sideInfo: number }
function mp3FrameAt(u8: Uint8Array, p: number, strict: boolean): Mp3Frame | null {
  if (p + 4 > u8.length || u8[p] !== 0xff || (u8[p + 1] & 0xe0) !== 0xe0) return null;
  const version = (u8[p + 1] >> 3) & 3, layerBits = (u8[p + 1] >> 1) & 3, bi = u8[p + 2] >> 4, ri = (u8[p + 2] >> 2) & 3, pad = (u8[p + 2] >> 1) & 1, mode = u8[p + 3] >> 6;
  if (version === 1 || layerBits === 0 || bi === 0 || bi === 15 || ri === 3) return null;
  const layer = 4 - layerBits, v1 = version === 3, rate = RATES[version][ri], bitrate = (v1 ? BITRATES.v1 : BITRATES.v2)[layer - 1][bi] * 1000;
  const samples = layer === 1 ? 384 : layer === 2 ? 1152 : v1 ? 1152 : 576;
  const length = layer === 1 ? (Math.floor((12 * bitrate) / rate) + pad) * 4 : Math.floor((samples / 8) * bitrate / rate) + pad;
  const channels = mode === 3 ? 1 : 2, sideInfo = v1 ? (channels === 1 ? 17 : 32) : channels === 1 ? 9 : 17;
  const f = { length, bitrate, rate, channels, layer, version, samples, sideInfo };
  if (strict) { const next = p + length; if (next + 4 > u8.length) return null; const n = mp3FrameAt(u8, next, false); if (!n || n.layer !== layer || n.rate !== rate) return null; }
  return f;
}
function readMp3(u8: Uint8Array, info: MediaInfo): void {
  let p = 0;
  if (str(u8, 0, 3) === 'ID3') { p = readId3v2(u8, info); }
  let end = u8.length;
  if (end >= 128 && str(u8, end - 128, 3) === 'TAG') { readId3v1(u8, end - 128, info); end -= 128; }
  let f: Mp3Frame | null = null;
  for (let q = p; q < Math.min(end, p + 65536); q++) { f = mp3FrameAt(u8, q, true); if (f) { p = q; break; } }
  if (!f) { info.warnings.push('No MPEG audio frame found'); return; }
  const t: MediaTrack = { kind: 'audio', codec: f.layer === 3 ? 'MP3' : f.layer === 2 ? 'MP2' : 'MPEG-1 layer I', sampleRate: f.rate, channels: f.channels };
  info.tracks.push(t);
  const x = p + 4 + f.sideInfo, tag = str(u8, x, 4);
  let frames = 0, vbr = false;
  if (tag === 'Xing' || tag === 'Info') { const fl = u32(u8, x + 4); if (fl & 1) frames = u32(u8, x + 8); vbr = tag === 'Xing'; }
  else if (str(u8, p + 4 + 32, 4) === 'VBRI') { frames = u32(u8, p + 4 + 32 + 14); vbr = true; }
  if (frames) info.duration = (frames * f.samples) / f.rate;
  else if (f.bitrate) info.duration = ((end - p) * 8) / f.bitrate;
  t.codec += vbr ? ' (VBR)' : ` ${f.bitrate / 1000} kbit/s`;
}
function id3Text(b: Uint8Array): string {
  const enc = b[0], body = b.subarray(1);
  const s = enc === 0 ? latin1.decode(body) : enc === 3 ? utf8.decode(body) : enc === 2 ? utf16be.decode(body) : body[0] === 0xff && body[1] === 0xfe ? utf16le.decode(body.subarray(2)) : utf16be.decode(body[0] === 0xfe ? body.subarray(2) : body);
  return clean(s.replace(/\0.*$/s, (m) => (m.length > 1 ? ' / ' + m.slice(1) : '')));
}
function readId3v2(u8: Uint8Array, info: MediaInfo): number {
  const ver = u8[3], flags = u8[5], size = ((u8[6] & 127) << 21) | ((u8[7] & 127) << 14) | ((u8[8] & 127) << 7) | (u8[9] & 127);
  let body = u8.subarray(10, 10 + size);
  if (flags & 0x80 && ver < 4) { const o: number[] = []; for (let i = 0; i < body.length; i++) { o.push(body[i]); if (body[i] === 0xff && body[i + 1] === 0) i++; } body = Uint8Array.from(o); } // unsynchronisation
  let p = 0;
  if (flags & 0x40) p += ver === 4 ? ((body[0] & 127) << 21) | ((body[1] & 127) << 14) | ((body[2] & 127) << 7) | (body[3] & 127) : u32(body, 0) + 4; // extended header
  const KEYS: Record<string, string> = { TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TALB: 'album', TAL: 'album', TYER: 'date', TDRC: 'date', TYE: 'date', TCON: 'genre', TCO: 'genre', COMM: 'comment', COM: 'comment', TRCK: 'track', TRK: 'track', TSSE: 'encoder', TSS: 'encoder', TENC: 'encoder', TCOM: 'composer', TCM: 'composer', TPE2: 'album artist', TP2: 'album artist' };
  while (p + (ver === 2 ? 6 : 10) <= body.length) {
    const id = str(body, p, ver === 2 ? 3 : 4); if (!/^[A-Z0-9]+$/.test(id)) break;
    const n = ver === 2 ? (body[p + 3] << 16) | (body[p + 4] << 8) | body[p + 5] : ver === 4 ? ((body[p + 4] & 127) << 21) | ((body[p + 5] & 127) << 14) | ((body[p + 6] & 127) << 7) | (body[p + 7] & 127) : u32(body, p + 4);
    const fflags = ver === 2 ? 0 : u16(body, p + 8);
    let d = body.subarray(p + (ver === 2 ? 6 : 10), p + (ver === 2 ? 6 : 10) + n); p += (ver === 2 ? 6 : 10) + n;
    if (ver === 4 && fflags & 2) { const o: number[] = []; for (let i = 0; i < d.length; i++) { o.push(d[i]); if (d[i] === 0xff && d[i + 1] === 0) i++; } d = Uint8Array.from(o); }
    if (ver === 4 && fflags & 1) d = d.subarray(4); // a data length indicator
    if (!d.length) continue;
    if (id === 'APIC' || id === 'PIC') {
      const enc = d[0]; let q = 1, mime: string;
      if (id === 'PIC') { mime = 'image/' + str(d, 1, 3).toLowerCase().replace('jpg', 'jpeg'); q = 4; } else { const z = d.indexOf(0, 1); mime = latin1.decode(d.subarray(1, z)); q = z + 1; }
      const type = d[q++];
      if (enc === 1 || enc === 2) { while (q + 1 < d.length && !(d[q] === 0 && d[q + 1] === 0)) q += 2; q += 2; } else { q = d.indexOf(0, q) + 1; }
      const data = d.subarray(q);
      if (data.length && (!info.cover || type === 3)) info.cover = { bytes: data.slice(), mime: /^image\/[a-z]+$/.test(mime) ? mime : imageMime(data) };
      continue;
    }
    const key = KEYS[id]; if (!key) continue;
    let text: string;
    if (id === 'COMM' || id === 'COM') { const enc = d[0]; const rest = d.subarray(4); const z = enc === 1 || enc === 2 ? ((): number => { let i = 0; while (i + 1 < rest.length && !(rest[i] === 0 && rest[i + 1] === 0)) i += 2; return i + 2; })() : rest.indexOf(0) + 1; text = id3Text(Uint8Array.from([enc, ...rest.subarray(z)])); }
    else text = id3Text(d);
    if (text && !info.tags[key]) info.tags[key] = text;
  }
  return 10 + size + (flags & 0x10 ? 10 : 0);
}
function readId3v1(u8: Uint8Array, p: number, info: MediaInfo): void {
  const f = (o: number, n: number) => clean(latin1.decode(u8.subarray(p + o, p + o + n)).replace(/\0.*$/s, ''));
  const t = f(3, 30), a = f(33, 30), al = f(63, 30), y = f(93, 4);
  if (t && !info.tags.title) info.tags.title = t; if (a && !info.tags.artist) info.tags.artist = a; if (al && !info.tags.album) info.tags.album = al; if (y && !info.tags.date) info.tags.date = y;
  if (u8[p + 125] === 0 && u8[p + 126] && !info.tags.track) info.tags.track = String(u8[p + 126]);
}
