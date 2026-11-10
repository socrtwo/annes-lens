/**
 * DICOM pictures (.dcm; the medical imaging standard, PS3.5 and PS3.10), read by the app's own code: the Part 10
 * header and raw data sets without it; implicit and explicit VR, little and big endian, deflated; the pixel module
 * (1, 8, 16 and 32 bits, signed and unsigned, BitsStored/HighBit, planar RGB, YBR_FULL and YBR_FULL_422, palette
 * color, MONOCHROME1/2); every frame as a page; the modality rescale and the first window (LINEAR, LINEAR_EXACT and
 * SIGMOID functions), or the full range of the frame when there is none. Compressed pixel data: RLE (own), JPEG
 * baseline and 12-bit extended (pdf.js's decoder and the app's own DCT decoder), JPEG lossless (the app's own process
 * 14 decoder), JPEG-LS (the app's own T.87 decoder), JPEG 2000 and HTJ2K (OpenJPEG as WebAssembly at full precision,
 * or pdf.js's 8-bit build of it when that runtime is not available). The video syntaxes are named in the error.
 * Modality and VOI lookup tables are applied (a VOI LUT before a window); overlay planes (separate or embedded in the
 * pixel words) are drawn in white. Presentation states are not applied.
 *
 * The pictures are for viewing only: the app is not a medical device and shows nothing for diagnosis.
 */
import { makeRaster, type DecodeResult, type DecodedPage } from './raster';
import { inflate } from './inflate';
import { jpxInfo } from './jpx';
import { decodeLjpeg } from '../raw/ljpeg';
import { decodeDctSamples } from './jpegdct';
import { decodeJpegLs } from './jpegls';
import { dicomTagName } from './dicomDict';
import { openJpegReady, decodeJ2k16 } from './openjpeg16';

export const NOT_FOR_DIAGNOSIS = 'For viewing only: Anne\'s Lens is not a medical device, and this picture is not for diagnosis or treatment decisions';

/** The SOP Instance UID of a file ('' when it has none), for matching references. */
export function dicomSopInstanceUid(u8: Uint8Array): string { try { return str(parseFile(u8), 8, 0x18) || ''; } catch { return ''; } }
const GSPS = '1.2.840.10008.5.1.4.1.1.11.1', CSPS = '1.2.840.10008.5.1.4.1.1.11.2', PCSPS = '1.2.840.10008.5.1.4.1.1.11.3', BSPS = '1.2.840.10008.5.1.4.1.1.11.4';
/** Whether a file is a (grayscale, color, pseudo-color or blending) softcopy presentation state: display instructions for another file's picture. */
export function isPresentationState(u8: Uint8Array): boolean { try { const d = parseFile(u8); const sop = str(d, 8, 0x16); return (sop === GSPS || sop === CSPS || sop === PCSPS || sop === BSPS) && !d.el.has(PIXEL); } catch { return false; } }

export interface GraphicObject { type: string; points: [number, number][]; filled: boolean; units: string }
export interface TextObject { text: string; anchor?: [number, number]; anchorVisible: boolean; box?: [number, number, number, number]; units: string; anchorUnits: string }
export interface PresentationState {
  name: string; label?: string; description?: string; references: string[];
  window?: { wc: number; ww: number; fn: string }; voiLut?: Lut | null; rescale?: { slope: number; intercept: number }; modalityLut?: Lut | null;
  inverse: boolean; presentationLut?: Lut | null;
  shutters: { shape: string; left?: number; right?: number; upper?: number; lower?: number; center?: [number, number]; radius?: number; vertices?: [number, number][]; gray: number }[];
  area?: { tl: [number, number]; br: [number, number] };
  rotation: number; flip: boolean;
  layers: { name: string; gray: number; graphics: GraphicObject[]; texts: TextObject[] }[];
  /** A pseudo-color state's palette (PS3.3 C.11.6), applied to the presentation values. */
  palette?: Palette;
  /** A blending state's superimposed layer (PS3.3 C.11.14): another picture, windowed, through its palette, over the underlying one at this opacity. */
  blend?: { references: string[]; window?: { wc: number; ww: number; fn: string }; voiLut?: Lut | null; palette?: Palette; opacity: number };
}
/** Reads a softcopy presentation state file (PS3.3 A.33): what it says to do with the picture it references. */
export function readPresentationState(u8: Uint8Array, name = ''): PresentationState {
  const d = parseFile(u8);
  const refs: string[] = [];
  for (const series of d.el.get(T(8, 0x1115))?.items || []) for (const im of series.get(T(8, 0x1140))?.items || []) { const uid = strIn(d, im, 8, 0x1155); if (uid) refs.push(uid); }
  const ps: PresentationState = { name, label: str(d, 0x70, 0x80), description: str(d, 0x70, 0x81), references: refs, inverse: (str(d, 0x2050, 0x20) || '').toUpperCase() === 'INVERSE', shutters: [], rotation: u16v(d, 0x70, 0x42) || 0, flip: (str(d, 0x70, 0x41) || '').toUpperCase() === 'Y', layers: [] };
  const windowOf = (el: Elements): { window?: PresentationState['window']; voiLut?: Lut | null } => {
    const voi = el.get(T(0x28, 0x3110))?.items?.[0], out: { window?: PresentationState['window']; voiLut?: Lut | null } = {};
    if (voi) {
      const wc = numsIn(d, voi, 0x28, 0x1050)[0], ww = numsIn(d, voi, 0x28, 0x1051)[0];
      if (Number.isFinite(wc) && Number.isFinite(ww) && ww >= 1) out.window = { wc, ww, fn: (strIn(d, voi, 0x28, 0x1056) || 'LINEAR').toUpperCase() };
      const lut = voi.get(T(0x28, 0x3010))?.items?.[0]; if (lut) out.voiLut = readLut(d, lut, true);
    }
    return out;
  };
  Object.assign(ps, windowOf(d.el));
  if (str(d, 8, 0x16) === BSPS) {
    // Blending (PS3.3 C.11.14): two items, the underlying picture (this state's references) and the superimposed one with its palette and opacity.
    const items = d.el.get(T(0x70, 0x402))?.items || [], refsOf = (el: Elements) => { const out: string[] = []; for (const series of el.get(T(8, 0x1115))?.items || []) for (const im of series.get(T(8, 0x1140))?.items || []) { const uid = strIn(d, im, 8, 0x1155); if (uid) out.push(uid); } return out; };
    const under = items.find((it) => (strIn(d, it, 0x70, 0x405) || '').toUpperCase() === 'UNDERLYING') || items[0], over = items.find((it) => (strIn(d, it, 0x70, 0x405) || '').toUpperCase() === 'SUPERIMPOSED') || items[1];
    if (under) { ps.references = refsOf(under); Object.assign(ps, windowOf(under)); }
    if (over) { const op = binIn(d, over, 0x70, 0x403)[0] ?? numsIn(d, over, 0x70, 0x403)[0]; ps.blend = { references: refsOf(over), ...windowOf(over), palette: readPaletteIn(d, over, u8, []) || undefined, opacity: Number.isFinite(op) ? Math.max(0, Math.min(1, op)) : 0.5 }; }
  }
  const slope = nums(d, 0x28, 0x1053)[0], icpt = nums(d, 0x28, 0x1052)[0];
  if (Number.isFinite(slope) && Number.isFinite(icpt)) ps.rescale = { slope, intercept: icpt };
  const ml = d.el.get(T(0x28, 0x3000))?.items?.[0]; if (ml) ps.modalityLut = readLut(d, ml, false);
  const pl = d.el.get(T(0x2050, 0x10))?.items?.[0]; if (pl) ps.presentationLut = readLut(d, pl, false);
  if (str(d, 8, 0x16) === PCSPS) { const pal = readPalette(d, u8, []); if (pal) ps.palette = pal; }
  const grayOf = (v: number | undefined) => (v === undefined ? 255 : Math.round((v / 65535) * 255));
  for (const shape of strs(d, 0x18, 0x1600)) {
    const sh = shape.toUpperCase(), gray = grayOf(u16v(d, 0x18, 0x1622) ?? 0);
    if (sh === 'RECTANGULAR') ps.shutters.push({ shape: sh, left: nums(d, 0x18, 0x1602)[0], right: nums(d, 0x18, 0x1604)[0], upper: nums(d, 0x18, 0x1606)[0], lower: nums(d, 0x18, 0x1608)[0], gray });
    else if (sh === 'CIRCULAR') { const c = nums(d, 0x18, 0x1610); ps.shutters.push({ shape: sh, center: [c[0], c[1]], radius: nums(d, 0x18, 0x1612)[0], gray }); }
    else if (sh === 'POLYGONAL') { const v = nums(d, 0x18, 0x1620), vertices: [number, number][] = []; for (let i = 0; i + 1 < v.length; i += 2) vertices.push([v[i], v[i + 1]]); ps.shutters.push({ shape: sh, vertices, gray }); }
  }
  const area = d.el.get(T(0x70, 0x5a))?.items?.[0];
  if (area) { const tl = binIn(d, area, 0x70, 0x52), br = binIn(d, area, 0x70, 0x53); if (tl.length >= 2 && br.length >= 2) ps.area = { tl: [tl[0], tl[1]], br: [br[0], br[1]] }; }
  const layerGray = new Map<string, number>();
  for (const l of d.el.get(T(0x70, 0x60))?.items || []) {
    const nm = strIn(d, l, 0x70, 0x02) || '', g = binIn(d, l, 0x70, 0x66)[0], lab = binIn(d, l, 0x70, 0x401);
    layerGray.set(nm, g !== undefined ? grayOf(g) : lab.length >= 1 ? Math.round((lab[0] / 65535) * 255) : 255);
  }
  for (const a of d.el.get(T(0x70, 0x01))?.items || []) {
    const nm = strIn(d, a, 0x70, 0x02) || '', layer = { name: nm, gray: layerGray.get(nm) ?? 255, graphics: [] as GraphicObject[], texts: [] as TextObject[] };
    for (const g of a.get(T(0x70, 0x09))?.items || []) {
      const data = binIn(d, g, 0x70, 0x22), points: [number, number][] = [];
      for (let i = 0; i + 1 < data.length; i += 2) points.push([data[i], data[i + 1]]);
      layer.graphics.push({ type: (strIn(d, g, 0x70, 0x23) || 'POLYLINE').toUpperCase(), points, filled: (strIn(d, g, 0x70, 0x24) || 'N').toUpperCase() === 'Y', units: (strIn(d, g, 0x70, 0x05) || 'PIXEL').toUpperCase() });
    }
    for (const t of a.get(T(0x70, 0x08))?.items || []) {
      const anchor = binIn(d, t, 0x70, 0x14), tl = binIn(d, t, 0x70, 0x10), br = binIn(d, t, 0x70, 0x11);
      layer.texts.push({ text: strIn(d, t, 0x70, 0x06) || '', anchor: anchor.length >= 2 ? [anchor[0], anchor[1]] : undefined, anchorVisible: (strIn(d, t, 0x70, 0x15) || 'Y').toUpperCase() === 'Y', box: tl.length >= 2 && br.length >= 2 ? [tl[0], tl[1], br[0], br[1]] : undefined, units: (strIn(d, t, 0x70, 0x03) || 'PIXEL').toUpperCase(), anchorUnits: (strIn(d, t, 0x70, 0x04) || 'PIXEL').toUpperCase() });
    }
    ps.layers.push(layer);
  }
  return ps;
}

