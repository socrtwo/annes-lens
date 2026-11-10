/**
 * Batch (M3): Batch Conversion and Rename (B), Batch Rename (Ctrl+B), Batch Lossless JPEG, Optimize
 * Files, Web and Email Sizes, Preview (dry run) and Undo Last Batch. Inputs are the marked thumbnails
 * or the whole folder; outputs go to a chosen folder (desktop, Android, File System Access) or, where
 * nothing can be written, into a ZIP download. Every batch is one journal entry Undo Last Batch reverses.
 */
import { iccForSave, writeWithProfile } from '../color/embedded';
import { def } from './registry';
import type { App } from '../app';
import { openDialog, toast, confirmDialog } from '../ui/dialog';
import { h, download, esc } from '../ui/dom';
import type { Entry } from '../picture/folder';
import { decodePicture, encodeCanvas, encoderFor, ENCODERS, type EncodeFormat } from '../codecs/registry';
import { frameRaster, rasterFrame } from '../picture/edit';
import { resample, grayscale, negative, reduceColors, autoCropRect, crop, clampRect, canvasSize, hexToRgb, type Kernel } from '../picture/ops';
import { colorCorrect, autoAdjust, autoLevels, autoContrast, autoColor, sharpen, gaussianBlur } from '../picture/adjust';
import { rotateRaster } from '../picture/geometry';
import { drawText, drawOverlay } from './editAdd';
import { updateXmp } from '../meta/xmp';
import { setXmp, canEmbed, decodeText } from '../meta/metaEdit';
import { sniff } from '../codecs/registry';
import { makeRaster, type Raster } from '../codecs/raster';
import type { Picture } from '../picture/model';
import { transformPage, orientationOps } from '../picture/model';
import { losslessTransform, isJpeg, opForOrientation, type LosslessOp } from '../codecs/jpegLossless';
import { extractMeta, hasMeta, injectMeta, setExifOrientation } from '../meta/metaWrite';
import { readExif } from '../meta/exif';
import { expandName, uniqueName, writeZip, type NameOptions } from '../picture/batch';
import { pickFolder, writeIntoFolder, deleteFile, renameFile, fileOpCaps } from '../platform/native';
import { dirUriOf, replaceEntry, parseExifDate } from './fileOps';
import { fmtSize } from '../ui/shell';
import { entryFromUri } from '../picture/folder';

/** One ordered step of a Batch Steps job (applied after the simple steps, in order). */
export type Action =
  | { kind: 'resize'; mode: 'long' | 'width' | 'height' | 'percent'; value: number; kernel: Kernel; onlyShrink: boolean }
  | { kind: 'crop'; x: number; y: number; w: number; h: number /* percent */ }
  | { kind: 'autoCrop'; tolerance: number }
  | { kind: 'rotate'; angle: number; expand: boolean; bg: string }
  | { kind: 'flip'; dir: 'h' | 'v' }
  | { kind: 'canvas'; w: number; h: number; anchor: string; bg: string; transparent: boolean }
  | { kind: 'color'; brightness: number; contrast: number; gamma: number; saturation: number }
  | { kind: 'auto'; what: 'adjust' | 'levels' | 'contrast' | 'color' }
  | { kind: 'grayscale' } | { kind: 'negative' } | { kind: 'colors'; n: number }
  | { kind: 'sharpen'; amount: number } | { kind: 'blur'; radius: number }
  | { kind: 'text'; text: string; size: number; color: string; anchor: string; margin: number; opacity: number; outline: number; font: string }
  | { kind: 'overlay'; dataUrl: string; scale: number; opacity: number; anchor: string; margin: number; tile: boolean }
  | { kind: 'border'; size: number; color: string }
  | { kind: 'metadata'; patch: Record<string, any> };
export interface BatchSteps {
  /** Ordered steps (Batch Steps editor); run after the fixed ones below. */
  actions?: Action[];
  /** 'box' fits within value × value2 (the command line's --resize=WxH). */
  resize?: { mode: 'long' | 'width' | 'height' | 'percent' | 'box'; value: number; value2?: number; kernel: Kernel; onlyShrink: boolean };
  rotate?: 'exif' | 'rot90' | 'rot180' | 'rot270' | 'flipH' | 'flipV';
  grayscale?: boolean;
  colors?: number;
  autoCrop?: boolean;
}
export interface BatchJob {
  inputs: Entry[];
  format: EncodeFormat | 'keep';
  quality: number;
  keepMeta: boolean;
  steps: BatchSteps;
  names: NameOptions;
  lossless?: { op: LosslessOp | 'exif'; strip: boolean };
}
export interface BatchResult { name: string; data: Uint8Array; source: Entry; note?: string }

