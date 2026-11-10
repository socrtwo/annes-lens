/**
 * Platform-bound file commands: Set as Wallpaper / Lock Screen, Set as Contact Photo, Cast to
 * Display, File Properties (system), Copy as File, Hide Picture, File Associations, Scan…, Batch
 * Scanning…, Select Scan Source…, Import from Camera or Phone…, Import with Rules…. Each shell says
 * what it can do (platformCaps in src/platform/native.ts); the commands disable themselves for the
 * rest. docs/TERMUX-VERIFY.md lists the one-time checks of the Android side on a device.
 */
import { def } from './registry';
import type { App } from '../app';
import type { Raster } from '../codecs/raster';
import { openDialog, confirmDialog, toast, type Field } from '../ui/dialog';
import { encodeCanvas, decodePicture } from '../codecs/registry';
import { Folder, entryFromBytes, entryFromUri, type Entry } from '../picture/folder';
import { frameRaster, rasterFrame, editRaster } from '../picture/edit';
import { resample } from '../picture/ops';
import { findPageCorners, perspective, deskewAngle, rotateRaster } from '../picture/geometry';
import { encodeTiff } from '../codecs/tiffwrite';
import { makePdf } from '../codecs/pdfwrite';
import { platformCaps, setWallpaper, attachData, openCastSettings, copyFileToClipboard, showProperties, setAssociations, listScanners, scanPage, capturePhoto, createSubfolder, pickFolder, listFolderOf, readUri, writeIntoFolder, deleteFile, saveAs, isDesktop, platformName, type OpenedFile } from '../platform/native';
import { fmtSize } from '../ui/shell';
import { dirUriOf } from './fileOps';
import { sha } from '../meta/metaEdit';

const caps = platformCaps();
const has = (app: App) => !!app.picture;
const stamp = () => { const d = new Date(), p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };

// Wallpaper ----------------------------------------------------------------------------------------

export type WallpaperMode = 'fill' | 'fit' | 'stretch' | 'center' | 'tile';
/** Renders the picture onto a screen-sized canvas the way the mode says. */
export function wallpaperRaster(src: Raster, sw: number, sh: number, mode: WallpaperMode, bg = '#000000'): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = sw; c.height = sh;
  const x = c.getContext('2d')!; x.fillStyle = bg; x.fillRect(0, 0, sw, sh); x.imageSmoothingQuality = 'high';
  const img = rasterFrame(src, 0).image as HTMLCanvasElement;
  if (mode === 'stretch') x.drawImage(img, 0, 0, sw, sh);
  else if (mode === 'tile') { for (let y = 0; y < sh; y += src.height) for (let xx = 0; xx < sw; xx += src.width) x.drawImage(img, xx, y); }
  else if (mode === 'center') x.drawImage(img, Math.round((sw - src.width) / 2), Math.round((sh - src.height) / 2));
  else { const k = mode === 'fill' ? Math.max(sw / src.width, sh / src.height) : Math.min(sw / src.width, sh / src.height); const w = src.width * k, h = src.height * k; x.drawImage(img, (sw - w) / 2, (sh - h) / 2, w, h); }
  return c;
}
const screenSize = () => ({ w: Math.round(screen.width * (devicePixelRatio || 1)), h: Math.round(screen.height * (devicePixelRatio || 1)) });
async function applyWallpaper(app: App, mode: WallpaperMode, which: 'home' | 'lock' | 'both'): Promise<void> {
  const { w, h } = screenSize();
  const c = wallpaperRaster(frameRaster(app.picture!.currentFrame), w, h, mode);
  const png = await (await encodeCanvas(c, 'png')).arrayBuffer();
  const r = await setWallpaper(png, which);
  toast(r.ok ? `${which === 'lock' ? 'Lock screen' : 'Wallpaper'} set (${mode}, ${w}×${h}${(r as any).how ? `, ${(r as any).how}` : ''}).` : 'The wallpaper could not be set.');
}
const MODES: [WallpaperMode, string][] = [['fill', 'Fill the screen'], ['fit', 'Fit inside the screen'], ['stretch', 'Stretch'], ['center', 'Center'], ['tile', 'Tile']];

// Scanning -----------------------------------------------------------------------------------------