/** A text rasterizer the app provides (a canvas): an alpha mask of the text in a 12 px sans-serif, or null where none exists. */
export type TextRasterizer = (text: string) => { width: number; height: number; alpha: Uint8ClampedArray } | null;

/** The transfer syntax UID of a Part 10 file ('' when there is none). */
export function dicomTransferSyntax(u8: Uint8Array): string { try { return parseFile(u8).ts; } catch { return ''; } }
export const isJ2kTransferSyntax = (ts: string): boolean => /^1\.2\.840\.10008\.1\.2\.4\.(9[0-3]|20[1-3])$/.test(ts);
export const isDicom = (u8: Uint8Array): boolean => u8.length > 132 && u8[128] === 0x44 && u8[129] === 0x49 && u8[130] === 0x43 && u8[131] === 0x4d;
/** A raw data set without the Part 10 header: a plausible first element (group 0002 or 0008, explicit or implicit VR). */
export function isRawDicom(u8: Uint8Array): boolean {
  if (u8.length < 16 || isDicom(u8)) return false;
  const g = u8[0] | (u8[1] << 8), e = u8[2] | (u8[3] << 8);
  if (!(g === 0x0002 || g === 0x0008) || e > 0x1000) return false;
  const vr = String.fromCharCode(u8[4], u8[5]);
  if (/^[A-Z]{2}$/.test(vr)) return true; // explicit VR
  const len = u8[4] | (u8[5] << 8) | (u8[6] << 16) | (u8[7] << 24);
  return len >= 0 && len < 4096; // implicit VR with a short value
}

const TS: Record<string, string> = {
  '1.2.840.10008.1.2': 'implicit VR little endian', '1.2.840.10008.1.2.1': 'explicit VR little endian', '1.2.840.10008.1.2.1.98': 'encapsulated uncompressed',
  '1.2.840.10008.1.2.1.99': 'deflated explicit VR little endian', '1.2.840.10008.1.2.2': 'explicit VR big endian', '1.2.840.10008.1.2.5': 'RLE lossless',
  '1.2.840.10008.1.2.4.50': 'JPEG baseline', '1.2.840.10008.1.2.4.51': 'JPEG extended (12-bit)', '1.2.840.10008.1.2.4.57': 'JPEG lossless', '1.2.840.10008.1.2.4.70': 'JPEG lossless (SV1)',
  '1.2.840.10008.1.2.4.80': 'JPEG-LS lossless', '1.2.840.10008.1.2.4.81': 'JPEG-LS near-lossless', '1.2.840.10008.1.2.4.90': 'JPEG 2000 lossless', '1.2.840.10008.1.2.4.91': 'JPEG 2000',
  '1.2.840.10008.1.2.4.92': 'JPEG 2000 multi-component lossless', '1.2.840.10008.1.2.4.93': 'JPEG 2000 multi-component', '1.2.840.10008.1.2.4.201': 'HTJ2K lossless', '1.2.840.10008.1.2.4.202': 'HTJ2K lossless RPCL', '1.2.840.10008.1.2.4.203': 'HTJ2K',
  '1.2.840.10008.1.2.4.100': 'MPEG-2 video', '1.2.840.10008.1.2.4.101': 'MPEG-2 video', '1.2.840.10008.1.2.4.102': 'MPEG-4 video', '1.2.840.10008.1.2.4.103': 'MPEG-4 video', '1.2.840.10008.1.2.4.104': 'MPEG-4 video', '1.2.840.10008.1.2.4.105': 'MPEG-4 video', '1.2.840.10008.1.2.4.106': 'MPEG-4 video', '1.2.840.10008.1.2.4.107': 'HEVC video', '1.2.840.10008.1.2.4.108': 'HEVC video',
};
const SOP: Record<string, string> = {
  '1.2.840.10008.5.1.4.1.1.1': 'Computed Radiography', '1.2.840.10008.5.1.4.1.1.1.1': 'Digital X-Ray', '1.2.840.10008.5.1.4.1.1.1.2': 'Digital Mammography', '1.2.840.10008.5.1.4.1.1.2': 'CT image', '1.2.840.10008.5.1.4.1.1.2.1': 'Enhanced CT image',
  '1.2.840.10008.5.1.4.1.1.3.1': 'Ultrasound multi-frame', '1.2.840.10008.5.1.4.1.1.4': 'MR image', '1.2.840.10008.5.1.4.1.1.4.1': 'Enhanced MR image', '1.2.840.10008.5.1.4.1.1.6.1': 'Ultrasound image', '1.2.840.10008.5.1.4.1.1.7': 'Secondary capture',
  '1.2.840.10008.5.1.4.1.1.12.1': 'X-Ray angiography', '1.2.840.10008.5.1.4.1.1.12.2': 'X-Ray fluoroscopy', '1.2.840.10008.5.1.4.1.1.20': 'Nuclear medicine', '1.2.840.10008.5.1.4.1.1.66.4': 'Segmentation', '1.2.840.10008.5.1.4.1.1.77.1.4': 'VL photograph',
  '1.2.840.10008.5.1.4.1.1.77.1.5.1': 'Ophthalmic photography', '1.2.840.10008.5.1.4.1.1.128': 'PET image', '1.2.840.10008.5.1.4.1.1.481.2': 'RT dose', '1.2.840.10008.5.1.4.1.1.481.1': 'RT image',
};
const CHARSETS: Record<string, string> = {
  'ISO_IR 100': 'iso-8859-1', 'ISO_IR 101': 'iso-8859-2', 'ISO_IR 109': 'iso-8859-3', 'ISO_IR 110': 'iso-8859-4', 'ISO_IR 144': 'iso-8859-5', 'ISO_IR 127': 'iso-8859-6', 'ISO_IR 126': 'iso-8859-7', 'ISO_IR 138': 'iso-8859-8', 'ISO_IR 148': 'iso-8859-9', 'ISO_IR 203': 'iso-8859-15',
  'ISO_IR 166': 'windows-874', 'ISO_IR 13': 'shift_jis', 'ISO_IR 192': 'utf-8', 'GB18030': 'gb18030', 'GBK': 'gbk', 'ISO 2022 IR 87': 'iso-2022-jp', 'ISO 2022 IR 149': 'euc-kr', 'ISO 2022 IR 58': 'gb2312',
};
const LONG_VR = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'SQ', 'UT', 'UN', 'UC', 'UR', 'SV', 'UV']);
const T = (g: number, e: number) => ((g << 16) | e) >>> 0;
let keepAll = false; // the tag dump keeps every sequence's items
const PIXEL = T(0x7fe0, 0x0010), FLOAT_PIXEL = T(0x7fe0, 0x0008), DOUBLE_PIXEL = T(0x7fe0, 0x0009), ITEM = 0xfffee000, ITEM_END = 0xfffee00d, SEQ_END = 0xfffee0dd;

interface Element { vr: string; off: number; len: number; be: boolean; frags?: { off: number; len: number }[]; bot?: number[]; items?: Elements[] }
type Elements = Map<number, Element>;
/** Sequences whose items are kept (the lookup tables). */
const KEEP_ITEMS = new Set([T(0x28, 0x3000), T(0x28, 0x3010), T(0x28, 0x3110), T(0x2050, 0x0010), T(0x70, 0x5a), T(0x70, 0x60), T(0x70, 0x01), T(0x70, 0x08), T(0x70, 0x09), T(0x70, 0x402), T(0x08, 0x1115), T(0x08, 0x1140)]);

/** The items of a sequence from `start` to `end` (or to the sequence delimiter when `end` is Infinity). */
function walkItems(u8: Uint8Array, start: number, end: number, explicit: boolean, be: boolean, collect: boolean, depth: number): { end: number; items: Elements[] } {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), items: Elements[] = [];
  let q = start;
  while (q + 8 <= Math.min(end, u8.length)) {
    const t = T(dv.getUint16(q, !be), dv.getUint16(q + 2, !be)), l = dv.getUint32(q + 4, !be);
    if (t === SEQ_END) { q += 8; break; }
    if (t !== ITEM) { q = Math.min(end, u8.length); break; }
    if (l === 0xffffffff) {
      if (depth > 16) throw new Error('Sequences nested too deeply');
      const item = new Map<number, Element>();
      q = parseDataset(u8, q + 8, u8.length, explicit, be, item, depth + 1);
      if (collect) items.push(item);
    } else {
      if (collect) { const item = new Map<number, Element>(); parseDataset(u8, q + 8, Math.min(u8.length, q + 8 + l), explicit, be, item, depth + 1); items.push(item); }
      q += 8 + l;
    }
  }
  return { end: q, items };
}

