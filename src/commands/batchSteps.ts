/**
 * Batch tab, the steps engine: Batch Steps (an ordered list of resize, crop, rotate, canvas, color,
 * sharpen, text, overlay, border and metadata steps with the output settings), the Recipe Editor
 * (saved, named step lists), the Batch Queue (jobs running in the background with progress, pause
 * and cancel), Batch Watermark, Batch Metadata (XMP written in place) and Batch Multipage (split
 * multipage files into pictures, or join pictures into one TIFF or PDF).
 */
import { def } from './registry';
import type { App } from '../app';
import { openDialog, toast, confirmDialog } from '../ui/dialog';
import type { Field } from '../ui/dialog';
import { h } from '../ui/dom';
import { inputsOf, chooseSink, runBatch, summary, journalOutputs, type Action, type BatchJob, type BatchResult } from './batch';
import { patchXmp } from '../picture/metadata';
import type { XmpProps } from '../meta/xmp';
import { ENCODERS, decodePicture, encodeCanvas, type EncodeFormat } from '../codecs/registry';
import { fmtSize } from '../ui/shell';
import { encodeTiff } from '../codecs/tiffwrite';

const list = (s: string) => s.split(/[;,\n]/).map((x) => x.trim()).filter(Boolean);
const ANCHORS = [['tl', 'Top left'], ['tc', 'Top center'], ['tr', 'Top right'], ['ml', 'Middle left'], ['mc', 'Center'], ['mr', 'Middle right'], ['bl', 'Bottom left'], ['bc', 'Bottom center'], ['br', 'Bottom right']].map(([value, label]) => ({ value, label }));
const KINDS: { value: Action['kind']; label: string }[] = [['resize', 'Resize'], ['crop', 'Crop (percent)'], ['autoCrop', 'Auto crop borders'], ['rotate', 'Rotate by an angle'], ['flip', 'Flip'], ['canvas', 'Canvas size'], ['color', 'Brightness, contrast, gamma, saturation'], ['auto', 'Automatic correction'], ['grayscale', 'Grayscale'], ['negative', 'Negative'], ['colors', 'Reduce colors'], ['sharpen', 'Sharpen'], ['blur', 'Blur'], ['text', 'Text watermark'], ['overlay', 'Picture watermark'], ['border', 'Border'], ['metadata', 'Metadata']].map(([value, label]) => ({ value: value as Action['kind'], label }));

/** One line describing a step. */
export function describeAction(a: Action): string {
  switch (a.kind) {
    case 'resize': return `Resize ${a.mode === 'percent' ? `${a.value}%` : `${a.mode} ${a.value} px`}${a.onlyShrink ? ', shrink only' : ''}`;
    case 'crop': return `Crop ${a.w}×${a.h}% at ${a.x},${a.y}%`; case 'autoCrop': return `Auto crop (tolerance ${a.tolerance})`;
    case 'rotate': return `Rotate ${a.angle}°${a.expand ? ', expand' : ''}`; case 'flip': return a.dir === 'h' ? 'Flip horizontal' : 'Flip vertical';
    case 'canvas': return `Canvas ${a.w || 'auto'}×${a.h || 'auto'} (${a.anchor})`; case 'color': return `Color: brightness ${a.brightness}, contrast ${a.contrast}, gamma ${a.gamma}, saturation ${a.saturation}`;
    case 'auto': return `Auto ${a.what}`; case 'grayscale': return 'Grayscale'; case 'negative': return 'Negative'; case 'colors': return `Reduce to ${a.n} colors`;
    case 'sharpen': return `Sharpen ${a.amount}%`; case 'blur': return `Blur ${a.radius} px`; case 'text': return `Text "${a.text}" (${a.anchor})`; case 'overlay': return `Picture watermark ${Math.round(a.scale * 100)}% (${a.tile ? 'tiled' : a.anchor})`;
    case 'border': return `Border ${a.size} px`; case 'metadata': return `Metadata: ${Object.keys(a.patch).join(', ') || 'nothing'}`;
  }
}