const base = (n: string) => n.replace(/\.[^.]+$/, '');
const extOf = (n: string) => (n.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();

/** The inputs: marked thumbnails, else the whole folder. */
export function inputsOf(app: App): { entries: Entry[]; marked: boolean } {
  const t = app.tab;
  const marked = [...t.marked].filter((e) => t.folder.entries.includes(e));
  return marked.length ? { entries: t.folder.entries.filter((e) => t.marked.has(e)), marked: true } : { entries: [...t.folder.entries], marked: false };
}

/** Output names for a dry run: the same expansion the run uses. */
export function planNames(job: BatchJob, infos: { entry: Entry; width?: number; height?: number; exifDate?: Date; make?: string; model?: string }[]): string[] {
  const used = new Set<string>();
  return infos.map((inf, i) => {
    const e = inf.entry;
    const ext = job.format === 'keep' ? extOf(e.name) || 'png' : ENCODERS[job.format].ext;
    const stem = expandName(job.names, { name: base(e.name), ext, index: i, date: e.mtime ? new Date(e.mtime) : new Date(), exifDate: inf.exifDate, make: inf.make, model: inf.model, width: inf.width, height: inf.height });
    return uniqueName(/\{ext\}/.test(job.names.pattern) ? stem : `${stem}.${ext}`, used);
  });
}

/** Processes one input to its output bytes. */
async function processOne(job: BatchJob, e: Entry, index: number, name: string): Promise<BatchResult> {
  const u8 = new Uint8Array(await e.read());
  const steps = job.steps;
  const pixelWork = !!(steps.resize || steps.grayscale || steps.colors || steps.autoCrop || steps.actions?.some((a) => a.kind !== 'metadata') || (steps.rotate && !(isJpeg(u8) && job.format === 'keep')));
  const metaAction = steps.actions?.filter((a): a is Extract<Action, { kind: 'metadata' }> => a.kind === 'metadata') || [];
  // Lossless paths: JPEG kept as JPEG with only a rotation, or an explicit lossless job.
  if (isJpeg(u8) && job.format === 'keep' && !pixelWork && (job.lossless || steps.rotate)) {
    const exif = readExif(u8);
    const wanted = job.lossless ? job.lossless.op : steps.rotate!;
    const op: LosslessOp = wanted === 'exif' ? opForOrientation(exif?.orientation || 1) : wanted;
    const r = losslessTransform(u8, op, { stripMetadata: job.lossless?.strip || !job.keepMeta, orientation: wanted === 'exif' || op !== 'none' ? 1 : undefined });
    return { name, data: r.bytes, source: e, note: `${op === 'none' ? 'optimized' : op} losslessly, ${fmtSize(u8.length)} → ${fmtSize(r.bytes.length)}` };
  }
  if (job.format === 'keep' && !pixelWork) {
    if (metaAction.length) { const fmt = sniff(u8, e.name)?.id || ''; if (canEmbed(fmt)) { const m = extractMeta(u8); let xml = m.xmp ? decodeText(m.xmp) : null; for (const a of metaAction) xml = updateXmp(xml, a.patch); return { name, data: setXmp(u8, fmt, new TextEncoder().encode(xml!)), source: e, note: 'metadata updated' }; } }
    return { name, data: u8, source: e, note: 'copied' };
  }
  const pic = await decodePicture(u8, e);
  try {
    let page = pic.current;
    if (steps.rotate) { const ops = steps.rotate === 'exif' ? (pic.orientationApplied ? [] : orientationOps(pic.orientation)) : [({ rot90: 'cw', rot180: '180', rot270: 'ccw', flipH: 'flipH', flipV: 'flipV' } as const)[steps.rotate]]; for (const op of ops) page = transformPage(page, op); }
    let r = frameRaster(page.frames[0]);
    if (steps.autoCrop) { const rect = autoCropRect(r, 16); if (rect) r = crop(r, rect); }
    if (steps.resize) {
      const { mode, value, value2, kernel, onlyShrink } = steps.resize;
      let w = r.width, hh = r.height;
      if (mode === 'percent') { w = Math.round(r.width * value / 100); hh = Math.round(r.height * value / 100); }
      else { const k = mode === 'box' ? Math.min(value / r.width, (value2 || value) / r.height) : mode === 'long' ? value / Math.max(r.width, r.height) : mode === 'width' ? value / r.width : value / r.height; w = Math.round(r.width * k); hh = Math.round(r.height * k); }
      if (!(onlyShrink && (w > r.width || hh > r.height))) r = resample(r, Math.max(1, w), Math.max(1, hh), kernel);
    }
    if (steps.grayscale) r = grayscale(r);
    if (steps.colors) r = reduceColors(r, steps.colors, 'floyd').raster;
    for (const a of steps.actions || []) r = await applyAction(r, a, { name: e.name, index, pic });
    const fmt: EncodeFormat = job.format === 'keep' ? encoderFor(pic.format.id) || 'png' : job.format;
    const c = rasterFrame(r, 0).image as HTMLCanvasElement;
    let blob = await encodeCanvas(c, fmt, job.quality / 100);
    if ((job.keepMeta || metaAction.length || pic.current.icc) && (fmt === 'jpeg' || fmt === 'png' || fmt === 'webp')) {
      const meta = job.keepMeta ? extractMeta(u8) : {};
      if (metaAction.length) { let xml = meta.xmp ? decodeText(meta.xmp) : null; for (const a of metaAction) xml = updateXmp(xml, a.patch); meta.xmp = new TextEncoder().encode(xml!); }
      const icc = iccForSave(pic.current.icc, meta.icc);
      if (hasMeta({ ...meta, icc })) { if (meta.exif) meta.exif = setExifOrientation(meta.exif, 1); blob = new Blob([await writeWithProfile(new Uint8Array(await blob.arrayBuffer()), fmt, meta, icc) as BlobPart], { type: blob.type }); }
    }
    const out = new Uint8Array(await blob.arrayBuffer());
    const outName = job.format === 'keep' && encoderFor(pic.format.id) !== fmt ? name.replace(/\.[^.]+$/, '') + '.' + ENCODERS[fmt].ext : name;
    return { name: outName, data: out, source: e, note: `${r.width} × ${r.height}, ${fmtSize(out.length)}` };
  } finally { pic.release(); }
}

const overlayImages = new Map<string, Promise<HTMLImageElement>>();
function overlayImage(dataUrl: string): Promise<HTMLImageElement> {
  let p = overlayImages.get(dataUrl);
  if (!p) { p = new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = () => rej(new Error('The overlay picture could not be decoded.')); img.src = dataUrl; }); overlayImages.set(dataUrl, p); }
  return p;
}
/** Applies one Batch Steps action to a raster. */
export async function applyAction(r: Raster, a: Action, ctx: { name: string; index: number; pic?: Picture }): Promise<Raster> {
  switch (a.kind) {
    case 'resize': { let w = r.width, hh = r.height; if (a.mode === 'percent') { w = Math.round(r.width * a.value / 100); hh = Math.round(r.height * a.value / 100); } else { const k = a.mode === 'long' ? a.value / Math.max(r.width, r.height) : a.mode === 'width' ? a.value / r.width : a.value / r.height; w = Math.round(r.width * k); hh = Math.round(r.height * k); } return a.onlyShrink && (w > r.width || hh > r.height) ? r : resample(r, Math.max(1, w), Math.max(1, hh), a.kernel); }
    case 'crop': { const rect = clampRect({ x: Math.round(r.width * a.x / 100), y: Math.round(r.height * a.y / 100), w: Math.round(r.width * a.w / 100), h: Math.round(r.height * a.h / 100) }, r.width, r.height); return rect ? crop(r, rect) : r; }
    case 'autoCrop': { const rect = autoCropRect(r, a.tolerance); return rect ? crop(r, rect) : r; }
    case 'rotate': return a.angle ? rotateRaster(r, a.angle, a.expand, hexToRgb(a.bg) as [number, number, number]) : r;
    case 'flip': { const out = makeRaster(r.width, r.height); for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) { const sx = a.dir === 'h' ? r.width - 1 - x : x, sy = a.dir === 'v' ? r.height - 1 - y : y; out.data.set(r.data.subarray((sy * r.width + sx) * 4, (sy * r.width + sx) * 4 + 4), (y * r.width + x) * 4); } return out; }
    case 'canvas': { const w = a.w || r.width, hh = a.h || r.height, ax = /left/.test(a.anchor) ? 0 : /right/.test(a.anchor) ? 1 : 0.5, ay = /top/.test(a.anchor) ? 0 : /bottom/.test(a.anchor) ? 1 : 0.5; return canvasSize(r, w, hh, Math.round((w - r.width) * ax), Math.round((hh - r.height) * ay), a.transparent ? [0, 0, 0, 0] : [...hexToRgb(a.bg), 255] as [number, number, number, number]); }
    case 'color': return colorCorrect(r, { brightness: a.brightness, contrast: a.contrast, gamma: a.gamma, saturation: a.saturation });
    case 'auto': return a.what === 'adjust' ? autoAdjust(r) : a.what === 'levels' ? autoLevels(r) : a.what === 'contrast' ? autoContrast(r) : autoColor(r);
    case 'grayscale': return grayscale(r);
    case 'negative': return negative(r);
    case 'colors': return reduceColors(r, a.n, 'floyd').raster;
    case 'sharpen': return sharpen(r, a.amount / 100);
    case 'blur': return gaussianBlur(r, a.radius);
    case 'text': return drawText(r, r.width, { text: a.text.replace(/\{name\}/g, ctx.name).replace(/\{basename\}/g, ctx.name.replace(/\.[^.]+$/, '')).replace(/\{n\}/g, String(ctx.index + 1)).replace(/\{date\}/g, new Date().toISOString().slice(0, 10)).replace(/\{exifdate\}/g, ctx.pic?.exif?.dateTaken?.slice(0, 10).replace(/:/g, '-') || '').replace(/\{w\}/g, String(r.width)).replace(/\{h\}/g, String(r.height)), font: a.font, size: a.size, bold: false, italic: false, color: a.color, outline: a.outline, outlineColor: '#000000', shadow: 0, shadowColor: '#000000', bg: '#000000', bgOpacity: 0, rotation: 0, anchor: a.anchor, margin: a.margin, opacity: a.opacity, align: 'left' });
    case 'overlay': return drawOverlay(r, r.width, await overlayImage(a.dataUrl), { scale: a.scale, opacity: a.opacity, anchor: a.anchor, margin: a.margin, tile: a.tile, rotation: 0 });
    case 'border': return canvasSize(r, r.width + 2 * a.size, r.height + 2 * a.size, a.size, a.size, [...hexToRgb(a.color), 255] as [number, number, number, number]);
    case 'metadata': return r;
  }
}