/** Parses one data set (or sequence item) into `into`, top-level elements only; returns the position after `end` or the delimiter. */
function parseDataset(u8: Uint8Array, start: number, end: number, explicit: boolean, be: boolean, into: Elements, depth: number): number {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const u16 = (o: number) => dv.getUint16(o, !be), u32 = (o: number) => dv.getUint32(o, !be);
  let p = start;
  while (p + 8 <= end) {
    const tag = T(u16(p), u16(p + 2));
    if (tag === ITEM_END || tag === SEQ_END) return p + 8;
    let vr = '', len: number, hdr: number;
    if (tag === ITEM) { vr = 'IT'; len = u32(p + 4); hdr = 8; }
    else if (explicit) {
      vr = String.fromCharCode(u8[p + 4], u8[p + 5]);
      if (LONG_VR.has(vr)) { len = u32(p + 8); hdr = 12; } else { len = u16(p + 6); hdr = 8; }
    } else { len = u32(p + 4); hdr = 8; }
    const off = p + hdr;
    if (len === 0xffffffff) {
      if (tag === PIXEL || tag === FLOAT_PIXEL || tag === DOUBLE_PIXEL) {
        // Encapsulated: a basic offset table item, then fragments, to the sequence delimiter.
        const frags: { off: number; len: number }[] = [], bot: number[] = [];
        let q = off, first = true;
        while (q + 8 <= u8.length) {
          const t = T(u16(q), u16(q + 2)), l = u32(q + 4);
          if (t === SEQ_END) { q += 8; break; }
          if (t !== ITEM) throw new Error(`Unexpected tag in encapsulated pixel data at ${q}`);
          if (first) { for (let i = 0; i + 4 <= l; i += 4) bot.push(u32(q + 8 + i)); first = false; }
          else frags.push({ off: q + 8, len: Math.min(l, u8.length - q - 8) });
          q += 8 + l;
        }
        into.set(tag, { vr: vr || 'OB', off, len: q - off, be, frags, bot });
        p = q; continue;
      }
      // A sequence (or UN) of undefined length: walk its items to the delimiter (UN items are implicit VR little endian).
      const w = walkItems(u8, off, Infinity, explicit && vr !== 'UN', vr === 'UN' ? false : be, keepAll || KEEP_ITEMS.has(tag), depth);
      if (!into.has(tag)) into.set(tag, { vr: vr || 'SQ', off, len: w.end - off, be, items: w.items });
      p = w.end; continue;
    }
    if (tag === ITEM) { p = off + len; continue; } // an item in a data set is out of place: skip it
    if ((KEEP_ITEMS.has(tag) || (keepAll && vr === 'SQ')) && !into.has(tag)) { // a sequence of known length whose items matter
      const w = walkItems(u8, off, off + len, explicit, be, true, depth);
      into.set(tag, { vr: 'SQ', off, len, be, items: w.items });
      p = off + len; continue;
    }
    if (!into.has(tag) || tag === PIXEL) into.set(tag, { vr, off, len: Math.min(len, u8.length - off), be });
    p = off + len;
    if (p > u8.length) break;
  }
  return p;
}

interface Parsed { el: Elements; u8: Uint8Array; ts: string; explicit: boolean; be: boolean; charset: string[] }

function parseFile(input: Uint8Array): Parsed {
  let u8 = input, p = 0, ts = '';
  const meta: Elements = new Map();
  if (isDicom(u8)) {
    p = 132;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    // The meta group is explicit VR little endian; its group length says where the data set starts.
    let q = p;
    while (q + 8 <= u8.length && dv.getUint16(q, true) === 0x0002) {
      const vr = String.fromCharCode(u8[q + 4], u8[q + 5]);
      const long = LONG_VR.has(vr), len = long ? dv.getUint32(q + 8, true) : dv.getUint16(q + 6, true), off = q + (long ? 12 : 8);
      meta.set(T(2, dv.getUint16(q + 2, true)), { vr, off, len, be: false });
      q = off + len;
    }
    p = q;
    const tsEl = meta.get(T(2, 0x10));
    if (tsEl) ts = latin1(u8, tsEl.off, tsEl.len).replace(/\0+$/, '').trim();
  }
  let explicit: boolean, be = false;
  if (ts === '1.2.840.10008.1.2.1.99') { u8 = inflate(u8.subarray(p)).data; p = 0; explicit = true; }
  else if (ts === '1.2.840.10008.1.2') explicit = false;
  else if (ts === '1.2.840.10008.1.2.2') { explicit = true; be = true; }
  else if (ts) explicit = true;
  else { // no transfer syntax: guess from the first element
    explicit = /^[A-Z]{2}$/.test(String.fromCharCode(u8[p + 4], u8[p + 5]));
    ts = explicit ? '1.2.840.10008.1.2.1' : '1.2.840.10008.1.2';
  }
  // Some writers label the data set wrongly: trust the bytes of its first element (two VR letters, or not).
  if (p + 6 <= u8.length) { const looksExplicit = /^[A-Z]{2}$/.test(String.fromCharCode(u8[p + 4], u8[p + 5])); if (looksExplicit !== explicit) { explicit = looksExplicit; if (explicit) be = false; } }
  const el: Elements = new Map();
  parseDataset(u8, p, u8.length, explicit, be, el, 0);
  if (!el.size) throw new Error('No DICOM data set was found');
  const cs = el.get(T(8, 5));
  const charset = cs ? latin1(u8, cs.off, cs.len).split('\\').map((s) => s.trim()) : [];
  return { el, u8, ts, explicit, be, charset };
}

const latin1 = (u8: Uint8Array, o: number, n: number) => { let s = ''; for (let i = o; i < o + n; i++) s += String.fromCharCode(u8[i]); return s; };
function decodeText(d: Parsed, e: Element): string {
  const bytes = d.u8.subarray(e.off, e.off + e.len);
  const label = d.charset.find((c) => c) || '';
  let s: string;
  try { s = new TextDecoder(CHARSETS[label] || 'iso-8859-1').decode(bytes); } catch { s = latin1(d.u8, e.off, e.len); }
  return s.replace(/[\0 ]+$/, '').replace(/^ +/, '');
}
const str = (d: Parsed, g: number, e: number): string | undefined => { const el = d.el.get(T(g, e)); return el ? decodeText(d, el) : undefined; };
const strIn = (d: Parsed, m: Elements, g: number, e: number): string | undefined => { const el = m.get(T(g, e)); return el ? decodeText(d, el) : undefined; };
const numsIn = (d: Parsed, m: Elements, g: number, e: number): number[] => (strIn(d, m, g, e) || '').split('\\').map((x) => Number(x.trim())).filter((v) => Number.isFinite(v));
/** Binary numbers of an element (FL, SL, US, SS) by its VR, or the text numbers of IS/DS. */
function binIn(d: Parsed, m: Elements, g: number, e: number): number[] {
  const el = m.get(T(g, e)); if (!el) return [];
  const dv = new DataView(d.u8.buffer, d.u8.byteOffset + el.off, el.len), out: number[] = [];
  if (el.vr === 'FL') for (let i = 0; i + 4 <= el.len; i += 4) out.push(dv.getFloat32(i, !el.be));
  else if (el.vr === 'FD') for (let i = 0; i + 8 <= el.len; i += 8) out.push(dv.getFloat64(i, !el.be));
  else if (el.vr === 'SL') for (let i = 0; i + 4 <= el.len; i += 4) out.push(dv.getInt32(i, !el.be));
  else if (el.vr === 'UL') for (let i = 0; i + 4 <= el.len; i += 4) out.push(dv.getUint32(i, !el.be));
  else if (el.vr === 'SS') for (let i = 0; i + 2 <= el.len; i += 2) out.push(dv.getInt16(i, !el.be));
  else if (el.vr === 'US' || el.vr === '') for (let i = 0; i + 2 <= el.len; i += 2) out.push(dv.getUint16(i, !el.be));
  else return numsIn(d, m, g, e);
  return out;
}
const strs = (d: Parsed, g: number, e: number): string[] => (str(d, g, e) || '').split('\\').map((s) => s.trim()).filter((s) => s !== '');
const nums = (d: Parsed, g: number, e: number): number[] => strs(d, g, e).map(Number).filter((v) => Number.isFinite(v));
/** A US (or SS) value, by the transfer syntax's byte order. */
function u16v(d: Parsed, g: number, e: number): number | undefined {
  const el = d.el.get(T(g, e));
  if (!el || el.len < 2) return undefined;
  if (el.vr === 'IS' || el.vr === 'DS') return nums(d, g, e)[0];
  const dv = new DataView(d.u8.buffer, d.u8.byteOffset + el.off, el.len);
  if (el.len >= 4 && (el.vr === 'UL' || el.vr === 'SL')) return dv.getUint32(0, !el.be);
  return dv.getUint16(0, !el.be);
}
const u16s = (d: Parsed, g: number, e: number): number[] => { const el = d.el.get(T(g, e)); if (!el) return []; const dv = new DataView(d.u8.buffer, d.u8.byteOffset + el.off, el.len), out: number[] = []; for (let i = 0; i + 2 <= el.len; i += 2) out.push(dv.getUint16(i, !el.be)); return out; };
const personName = (s?: string) => s ? s.split('=')[0].split('^').filter(Boolean).join(' ').trim() : undefined;
const dicomDate = (s?: string) => s && /^\d{8}/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;

/** Samples of one frame, unpacked (not yet rescaled or windowed): `rows × cols × spp` values, pixel-interleaved. */
interface Frame { v: Float32Array; alreadyRgb?: boolean; depthNote?: string }
interface PixelInfo { rows: number; cols: number; spp: number; pi: string; planar: number; bitsAlloc: number; bitsStored: number; highBit: number; signed: boolean; frames: number }

function unpackNative(bytes: Uint8Array, pi: PixelInfo, be: boolean): Float32Array {
  const { rows, cols, spp, bitsAlloc, bitsStored, highBit, signed, planar } = pi, n = rows * cols, out = new Float32Array(n * spp);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const shift = Math.max(0, highBit + 1 - bitsStored), mask = bitsStored >= 32 ? 0xffffffff : (1 << bitsStored) - 1, signBit = 2 ** (bitsStored - 1), wrap = 2 ** bitsStored;
  const raw = (i: number): number => {
    switch (bitsAlloc) {
      case 1: return (bytes[i >> 3] >> (i & 7)) & 1;
      case 8: return i < bytes.length ? bytes[i] : 0;
      case 16: return i * 2 + 2 <= bytes.length ? dv.getUint16(i * 2, !be) : 0;
      case 32: return i * 4 + 4 <= bytes.length ? dv.getUint32(i * 4, !be) : 0;
      case 64: return i * 8 + 8 <= bytes.length ? Number(dv.getBigUint64(i * 8, !be) & 0xffffffffn) : 0;
      default: throw new Error(`${bitsAlloc} bits allocated per sample are not supported`);
    }
  };
  for (let s = 0; s < spp; s++) for (let i = 0; i < n; i++) {
    let v = raw(planar === 1 ? s * n + i : i * spp + s);
    if (bitsAlloc > 1) { v = bitsStored >= 32 ? v >>> 0 : (v >>> shift) & mask; if (signed && v >= signBit) v -= wrap; }
    out[i * spp + s] = v;
  }
  return out;
}

/** PS3.5 Annex G: segments of PackBits-coded bytes, the most significant byte of each sample first. */
function unpackRle(bytes: Uint8Array, pi: PixelInfo): Float32Array {
  const { rows, cols, spp, bitsAlloc, bitsStored, signed } = pi, n = rows * cols, perSample = bitsAlloc / 8;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nseg = dv.getUint32(0, true);
  if (nseg !== spp * perSample) throw new Error(`RLE pixel data with ${nseg} segments for ${spp} samples of ${bitsAlloc} bits`);
  const out = new Float32Array(n * spp), seg = new Uint8Array(n);
  const signBit = 2 ** (bitsStored - 1), wrap = 2 ** bitsStored, mask = bitsStored >= 32 ? 0xffffffff : (1 << bitsStored) - 1;
  for (let s = 0; s < spp; s++) for (let b = 0; b < perSample; b++) {
    const k = s * perSample + b, start = dv.getUint32(4 + k * 4, true), end = k + 1 < nseg ? dv.getUint32(8 + k * 4, true) : bytes.length;
    let p = start, q = 0;
    seg.fill(0);
    while (p < end && q < n) {
      const h = bytes[p++];
      if (h < 128) { for (let i = 0; i <= h && q < n && p < end; i++) seg[q++] = bytes[p++]; }
      else if (h > 128) { const v = bytes[p++]; for (let i = 0; i < 257 - h && q < n; i++) seg[q++] = v; }
    }
    const scale = 2 ** (8 * (perSample - 1 - b));
    for (let i = 0; i < n; i++) out[i * spp + s] += seg[i] * scale;
  }
  if (bitsAlloc > 8 || signed) for (let i = 0; i < out.length; i++) { let v = out[i]; v = bitsStored >= 32 ? v : v % 2 ** bitsStored & mask; if (signed && v >= signBit) v -= wrap; out[i] = v; }
  return out;
}

