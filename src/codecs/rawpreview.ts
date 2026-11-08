/**
 * Camera RAW files: identification by their TIFF-like structure or maker signature, and the embedded
 * JPEG previews (the largest is shown, which is what culling needs). Development of the sensor data is
 * the optional RAW module (FORMATS-PLAN.md); this reader never pretends to decode it.
 */

export interface RawId { family: string; make: string }

const SIG: [string, number, string, string][] = [
  // [signature, offset, family, make]
  ['FUJIFILMCCD-RAW', 0, 'RAF', 'Fujifilm'],
  ['IIRO', 0, 'ORF', 'Olympus / OM System'], ['IIRS', 0, 'ORF', 'Olympus / OM System'], ['MMOR', 0, 'ORF', 'Olympus / OM System'],
  ['IIU\0', 0, 'RW2', 'Panasonic / Leica'],
  ['FOVb', 0, 'X3F', 'Sigma'],
  ['II\x1a\0\0\0HEAPCCDR', 0, 'CRW', 'Canon'],
  ['ftypcrx ', 4, 'CR3', 'Canon'],
  ['\0MRM', 0, 'MRW', 'Minolta'],
];

const EXT_FAMILY: Record<string, [string, string]> = {
  cr2: ['CR2', 'Canon'], cr3: ['CR3', 'Canon'], crw: ['CRW', 'Canon'], nef: ['NEF', 'Nikon'], nrw: ['NRW', 'Nikon'], arw: ['ARW', 'Sony'], srf: ['SRF', 'Sony'], sr2: ['SR2', 'Sony'], raf: ['RAF', 'Fujifilm'],
  orf: ['ORF', 'Olympus / OM System'], rw2: ['RW2', 'Panasonic'], rwl: ['RWL', 'Leica'], pef: ['PEF', 'Pentax'], dng: ['DNG', 'Adobe DNG'], '3fr': ['3FR', 'Hasselblad'], fff: ['FFF', 'Hasselblad'], iiq: ['IIQ', 'Phase One'],
  x3f: ['X3F', 'Sigma'], srw: ['SRW', 'Samsung'], mrw: ['MRW', 'Minolta'], erf: ['ERF', 'Epson'], mef: ['MEF', 'Mamiya'], mos: ['MOS', 'Leaf'], kdc: ['KDC', 'Kodak'], dcr: ['DCR', 'Kodak'], raw: ['RAW', 'Panasonic / Leica'],
};
export const RAW_EXTENSIONS = Object.keys(EXT_FAMILY);

const at = (u8: Uint8Array, o: number, s: string) => { if (o + s.length > u8.length) return false; for (let i = 0; i < s.length; i++) if (u8[o + i] !== s.charCodeAt(i)) return false; return true; };