/** Runs the job with a progress dialog; `sink` stores each output. Returns what was written. */
export interface BatchControl { paused?: () => boolean; canceled?: () => boolean; progress?: (i: number, n: number, name: string) => void }
export async function runBatch(app: App, job: BatchJob, sink: (r: BatchResult) => Promise<{ uri: string | null; name: string }>, opts: { silent?: boolean; control?: BatchControl } = {}): Promise<{ done: { name: string; uri: string | null; source: Entry; note?: string }[]; failed: { name: string; error: string }[]; canceled: boolean }> {
  const names = planNames(job, job.inputs.map((entry) => ({ entry })));
  const done: { name: string; uri: string | null; source: Entry; note?: string }[] = [], failed: { name: string; error: string }[] = [];
  let canceled = false;
  const bar = h('progress', { max: String(job.inputs.length), value: '0', style: 'width:100%' }) as HTMLProgressElement;
  const line = h('div', { class: 'ql-help' }, 'Starting…');
  const dialog = { close: null as null | (() => void) };
  const dlg = opts.silent ? null : openDialog({ title: 'Batch', content: h('div', null, bar, line), ok: false, cancel: 'Cancel', onOpen: (ctl) => { dialog.close = () => ctl.close(null); } }).then(() => { canceled = true; });
  for (let i = 0; i < job.inputs.length; i++) {
    while (opts.control?.paused?.() && !opts.control.canceled?.()) await new Promise((res) => setTimeout(res, 200));
    if (canceled || opts.control?.canceled?.()) { canceled = true; break; }
    const e = job.inputs[i];
    line.textContent = `${i + 1} / ${job.inputs.length}: ${e.name}`;
    opts.control?.progress?.(i, job.inputs.length, e.name);
    try {
      const r = await processOne(job, e, i, names[i]);
      const w = await sink(r);
      done.push({ name: w.name, uri: w.uri, source: e, note: w.name !== r.name ? [r.note, `named ${w.name}: ${r.name} was there already`].filter(Boolean).join('; ') : r.note });
    } catch (err: any) { failed.push({ name: e.name, error: err?.message || String(err) }); }
    bar.value = i + 1;
    await new Promise((res) => setTimeout(res, 0));
  }
  opts.control?.progress?.(job.inputs.length, job.inputs.length, '');
  dialog.close?.();
  await dlg;
  return { done, failed, canceled };
}