const hasJfif = (u8: Uint8Array): boolean => { for (let p = 2; p + 4 < u8.length && u8[p] === 0xff && u8[p + 1] !== 0xda; p += 2 + ((u8[p + 2] << 8) | u8[p + 3])) { if (u8[p + 1] === 0xe0 && u8[p + 4] === 0x4a && u8[p + 5] === 0x46) return true; } return false; };

/** Frame bytes from the encapsulated fragments (PS3.5 A.4): the offset table, one fragment per frame, or JPEG starts. */
function frameFragments(pix: Element, u8: Uint8Array, frames: number): Uint8Array[] {
  const frags = pix.frags || [], out: Uint8Array[] = [];
  const join = (parts: { off: number; len: number }[]) => { if (parts.length === 1) return u8.subarray(parts[0].off, parts[0].off + parts[0].len); const n = parts.reduce((a, f) => a + f.len, 0), j = new Uint8Array(n); let q = 0; for (const f of parts) { j.set(u8.subarray(f.off, f.off + f.len), q); q += f.len; } return j; };
  if (!frags.length) return [];
  if (frames <= 1) return [join(frags)];
  if (pix.bot && pix.bot.length === frames) {
    const base = frags[0].off - 8;
    for (let f = 0; f < frames; f++) { const from = base + pix.bot[f], to = f + 1 < frames ? base + pix.bot[f + 1] : Infinity; out.push(join(frags.filter((g) => g.off - 8 >= from && g.off - 8 < to))); }
    return out;
  }
  if (frags.length === frames) return frags.map((f) => join([f]));
  // Group by the start of a JPEG or JPEG 2000 codestream.
  const starts = (f: { off: number }) => (u8[f.off] === 0xff && (u8[f.off + 1] === 0xd8 || u8[f.off + 1] === 0x4f)) || (u8[f.off] === 0 && u8[f.off + 1] === 0 && u8[f.off + 2] === 0 && u8[f.off + 3] === 0x0c);
  let cur: { off: number; len: number }[] = [];
  for (const f of frags) { if (starts(f) && cur.length) { out.push(join(cur)); cur = []; } cur.push(f); }
  if (cur.length) out.push(join(cur));
  if (out.length === frames) return out;
  throw new Error(`${frags.length} fragments for ${frames} frames without an offset table`);
}

/** A lookup table item (PS3.3 C.11.1/C.11.2): descriptor [entries, first mapped value, bits] and its data, as numbers. */
interface Lut { first: number; values: Float64Array; bits: number; max: number; explanation?: string }
function readLut(d: Parsed, item: Elements, signedFirst: boolean): Lut | null {
  const desc = item.get(T(0x28, 0x3002)), data = item.get(T(0x28, 0x3006));
  if (!desc || !data || desc.len < 6) return null;
  const dv = new DataView(d.u8.buffer, d.u8.byteOffset + desc.off, desc.len);
  const n = dv.getUint16(0, !desc.be) || 65536, f = dv.getUint16(2, !desc.be), bits = dv.getUint16(4, !desc.be) || 16;
  const first = signedFirst && f > 32767 ? f - 65536 : f;
  const values = new Float64Array(n);
  const dd = new DataView(d.u8.buffer, d.u8.byteOffset + data.off, data.len);
  const bytes = bits <= 8 && data.len < n * 2;
  let max = 1;
  for (let i = 0; i < n; i++) { const v = bytes ? (i < data.len ? d.u8[data.off + i] : 0) : i * 2 + 2 <= data.len ? dd.getUint16(i * 2, !data.be) : 0; values[i] = v; if (v > max) max = v; }
  const ex = item.get(T(0x28, 0x3003));
  return { first, values, bits, max, explanation: ex ? decodeText(d, ex) : undefined };
}
const lutAt = (l: Lut, x: number): number => l.values[Math.max(0, Math.min(l.values.length - 1, Math.round(x) - l.first))];

/** Overlay planes (PS3.3 C.9): their bits, 1 per pixel, row-major, origin 1-based; embedded planes come from the pixel words. */
interface Overlay { group: number; rows: number; cols: number; originRow: number; originCol: number; frames: number; frameOrigin: number; bits: Uint8Array | null; bitPosition: number; type: string }
function readOverlays(d: Parsed): Overlay[] {
  const out: Overlay[] = [];
  for (let g = 0x6000; g <= 0x601e; g += 2) {
    const rows = u16v(d, g, 0x10), cols = u16v(d, g, 0x11);
    if (!rows || !cols) continue;
    const origin = d.el.get(T(g, 0x50));
    let originRow = 1, originCol = 1;
    if (origin && origin.len >= 4) { const dv = new DataView(d.u8.buffer, d.u8.byteOffset + origin.off, origin.len); originRow = dv.getInt16(0, !origin.be); originCol = dv.getInt16(2, !origin.be); }
    const data = d.el.get(T(g, 0x3000));
    out.push({ group: g, rows, cols, originRow, originCol, frames: Math.max(1, nums(d, g, 0x15)[0] || 1), frameOrigin: u16v(d, g, 0x51) || 1, bits: data ? d.u8.subarray(data.off, data.off + data.len) : null, bitPosition: u16v(d, g, 0x102) || 0, type: str(d, g, 0x40) || 'G' });
  }
  return out;
}