/** The parameter dialog for one step kind (prefilled from `cur` when editing). Returns the action or null. */
async function editAction(kind: Action['kind'], cur?: Action): Promise<Action | null> {
  const c = (cur && cur.kind === kind ? cur : null) as any;
  const F = (fields: Field[], title: string) => openDialog({ title, ok: 'OK', fields });
  switch (kind) {
    case 'resize': { const r = await F([{ key: 'mode', label: 'Resize', type: 'select', options: [{ value: 'long', label: 'Longest side to' }, { value: 'width', label: 'Width to' }, { value: 'height', label: 'Height to' }, { value: 'percent', label: 'Percent' }], value: c?.mode || 'long', half: true }, { key: 'value', label: 'Pixels / percent', type: 'number', min: 1, max: 32768, value: c?.value || 1600, half: true }, { key: 'kernel', label: 'Resampling', type: 'select', options: [{ value: 'lanczos3', label: 'Lanczos 3' }, { value: 'bicubic', label: 'Bicubic' }, { value: 'bilinear', label: 'Bilinear' }, { value: 'nearest', label: 'Nearest' }], value: c?.kernel || 'lanczos3', half: true }, { key: 'onlyShrink', label: 'Only shrink', type: 'checkbox', value: c ? c.onlyShrink : true, half: true }], 'Resize'); return r ? { kind, mode: r.mode, value: +r.value, kernel: r.kernel, onlyShrink: !!r.onlyShrink } : null; }
    case 'crop': { const r = await F([{ key: 'x', label: 'Left (%)', type: 'number', min: 0, max: 99, value: c?.x ?? 10, half: true }, { key: 'y', label: 'Top (%)', type: 'number', min: 0, max: 99, value: c?.y ?? 10, half: true }, { key: 'w', label: 'Width (%)', type: 'number', min: 1, max: 100, value: c?.w ?? 80, half: true }, { key: 'h', label: 'Height (%)', type: 'number', min: 1, max: 100, value: c?.h ?? 80, half: true }], 'Crop'); return r ? { kind, x: +r.x, y: +r.y, w: +r.w, h: +r.h } : null; }
    case 'autoCrop': { const r = await F([{ key: 'tolerance', label: 'Tolerance', type: 'range', min: 0, max: 128, value: c?.tolerance ?? 16 }], 'Auto Crop Borders'); return r ? { kind, tolerance: +r.tolerance } : null; }
    case 'rotate': { const r = await F([{ key: 'angle', label: 'Angle (°, clockwise)', type: 'number', min: -360, max: 360, step: 0.1, value: c?.angle ?? 90, half: true }, { key: 'expand', label: 'Expand the canvas', type: 'checkbox', value: c ? c.expand : true, half: true }, { key: 'bg', label: 'Background', type: 'color', value: c?.bg || '#ffffff', half: true }], 'Rotate'); return r ? { kind, angle: +r.angle, expand: !!r.expand, bg: r.bg } : null; }
    case 'flip': { const r = await F([{ key: 'dir', label: 'Direction', type: 'radio', options: [{ value: 'h', label: 'Horizontal' }, { value: 'v', label: 'Vertical' }], value: c?.dir || 'h' }], 'Flip'); return r ? { kind, dir: r.dir } : null; }
    case 'canvas': { const r = await F([{ key: 'w', label: 'Width (px, 0 = keep)', type: 'number', min: 0, max: 32768, value: c?.w ?? 0, half: true }, { key: 'h', label: 'Height (px, 0 = keep)', type: 'number', min: 0, max: 32768, value: c?.h ?? 0, half: true }, { key: 'anchor', label: 'Anchor', type: 'select', options: ANCHORS, value: c?.anchor || 'mc', half: true }, { key: 'bg', label: 'Background', type: 'color', value: c?.bg || '#ffffff', half: true }, { key: 'transparent', label: 'Transparent', type: 'checkbox', value: !!c?.transparent, half: true }], 'Canvas Size'); return r ? { kind, w: +r.w, h: +r.h, anchor: r.anchor, bg: r.bg, transparent: !!r.transparent } : null; }
    case 'color': { const r = await F([{ key: 'brightness', label: 'Brightness', type: 'range', min: -255, max: 255, value: c?.brightness ?? 0, half: true }, { key: 'contrast', label: 'Contrast', type: 'range', min: -127, max: 127, value: c?.contrast ?? 0, half: true }, { key: 'gamma', label: 'Gamma (×100)', type: 'range', min: 10, max: 500, value: c ? Math.round(c.gamma * 100) : 100, half: true }, { key: 'saturation', label: 'Saturation', type: 'range', min: -255, max: 255, value: c?.saturation ?? 0, half: true }], 'Color Corrections'); return r ? { kind, brightness: +r.brightness, contrast: +r.contrast, gamma: +r.gamma / 100, saturation: +r.saturation } : null; }
    case 'auto': { const r = await F([{ key: 'what', label: 'Correction', type: 'select', options: [{ value: 'adjust', label: 'Auto-adjust colors' }, { value: 'levels', label: 'Auto levels' }, { value: 'contrast', label: 'Auto contrast' }, { value: 'color', label: 'Auto color (cast)' }], value: c?.what || 'adjust' }], 'Automatic Correction'); return r ? { kind, what: r.what } : null; }
    case 'grayscale': case 'negative': return { kind } as Action;
    case 'colors': { const r = await F([{ key: 'n', label: 'Colors', type: 'select', options: ['256', '64', '16', '2'].map((v) => ({ value: v, label: v })), value: String(c?.n || 256) }], 'Reduce Colors'); return r ? { kind, n: +r.n } : null; }
    case 'sharpen': { const r = await F([{ key: 'amount', label: 'Amount (%)', type: 'range', min: 10, max: 300, value: c?.amount ?? 100 }], 'Sharpen'); return r ? { kind, amount: +r.amount } : null; }
    case 'blur': { const r = await F([{ key: 'radius', label: 'Radius (px)', type: 'range', min: 1, max: 50, value: c?.radius ?? 3 }], 'Blur'); return r ? { kind, radius: +r.radius } : null; }
    case 'text': { const r = await F([{ key: 'text', label: 'Text ({name} {basename} {n} {date} {exifdate} {w} {h})', type: 'text', value: c?.text || '© {date}' }, { key: 'font', label: 'Font', type: 'combo', options: ['sans-serif', 'serif', 'monospace', 'Arial', 'Georgia', 'Impact'], value: c?.font || 'sans-serif', half: true }, { key: 'size', label: 'Size (% of the width)', type: 'number', min: 1, max: 50, step: 0.5, value: c ? c.size : 4, half: true }, { key: 'color', label: 'Color', type: 'color', value: c?.color || '#ffffff', half: true }, { key: 'outline', label: 'Outline (px)', type: 'number', min: 0, max: 20, value: c?.outline ?? 1, half: true }, { key: 'opacity', label: 'Opacity (%)', type: 'range', min: 1, max: 100, value: c ? Math.round(c.opacity * 100) : 80, half: true }, { key: 'anchor', label: 'Position', type: 'select', options: ANCHORS, value: c?.anchor || 'br', half: true }, { key: 'margin', label: 'Margin (% of the width)', type: 'number', min: 0, max: 50, value: c?.margin ?? 2, half: true }], 'Text Watermark'); return r ? { kind, text: r.text, font: r.font, size: +r.size, color: r.color, outline: +r.outline, opacity: +r.opacity / 100, anchor: r.anchor, margin: +r.margin } : null; }
    case 'overlay': { const r = await F([{ key: 'file', label: 'Picture (PNG with transparency works best)', type: 'file', accept: 'image/*' }, { key: 'scale', label: 'Width (% of the picture)', type: 'range', min: 1, max: 100, value: c ? Math.round(c.scale * 100) : 20, half: true }, { key: 'opacity', label: 'Opacity (%)', type: 'range', min: 1, max: 100, value: c ? Math.round(c.opacity * 100) : 50, half: true }, { key: 'anchor', label: 'Position', type: 'select', options: ANCHORS, value: c?.anchor || 'br', half: true }, { key: 'margin', label: 'Margin (% of the width)', type: 'number', min: 0, max: 50, value: c?.margin ?? 2, half: true }, { key: 'tile', label: 'Tile', type: 'checkbox', value: !!c?.tile, half: true }], 'Picture Watermark'); if (!r) return null; let dataUrl = c?.dataUrl || ''; if (r.file) dataUrl = await new Promise<string>((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.readAsDataURL(r.file as Blob); }); if (!dataUrl) { toast('Choose the watermark picture.'); return null; } return { kind, dataUrl, scale: +r.scale / 100, opacity: +r.opacity / 100, anchor: r.anchor, margin: +r.margin, tile: !!r.tile }; }
    case 'border': { const r = await F([{ key: 'size', label: 'Width (px)', type: 'number', min: 1, max: 2000, value: c?.size ?? 20, half: true }, { key: 'color', label: 'Color', type: 'color', value: c?.color || '#ffffff', half: true }], 'Border'); return r ? { kind, size: +r.size, color: r.color } : null; }
    case 'metadata': { const p = c?.patch || {}; const r = await F([{ key: 'title', label: 'Title', type: 'text', value: p.title || '', half: true }, { key: 'creator', label: 'Creator', type: 'text', value: (p.creator || []).join('; '), half: true }, { key: 'rights', label: 'Copyright', type: 'text', value: p.rights || '' }, { key: 'keywords', label: 'Keywords (;)', type: 'text', value: (p.keywords || []).join('; ') }, { key: 'description', label: 'Caption', type: 'textarea', rows: 2, value: p.description || '' }, { key: 'credit', label: 'Credit', type: 'text', value: p.credit || '', half: true }, { key: 'source', label: 'Source', type: 'text', value: p.source || '', half: true }], 'Metadata'); if (!r) return null; const patch: Record<string, any> = {}; if (r.title.trim()) patch.title = r.title.trim(); if (r.creator.trim()) patch.creator = list(r.creator); if (r.rights.trim()) patch.rights = r.rights.trim(); if (r.keywords.trim()) patch.keywords = list(r.keywords); if (r.description.trim()) patch.description = r.description.trim(); if (r.credit.trim()) patch.credit = r.credit.trim(); if (r.source.trim()) patch.source = r.source.trim(); return { kind, patch }; }
  }
  return null;
}