/** Where outputs go: a folder the platform can write into, or a ZIP download. */
export async function chooseSink(app: App, title: string): Promise<{ sink: (r: BatchResult) => Promise<{ uri: string | null; name: string }>; finish: () => Promise<void>; dirUri: string | null; label: string } | null> {
  const dest = await pickFolder(title);
  // Outputs never replace a file that is already there (the source folder may be the destination): a taken name gets " (2)".
  if (dest) return { sink: async (r) => writeIntoFolder(dest.uri, r.name, r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.byteLength) as ArrayBuffer, 'rename'), finish: async () => undefined, dirUri: dest.uri, label: dest.name };
  const fsa = !!(window as any).showDirectoryPicker;
  if (fsa) return null; // the user canceled the picker
  const zipped: { name: string; data: Uint8Array }[] = [];
  return { sink: async (r) => { zipped.push({ name: r.name, data: r.data }); return { uri: null, name: r.name }; }, finish: async () => { if (zipped.length) download(new Blob([writeZip(zipped) as BlobPart], { type: 'application/zip' }), `${app.tab.folder.name || 'batch'}-output.zip`); }, dirUri: null, label: 'a ZIP download' };
}

export function summary(app: App, r: { done: any[]; failed: { name: string; error: string }[]; canceled: boolean }, where: string): void {
  const renamed = r.done.filter((d) => /was there already$/.test(d.note || '')).length;
  const text = `${r.done.length} file${r.done.length === 1 ? '' : 's'} written to ${where}${renamed ? ` (${renamed} under a new name, since a file of that name was there already)` : ''}${r.failed.length ? `; ${r.failed.length} failed (${r.failed.slice(0, 3).map((f) => `${f.name}: ${f.error}`).join('; ')})` : ''}${r.canceled ? '; canceled' : ''}`;
  toast(text, { ms: 8000, action: r.done.length ? 'Undo' : undefined, onAction: () => app.exec('batch.undo') });
}

