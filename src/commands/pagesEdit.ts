/**
 * Pages and Frames, editing: Insert Pages (other pictures become pages), Delete Page, Extract Pages
 * (to a ZIP or a new window), Reorder Pages; Frame Editor (order, delete, duplicate, per-frame
 * delay), Reverse Frames, Loop Count, Optimize Animation (merges identical consecutive frames).
 * RAW: Show Embedded Preview (pick one of the JPEGs inside), Extract Embedded Preview (the camera's
 * JPEG as is), Use Embedded Preview by Default.
 */
import { def } from './registry';
import type { App } from '../app';
import { openDialog, toast, confirmDialog } from '../ui/dialog';
import type { Field } from '../ui/dialog';
import type { Page, Frame } from '../picture/model';
import { Folder, entryFromBytes } from '../picture/folder';
import { decodePicture, encodeCanvas } from '../codecs/registry';
import { findEmbeddedJpegs } from '../codecs/rawpreview';
import { rawSupport } from '../raw/families';
import type { DevelopOptions } from '../raw/develop';
import { editRaster } from '../picture/edit';
import { writeZip } from '../picture/batch';
import { openDocuments, saveAs } from '../platform/native';
import { fmtSize } from '../ui/shell';

const hasPages = (app: App) => !!app.picture && app.picture.pages.length > 1;
const hasFrames = (app: App) => !!app.picture && app.picture.animated;
const isRaw = (app: App) => !!app.picture && app.picture.format.id === 'raw';
let lastDevelop: DevelopOptions = {};
const base = (n: string) => n.replace(/\.[^.]+$/, '');

/** Pure helpers on frame lists (tested). */
export function reverseFrames(frames: Frame[]): Frame[] { return [...frames].reverse(); }
/** Merges runs of identical frames (same pixels) into one frame whose delay is the sum. */
export function mergeIdenticalFrames(frames: Frame[], same: (a: Frame, b: Frame) => boolean): Frame[] {
  const out: Frame[] = [];
  for (const f of frames) { const last = out[out.length - 1]; if (last && same(last, f)) out[out.length - 1] = { ...last, delay: last.delay + f.delay }; else out.push({ ...f }); }
  return out;
}
export function reorder<T>(items: T[], order: number[]): T[] { return order.filter((i) => i >= 0 && i < items.length).map((i) => items[i]); }

const frameCanvas = (f: Frame): HTMLCanvasElement => { if (f.image instanceof HTMLCanvasElement) return f.image; const c = document.createElement('canvas'); c.width = f.width; c.height = f.height; c.getContext('2d')!.drawImage(f.image as CanvasImageSource, 0, 0); return c; };
const samePixels = (a: Frame, b: Frame): boolean => { if (a.width !== b.width || a.height !== b.height) return false; const da = frameCanvas(a).getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, a.width, a.height).data, db = frameCanvas(b).getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, b.width, b.height).data; for (let i = 0; i < da.length; i++) if (da[i] !== db[i]) return false; return true; };
const thumbOf = (f: Frame, max = 64): HTMLCanvasElement => { const c = document.createElement('canvas'); const k = Math.min(1, max / Math.max(f.width, f.height)); c.width = Math.max(1, Math.round(f.width * k)); c.height = Math.max(1, Math.round(f.height * k)); c.getContext('2d')!.drawImage(f.image as CanvasImageSource, 0, 0, c.width, c.height); return c; };

/** A list dialog for ordering items; returns the new order (indexes into the original list) or null. */
async function orderDialog(title: string, labels: string[], extra: Field[] = [], help?: string): Promise<{ order: number[]; values: Record<string, any> } | null> {
  let order = labels.map((_, i) => i);
  const opts = () => order.map((i, pos) => ({ value: String(pos), label: `${pos + 1}. ${labels[i]}` }));
  const r = await openDialog({ title, ok: 'Apply', help, fields: [
    { key: 'items', label: 'Order', type: 'list', options: opts(), rows: 8 },
    { key: 'up', label: 'Move up', type: 'button', half: true, onClick: (v, ctl) => { const p = +v.items; if (!(p > 0)) return; [order[p - 1], order[p]] = [order[p], order[p - 1]]; ctl.set('items', opts()); ctl.set('items', String(p - 1)); } },
    { key: 'down', label: 'Move down', type: 'button', half: true, onClick: (v, ctl) => { const p = +v.items; if (!(p >= 0 && p < order.length - 1)) return; [order[p + 1], order[p]] = [order[p], order[p + 1]]; ctl.set('items', opts()); ctl.set('items', String(p + 1)); } },
    { key: 'first', label: 'Move to the start', type: 'button', half: true, onClick: (v, ctl) => { const p = +v.items; if (!(p > 0)) return; const [x] = order.splice(p, 1); order.unshift(x); ctl.set('items', opts()); ctl.set('items', '0'); } },
    { key: 'reverse', label: 'Reverse all', type: 'button', half: true, onClick: (_v, ctl) => { order = order.reverse(); ctl.set('items', opts()); } },
    ...extra,
  ] });
  return r ? { order, values: r } : null;
}