// Text watermark sizes are percentages of the width in the editor; the runner wants pixels per picture, so convert at run time.
function resolveActions(actions: Action[], width: number): Action[] {
  return actions.map((a) => (a.kind === 'text' ? { ...a, size: Math.max(6, Math.round((a.size / 100) * width)), margin: Math.round((a.margin / 100) * width) } : a.kind === 'overlay' ? { ...a, margin: Math.round((a.margin / 100) * width) } : a));
}

interface Recipe { name: string; actions: Action[]; format: string; quality: number; keepMeta: boolean; pattern: string }
const formatOptions = [{ value: 'keep', label: 'Same as the source' }, ...Object.entries(ENCODERS).map(([value, v]) => ({ value, label: v.label }))];

/** The Batch Steps dialog; returns the job settings or null. */
async function stepsDialog(app: App, init: Partial<Recipe> = {}, title = 'Batch Steps'): Promise<{ recipe: Recipe; queue: boolean } | null> {
  const { entries, marked } = inputsOf(app);
  const actions: Action[] = JSON.parse(JSON.stringify(init.actions || []));
  const opts = () => actions.map((a, i) => ({ value: String(i), label: `${i + 1}. ${describeAction(a)}` }));
  const fields = (): Field[] => [
    { key: 'steps', label: `Steps, in order (${entries.length} file${entries.length === 1 ? '' : 's'}${marked ? ', the marked thumbnails' : ''})`, type: 'list', options: opts(), rows: 7 },
    { key: 'kind', label: 'Add a step', type: 'select', options: KINDS, value: 'resize', half: true },
    { key: 'add', label: 'Add', type: 'button', half: true, onClick: async (v, ctl) => { const a = await editAction(v.kind); if (a) { actions.push(a); ctl.set('steps', opts()); ctl.set('steps', String(actions.length - 1)); } } },
    { key: 'edit', label: 'Edit the selected step', type: 'button', half: true, onClick: async (v, ctl) => { const i = +v.steps; if (!(i >= 0)) return; const a = await editAction(actions[i].kind, actions[i]); if (a) { actions[i] = a; ctl.set('steps', opts()); ctl.set('steps', String(i)); } } },
    { key: 'remove', label: 'Remove', type: 'button', half: true, onClick: (v, ctl) => { const i = +v.steps; if (!(i >= 0)) return; actions.splice(i, 1); ctl.set('steps', opts()); } },
    { key: 'up', label: 'Move up', type: 'button', half: true, onClick: (v, ctl) => { const i = +v.steps; if (!(i > 0)) return; [actions[i - 1], actions[i]] = [actions[i], actions[i - 1]]; ctl.set('steps', opts()); ctl.set('steps', String(i - 1)); } },
    { key: 'down', label: 'Move down', type: 'button', half: true, onClick: (v, ctl) => { const i = +v.steps; if (!(i >= 0 && i < actions.length - 1)) return; [actions[i + 1], actions[i]] = [actions[i], actions[i + 1]]; ctl.set('steps', opts()); ctl.set('steps', String(i + 1)); } },
    { key: 'h2', type: 'heading', label: 'Output' },
    { key: 'format', label: 'Format', type: 'select', options: formatOptions, value: init.format || 'keep', half: true },
    { key: 'quality', label: 'Quality', type: 'range', min: 1, max: 100, value: init.quality || app.prefs.jpegQuality, half: true },
    { key: 'pattern', label: 'Name pattern', type: 'text', value: init.pattern || '{name}', half: true }, { key: 'keepMeta', label: 'Keep metadata', type: 'checkbox', value: init.keepMeta ?? true, half: true },
    { key: 'name', label: 'Recipe name (to save)', type: 'text', value: init.name || '', half: true },
    { key: 'save', label: 'Save as recipe', type: 'button', half: true, onClick: (v) => { const name = String(v.name || '').trim(); if (!name) { toast('Name the recipe first.'); return; } app.prefs.batchRecipes = [...app.prefs.batchRecipes.filter((r) => r.name !== name), { name, actions: JSON.parse(JSON.stringify(actions)), format: v.format, quality: +v.quality, keepMeta: !!v.keepMeta, pattern: v.pattern || '{name}' }]; app.savePrefs(); toast(`Recipe "${name}" saved`); } },
  ];
  let queue = false;
  const r = await openDialog({ title, wide: true, ok: 'Run…', fields: fields(), help: 'Steps run top to bottom on every picture; then the file is written in the chosen format. Outputs go to a folder you choose; the originals stay.', buttons: [{ label: 'Add to queue', onClick: (v, ctl) => { queue = true; ctl.close(v); } }] });
  if (!r) return null;
  return { recipe: { name: String(r.name || ''), actions, format: r.format, quality: +r.quality || 85, keepMeta: !!r.keepMeta, pattern: r.pattern || '{name}' }, queue };
}

