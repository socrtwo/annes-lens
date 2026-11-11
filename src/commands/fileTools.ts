/**
 * File tools (M2): Open as Hex, Open as Text, Open RAW Pixel Data, Recovery Report, Save for Web, Save to
 * Target File Size and Print at True Size with a calibration ruler.
 */
import { def } from './registry';
import type { App } from '../app';
import { openDialog, toast } from '../ui/dialog';
import { h, esc, pickFile } from '../ui/dom';
import { Folder, entryFromBytes } from '../picture/folder';
import { encodeCanvas, sniff, formatFromName, type EncodeFormat } from '../codecs/registry';
import { saveAs, openDocuments } from '../platform/native';
import { fmtSize } from '../ui/shell';
import { printPicture } from './file';
import { makeRaster } from '../codecs/raster';
import { latin1 } from '../codecs/limits';

/** The bytes to inspect: the open picture's file, or a file the user picks (any type). */
async function bytesToInspect(app: App): Promise<{ name: string; bytes: Uint8Array } | null> {
  const pic = app.picture;
  if (pic) return { name: pic.name, bytes: pic.bytes };
  const files = await openDocuments('*/*', ['*/*'], false);
  if (!files.length) return null;
  return { name: files[0].name, bytes: new Uint8Array(files[0].data) };
}

// Hex view ------------------------------------------------------------------------------------

interface Landmark { offset: number; label: string }

/** Markers, chunks and IFDs with their offsets, for "jump to". */
export function landmarks(u8: Uint8Array): Landmark[] {
  const out: Landmark[] = [{ offset: 0, label: 'Start of file' }];
  const str = (o: number, n: number) => latin1(u8, o, o + n);
  if (u8[0] === 0xff && u8[1] === 0xd8) {
    const names: Record<number, string> = { 0xc0: 'SOF0 baseline', 0xc1: 'SOF1', 0xc2: 'SOF2 progressive', 0xc4: 'DHT', 0xdb: 'DQT', 0xdd: 'DRI', 0xda: 'SOS scan data', 0xe0: 'APP0 JFIF', 0xe1: 'APP1', 0xe2: 'APP2', 0xed: 'APP13 IPTC', 0xee: 'APP14 Adobe', 0xfe: 'COM comment', 0xd9: 'EOI' };
    let p = 2;
    while (p + 2 <= u8.length && out.length < 400) {
      if (u8[p] !== 0xff) break;
      const m = u8[p + 1];
      if (m === 0xff) { p++; continue; }
      if (m === 0xd9) { out.push({ offset: p, label: 'EOI end of image' }); break; }
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { p += 2; continue; }
      if (p + 4 > u8.length) break;
      const len = (u8[p + 2] << 8) | u8[p + 3];
      let label = names[m] || (m >= 0xe0 && m <= 0xef ? `APP${m - 0xe0}` : `marker FF${m.toString(16).toUpperCase()}`);
      if (m === 0xe1) label += str(p + 4, 4) === 'Exif' ? ' EXIF' : str(p + 4, 5) === 'http:' ? ' XMP' : '';
      out.push({ offset: p, label: `${label} (${len} bytes)` });
      if (m === 0xda) { p += 2 + len; while (p + 1 < u8.length && !(u8[p] === 0xff && u8[p + 1] !== 0 && !(u8[p + 1] >= 0xd0 && u8[p + 1] <= 0xd7))) p++; continue; }
      p += 2 + len;
    }
  } else if (u8[0] === 0x89 && u8[1] === 0x50) {
    let p = 8;
    while (p + 8 <= u8.length && out.length < 400) {
      const len = ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0;
      out.push({ offset: p, label: `${str(p + 4, 4)} chunk (${len} bytes)` });
      p += 12 + len;
    }
  } else if (str(0, 4) === 'RIFF') {
    out.push({ offset: 8, label: `${str(8, 4)} form` });
    let p = 12;
    while (p + 8 <= u8.length && out.length < 400) {
      const len = (u8[p + 4] | (u8[p + 5] << 8) | (u8[p + 6] << 16) | (u8[p + 7] << 24)) >>> 0;
      out.push({ offset: p, label: `${str(p, 4)} chunk (${len} bytes)` });
      p += 8 + len + (len & 1);
    }
  } else if ((u8[0] === 0x49 && u8[1] === 0x49 && u8[2] === 42) || (u8[0] === 0x4d && u8[1] === 0x4d && u8[3] === 42)) {
    const le = u8[0] === 0x49;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let ifd = dv.getUint32(4, le), n = 0;
    const seen = new Set<number>();
    while (ifd && ifd + 2 <= u8.length && !seen.has(ifd) && n < 100) {
      seen.add(ifd);
      const count = dv.getUint16(ifd, le);
      out.push({ offset: ifd, label: `IFD${n} (${count} entries)` });
      const next = ifd + 2 + count * 12;
      if (next + 4 > u8.length) break;
      ifd = dv.getUint32(next, le); n++;
    }
  } else if (str(4, 4) === 'ftyp') {
    let p = 0;
    while (p + 8 <= u8.length && out.length < 400) {
      let len = ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0;
      if (len === 1 && p + 16 <= u8.length) len = Number(new DataView(u8.buffer, u8.byteOffset + p + 8, 8).getBigUint64(0));
      if (!len) len = u8.length - p;
      out.push({ offset: p, label: `${str(p + 4, 4)} box (${len} bytes)` });
      if (len < 8) break;
      p += len;
    }
  } else if (str(0, 3) === 'GIF') {
    out.push({ offset: 6, label: 'Logical screen descriptor' });
    let p = 13 + ((u8[10] & 0x80) ? 3 << ((u8[10] & 7) + 1) : 0);
    let frame = 0;
    while (p < u8.length && out.length < 400) {
      const b = u8[p];
      if (b === 0x3b) { out.push({ offset: p, label: 'Trailer' }); break; }
      if (b === 0x2c) { out.push({ offset: p, label: `Image ${++frame}` }); p += 10 + ((u8[p + 9] & 0x80) ? 3 << ((u8[p + 9] & 7) + 1) : 0) + 1; }
      else if (b === 0x21) { out.push({ offset: p, label: `Extension ${u8[p + 1].toString(16).toUpperCase()}` }); p += 2; }
      else break;
      while (p < u8.length && u8[p]) p += u8[p] + 1;
      p++;
    }
  }
  if (u8.length > 0) out.push({ offset: Math.max(0, u8.length - 256), label: 'End of file' });
  return out;
}

