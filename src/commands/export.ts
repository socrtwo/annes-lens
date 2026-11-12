/**
 * Export commands (M2): Export Palette, Export Metadata as CSV, Export as Icon, Export Animation, and
 * Open with External Editor (desktop, up to nine programs).
 */
import { def } from './registry';
import type { App } from '../app';
import { openDialog, toast, promptDialog } from '../ui/dialog';
import { medianCut, mapToPalette, encodePalette, type PaletteFormat } from '../codecs/palette';
import { encodeGif } from '../codecs/gifenc';
import { encodePng, encodeApng, encodeIco, encodeIcns } from '../codecs/pngenc';
import { saveAs, isDesktop, desktopBridge } from '../platform/native';
import { sniff } from '../codecs/registry';
import { jpegInfo, pngInfo, webpInfo } from '../codecs/info';
import { readExif } from '../meta/exif';
import { fmtSize } from '../ui/shell';
import type { Raster } from '../codecs/raster';
import { csvCell } from './meta';

const rasterOf = (c: HTMLCanvasElement): Raster => { const id = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height); return { width: c.width, height: c.height, data: id.data as Uint8ClampedArray<ArrayBuffer> }; };
/** The canvas an exported animation needs: the largest width and height among its frames. */
export function animationCanvas(frames: { width: number; height: number }[]): { width: number; height: number } {
  return { width: Math.max(1, ...frames.map((f) => f.width)), height: Math.max(1, ...frames.map((f) => f.height)) };
}
const base = (name: string) => name.replace(/\.[^.]+$/, '') || 'picture';