function jobFrom(app: App, recipe: Recipe): BatchJob {
  const { entries } = inputsOf(app);
  return { inputs: entries, format: recipe.format as EncodeFormat | 'keep', quality: recipe.quality, keepMeta: recipe.keepMeta, steps: { actions: recipe.actions }, names: { pattern: recipe.pattern } };
}

// The queue ---------------------------------------------------------------------------------------
interface QueueItem { id: number; label: string; job: BatchJob; state: 'waiting' | 'running' | 'paused' | 'done' | 'failed' | 'canceled'; progress: [number, number]; current: string; result?: string; sink: (r: BatchResult) => Promise<{ uri: string | null; name: string }>; finish: () => Promise<void>; where: string; dirUri: string | null; cancelFlag: boolean }
const queue: QueueItem[] = [];
let queueSeq = 0, queueRunning = false, queuePaused = false;
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };
async function pumpQueue(app: App): Promise<void> {
  if (queueRunning) return; queueRunning = true;
  try {
    for (;;) {
      const item = queue.find((q) => q.state === 'waiting'); if (!item) break;
      item.state = 'running'; notify();
      try {
        const res = await runBatch(app, item.job, item.sink, { silent: true, control: { paused: () => queuePaused, canceled: () => item.cancelFlag, progress: (i, n, name) => { item.progress = [i, n]; item.current = name; item.state = queuePaused ? 'paused' : 'running'; notify(); } } });
        await item.finish();
        journalOutputs(app, `${item.label}: ${res.done.length} file${res.done.length === 1 ? '' : 's'} to ${item.where}`, res.done, item.dirUri);
        item.state = res.canceled ? 'canceled' : 'done'; item.result = `${res.done.length} written${res.failed.length ? `, ${res.failed.length} failed` : ''}`;
        toast(`${item.label}: ${item.result}`, { ms: 4000 });
      } catch (e: any) { item.state = 'failed'; item.result = e?.message || String(e); }
      notify();
    }
  } finally { queueRunning = false; }
}
async function enqueue(app: App, label: string, job: BatchJob): Promise<void> {
  const out = await chooseSink(app, `Output folder for "${label}"`);
  if (!out) return;
  queue.push({ id: ++queueSeq, label, job, state: 'waiting', progress: [0, job.inputs.length], current: '', sink: out.sink, finish: out.finish, where: out.label, dirUri: out.dirUri, cancelFlag: false });
  toast(`${label} queued (${job.inputs.length} file${job.inputs.length === 1 ? '' : 's'}); Batch Queue shows progress.`);
  void pumpQueue(app);
}