export function hexDump(u8: Uint8Array, offset: number, lines = 32, width = 16): string {
  const rows: string[] = [];
  const digits = Math.max(6, u8.length.toString(16).length);
  for (let i = 0; i < lines; i++) {
    const o = offset + i * width;
    if (o >= u8.length) break;
    const row = u8.subarray(o, Math.min(u8.length, o + width));
    const hex = [...row].map((b, k) => b.toString(16).padStart(2, '0') + (k === 7 ? '  ' : ' ')).join('').padEnd(width * 3 + 1);
    const asc = [...row].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '·')).join('');
    rows.push(`${o.toString(16).padStart(digits, '0')}  ${hex} ${asc}`);
  }
  return rows.join('\n');
}

def([
  {
    id: 'file.openHex', icon: 'data_object', noRecord: true,
    tip: 'Read-only hex and ASCII view of the file; jump to any marker, chunk or IFD',
    run: async (app) => {
      const src = await bytesToInspect(app);
      if (!src) return;
      const u8 = src.bytes;
      const marks = landmarks(u8);
      const lines = 32;
      const page = lines * 16;
      const render = (v: Record<string, any>, ctl: any) => {
        const off = Math.max(0, Math.min(Math.max(0, u8.length - 1), Math.floor(+v.offset || 0) & ~15));
        ctl.setPreview(`<pre class="ql-hex">${esc(hexDump(u8, off, lines))}</pre><div class="ql-help">${esc(src.name)} · ${u8.length.toLocaleString()} bytes · showing ${off.toLocaleString()}–${Math.min(u8.length, off + page).toLocaleString()}</div>`);
      };
      await openDialog({ title: 'Open as Hex', wide: true, cancel: false, ok: 'Close', preview: true, previewStyle: 'overflow:auto',
        fields: [
          { key: 'jump', label: 'Jump to', type: 'select', options: marks.map((m) => ({ value: String(m.offset), label: `${m.label} @ 0x${m.offset.toString(16)}` })), value: '0', half: true },
          { key: 'offset', label: 'Offset (bytes)', type: 'number', min: 0, max: Math.max(0, u8.length - 1), value: 0, half: true },
          { key: 'find', label: 'Find ASCII text', type: 'text', placeholder: 'Exif, IHDR, …', half: true },
        ],
        buttons: [
          { label: '◀ Page', onClick: (v, ctl) => { ctl.set('offset', Math.max(0, (+v.offset || 0) - page)); render(ctl.values(), ctl); } },
          { label: 'Page ▶', onClick: (v, ctl) => { ctl.set('offset', Math.min(Math.max(0, u8.length - 16), (+v.offset || 0) + page)); render(ctl.values(), ctl); } },
          { label: 'Copy page', onClick: (v) => { navigator.clipboard?.writeText(hexDump(u8, Math.floor(+v.offset || 0) & ~15, lines)); toast('Copied'); } },
        ],
        onChange: (v, ctl, key) => {
          if (key === 'jump') ctl.set('offset', +v.jump);
          if (key === 'find' && v.find) {
            const needle = [...String(v.find)].map((c) => c.charCodeAt(0) & 255);
            const from = (+v.offset || 0) + 1;
            let at = -1;
            outer: for (let i = from; i <= u8.length - needle.length; i++) { for (let k = 0; k < needle.length; k++) if (u8[i + k] !== needle[k]) continue outer; at = i; break; }
            if (at >= 0) ctl.set('offset', at); else toast('Not found after this offset');
          }
          render(ctl.values(), ctl);
        },
        onOpen: (ctl) => render(ctl.values(), ctl),
      });
    },
  },
  {
    id: 'file.openText', icon: 'description', noRecord: true,
    tip: 'Shows the file as text (UTF-8, or Latin-1 when it is not valid UTF-8)',
    run: async (app) => {
      const src = await bytesToInspect(app);
      if (!src) return;
      const limit = 2 << 20;
      const slice = src.bytes.subarray(0, limit);
      let text: string, enc = 'UTF-8';
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(slice); } catch { text = new TextDecoder('latin1').decode(slice); enc = 'Latin-1'; }
      const binary = /[\0-\x08\x0e-\x1f]/.test(text.slice(0, 4096));
      await openDialog({ title: `Open as Text: ${src.name}`, wide: true, cancel: false, ok: 'Close',
        fields: [
          { key: 'i', type: 'info', label: `${enc}${binary ? ' (the file looks binary; Open as Hex shows it byte by byte)' : ''}${src.bytes.length > limit ? `; first ${fmtSize(limit)} of ${fmtSize(src.bytes.length)}` : ''}` },
          { key: 'text', type: 'textarea', rows: 24, value: text },
        ],
        buttons: [{ label: 'Copy', onClick: () => { navigator.clipboard?.writeText(text); toast('Copied'); } }] });
    },
  },
]);