def([
  {
    id: 'file.export.palette', icon: 'palette', noRecord: true, isEnabled: (app) => !!app.picture,
    tip: 'The picture\'s colors as a GIMP, Adobe, JASC or Photoshop palette or CSS variables',
    run: async (app) => {
      const pic = app.picture!;
      const r = await openDialog({ title: 'Export Palette', ok: 'Save…', fields: [
        { key: 'n', label: 'Colors', type: 'number', min: 2, max: 256, value: 16, half: true },
        { key: 'format', label: 'Format', type: 'select', options: [{ value: 'gpl', label: 'GIMP palette (.gpl)' }, { value: 'act', label: 'Adobe color table (.act)' }, { value: 'pal', label: 'JASC / Paint Shop Pro (.pal)' }, { value: 'aco', label: 'Photoshop swatches (.aco)' }, { value: 'css', label: 'CSS custom properties (.css)' }, { value: 'txt', label: 'Hex list (.txt)' }], value: 'gpl', half: true },
        { key: 'sort', label: 'Order', type: 'select', options: [{ value: 'lum', label: 'Dark to light' }, { value: 'hue', label: 'By hue' }, { value: 'none', label: 'As found' }], value: 'lum' },
      ] });
      if (!r) return;
      const pal = medianCut(rasterOf(pic.frameCanvas()).data, Math.max(2, Math.min(256, +r.n || 16)));
      if (r.sort === 'lum') pal.colors.sort((a, b) => (0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]) - (0.2126 * b[0] + 0.7152 * b[1] + 0.0722 * b[2]));
      else if (r.sort === 'hue') { const hue = (c: number[]) => { const [x, y, z] = c.map((v) => v / 255); const mx = Math.max(x, y, z), mn = Math.min(x, y, z); if (mx === mn) return -1; const d = mx - mn; return mx === x ? ((y - z) / d + 6) % 6 : mx === y ? (z - x) / d + 2 : (x - y) / d + 4; }; pal.colors.sort((a, b) => hue(a) - hue(b)); }
      const out = encodePalette(pal, r.format as PaletteFormat, base(pic.name));
      const saved = await saveAs(new Blob([out.bytes as BlobPart], { type: out.mime }), `${base(pic.name)}.${out.ext}`);
      if (saved) toast(`${pal.colors.length} colors saved to ${saved.name}`);
    },
  },
  {
    id: 'file.export.metadataCsv', icon: 'table', noRecord: true, isEnabled: (app) => !!app.tab.folder.length,
    tip: 'Name, size, dimensions, camera, exposure, date taken and location of every picture in the folder',
    run: async (app) => {
      const entries = app.tab.folder.entries;
      const limit = 2000;
      const rows: string[][] = [['File', 'Size (bytes)', 'Modified', 'Format', 'Width', 'Height', 'Date taken', 'Make', 'Model', 'Lens', 'Exposure', 'Latitude', 'Longitude', 'Software', 'Description', 'Copyright']];
      toast(`Reading ${Math.min(entries.length, limit)} files…`, { ms: 3000 });
      for (const e of entries.slice(0, limit)) {
        try {
          const u8 = new Uint8Array(await e.read());
          const fmt = sniff(u8, e.name);
          const info = fmt?.id === 'jpeg' ? jpegInfo(u8) : fmt?.id === 'png' || fmt?.id === 'apng' ? pngInfo(u8) : fmt?.id === 'webp' ? webpInfo(u8) : null;
          let w = info?.width, hgt = info?.height;
          if (!w && app.picture?.entry === e) { w = app.picture.width; hgt = app.picture.height; }
          const x = readExif(u8);
          rows.push([e.name, String(u8.length), e.mtime ? new Date(e.mtime).toISOString() : '', fmt?.label || '', w ? String(w) : '', hgt ? String(hgt) : '', x?.dateTaken || '', x?.make || '', x?.model || '', x?.lens || '', x?.exposure || '', x?.gps ? x.gps.lat.toFixed(6) : '', x?.gps ? x.gps.lon.toFixed(6) : '', x?.software || '', x?.description || '', x?.copyright || '']);
        } catch { rows.push([e.name, '', '', 'unreadable']); }
      }
      const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'; // csvCell also keeps a spreadsheet from running a value as a formula
      const saved = await saveAs(new Blob(['﻿' + csv], { type: 'text/csv' }), `${app.tab.folder.name || 'pictures'}-metadata.csv`);
      if (saved) toast(`${rows.length - 1} rows saved to ${saved.name}`);
    },
  },
  {
    id: 'file.export.icon', icon: 'apps', noRecord: true, isEnabled: (app) => !!app.picture,
    tip: 'Windows .ico or Apple .icns with several sizes from this picture',
    run: async (app) => {
      const pic = app.picture!;
      const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
      const r = await openDialog({ title: 'Export as Icon', ok: 'Save…', fields: [
        { key: 'kind', label: 'File', type: 'radio', options: [{ value: 'ico', label: 'Windows icon (.ico, up to 256 px)' }, { value: 'icns', label: 'Apple icon (.icns, 16–1024 px)' }], value: 'ico' },
        ...sizes.map((s) => ({ key: `s${s}`, label: `${s} × ${s}`, type: 'checkbox' as const, value: [16, 32, 48, 256].includes(s), half: true })),
        { key: 'square', label: 'Crop to a centered square (otherwise pad with transparency)', type: 'checkbox', value: false },
      ] });
      if (!r) return;
      const chosen = sizes.filter((s) => r[`s${s}`] && (r.kind === 'icns' ? s >= 16 && ![24, 48].includes(s) : s <= 256));
      if (!chosen.length) { toast('Choose at least one size.'); return; }
      const src = pic.frameCanvas();
      const entries: { size: number; png: Uint8Array }[] = [];
      for (const size of chosen) {
        const c = document.createElement('canvas'); c.width = size; c.height = size;
        const x = c.getContext('2d')!; x.imageSmoothingQuality = 'high';
        const s = Math.min(src.width, src.height);
        if (r.square) x.drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, 0, 0, size, size);
        else { const k = Math.min(size / src.width, size / src.height); const w = src.width * k, hh = src.height * k; x.drawImage(src, (size - w) / 2, (size - hh) / 2, w, hh); }
        entries.push({ size, png: await encodePng(rasterOf(c)) });
      }
      const bytes = r.kind === 'ico' ? encodeIco(entries) : encodeIcns(entries);
      const saved = await saveAs(new Blob([bytes as BlobPart], { type: r.kind === 'ico' ? 'image/x-icon' : 'image/icns' }), `${base(pic.name)}.${r.kind}`);
      if (saved) toast(`Saved ${saved.name} (${entries.length} sizes, ${fmtSize(bytes.length)})`);
    },
  },
  {
    id: 'file.export.animation', icon: 'animation', noRecord: true, isEnabled: (app) => !!app.picture,
    tip: 'The frames (or pages) of this picture as an animated GIF or APNG',
    run: async (app) => {
      const pic = app.picture!;
      const frames = pic.animated ? pic.current.frames : pic.pages.map((p) => p.frames[0]);
      const r = await openDialog({ title: 'Export Animation', ok: 'Save…', help: `${frames.length} frame${frames.length > 1 ? 's' : ''} from ${pic.animated ? 'the animation' : pic.multipage ? 'the pages' : 'the picture'}.`, fields: [
        { key: 'format', label: 'Format', type: 'radio', options: [{ value: 'gif', label: 'GIF (256 colors)' }, { value: 'apng', label: 'APNG (full color, transparency)' }], value: 'gif' },
        { key: 'delay', label: 'Frame delay (ms, 0 = keep each frame\'s own)', type: 'number', min: 0, max: 60000, value: pic.animated ? 0 : 500, half: true },
        { key: 'loops', label: 'Loops (0 = forever)', type: 'number', min: 0, max: 65535, value: pic.animated ? pic.current.loops : 0, half: true },
        { key: 'maxSide', label: 'Longest side (pixels, 0 = keep)', type: 'number', min: 0, max: 8192, value: 0, half: true },
      ] });
      if (!r) return;
      const max = +r.maxSide || 0;
      // GIF and APNG frames share one canvas: pages of different sizes are centered on the largest, on transparency, all at one scale (W23).
      const { width: W0, height: H0 } = animationCanvas(frames);
      const k = max ? Math.min(1, max / Math.max(W0, H0)) : 1, W = Math.max(1, Math.round(W0 * k)), H = Math.max(1, Math.round(H0 * k));
      const rasters = frames.map((f) => {
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const w = Math.max(1, Math.round(f.width * k)), hh = Math.max(1, Math.round(f.height * k));
        const x = c.getContext('2d')!; x.imageSmoothingQuality = 'high'; x.drawImage(f.image as CanvasImageSource, Math.floor((W - w) / 2), Math.floor((H - hh) / 2), w, hh);
        return { raster: rasterOf(c), delay: +r.delay > 0 ? +r.delay : f.delay || 100 };
      });
      toast('Encoding…', { ms: 2000 });
      let bytes: Uint8Array, ext: string, mime: string;
      if (r.format === 'apng') { bytes = await encodeApng(rasters, +r.loops || 0); ext = 'png'; mime = 'image/png'; }
      else {
        const all = new Uint8ClampedArray(rasters.reduce((s, f) => s + f.raster.data.length, 0));
        let o = 0; for (const f of rasters) { all.set(f.raster.data, o); o += f.raster.data.length; }
        let transparent = false; for (let i = 3; i < all.length; i += 4) if (all[i] < 128) { transparent = true; break; }
        const pal = medianCut(all, transparent ? 255 : 256);
        const tIndex = transparent ? pal.colors.length : undefined;
        bytes = encodeGif(rasters[0].raster.width, rasters[0].raster.height, pal, rasters.map((f) => ({ indexes: mapToPalette(f.raster.data, pal, tIndex ?? -1), delay: f.delay })), { loops: +r.loops || 0, transparent: tIndex });
        ext = 'gif'; mime = 'image/gif';
      }
      const saved = await saveAs(new Blob([bytes as BlobPart], { type: mime }), `${base(pic.name)}.${ext}`);
      if (saved) toast(`Saved ${saved.name} (${rasters.length} frames, ${fmtSize(bytes.length)})`);
    },
  },
  {
    id: 'file.openExternal', icon: 'edit_note', kind: 'menu', noRecord: true, isEnabled: (app) => isDesktop() && !!app.picture?.entry.uri,
    tip: 'Opens the file in one of up to nine programs you choose (Shift+E: the first)',
    menu: (app) => [
      ...app.prefs.externalEditors.map((e, i) => ({ id: 'file.openExternal', arg: i + 1, label: `${i + 1}  ${e.name}` })),
      ...(app.prefs.externalEditors.length ? [{ separator: true }] : []),
      { id: 'file.openExternal', arg: 'add', label: 'Add a Program…', icon: 'add' },
      ...(app.prefs.externalEditors.length ? [{ id: 'file.openExternal', arg: 'manage', label: 'Remove Programs…', icon: 'delete' }] : []),
    ],
    run: async (app, arg?: number | string) => {
      const d = desktopBridge();
      if (!d) return;
      const list = app.prefs.externalEditors;
      if (arg === 'add' || (arg === undefined && !list.length)) {
        const r = await d.pickProgram();
        if (r.canceled || !r.path) return;
        const name = await promptDialog('Add a Program', 'Name in the menu', r.name || r.path);
        if (name === null) return;
        if (list.length >= 9) list.pop();
        list.push({ name: name.trim() || r.name || r.path, path: r.path });
        app.savePrefs();
        toast(`${list[list.length - 1].name} added as editor ${list.length}`);
        if (arg !== 'add') arg = list.length;
        else return;
      }
      if (arg === 'manage') {
        const r = await openDialog({ title: 'External Editors', ok: 'Remove Checked', fields: list.map((e, i) => ({ key: `e${i}`, label: `${i + 1}: ${e.name} (${e.path})`, type: 'checkbox' as const, value: false })) });
        if (!r) return;
        app.prefs.externalEditors = list.filter((_, i) => !r[`e${i}`]);
        app.savePrefs();
        return;
      }
      const n = typeof arg === 'number' ? arg : 1;
      const ed = list[n - 1];
      if (!ed) { toast(`No editor ${n} is set up; choose one from the menu.`); return; }
      const uri = app.picture!.entry.uri!;
      const res = await d.openWithProgram({ uri, program: ed.path });
      if (!res.ok) toast(res.error || `Could not start ${ed.name}`);
    },
  },
]);

export type { App };