/** `dec` is pdf.js's image-decoders module (JpegImage, JpxImage); needed only for JPEG and JPEG 2000 pixel data. */
export interface DicomWindow { wc: number; ww: number; fn?: string }
export async function decodeDicom(input: Uint8Array, dec: any = null, o: { maxFrames?: number; maxPixels?: number; presentation?: PresentationState; drawText?: TextRasterizer; /** Draw the overlay planes (default true). */ overlays?: boolean; /** Window / Level: a window of the user's instead of the file's (and its VOI LUT), or 'full' for the frame's whole range. */ window?: DicomWindow | 'full'; /** A blending state's superimposed picture, decoded (gray) with the state's window for it. */ superimposed?: ReturnType<typeof makeRaster> } = {}): Promise<DecodeResult> {
  const ps = o.presentation;
  const d = parseFile(input), warnings: string[] = [], info: Record<string, string> = {};
  const { u8, ts, be } = d;
  const rows = u16v(d, 0x28, 0x10) || 0, cols = u16v(d, 0x28, 0x11) || 0;
  const pix = d.el.get(PIXEL) || d.el.get(FLOAT_PIXEL) || d.el.get(DOUBLE_PIXEL);
  const sop = str(d, 8, 0x16) || '', modality = str(d, 8, 0x60);
  const describe = () => {
    const put = (k: string, v?: string) => { if (v) info[k] = v; };
    put('kind', SOP[sop] || (sop ? `SOP class ${sop}` : undefined));
    put('modality', modality);
    put('patient', personName(str(d, 0x10, 0x10)));
    put('patient ID', str(d, 0x10, 0x20));
    put('born', dicomDate(str(d, 0x10, 0x30)));
    put('sex', str(d, 0x10, 0x40));
    put('study date', dicomDate(str(d, 8, 0x20)));
    put('study', str(d, 8, 0x1030));
    put('series', str(d, 8, 0x103e));
    put('body part', str(d, 0x18, 0x15));
    put('institution', str(d, 8, 0x80));
    put('equipment', [str(d, 8, 0x70), str(d, 8, 0x1090)].filter(Boolean).join(' '));
    put('instance', str(d, 0x20, 0x13));
    put('comments', str(d, 0x20, 0x4000));
    put('transfer syntax', `${TS[ts] || ts}${ts && TS[ts] ? ` (${ts})` : ''}`);
    put('character set', d.charset.filter(Boolean).join(', '));
    if (str(d, 0x28, 0x2110) === '01') put('lossy compression', [str(d, 0x28, 0x2114), nums(d, 0x28, 0x2112)[0] ? `ratio ${nums(d, 0x28, 0x2112)[0]}` : ''].filter(Boolean).join(', ') || 'yes');
  };
  describe();
  if (!pix || !rows || !cols) throw new Error(`This DICOM file has no picture${info.kind ? ` (${info.kind}${modality ? `, ${modality}` : ''})` : ''}`);
  let pi: PixelInfo = {
    rows, cols, spp: u16v(d, 0x28, 2) || 1, pi: (str(d, 0x28, 4) || 'MONOCHROME2').toUpperCase(), planar: u16v(d, 0x28, 6) || 0,
    bitsAlloc: u16v(d, 0x28, 0x100) || 8, bitsStored: u16v(d, 0x28, 0x101) || 0, highBit: u16v(d, 0x28, 0x102) || 0, signed: u16v(d, 0x28, 0x103) === 1, frames: Math.max(1, nums(d, 0x28, 8)[0] || 1),
  };
  if (!pi.bitsStored) pi.bitsStored = pi.bitsAlloc;
  if (pi.highBit < pi.bitsStored - 1) pi.highBit = pi.bitsStored - 1;
  const floatPixels = !d.el.get(PIXEL) && !!pix;
  if (floatPixels) { pi.bitsAlloc = d.el.get(DOUBLE_PIXEL) ? 64 : 32; pi.signed = false; }
  const maxFrames = o.maxFrames ?? 400, maxPixels = o.maxPixels ?? 150e6;
  let frames = pi.frames;
  if (frames > maxFrames) { warnings.push(`Only the first ${maxFrames} of ${frames} frames are shown`); frames = maxFrames; }
  if (rows * cols * frames > maxPixels) { const f = Math.max(1, Math.floor(maxPixels / (rows * cols))); warnings.push(`Only the first ${f} of ${frames} frames are shown (too many pixels)`); frames = f; }
  const encapsulated = !!pix.frags;
  const jpegTs = ts.startsWith('1.2.840.10008.1.2.4.');
  const needDec = jpegTs && /\.(50|51|9[0-3]|20[1-3])$/.test(ts);
  const noDecoder = () => new Error(`${TS[ts]} pixel data needs the JPEG decoders, which did not load`);
  if (/\.10[0-8]$/.test(ts)) throw new Error(`${TS[ts]} pixel data is a video stream, not a picture`);
  if (jpegTs && !needDec && !/\.(57|70|8[01])$/.test(ts)) throw new Error(`Transfer syntax ${ts} is not supported`);
  const frameBytes = encapsulated ? frameFragments(pix, u8, pi.frames) : null;
  const is422 = pi.pi === 'YBR_FULL_422' && pi.spp === 3 && !encapsulated;
  const frameSize = is422 ? rows * cols * 2 * (pi.bitsAlloc / 8) : Math.ceil((rows * cols * pi.spp * pi.bitsAlloc) / 8);
  const rescaleSlope = ps?.rescale ? ps.rescale.slope : nums(d, 0x28, 0x1053)[0], rescaleIntercept = ps?.rescale ? ps.rescale.intercept : nums(d, 0x28, 0x1052)[0];
  let wc = nums(d, 0x28, 0x1050)[0], ww = nums(d, 0x28, 0x1051)[0], voiFn = (str(d, 0x28, 0x1056) || 'LINEAR').toUpperCase();
  if (ps?.window) { wc = ps.window.wc; ww = ps.window.ww; voiFn = ps.window.fn; }
  if (o.window === 'full') { wc = NaN; ww = NaN; } else if (o.window) { wc = o.window.wc; ww = o.window.ww; voiFn = (o.window.fn || 'LINEAR').toUpperCase(); }
  const haveWindow = Number.isFinite(wc) && Number.isFinite(ww) && ww >= 1;
  const haveRescale = Number.isFinite(rescaleSlope) && Number.isFinite(rescaleIntercept) && !(rescaleSlope === 1 && rescaleIntercept === 0);
  const spacing = nums(d, 0x28, 0x30).length === 2 ? nums(d, 0x28, 0x30) : nums(d, 0x18, 0x1164).length === 2 ? nums(d, 0x18, 0x1164) : null;
  if (spacing) info['pixel spacing'] = `${spacing[0]} × ${spacing[1]} mm`;
  const thick = nums(d, 0x18, 0x50)[0];
  if (Number.isFinite(thick)) info['slice thickness'] = `${thick} mm`;
  if (haveRescale) info.rescale = `× ${rescaleSlope} + ${rescaleIntercept}${modality === 'CT' ? ' (Hounsfield units)' : ''}`;
  if (haveWindow) info.window = `center ${wc}, width ${ww}${voiFn !== 'LINEAR' ? ` (${voiFn})` : ''}${o.window ? ' (Window / Level)' : nums(d, 0x28, 0x1050).length > 1 ? ` (first of ${nums(d, 0x28, 0x1050).length})` : ''}`;
  else if (o.window === 'full') info.window = 'the full range (Window / Level)';
  const fileWindow = nums(d, 0x28, 0x1050).length && nums(d, 0x28, 0x1051).length ? `${nums(d, 0x28, 0x1050)[0]}/${nums(d, 0x28, 0x1051)[0]}` : '';
  if (fileWindow && o.window) info['file window'] = `center ${nums(d, 0x28, 0x1050)[0]}, width ${nums(d, 0x28, 0x1051)[0]}`;
  info.pixels = `${pi.spp === 1 ? 'monochrome' : `${pi.spp} samples`}, ${pi.bitsStored} of ${pi.bitsAlloc} bits${pi.signed ? ', signed' : ''}, ${pi.pi}${pi.frames > 1 ? `, ${pi.frames} frames` : ''}`;
  const overlays = readOverlays(d);
  const modalityLut = ps?.modalityLut || (ps?.rescale ? null : (d.el.get(T(0x28, 0x3000))?.items || []).map((it) => readLut(d, it, pi.signed)).find(Boolean) || null);
  const voiLut = ps?.window || o.window ? null : ps?.voiLut || (d.el.get(T(0x28, 0x3010))?.items || []).map((it) => readLut(d, it, true)).find(Boolean) || null;
  if (modalityLut) info['modality LUT'] = `${modalityLut.values.length} entries from ${modalityLut.first}${modalityLut.explanation ? ` (${modalityLut.explanation})` : ''}`;
  if (voiLut) info['VOI LUT'] = `${voiLut.values.length} entries from ${voiLut.first}${voiLut.explanation ? ` (${voiLut.explanation})` : ''}${haveWindow ? '; used instead of the window' : ''}`;
  if (overlays.length) info.overlays = overlays.map((o) => `${o.rows} × ${o.cols} at (${o.originCol}, ${o.originRow})${o.type === 'R' ? ', ROI' : ''}${o.bits ? '' : ' (embedded)'}`).join('; ');

  // The palette (PS3.3 C.7.6.3.1.5/6): descriptors [entries, first index, bits], data as 16-bit words (or bytes).
  const pal = pi.pi === 'PALETTE COLOR' ? readPalette(d, u8, warnings) : null;
  const palette = pal?.rgb || null, paletteFirst = pal?.first || 0, paletteN = pal?.n || 0;
  if (pi.pi === 'PALETTE COLOR' && !pal) warnings.push('The palette is missing: the picture is shown gray');

  const pages: DecodedPage[] = [];
  let depthNote = '';
  for (let f = 0; f < frames; f++) {
    let fr: Frame;
    if (!encapsulated) {
      const start = pix.off + f * frameSize;
      if (start >= pix.off + pix.len) { warnings.push(`The pixel data ends after frame ${f} of ${frames}`); break; }
      if (floatPixels) {
        const n = rows * cols * pi.spp, v = new Float32Array(n), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), w = pi.bitsAlloc / 8;
        for (let i = 0; i < n; i++) { const at = start + i * w; v[i] = at + w <= u8.length ? (w === 4 ? dv.getFloat32(at, !be) : dv.getFloat64(at, !be)) : 0; }
        fr = { v };
      } else if (is422) fr = { v: deinterleave422(unpackNative(u8.subarray(start, Math.min(u8.length, start + frameSize)), { ...pi, spp: 1, cols: cols * 2 }, be), rows, cols) };
      else fr = { v: unpackNative(u8.subarray(start, Math.min(u8.length, start + frameSize)), pi, be) };
    } else {
      const bytes = frameBytes![f];
      if (!bytes) { warnings.push(`Frame ${f + 1} is missing from the pixel data`); break; }
      if (ts === '1.2.840.10008.1.2.5') fr = { v: unpackRle(bytes, pi) };
      else if (ts === '1.2.840.10008.1.2.1.98') fr = { v: unpackNative(bytes, pi, false) };
      else if (/\.(8[01])$/.test(ts)) {
        const j = decodeJpegLs(bytes);
        if (j.width !== cols || j.height !== rows) warnings.push(`Frame ${f + 1} is ${j.width} × ${j.height}, not ${cols} × ${rows}`);
        for (const w of j.warnings) if (!warnings.includes(w)) warnings.push(w);
        if (j.near && f === 0) info['lossy compression'] = info['lossy compression'] || `JPEG-LS near-lossless, error up to ${j.near}`;
        if (j.mapped) { // a JPEG-LS mapping table turned the samples into gray, a 16-bit value or RGB(A): shown as the table says
          if (f === 0) info['JPEG-LS mapping table'] = `table ${j.mapped.id}, ${j.mapped.entries} entries of ${j.mapped.width} byte${j.mapped.width > 1 ? 's' : ''}`;
          if (j.comps !== pi.spp || j.precision !== pi.bitsStored) { pi = { ...pi, spp: j.comps, bitsStored: j.precision, bitsAlloc: j.precision > 8 ? 16 : 8, highBit: j.precision - 1, signed: false, planar: 0, pi: j.comps >= 3 ? 'RGB' : 'MONOCHROME2' }; if (f === 0) warnings.push(`The JPEG-LS mapping table gives ${j.comps >= 3 ? 'color' : `${j.precision}-bit`} samples; the file's photometric interpretation is set aside`); }
        }
        fr = { v: samplesFrom(j.data, j.width, j.height, j.comps, pi, pi.signed) };
      } else if (/\.(57|70)$/.test(ts)) {
        const lj = decodeLjpeg(bytes);
        if (lj.width !== cols || lj.height !== rows) warnings.push(`Frame ${f + 1} is ${lj.width} × ${lj.height}, not ${cols} × ${rows}`);
        fr = { v: samplesFrom(lj.data, lj.width, lj.height, lj.comps, pi, pi.signed) };
      } else if (/\.(50|51)$/.test(ts)) {
        let precision = 8;
        for (let p = 2; p + 9 < bytes.length && bytes[p] === 0xff; p += 2 + ((bytes[p + 2] << 8) | bytes[p + 3])) if ((bytes[p + 1] >= 0xc0 && bytes[p + 1] <= 0xc3) || (bytes[p + 1] >= 0xc5 && bytes[p + 1] <= 0xc7) || (bytes[p + 1] >= 0xc9 && bytes[p + 1] <= 0xcb)) { precision = bytes[p + 4]; break; }
        if (precision > 8 || pi.spp === 1 && pi.bitsStored > 8) {
          const s = decodeDctSamples(bytes);
          if (s.width !== cols || s.height !== rows) warnings.push(`Frame ${f + 1} is ${s.width} × ${s.height}, not ${cols} × ${rows}`);
          fr = { v: samplesFrom(s.data, s.width, s.height, s.comps, pi, pi.signed) };
        } else {
          if (!dec) throw noDecoder();
          const img = new dec.JpegImage(pi.pi === 'RGB' && !hasJfif(bytes) ? { colorTransform: 0 } : {});
          img.parse(bytes);
          const out: Uint8ClampedArray = img.getData({ width: img.width, height: img.height, forceRGB: false });
          const n = out.length / (img.width * img.height);
          if (img.width !== cols || img.height !== rows) warnings.push(`Frame ${f + 1} is ${img.width} × ${img.height}, not ${cols} × ${rows}`);
          fr = { v: samplesFrom(out, img.width, img.height, n, pi, false), alreadyRgb: n === 3 };
        }
      } else if (openJpegReady()) { // JPEG 2000 / HTJ2K through OpenJPEG at full precision
        const j = decodeJ2k16(bytes);
        if (j.width !== cols || j.height !== rows) warnings.push(`Frame ${f + 1} is ${j.width} × ${j.height}, not ${cols} × ${rows}`);
        fr = { v: samplesFrom(j.samples, j.width, j.height, j.components, pi, false), alreadyRgb: j.components === 3 && pi.pi.startsWith('YBR') };
      } else { // JPEG 2000 / HTJ2K through pdf.js's OpenJPEG: 8-bit samples, negative values lost
        if (!dec) throw noDecoder();
        const jinfo = jpxInfo(bytes), depth = jinfo.depths[0] || 8, signed = jinfo.signed[0];
        const data: Uint8ClampedArray = await dec.JpxImage.instance.decode(bytes, {});
        const n = data.length / (jinfo.width * jinfo.height);
        if (jinfo.width !== cols || jinfo.height !== rows) warnings.push(`Frame ${f + 1} is ${jinfo.width} × ${jinfo.height}, not ${cols} × ${rows}`);
        const v = samplesFrom(data, jinfo.width, jinfo.height, n, pi, false);
        if (depth > 8) { const k = 2 ** (depth - 8); for (let i = 0; i < v.length; i++) v[i] *= k; depthNote = `the full-precision JPEG 2000 decoder was not available: these ${depth}-bit samples were reduced to 8 bits, so the window is applied in steps of ${k}${signed ? ' and negative values are lost' : ''}`; }
        fr = { v, alreadyRgb: n === 3 && (jinfo.colorspace === 'sYCC' || pi.pi.startsWith('YBR')) };
      }
    }
    const r = makeRaster(cols, rows), out = r.data, n = rows * cols, v = fr.v, spp = v.length / n;
    const notes: string[] = [];
    if (pi.pi === 'PALETTE COLOR' && palette) {
      for (let i = 0; i < n; i++) { const k = Math.min(paletteN - 1, Math.max(0, Math.round(v[i]) - paletteFirst)); out[i * 4] = palette[0][k]; out[i * 4 + 1] = palette[1][k]; out[i * 4 + 2] = palette[2][k]; out[i * 4 + 3] = 255; }
      notes.push(`palette color, ${paletteN} entries`);
    } else if (spp >= 3) {
      const max = pi.bitsStored > 8 && !fr.alreadyRgb ? 2 ** pi.bitsStored - 1 : 255;
      const ybr = !fr.alreadyRgb && (pi.pi === 'YBR_FULL' || pi.pi === 'YBR_FULL_422');
      for (let i = 0; i < n; i++) {
        let R = v[i * spp] * 255 / max, G = v[i * spp + 1] * 255 / max, B = v[i * spp + 2] * 255 / max;
        if (ybr) { const Y = R, cb = G - 128, cr = B - 128; R = Y + 1.402 * cr; G = Y - 0.344136 * cb - 0.714136 * cr; B = Y + 1.772 * cb; }
        out[i * 4] = Math.round(R); out[i * 4 + 1] = Math.round(G); out[i * 4 + 2] = Math.round(B); out[i * 4 + 3] = 255;
      }
      notes.push(`${pi.pi}${pi.bitsStored > 8 ? `, ${pi.bitsStored} bits per sample` : ''}`);
    } else {
      let lo = Infinity, hi = -Infinity;
      const slope = haveRescale ? rescaleSlope : 1, icpt = haveRescale ? rescaleIntercept : 0;
      const modal = (raw: number) => (modalityLut ? lutAt(modalityLut, raw) : raw * slope + icpt);
      if (!haveWindow && !voiLut) for (let i = 0; i < n; i++) { const x = modal(v[i * spp]); if (x < lo) lo = x; if (x > hi) hi = x; }
      const inv = pi.pi === 'MONOCHROME1';
      for (let i = 0; i < n; i++) {
        const x = modal(v[i * spp]);
        let y: number;
        if (voiLut) y = (lutAt(voiLut, x) / voiLut.max) * 255;
        else if (haveWindow) {
          if (voiFn === 'SIGMOID') y = 255 / (1 + Math.exp((-4 * (x - wc)) / ww));
          else if (voiFn === 'LINEAR_EXACT') y = x <= wc - ww / 2 ? 0 : x > wc + ww / 2 ? 255 : ((x - (wc - ww / 2)) / ww) * 255;
          else y = x <= wc - 0.5 - (ww - 1) / 2 ? 0 : x > wc - 0.5 + (ww - 1) / 2 ? 255 : ((x - (wc - 0.5)) / (ww - 1) + 0.5) * 255;
        } else y = hi > lo ? ((x - lo) / (hi - lo)) * 255 : 0;
        if (ps?.presentationLut) y = (lutAt(ps.presentationLut, (y / 255) * (ps.presentationLut.values.length - 1) + ps.presentationLut.first) / ps.presentationLut.max) * 255;
        y = Math.round(Math.max(0, Math.min(255, y)));
        if (inv !== !!ps?.inverse) y = 255 - y;
        out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = y; out[i * 4 + 3] = 255;
      }
      const after = modalityLut ? ', after the modality lookup table' : haveRescale ? ', after the rescale' : '';
      notes.push(voiLut ? `the file's VOI lookup table (${voiLut.values.length} entries${voiLut.explanation ? `, ${voiLut.explanation}` : ''}) applied${after}` : haveWindow ? `window center ${wc}, width ${ww}${voiFn !== 'LINEAR' ? ` (${voiFn})` : ''}${after}` : `shown over the frame's range ${fmt(lo)} to ${fmt(hi)}${after ? ` (${after.slice(2)})` : ''} (no window in the file)`);
      if (inv) notes.push('MONOCHROME1: low values are bright');
    }
    let drawn = 0;
    for (const ov of o.overlays === false ? [] : overlays) {
      const of = ov.frames > 1 || ov.frameOrigin > 1 ? f - (ov.frameOrigin - 1) : 0;
      if (of < 0 || of >= ov.frames) continue;
      const per = ov.rows * ov.cols;
      const bit = (i: number): number => {
        if (ov.bits) { const k = of * per + i; return k >> 3 < ov.bits.length ? (ov.bits[k >> 3] >> (k & 7)) & 1 : 0; }
        if (encapsulated || pi.bitsAlloc !== 16) return 0;
        const at = pix.off + f * frameSize + i * 2 * pi.spp; // embedded in the pixel words of this frame
        return at + 2 <= u8.length ? ((be ? (u8[at] << 8) | u8[at + 1] : u8[at] | (u8[at + 1] << 8)) >> ov.bitPosition) & 1 : 0;
      };
      let any = false;
      for (let oy = 0; oy < ov.rows; oy++) { const y = oy + ov.originRow - 1; if (y < 0 || y >= rows) continue; for (let ox = 0; ox < ov.cols; ox++) { const x = ox + ov.originCol - 1; if (x < 0 || x >= cols) continue; if (bit(oy * ov.cols + ox)) { const o = (y * cols + x) * 4; out[o] = out[o + 1] = out[o + 2] = 255; any = true; } } }
      if (any) drawn++;
    }
    if (drawn) notes.push(`${drawn} overlay plane${drawn > 1 ? 's' : ''} drawn in white`);
    else if (o.overlays === false && overlays.length) notes.push(`${overlays.length} overlay plane${overlays.length > 1 ? 's' : ''} not drawn (View ▸ DICOM Overlay Planes)`);
    let page: { raster: ReturnType<typeof makeRaster>; dpiSwap: boolean } = { raster: r, dpiSwap: false };
    if (ps) { page = applyPresentation(r, ps, o.drawText, notes, warnings, f === 0 ? info : {}, o.superimposed); }
    if (pi.frames > 1) notes.unshift(`frame ${f + 1} of ${pi.frames}`);
    notes.push(`${pi.bitsStored}-bit ${pi.spp === 1 ? 'monochrome' : `${pi.spp}-sample`} ${TS[ts] || 'DICOM'} pixel data`);
    if (depthNote) notes.push(depthNote);
    notes.push(NOT_FOR_DIAGNOSIS);
    const dpi: [number, number] | undefined = spacing && spacing[0] > 0 && spacing[1] > 0 ? (page.dpiSwap ? [25.4 / spacing[0], 25.4 / spacing[1]] : [25.4 / spacing[1], 25.4 / spacing[0]]) : undefined;
    pages.push({ width: page.raster.width, height: page.raster.height, frames: [{ raster: page.raster, delay: 0 }], loops: 0, bitDepth: pi.bitsStored, hasAlpha: false, notes, dpi });
  }
  if (!pages.length) throw new Error('No frame could be read');
  info.notice = NOT_FOR_DIAGNOSIS;
  return { pages, info, warnings };
}