// RAW pixel data ---------------------------------------------------------------------------------

type PixelLayout = 'gray8' | 'gray16' | 'rgb' | 'bgr' | 'rgba' | 'bgra' | 'argb' | 'abgr' | 'rgb565' | 'rgb555' | 'mono' | 'gray32f' | 'rgb32f';
const LAYOUTS: { value: PixelLayout; label: string; bits: number }[] = [
  { value: 'gray8', label: '8-bit grayscale', bits: 8 }, { value: 'gray16', label: '16-bit grayscale', bits: 16 }, { value: 'mono', label: '1-bit (1 = white)', bits: 1 },
  { value: 'rgb', label: '24-bit RGB', bits: 24 }, { value: 'bgr', label: '24-bit BGR', bits: 24 }, { value: 'rgba', label: '32-bit RGBA', bits: 32 }, { value: 'bgra', label: '32-bit BGRA', bits: 32 }, { value: 'argb', label: '32-bit ARGB', bits: 32 }, { value: 'abgr', label: '32-bit ABGR', bits: 32 },
  { value: 'rgb565', label: '16-bit RGB 5-6-5', bits: 16 }, { value: 'rgb555', label: '16-bit RGB 5-5-5', bits: 16 }, { value: 'gray32f', label: '32-bit float grayscale', bits: 32 }, { value: 'rgb32f', label: '96-bit float RGB', bits: 96 },
];

export interface RawPixelOptions { width: number; height: number; layout: PixelLayout; offset: number; stride?: number; littleEndian: boolean; flip: boolean; planar?: boolean }

