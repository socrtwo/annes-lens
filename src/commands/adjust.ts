/**
 * Adjust tab (M4 start): automatic corrections, tone, color and detail commands with a live preview
 * dialog. Edits are undoable steps on the pixels; the non-destructive stack, presets and curves come
 * later. Every command respects the rectangle selection.
 */
import { def } from './registry';
import type { App } from '../app';
import { openDialog, toast } from '../ui/dialog';
import type { Field } from '../ui/dialog';
import { editSelection, editRaster, frameRaster, rasterFrame } from '../picture/edit';
import type { Picture } from '../picture/model';
import { h, esc } from '../ui/dom';
import { openDocuments } from '../platform/native';
import { crop, resample, hexToRgb } from '../picture/ops';
import * as A from '../picture/adjust';
import type { Raster } from '../codecs/raster';

const has = (app: App) => !!app.picture;

/** Applied adjustment steps per picture (for Copy/Paste Adjustments and presets), and how to replay each command id. */
export interface Step { id: string; values: Record<string, any> }
const applied = new WeakMap<Picture, Step[]>();
export const STEP_FNS = new Map<string, { fn: (r: Raster, v: Record<string, any>) => Raster; whole?: boolean; label: string }>();
export function recordStep(app: App, step: Step): void { const pic = app.picture; if (!pic) return; const l = applied.get(pic) || []; l.push(step); applied.set(pic, l); }
export const stepsOf = (pic: Picture | null): Step[] => (pic ? applied.get(pic) || [] : []);
let clipboard: Step[] = [];
/** A no-dialog adjustment: applied to the selection and recorded as a step of the running command. */
function applyPlain(app: App, label: string, fn: (r: Raster) => Raster): void { editSelection(app, label, fn); const id = app.lastCommand?.id; if (id) { STEP_FNS.set(id, { fn: (r) => fn(r), label }); recordStep(app, { id, values: {} }); } }
/** Replays steps on the current picture (selection respected unless the step changes the canvas). */
export function replaySteps(app: App, steps: Step[], label: string): number {
  let n = 0;
  for (const st of steps) { const f = STEP_FNS.get(st.id); if (!f) continue; if (f.whole) editRaster(app, label, (x) => f.fn(x, st.values)); else editSelection(app, label, (x) => f.fn(x, st.values)); recordStep(app, st); n++; }
  return n;
}

/** A dialog whose preview shows `fn` applied to a small copy of the selection (or picture); OK applies it at full size. */
export async function adjustDialog(app: App, title: string, fields: Field[], fn: (r: Raster, v: Record<string, any>) => Raster, opts: { help?: string; ok?: string; label?: string; id?: string; extra?: (ctl: any, rerender: () => void) => void; buttons?: any[] } = {}): Promise<Record<string, any> | null> {
  const pic = app.picture!;
  const full = frameRaster(pic.currentFrame);
  const sel = app.tab.selection;
  const region = sel ? crop(full, sel) : full;
  const k = Math.min(1, 420 / Math.max(region.width, region.height));
  const small = k < 1 ? resample(region, Math.round(region.width * k), Math.round(region.height * k), 'bilinear') : region;
  const before = (rasterFrame(small, 0).image as HTMLCanvasElement).toDataURL();
  let seq = 0, busy = false, pending: Record<string, any> | null = null;
  const render = async (v: Record<string, any>, ctl: any) => {
    if (busy) { pending = v; return; }
    busy = true;
    const my = ++seq;
    await new Promise((r) => setTimeout(r, 0));
    try {
      const out = fn(small, v);
      if (my === seq) ctl.setPreview(`<div class="ql-sxs"><figure><img src="${before}"><figcaption>Before</figcaption></figure><figure><img src="${(rasterFrame(out, 0).image as HTMLCanvasElement).toDataURL()}"><figcaption>After</figcaption></figure></div>`);
    } catch (e: any) { ctl.setPreview(`<div class="ql-help">${esc(String(e?.message || e))}</div>`); }
    busy = false;
    if (pending) { const p = pending; pending = null; void render(p, ctl); }
  };
  const r = await openDialog({ title, wide: true, ok: opts.ok || 'Apply', preview: true, help: opts.help, fields, buttons: opts.buttons, onChange: (v, ctl) => { void render(v, ctl); }, onOpen: (ctl) => { opts.extra?.(ctl, () => void render(ctl.values(), ctl)); void render(ctl.values(), ctl); } });
  if (!r) return null;
  toast('Applying…', { ms: 1200 });
  await new Promise((res) => setTimeout(res, 20));
  editSelection(app, opts.label || title.replace(/…$/, ''), (x) => fn(x, r));
  const id = opts.id || app.lastCommand?.id;
  if (id) { STEP_FNS.set(id, { fn, label: opts.label || title.replace(/…$/, '') }); recordStep(app, { id, values: r }); }
  return r;
}

