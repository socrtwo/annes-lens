/**
 * Tools tab and odds and ends: Print Size Calculator, Extract Palette, Make QR Code, Document
 * Cleanup, Restore Old Photo, Print Check, Compare Folders; Encrypt Picture and Open Encrypted
 * Picture (.qlpe, AES-256-GCM), Save Selection As, Recover Pictures from Any File; Find Files;
 * Difference Overlay.
 */
import { dayStart, dayEnd } from '../util/days';
import { def } from './registry';
import type { App } from '../app';
import { openDialog, toast } from '../ui/dialog';
import type { Field } from '../ui/dialog';
import { h, esc } from '../ui/dom';
import { Folder, entryFromBytes } from '../picture/folder';
import type { Entry } from '../picture/folder';
import { encodeCanvas, ENCODERS, decodePicture, sniff, type EncodeFormat } from '../codecs/registry';
import { medianCut, encodePalette, type PaletteFormat } from '../codecs/palette';
import { encodeQr, qrRaster, qrSvg, type EcLevel } from '../codecs/qr';
import { carvePictures } from '../codecs/carve';
import { encryptPicture, decryptPicture, isQlpe, QLPE_EXT } from '../codecs/encrypt';
import { adjustDialog, range } from './adjust';
import { frameRaster, rasterFrame } from '../picture/edit';
import { crop, resample, grayscale, adaptiveThreshold, hexToRgb } from '../picture/ops';
import * as A from '../picture/adjust';
import { findPageCorners, perspective, deskewAngle, rotateRaster } from '../picture/geometry';
import { openDocuments, saveAs, pickFolder, listFolderOf, readUri, writeClipboardText } from '../platform/native';
import { readMeta } from '../picture/metadata';
import { fmtSize } from '../ui/shell';
import { extractMeta } from '../meta/metaWrite';
import type { Raster } from '../codecs/raster';
import { sha } from '../meta/metaEdit';

const has = (app: App) => !!app.picture;
const base = (n: string) => n.replace(/\.[^.]+$/, '') || 'picture';
const rasterOf = (c: HTMLCanvasElement): Raster => { const id = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height); return { width: c.width, height: c.height, data: id.data as Uint8ClampedArray<ArrayBuffer> }; };
async function openBytes(app: App, name: string, bytes: Uint8Array, folderName: string): Promise<void> { await app.openFolder(new Folder([entryFromBytes(name, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)], folderName), 0, { newWindow: true }); }

/** Flattens uneven lighting: divides by a heavily blurred copy (the paper), then levels the paper to white. */
export function flattenLighting(src: Raster, radius = 40, white = 0.92): Raster {
  const bg = A.gaussianBlur(src, radius), out = { width: src.width, height: src.height, data: src.data.slice() as Uint8ClampedArray<ArrayBuffer> }, d = out.data, b = bg.data;
  for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = Math.max(0, Math.min(255, (d[i + c] / Math.max(8, b[i + c])) * 255 * white));
  return out;
}
export function docCleanup(src: Raster, o: { cropPage: boolean; deskew: boolean; flatten: boolean; whiten: boolean; despeckle: boolean; bw: boolean }): Raster {
  let r = src;
  if (o.cropPage) { const q = findPageCorners(r); if (q) r = perspective(r, q); }
  if (o.deskew) { const a = deskewAngle(r); if (a) r = rotateRaster(r, a, false, [255, 255, 255]); }
  if (o.flatten) r = flattenLighting(r);
  if (o.whiten) r = A.levels(r, { inBlack: 20, inWhite: 225 });
  if (o.despeckle) r = A.despeckle(r, 1);
  if (o.bw) r = adaptiveThreshold(grayscale(r), 25, 10);
  return r;
}

async function bytesOfEntry(app: App, e: Entry): Promise<Uint8Array> { const pic = app.tab.picture; return pic && pic.entry === e ? pic.bytes : new Uint8Array(await e.read()); }