/** Interprets headerless pixel bytes; `stride` 0 or undefined means packed rows. */
export function rawPixels(u8: Uint8Array, o: RawPixelOptions) {
  const { width: w, height: h } = o;
  const L = LAYOUTS.find((l) => l.value === o.layout)!;
  const rowBytes = Math.ceil((w * L.bits) / 8);
  const stride = o.stride || rowBytes;
  const out = makeRaster(w, h);
  const d = out.data;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const le = o.littleEndian;
  let truncated = false;
  const u16 = (p: number) => (p + 2 > u8.length ? (truncated = true, 0) : dv.getUint16(p, le));
  const f32 = (p: number) => (p + 4 > u8.length ? (truncated = true, 0) : dv.getFloat32(p, le));
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const srgb = (v: number) => clamp(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055));
  for (let y = 0; y < h; y++) {
    const row = o.offset + (o.flip ? h - 1 - y : y) * stride;
    for (let x = 0; x < w; x++) {
      const q = (y * w + x) * 4;
      let r = 0, g = 0, b = 0, a = 255;
      const p = row + Math.floor((x * L.bits) / 8);
      if (p >= u8.length && L.bits >= 8) { truncated = true; d[q + 3] = 0; continue; }
      switch (o.layout) {
        case 'gray8': r = g = b = u8[p]; break;
        case 'gray16': r = g = b = u16(p) >> 8; break;
        case 'mono': { const bit = (u8[p] >> (7 - (x & 7))) & 1; r = g = b = bit ? 255 : 0; break; }
        case 'rgb': r = u8[p]; g = u8[p + 1]; b = u8[p + 2]; break;
        case 'bgr': b = u8[p]; g = u8[p + 1]; r = u8[p + 2]; break;
        case 'rgba': r = u8[p]; g = u8[p + 1]; b = u8[p + 2]; a = u8[p + 3]; break;
        case 'bgra': b = u8[p]; g = u8[p + 1]; r = u8[p + 2]; a = u8[p + 3]; break;
        case 'argb': a = u8[p]; r = u8[p + 1]; g = u8[p + 2]; b = u8[p + 3]; break;
        case 'abgr': a = u8[p]; b = u8[p + 1]; g = u8[p + 2]; r = u8[p + 3]; break;
        case 'rgb565': { const v = u16(p); r = ((v >> 11) & 31) * 255 / 31; g = ((v >> 5) & 63) * 255 / 63; b = (v & 31) * 255 / 31; break; }
        case 'rgb555': { const v = u16(p); r = ((v >> 10) & 31) * 255 / 31; g = ((v >> 5) & 31) * 255 / 31; b = (v & 31) * 255 / 31; break; }
        case 'gray32f': r = g = b = srgb(f32(p)); break;
        case 'rgb32f': r = srgb(f32(p)); g = srgb(f32(p + 4)); b = srgb(f32(p + 8)); break;
      }
      if (p + Math.ceil(L.bits / 8) > u8.length) { truncated = true; a = 0; }
      d[q] = clamp(r); d[q + 1] = clamp(g); d[q + 2] = clamp(b); d[q + 3] = Number.isNaN(a) ? 255 : clamp(a);
    }
  }
  return { raster: out, truncated, rowBytes, bytesNeeded: o.offset + stride * (h - 1) + rowBytes };
}

/** Guesses dimensions for a byte count and layout: the largest divisor pairs near a 4:3 shape. */
export function guessSizes(bytes: number, bits: number, limit = 6): [number, number][] {
  const px = Math.floor((bytes * 8) / bits);
  const out: [number, number][] = [];
  const common = [[640, 480], [800, 600], [1024, 768], [1280, 720], [1280, 1024], [1920, 1080], [320, 240], [256, 256], [512, 512], [1024, 1024], [2048, 2048], [128, 128], [64, 64], [32, 32], [16, 16]];
  for (const [w, hh] of common) if (w * hh === px) out.push([w, hh]);
  for (let w = Math.floor(Math.sqrt(px * 4 / 3)); w >= 8 && out.length < limit; w--) if (px % w === 0 && !out.some(([a]) => a === w)) out.push([w, px / w]);
  for (let w = Math.ceil(Math.sqrt(px * 4 / 3)); w <= px && out.length < limit; w++) if (px % w === 0 && !out.some(([a]) => a === w)) out.push([w, px / w]);
  return out.slice(0, limit);
}