/** Undo removes the batch's own outputs, which are always new files (the sink never replaces one), to the trash where the platform has one. */
export function journalOutputs(app: App, label: string, done: { name: string; uri: string | null }[], dirUri: string | null): void {
  const withUri = done.filter((d) => d.uri);
  app.journal.push({ kind: 'copy', label, when: Date.now(), undo: withUri.length ? async () => { for (const d of withUri) await deleteFile(d.uri!, dirUri, false); } : undefined, noUndo: withUri.length ? undefined : 'the outputs were downloaded, not written to a folder' });
}

const formatOptions = [{ value: 'keep', label: 'Same as the source (copy or lossless rotate)' }, ...Object.entries(ENCODERS).map(([value, v]) => ({ value, label: v.label }))];

async function batchDialog(app: App, preset: Partial<{ format: string; quality: number; long: number; strip: boolean; title: string }> = {}): Promise<void> {
  const { entries, marked } = inputsOf(app);
  if (!entries.length) { toast('Open a folder first.'); return; }
  let previewNames: string[] = [];
  const build = (v: Record<string, any>): BatchJob => ({
    inputs: v.scope === 'current' && app.tab.entry ? [app.tab.entry] : entries,
    format: v.format, quality: +v.quality || 85, keepMeta: !v.strip,
    steps: {
      resize: v.resize !== 'none' ? { mode: v.resize, value: +v.size || 1600, kernel: v.kernel, onlyShrink: !!v.onlyShrink } : undefined,
      rotate: v.rotate !== 'none' ? v.rotate : undefined, grayscale: !!v.gray, colors: v.colors !== 'no' ? +v.colors : undefined, autoCrop: !!v.autoCrop,
    },
    names: { pattern: v.pattern || '{name}', start: +v.start || 1, step: 1, pad: +v.pad || 1, case: v.case, find: v.find || undefined, replace: v.replace || '', regex: !!v.regex },
  });
  const preview = (v: Record<string, any>, ctl: any) => {
    const job = build(v);
    previewNames = planNames(job, job.inputs.map((entry) => ({ entry })));
    const rows = job.inputs.slice(0, 200).map((e, i) => `<tr><td>${esc(e.name)}</td><td>→</td><td>${esc(previewNames[i] || '')}</td></tr>`).join('');
    ctl.setPreview(`<div class="ql-help">${job.inputs.length} file${job.inputs.length === 1 ? '' : 's'}${marked && v.scope !== 'current' ? ' (the marked thumbnails)' : ''}; ${new Set(previewNames.map((n) => n.toLowerCase())).size === previewNames.length ? 'no name conflicts' : 'conflicting names get " (2)"'}</div><table class="ql-stats qn-info" style="font-size:12px">${rows}${job.inputs.length > 200 ? '<tr><td colspan="3">…</td></tr>' : ''}</table>`);
  };
  const r = await openDialog({ title: preset.title || 'Batch Conversion and Rename', wide: true, ok: 'Run…', preview: true, previewStyle: 'max-height:40vh;overflow:auto',
    help: 'Every step is optional and runs in order: rotate, auto crop, resize, grayscale, colors, then the output format and name. Outputs go to a folder you choose (or a ZIP download where the browser cannot write folders); the originals are never changed. Undo Last Batch removes the outputs.',
    fields: [
      { key: 'scope', label: 'Files', type: 'select', options: [{ value: 'all', label: marked ? `The ${entries.length} marked pictures` : `Every picture in the folder (${entries.length})` }, { value: 'current', label: 'This picture only' }], value: 'all', half: true },
      { key: 'format', label: 'Output format', type: 'select', options: formatOptions, value: preset.format || 'keep', half: true },
      { key: 'quality', label: 'Quality (JPEG, WebP)', type: 'range', min: 1, max: 100, value: preset.quality || app.prefs.jpegQuality, half: true, visibleIf: (v) => v.format === 'jpeg' || v.format === 'webp' || v.format === 'keep' },
      { key: 'strip', label: 'Strip metadata (EXIF, XMP, profile)', type: 'checkbox', value: !!preset.strip, half: true },
      { key: 'h1', type: 'heading', label: 'Steps' },
      { key: 'rotate', label: 'Rotate', type: 'select', options: [{ value: 'none', label: 'No' }, { value: 'exif', label: 'Upright by EXIF orientation' }, { value: 'rot90', label: '90° clockwise' }, { value: 'rot270', label: '90° counter-clockwise' }, { value: 'rot180', label: '180°' }, { value: 'flipH', label: 'Flip horizontal' }, { value: 'flipV', label: 'Flip vertical' }], value: 'none', half: true },
      { key: 'autoCrop', label: 'Auto crop uniform borders', type: 'checkbox', value: false, half: true },
      { key: 'resize', label: 'Resize', type: 'select', options: [{ value: 'none', label: 'No' }, { value: 'long', label: 'Longest side to' }, { value: 'width', label: 'Width to' }, { value: 'height', label: 'Height to' }, { value: 'percent', label: 'Percent' }], value: preset.long ? 'long' : 'none', half: true },
      { key: 'size', label: 'Pixels / percent', type: 'number', min: 1, max: 32768, value: preset.long || 1600, half: true, visibleIf: (v) => v.resize !== 'none' },
      { key: 'kernel', label: 'Resampling', type: 'select', options: [{ value: 'lanczos3', label: 'Lanczos 3' }, { value: 'bicubic', label: 'Bicubic' }, { value: 'bilinear', label: 'Bilinear' }, { value: 'nearest', label: 'Nearest' }], value: 'lanczos3', half: true, visibleIf: (v) => v.resize !== 'none' },
      { key: 'onlyShrink', label: 'Only shrink, never enlarge', type: 'checkbox', value: true, half: true, visibleIf: (v) => v.resize !== 'none' },
      { key: 'gray', label: 'Grayscale', type: 'checkbox', value: false, half: true },
      { key: 'colors', label: 'Reduce colors', type: 'select', options: [{ value: 'no', label: 'No' }, { value: '256', label: '256' }, { value: '16', label: '16' }, { value: '2', label: '2' }], value: 'no', half: true },
      { key: 'h2', type: 'heading', label: 'Names' },
      { key: 'pattern', label: 'Pattern', type: 'text', value: '{name}', help: '{name} {n} {n:4} {date} {time} {yyyy} {mm} {dd} {exifdate} {make} {model} {w} {h}; the extension follows the format', half: true },
      { key: 'start', label: 'Counter starts at', type: 'number', min: 0, value: 1, half: true },
      { key: 'case', label: 'Case', type: 'select', options: [{ value: 'keep', label: 'Keep' }, { value: 'lower', label: 'lower case' }, { value: 'upper', label: 'UPPER CASE' }, { value: 'title', label: 'Title Case' }], value: 'keep', half: true },
      { key: 'pad', label: 'Counter digits', type: 'number', min: 1, max: 8, value: 1, half: true },
      { key: 'find', label: 'Find', type: 'text', value: '', half: true }, { key: 'replace', label: 'Replace with', type: 'text', value: '', half: true },
      { key: 'regex', label: 'Find is a regular expression', type: 'checkbox', value: false },
    ],
    onChange: (v, ctl) => preview(v, ctl), onOpen: (ctl) => preview(ctl.values(), ctl) });
  if (!r) return;
  const job = build(r);
  const out = await chooseSink(app, 'Output folder for the batch');
  if (!out) return;
  const res = await runBatch(app, job, out.sink);
  await out.finish();
  journalOutputs(app, `Batch: ${res.done.length} file${res.done.length === 1 ? '' : 's'} to ${out.label}`, res.done, out.dirUri);
  summary(app, res, out.label);
}