/** Decoder output (interleaved samples) into the frame's layout, applying BitsStored masking and the sign when asked. */
export interface Palette { rgb: Uint8Array[]; first: number; n: number }
/** The palette of a PALETTE COLOR picture or a pseudo-color presentation state: 8-bit RGB entries from 8- or 16-bit data, plain or segmented. */
function readPalette(d: Parsed, u8: Uint8Array, warnings: string[]): Palette | null { return readPaletteIn(d, d.el, u8, warnings); }
/** The same from a sequence item's elements (a blending state's superimposed layer). */
function readPaletteIn(d: Parsed, elements: Elements, u8: Uint8Array, warnings: string[]): Palette | null {
  let palette: Uint8Array[] | null = null, paletteFirst = 0, paletteN = 0;
  const descEl = elements.get(T(0x28, 0x1101)), desc: number[] = [];
  if (descEl) { const dv = new DataView(u8.buffer, u8.byteOffset + descEl.off, descEl.len); for (let i = 0; i + 1 < descEl.len; i += 2) desc.push(dv.getUint16(i, !descEl.be)); }
  if (desc.length >= 3 && elements.has(T(0x28, 0x1221))) { // segmented (PS3.3 C.7.9.2): discrete, linear and indirect segments expanded
    paletteN = desc[0] || 65536; paletteFirst = desc[1] > 32767 ? desc[1] - 65536 : desc[1];
    const max = desc[2] === 8 ? 255 : 65535;
    palette = [0x1221, 0x1222, 0x1223].map((e) => {
      const el = elements.get(T(0x28, e)), out = new Uint8Array(paletteN);
      if (!el) return out;
      // The segments are a stream of 16-bit words, or of bytes when the entries are 8 bits wide; an indirect segment's offset counts bytes.
      const bytes8 = desc[2] === 8, dv = new DataView(u8.buffer, u8.byteOffset + el.off, el.len), nw = bytes8 ? el.len : el.len >> 1;
      const word = (i: number) => (i < nw ? (bytes8 ? u8[el.off + i] : dv.getUint16(i * 2, !el.be)) : 0);
      const vals: number[] = [];
      // Indirect segments may point at each other; a crafted table would be walked exponentially often. The whole expansion gets
      // a budget of segment visits (a real table needs at most one per entry).
      let visits = 4 * paletteN + 64;
      const run = (from: number, segments: number, depth: number): number => { // returns the element position after the segments
        let p = from;
        for (let s = 0; s < segments && p + 1 < nw && vals.length < paletteN; s++) {
          if (--visits < 0) { if (visits === -1) warnings.push('The segmented palette refers to itself; it was cut short'); break; }
          const op = word(p), n = word(p + 1);
          if (op === 0) { for (let i = 0; i < n; i++) vals.push(word(p + 2 + i)); p += 2 + n; }
          else if (op === 1) { const y = word(p + 2), y0 = vals.length ? vals[vals.length - 1] : 0; for (let i = 1; i <= n; i++) vals.push(Math.round(y0 + ((y - y0) * i) / n)); p += 3; }
          else if (op === 2) {
            const off = bytes8 ? word(p + 2) | (word(p + 3) << 8) | (word(p + 4) << 16) | (word(p + 5) << 24) : word(p + 2) | (word(p + 3) << 16);
            if (depth < 8) run(bytes8 ? off : off >> 1, n, depth + 1);
            p += bytes8 ? 6 : 4;
          }
          else { warnings.push(`Unknown palette segment type ${op}`); break; }
        }
        return p;
      };
      run(0, 1e9, 0);
      if (vals.length < paletteN) warnings.push('The segmented palette is shorter than its descriptor says');
      for (let i = 0; i < paletteN; i++) out[i] = Math.round(((vals[i] ?? 0) * 255) / max);
      return out;
    });
  } else if (desc.length >= 3) {
    paletteN = desc[0] || 65536; paletteFirst = desc[1] > 32767 ? desc[1] - 65536 : desc[1];
    palette = [0x1201, 0x1202, 0x1203].map((e) => {
      const el = elements.get(T(0x28, e)), out = new Uint8Array(paletteN);
      if (!el) return out;
      const wide = desc[2] === 16 && el.len >= paletteN * 2;
      const dv = new DataView(u8.buffer, u8.byteOffset + el.off, el.len);
      for (let i = 0; i < paletteN; i++) out[i] = wide ? (i * 2 + 2 <= el.len ? Math.round((dv.getUint16(i * 2, !el.be) * 255) / 65535) : 0) : i < el.len ? u8[el.off + i] : 0;
      return out;
    });
  } else return null;
  return palette ? { rgb: palette, first: paletteFirst, n: paletteN } : null;
}