def({
  id: 'file.openRawPixels', icon: 'grid_on', noRecord: true,
  tip: 'Headerless pixel dumps: give the width, height, layout and header offset',
  run: async (app) => {
    const files = await pickFile('*/*', false);
    if (!files.length) return;
    const u8 = new Uint8Array(await files[0].arrayBuffer());
    const name = files[0].name;
    const known = sniff(u8, name);
    const guess = guessSizes(u8.length, 24)[0] || [Math.min(512, u8.length), 1];
    const preview = async (v: Record<string, any>, ctl: any) => {
      const w = Math.max(1, Math.min(32768, +v.width || 1)), hh = Math.max(1, Math.min(32768, +v.height || 1));
      const r = rawPixels(u8, { width: w, height: hh, layout: v.layout, offset: Math.max(0, +v.offset || 0), stride: +v.stride || 0, littleEndian: v.endian === 'le', flip: !!v.flip });
      const c = document.createElement('canvas'); c.width = w; c.height = hh;
      c.getContext('2d')!.putImageData(new ImageData(r.raster.data, w, hh), 0, 0);
      const scale = Math.min(1, 360 / w, 240 / hh);
      ctl.setPreview(`<div class="ql-help">${w} × ${hh}, ${r.rowBytes} bytes per row · needs ${fmtSize(r.bytesNeeded)} of ${fmtSize(u8.length)}${r.truncated ? ' · <b>the file is shorter than that</b>' : ''}</div><img src="${c.toDataURL()}" style="width:${Math.round(w * scale)}px;height:${Math.round(hh * scale)}px;image-rendering:pixelated;background:repeating-conic-gradient(#888 0 25%,#bbb 0 50%) 0 0/16px 16px">`);
    };
    const r = await openDialog({ title: 'Open RAW Pixel Data', wide: true, ok: 'Open', preview: true,
      help: known ? `${name} looks like a ${known.label} file; Open opens it normally. These settings read its bytes as a plain pixel dump instead.` : `${name}: ${fmtSize(u8.length)}. Enter how the pixels are laid out; the preview follows.`,
      fields: [
        { key: 'width', label: 'Width', type: 'number', min: 1, max: 32768, value: guess[0], half: true },
        { key: 'height', label: 'Height', type: 'number', min: 1, max: 32768, value: guess[1], half: true },
        { key: 'layout', label: 'Pixel layout', type: 'select', options: LAYOUTS.map((l) => ({ value: l.value, label: l.label })), value: 'rgb', half: true },
        { key: 'endian', label: '16/32-bit byte order', type: 'select', options: [{ value: 'le', label: 'Little-endian (Intel)' }, { value: 'be', label: 'Big-endian (Motorola)' }], value: 'le', half: true },
        { key: 'offset', label: 'Header offset (bytes to skip)', type: 'number', min: 0, value: 0, half: true },
        { key: 'stride', label: 'Bytes per row (0 = packed)', type: 'number', min: 0, value: 0, half: true },
        { key: 'flip', label: 'Rows run bottom to top', type: 'checkbox', value: false, half: true },
        { key: 'sizes', label: 'Sizes that fit the file', type: 'select', options: [{ value: '', label: '(choose)' }, ...guessSizes(u8.length, 24, 8).map(([w, hh]) => ({ value: `${w}x${hh}`, label: `${w} × ${hh}` }))], value: '', half: true },
      ],
      onChange: (v, ctl, key) => {
        if (key === 'sizes' && v.sizes) { const [w, hh] = String(v.sizes).split('x'); ctl.set('width', +w); ctl.set('height', +hh); }
        if (key === 'layout' || key === 'offset') { const bits = LAYOUTS.find((l) => l.value === v.layout)!.bits; const sizes = guessSizes(Math.max(0, u8.length - (+v.offset || 0)), bits, 8); const sel = ctl.body.querySelector<HTMLSelectElement>('select[id^="f_sizes_"]'); if (sel) { sel.innerHTML = ''; for (const [val, label] of [['', '(choose)'], ...sizes.map(([w, hh]) => [`${w}x${hh}`, `${w} × ${hh}`])]) sel.appendChild(h('option', { value: val }, label)); } }
        void preview(ctl.values(), ctl);
      },
      onOpen: (ctl) => { void preview(ctl.values(), ctl); } });
    if (!r) return;
    const w = Math.max(1, +r.width || 1), hh = Math.max(1, +r.height || 1);
    const px = rawPixels(u8, { width: w, height: hh, layout: r.layout, offset: Math.max(0, +r.offset || 0), stride: +r.stride || 0, littleEndian: r.endian === 'le', flip: !!r.flip });
    const c = document.createElement('canvas'); c.width = w; c.height = hh;
    c.getContext('2d')!.putImageData(new ImageData(px.raster.data, w, hh), 0, 0);
    const blob = await encodeCanvas(c, 'png');
    const entryName = `${name.replace(/\.[^.]+$/, '')} (${w}×${hh} ${r.layout}).png`;
    await app.openFolder(new Folder([entryFromBytes(entryName, await blob.arrayBuffer())], 'RAW pixel data'), 0, { newWindow: true });
    if (px.truncated) toast('The file ended before the last row; missing pixels are transparent.');
  },
});

// Recovery report --------------------------------------------------------------------------------