def([
  // Tools: documents, print, color, codes -------------------------------------------------------------
  {
    id: 'tools.printCalc', icon: 'calculate', noRecord: true, tip: 'Pixels ↔ inches and centimeters at a DPI; the largest good print size of this picture',
    run: async (app) => {
      const pic = app.picture; const dpi0 = pic?.current.dpi?.[0] || 300;
      const calc = (v: Record<string, any>) => { const w = +v.w || 0, hh = +v.h || 0, dpi = +v.dpi || 300; const inW = w / dpi, inH = hh / dpi; return `<table class="ql-stats qn-info"><tr><td>At ${dpi} dpi</td><td>${inW.toFixed(2)} × ${inH.toFixed(2)} in = ${(inW * 2.54).toFixed(1)} × ${(inH * 2.54).toFixed(1)} cm</td></tr><tr><td>Largest good print (300 dpi)</td><td>${(w / 300).toFixed(1)} × ${(hh / 300).toFixed(1)} in = ${((w / 300) * 2.54).toFixed(0)} × ${((hh / 300) * 2.54).toFixed(0)} cm</td></tr><tr><td>Acceptable (200 dpi)</td><td>${(w / 200).toFixed(1)} × ${(hh / 200).toFixed(1)} in</td></tr><tr><td>Poster (150 dpi)</td><td>${(w / 150).toFixed(1)} × ${(hh / 150).toFixed(1)} in</td></tr><tr><td>For ${(+v.printW || 0).toFixed(1)} in wide</td><td>${v.printW ? `${(w / +v.printW).toFixed(0)} dpi effective${w / +v.printW < 150 ? ' — too low' : w / +v.printW < 240 ? ' — acceptable' : ' — good'}` : '—'}</td></tr></table>`; };
      await openDialog({ title: 'Print Size Calculator', ok: 'Close', cancel: false, preview: true, fields: [{ key: 'w', label: 'Width (px)', type: 'number', min: 1, value: pic?.width || 3000, half: true }, { key: 'h', label: 'Height (px)', type: 'number', min: 1, value: pic?.height || 2000, half: true }, { key: 'dpi', label: 'DPI', type: 'number', min: 1, max: 2400, value: dpi0, half: true }, { key: 'printW', label: 'Wanted print width (in)', type: 'number', min: 0, step: 0.1, value: 8, half: true }], onChange: (v, ctl) => ctl.setPreview(calc(v)), onOpen: (ctl) => ctl.setPreview(calc(ctl.values())) });
    },
  },
  {
    id: 'tools.paletteExtract', icon: 'palette', noRecord: true, isEnabled: has, tip: 'The dominant colors as swatches; copy as CSS or save a palette file',
    run: async (app) => {
      const pic = app.picture!;
      const small = (() => { const r = frameRaster(pic.currentFrame); const k = Math.min(1, 400 / Math.max(r.width, r.height)); return k < 1 ? resample(r, Math.round(r.width * k), Math.round(r.height * k), 'bilinear') : r; })();
      let pal = medianCut(small.data, 8);
      const swatches = (n: number) => { pal = medianCut(small.data, n); pal.colors.sort((a, b) => (0.299 * b[0] + 0.587 * b[1] + 0.114 * b[2]) - (0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2])); return `<div style="display:flex;flex-wrap:wrap;gap:6px">${pal.colors.map((c) => { const hex = '#' + c.map((v) => v.toString(16).padStart(2, '0')).join(''); return `<div style="width:64px"><div style="height:40px;border-radius:4px;background:${hex};border:1px solid #8884"></div><div style="font-size:11px;text-align:center">${hex}</div></div>`; }).join('')}</div>`; };
      const css = () => `:root {\n${pal.colors.map((c, i) => `  --color-${i + 1}: #${c.map((v) => v.toString(16).padStart(2, '0')).join('')};`).join('\n')}\n}`;
      await openDialog({ title: `Palette — ${pic.name}`, wide: true, ok: 'Close', cancel: false, preview: true, fields: [{ key: 'n', label: 'Colors', type: 'range', min: 2, max: 32, value: 8 }], onChange: (v, ctl) => ctl.setPreview(swatches(+v.n)), onOpen: (ctl) => ctl.setPreview(swatches(8)), buttons: [
        { label: 'Copy CSS', onClick: () => { writeClipboardText(css()); toast('Copied CSS variables'); } },
        { label: 'Copy hex list', onClick: () => { writeClipboardText(pal.colors.map((c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')).join('\n')); toast('Copied'); } },
        { label: 'Save palette file…', onClick: async () => { const r = await openDialog({ title: 'Palette File', ok: 'Save…', fields: [{ key: 'format', label: 'Format', type: 'select', options: [{ value: 'gpl', label: 'GIMP (.gpl)' }, { value: 'act', label: 'Adobe color table (.act)' }, { value: 'pal', label: 'JASC (.pal)' }, { value: 'aco', label: 'Photoshop (.aco)' }, { value: 'css', label: 'CSS' }, { value: 'txt', label: 'Text' }], value: 'gpl' }] }); if (!r) return; const out = encodePalette(pal, r.format as PaletteFormat, base(pic.name)); const saved = await saveAs(new Blob([out.bytes as BlobPart], { type: out.mime }), `${base(pic.name)}.${out.ext}`); if (saved) toast(`Saved ${saved.name}`); } },
      ] });
    },
  },
  {
    id: 'tools.makeQr', icon: 'qr_code_2', noRecord: true, tip: 'Text, a link, Wi-Fi or contact details as a QR code picture (PNG or SVG)',
    run: async (app) => {
      const pic = app.picture;
      const make = (v: Record<string, any>) => { const text = v.kind === 'wifi' ? `WIFI:T:${v.wifiSec};S:${v.wifiSsid};P:${v.wifiPass};;` : v.kind === 'contact' ? `MECARD:N:${v.name};TEL:${v.tel};EMAIL:${v.email};;` : String(v.text || ''); return { text, qr: encodeQr(text || ' ', v.ecl as EcLevel) }; };
      const r = await openDialog({ title: 'Make QR Code', wide: true, ok: 'Open as picture', preview: true, fields: [
        { key: 'kind', label: 'Content', type: 'select', options: [{ value: 'text', label: 'Text or link' }, { value: 'wifi', label: 'Wi-Fi network' }, { value: 'contact', label: 'Contact (MeCard)' }], value: 'text', half: true },
        { key: 'ecl', label: 'Error correction', type: 'select', options: [{ value: 'L', label: 'L (7%)' }, { value: 'M', label: 'M (15%)' }, { value: 'Q', label: 'Q (25%)' }, { value: 'H', label: 'H (30%)' }], value: 'M', half: true },
        { key: 'text', label: 'Text', type: 'textarea', rows: 3, value: pic?.entry.uri?.startsWith('http') ? pic.entry.uri : 'https://', visibleIf: (v) => v.kind === 'text' },
        { key: 'wifiSsid', label: 'Network name', type: 'text', value: '', half: true, visibleIf: (v) => v.kind === 'wifi' }, { key: 'wifiPass', label: 'Password', type: 'text', value: '', half: true, visibleIf: (v) => v.kind === 'wifi' }, { key: 'wifiSec', label: 'Security', type: 'select', options: ['WPA', 'WEP', 'nopass'], value: 'WPA', half: true, visibleIf: (v) => v.kind === 'wifi' },
        { key: 'name', label: 'Name', type: 'text', value: '', half: true, visibleIf: (v) => v.kind === 'contact' }, { key: 'tel', label: 'Phone', type: 'text', value: '', half: true, visibleIf: (v) => v.kind === 'contact' }, { key: 'email', label: 'Email', type: 'text', value: '', half: true, visibleIf: (v) => v.kind === 'contact' },
        { key: 'scale', label: 'Pixels per module', type: 'number', min: 1, max: 40, value: 8, half: true }, { key: 'dark', label: 'Dark', type: 'color', value: '#000000', half: true }, { key: 'light', label: 'Light', type: 'color', value: '#ffffff', half: true },
      ], onChange: (v, ctl) => { try { const { qr } = make(v); ctl.setPreview(`<div style="max-width:220px;margin:auto">${qrSvg(qr)}</div><div class="ql-help">Version ${qr.version} (${qr.size}×${qr.size}), level ${qr.ecl}</div>`); } catch (e: any) { ctl.setPreview(`<div class="ql-help">${esc(String(e.message))}</div>`); } }, onOpen: (ctl) => { const { qr } = make(ctl.values()); ctl.setPreview(`<div style="max-width:220px;margin:auto">${qrSvg(qr)}</div><div class="ql-help">Version ${qr.version}, level ${qr.ecl}</div>`); }, buttons: [
        { label: 'Save SVG…', onClick: async (v) => { try { const { qr } = make(v); const saved = await saveAs(new Blob([qrSvg(qr)], { type: 'image/svg+xml' }), 'qr-code.svg'); if (saved) toast(`Saved ${saved.name}`); } catch (e: any) { toast(e.message); } } },
      ] });
      if (!r) return;
      try { const { qr } = make(r); const raster = qrRaster(qr, Math.max(1, +r.scale || 8), 4, hexToRgb(r.dark) as [number, number, number], hexToRgb(r.light) as [number, number, number]); const blob = await encodeCanvas(rasterFrame(raster, 0).image as HTMLCanvasElement, 'png'); await openBytes(app, 'qr-code.png', new Uint8Array(await blob.arrayBuffer()), 'QR code'); } catch (e: any) { toast(e.message); }
    },
  },
  {
    id: 'tools.docCleanup', icon: 'document_scanner', popular: true, edits: true, isEnabled: has, tip: 'Crop to the page, deskew, flatten the lighting, whiten the paper, despeckle, black-and-white — with a preview',
    run: (app) => adjustDialog(app, 'Document Cleanup…', [{ key: 'cropPage', label: 'Crop to the page (photo of a document)', type: 'checkbox', value: false, half: true }, { key: 'deskew', label: 'Deskew', type: 'checkbox', value: true, half: true }, { key: 'flatten', label: 'Flatten the lighting', type: 'checkbox', value: true, half: true }, { key: 'whiten', label: 'Whiten the paper', type: 'checkbox', value: true, half: true }, { key: 'despeckle', label: 'Despeckle', type: 'checkbox', value: false, half: true }, { key: 'bw', label: 'Black and white (adaptive threshold)', type: 'checkbox', value: false, half: true }],
      (r, v) => docCleanup(r, { cropPage: !!v.cropPage, deskew: !!v.deskew, flatten: !!v.flatten, whiten: !!v.whiten, despeckle: !!v.despeckle, bw: !!v.bw }), { help: 'For scans and phone photos of papers. Black and white gives the smallest files for text.', label: 'Document Cleanup' }).then(() => undefined),
  },
  {
    id: 'tools.restoreWizard', icon: 'auto_fix_high', edits: true, isEnabled: has, tip: 'Guided repair of old prints and slides: dust and scratches, faded colors, contrast, sharpening',
    run: (app) => adjustDialog(app, 'Restore Old Photo…', [{ key: 'dust', label: 'Remove dust and scratches', type: 'checkbox', value: true, half: true }, range('dustRadius', 'Speck size (px)', 1, 5, 2), { key: 'faded', label: 'Restore faded colors', type: 'checkbox', value: true, half: true }, { key: 'contrast', label: 'Recover contrast (auto levels)', type: 'checkbox', value: true, half: true }, { key: 'cast', label: 'Remove the color cast', type: 'checkbox', value: true, half: true }, { key: 'sharpen', label: 'Sharpen gently', type: 'checkbox', value: true, half: true }, range('sepia', 'Sepia to color (0 keeps the tone)', 0, 100, 0)],
      (r, v) => { let x = r; if (v.dust) x = A.dustScratches(x, +v.dustRadius, 28).raster; if (v.faded) x = A.restoreFaded(x); if (v.contrast) x = A.autoContrast(x); if (v.cast) x = A.autoColor(x, 0.7); if (+v.sepia) x = A.saturate(x, -(+v.sepia) / 100); if (v.sharpen) x = A.sharpen(x, 0.6); return x; }, { help: 'Tears and missing areas need the paint tools; AI repair and colorizing come with the AI tab.', label: 'Restore Old Photo' }).then(() => undefined),
  },
  {
    id: 'tools.preflight', icon: 'print', noRecord: true, isEnabled: has, tip: 'Effective DPI at a print size, color mode, embedded profile and what to fix before printing',
    run: async (app) => {
      const pic = app.picture!; const meta = extractMeta(pic.bytes);
      const r = await openDialog({ title: 'Print Check', ok: 'Close', cancel: false, preview: true, fields: [{ key: 'w', label: 'Print width (in)', type: 'number', min: 0.5, step: 0.1, value: 8, half: true }, { key: 'paper', label: 'Target', type: 'select', options: [{ value: '300', label: 'Photo print (300 dpi)' }, { value: '240', label: 'Inkjet (240 dpi)' }, { value: '150', label: 'Poster (150 dpi)' }], value: '300', half: true }], onChange: (v, ctl) => ctl.setPreview(report(+v.w, +v.paper)), onOpen: (ctl) => ctl.setPreview(report(8, 300)) });
      void r;
      function report(w: number, want: number): string {
        const dpi = pic.width / Math.max(0.1, w), hIn = pic.height / dpi;
        const rows: [string, string, string][] = [];
        rows.push(['Effective resolution', `${dpi.toFixed(0)} dpi at ${w.toFixed(1)} × ${hIn.toFixed(1)} in`, dpi >= want ? 'ok' : dpi >= want * 0.66 ? 'warn' : 'bad']);
        rows.push(['Largest print at the target', `${(pic.width / want).toFixed(1)} × ${(pic.height / want).toFixed(1)} in`, 'ok']);
        rows.push(['Color mode', pic.current.notes.find((n) => /gray|cmyk|palette|indexed/i.test(n)) || `${pic.current.bitDepth}-bit RGB`, 'ok']);
        rows.push(['Color profile', meta.icc ? `embedded (${fmtSize(meta.icc.length)})` : 'none (sRGB assumed)', meta.icc ? 'ok' : 'warn']);
        rows.push(['Format', `${pic.format.label}${pic.format.id === 'jpeg' ? ' (lossy; save edits as TIFF or PNG)' : ''}`, 'ok']);
        if (pic.current.hasAlpha) rows.push(['Transparency', 'present; it prints as white unless flattened', 'warn']);
        if (pic.exif?.orientation && pic.exif.orientation !== 1 && !pic.orientationApplied) rows.push(['Orientation', 'EXIF rotation not applied; apply it before printing', 'warn']);
        return `<table class="ql-stats qn-info">${rows.map(([a, b, s]) => `<tr class="${s === 'bad' ? 'qn-priv-high' : s === 'warn' ? 'qn-priv-med' : ''}"><td>${a}</td><td>${b}</td></tr>`).join('')}</table>`;
      }
    },
  },
  {
    id: 'tools.compareFolders', icon: 'compare_arrows', noRecord: true, tip: 'Pictures missing, changed (by size and checksum) or present in both of two folders',
    run: async (app) => {
      const a = await pickFolder('First folder'); if (!a) return; const b = await pickFolder('Second folder'); if (!b) return;
      const la = await listFolderOf(a.uri), lb = await listFolderOf(b.uri);
      if (!la || !lb) { toast('The folders could not be listed on this platform.'); return; }
      const r = await openDialog({ title: 'Compare Folders', ok: 'Compare', fields: [{ key: 'hash', label: 'Compare contents by SHA-256 (slower; otherwise by size)', type: 'checkbox', value: false }], help: `${a.name}: ${la.entries.length} files; ${b.name}: ${lb.entries.length} files.` }); if (!r) return;
      const mb = new Map(lb.entries.map((e) => [e.name.toLowerCase(), e]));
      const onlyA: string[] = [], onlyB: string[] = [], changed: string[] = [], same: string[] = []; let i = 0;
      const digest = async (uri: string) => { const f = await readUri(uri); return f ? sha(new Uint8Array(f.data), 'SHA-256') : ''; };
      for (const e of la.entries) { i++; if (i % 10 === 0) toast(`${i} / ${la.entries.length}…`, { ms: 600 }); const o = mb.get(e.name.toLowerCase()); if (!o) { onlyA.push(e.name); continue; } mb.delete(e.name.toLowerCase()); const diff = r.hash ? (await digest(e.uri)) !== (await digest(o.uri)) : (e.size ?? -1) !== (o.size ?? -2); (diff ? changed : same).push(e.name); }
      for (const e of mb.values()) onlyB.push(e.name);
      const sec = (title: string, names: string[]) => (names.length ? [h('h4', null, `${title} (${names.length})`), h('div', { class: 'ql-help', style: 'white-space:pre-wrap' }, names.sort().join('\n'))] : []);
      await openDialog({ title: `${a.name} ↔ ${b.name}`, wide: true, ok: 'Close', cancel: false, help: `${same.length} same, ${changed.length} changed, ${onlyA.length} only in ${a.name}, ${onlyB.length} only in ${b.name}.`, content: h('div', { style: 'max-height:60vh;overflow:auto' }, ...sec(`Only in ${a.name}`, onlyA), ...sec(`Only in ${b.name}`, onlyB), ...sec('Changed', changed), ...sec('Same', same)) });
    },
  },

  // Files: encryption, selection, recovery -----------------------------------------------------------
  {
    id: 'file.encrypt', icon: 'lock', noRecord: true, isEnabled: has, tip: 'Saves this picture as an AES-256 encrypted .qlpe package (for scans of IDs, records and other private papers)',
    run: async (app) => {
      const pic = app.picture!;
      const r = await openDialog({ title: 'Encrypt Picture', ok: 'Encrypt and save…', help: 'AES-256-GCM with a key from your password (PBKDF2, 600 000 rounds). There is no recovery without the password.', fields: [{ key: 'p1', label: 'Password', type: 'password', value: '', autofocus: true }, { key: 'p2', label: 'Repeat the password', type: 'password', value: '' }, { key: 'current', label: 'Encrypt the file as it is on disk (otherwise the edited picture as PNG)', type: 'checkbox', value: !app.tab.dirty }] });
      if (!r) return;
      if (!r.p1 || r.p1 !== r.p2) { toast('The passwords do not match.'); return; }
      if (String(r.p1).length < 8) { toast('Use at least 8 characters.'); return; }
      let bytes = pic.bytes, name = pic.name;
      if (!r.current) { bytes = new Uint8Array(await (await encodeCanvas(pic.frameCanvas(), 'png')).arrayBuffer()); name = `${base(pic.name)}.png`; }
      toast('Encrypting…', { ms: 1500 });
      const pkg = await encryptPicture(bytes, name, String(r.p1));
      const saved = await saveAs(new Blob([pkg as BlobPart], { type: 'application/octet-stream' }), `${base(pic.name)}.${QLPE_EXT}`);
      if (saved) toast(`Saved ${saved.name} (${fmtSize(pkg.length)})`);
    },
  },
  {
    id: 'file.openEncrypted', icon: 'lock_open', noRecord: true, tip: 'Opens a .qlpe package with its password',
    run: async (app) => { const files = await openDocuments(`.${QLPE_EXT}`, ['application/octet-stream'], false); if (!files.length) return; await openEncrypted(app, files[0].name, new Uint8Array(files[0].data)); },
  },
  {
    id: 'file.saveSelection', icon: 'save', noRecord: true, isEnabled: (app) => !!app.picture && !!app.tab.selection, tip: 'The selected rectangle as a new file',
    run: async (app) => {
      const pic = app.picture!, sel = app.tab.selection!;
      const r = await openDialog({ title: 'Save Selection As', ok: 'Save…', fields: [{ key: 'format', label: 'Format', type: 'select', options: Object.entries(ENCODERS).map(([value, v]) => ({ value, label: v.label })), value: 'png', half: true }, { key: 'quality', label: 'Quality', type: 'range', min: 1, max: 100, value: app.prefs.jpegQuality, half: true }] });
      if (!r) return;
      const part = crop(frameRaster(pic.currentFrame), sel);
      const blob = await encodeCanvas(rasterFrame(part, 0).image as HTMLCanvasElement, r.format as EncodeFormat, +r.quality / 100);
      const saved = await saveAs(blob, `${base(pic.name)}-${sel.w}x${sel.h}.${ENCODERS[r.format as EncodeFormat].ext}`);
      if (saved) toast(`Saved ${saved.name} (${fmtSize(blob.size)})`);
    },
  },
  {
    id: 'file.recoverAny', icon: 'find_in_page', noRecord: true, tip: 'Carves JPEG, PNG, GIF, WebP, BMP and TIFF pictures out of any file: disk images, caches, documents, damaged archives',
    run: async (app) => {
      const files = await openDocuments('*/*', ['*/*'], false); if (!files.length) return;
      const u8 = new Uint8Array(files[0].data);
      toast('Scanning…', { ms: 1500 });
      const found = carvePictures(u8);
      if (!found.length) { toast(`No pictures found in ${files[0].name}.`); return; }
      const bn = base(files[0].name); const exts = { jpeg: 'jpg', png: 'png', gif: 'gif', webp: 'webp', bmp: 'bmp', tiff: 'tif' };
      const entries = found.map((c, i) => entryFromBytes(`${bn}-${String(i + 1).padStart(3, '0')}.${exts[c.format]}`, u8.slice(c.offset, c.offset + c.length).buffer as ArrayBuffer));
      await app.openFolder(new Folder(entries, `Recovered from ${files[0].name}`), 0, { newWindow: true });
      toast(`${found.length} picture${found.length === 1 ? '' : 's'} carved out of ${files[0].name} (${fmtSize(u8.length)}); save the ones you want.`);
    },
  },

  // Find and compare ---------------------------------------------------------------------------------
  {
    id: 'edit.findFiles', icon: 'search', noRecord: true, isEnabled: (app) => app.folder.length > 0, tip: 'Name (wildcards), size, dimensions, date and caption text in this folder; the hits are marked',
    run: async (app) => {
      const f = app.tab.folder;
      const r = await openDialog({ title: 'Find Files', ok: 'Find', help: `Searches the ${f.length} pictures of this folder. Hits are marked in the thumbnails.`, fields: [
        { key: 'name', label: 'Name (use * and ?)', type: 'text', value: '*', half: true }, { key: 'text', label: 'Text in title, caption or keywords', type: 'text', value: '', half: true },
        { key: 'minKb', label: 'Size at least (KB)', type: 'number', min: 0, value: 0, half: true }, { key: 'maxKb', label: 'Size at most (KB, 0 = any)', type: 'number', min: 0, value: 0, half: true },
        { key: 'minW', label: 'Width at least', type: 'number', min: 0, value: 0, half: true }, { key: 'minH', label: 'Height at least', type: 'number', min: 0, value: 0, half: true },
        { key: 'from', label: 'Modified from', type: 'date', value: '', half: true }, { key: 'to', label: 'Modified to', type: 'date', value: '', half: true },
      ] });
      if (!r) return;
      const re = new RegExp('^' + String(r.name || '*').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
      const q = String(r.text || '').trim().toLowerCase(); const needsDims = +r.minW > 0 || +r.minH > 0; const from = dayStart(r.from)?.getTime() ?? 0, to = dayEnd(r.to)?.getTime() ?? Infinity;
      const hits: Entry[] = []; let i = 0;
      for (const e of f.entries) {
        i++; if ((q || needsDims) && i % 10 === 0) toast(`${i} / ${f.length}…`, { ms: 600 });
        if (!re.test(e.name)) continue;
        if (e.size !== undefined && ((+r.minKb && e.size < +r.minKb * 1024) || (+r.maxKb && e.size > +r.maxKb * 1024))) continue;
        if (e.mtime !== undefined && (e.mtime < from || e.mtime > to)) continue;
        if (q) { const m = await readMeta(app, e); const text = [m?.props.title, m?.props.description, ...(m?.props.keywords || []), e.name].filter(Boolean).join(' ').toLowerCase(); if (!text.includes(q)) continue; }
        if (needsDims) { try { const u8 = await bytesOfEntry(app, e); const fmt = sniff(u8, e.name); if (!fmt) continue; const bmp = await createImageBitmap(new Blob([u8 as BlobPart], { type: fmt.mime })); const ok = bmp.width >= +r.minW && bmp.height >= +r.minH; bmp.close(); if (!ok) continue; } catch { continue; } }
        hits.push(e);
      }
      app.tab.marked.clear(); for (const e of hits) app.tab.marked.add(e);
      if (hits.length && !app.tab.thumbs.open) app.tab.thumbs.show('grid'); app.tab.thumbs.sync(); app.refresh();
      toast(hits.length ? `${hits.length} file${hits.length === 1 ? '' : 's'} found and marked` : 'Nothing matched.');
    },
  },
  {
    id: 'view.diffOverlay', icon: 'difference', noRecord: true, isEnabled: (app) => !!app.picture && (app.tab.marked.size >= 1 || app.folder.length > 1), tip: 'Changed pixels between this picture and another (a marked thumbnail, or the next picture) as a new window',
    run: async (app) => {
      const pic = app.picture!; const t = app.tab; const other = t.folder.entries.find((e) => t.marked.has(e) && e !== pic.entry) || t.folder.entries[t.folder.index + 1] || t.folder.entries[0];
      if (!other || other === pic.entry) { toast('Mark another picture to compare with.'); return; }
      const r = await openDialog({ title: 'Difference Overlay', ok: 'Show', help: `${pic.name} against ${other.name}.`, fields: [{ key: 'threshold', label: 'Threshold (0 = any change)', type: 'range', min: 0, max: 128, value: 8 }, { key: 'mode', label: 'Show', type: 'select', options: [{ value: 'overlay', label: 'Changed pixels in red over the picture' }, { value: 'diff', label: 'The difference itself (amplified)' }], value: 'overlay' }] });
      if (!r) return;
      const o = await decodePicture(await bytesOfEntry(app, other), other);
      try {
        const a = frameRaster(pic.currentFrame); let b = frameRaster(o.currentFrame); if (b.width !== a.width || b.height !== a.height) b = resample(b, a.width, a.height, 'bilinear');
        const out = { width: a.width, height: a.height, data: a.data.slice() as Uint8ClampedArray<ArrayBuffer> }; let changed = 0;
        for (let i = 0; i < out.data.length; i += 4) { const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2])); if (r.mode === 'diff') { const v = Math.min(255, d * 4); out.data[i] = out.data[i + 1] = out.data[i + 2] = v; out.data[i + 3] = 255; if (d > +r.threshold) changed++; } else if (d > +r.threshold) { changed++; out.data[i] = 255; out.data[i + 1] = Math.round(out.data[i + 1] * 0.3); out.data[i + 2] = Math.round(out.data[i + 2] * 0.3); } }
        const blob = await encodeCanvas(rasterFrame(out, 0).image as HTMLCanvasElement, 'png');
        await openBytes(app, `${base(pic.name)}-vs-${base(other.name)}.png`, new Uint8Array(await blob.arrayBuffer()), 'Difference');
        toast(`${((100 * changed) / (a.width * a.height)).toFixed(2)}% of the pixels differ by more than ${r.threshold}`);
      } finally { o.release(); }
    },
  },
]);

/** Asks for the password and opens the picture inside a .qlpe package. */
export async function openEncrypted(app: App, name: string, pkg: Uint8Array): Promise<boolean> {
  if (!isQlpe(pkg)) { toast(`${name} is not an encrypted picture.`); return false; }
  for (;;) {
    const r = await openDialog({ title: `Open ${name}`, ok: 'Open', fields: [{ key: 'p', label: 'Password', type: 'password', value: '', autofocus: true }] });
    if (!r) return false;
    try { const { name: inner, bytes } = await decryptPicture(pkg, String(r.p)); await openBytes(app, inner, bytes, `${name} (decrypted)`); toast(`${inner} opened from ${name}; it is not written anywhere unless you save it.`); return true; }
    catch (e: any) { toast(e.message); }
  }
}