export function tidyScan(r: Raster, o: { autoCrop: boolean; deskew: boolean }): Raster {
  let out = r;
  if (o.autoCrop) { const k = Math.min(1, 800 / Math.max(r.width, r.height)); const sm = k < 1 ? resample(r, Math.round(r.width * k), Math.round(r.height * k), 'lanczos3') : r; const q = findPageCorners(sm); if (q) out = perspective(out, q.map(([x, y]) => [x / k, y / k]) as typeof q); }
  if (o.deskew) { const a = deskewAngle(out); if (Math.abs(a) > 0.1) out = rotateRaster(out, -a, false); }
  return out;
}
async function openedRaster(f: OpenedFile): Promise<Raster> { const pic = await decodePicture(new Uint8Array(f.data), { name: f.name, uri: null, read: async () => f.data }); const r = frameRaster(pic.currentFrame); pic.release(); return r; }
/** One page from the chosen source: a scanner through the shell, the camera app (Android), or the camera stream. */
async function acquirePage(app: App, source: string, dpi: number, mode: 'color' | 'gray'): Promise<Raster | null> {
  if (source === 'camera-intent') { const f = await capturePhoto(); return f ? openedRaster(f) : null; }
  if (source === 'camera') { await (app.exec('file.captureCamera') as Promise<unknown>); const p = app.picture; if (!p || !/^Camera /.test(p.name)) return null; const r = frameRaster(p.currentFrame); app.closeTab(app.tab); return r; }
  return openedRaster(await scanPage({ device: source === 'default' ? app.prefs.scanSource || undefined : source, dpi, mode }));
}
async function sourceFields(app: App): Promise<{ fields: Field[]; any: boolean }> {
  const opts: { value: string; label: string }[] = [];
  if (caps.scanner) { const l = await listScanners(); for (const d of l.devices) opts.push({ value: d.id, label: `Scanner: ${d.name}` }); if (!l.devices.length && l.note) toast(l.note, { ms: 5000 }); }
  if (caps.cameraIntent) opts.push({ value: 'camera-intent', label: 'Camera app (document camera)' });
  if (typeof navigator !== 'undefined' && navigator.mediaDevices) opts.push({ value: 'camera', label: 'Camera (in the app)' });
  const def = opts.find((o) => o.value === app.prefs.scanSource)?.value || opts[0]?.value || '';
  return { any: opts.length > 0, fields: [
    { key: 'source', label: 'Source', type: 'select', options: opts, value: def },
    { key: 'dpi', label: 'Resolution (dpi)', type: 'select', options: ['150', '200', '300', '400', '600'], value: '300', half: true, visibleIf: (v) => !/^camera/.test(v.source) },
    { key: 'mode', label: 'Color', type: 'select', options: [{ value: 'color', label: 'Color' }, { value: 'gray', label: 'Grayscale' }], value: 'color', half: true, visibleIf: (v) => !/^camera/.test(v.source) },
    { key: 'autoCrop', label: 'Find the page and flatten it (document camera)', type: 'checkbox', value: true, half: true },
    { key: 'deskew', label: 'Deskew', type: 'checkbox', value: true, half: true },
  ] };
}

// Import -------------------------------------------------------------------------------------------