function samplesFrom(src: ArrayLike<number>, w: number, h: number, comps: number, pi: PixelInfo, signed: boolean): Float32Array {
  const n = pi.rows * pi.cols, spp = Math.min(comps, 4), out = new Float32Array(n * spp);
  const signBit = 2 ** (pi.bitsStored - 1), wrap = 2 ** pi.bitsStored;
  for (let y = 0; y < pi.rows; y++) for (let x = 0; x < pi.cols; x++) {
    const i = y * pi.cols + x, j = (Math.min(y, h - 1) * w + Math.min(x, w - 1)) * comps;
    for (let c = 0; c < spp; c++) { let v = src[j + c]; if (signed && v >= signBit) v -= wrap; out[i * spp + c] = v; }
  }
  return out;
}
/** YBR_FULL_422 as stored (Y0 Y1 Cb Cr for each pair of pixels along a row) to Y Cb Cr per pixel. */
function deinterleave422(src: Float32Array, rows: number, cols: number): Float32Array {
  const n = rows * cols, v = new Float32Array(n * 3);
  for (let i = 0, p = 0; i + 1 < n; i += 2, p += 4) {
    const y0 = src[p], y1 = src[p + 1], cb = src[p + 2], cr = src[p + 3];
    v[i * 3] = y0; v[i * 3 + 1] = cb; v[i * 3 + 2] = cr; v[i * 3 + 3] = y1; v[i * 3 + 4] = cb; v[i * 3 + 5] = cr;
  }
  return v;
}
const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

/** Shutters, annotations, the displayed area and the spatial transformation of a presentation state applied to a frame's raster. */
function applyPresentation(r: ReturnType<typeof makeRaster>, ps: PresentationState, drawText: TextRasterizer | undefined, notes: string[], warnings: string[], info: Record<string, string>, superimposed?: ReturnType<typeof makeRaster>): { raster: ReturnType<typeof makeRaster>; dpiSwap: boolean } {
  const w = r.width, h = r.height, d = r.data;
  const what: string[] = [];
  if (ps.window) what.push(`window center ${ps.window.wc}, width ${ps.window.ww}`);
  else if (ps.voiLut) what.push('its VOI lookup table');
  if (ps.rescale) what.push(`rescale × ${ps.rescale.slope} + ${ps.rescale.intercept}`);
  if (ps.modalityLut) what.push('its modality lookup table');
  if (ps.presentationLut) what.push('its presentation lookup table');
  if (ps.inverse) what.push('inverse presentation');
  if (ps.palette) { // pseudo-color: the presentation values index the state's palette (8-bit values scaled over its entries)
    const { rgb, first, n: pn } = ps.palette, scale = (pn - 1) / 255;
    for (let i = 0; i < w * h; i++) { const o = i * 4, k = Math.min(pn - 1, Math.max(0, Math.round(d[o] * scale) - first)); d[o] = rgb[0][k]; d[o + 1] = rgb[1][k]; d[o + 2] = rgb[2][k]; }
    what.push(`pseudo-color palette (${pn} entries)`);
  }
  if (ps.blend) { // blending: the superimposed picture (windowed gray), through its palette, over the underlying one at the state's opacity
    const b = ps.blend, s = superimposed;
    if (s && s.width > 0 && s.height > 0) {
      const a = b.opacity, pal = b.palette, scale = pal ? (pal.n - 1) / 255 : 0, sd = s.data;
      for (let y = 0; y < h; y++) {
        const sy = Math.min(s.height - 1, Math.floor((y * s.height) / h));
        for (let x = 0; x < w; x++) {
          const sx = Math.min(s.width - 1, Math.floor((x * s.width) / w)), so = (sy * s.width + sx) * 4, g = sd[so], o = (y * w + x) * 4;
          let cr = g, cg = g, cb = g;
          if (pal) { const k = Math.min(pal.n - 1, Math.max(0, Math.round(g * scale) - pal.first)); cr = pal.rgb[0][k]; cg = pal.rgb[1][k]; cb = pal.rgb[2][k]; }
          d[o] = Math.round(d[o] * (1 - a) + cr * a); d[o + 1] = Math.round(d[o + 1] * (1 - a) + cg * a); d[o + 2] = Math.round(d[o + 2] * (1 - a) + cb * a);
        }
      }
      what.push(`the superimposed picture${pal ? ` through its palette (${pal.n} entries)` : ''} at opacity ${fmt(a)}${s.width !== w || s.height !== h ? `, scaled from ${s.width} × ${s.height}` : ''}`);
    } else warnings.push(`The blending state's superimposed picture${b.references.length ? ` (SOP instance ${b.references[0]})` : ''} is not in this folder; the underlying picture is shown alone`);
  }
  // Shutters: everything outside the shape takes the shutter's gray (pixel columns and rows are 1-based in the file).
  for (const sh of ps.shutters) {
    const g = sh.gray;
    const poly = sh.shape === 'POLYGONAL' && sh.vertices && sh.vertices.length >= 3 ? sh.vertices.slice(0, 4096).map(([row, col]) => [col, row] as [number, number]) : null; // made once, not for every pixel
    const keep = (x: number, y: number): boolean => {
      const c = x + 1, rr = y + 1;
      if (sh.shape === 'RECTANGULAR') return c >= (sh.left ?? 1) && c <= (sh.right ?? w) && rr >= (sh.upper ?? 1) && rr <= (sh.lower ?? h);
      if (sh.shape === 'CIRCULAR') return sh.center ? Math.hypot(c - sh.center[1], rr - sh.center[0]) <= (sh.radius ?? 0) : true;
      if (poly) return insidePolygon(poly, c, rr);
      return true;
    };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!keep(x, y)) { const o = (y * w + x) * 4; d[o] = d[o + 1] = d[o + 2] = g; }
    what.push(`${sh.shape.toLowerCase()} shutter`);
  }
  // Annotations, in image pixel units (the top-left corner of the picture is 0, 0) or fractions of the displayed area.
  const area = ps.area ? { x: ps.area.tl[0] - 1, y: ps.area.tl[1] - 1, w: ps.area.br[0] - ps.area.tl[0] + 1, h: ps.area.br[1] - ps.area.tl[1] + 1 } : { x: 0, y: 0, w, h };
  const toPx = (p: [number, number], units: string): [number, number] => (units === 'DISPLAY' ? [area.x + p[0] * area.w, area.y + p[1] * area.h] : p);
  let nGraphics = 0, nTexts = 0, textSkipped = false;
  const texts: string[] = [];
  for (const layer of ps.layers) {
    const g = layer.gray;
    for (const obj of layer.graphics) {
      const pts = obj.points.map((p) => toPx(p, obj.units));
      if (!pts.length) continue;
      nGraphics++;
      if (obj.type === 'POINT') { const [x, y] = pts[0]; drawLine(r, x - 3, y, x + 3, y, g); drawLine(r, x, y - 3, x, y + 3, g); }
      else if (obj.type === 'CIRCLE' && pts.length >= 2) drawPolyline(r, ellipsePoints(pts[0], Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]), 0, 0), true, obj.filled, g);
      else if (obj.type === 'ELLIPSE' && pts.length >= 4) { const c: [number, number] = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2]; drawPolyline(r, ellipsePoints(c, Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) / 2, Math.hypot(pts[3][0] - pts[2][0], pts[3][1] - pts[2][1]) / 2, Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0])), true, obj.filled, g); }
      else drawPolyline(r, pts, obj.filled, obj.filled, g); // POLYLINE, INTERPOLATED (drawn straight)
    }
    for (const t of layer.texts) {
      nTexts++; texts.push(t.text);
      const box = t.box ? [...toPx([t.box[0], t.box[1]], t.units), ...toPx([t.box[2], t.box[3]], t.units)] : null;
      const anchor = t.anchor ? toPx(t.anchor, t.anchorUnits) : null;
      if (anchor && t.anchorVisible) { drawLine(r, anchor[0] - 3, anchor[1] - 3, anchor[0] + 3, anchor[1] + 3, g); drawLine(r, anchor[0] - 3, anchor[1] + 3, anchor[0] + 3, anchor[1] - 3, g); }
      if (box) {
        drawPolyline(r, [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]], true, false, g);
        if (anchor && t.anchorVisible) { const cx = Math.max(box[0], Math.min(box[2], anchor[0])), cy = Math.max(box[1], Math.min(box[3], anchor[1])); drawLine(r, anchor[0], anchor[1], cx, cy, g); }
      }
      const mask = drawText ? drawText(t.text) : null;
      if (!mask) { textSkipped = true; continue; }
      const ox = box ? Math.round(box[0] + 2) : anchor ? Math.round(anchor[0] + 6) : 2, oy = box ? Math.round(box[1] + 1) : anchor ? Math.round(anchor[1] - mask.height / 2) : 2;
      for (let yy = 0; yy < mask.height; yy++) for (let xx = 0; xx < mask.width; xx++) {
        const a = mask.alpha[yy * mask.width + xx] / 255; if (!a) continue;
        const x = ox + xx, y = oy + yy; if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const o = (y * w + x) * 4; d[o] = Math.round(d[o] * (1 - a) + g * a); d[o + 1] = Math.round(d[o + 1] * (1 - a) + g * a); d[o + 2] = Math.round(d[o + 2] * (1 - a) + g * a);
      }
    }
  }
  if (nGraphics || nTexts) what.push(`${nGraphics} graphic object${nGraphics === 1 ? '' : 's'}${nTexts ? ` and ${nTexts} text${nTexts === 1 ? '' : 's'}` : ''}`);
  if (textSkipped) warnings.push('The presentation state\'s text could not be drawn here (no text renderer); its words are in the details');
  if (texts.length) info.annotations = texts.join(' | ');
  // The displayed area (a crop), then the horizontal flip, then the clockwise rotation.
  let out = r;
  if (ps.area) {
    const x0 = Math.max(0, area.x), y0 = Math.max(0, area.y), x1 = Math.min(w, area.x + area.w), y1 = Math.min(h, area.y + area.h);
    if (x1 > x0 && y1 > y0 && (x0 || y0 || x1 < w || y1 < h)) {
      const c = makeRaster(x1 - x0, y1 - y0);
      for (let y = y0; y < y1; y++) c.data.set(d.subarray((y * w + x0) * 4, (y * w + x1) * 4), (y - y0) * c.width * 4);
      out = c; what.push(`displayed area ${c.width} × ${c.height}`);
    }
  }
  if (ps.flip) { const c = makeRaster(out.width, out.height); for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) { const s0 = (y * out.width + x) * 4, t0 = (y * out.width + (out.width - 1 - x)) * 4; c.data[t0] = out.data[s0]; c.data[t0 + 1] = out.data[s0 + 1]; c.data[t0 + 2] = out.data[s0 + 2]; c.data[t0 + 3] = out.data[s0 + 3]; } out = c; what.push('horizontal flip'); }
  const rot = ((Math.round(ps.rotation / 90) * 90) % 360 + 360) % 360;
  let dpiSwap = false;
  if (rot) {
    const sw = out.width, sh = out.height, c = rot === 180 ? makeRaster(sw, sh) : makeRaster(sh, sw);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      const [tx, ty] = rot === 90 ? [sh - 1 - y, x] : rot === 180 ? [sw - 1 - x, sh - 1 - y] : [y, sw - 1 - x];
      const s0 = (y * sw + x) * 4, t0 = (ty * c.width + tx) * 4;
      c.data[t0] = out.data[s0]; c.data[t0 + 1] = out.data[s0 + 1]; c.data[t0 + 2] = out.data[s0 + 2]; c.data[t0 + 3] = out.data[s0 + 3];
    }
    out = c; dpiSwap = rot !== 180; what.push(`rotation ${rot}°`);
  }
  notes.push(`presentation state ${ps.label || ps.name}${ps.description ? ` (${ps.description})` : ''} applied: ${what.join(', ') || 'nothing to change'}`);
  info['presentation state'] = `${ps.name}${ps.label ? ` (${ps.label})` : ''}`;
  return { raster: out, dpiSwap };
}
type R = ReturnType<typeof makeRaster>;
function put(r: R, x: number, y: number, g: number): void { const xi = Math.floor(x), yi = Math.floor(y); if (xi < 0 || yi < 0 || xi >= r.width || yi >= r.height) return; const o = (yi * r.width + xi) * 4; r.data[o] = r.data[o + 1] = r.data[o + 2] = g; r.data[o + 3] = 255; }
function drawLine(r: R, x0: number, y0: number, x1: number, y1: number, g: number): void {
  if (![x0, y0, x1, y1].every(Number.isFinite)) return;
  // Clipped to the picture first (Liang–Barsky): a point far outside must not be stepped to pixel by pixel.
  let t0 = 0, t1 = 1; const dx = x1 - x0, dy = y1 - y0;
  for (const [p, q] of [[-dx, x0 + 1], [dx, r.width - x0], [-dy, y0 + 1], [dy, r.height - y0]]) {
    if (p === 0) { if (q < 0) return; continue; }
    const t = q / p; if (p < 0) { if (t > t1) return; if (t > t0) t0 = t; } else { if (t < t0) return; if (t < t1) t1 = t; }
  }
  [x0, y0, x1, y1] = [x0 + dx * t0, y0 + dy * t0, x0 + dx * t1, y0 + dy * t1];
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
  for (let i = 0; i <= n; i++) put(r, x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, g);
}
function insidePolygon(pts: [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i], [xj, yj] = pts[j]; if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside; }
  return inside;
}
function drawPolyline(r: R, pts: [number, number][], closed: boolean, filled: boolean, g: number): void {
  if (filled && pts.length >= 3) {
    const ys = pts.map((p) => p[1]), y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(r.height - 1, Math.ceil(Math.max(...ys)));
    for (let y = y0; y <= y1; y++) for (let x = 0; x < r.width; x++) if (insidePolygon(pts, x + 0.5, y + 0.5)) put(r, x, y, g);
  }
  for (let i = 1; i < pts.length; i++) drawLine(r, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], g);
  if (closed && pts.length > 2) drawLine(r, pts[pts.length - 1][0], pts[pts.length - 1][1], pts[0][0], pts[0][1], g);
}
function ellipsePoints(c: [number, number], a: number, b: number, angle: number): [number, number][] {
  if (!b) b = a;
  if (![c[0], c[1], a, b, angle].every(Number.isFinite)) return [];
  const n = Math.min(20000, Math.max(16, Math.ceil(2 * Math.PI * Math.max(a, b)))), out: [number, number][] = [], ca = Math.cos(angle), sa = Math.sin(angle); // more steps than any picture's outline needs are never taken
  for (let i = 0; i < n; i++) { const t = (2 * Math.PI * i) / n, ex = a * Math.cos(t), ey = b * Math.sin(t); out.push([c[0] + ex * ca - ey * sa, c[1] + ex * sa + ey * ca]); }
  return out;
}