def([
  { id: 'batch.convert', icon: 'dynamic_feed', popular: true, noRecord: true, isEnabled: (app) => app.folder.length > 0, tip: 'Convert, resize, rotate, recolor and rename many pictures at once; the marked thumbnails or the whole folder', run: (app) => batchDialog(app) },
  { id: 'batch.webPresets', icon: 'public', kind: 'menu', noRecord: true, isEnabled: (app) => app.folder.length > 0,
    menu: () => [{ id: 'batch.webPresets', arg: 'web', label: 'Web: longest side 1600, JPEG 80, no metadata' }, { id: 'batch.webPresets', arg: 'email', label: 'Email: longest side 1024, JPEG 75, no metadata' }, { id: 'batch.webPresets', arg: 'hd', label: 'HD screen: longest side 1920, JPEG 85' }, { id: 'batch.webPresets', arg: 'thumb', label: 'Thumbnails: longest side 400, JPEG 70, no metadata' }],
    run: (app, arg?: string) => batchDialog(app, ({ web: { format: 'jpeg', quality: 80, long: 1600, strip: true, title: 'Web Size' }, email: { format: 'jpeg', quality: 75, long: 1024, strip: true, title: 'Email Size' }, hd: { format: 'jpeg', quality: 85, long: 1920, strip: false, title: 'HD Screen Size' }, thumb: { format: 'jpeg', quality: 70, long: 400, strip: true, title: 'Thumbnail Size' } } as any)[arg || 'web']) },
  { id: 'batch.dryRun', icon: 'preview', noRecord: true, isEnabled: (app) => app.folder.length > 0, tip: 'The batch dialog shows every output name before anything is written', run: (app) => batchDialog(app, { title: 'Preview Batch (names, then Run)' }) },
  {
    id: 'batch.rename', icon: 'drive_file_rename_outline', noRecord: true, isEnabled: (app) => app.folder.length > 0 && fileOpCaps(app.tab.entry?.uri || null, dirUriOf(app.tab.entry, app.tab.folder)).rename,
    tip: 'Renames the files in place with a pattern; live preview; one Undo File Operation takes it all back',
    run: async (app) => {
      const { entries, marked } = inputsOf(app);
      const tab = app.tab;
      const dirUri = dirUriOf(tab.entry, tab.folder);
      const build = (v: Record<string, any>): NameOptions => ({ pattern: v.pattern || '{name}', start: +v.start || 1, step: 1, pad: +v.pad || 1, case: v.case, find: v.find || undefined, replace: v.replace || '', regex: !!v.regex });
      const staying = tab.folder.entries.filter((e) => !entries.includes(e)).map((e) => e.name.toLowerCase()); // files not in the rename keep their names
      const plan = (o: NameOptions) => { const used = new Set<string>(staying); return entries.map((e, i) => uniqueName(`${expandName(o, { name: base(e.name), ext: extOf(e.name), index: i, date: e.mtime ? new Date(e.mtime) : new Date() })}.${extOf(e.name)}`, used)); };
      const preview = (v: Record<string, any>, ctl: any) => { const names = plan(build(v)); ctl.setPreview(`<table class="ql-stats qn-info" style="font-size:12px">${entries.slice(0, 300).map((e, i) => `<tr><td>${esc(e.name)}</td><td>→</td><td>${names[i] === e.name ? '<span class="ql-help">(unchanged)</span>' : esc(names[i])}</td></tr>`).join('')}</table>`); };
      const r = await openDialog({ title: 'Batch Rename', wide: true, ok: 'Rename', preview: true, previewStyle: 'max-height:40vh;overflow:auto', help: `${entries.length} file${entries.length === 1 ? '' : 's'}${marked ? ' (the marked thumbnails)' : ''} are renamed in place. {name} {n} {n:4} {date} {time} {yyyy} {mm} {dd} {exifdate}; the extension stays.`,
        fields: [
          { key: 'pattern', label: 'Pattern', type: 'text', value: '{name}', half: true }, { key: 'start', label: 'Counter starts at', type: 'number', min: 0, value: 1, half: true },
          { key: 'case', label: 'Case', type: 'select', options: [{ value: 'keep', label: 'Keep' }, { value: 'lower', label: 'lower case' }, { value: 'upper', label: 'UPPER CASE' }, { value: 'title', label: 'Title Case' }], value: 'keep', half: true }, { key: 'pad', label: 'Counter digits', type: 'number', min: 1, max: 8, value: 3, half: true },
          { key: 'find', label: 'Find', type: 'text', value: '', half: true }, { key: 'replace', label: 'Replace with', type: 'text', value: '', half: true },
          { key: 'regex', label: 'Find is a regular expression', type: 'checkbox', value: false },
        ], onChange: (v, ctl) => preview(v, ctl), onOpen: (ctl) => preview(ctl.values(), ctl) });
      if (!r) return;
      const names = plan(build(r));
      const changes = entries.map((e, i) => ({ e, to: names[i] })).filter((c) => c.to !== c.e.name && c.e.uri);
      if (!changes.length) { toast('Nothing to rename.'); return; }
      if (!(await confirmDialog('Batch Rename', `Rename ${changes.length} file${changes.length === 1 ? '' : 's'}?`, 'Rename'))) return;
      const undoList: { uri: string; from: string }[] = [], stranded: string[] = [];
      let n = 0;
      // Two passes avoid collisions when names rotate (a→b, b→a): first to temporary names, then to the targets.
      const temps = changes.map((c, i) => ({ c, tmp: `.ql-batch-${Date.now()}-${i}.${extOf(c.e.name)}` }));
      const current = new Map<Entry, Entry>();
      for (const { c, tmp } of temps) { try { const t = await renameFile(c.e.uri!, dirUri, tmp); const te = entryFromUri({ uri: t.uri, name: t.name, size: c.e.size, mtime: c.e.mtime }); replaceEntry(tab, c.e, te); current.set(c.e, te); } catch (err: any) { stranded.push(`${c.e.name}: ${err?.message || err}`); } }
      for (const { c } of temps) {
        const cur = current.get(c.e); if (!cur) continue;
        try { const t = await renameFile(cur.uri!, dirUri, c.to); const ne = entryFromUri({ uri: t.uri, name: t.name, size: c.e.size, mtime: c.e.mtime }); replaceEntry(tab, cur, ne); undoList.push({ uri: ne.uri!, from: c.e.name }); current.set(c.e, ne); n++; }
        catch (err: any) {
          // Back to its old name; if another file took that name meanwhile, to a visible free one, and say so (never left under the hidden temporary name).
          let back: { uri: string; name: string } | null = null;
          for (const cand of [c.e.name, ...Array.from({ length: 20 }, (_, k) => c.e.name.replace(/(\.[^.]+)?$/, ` (not renamed ${k + 1})$1`))]) { try { back = await renameFile(cur.uri!, dirUri, cand); break; } catch { /* try the next name */ } }
          if (back) replaceEntry(tab, cur, entryFromUri({ uri: back.uri, name: back.name, size: c.e.size, mtime: c.e.mtime }));
          stranded.push(back ? (back.name === c.e.name ? `${c.e.name}: ${err?.message || err}` : `${c.e.name} is now ${back.name}: ${err?.message || err}`) : `${c.e.name} is left as ${cur.name}: ${err?.message || err}`);
        }
      }
      tab.folder.sort(app.prefs.sort, app.prefs.sortDescending);
      app.refresh(); tab.thumbs.sync();
      app.journal.push({ kind: 'rename', label: `Batch rename: ${n} file${n === 1 ? '' : 's'}`, when: Date.now(), undo: async () => {
        for (const u of undoList.reverse()) { const e = tab.folder.entries.find((x) => x.uri === u.uri); if (!e) continue; const t = await renameFile(e.uri!, dirUri, u.from); replaceEntry(tab, e, entryFromUri({ uri: t.uri, name: t.name, size: e.size, mtime: e.mtime })); }
        tab.folder.sort(app.prefs.sort, app.prefs.sortDescending); app.refresh(); tab.thumbs.sync();
      } });
      toast(`${n} file${n === 1 ? '' : 's'} renamed${stranded.length ? `; ${stranded.length} not renamed (${stranded.slice(0, 3).join('; ')})` : ''}`, { ms: stranded.length ? 12000 : undefined, action: 'Undo', onAction: () => app.exec('file.undoFileOp') });
    },
  },
  {
    id: 'batch.lossless', icon: 'rotate_90_degrees_cw', noRecord: true, isEnabled: (app) => app.folder.length > 0, tip: 'Rotate, turn upright by EXIF, or optimize every JPEG without re-encoding',
    run: async (app) => {
      const { entries, marked } = inputsOf(app);
      const jpegs = entries.filter((e) => /\.(jpe?g|jfif|jpe)$/i.test(e.name));
      if (!jpegs.length) { toast('No JPEG files among the inputs.'); return; }
      const r = await openDialog({ title: 'Batch Lossless JPEG', ok: 'Run…', help: `${jpegs.length} JPEG file${jpegs.length === 1 ? '' : 's'}${marked ? ' among the marked thumbnails' : ' in the folder'}.`, fields: [
        { key: 'op', label: 'Operation', type: 'select', options: [{ value: 'exif', label: 'Turn upright by the EXIF orientation (and reset the tag)' }, { value: 'none', label: 'Optimize only (Huffman tables)' }, { value: 'rot90', label: 'Rotate 90° clockwise' }, { value: 'rot270', label: 'Rotate 90° counter-clockwise' }, { value: 'rot180', label: 'Rotate 180°' }, { value: 'flipH', label: 'Flip horizontal' }, { value: 'flipV', label: 'Flip vertical' }], value: 'exif' },
        { key: 'strip', label: 'Strip metadata', type: 'checkbox', value: false },
      ] });
      if (!r) return;
      const out = await chooseSink(app, 'Output folder for the lossless JPEGs');
      if (!out) return;
      const job: BatchJob = { inputs: jpegs, format: 'keep', quality: 100, keepMeta: !r.strip, steps: {}, names: { pattern: '{name}' }, lossless: { op: r.op, strip: !!r.strip } };
      const res = await runBatch(app, job, out.sink);
      await out.finish();
      journalOutputs(app, `Batch lossless JPEG: ${res.done.length} files to ${out.label}`, res.done, out.dirUri);
      summary(app, res, out.label);
    },
  },
  {
    id: 'batch.optimize', icon: 'compress', noRecord: true, isEnabled: (app) => app.folder.length > 0, tip: 'Lossless recompression of JPEG files (optimized Huffman tables); reports the bytes saved',
    run: async (app) => {
      const { entries } = inputsOf(app);
      const jpegs = entries.filter((e) => /\.(jpe?g|jfif|jpe)$/i.test(e.name));
      if (!jpegs.length) { toast('No JPEG files among the inputs (PNG optimization is planned).'); return; }
      const out = await chooseSink(app, 'Output folder for the optimized files');
      if (!out) return;
      let before = 0, after = 0;
      const job: BatchJob = { inputs: jpegs, format: 'keep', quality: 100, keepMeta: true, steps: {}, names: { pattern: '{name}' }, lossless: { op: 'none', strip: false } };
      const res = await runBatch(app, job, async (r) => { before += (await r.source.read()).byteLength; after += r.data.length; return out.sink(r); });
      await out.finish();
      journalOutputs(app, `Optimize: ${res.done.length} files to ${out.label}`, res.done, out.dirUri);
      toast(`${res.done.length} files: ${fmtSize(before)} → ${fmtSize(after)} (${before ? Math.round((100 * (before - after)) / before) : 0}% saved)`, { ms: 8000 });
    },
  },
  {
    id: 'batch.undo', icon: 'undo', noRecord: true, isEnabled: (app) => !!app.journal.last && /^(Batch|Optimize)/.test(app.journal.last.label), tip: 'Removes the files the last batch wrote (or restores renamed originals)',
    run: async (app) => {
      const op = app.journal.last;
      if (!op || !/^(Batch|Optimize)/.test(op.label)) { toast('The last file operation is not a batch; use Undo File Operation.'); return; }
      if (!op.undo) { toast(`${op.label} cannot be undone: ${op.noUndo || ''}`); return; }
      if (!(await confirmDialog('Undo Last Batch', `${op.label}: take it back?`, 'Undo'))) return;
      await app.journal.undoLast();
      toast(`Undone: ${op.label}`);
    },
  },
]);

export { parseExifDate };