def([
  // Pages ------------------------------------------------------------------------------------------
  {
    id: 'pages.insert', icon: 'note_add', edits: true, isEnabled: (app) => !!app.picture, tip: 'Other pictures become pages after the current one (TIFF, PDF and ICO output keep them)',
    run: async (app) => {
      const files = await openDocuments('image/*', ['image/*'], true);
      if (!files.length) return;
      const pages: Page[] = [];
      for (const f of files) { try { const pic = await decodePicture(new Uint8Array(f.data), entryFromBytes(f.name, f.data)); pages.push(...pic.pages.map((p) => ({ ...p, frames: p.frames.map((fr) => ({ ...fr, image: frameCanvas(fr) })) }))); } catch (e: any) { toast(`${f.name}: ${e?.message || e}`); } }
      if (!pages.length) return;
      app.edit(`Insert ${pages.length} page${pages.length === 1 ? '' : 's'}`, (p) => { p.pages = [...p.pages.slice(0, p.page + 1), ...pages, ...p.pages.slice(p.page + 1)]; });
      toast(`${pages.length} page${pages.length === 1 ? '' : 's'} inserted; the picture now has ${app.picture!.pages.length}. Save as TIFF or PDF to keep them.`);
    },
  },
  { id: 'pages.delete', icon: 'delete_sweep', edits: true, isEnabled: hasPages, tip: 'Removes the current page', run: (app) => { const n = app.picture!.page + 1; app.edit(`Delete page ${n}`, (p) => { p.pages = p.pages.filter((_, i) => i !== p.page); p.page = Math.min(p.page, p.pages.length - 1); p.frame = 0; }); app.viewer.pictureChanged(); } },
  {
    id: 'pages.extract', icon: 'file_present', noRecord: true, isEnabled: hasPages, tip: 'Chosen pages as separate pictures: a ZIP, or a new window',
    run: async (app) => {
      const pic = app.picture!;
      const r = await openDialog({ title: 'Extract Pages', ok: 'Extract', fields: [{ key: 'pages', label: 'Pages', type: 'list', multiple: true, options: pic.pages.map((pg, i) => ({ value: String(i), label: `Page ${i + 1} (${pg.width}×${pg.height})` })), value: pic.pages.map((_, i) => String(i)), rows: 8 }, { key: 'to', label: 'To', type: 'select', options: [{ value: 'window', label: 'A new window (pictures in memory)' }, { value: 'zip', label: 'A ZIP file' }], value: 'window', half: true }, { key: 'format', label: 'Format', type: 'select', options: [{ value: 'png', label: 'PNG' }, { value: 'jpeg', label: 'JPEG' }], value: 'png', half: true }] });
      if (!r) return;
      const idx = (r.pages as string[]).map(Number); if (!idx.length) return;
      const files: { name: string; data: Uint8Array }[] = [];
      for (const i of idx) { const f = pic.pages[i].frames[0]; const blob = await encodeCanvas(frameCanvas(f), r.format, 0.92); files.push({ name: `${base(pic.name)}-p${String(i + 1).padStart(3, '0')}.${r.format === 'jpeg' ? 'jpg' : 'png'}`, data: new Uint8Array(await blob.arrayBuffer()) }); }
      if (r.to === 'zip') { const zip = writeZip(files); const saved = await saveAs(new Blob([zip as BlobPart], { type: 'application/zip' }), `${base(pic.name)}-pages.zip`); if (saved) toast(`Saved ${saved.name} (${files.length} pages, ${fmtSize(zip.length)})`); return; }
      await app.openFolder(new Folder(files.map((f) => entryFromBytes(f.name, f.data.buffer as ArrayBuffer)), `${pic.name} pages`), 0, { newWindow: true });
    },
  },
  {
    id: 'pages.reorder', icon: 'low_priority', edits: true, isEnabled: hasPages, tip: 'Move pages up or down, or reverse them',
    run: async (app) => {
      const pic = app.picture!;
      const r = await orderDialog('Reorder Pages', pic.pages.map((pg, i) => `Page ${i + 1} (${pg.width}×${pg.height})`));
      if (!r) return;
      app.edit('Reorder pages', (p) => { const cur = p.pages[p.page]; p.pages = reorder(p.pages, r.order); p.page = Math.max(0, p.pages.indexOf(cur)); });
      app.viewer.pictureChanged();
    },
  },

  // Frames -----------------------------------------------------------------------------------------
  {
    id: 'frames.editor', icon: 'view_timeline', edits: true, isEnabled: hasFrames, tip: 'Reorder, delete and duplicate frames; set each frame\'s delay',
    run: async (app) => {
      const pic = app.picture!;
      let frames: Frame[] = pic.current.frames.map((f) => ({ ...f }));
      const opts = () => frames.map((f, i) => ({ value: String(i), label: `${i + 1}. ${f.delay} ms` }));
      const preview = h2(frames[0]);
      const r = await openDialog({ title: `Frame Editor — ${frames.length} frames`, wide: true, ok: 'Apply', preview: true, fields: [
        { key: 'frames', label: 'Frames', type: 'list', options: opts(), value: '0', rows: 8 },
        { key: 'delay', label: 'Delay of the selected frame (ms)', type: 'number', min: 10, max: 60000, value: frames[0].delay, half: true },
        { key: 'setDelay', label: 'Set delay', type: 'button', half: true, onClick: (v, ctl) => { const i = +v.frames; if (!(i >= 0)) return; frames[i] = { ...frames[i], delay: Math.max(10, +v.delay || 100) }; ctl.set('frames', opts()); ctl.set('frames', String(i)); } },
        { key: 'allDelay', label: 'Set this delay for all frames', type: 'button', half: true, onClick: (v, ctl) => { frames = frames.map((f) => ({ ...f, delay: Math.max(10, +v.delay || 100) })); ctl.set('frames', opts()); } },
        { key: 'dup', label: 'Duplicate', type: 'button', half: true, onClick: (v, ctl) => { const i = +v.frames; if (!(i >= 0)) return; frames.splice(i + 1, 0, { ...frames[i] }); ctl.set('frames', opts()); ctl.set('frames', String(i + 1)); } },
        { key: 'del', label: 'Delete', type: 'button', half: true, onClick: (v, ctl) => { const i = +v.frames; if (!(i >= 0) || frames.length < 2) return; frames.splice(i, 1); ctl.set('frames', opts()); ctl.set('frames', String(Math.min(i, frames.length - 1))); } },
        { key: 'up', label: 'Move up', type: 'button', half: true, onClick: (v, ctl) => { const i = +v.frames; if (!(i > 0)) return; [frames[i - 1], frames[i]] = [frames[i], frames[i - 1]]; ctl.set('frames', opts()); ctl.set('frames', String(i - 1)); } },
        { key: 'down', label: 'Move down', type: 'button', half: true, onClick: (v, ctl) => { const i = +v.frames; if (!(i >= 0 && i < frames.length - 1)) return; [frames[i + 1], frames[i]] = [frames[i], frames[i + 1]]; ctl.set('frames', opts()); ctl.set('frames', String(i + 1)); } },
      ], onChange: (v, ctl, key) => { if (key === 'frames') { const i = +v.frames; if (i >= 0 && frames[i]) { ctl.set('delay', frames[i].delay); ctl.setPreview(h2(frames[i])); } } }, onOpen: (ctl) => ctl.setPreview(preview) });
      if (!r) return;
      const next = frames;
      app.edit('Edit frames', (p) => { p.pages = p.pages.map((pg, i) => (i === p.page ? { ...pg, frames: next } : pg)); p.frame = 0; });
      app.viewer.pictureChanged();
    },
  },
  { id: 'frames.reverse', icon: 'swap_horiz', edits: true, isEnabled: hasFrames, run: (app) => { app.edit('Reverse frames', (p) => { p.pages = p.pages.map((pg, i) => (i === p.page ? { ...pg, frames: reverseFrames(pg.frames) } : pg)); p.frame = 0; }); app.viewer.pictureChanged(); } },
  {
    id: 'frames.loopCount', icon: 'repeat', edits: true, isEnabled: hasFrames, tip: '0 = forever; kept when saving as GIF or APNG',
    run: async (app) => { const pic = app.picture!; const r = await openDialog({ title: 'Loop Count', ok: 'Set', fields: [{ key: 'loops', label: 'Loops (0 = forever)', type: 'number', min: 0, max: 65535, value: pic.current.loops }] }); if (!r) return; app.edit('Loop count', (p) => { p.pages = p.pages.map((pg, i) => (i === p.page ? { ...pg, loops: Math.max(0, +r.loops || 0) } : pg)); }); },
  },
  {
    id: 'frames.optimize', icon: 'compress', edits: true, isEnabled: hasFrames, tip: 'Merges identical consecutive frames into one with the summed delay (the GIF and APNG writers then share one palette and store only what is needed)',
    run: (app) => { const pic = app.picture!; const before = pic.current.frames.length; const merged = mergeIdenticalFrames(pic.current.frames, samePixels); if (merged.length === before) { toast('No identical consecutive frames.'); return; } app.edit('Optimize animation', (p) => { p.pages = p.pages.map((pg, i) => (i === p.page ? { ...pg, frames: merged } : pg)); p.frame = 0; }); app.viewer.pictureChanged(); toast(`${before} → ${merged.length} frames`); },
  },

  // RAW --------------------------------------------------------------------------------------------
  {
    id: 'raw.preview', icon: 'raw_on', noRecord: true, isEnabled: isRaw, tip: 'The JPEG previews inside the RAW file; pick the one to show',
    run: async (app) => {
      const pic = app.picture!; const previews = findEmbeddedJpegs(pic.bytes);
      if (!previews.length) { toast('No embedded JPEG preview in this file.'); return; }
      const r = await openDialog({ title: 'Embedded Previews', ok: 'Show', fields: [{ key: 'i', label: 'Preview', type: 'list', options: previews.map((p, i) => ({ value: String(i), label: `${p.width} × ${p.height} (${fmtSize(p.length)})` })), value: '0', rows: Math.min(8, previews.length + 1) }] });
      if (!r) return;
      const pv = previews[+r.i]; const bytes = pic.bytes.slice(pv.offset, pv.offset + pv.length);
      await app.openFolder(new Folder([entryFromBytes(`${base(pic.name)}-preview-${pv.width}x${pv.height}.jpg`, bytes.buffer as ArrayBuffer)], 'Embedded preview'), 0, { newWindow: true });
    },
  },
  {
    id: 'raw.extractPreview', icon: 'save_alt', noRecord: true, isEnabled: isRaw, tip: 'Saves the largest embedded JPEG exactly as the camera wrote it',
    run: async (app) => { const pic = app.picture!; const previews = findEmbeddedJpegs(pic.bytes); if (!previews.length) { toast('No embedded JPEG preview in this file.'); return; } const pv = previews.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a)); const bytes = pic.bytes.slice(pv.offset, pv.offset + pv.length); const saved = await saveAs(new Blob([bytes as BlobPart], { type: 'image/jpeg' }), `${base(pic.name)}.jpg`); if (saved) toast(`Saved ${saved.name} (${pv.width}×${pv.height}, ${fmtSize(bytes.length)})`); },
  },
  {
    id: 'raw.develop', icon: 'tune', noRecord: true, isEnabled: isRaw, tip: 'Develops a RAW file\'s sensor data (DNG and the camera files the reader knows): white balance, exposure, highlights, demosaic quality and output color space. For a file it cannot read it says why (a maker\'s compressed coding, for instance)',
    run: async (app, arg?: DevelopOptions) => {
      const pic = app.picture!;
      const { develop, neutralToTemp } = await import('../raw/develop'), { readRaw } = await import('../raw/families');
      // Offered for every RAW file, so that one it cannot read gets its reason rather than a greyed-out command.
      const can = rawSupport(pic.bytes, pic.name); if (!can.ok) { toast(`Develop RAW: ${can.why || 'this file is not one the reader knows'}.`, { ms: 6000 }); return; }
      let raw; try { raw = readRaw(pic.bytes, pic.name); } catch (e) { toast(`Develop RAW: ${(e as Error).message}.`, { ms: 5000 }); return; }
      let o: DevelopOptions = arg || lastDevelop;
      if (!arg) {
        const shot = raw.asShotNeutral ? neutralToTemp(raw, raw.asShotNeutral) : null;
        let timer: any = 0;
        const opts = (v: Record<string, any>): DevelopOptions => ({ wb: v.wb, temp: +v.temp, tint: +v.tint, exposure: +v.exposure, highlights: v.highlights, demosaic: v.demosaic, space: v.space, crop: !!v.crop });
        const preview = (v: Record<string, any>, ctl: { setPreview: (h: string) => void }) => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            try {
              const d = develop(raw!, { ...opts(v), demosaic: 'half' }), k = Math.min(1, 520 / Math.max(d.raster.width, d.raster.height));
              const c = document.createElement('canvas'); c.width = d.raster.width; c.height = d.raster.height; c.getContext('2d')!.putImageData(new ImageData(d.raster.data, d.raster.width, d.raster.height), 0, 0);
              const t = document.createElement('canvas'); t.width = Math.max(1, Math.round(c.width * k)); t.height = Math.max(1, Math.round(c.height * k)); t.getContext('2d')!.drawImage(c, 0, 0, t.width, t.height);
              ctl.setPreview(`<img alt="Preview" src="${t.toDataURL('image/jpeg', 0.85)}" style="max-width:100%;max-height:42vh;display:block;margin:auto"><div class="ql-help">White balance ${d.temp} K, tint ${d.tint > 0 ? '+' : ''}${d.tint}</div>`);
            } catch (e) { ctl.setPreview(`<div class="ql-help">${(e as Error).message}</div>`); }
          }, 200);
        };
        const r = await openDialog({ title: 'Develop RAW', ok: 'Develop', wide: true, preview: true,
          help: `${pic.name}: ${raw.width} × ${raw.height} ${raw.cfa ? 'Bayer sensor' : 'linear'} data${raw.make || raw.model ? ` from ${[raw.make, raw.model].filter(Boolean).join(' ')}` : ''}${shot ? `; as shot ${shot.temp} K` : ''}.`,
          fields: [
            { key: 'wb', label: 'White balance', type: 'select', value: o.wb || 'asShot', half: true, options: [{ value: 'asShot', label: 'As shot' }, { value: 'auto', label: 'Automatic (gray world)' }, { value: 'daylight', label: 'Daylight (5500 K)' }, { value: 'custom', label: 'Temperature and tint' }] },
            { key: 'exposure', label: 'Exposure (EV)', type: 'range', min: -3, max: 3, step: 0.1, value: o.exposure ?? 0, half: true },
            { key: 'temp', label: 'Temperature (K)', type: 'range', min: 2000, max: 12000, step: 50, value: o.temp ?? shot?.temp ?? 5500, half: true, visibleIf: (v) => v.wb === 'custom' },
            { key: 'tint', label: 'Tint (green − / magenta +)', type: 'range', min: -100, max: 100, step: 1, value: o.tint ?? shot?.tint ?? 0, half: true, visibleIf: (v) => v.wb === 'custom' },
            { key: 'highlights', label: 'Highlights', type: 'select', value: o.highlights || 'recover', half: true, options: [{ value: 'recover', label: 'Rebuild (blown areas white, soft roll-off)' }, { value: 'clip', label: 'Clip' }, { value: 'unclip', label: 'Keep all sensor data (darker)' }] },
            { key: 'demosaic', label: 'Demosaic', type: 'select', value: o.demosaic || 'high', half: true, options: [{ value: 'high', label: 'High quality (gradient-corrected)' }, { value: 'bilinear', label: 'Bilinear' }, { value: 'half', label: 'Half size (fast)' }] },
            { key: 'space', label: 'Color space', type: 'select', value: o.space || 'srgb', half: true, options: [{ value: 'srgb', label: 'sRGB' }, { value: 'p3', label: 'Display P3' }, { value: 'adobergb', label: 'Adobe RGB (1998) compatible' }, { value: 'prophoto', label: 'ProPhoto RGB' }] },
            { key: 'crop', label: 'Default crop', type: 'checkbox', value: o.crop !== false, half: true },
          ],
          onOpen: (ctl) => preview(ctl.values(), ctl),
          onChange: (v, ctl) => preview(v, ctl),
        });
        clearTimeout(timer);
        if (!r) return;
        o = lastDevelop = opts(r);
      }
      toast('Developing…', { ms: 1500 }); await new Promise((res) => setTimeout(res, 30));
      const d = develop(raw, o);
      editRaster(app, 'Develop RAW', () => d.raster, { patch: { icc: o.space && o.space !== 'srgb' ? d.icc : undefined } });
      return { width: d.raster.width, height: d.raster.height, temp: d.temp, tint: d.tint, multipliers: d.multipliers };
    },
  },
  { id: 'raw.preferPreview', icon: 'bolt', kind: 'toggle', noRecord: true, isActive: (app) => app.prefs.rawPreferPreview, tip: 'RAW files open as their embedded preview (fast culling); off: files the RAW reader knows are developed when opened (others still show their preview)', run: (app) => { app.prefs.rawPreferPreview = !app.prefs.rawPreferPreview; app.savePrefs(); toast(app.prefs.rawPreferPreview ? 'RAW files open as the embedded preview.' : 'DNG files are developed when opened; other RAW files show their embedded preview.'); } },
]);
function h2(f: Frame): string { return `<img src="${thumbOf(f, 240).toDataURL()}" style="max-height:30vh"> <div class="ql-help">${f.width} × ${f.height}, ${f.delay} ms</div>`; }