async function runNow(app: App, label: string, job: BatchJob): Promise<void> {
  const out = await chooseSink(app, 'Output folder for the batch');
  if (!out) return;
  const res = await runBatch(app, job, out.sink);
  await out.finish();
  journalOutputs(app, `${label}: ${res.done.length} file${res.done.length === 1 ? '' : 's'} to ${out.label}`, res.done, out.dirUri);
  summary(app, res, out.label);
}

async function runRecipe(app: App, recipe: Recipe, queueIt: boolean): Promise<void> {
  const base = jobFrom(app, recipe);
  // Text sizes are relative; resolve per picture inside processOne by giving the runner a per-picture resolver through a wrapper action list.
  const job: BatchJob = { ...base, steps: { actions: base.steps.actions } };
  const first = app.picture?.width || 1600;
  job.steps.actions = resolveActions(recipe.actions, first);
  const label = recipe.name || 'Batch Steps';
  if (queueIt) await enqueue(app, label, job); else await runNow(app, label, job);
}

/** One split page: PNG and JPEG through the platform, TIFF through the app's own writer (the platform has no TIFF encoder; W25). */
export async function encodePage(c: HTMLCanvasElement, format: string): Promise<Uint8Array> {
  if (format === 'tiff') {
    const id = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height);
    let alpha = false; for (let i = 3; i < id.data.length; i += 4) if (id.data[i] < 255) { alpha = true; break; }
    return encodeTiff([{ raster: { width: c.width, height: c.height, data: id.data as Uint8ClampedArray<ArrayBuffer> }, alpha }]);
  }
  return new Uint8Array(await (await encodeCanvas(c, format as EncodeFormat, 0.92)).arrayBuffer());
}