def({
  id: 'file.recoveryReport', icon: 'healing', noRecord: true, isEnabled: (app) => !!app.picture || !!app.tab.error,
  tip: 'What the decoder found, repaired or could not read in the current file',
  run: async (app) => {
    const pic = app.picture;
    const tab = app.tab;
    const rows: [string, string][] = [];
    if (!pic) {
      rows.push(['File', tab.entry?.name || '—'], ['Result', 'Could not be opened'], ['Reason', tab.error || 'unknown']);
      rows.push(['Next steps', 'Open and Repair (planned for M2) will try every recovery method; Open as Hex shows the bytes now.']);
    } else {
      const sniffed = sniff(pic.bytes, pic.name);
      const byName = formatFromName(pic.name);
      rows.push(['File', pic.name], ['Size', `${fmtSize(pic.bytes.length)} (${pic.bytes.length.toLocaleString()} bytes)`]);
      rows.push(['Recognized as', `${pic.format.label}${sniffed ? ' by its content' : ' by its name only'}`]);
      if (sniffed && byName && sniffed.id !== byName.id && !(sniffed.id === 'apng' && byName.id === 'png')) rows.push(['Name mismatch', `the name says ${byName.label}, the content is ${sniffed.label}; Save As writes the right extension`]);
      rows.push(['Decoder', pic.decoder.startsWith('platform') ? 'the platform\'s codec' : `Anne's Lens ${pic.decoder} reader`]);
      rows.push(['Recovered', `${pic.pages.length} page${pic.pages.length > 1 ? 's' : ''}, ${pic.pages.reduce((s, p) => s + p.frames.length, 0)} frame${pic.pages.reduce((s, p) => s + p.frames.length, 0) > 1 ? 's' : ''}, ${pic.width} × ${pic.height}`]);
      rows.push(['Condition', pic.warnings.length ? `${pic.warnings.length} problem${pic.warnings.length > 1 ? 's' : ''} found; everything readable is shown` : 'no damage found']);
      for (const [i, w] of pic.warnings.entries()) rows.push([`Problem ${i + 1}`, w]);
      if (pic.exif?.orientation && pic.exif.orientation !== 1) rows.push(['EXIF orientation', `${pic.exif.orientation}${pic.orientationApplied ? ' (applied on display)' : ' (not applied)'}`]);
      for (const [k, v] of Object.entries(pic.info)) if (v && k !== 'segments' && k !== 'chunks') rows.push([k[0].toUpperCase() + k.slice(1), v.length > 200 ? v.slice(0, 200) + '…' : v]);
    }
    const table = h('table', { class: 'ql-stats qn-info' }, ...rows.map(([k, v]) => h('tr', null, h('td', null, k), h('td', null, v))));
    await openDialog({ title: 'Recovery Report', wide: true, content: table, cancel: false, ok: 'Close', buttons: [
      { label: 'Copy', onClick: () => { navigator.clipboard?.writeText(rows.map(([k, v]) => `${k}: ${v}`).join('\n')); toast('Copied'); } },
      { label: 'Open as Hex…', onClick: (_v, ctl) => { ctl.close(null); app.exec('file.openHex'); } },
    ] });
  },
});

// Save for Web, target size ----------------------------------------------------------------------

function scaled(src: HTMLCanvasElement, maxW: number, maxH: number): HTMLCanvasElement {
  const s = Math.min(1, maxW / src.width, maxH / src.height);
  if (s >= 1) return src;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(src.width * s)); c.height = Math.max(1, Math.round(src.height * s));
  const x = c.getContext('2d')!; x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

async function encodeFor(src: HTMLCanvasElement, format: EncodeFormat, quality: number, maxW: number, maxH: number): Promise<{ blob: Blob; canvas: HTMLCanvasElement }> {
  const canvas = scaled(src, maxW || Infinity, maxH || Infinity);
  const blob = await encodeCanvas(canvas, format, quality / 100);
  return { blob, canvas };
}