/** Identifies a RAW file by content (TIFF-based files need a maker tag or a known extension), else null. */
export function identifyRaw(u8: Uint8Array, name = ''): RawId | null {
  for (const [sig, off, family, make] of SIG) if (at(u8, off, sig)) return { family, make };
  const ext = (name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
  const tiff = u8.length > 16 && ((u8[0] === 0x49 && u8[1] === 0x49 && u8[2] === 42) || (u8[0] === 0x4d && u8[1] === 0x4d && u8[3] === 42));
  if (tiff) {
    if (at(u8, 8, 'CR\x02')) return { family: 'CR2', make: 'Canon' };
    const tags = ifd0Tags(u8);
    if (tags.has(0xc612)) return { family: 'DNG', make: tags.get(0x10f) || 'Adobe DNG' };
    const make = tags.get(0x10f) || '';
    if (EXT_FAMILY[ext]) return { family: EXT_FAMILY[ext][0], make: make || EXT_FAMILY[ext][1] };
    // A TIFF with sensor data (CFA photometric 32803 or 34892) is RAW whatever its name.
    const photo = tags.get('photometric');
    if (photo === '32803' || photo === '34892') return { family: ext.toUpperCase() || 'RAW', make: make || 'unknown camera' };
    return null;
  }
  if (EXT_FAMILY[ext] && !tiff) return { family: EXT_FAMILY[ext][0], make: EXT_FAMILY[ext][1] };
  return null;
}

function ifd0Tags(u8: Uint8Array): Map<number | string, string> {
  const out = new Map<number | string, string>();
  try {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const le = u8[0] === 0x49;
    const ifd = dv.getUint32(4, le);
    const n = dv.getUint16(ifd, le);
    for (let i = 0; i < Math.min(n, 200); i++) {
      const e = ifd + 2 + i * 12;
      const tag = dv.getUint16(e, le), type = dv.getUint16(e + 2, le), count = dv.getUint32(e + 4, le);
      if (type === 2 && (tag === 0x10f || tag === 0x110)) { const off = count <= 4 ? e + 8 : dv.getUint32(e + 8, le); out.set(tag, String.fromCharCode(...u8.subarray(off, Math.min(u8.length, off + count))).replace(/\0.*$/s, '').trim()); }
      else if (type === 3 && count === 1) { const v = dv.getUint16(e + 8, le); out.set(tag, String(v)); if (tag === 0x103) out.set('compression', String(v)); if (tag === 0x106) out.set('photometric', String(v)); }
      else out.set(tag, '');
    }
  } catch { /* not a TIFF */ }
  return out;
}

export interface EmbeddedJpeg { offset: number; length: number; width: number; height: number }

/** Every complete JPEG inside `u8` (SOI … EOI with a SOF marker), largest first. Scans the whole file. */
export function findEmbeddedJpegs(u8: Uint8Array, limit = 8): EmbeddedJpeg[] {
  const out: EmbeddedJpeg[] = [];
  let i = 0;
  while (i + 4 < u8.length && out.length < limit) {
    if (u8[i] === 0xff && u8[i + 1] === 0xd8 && u8[i + 2] === 0xff) {
      const j = scanJpeg(u8, i);
      if (j) { out.push(j); i = j.offset + j.length; continue; }
    }
    i++;
  }
  out.sort((a, b) => b.width * b.height - a.width * a.height || b.length - a.length);
  return out;
}

/** Walks the segments from SOI at `start`; returns the range and the SOF size, or null when it is not a whole JPEG. */
function scanJpeg(u8: Uint8Array, start: number): EmbeddedJpeg | null {
  let p = start + 2, width = 0, height = 0;
  // The end-of-image marker is two bytes, so a JPEG that ends exactly at the end of the data counts too.
  while (p + 2 <= u8.length) {
    if (u8[p] !== 0xff) return null;
    const marker = u8[p + 1];
    if (marker === 0xff) { p++; continue; }
    if (marker === 0xd8) return null;
    if (marker === 0xd9) return width ? { offset: start, length: p + 2 - start, width, height } : null;
    if (p + 4 > u8.length) return null;
    const len = (u8[p + 2] << 8) | u8[p + 3];
    if (len < 2) return null;
    // Lossless frames (SOF3, SOF7, SOF11, SOF15) hold sensor data (DNG tiles, CR2 slices), not previews.
    if (marker === 0xc3 || marker === 0xc7 || marker === 0xcb || marker === 0xcf) return null;
    if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc && p + 9 <= u8.length) { height = (u8[p + 5] << 8) | u8[p + 6]; width = (u8[p + 7] << 8) | u8[p + 8]; }
    if (marker === 0xda) {
      // Entropy-coded data: skip to the next marker that is not RSTn or stuffed.
      p += 2 + len;
      while (p + 1 < u8.length) { if (u8[p] === 0xff && u8[p + 1] !== 0 && !(u8[p + 1] >= 0xd0 && u8[p + 1] <= 0xd7)) break; p++; }
      continue;
    }
    p += 2 + len;
  }
  return null;
}

/**
 * TIFF-based RAW files of older cameras (Kodak DCR/KDC, Epson ERF, Hasselblad 3FR/FFF, Phase One IIQ…) carry no JPEG
 * preview, only an uncompressed RGB thumbnail in a TIFF directory: the largest such directory, decoded by the TIFF
 * reader, or null when there is none the reader can show.
 */
export async function tiffThumbnail(u8: Uint8Array): Promise<{ page: import('./raster').DecodedPage; count: number } | null> {
  const { isTiff, decodeTiff } = await import('./tiff');
  if (!isTiff(u8)) return null;
  let r: Awaited<ReturnType<typeof decodeTiff>>;
  try { r = await decodeTiff(u8); } catch { return null; }
  const rgb = r.pages.filter((p) => p.width > 0 && p.height > 0 && !p.notes.some((n) => /CFA|color filter|unknown photometric/i.test(n)));
  if (!rgb.length) return null;
  const best = rgb.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
  return { page: best, count: rgb.length };
}
