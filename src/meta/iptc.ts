/**
 * IPTC-IIM (the Photoshop APP13 "8BIM" 0x0404 resource in JPEG files): reading the record 2 datasets
 * Anne's Lens edits and writing them back, keeping the other Photoshop resources in the segment.
 */
import { latin1 } from '../codecs/limits';

export interface IptcFields { title?: string; keywords?: string[]; byline?: string; bylineTitle?: string; city?: string; state?: string; country?: string; headline?: string; credit?: string; source?: string; copyright?: string; caption?: string; writer?: string; dateCreated?: string; instructions?: string; category?: string }
const DATASETS: Record<number, keyof IptcFields> = { 5: 'title', 25: 'keywords', 80: 'byline', 85: 'bylineTitle', 90: 'city', 95: 'state', 101: 'country', 105: 'headline', 110: 'credit', 115: 'source', 116: 'copyright', 120: 'caption', 122: 'writer', 55: 'dateCreated', 40: 'instructions', 15: 'category' };
const ORDER: [number, keyof IptcFields][] = [[5, 'title'], [15, 'category'], [25, 'keywords'], [40, 'instructions'], [55, 'dateCreated'], [80, 'byline'], [85, 'bylineTitle'], [90, 'city'], [95, 'state'], [101, 'country'], [105, 'headline'], [110, 'credit'], [115, 'source'], [116, 'copyright'], [120, 'caption'], [122, 'writer']];

const str = (u8: Uint8Array, o: number, n: number) => latin1(u8, o, o + n);
const ascii = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 255));
function concat(parts: Uint8Array[]): Uint8Array { const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }

/** The JPEG segments as {marker, start, len} (len = segment length field; start = position of 0xFF). */
export function jpegSegments(u8: Uint8Array): { marker: number; start: number; len: number }[] {
  const out: { marker: number; start: number; len: number }[] = [];
  if (u8[0] !== 0xff || u8[1] !== 0xd8) return out;
  let p = 2;
  while (p + 4 <= u8.length && u8[p] === 0xff) {
    const m = u8[p + 1];
    if (m === 0xff) { p++; continue; }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { p += 2; continue; }
    if (m === 0xda || m === 0xd9) break;
    const len = (u8[p + 2] << 8) | u8[p + 3];
    out.push({ marker: m, start: p, len });
    p += 2 + len;
  }
  return out;
}

interface Resource { id: number; name: Uint8Array; data: Uint8Array }
function parseResources(body: Uint8Array): Resource[] {
  const out: Resource[] = [];
  let p = 0;
  while (p + 12 <= body.length) {
    if (str(body, p, 4) !== '8BIM') break;
    const id = (body[p + 4] << 8) | body[p + 5];
    const nlen = body[p + 6]; const name = body.slice(p + 7, p + 7 + nlen); let q = p + 7 + nlen; if ((nlen + 1) & 1) q++;
    const size = ((body[q] << 24) | (body[q + 1] << 16) | (body[q + 2] << 8) | body[q + 3]) >>> 0;
    out.push({ id, name, data: body.slice(q + 4, q + 4 + size) });
    p = q + 4 + size + (size & 1);
  }
  return out;
}
function buildResources(res: Resource[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const r of res) {
    const nlen = r.name.length, head = new Uint8Array(7 + nlen + (((nlen + 1) & 1) ? 1 : 0) + 4);
    head.set(ascii('8BIM')); head[4] = r.id >> 8; head[5] = r.id & 255; head[6] = nlen; head.set(r.name, 7);
    const so = head.length - 4; head[so] = r.data.length >>> 24; head[so + 1] = (r.data.length >> 16) & 255; head[so + 2] = (r.data.length >> 8) & 255; head[so + 3] = r.data.length & 255;
    parts.push(head, r.data); if (r.data.length & 1) parts.push(new Uint8Array(1));
  }
  return concat(parts);
}

/** Parses an IPTC-IIM block (datasets 1C rr nn len...). */
export function parseIim(u8: Uint8Array): IptcFields {
  const out: IptcFields = {};
  let utf8 = false, p = 0;
  const dec = (b: Uint8Array) => { try { return utf8 ? new TextDecoder('utf-8', { fatal: true }).decode(b) : new TextDecoder('latin1').decode(b); } catch { return new TextDecoder('latin1').decode(b); } };
  while (p + 5 <= u8.length) {
    if (u8[p] !== 0x1c) { p++; continue; }
    const rec = u8[p + 1], ds = u8[p + 2]; let len = (u8[p + 3] << 8) | u8[p + 4], q = p + 5;
    if (len & 0x8000) { const n = len & 0x7fff; len = 0; for (let i = 0; i < n; i++) len = len * 256 + u8[q + i]; q += n; }
    const data = u8.subarray(q, q + len);
    if (rec === 1 && ds === 90) utf8 = str(data, 0, 3) === '\x1b%G';
    else if (rec === 2 && DATASETS[ds]) { const k = DATASETS[ds]; const v = dec(data); if (k === 'keywords') (out.keywords ||= []).push(v); else if (!(out as any)[k]) (out as any)[k] = v; }
    p = q + len;
  }
  return out;
}