def([
  {
    id: 'file.saveForWeb', icon: 'public', noRecord: true, isEnabled: (app) => !!app.picture,
    tip: 'Original and result side by side: format, quality, longest side, file size',
    run: async (app) => {
      const pic = app.picture!;
      const src = pic.frameCanvas();
      const base = pic.name.replace(/\.[^.]+$/, '') || 'picture';
      let last: { blob: Blob; canvas: HTMLCanvasElement } | null = null;
      let url = '', origUrl = '';
      let seq = 0;
      const update = async (v: Record<string, any>, ctl: any) => {
        const my = ++seq;
        const max = Math.max(0, +v.maxSide || 0);
        const r = await encodeFor(src, v.format, +v.quality || 80, max, max);
        if (my !== seq) return;
        last = r;
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(r.blob);
        if (!origUrl) origUrl = URL.createObjectURL(await encodeCanvas(scaled(src, 1600, 1600), 'png'));
        const ratio = (r.blob.size / pic.bytes.length) * 100;
        ctl.setPreview(`<div class="ql-sxs"><figure><img src="${origUrl}"><figcaption>Original · ${pic.width} × ${pic.height} · ${fmtSize(pic.bytes.length)}</figcaption></figure><figure><img src="${url}"><figcaption>Result · ${r.canvas.width} × ${r.canvas.height} · <b>${fmtSize(r.blob.size)}</b> (${ratio.toFixed(0)}% of the original)</figcaption></figure></div>`);
      };
      const r = await openDialog({ title: 'Save for Web', wide: true, ok: 'Save…', preview: true,
        fields: [
          { key: 'format', label: 'Format', type: 'select', options: [{ value: 'jpeg', label: 'JPEG (photos)' }, { value: 'webp', label: 'WebP (smaller; photos and graphics)' }, { value: 'png', label: 'PNG (lossless; graphics, transparency)' }], value: pic.current.hasAlpha ? 'png' : 'jpeg', half: true },
          { key: 'quality', label: 'Quality', type: 'range', min: 1, max: 100, value: 80, half: true, visibleIf: (v) => v.format !== 'png' },
          { key: 'maxSide', label: 'Longest side (pixels, 0 = keep)', type: 'number', min: 0, max: 16384, value: Math.max(pic.width, pic.height) > 2048 ? 2048 : 0, half: true },
          { key: 'i', type: 'info', label: 'Metadata (EXIF, location, camera) is never written by Save for Web. Transparency is kept in PNG and WebP and flattened onto white in JPEG.' },
        ],
        onChange: (v, ctl) => { void update(v, ctl); }, onOpen: (ctl) => { void update(ctl.values(), ctl); } });
      try {
        if (!r || !last) return;
        const out = last as { blob: Blob; canvas: HTMLCanvasElement };
        const ext = r.format === 'jpeg' ? 'jpg' : r.format;
        const saved = await saveAs(out.blob, `${base}-web.${ext}`);
        if (saved) toast(`Saved ${saved.name} (${fmtSize(out.blob.size)})`);
      } finally { if (url) URL.revokeObjectURL(url); if (origUrl) URL.revokeObjectURL(origUrl); }
    },
  },
  {
    id: 'file.saveTargetSize', icon: 'compress', noRecord: true, isEnabled: (app) => !!app.picture,
    tip: 'Finds the quality (and, if allowed, the size) that fits a file-size limit',
    run: async (app) => {
      const pic = app.picture!;
      const src = pic.frameCanvas();
      const base = pic.name.replace(/\.[^.]+$/, '') || 'picture';
      const r = await openDialog({ title: 'Save to Target File Size', ok: 'Find and Save…', fields: [
        { key: 'kb', label: 'Target size (KB)', type: 'number', min: 1, max: 1_000_000, value: Math.max(10, Math.round(pic.bytes.length / 1024 / 2)), half: true },
        { key: 'format', label: 'Format', type: 'select', options: [{ value: 'jpeg', label: 'JPEG' }, { value: 'webp', label: 'WebP' }], value: 'jpeg', half: true },
        { key: 'minQuality', label: 'Lowest acceptable quality', type: 'range', min: 1, max: 100, value: 40, half: true },
        { key: 'resize', label: 'Shrink the picture when quality alone is not enough', type: 'checkbox', value: true, half: true },
      ] });
      if (!r) return;
      const target = Math.max(1, +r.kb) * 1024;
      const minQ = Math.max(1, Math.min(100, +r.minQuality || 1));
      let canvas = src;
      let best: { blob: Blob; q: number; w: number; h: number } | null = null;
      for (let round = 0; round < 8; round++) {
        let lo = minQ, hi = 100, found: { blob: Blob; q: number } | null = null;
        while (lo <= hi) {
          const q = Math.floor((lo + hi) / 2);
          const blob = await encodeCanvas(canvas, r.format, q / 100);
          if (blob.size <= target) { found = { blob, q }; lo = q + 1; } else hi = q - 1;
        }
        if (found) { best = { ...found, w: canvas.width, h: canvas.height }; break; }
        if (!r.resize || canvas.width <= 16) { const blob = await encodeCanvas(canvas, r.format, minQ / 100); best = { blob, q: minQ, w: canvas.width, h: canvas.height }; break; }
        const probe = await encodeCanvas(canvas, r.format, minQ / 100);
        const s = Math.min(0.9, Math.sqrt(target / probe.size));
        canvas = scaled(canvas, Math.max(16, Math.floor(canvas.width * s)), Math.max(16, Math.floor(canvas.height * s)));
      }
      if (!best) return;
      const ok = best.blob.size <= target;
      const saved = await saveAs(best.blob, `${base}-${Math.round(target / 1024)}kb.${r.format === 'jpeg' ? 'jpg' : 'webp'}`);
      if (saved) toast(`${ok ? 'Saved' : 'Saved (could not reach the target)'} ${saved.name}: ${fmtSize(best.blob.size)} at quality ${best.q}${best.w !== pic.width ? `, resized to ${best.w} × ${best.h}` : ''}`, { ms: 7000 });
    },
  },
]);