def([
  {
    id: 'batch.actions', icon: 'format_list_numbered', popular: true, noRecord: true, isEnabled: (app) => app.folder.length > 0, tip: 'An ordered list of steps (resize, crop, rotate, canvas, color, sharpen, watermark, text, metadata…) run on many pictures; save it as a recipe',
    run: async (app) => { const r = await stepsDialog(app); if (!r) return; if (!r.recipe.actions.length && r.recipe.format === 'keep') { toast('Add at least one step or choose an output format.'); return; } await runRecipe(app, r.recipe, r.queue); },
  },
  {
    id: 'batch.recipe', icon: 'menu_book', noRecord: true, isEnabled: () => true, tip: 'Saved, named step lists: run, edit, duplicate or delete',
    run: async (app) => {
      const recipes = () => app.prefs.batchRecipes as Recipe[];
      const opts = () => recipes().map((r) => ({ value: r.name, label: `${r.name} — ${r.actions.length} step${r.actions.length === 1 ? '' : 's'}, ${r.format === 'keep' ? 'same format' : ENCODERS[r.format as EncodeFormat]?.label || r.format}` }));
      let action: { what: 'run' | 'edit'; name: string } | null = null;
      const r = await openDialog({ title: 'Recipe Editor', wide: true, ok: 'Close', cancel: false, help: recipes().length ? 'Pick a recipe. Run applies it to the marked thumbnails or the folder.' : 'No recipes yet: build steps in Batch Steps and save them with a name.', fields: [
        { key: 'recipe', label: 'Recipes', type: 'list', options: opts(), rows: 6 },
        { key: 'run', label: 'Run on the pictures…', type: 'button', half: true, onClick: (v, ctl) => { if (v.recipe) { action = { what: 'run', name: v.recipe }; ctl.close(v); } } },
        { key: 'edit', label: 'Edit in Batch Steps…', type: 'button', half: true, onClick: (v, ctl) => { if (v.recipe) { action = { what: 'edit', name: v.recipe }; ctl.close(v); } } },
        { key: 'dup', label: 'Duplicate', type: 'button', half: true, onClick: (v, ctl) => { const src = recipes().find((x) => x.name === v.recipe); if (!src) return; let name = `${src.name} copy`; while (recipes().some((x) => x.name === name)) name += ' 2'; app.prefs.batchRecipes = [...recipes(), { ...JSON.parse(JSON.stringify(src)), name }]; app.savePrefs(); ctl.set('recipe', opts()); } },
        { key: 'del', label: 'Delete', type: 'button', half: true, onClick: async (v, ctl) => { if (!v.recipe || !(await confirmDialog('Delete Recipe', `Delete "${v.recipe}"?`, 'Delete'))) return; app.prefs.batchRecipes = recipes().filter((x) => x.name !== v.recipe); app.savePrefs(); ctl.set('recipe', opts()); } },
        { key: 'export', label: 'Copy as JSON', type: 'button', half: true, onClick: (v) => { const src = recipes().find((x) => x.name === v.recipe); if (src) { navigator.clipboard?.writeText(JSON.stringify(src, null, 2)); toast('Copied'); } } },
        { key: 'import', label: 'Paste JSON as a new recipe', type: 'button', half: true, onClick: async (_v, ctl) => { try { const t = await navigator.clipboard.readText(); const j = JSON.parse(t); if (!j || typeof j.name !== 'string' || !Array.isArray(j.actions)) throw new Error('not a recipe'); app.prefs.batchRecipes = [...recipes().filter((x) => x.name !== j.name), { name: j.name, actions: j.actions, format: j.format || 'keep', quality: +j.quality || 85, keepMeta: j.keepMeta !== false, pattern: j.pattern || '{name}' }]; app.savePrefs(); ctl.set('recipe', opts()); } catch { toast('The clipboard does not hold a recipe.'); } } },
      ] });
      void r;
      const chosen = action as { what: 'run' | 'edit'; name: string } | null;
      if (!chosen) return;
      const rec = recipes().find((x) => x.name === chosen.name); if (!rec) return;
      if (chosen.what === 'run') { if (!app.folder.length) { toast('Open a folder first.'); return; } await runRecipe(app, rec, false); }
      else { const e = await stepsDialog(app, rec, `Batch Steps — ${rec.name}`); if (e) await runRecipe(app, e.recipe, e.queue); }
    },
  },
  {
    id: 'batch.queue', icon: 'pending_actions', noRecord: true, isEnabled: () => true, tip: 'Background batch jobs with progress; pause, resume and cancel',
    run: async (app) => {
      const body = h('div', { class: 'qn-queue' });
      const draw = () => { body.replaceChildren(...(queue.length ? queue.map((q) => h('div', { class: `qn-queue-item qn-q-${q.state}` }, h('div', null, h('b', null, q.label), ` — ${q.state}${q.result ? `: ${q.result}` : ''}`), h('progress', { max: String(q.progress[1]), value: String(q.progress[0]), style: 'width:100%' }), h('div', { class: 'ql-help' }, q.state === 'running' || q.state === 'paused' ? `${q.progress[0]} / ${q.progress[1]}${q.current ? `: ${q.current}` : ''}` : `${q.job.inputs.length} file${q.job.inputs.length === 1 ? '' : 's'} → ${q.where}`), q.state === 'waiting' || q.state === 'running' || q.state === 'paused' ? h('button', { class: 'ql-btn', onclick: () => { q.cancelFlag = true; if (q.state === 'waiting') q.state = 'canceled'; notify(); } }, 'Cancel') : null)) : [h('p', { class: 'ql-help' }, 'The queue is empty. Batch Steps ▸ Add to queue puts a job here.')])); };
      const l = () => draw(); listeners.add(l); draw();
      await openDialog({ title: 'Batch Queue', wide: true, ok: 'Close', cancel: false, content: body, buttons: [
        { label: queuePaused ? 'Resume' : 'Pause', onClick: (_v, ctl) => { queuePaused = !queuePaused; notify(); ctl.close({}); void app.exec('batch.queue'); } },
        { label: 'Clear finished', onClick: () => { for (let i = queue.length - 1; i >= 0; i--) if (['done', 'failed', 'canceled'].includes(queue[i].state)) queue.splice(i, 1); notify(); } },
      ] });
      listeners.delete(l);
    },
  },
  {
    id: 'batch.watermark', icon: 'branding_watermark', noRecord: true, isEnabled: (app) => app.folder.length > 0, tip: 'Text or a picture on every picture, then the output settings',
    run: async (app) => {
      const kind = await openDialog({ title: 'Batch Watermark', ok: 'Next', fields: [{ key: 'kind', label: 'Watermark', type: 'radio', options: [{ value: 'text', label: 'Text' }, { value: 'overlay', label: 'A picture (logo)' }], value: 'text' }] });
      if (!kind) return;
      const a = await editAction(kind.kind); if (!a) return;
      const r = await stepsDialog(app, { actions: [a], format: 'jpeg', quality: app.prefs.jpegQuality, keepMeta: true, pattern: '{name}-wm' }, 'Batch Watermark'); if (!r) return;
      await runRecipe(app, r.recipe, r.queue);
    },
  },
  {
    id: 'batch.metadata', icon: 'edit_note', noRecord: true, isEnabled: (app) => app.folder.length > 0, tip: 'Writes title, caption, creator, copyright, keywords, credit and source into the marked pictures (or the folder) in place',
    run: async (app) => {
      const { entries, marked } = inputsOf(app);
      const a = await editAction('metadata'); if (!a || a.kind !== 'metadata') return;
      if (!Object.keys(a.patch).length) { toast('Nothing to write.'); return; }
      const mode = await openDialog({ title: 'Batch Metadata', ok: 'Write', help: `${entries.length} file${entries.length === 1 ? '' : 's'}${marked ? ' (the marked thumbnails)' : ''}: ${Object.keys(a.patch).join(', ')}.`, fields: [{ key: 'keywords', label: 'Keywords', type: 'select', options: [{ value: 'add', label: 'Add to the existing keywords' }, { value: 'replace', label: 'Replace the keywords' }], value: 'add' }] });
      if (!mode) return;
      let ok = 0, failed = 0, i = 0;
      for (const e of entries) {
        i++; if (i % 5 === 0) toast(`Writing ${i} of ${entries.length}…`, { ms: 700 });
        const patch: Partial<XmpProps> = { ...a.patch };
        if (patch.keywords && mode.keywords === 'add') { const { readMeta } = await import('../picture/metadata'); const cur = (await readMeta(app, e))?.props.keywords || []; patch.keywords = [...new Set([...cur, ...patch.keywords])]; }
        const r = await patchXmp(app, e, patch);
        if (r === 'canceled') break; if (r === 'written' || r === 'sidecar' || r === 'savedAs') ok++; else failed++;
      }
      app.tab.thumbs.sync(); app.refresh();
      toast(`Metadata written to ${ok} file${ok === 1 ? '' : 's'}${failed ? `, ${failed} could not be written` : ''}`);
    },
  },
  {
    id: 'batch.multipage', icon: 'auto_stories', noRecord: true, isEnabled: (app) => app.folder.length > 0, tip: 'Split multipage TIFF, PDF-like and animated files into one picture per page, or join the pictures into one TIFF or PDF',
    run: async (app) => {
      const { entries } = inputsOf(app);
      const r = await openDialog({ title: 'Batch Multipage', ok: 'Run', fields: [{ key: 'mode', label: 'Action', type: 'radio', options: [{ value: 'split', label: `Split: every page or frame of the ${entries.length} file${entries.length === 1 ? '' : 's'} becomes a picture` }, { value: 'join', label: 'Join the pictures into one multipage TIFF or PDF…' }], value: 'split' }, { key: 'format', label: 'Page format', type: 'select', options: [{ value: 'png', label: 'PNG' }, { value: 'jpeg', label: 'JPEG' }, { value: 'tiff', label: 'TIFF' }], value: 'png', visibleIf: (v) => v.mode === 'split' }] });
      if (!r) return;
      if (r.mode === 'join') { await app.exec('create.multipage'); return; }
      const out = await chooseSink(app, 'Output folder for the pages'); if (!out) return;
      const done: { name: string; uri: string | null; source: typeof entries[number] }[] = []; let failed = 0, i = 0, firstError = '';
      for (const e of entries) {
        i++; toast(`${i} / ${entries.length}: ${e.name}`, { ms: 700 });
        try {
          const pic = await decodePicture(new Uint8Array(await e.read()), e);
          try {
            const frames = pic.multipage ? pic.pages.map((p) => p.frames[0]) : pic.current.frames;
            const base = e.name.replace(/\.[^.]+$/, '');
            for (let k = 0; k < frames.length; k++) { const f = frames[k]; const c = document.createElement('canvas'); c.width = f.width; c.height = f.height; c.getContext('2d')!.drawImage(f.image as CanvasImageSource, 0, 0); const data = await encodePage(c, r.format); const w = await out.sink({ name: `${base}-${String(k + 1).padStart(3, '0')}.${r.format === 'tiff' ? 'tif' : ENCODERS[r.format as EncodeFormat].ext}`, data, source: e }); done.push({ name: w.name, uri: w.uri, source: e }); }
          } finally { pic.release(); }
        } catch (err: any) { failed++; if (!firstError) firstError = `${e.name}: ${err?.message || err}`; }
      }
      await out.finish();
      journalOutputs(app, `Split pages: ${done.length} to ${out.label}`, done, out.dirUri);
      toast(`${done.length} page${done.length === 1 ? '' : 's'} written to ${out.label}${failed ? `; ${failed} file${failed === 1 ? '' : 's'} failed (${firstError})` : ''}`, { ms: failed ? 8000 : 4000 });
    },
  },
]);
export { resolveActions };
export const queueState = () => queue;