// ---- The tag dump (DICOM Tags…) -----------------------------------------------------------------------------------
export interface DicomRow { tag: string; vr: string; name: string; value: string; depth: number; bytes: number }
const TEXT_VR = new Set(['AE', 'AS', 'CS', 'DA', 'DS', 'DT', 'IS', 'LO', 'LT', 'PN', 'SH', 'ST', 'TM', 'UC', 'UI', 'UR', 'UT', '']);
/** Every element of the file (the meta group and the data set, sequences nested), named from the dictionary, values as text. */
export function dumpDicom(u8: Uint8Array): { rows: DicomRow[]; transferSyntax: string } {
  keepAll = true;
  let d: Parsed;
  try { d = parseFile(u8); } finally { keepAll = false; }
  const rows: DicomRow[] = [];
  if (isDicom(u8)) { // the meta group again, for the listing
    const meta: Elements = new Map(); let q = 132; const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    while (q + 8 <= u8.length && dv.getUint16(q, true) === 0x0002) { const vr = String.fromCharCode(u8[q + 4], u8[q + 5]); const long = LONG_VR.has(vr), len = long ? dv.getUint32(q + 8, true) : dv.getUint16(q + 6, true), off = q + (long ? 12 : 8); meta.set(T(2, dv.getUint16(q + 2, true)), { vr, off, len, be: false }); q = off + len; }
    walk({ ...d, u8, el: meta }, meta, 0, rows);
  }
  walk(d, d.el, 0, rows);
  return { rows, transferSyntax: d.ts };
}
function walk(d: Parsed, el: Elements, depth: number, rows: DicomRow[]): void {
  for (const [tag, e] of [...el.entries()].sort((a, b) => a[0] - b[0])) {
    const g = tag >>> 16, n = tag & 0xffff, hex = `(${g.toString(16).padStart(4, '0')},${n.toString(16).padStart(4, '0')})`;
    const dict = dicomTagName(g, n), vr = e.vr || dict?.[1] || '';
    let value: string;
    if (e.items) value = `${e.items.length} item${e.items.length === 1 ? '' : 's'}`;
    else if (e.frags) value = `${e.frags.length} fragment${e.frags.length === 1 ? '' : 's'}, ${e.frags.reduce((a, f) => a + f.len, 0)} bytes`;
    else if (tag === PIXEL || tag === FLOAT_PIXEL || tag === DOUBLE_PIXEL || vr === 'OB' || vr === 'OW' || vr === 'OF' || vr === 'OD' || vr === 'OL' || vr === 'OV' || vr === 'UN' || (vr === '' && e.len > 64)) value = `${e.len} bytes${e.len ? ` (${Array.from(d.u8.subarray(e.off, e.off + Math.min(8, e.len))).map((b) => b.toString(16).padStart(2, '0')).join(' ')}${e.len > 8 ? ' …' : ''})` : ''}`;
    else if (['FL', 'FD', 'SL', 'UL', 'SS', 'US', 'SV', 'UV', 'AT'].includes(vr)) { const dv = new DataView(d.u8.buffer, d.u8.byteOffset + e.off, e.len), out: string[] = []; const w = vr === 'FD' || vr === 'SV' || vr === 'UV' ? 8 : vr === 'SS' || vr === 'US' ? 2 : 4; for (let i = 0; i + w <= e.len && out.length < 64; i += w) out.push(vr === 'FL' ? String(+dv.getFloat32(i, !e.be).toPrecision(7)) : vr === 'FD' ? String(dv.getFloat64(i, !e.be)) : vr === 'SL' ? String(dv.getInt32(i, !e.be)) : vr === 'UL' ? String(dv.getUint32(i, !e.be)) : vr === 'SS' ? String(dv.getInt16(i, !e.be)) : vr === 'US' ? String(dv.getUint16(i, !e.be)) : vr === 'AT' ? `(${dv.getUint16(i, !e.be).toString(16).padStart(4, '0')},${dv.getUint16(i + 2, !e.be).toString(16).padStart(4, '0')})` : String(dv.getBigInt64(i, !e.be))); value = out.join('\\') + (e.len > 64 * w ? ' …' : ''); }
    else if (TEXT_VR.has(vr)) { value = decodeText(d, e); if (vr === 'UI') { const name = TS[value] || SOP[value]; if (name) value = `${value} (${name})`; } if (value.length > 200) value = value.slice(0, 200) + ' …'; }
    else value = `${e.len} bytes`;
    rows.push({ tag: hex, vr, name: dict?.[0] || (g & 1 ? 'private' : ''), value, depth, bytes: e.len });
    if (e.items) e.items.forEach((item, i) => { rows.push({ tag: '', vr: '', name: `item ${i + 1}`, value: '', depth: depth + 1, bytes: 0 }); walk(d, item, depth + 2, rows); });
  }
}