// Print at true size ----------------------------------------------------------------------------

def({
  id: 'file.printTrueSize', icon: 'straighten', noRecord: true, isEnabled: (app) => !!app.picture,
  tip: 'Uses the picture\'s DPI and a one-time printer calibration so 1 inch prints as 1 inch',
  run: async (app) => {
    const pic = app.picture!;
    const fileDpi = pic.current.dpi?.[0] || 0;
    const r = await openDialog({ title: 'Print at True Size', ok: 'Print', help: 'The picture is printed at its stored resolution, so an object scanned at 300 dpi comes out at its real size. Printers scale a little; print the calibration ruler once, measure it, and enter what you measured.',
      fields: [
        { key: 'dpi', label: 'Resolution (pixels per inch)', type: 'number', min: 1, max: 10000, value: fileDpi || 300, help: fileDpi ? `From the file: ${fileDpi} dpi.` : 'The file stores no resolution; 300 dpi is a common scan setting.', half: true },
        { key: 'measured', label: 'Calibration ruler measured (mm, 0 = none)', type: 'number', min: 0, max: 400, step: 0.1, value: app.prefs.printScale === 1 ? 0 : Math.round(100 / app.prefs.printScale * 10) / 10, help: 'The ruler is 100 mm long; enter the length it printed at.', half: true },
        { key: 'title', label: 'Print the file name under the picture', type: 'checkbox', value: false },
        { key: 'i', type: 'info', label: `Printed size: ${(pic.width / (fileDpi || 300)).toFixed(2)} × ${(pic.height / (fileDpi || 300)).toFixed(2)} in at ${fileDpi || 300} dpi. Enable "Actual size" / disable "Fit to page" in the print dialog.` },
      ],
      buttons: [{ label: 'Print calibration ruler', onClick: async (_v, ctl) => {
        ctl.close(null);
        const ruler = h('div', { style: 'position:relative;width:100mm;height:14mm;border:0.3mm solid #000;border-top:none;margin-top:20mm;font:9px sans-serif' },
          ...Array.from({ length: 11 }, (_, i) => h('div', { style: `position:absolute;left:${i * 10}mm;top:0;width:0.25mm;height:${i % 5 ? 4 : 7}mm;background:#000` })),
          ...Array.from({ length: 11 }, (_, i) => h('div', { style: `position:absolute;left:${i * 10 - 2}mm;top:8mm` }, String(i * 10))),
          h('div', { style: 'position:absolute;left:0;top:-14px;white-space:nowrap' }, 'Anne\'s Lens print calibration: this ruler should be exactly 100 mm. Measure it and enter the length in Print at True Size.'));
        const root = document.getElementById('ql-print-root') || document.body.appendChild(h('div', { id: 'ql-print-root' }));
        root.innerHTML = ''; root.appendChild(h('div', { class: 'ql-print-page' }, ruler));
        document.body.classList.add('ql-printing');
        try { const { printDocument } = await import('../platform/native'); await printDocument('Calibration ruler'); } finally { setTimeout(() => { document.body.classList.remove('ql-printing'); root.innerHTML = ''; }, 1000); }
      } }] });
    if (!r) return;
    const measured = +r.measured || 0;
    const scale = measured > 0 ? 100 / measured : 1;
    if (scale !== app.prefs.printScale) { app.prefs.printScale = Math.max(0.5, Math.min(2, scale)); app.savePrefs(); }
    app.ui.hideBackstage();
    await printPicture(app, { fit: 'actual', title: !!r.title, dpi: Math.max(1, +r.dpi || 300), scale: app.prefs.printScale });
  },
});