export const range = (key: string, label: string, min: number, max: number, value: number, half = true, step?: number): Field => ({ key, label, type: 'range', min, max, value, half, step });

def([
  // Automatic ------------------------------------------------------------------------------
  { id: 'adjust.auto', icon: 'auto_fix_high', popular: true, edits: true, isEnabled: has, tip: 'Auto levels plus a touch of saturation (IrfanView\'s Auto adjust colors)', run: (app) => applyPlain(app, 'Auto-Adjust Colors', A.autoAdjust) },
  { id: 'adjust.enhance', icon: 'auto_awesome', popular: true, edits: true, isEnabled: has, tip: 'Tone, color and gentle sharpening in one step', run: (app) => applyPlain(app, 'One-Click Enhance', A.enhance) },
  { id: 'adjust.autoLevels', icon: 'tune', edits: true, isEnabled: has, run: (app) => applyPlain(app, 'Auto Levels', (r) => A.autoLevels(r)) },
  { id: 'adjust.autoContrast', icon: 'contrast', edits: true, isEnabled: has, run: (app) => applyPlain(app, 'Auto Contrast', (r) => A.autoContrast(r)) },
  { id: 'adjust.autoColor', icon: 'palette', edits: true, isEnabled: has, tip: 'Removes a color cast (gray-world)', run: (app) => applyPlain(app, 'Auto Color', (r) => A.autoColor(r)) },
  { id: 'adjust.autoWhiteBalance', icon: 'wb_auto', edits: true, isEnabled: has, run: (app) => applyPlain(app, 'Auto White Balance', (r) => A.autoColor(r, 0.8)) },

  // Tone -----------------------------------------------------------------------------------
  {
    id: 'adjust.colorCorrections', icon: 'tune', popular: true, edits: true, isEnabled: has, tip: 'Brightness, contrast, gamma, saturation and color balance with a live preview',
    run: (app) => adjustDialog(app, 'Color Corrections…', [range('brightness', 'Brightness', -255, 255, 0), range('contrast', 'Contrast', -127, 127, 0), range('gamma', 'Gamma (×100)', 1, 699, 100), range('saturation', 'Saturation', -255, 255, 0), range('red', 'Red balance', -255, 255, 0), range('green', 'Green balance', -255, 255, 0), range('blue', 'Blue balance', -255, 255, 0)],
      (r, v) => A.colorCorrect(r, { brightness: +v.brightness, contrast: +v.contrast, gamma: +v.gamma / 100, saturation: +v.saturation, red: +v.red, green: +v.green, blue: +v.blue })),
  },
  { id: 'adjust.brightnessContrast', icon: 'brightness_6', edits: true, isEnabled: has, run: (app) => adjustDialog(app, 'Brightness and Contrast…', [range('brightness', 'Brightness', -255, 255, 0), range('contrast', 'Contrast', -127, 127, 0)], (r, v) => A.colorCorrect(r, { brightness: +v.brightness, contrast: +v.contrast })) },
  { id: 'adjust.exposure', icon: 'exposure', edits: true, isEnabled: has, run: (app) => adjustDialog(app, 'Exposure…', [range('ev', 'Exposure (EV × 100)', -300, 300, 0, false)], (r, v) => A.colorCorrect(r, { exposure: +v.ev / 100 })) },
  { id: 'adjust.gamma', icon: 'gradient', edits: true, isEnabled: has, run: (app) => adjustDialog(app, 'Gamma…', [range('gamma', 'Gamma (×100)', 10, 500, 100, false)], (r, v) => A.colorCorrect(r, { gamma: +v.gamma / 100 })) },
  {
    id: 'adjust.levels', icon: 'bar_chart', edits: true, isEnabled: has, tip: 'Input black, gamma and white points; output range; per channel',
    run: (app) => adjustDialog(app, 'Levels…', [
      { key: 'channel', label: 'Channel', type: 'select', options: [{ value: 'all', label: 'RGB' }, { value: 'r', label: 'Red' }, { value: 'g', label: 'Green' }, { value: 'b', label: 'Blue' }], value: 'all', half: true }, range('gamma', 'Gamma (×100)', 10, 500, 100),
      range('inBlack', 'Input black', 0, 254, 0), range('inWhite', 'Input white', 1, 255, 255), range('outBlack', 'Output black', 0, 254, 0), range('outWhite', 'Output white', 1, 255, 255),
    ], (r, v) => A.levels(r, { inBlack: +v.inBlack, inWhite: Math.max(+v.inBlack + 1, +v.inWhite), gamma: +v.gamma / 100, outBlack: +v.outBlack, outWhite: +v.outWhite, channel: v.channel })),
  },
  { id: 'adjust.shadowsHighlights', icon: 'flare', edits: true, isEnabled: has, run: (app) => adjustDialog(app, 'Shadows and Highlights…', [range('shadows', 'Lift shadows', 0, 100, 30), range('highlights', 'Tame highlights', 0, 100, 0), range('radius', 'Radius', 2, 80, 20, false)], (r, v) => A.shadowsHighlights(r, +v.shadows, +v.highlights, +v.radius)) },
  { id: 'adjust.fillLight', icon: 'light_mode', edits: true, isEnabled: has, run: (app) => applyPlain(app, 'Fill Light', (r) => A.shadowsHighlights(r, 40, 0, 20)) },
  { id: 'adjust.equalize', icon: 'equalizer', edits: true, isEnabled: has, run: (app) => applyPlain(app, 'Equalize Histogram', A.equalize) },
  { id: 'adjust.normalize', icon: 'linear_scale', edits: true, isEnabled: has, tip: 'Stretches the luminance to the full range', run: (app) => applyPlain(app, 'Normalize', (r) => A.autoContrast(r, 0)) },
  { id: 'adjust.clarity', icon: 'deblur', edits: true, isEnabled: has, run: (app) => adjustDialog(app, 'Clarity…', [range('amount', 'Amount', -100, 100, 30, false)], (r, v) => A.clarity(r, +v.amount)) },
  { id: 'adjust.dehaze', icon: 'foggy', edits: true, isEnabled: has, run: (app) => adjustDialog(app, 'Dehaze…', [range('amount', 'Amount', 0, 100, 40, false)], (r, v) => A.dehaze(r, +v.amount)) },
  { id: 'adjust.vignette', icon: 'vignette', edits: true, isEnabled: has, run: (app) => adjustDialog(app, 'Vignette…', [range('amount', 'Darkening', 0, 100, 50), range('radius', 'Clear radius (%)', 10, 100, 70), { key: 'color', label: 'Color', type: 'color', value: '#000000', half: true }], (r, v) => A.vignette(r, +v.amount, +v.radius / 100, hexToRgb(v.color))) },

  // Color ----------------------------------------------------------------------------------
  { id: 'adjust.whiteBalance', icon: 'wb_sunny', edits: true, isEnabled: has, tip: 'Temperature and tint, or a neutral reference color', run: (app) => adjustDialog(app, 'White Balance…', [range('temperature', 'Temperature (cool … warm)', -100, 100, 0), range('tint', 'Tint (green … magenta)', -100, 100, 0), { key: 'useNeutral', label: 'Use a neutral reference color', type: 'checkbox', value: false, half: true }, { key: 'neutral', label: 'Color that should be gray', type: 'color', value: '#808080', half: true, visibleIf: (v) => !!v.useNeutral }], (r, v) => A.whiteBalance(r, { temperature: +v.temperature, tint: +v.tint, neutral: v.useNeutral ? hexToRgb(v.neutral) : undefined })) },
  { id: 'adjust.hsl', icon: 'color_lens', edits: true, isEnabled: has, run: (app) => adjustDialog(app, 'Hue, Saturation and Lightness…', [range('hue', 'Hue shift (°)', -180, 180, 0), range('saturation', 'Saturation', -100, 100, 0), range('lightness', 'Lightness', -100, 100, 0)], (r, v) => A.hsl(r, { hue: +v.hue, saturation: +v.saturation, lightness: +v.lightness })) },
  { id: 'adjust.vibrance', icon: 'water_drop', edits: true, isEnabled: has, run: (app) => adjustDialog(app, 'Vibrance…', [range('amount', 'Vibrance', -100, 100, 30, false)], (r, v) => A.vibrance(r, +v.amount / 100)) },
  {
    id: 'adjust.colorBalance', icon: 'balance', edits: true, isEnabled: has, tip: 'Cyan–red, magenta–green, yellow–blue for shadows, midtones and highlights',
    run: (app) => adjustDialog(app, 'Color Balance…', [
      { key: 'h1', type: 'heading', label: 'Midtones' }, range('mr', 'Cyan … Red', -100, 100, 0), range('mg', 'Magenta … Green', -100, 100, 0), range('mb', 'Yellow … Blue', -100, 100, 0),
      { key: 'h2', type: 'heading', label: 'Shadows' }, range('sr', 'Cyan … Red', -100, 100, 0), range('sg', 'Magenta … Green', -100, 100, 0), range('sb', 'Yellow … Blue', -100, 100, 0),
      { key: 'h3', type: 'heading', label: 'Highlights' }, range('hr', 'Cyan … Red', -100, 100, 0), range('hg', 'Magenta … Green', -100, 100, 0), range('hb', 'Yellow … Blue', -100, 100, 0),
    ], (r, v) => A.colorBalance(r, { shadows: [+v.sr, +v.sg, +v.sb], midtones: [+v.mr, +v.mg, +v.mb], highlights: [+v.hr, +v.hg, +v.hb] })),
  },
  {
    id: 'adjust.channelMixer', icon: 'blender', edits: true, isEnabled: has,
    run: (app) => adjustDialog(app, 'Channel Mixer…', [
      { key: 'h1', type: 'heading', label: 'Red output (% of R, G, B)' }, range('rr', 'Red', -200, 200, 100), range('rg', 'Green', -200, 200, 0), range('rb', 'Blue', -200, 200, 0),
      { key: 'h2', type: 'heading', label: 'Green output' }, range('gr', 'Red', -200, 200, 0), range('gg', 'Green', -200, 200, 100), range('gb', 'Blue', -200, 200, 0),
      { key: 'h3', type: 'heading', label: 'Blue output' }, range('br', 'Red', -200, 200, 0), range('bg', 'Green', -200, 200, 0), range('bb', 'Blue', -200, 200, 100),
    ], (r, v) => A.channelMixer(r, [[+v.rr, +v.rg, +v.rb], [+v.gr, +v.gg, +v.gb], [+v.br, +v.bg, +v.bb]])),
  },
  { id: 'adjust.bwMixer', icon: 'filter_b_and_w', edits: true, isEnabled: has, tip: 'Black and white from a weighted mix of the channels (a red filter darkens skies)', run: (app) => adjustDialog(app, 'Black-and-White Mixer…', [range('r', 'Red (%)', -100, 200, 30), range('g', 'Green (%)', -100, 200, 59), range('b', 'Blue (%)', -100, 200, 11)], (r, v) => A.channelMixer(r, [[+v.r, +v.g, +v.b], [0, 0, 0], [0, 0, 0]], true)) },
  { id: 'adjust.tint', icon: 'invert_colors', edits: true, isEnabled: has, run: (app) => adjustDialog(app, 'Tint and Sepia…', [{ key: 'color', label: 'Tone', type: 'color', value: '#704214', half: true }, range('strength', 'Strength', 0, 100, 100)], (r, v) => A.tint(r, hexToRgb(v.color), +v.strength / 100)) },
  { id: 'adjust.warmify', icon: 'wb_incandescent', edits: true, isEnabled: has, run: (app) => applyPlain(app, 'Warmify', (r) => A.whiteBalance(r, { temperature: 35 })) },
  { id: 'adjust.posterize', icon: 'texture', edits: true, isEnabled: has, run: (app) => adjustDialog(app, 'Posterize…', [range('levels', 'Levels per channel', 2, 32, 4, false)], (r, v) => A.posterize(r, +v.levels)) },

  // Detail and retouch ---------------------------------------------------------------------
  { id: 'adjust.sharpen', icon: 'details', popular: true, edits: true, isEnabled: has, run: (app) => applyPlain(app, 'Sharpen', (r) => A.sharpen(r)) },
  { id: 'adjust.unsharp', icon: 'deblur', edits: true, isEnabled: has, run: (app) => adjustDialog(app, 'Unsharp Mask…', [range('amount', 'Amount (%)', 1, 500, 100), range('radius', 'Radius (px)', 1, 50, 2, true, 1), range('threshold', 'Threshold', 0, 255, 0, false)], (r, v) => A.unsharpMask(r, +v.amount, +v.radius, +v.threshold)) },
  { id: 'adjust.blur', icon: 'blur_on', edits: true, isEnabled: has, run: (app) => adjustDialog(app, 'Blur…', [{ key: 'kind', label: 'Kind', type: 'select', options: [{ value: 'gaussian', label: 'Gaussian' }, { value: 'box', label: 'Box' }, { value: 'surface', label: 'Surface (keeps edges)' }], value: 'gaussian', half: true }, range('radius', 'Radius (px)', 1, 100, 3)], (r, v) => (v.kind === 'box' ? A.boxBlur(r, +v.radius) : v.kind === 'surface' ? A.denoise(r, Math.min(6, +v.radius), 40) : A.gaussianBlur(r, +v.radius))) },
  { id: 'adjust.denoise', icon: 'grain', edits: true, isEnabled: has, run: (app) => adjustDialog(app, 'Noise Reduction…', [range('strength', 'Strength', 1, 100, 30), range('radius', 'Radius (px)', 1, 6, 2)], (r, v) => A.denoise(r, +v.radius, +v.strength)) },
  { id: 'adjust.despeckle', icon: 'cleaning_services', edits: true, isEnabled: has, run: (app) => applyPlain(app, 'Despeckle', (r) => A.despeckle(r)) },
  { id: 'adjust.redEye', icon: 'remove_red_eye', edits: true, isEnabled: has, tip: 'Select the eyes first, then apply', run: (app) => { if (!app.tab.selection) { toast('Select the eyes first (Shift+drag), then Red-Eye Reduction.'); return; } applyPlain(app, 'Red-Eye Reduction', (r) => A.redEye(r)); } },
  { id: 'adjust.restoreFaded', icon: 'restore', edits: true, isEnabled: has, tip: 'Per-channel stretch plus a cast correction for faded prints and slides', run: (app) => applyPlain(app, 'Restore Faded Colors', A.restoreFaded) },


  // Curves, tone equalizer, selective color, LUTs ----------------------------------------------
  {
    id: 'adjust.curves', icon: 'show_chart', popular: true, edits: true, isEnabled: has, tip: 'Drag points on the RGB or a channel curve; presets for contrast, fade and inversion',
    run: (app) => {
      const curves: Record<string, A.CurvePoint[]> = { all: [[0, 0], [255, 255]], r: [[0, 0], [255, 255]], g: [[0, 0], [255, 255]], b: [[0, 0], [255, 255]] };
      const PRESETS: Record<string, A.CurvePoint[]> = { 'S-curve (contrast)': [[0, 0], [64, 48], [192, 208], [255, 255]], 'Brighten': [[0, 0], [128, 160], [255, 255]], 'Darken': [[0, 0], [128, 96], [255, 255]], 'Fade (lift blacks)': [[0, 30], [255, 240]], 'Invert': [[0, 255], [255, 0]], 'Linear': [[0, 0], [255, 255]] };
      let channel = 'all';
      const fn = (r: Raster, v: Record<string, any>) => A.curves(r, v.curves || curves);
      return (async () => { const r = await adjustDialog(app, 'Curves…', [
        { key: 'channel', label: 'Channel', type: 'select', options: [{ value: 'all', label: 'RGB' }, { value: 'r', label: 'Red' }, { value: 'g', label: 'Green' }, { value: 'b', label: 'Blue' }], value: 'all', half: true },
        { key: 'preset', label: 'Preset', type: 'select', options: [{ value: '', label: '(custom)' }, ...Object.keys(PRESETS).map((k) => ({ value: k, label: k }))], value: '', half: true },
      ], fn, { id: 'adjust.curves', help: 'Click to add a point, drag to move it, drag a point off the graph to remove it. Input runs left to right, output bottom to top.', extra: (ctl, rerender) => {
        const canvas = h('canvas', { class: 'qn-curve', width: '256', height: '256' }) as HTMLCanvasElement;
        const ctx = canvas.getContext('2d')!;
        const draw = () => {
          ctx.clearRect(0, 0, 256, 256); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 256, 256); ctx.strokeStyle = '#ddd'; ctx.lineWidth = 1;
          for (let i = 64; i < 256; i += 64) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 256); ctx.moveTo(0, i); ctx.lineTo(256, i); ctx.stroke(); }
          ctx.strokeStyle = '#bbb'; ctx.beginPath(); ctx.moveTo(0, 255); ctx.lineTo(255, 0); ctx.stroke();
          const lut = A.curveLut(curves[channel]);
          ctx.strokeStyle = channel === 'r' ? '#d33' : channel === 'g' ? '#2a2' : channel === 'b' ? '#36c' : '#000'; ctx.lineWidth = 2; ctx.beginPath();
          for (let x = 0; x < 256; x++) { const y = 255 - lut[x]; if (x) ctx.lineTo(x, y); else ctx.moveTo(x, y); } ctx.stroke();
          ctx.fillStyle = ctx.strokeStyle; for (const [x, y] of curves[channel]) { ctx.beginPath(); ctx.arc(x, 255 - y, 4, 0, Math.PI * 2); ctx.fill(); }
        };
        let drag = -1;
        const pos = (e: PointerEvent) => { const r = canvas.getBoundingClientRect(); return [Math.max(0, Math.min(255, Math.round(((e.clientX - r.left) / r.width) * 255))), Math.max(0, Math.min(255, Math.round(255 - ((e.clientY - r.top) / r.height) * 255)))] as [number, number]; };
        canvas.addEventListener('pointerdown', (e) => { const [x, y] = pos(e); const pts = curves[channel]; drag = pts.findIndex((p) => Math.abs(p[0] - x) < 8 && Math.abs(p[1] - y) < 8); if (drag < 0) { pts.push([x, y]); pts.sort((a, b) => a[0] - b[0]); drag = pts.findIndex((p) => p[0] === x && p[1] === y); } canvas.setPointerCapture(e.pointerId); ctl.set('preset', ''); draw(); });
        canvas.addEventListener('pointermove', (e) => { if (drag < 0) return; const [x, y] = pos(e); const pts = curves[channel]; const r = canvas.getBoundingClientRect(); const off = e.clientY < r.top - 30 || e.clientY > r.bottom + 30 || e.clientX < r.left - 30 || e.clientX > r.right + 30; if (off && pts.length > 2) { pts.splice(drag, 1); drag = -1; draw(); rerender(); return; } const lo = drag > 0 ? pts[drag - 1][0] + 1 : 0, hi = drag < pts.length - 1 ? pts[drag + 1][0] - 1 : 255; pts[drag] = [Math.max(lo, Math.min(hi, x)), y]; draw(); });
        canvas.addEventListener('pointerup', () => { if (drag >= 0) { drag = -1; rerender(); } });
        const host = h('div', { class: 'qn-curve-host' }, canvas);
        ctl.body.insertBefore(host, ctl.body.firstChild);
        const sel = ctl.body.querySelector('select') as HTMLSelectElement | null;
        sel?.addEventListener('change', () => { channel = sel.value; draw(); });
        const presetSel = ctl.body.querySelectorAll('select')[1] as HTMLSelectElement | undefined;
        presetSel?.addEventListener('change', () => { const pts = PRESETS[presetSel.value]; if (pts) { curves[channel] = pts.map((p) => [p[0], p[1]] as A.CurvePoint); draw(); rerender(); } });
        draw();
      } });
      if (r) { const st = stepsOf(app.picture); const last = st[st.length - 1]; if (last && last.id === 'adjust.curves') last.values = { curves: JSON.parse(JSON.stringify(curves)) }; }
      })();
    },
  },
  {
    id: 'adjust.toneEqualizer', icon: 'equalizer', edits: true, isEnabled: has, tip: 'Lightens or darkens five tonal bands by a blurred mask, keeping local contrast',
    run: (app) => adjustDialog(app, 'Tone Equalizer…', [range('b0', 'Blacks', -100, 100, 0), range('b1', 'Shadows', -100, 100, 0), range('b2', 'Midtones', -100, 100, 0), range('b3', 'Highlights', -100, 100, 0), range('b4', 'Whites', -100, 100, 0), range('radius', 'Mask radius (px)', 4, 120, 24)], (r, v) => A.toneEqualizer(r, [+v.b0, +v.b1, +v.b2, +v.b3, +v.b4], +v.radius)),
  },
  {
    id: 'adjust.selectiveColor', icon: 'palette', edits: true, isEnabled: has, tip: 'Hue, saturation and lightness of one color range at a time (reds, yellows, greens, cyans, blues, magentas, whites, neutrals, blacks)',
    run: (app) => {
      const RANGES: A.SelectiveRange[] = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks'];
      const fields: Field[] = [];
      for (const rg of RANGES) fields.push({ key: `h_${rg}`, type: 'heading', label: rg[0].toUpperCase() + rg.slice(1), visibleIf: (v) => v.range === rg }, { ...range(`${rg}_hue`, 'Hue shift (°)', -60, 60, 0), visibleIf: (v) => v.range === rg }, { ...range(`${rg}_sat`, 'Saturation', -100, 100, 0), visibleIf: (v) => v.range === rg }, { ...range(`${rg}_light`, 'Lightness', -100, 100, 0), visibleIf: (v) => v.range === rg });
      return adjustDialog(app, 'Selective Color…', [{ key: 'range', label: 'Color range', type: 'select', options: RANGES.map((r) => ({ value: r, label: r[0].toUpperCase() + r.slice(1) })), value: 'reds', half: true }, ...fields], (r, v) => { const o: Partial<Record<A.SelectiveRange, A.SelectiveAdjust>> = {}; for (const rg of RANGES) o[rg] = { hue: +v[`${rg}_hue`] || 0, saturation: +v[`${rg}_sat`] || 0, lightness: +v[`${rg}_light`] || 0 }; return A.selectiveColor(r, o); }, { help: 'Settings for every range apply together; pick a range to edit its sliders.' });
    },
  },
  {
    id: 'adjust.lut', icon: 'gradient', edits: true, isEnabled: has, tip: 'Applies a .cube 3-D lookup table (color grading presets from other software)',
    run: async (app) => {
      const files = await openDocuments('.cube,.CUBE', ['application/octet-stream', 'text/plain'], false);
      if (!files.length) return;
      let lut: A.Lut3d;
      try { lut = A.parseCube(new TextDecoder().decode(files[0].data)); } catch (e: any) { toast(`${files[0].name}: ${e?.message || e}`); return; }
      const fn = (r: Raster, v: Record<string, any>) => A.applyLut3d(r, lut, +v.strength / 100);
      const r = await adjustDialog(app, `Apply LUT — ${lut.title || files[0].name}`, [range('strength', 'Strength (%)', 0, 100, 100, false)], fn, { id: 'adjust.lut', label: `LUT ${lut.title || files[0].name}`, help: `${lut.size}×${lut.size}×${lut.size} table.` });
      if (r) STEP_FNS.set('adjust.lut', { fn, label: `LUT ${lut.title || files[0].name}` });
    },
  },

  // Detail and retouch (scans) ----------------------------------------------------------------
  {
    id: 'adjust.dustScratches', icon: 'auto_fix_normal', edits: true, isEnabled: has, tip: 'Replaces specks that differ from their surroundings; the preview can show the replaced pixels as a mask',
    run: (app) => adjustDialog(app, 'Remove Dust and Scratches…', [range('radius', 'Radius (px)', 1, 6, 2), range('threshold', 'Threshold', 0, 128, 24), { key: 'mask', label: 'Show the replaced pixels in red (preview only)', type: 'checkbox', value: false }], (r, v) => { const { raster, mask } = A.dustScratches(r, +v.radius, +v.threshold); if (!v.mask) return raster; const d = raster.data; for (let j = 0; j < mask.length; j++) if (mask[j]) { d[j * 4] = 255; d[j * 4 + 1] = 0; d[j * 4 + 2] = 0; } return raster; }, { help: 'Scanned prints and slides: a small radius and a moderate threshold keep detail.' }),
  },
  {
    id: 'adjust.descreen', icon: 'blur_linear', edits: true, isEnabled: has, tip: 'Removes the halftone screen of scanned printed pictures (newspapers, books, magazines)',
    run: (app) => adjustDialog(app, 'Descreen (moiré)…', [range('period', 'Screen period (px)', 2, 16, 4), range('restore', 'Restore edges (%)', 0, 150, 40)], (r, v) => A.descreen(r, +v.period, +v.restore), { help: 'The period is the dot spacing of the screen in the scan; 3–6 px at 300 dpi for most print.' }),
  },
  // Presets and history --------------------------------------------------------------------

  { id: 'adjust.copySettings', icon: 'content_copy', noRecord: true, isEnabled: (app) => stepsOf(app.picture).length > 0, tip: 'Copies the adjustments and effects applied to this picture since it was opened', run: (app) => { clipboard = stepsOf(app.picture).map((s) => ({ id: s.id, values: { ...s.values } })); toast(`${clipboard.length} adjustment${clipboard.length === 1 ? '' : 's'} copied`); } },
  { id: 'adjust.pasteSettings', icon: 'content_paste', edits: true, isEnabled: (app) => !!app.picture && clipboard.length > 0, tip: 'Applies the copied adjustments to this picture (or its selection)', run: (app) => { const n = replaySteps(app, clipboard, 'Paste Adjustments'); toast(n ? `${n} adjustment${n === 1 ? '' : 's'} applied` : 'Nothing to paste.'); } },
  {
    id: 'adjust.savePreset', icon: 'bookmark_add', noRecord: true, isEnabled: (app) => stepsOf(app.picture).length > 0, tip: 'Saves the adjustments applied to this picture as a named preset',
    run: async (app) => {
      const steps = stepsOf(app.picture);
      const r = await openDialog({ title: 'Save Adjustment Preset', ok: 'Save', help: `${steps.length} step${steps.length === 1 ? '' : 's'}: ${steps.map((s) => STEP_FNS.get(s.id)?.label || s.id).join(', ')}`, fields: [{ key: 'name', label: 'Name', type: 'text', value: '', autofocus: true }] });
      const name = String(r?.name || '').trim(); if (!name) return;
      app.prefs.adjustPresets = [...app.prefs.adjustPresets.filter((p) => p.name !== name), { name, steps: steps.map((s) => ({ id: s.id, values: { ...s.values } })) }]; app.savePrefs();
      toast(`Preset "${name}" saved`);
    },
  },
  {
    id: 'adjust.applyPreset', icon: 'bookmarks', kind: 'menu', edits: true, isEnabled: (app) => !!app.picture && app.prefs.adjustPresets.length > 0, tip: 'Applies a saved preset',
    menu: (app) => app.prefs.adjustPresets.map((p) => ({ id: 'adjust.applyPreset', arg: p.name, label: `${p.name} (${p.steps.length})` })),
    run: (app, arg?: string) => { const p = app.prefs.adjustPresets.find((x) => x.name === arg) || app.prefs.adjustPresets[0]; if (!p) { toast('No presets saved yet.'); return; } const n = replaySteps(app, p.steps, `Preset ${p.name}`); toast(n ? `${p.name}: ${n} step${n === 1 ? '' : 's'} applied` : `${p.name}: its steps are not available in this build`); },
  },
  {
    id: 'adjust.beforeAfter', icon: 'compare', kind: 'toggle', noRecord: true, isEnabled: (app) => !!app.picture && (app.tab.canUndo || app.tab.showingOriginal), isActive: (app) => app.tab.showingOriginal, tip: 'Shows the picture as it was before any edit; press again to return',
    run: (app) => { const t = app.tab; if (!t.showOriginal(!t.showingOriginal)) toast('No edits to compare with.'); else toast(t.showingOriginal ? 'Before (original)' : 'After (edited)', { ms: 1200 }); },
  },
]);