export function expandImportName(pattern: string, o: { name: string; date: Date; n: number }): string {
  const base = o.name.replace(/\.[^.]+$/, ''), ext = (o.name.match(/\.[^.]+$/) || [''])[0];
  const p = (n: number) => String(n).padStart(2, '0'), d = o.date;
  const out = pattern.replace(/\{n(?::(\d))?\}/g, (_m, w) => String(o.n).padStart(+(w || 1), '0')).replace(/\{name\}/g, base).replace(/\{yyyy\}/g, String(d.getFullYear())).replace(/\{mm\}/g, p(d.getMonth() + 1)).replace(/\{dd\}/g, p(d.getDate())).replace(/\{hh\}/g, p(d.getHours())).replace(/\{min\}/g, p(d.getMinutes())).replace(/\{date\}/g, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`).replace(/\{ext\}/g, ext.slice(1));
  return /\.[^./]+$/.test(out) ? out : out + ext;
}
export interface ImportRule { name: string; subfolder: string; rename: string; skipDuplicates: boolean; deleteAfter: boolean }
const RULE_FIELDS = (r: Partial<ImportRule>): Field[] => [
  { key: 'subfolder', label: 'Dated subfolders in the destination', type: 'combo', options: ['', '{yyyy}', '{yyyy}/{yyyy}-{mm}', '{yyyy}/{date}', '{date}'], value: r.subfolder ?? '{yyyy}/{date}', help: 'Empty = straight into the destination. {yyyy} {mm} {dd} {date} from the file\'s date.' },
  { key: 'rename', label: 'Rename on import', type: 'combo', options: ['{name}', '{date} {name}', '{yyyy}{mm}{dd}_{hh}{min} {name}', '{date} {n:4}'], value: r.rename ?? '{name}', help: '{name} {n} {n:4} {date} {yyyy} {mm} {dd} {hh} {min}; the extension is kept.' },
  { key: 'skipDuplicates', label: 'Skip files already in the destination (same name and size, or same content)', type: 'checkbox', value: r.skipDuplicates ?? true },
  { key: 'deleteAfter', label: 'Delete from the source after a successful copy (asks first)', type: 'checkbox', value: r.deleteAfter ?? false },
];
async function runImport(app: App, rule: ImportRule): Promise<void> {
  const src = await pickFolder('Import from (the camera or phone folder, e.g. DCIM)'); if (!src) return;
  const dest = await pickFolder('Import into'); if (!dest) return;
  const listing = await listFolderOf(src.uri); if (!listing || !listing.entries.length) { toast('No pictures in that folder.'); return; }
  // What each target folder already holds (name and size), listed once per folder: duplicates are judged where the file would land.
  const listings = new Map<string, Set<string>>();
  const existingIn = async (dirUri: string): Promise<Set<string>> => { let s = listings.get(dirUri); if (!s) { s = new Set(); const l = await listFolderOf(dirUri, { all: true }).catch(() => null); for (const x of l?.entries || []) s.add(`${x.name.toLowerCase()}|${x.size || 0}`); listings.set(dirUri, s); } return s; };
  const hashes = new Map<string, true>();
  if (rule.deleteAfter && !(await confirmDialog('Delete after import?', `${listing.entries.length} files will be deleted from ${src.name} after they are copied. Continue?`, 'Import and delete'))) return;
  let done = 0, skipped = 0, failed = 0, n = 0, renamed = 0, kept = 0;
  const subfolders = new Map<string, string>();
  const t = toast; t(`Importing ${listing.entries.length} files…`, { ms: 2000 });
  for (const e of listing.entries) {
    try {
      const date = e.mtime ? new Date(e.mtime) : new Date();
      const f = await readUri(e.uri); if (!f) { failed++; continue; }
      if (rule.skipDuplicates) { const h = await sha(new Uint8Array(f.data), 'SHA-256'); if (hashes.has(h)) { skipped++; continue; } hashes.set(h, true); }
      let dir = dest.uri;
      if (rule.subfolder.trim()) {
        const rel = expandImportName(rule.subfolder.trim() + '.x', { name: 'x.x', date, n }).replace(/\.x$/, '');
        for (const part of rel.split('/').filter(Boolean)) { const key = `${dir}|${part}`; let u = subfolders.get(key); if (!u) { u = (await createSubfolder(dir, part)).uri; subfolders.set(key, u); } dir = u; }
      }
      const name = expandImportName(rule.rename.trim() || '{name}', { name: e.name, date, n: n + 1 });
      const there = await existingIn(dir);
      if (rule.skipDuplicates && (there.has(`${name.toLowerCase()}|${f.data.byteLength}`) || there.has(`${e.name.toLowerCase()}|${f.data.byteLength}`))) { skipped++; continue; }
      n++;
      // Never over a file already in the destination: a taken name gets " (2)". The source goes only after the copy reads back whole.
      const w = await writeIntoFolder(dir, name, f.data, 'rename');
      there.add(`${w.name.toLowerCase()}|${f.data.byteLength}`);
      if (w.name !== name) renamed++;
      if (rule.deleteAfter) {
        const back = await readUri(w.uri).catch(() => null);
        if (!back || back.data.byteLength !== f.data.byteLength) { kept++; done++; continue; } // the copy could not be verified: the source stays
        await deleteFile(e.uri, src.uri, true);
      }
      done++;
    } catch { failed++; }
  }
  toast(`Imported ${done} file${done === 1 ? '' : 's'} into ${dest.name}; ${skipped} skipped, ${failed} failed${renamed ? `; ${renamed} under a new name (a file of that name was there already)` : ''}${kept ? `; ${kept} left on the source because the copy could not be checked` : ''}.`, { ms: renamed || kept ? 12000 : 7000 });
  app.journal.push({ kind: 'copy', label: `Import ${done} files from ${src.name} to ${dest.name}`, when: Date.now(), noUndo: 'imported files stay in the destination' } as any);
}

def([
  {
    id: 'file.wallpaper', icon: 'wallpaper', kind: 'menu', noRecord: true, isEnabled: (app) => has(app) && caps.wallpaper, tip: 'Fill, fit, stretch, center or tile the picture on the screen',
    menu: () => MODES.map(([id, label]) => ({ id, arg: id, label })),
    run: (app, arg?: WallpaperMode) => applyWallpaper(app, arg || 'fill', 'home'),
  },
  { id: 'file.lockScreen', icon: 'lock', noRecord: true, isEnabled: (app) => has(app) && caps.lockScreen, tip: 'The picture as the lock-screen wallpaper (Android; GNOME on Linux)', run: (app) => applyWallpaper(app, 'fill', 'lock') },
  {
    id: 'file.contactPhoto', icon: 'account_circle', noRecord: true, isEnabled: (app) => has(app) && caps.contactPhoto, tip: 'Hands the picture to the Contacts app (Android "Set as")',
    run: async (app) => { const blob = await encodeCanvas(app.picture!.frameCanvas(), 'png'); await attachData(app.picture!.name.replace(/\.[^.]+$/, '') + '.png', 'image/png', await blob.arrayBuffer()); },
  },
  {
    id: 'file.cast', icon: 'cast', noRecord: true, isEnabled: () => caps.cast, tip: 'Opens the system Cast picker; the picture is then shown full screen on the mirrored display',
    run: async (app) => { const r = await openCastSettings(); if (r.ok) { toast('Choose a display, then come back: the picture goes full screen.', { ms: 6000 }); if (app.picture) app.exec('view.fullScreen'); } },
  },
  {
    id: 'file.sysProperties', icon: 'info', noRecord: true, isEnabled: has, tip: 'The operating system\'s properties window (Windows, macOS) or the file\'s system facts',
    run: async (app) => {
      const e = app.picture!.entry;
      let info: Record<string, string> = { Name: e.name, Size: e.size ? `${fmtSize(e.size)} (${e.size.toLocaleString()} bytes)` : '—', Modified: e.mtime ? new Date(e.mtime).toLocaleString() : '—', Address: e.uri || 'in memory' };
      if (isDesktop() && e.uri) {
        try { const r = await showProperties(e.uri); if (r.opened) { toast('The system properties window is open.'); return; } info = { ...info, Path: r.path, Created: new Date(r.ctime).toLocaleString(), Permissions: r.mode, System: r.os }; }
        catch (err) { toast(String((err as Error).message)); }
      }
      await openDialog({ title: 'File Properties (system)', ok: 'Close', cancel: false, fields: Object.entries(info).map(([k, v]) => ({ key: k, label: k, type: 'info' as const, html: `<b>${k}:</b> ${String(v).replace(/</g, '&lt;')}` })) });
    },
  },
  {
    id: 'file.copyAsFile', icon: 'file_copy', noRecord: true, isEnabled: (app) => has(app) && caps.copyAsFile, tip: 'The file itself on the clipboard, for pasting in a file manager (desktop: the file; Android: a content link to a copy)',
    run: async (app) => {
      const p = app.picture!;
      if (isDesktop() && p.entry.uri) { const r = await copyFileToClipboard({ uri: p.entry.uri, name: p.name, mime: '' }); toast(r.ok ? `File copied (${(r as any).how}).` : 'Could not copy the file.'); return; }
      const data = p.bytes.buffer.slice(p.bytes.byteOffset, p.bytes.byteOffset + p.bytes.byteLength) as ArrayBuffer;
      const r = await copyFileToClipboard({ uri: null, name: p.name, mime: p.format.mime || 'application/octet-stream', data });
      toast(r.ok ? 'A link to a copy of the file is on the clipboard.' : 'Could not copy the file.');
    },
  },
  {
    id: 'file.hide', icon: 'visibility_off', kind: 'menu', noRecord: true, isEnabled: (app) => has(app) || app.prefs.hiddenFiles.some((k) => k.startsWith(`${app.folder.uri || app.folder.name}|`)), tip: 'Hides the picture from this folder in Anne\'s Lens (the file is not changed); Unhide brings them back',
    menu: (app) => { const key = `${app.folder.uri || app.folder.name}|`; const n = app.prefs.hiddenFiles.filter((k) => k.startsWith(key)).length; return [{ id: 'hide', arg: 'hide', label: app.picture ? `Hide ${app.picture.name}` : 'Hide this picture' }, { id: 'unhide', arg: 'unhide', label: n ? `Unhide ${n} hidden picture${n === 1 ? '' : 's'} here` : 'Nothing hidden here' }]; },
    run: async (app, arg?: string) => {
      const folder = app.folder, key = `${folder.uri || folder.name}|`;
      if (arg === 'unhide') {
        const before = app.prefs.hiddenFiles.length;
        app.prefs.hiddenFiles = app.prefs.hiddenFiles.filter((k) => !k.startsWith(key)); app.savePrefs();
        const n = before - app.prefs.hiddenFiles.length;
        if (n && folder.uri) { const l = await listFolderOf(folder.uri); if (l) { const cur = folder.current?.name; folder.entries = l.entries.map(entryFromUri); folder.select(Math.max(0, folder.entries.findIndex((e) => e.name === cur))); app.tab.thumbs?.refilter(); app.refresh(); } }
        toast(n ? `${n} picture${n === 1 ? '' : 's'} unhidden${folder.uri ? '' : ' (open the folder again to see them)'}.` : 'Nothing was hidden here.'); return;
      }
      const p = app.picture; if (!p) return;
      app.prefs.hiddenFiles = [...new Set([...app.prefs.hiddenFiles, key + p.name])].slice(-5000); app.savePrefs();
      const i = folder.entries.indexOf(p.entry); app.tab.marked.delete(p.entry);
      folder.entries = folder.entries.filter((e) => e !== p.entry);
      if (folder.entries.length) folder.select(Math.min(i, folder.entries.length - 1)); else folder.select(0);
      app.tab.thumbs?.refilter(); app.refresh();
      toast(`${p.name} hidden (Hide Picture ▸ Unhide brings it back).`);
    },
  },
  {
    id: 'file.associations', icon: 'extension', noRecord: true, isEnabled: () => caps.associations, tip: 'Desktop: register picture types with Anne\'s Lens (Linux: xdg-mime; Windows: the Default apps page; macOS: Finder instructions). Android: the Default apps settings.',
    run: async () => {
      if (!isDesktop()) { const r = await setAssociations([]); toast(r.ok ? 'Choose Anne\'s Lens under Default apps ▸ Opening links or in each file type\'s settings.' : 'Not available.', { ms: 7000 }); return; }
      const types = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'heic', 'bmp', 'tif', 'tiff', 'svg', 'ico', 'jxl', 'psd', 'tga', 'pdf'];
      const r = await openDialog({ title: 'File Associations', ok: 'Register', help: platformName() === 'linux' ? 'Sets Anne\'s Lens as the default opener for the ticked types (xdg-mime).' : platformName() === 'windows' ? 'The installer registered these types; Windows asks you to confirm the default app on its Default apps page, which opens next.' : 'macOS keeps this in the Finder: select a file, Get Info, Open with ▸ Anne\'s Lens, Change All…', fields: types.map((t) => ({ key: t, label: t.toUpperCase(), type: 'checkbox' as const, value: !['pdf', 'psd', 'svg'].includes(t), half: true })) });
      if (!r) return;
      const res = await setAssociations(types.filter((t) => r[t]));
      toast(res.ok ? `Registered${res.done.length ? `: ${res.done.join(', ')}` : ''} (${res.how}).` : `${res.how}${res.failed.length ? ` — not set: ${res.failed.join(', ')}` : ''}`, { ms: 8000 });
    },
  },
  {
    id: 'file.scan', icon: 'scanner', noRecord: true, popular: true, isEnabled: () => caps.scanner || caps.cameraIntent || !!navigator.mediaDevices, tip: 'A page from a scanner (SANE on Linux, WIA on Windows) or the document camera; the page found and flattened, deskewed',
    run: async (app) => {
      const sf = await sourceFields(app); if (!sf.any) { toast('No scanner or camera is available here.'); return; }
      const v = await openDialog({ title: 'Scan', ok: 'Scan', fields: sf.fields }); if (!v) return;
      let r: Raster | null;
      try { r = await acquirePage(app, v.source, +v.dpi, v.mode); } catch (e) { toast(`Scan failed: ${(e as Error).message}`, { ms: 8000 }); return; }
      if (!r) return;
      r = tidyScan(r, { autoCrop: !!v.autoCrop, deskew: !!v.deskew });
      const blob = await encodeCanvas(rasterFrame(r, 0).image as HTMLCanvasElement, 'png');
      await app.openFolder(new Folder([entryFromBytes(`Scan ${stamp()}.png`, await blob.arrayBuffer())], 'Scans'), 0, { newWindow: true });
    },
  },
  {
    id: 'file.selectSource', icon: 'settings_input_component', noRecord: true, isEnabled: () => caps.scanner, tip: 'The scanner Scan… uses by default',
    run: async (app) => {
      const l = await listScanners();
      if (!l.devices.length) { toast(l.note || 'No scanner found.'); return; }
      const v = await openDialog({ title: 'Select Scan Source', ok: 'Use', fields: [{ key: 'd', label: 'Scanner', type: 'select', options: [{ value: '', label: 'Ask each time' }, ...l.devices.map((d) => ({ value: d.id, label: d.name }))], value: app.prefs.scanSource }] });
      if (!v) return; app.prefs.scanSource = v.d; app.savePrefs();
    },
  },
  {
    id: 'file.batchScan', icon: 'document_scanner', noRecord: true, isEnabled: () => caps.scanner || caps.cameraIntent || !!navigator.mediaDevices, tip: 'Page after page: name pattern, format, auto-crop and deskew; separate files, or one multipage TIFF or PDF',
    run: async (app) => {
      const sf = await sourceFields(app); if (!sf.any) { toast('No scanner or camera is available here.'); return; }
      const v = await openDialog({ title: 'Batch Scanning', ok: 'Start', wide: true, fields: [...sf.fields,
        { key: 'pattern', label: 'Name pattern', type: 'text', value: 'Scan {date} {n:3}', half: true, help: '{n} {n:3} {date} {yyyy} {mm} {dd} {hh} {min}' },
        { key: 'output', label: 'Output', type: 'select', options: [{ value: 'png', label: 'Separate PNG files' }, { value: 'jpeg', label: 'Separate JPEG files' }, { value: 'tiff', label: 'One multipage TIFF' }, { value: 'pdf', label: 'One PDF' }], value: 'pdf', half: true },
      ] });
      if (!v) return;
      const pages: Raster[] = []; const date = new Date();
      for (;;) {
        let r: Raster | null;
        try { r = await acquirePage(app, v.source, +v.dpi, v.mode); } catch (e) { toast(`Scan failed: ${(e as Error).message}`, { ms: 8000 }); break; }
        if (!r) break;
        pages.push(tidyScan(r, { autoCrop: !!v.autoCrop, deskew: !!v.deskew }));
        if (!(await confirmDialog(`Page ${pages.length} scanned`, 'Put the next page in and continue, or finish.', 'Scan next page', 'Finish'))) break;
      }
      if (!pages.length) return;
      const base = expandImportName(String(v.pattern || 'Scan {n:3}') + '.x', { name: 'x.x', date, n: 1 }).replace(/\.x$/, '').replace(/ ?0*1$/, '').trim() || 'Scan';
      if (v.output === 'tiff' || v.output === 'pdf') {
        let bytes: Uint8Array;
        if (v.output === 'tiff') bytes = encodeTiff(pages.map((p) => ({ raster: p, dpi: +v.dpi || 300 })));
        else { const pdfPages = []; for (const p of pages) { const jpg = new Uint8Array(await (await encodeCanvas(rasterFrame(p, 0).image as HTMLCanvasElement, 'jpeg', 0.9)).arrayBuffer()); const dpi = +v.dpi || 300; pdfPages.push({ image: jpg, width: p.width, height: p.height, pageWidth: p.width * 72 / dpi, pageHeight: p.height * 72 / dpi }); } bytes = makePdf(pdfPages, { title: base }); }
        const saved = await saveAs(new Blob([bytes as BlobPart], { type: v.output === 'tiff' ? 'image/tiff' : 'application/pdf' }), `${base}.${v.output === 'tiff' ? 'tif' : 'pdf'}`);
        toast(saved ? `${pages.length} pages saved as ${saved.name}.` : 'Not saved.'); return;
      }
      const entries: Entry[] = [];
      for (let i = 0; i < pages.length; i++) { const name = expandImportName(String(v.pattern || 'Scan {n:3}') + '.' + (v.output === 'jpeg' ? 'jpg' : 'png'), { name: 'x.x', date, n: i + 1 }); const blob = await encodeCanvas(rasterFrame(pages[i], 0).image as HTMLCanvasElement, v.output === 'jpeg' ? 'jpeg' : 'png', 0.9); entries.push(entryFromBytes(name, await blob.arrayBuffer())); }
      await app.openFolder(new Folder(entries, 'Scans'), 0, { newWindow: true });
      toast(`${entries.length} pages scanned; Save All or Batch Convert writes them where you want.`);
    },
  },
  {
    id: 'file.importCamera', icon: 'add_a_photo', noRecord: true, isEnabled: () => caps.subfolders, tip: 'From a camera card or a phone folder: skip duplicates, rename, dated folders, delete after import (asks)',
    run: async (app) => {
      const v = await openDialog({ title: 'Import from Camera or Phone', ok: 'Choose folders…', wide: true, help: 'First the source folder (the card or the phone\'s DCIM, which Android shows through its file picker), then the destination.', fields: [...RULE_FIELDS({}), { key: 'saveAs', label: 'Save these settings as a rule named', type: 'text', value: '', half: true }] });
      if (!v) return;
      const rule: ImportRule = { name: String(v.saveAs || '').trim(), subfolder: v.subfolder, rename: v.rename, skipDuplicates: !!v.skipDuplicates, deleteAfter: !!v.deleteAfter };
      if (rule.name) { app.prefs.importRules = [...app.prefs.importRules.filter((r) => r.name !== rule.name), rule].slice(0, 40); app.savePrefs(); }
      await runImport(app, rule);
    },
  },
  {
    id: 'file.importRules', icon: 'rule', kind: 'menu', noRecord: true, isEnabled: () => caps.subfolders, tip: 'Saved import presets: folder pattern, rename pattern, duplicates, delete after',
    menu: (app) => [...app.prefs.importRules.map((r) => ({ id: r.name, arg: r.name, label: r.name })), { id: '__edit', arg: '__edit', label: 'Edit rules…' }],
    run: async (app, arg?: string) => {
      if (arg && arg !== '__edit') { const rule = app.prefs.importRules.find((r) => r.name === arg); if (rule) await runImport(app, rule); return; }
      const rules = app.prefs.importRules;
      const v = await openDialog({ title: 'Import with Rules', ok: 'Close', cancel: false, wide: true, fields: [
        { key: 'pick', label: 'Rule', type: 'select', options: [{ value: '', label: rules.length ? 'Choose a rule' : 'No rules yet' }, ...rules.map((r) => ({ value: r.name, label: r.name }))], value: '' },
        { key: 'name', label: 'Name', type: 'text', value: '' }, ...RULE_FIELDS({}),
        { key: 'save', label: 'Save rule', type: 'button', half: true, onClick: (x, ctl) => { const name = String(x.name || '').trim(); if (!name) { toast('Enter a name.'); return; } app.prefs.importRules = [...rules.filter((r) => r.name !== name), { name, subfolder: x.subfolder, rename: x.rename, skipDuplicates: !!x.skipDuplicates, deleteAfter: !!x.deleteAfter }].slice(0, 40); app.savePrefs(); toast(`Rule "${name}" saved.`); ctl.close(); app.exec('file.importRules', '__edit'); } },
        { key: 'run', label: 'Run this rule…', type: 'button', half: true, onClick: (x, ctl) => { ctl.close(); runImport(app, { name: String(x.name || ''), subfolder: x.subfolder, rename: x.rename, skipDuplicates: !!x.skipDuplicates, deleteAfter: !!x.deleteAfter }); } },
        { key: 'del', label: 'Delete rule', type: 'button', half: true, onClick: (x, ctl) => { app.prefs.importRules = rules.filter((r) => r.name !== x.pick); app.savePrefs(); ctl.close(); app.exec('file.importRules', '__edit'); } },
      ], onChange: (x, ctl, key) => { if (key !== 'pick') return; const r = rules.find((q) => q.name === x.pick); if (!r) return; ctl.set('name', r.name); ctl.set('subfolder', r.subfolder); ctl.set('rename', r.rename); ctl.set('skipDuplicates', r.skipDuplicates); ctl.set('deleteAfter', r.deleteAfter); } });
      void v;
    },
  },
]);
void editRaster; void dirUriOf;