/** UTF-8 bytes cut to at most `max`, at a character boundary (never inside a character). */
export function clipUtf8(b: Uint8Array, max: number): Uint8Array {
  if (b.length <= max) return b;
  let end = max; while (end > 0 && (b[end] & 0xc0) === 0x80) end--;
  return b.subarray(0, end);
}
/** The datasets of an IIM block as they are stored: record, number, bytes; and whether the block declares UTF-8. */
function rawDatasets(u8: Uint8Array): { sets: { rec: number; ds: number; data: Uint8Array }[]; utf8: boolean } {
  const sets: { rec: number; ds: number; data: Uint8Array }[] = []; let utf8 = false, p = 0;
  while (p + 5 <= u8.length) {
    if (u8[p] !== 0x1c) { p++; continue; }
    const rec = u8[p + 1], ds = u8[p + 2]; let len = (u8[p + 3] << 8) | u8[p + 4], q = p + 5;
    if (len & 0x8000) { const n = len & 0x7fff; len = 0; for (let i = 0; i < n; i++) len = len * 256 + u8[q + i]; q += n; }
    const data = u8.subarray(q, Math.min(u8.length, q + len));
    if (rec === 1 && ds === 90) utf8 = str(data, 0, 3) === '\x1b%G';
    sets.push({ rec, ds, data }); p = q + len;
  }
  return { sets, utf8 };
}
/**
 * Builds an IPTC-IIM block (UTF-8) from fields. `previous`: the block being replaced; the datasets in it that this
 * app has no field for (urgency, subject codes, the by-line's contact fields, a program's own records) are carried
 * over as they were, their text converted to UTF-8 when the old block was not.
 */
export function buildIim(f: IptcFields, previous?: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const ds = (rec: number, n: number, data: Uint8Array) => (data.length < 0x8000
    ? concat([Uint8Array.from([0x1c, rec, n, data.length >> 8, data.length & 255]), data])
    : concat([Uint8Array.from([0x1c, rec, n, 0x80, 4, data.length >>> 24, (data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255]), data]));
  const parts: Uint8Array[] = [ds(1, 90, ascii('\x1b%G')), ds(2, 0, Uint8Array.from([0, 4]))];
  const old = previous ? rawDatasets(previous) : { sets: [], utf8: true };
  const BINARY = new Set([0, 125, 200, 201, 202]); // record version, rasterized caption, preview: not text
  const keep = (x: { rec: number; ds: number; data: Uint8Array }) => (old.utf8 || x.rec !== 2 || BINARY.has(x.ds) ? x.data : enc.encode(new TextDecoder('latin1').decode(x.data)));
  for (const x of old.sets) if (x.rec === 1 && x.ds !== 90 && x.ds !== 0) parts.push(ds(1, x.ds, x.data)); // the envelope's other datasets
  for (const [n, key] of ORDER) {
    const v = f[key]; if (!v || (Array.isArray(v) && !v.length)) continue;
    for (const item of Array.isArray(v) ? v : [v]) { const b = clipUtf8(enc.encode(item), n === 120 ? 2000 : 255); if (b.length) parts.push(ds(2, n, b)); }
  }
  for (const x of old.sets) if ((x.rec === 2 && x.ds !== 0 && !DATASETS[x.ds]) || x.rec > 2) parts.push(ds(x.rec, x.ds, keep(x)));
  return concat(parts);
}

/** The IPTC fields of a JPEG (undefined when there is no IPTC block). */
export function readIptc(u8: Uint8Array): IptcFields | undefined {
  for (const s of jpegSegments(u8)) {
    if (s.marker !== 0xed) continue;
    const body = u8.subarray(s.start + 4, s.start + 2 + s.len);
    if (str(body, 0, 14) !== 'Photoshop 3.0\0') continue;
    const r = parseResources(body.subarray(14)).find((x) => x.id === 0x0404);
    if (r) return parseIim(r.data);
  }
  return undefined;
}

/** A copy of the JPEG with its IPTC block replaced (removed when `fields` is null); other Photoshop resources stay. */
export function writeIptc(u8: Uint8Array, fields: IptcFields | null): Uint8Array {
  const segs = jpegSegments(u8);
  const app13 = segs.find((s) => s.marker === 0xed && str(u8, s.start + 4, 14) === 'Photoshop 3.0\0');
  let res: Resource[] = app13 ? parseResources(u8.subarray(app13.start + 18, app13.start + 2 + app13.len)) : [];
  const previous = res.find((r) => r.id === 0x0404)?.data;
  res = res.filter((r) => r.id !== 0x0404);
  const any = fields && Object.values(fields).some((v) => (Array.isArray(v) ? v.length : !!v));
  if (any) res.unshift({ id: 0x0404, name: new Uint8Array(0), data: buildIim(fields!, previous) });
  const body = res.length ? concat([ascii('Photoshop 3.0\0'), buildResources(res)]) : null;
  const seg = body && body.length + 2 <= 65535 ? concat([Uint8Array.from([0xff, 0xed, (body.length + 2) >> 8, (body.length + 2) & 255]), body]) : new Uint8Array(0);
  if (app13) return concat([u8.subarray(0, app13.start), seg, u8.subarray(app13.start + 2 + app13.len)]);
  if (!seg.length) return u8;
  // Insert after the last APPn segment at the start (after EXIF/XMP, before the tables).
  let at = 2; for (const s of segs) { if (s.marker >= 0xe0 && s.marker <= 0xef) at = s.start + 2 + s.len; else break; }
  return concat([u8.subarray(0, at), seg, u8.subarray(at)]);
}
