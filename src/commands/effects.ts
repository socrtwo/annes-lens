/**
 * Effects tab: artistic, photographic, distortion and frame effects with a live before/after preview,
 * an Effects Browser with a thumbnail of every effect, Repeat Last Effect and a custom convolution
 * with saved kernels. Every effect respects the rectangle selection (frames change the canvas size
 * and therefore ignore it).
 */
import { def } from './registry';
import type { App } from '../app';
import { openDialog, toast } from '../ui/dialog';
import type { Field } from '../ui/dialog';
import { h, esc } from '../ui/dom';
import { adjustDialog, range, STEP_FNS, recordStep } from './adjust';
import { editSelection, editRaster, frameRaster, rasterFrame } from '../picture/edit';
import { crop, resample, hexToRgb } from '../picture/ops';
import * as E from '../picture/effects';
import type { Raster } from '../codecs/raster';

const has = (app: App) => !!app.picture;
type Fn = (r: Raster, v: Record<string, any>) => Raster;
const rgb = (hex: string) => hexToRgb(hex) as E.RGB;

interface Effect { id: string; title: string; fields: Field[]; fn: Fn; help?: string; canvas?: boolean }
const EFFECTS: Effect[] = [];
let last: { fx: Effect; values: Record<string, any> } | null = null;

/** Runs one effect: dialog with preview, then apply; frames (canvas-size changes) apply to the whole picture. */
async function runEffect(app: App, fx: Effect): Promise<void> {
  if (fx.canvas) {
    const r = await previewOnly(app, fx);
    if (!r) return;
    editRaster(app, fx.title.replace(/…$/, ''), (x) => fx.fn(x, r));
    last = { fx, values: r };
    STEP_FNS.set(fx.id, { fn: fx.fn, whole: true, label: fx.title.replace(/…$/, '') }); recordStep(app, { id: fx.id, values: r });
    return;
  }
  const r = await adjustDialog(app, fx.title, fx.fields, fx.fn, { help: fx.help, id: fx.id, label: fx.title.replace(/…$/, '') });
  if (r) last = { fx, values: r };
}

/** Like adjustDialog but previews the whole picture (for effects that change the canvas). */
async function previewOnly(app: App, fx: Effect): Promise<Record<string, any> | null> {
  const full = frameRaster(app.picture!.currentFrame);
  const k = Math.min(1, 360 / Math.max(full.width, full.height));
  const small = k < 1 ? resample(full, Math.round(full.width * k), Math.round(full.height * k), 'bilinear') : full;
  let seq = 0;
  const render = async (v: Record<string, any>, ctl: any) => {
    const my = ++seq; await new Promise((r) => setTimeout(r, 0));
    try { const out = fx.fn(small, v); if (my === seq) ctl.setPreview(`<img src="${(rasterFrame(out, 0).image as HTMLCanvasElement).toDataURL()}" style="max-width:100%;max-height:40vh">`); } catch (e: any) { ctl.setPreview(`<div class="ql-help">${esc(String(e?.message || e))}</div>`); }
  };
  return openDialog({ title: fx.title, wide: true, ok: 'Apply', preview: true, help: fx.help, fields: fx.fields, onChange: (v, ctl) => { void render(v, ctl); }, onOpen: (ctl) => { void render(ctl.values(), ctl); } });
}

const fx = (id: string, title: string, fields: Field[], fn: Fn, extra: Partial<Effect> = {}): Effect => { const e: Effect = { id, title, fields, fn, ...extra }; EFFECTS.push(e); return e; };
const color = (key: string, label: string, value: string): Field => ({ key, label, type: 'color', value, half: true });
const check = (key: string, label: string, value: boolean): Field => ({ key, label, type: 'checkbox', value, half: true });
const select = (key: string, label: string, options: { value: string; label: string }[], value: string): Field => ({ key, label, type: 'select', options, value, half: true });
const center = (): Field[] => [range('cx', 'Center X (%)', 0, 100, 50), range('cy', 'Center Y (%)', 0, 100, 50)];

// Artistic ---------------------------------------------------------------------------------------
fx('fx.emboss', 'Emboss…', [range('strength', 'Strength', 1, 10, 2), range('angle', 'Light angle (°)', 0, 360, 135), check('gray', 'Gray relief', true)], (r, v) => E.emboss(r, +v.strength, +v.angle, !!v.gray));
fx('fx.oilPaint', 'Oil Paint…', [range('radius', 'Brush radius', 1, 8, 3), range('levels', 'Intensity levels', 4, 64, 20)], (r, v) => E.oilPaint(r, +v.radius, +v.levels));
fx('fx.edgeDetect', 'Edge Detect…', [select('mode', 'Operator', [{ value: 'sobel', label: 'Sobel' }, { value: 'prewitt', label: 'Prewitt' }, { value: 'laplacian', label: 'Laplacian' }], 'sobel'), range('strength', 'Strength (×100)', 25, 400, 100), check('invert', 'Dark lines on white', false)], (r, v) => E.edgeDetect(r, v.mode, !!v.invert, +v.strength / 100));
fx('fx.median', 'Median…', [range('radius', 'Radius (px)', 1, 10, 2, false)], (r, v) => E.median(r, +v.radius));
fx('fx.pencilSketch', 'Pencil Sketch…', [range('radius', 'Line softness', 1, 20, 6), range('strength', 'Darkness (×100)', 20, 300, 100)], (r, v) => E.pencilSketch(r, +v.radius, +v.strength / 100));
fx('fx.watercolor', 'Watercolor…', [range('radius', 'Brush size', 1, 8, 3), range('levels', 'Color levels', 4, 32, 12)], (r, v) => E.watercolor(r, +v.radius, +v.levels));
fx('fx.cartoon', 'Cartoon…', [range('levels', 'Color levels', 2, 16, 6), range('edge', 'Outline threshold', 10, 200, 60)], (r, v) => E.cartoon(r, +v.levels, +v.edge));
fx('fx.halftone', 'Halftone…', [range('cell', 'Dot spacing (px)', 3, 32, 6), range('angle', 'Screen angle (°)', 0, 90, 45), check('color', 'Color (per channel)', false), color('ink', 'Ink', '#000000'), color('paper', 'Paper', '#ffffff')], (r, v) => E.halftone(r, +v.cell, +v.angle, !!v.color, rgb(v.ink), rgb(v.paper)));
fx('fx.mosaic', 'Mosaic…', [range('size', 'Tile size (px)', 3, 64, 12), range('gap', 'Grout width (px)', 0, 8, 1), color('grout', 'Grout color', '#282828')], (r, v) => E.mosaic(r, +v.size, +v.gap, rgb(v.grout)));
fx('fx.pixelize', 'Pixelate…', [range('size', 'Block size (px)', 2, 128, 8, false)], (r, v) => E.pixelize(r, +v.size));
fx('fx.solarize', 'Solarize…', [range('threshold', 'Threshold', 0, 255, 128, false)], (r, v) => E.solarize(r, +v.threshold));
fx('fx.tiles', 'Tiles…', [range('size', 'Tile size (px)', 8, 128, 24), range('offset', 'Maximum offset (px)', 0, 32, 6), color('grout', 'Background', '#000000')], (r, v) => E.tiles(r, +v.size, +v.offset, rgb(v.grout)));
fx('fx.button3d', '3-D Button…', [range('bevel', 'Bevel width (px)', 2, 64, 12), range('depth', 'Depth (%)', 10, 100, 50)], (r, v) => E.button3d(r, +v.bevel, +v.depth / 100));

// Photographic -----------------------------------------------------------------------------------
fx('fx.filmGrain', 'Film Grain…', [range('amount', 'Amount', 1, 100, 30), range('size', 'Grain size (px)', 1, 4, 1)], (r, v) => E.filmGrain(r, +v.amount, +v.size));
fx('fx.softFocus', 'Soft Focus…', [range('radius', 'Radius (px)', 1, 40, 8), range('amount', 'Amount (%)', 1, 100, 50)], (r, v) => E.softFocus(r, +v.radius, +v.amount));
fx('fx.glow', 'Glow…', [range('radius', 'Radius (px)', 1, 60, 12), range('amount', 'Amount (%)', 1, 100, 60), range('threshold', 'Threshold', 0, 254, 160)], (r, v) => E.glow(r, +v.radius, +v.amount, +v.threshold));
fx('fx.focalBW', 'Focal Black and White…', [...center(), range('radius', 'Color radius (%)', 5, 100, 40), range('feather', 'Feather (%)', 0, 100, 30), select('outside', 'Outside', [{ value: 'gray', label: 'Gray' }, { value: 'sepia', label: 'Sepia' }], 'gray')], (r, v) => E.focalBW(r, +v.cx / 100, +v.cy / 100, +v.radius / 100, +v.feather / 100, v.outside), { help: 'Color is kept inside the circle; the rest turns gray or sepia.' });
fx('fx.graduatedTint', 'Graduated Tint…', [color('color', 'Color', '#ffa03c'), range('direction', 'From (°, 0 = top, clockwise)', 0, 359, 0), range('strength', 'Strength (%)', 1, 100, 50), range('position', 'Fade ends at (%)', 5, 100, 50)], (r, v) => E.graduatedTint(r, rgb(v.color), +v.direction, +v.strength, +v.position / 100));
fx('fx.orton', 'Orton Glow…', [range('radius', 'Radius (px)', 2, 40, 10), range('amount', 'Amount (%)', 1, 100, 70)], (r, v) => E.orton(r, +v.radius, +v.amount));
fx('fx.crossProcess', 'Cross Process…', [range('strength', 'Strength (%)', 1, 100, 100, false)], (r, v) => E.crossProcess(r, +v.strength));
fx('fx.toyCamera', 'Toy Camera…', [range('strength', 'Strength (%)', 1, 100, 100, false)], (r, v) => E.toyCamera(r, +v.strength));
fx('fx.tiltShift', 'Tilt-Shift Miniature…', [range('center', 'Sharp band center (%)', 0, 100, 50), range('band', 'Band height (%)', 5, 100, 30), range('feather', 'Feather (%)', 1, 50, 20), range('radius', 'Blur radius (px)', 1, 40, 8), range('boost', 'Saturation boost (%)', 0, 100, 30)], (r, v) => E.tiltShift(r, +v.center / 100, +v.band / 100, +v.feather / 100, +v.radius, +v.boost));
fx('fx.duotone', 'Duotone…', [color('dark', 'Shadows', '#141e50'), color('light', 'Highlights', '#ffe6b4')], (r, v) => E.duotone(r, rgb(v.dark), rgb(v.light)));
fx('fx.noise', 'Add Noise…', [range('amount', 'Amount', 1, 100, 20), check('mono', 'Monochrome', true), check('gaussian', 'Gaussian distribution', true)], (r, v) => E.noise(r, +v.amount, !!v.mono, !!v.gaussian));

// Distort ----------------------------------------------------------------------------------------
fx('fx.swirl', 'Swirl…', [range('angle', 'Angle (°)', -720, 720, 90), range('radius', 'Radius (%)', 10, 150, 100), ...center()], (r, v) => E.swirl(r, +v.angle, +v.radius / 100, +v.cx / 100, +v.cy / 100));
fx('fx.explosion', 'Explosion…', [range('amount', 'Amount (px)', 1, 100, 12), ...center()], (r, v) => E.explosion(r, +v.amount, +v.cx / 100, +v.cy / 100));
fx('fx.rain', 'Rain Drops…', [range('count', 'Drops', 1, 300, 40), range('size', 'Drop size (px)', 4, 120, 24), range('seed', 'Pattern', 1, 99, 13)], (r, v) => E.rain(r, +v.count, +v.size, +v.seed));
fx('fx.fragment', 'Fragment…', [range('distance', 'Distance (px)', 1, 40, 4, false)], (r, v) => E.fragment(r, +v.distance));
fx('fx.spread', 'Spread…', [range('amount', 'Amount (px)', 1, 50, 5, false)], (r, v) => E.spread(r, +v.amount));
fx('fx.shift', 'Shift Lines…', [range('amount', 'Amount (px)', 1, 100, 10), range('band', 'Band height (px)', 1, 64, 4), check('vertical', 'Shift columns instead of rows', false)], (r, v) => E.shiftLines(r, +v.amount, +v.band, !!v.vertical));
fx('fx.radialBlur', 'Radial Blur…', [range('angle', 'Angle (°)', 1, 90, 10), range('steps', 'Quality (samples)', 4, 48, 12), ...center()], (r, v) => E.radialBlur(r, +v.angle, +v.steps, +v.cx / 100, +v.cy / 100));
fx('fx.zoomBlur', 'Zoom Blur…', [range('amount', 'Amount (%)', 1, 50, 10), range('steps', 'Quality (samples)', 4, 48, 12), ...center()], (r, v) => E.zoomBlur(r, +v.amount / 100, +v.steps, +v.cx / 100, +v.cy / 100));
fx('fx.fishEye', 'Fisheye…', [range('amount', 'Amount (−100 = correct, +100 = bulge)', -100, 100, 50, false)], (r, v) => E.fishEye(r, +v.amount / 100));
fx('fx.wave', 'Wave…', [range('amplitude', 'Amplitude (px)', 1, 100, 10), range('wavelength', 'Wavelength (px)', 4, 400, 60), select('direction', 'Direction', [{ value: 'both', label: 'Both' }, { value: 'horizontal', label: 'Horizontal' }, { value: 'vertical', label: 'Vertical' }], 'both'), range('phase', 'Phase (°)', 0, 360, 0)], (r, v) => E.wave(r, +v.amplitude, +v.wavelength, v.direction, +v.phase));
fx('fx.glass', 'Glass…', [range('amount', 'Refraction (px)', 1, 40, 6), range('cell', 'Texture size (px)', 2, 64, 8)], (r, v) => E.glass(r, +v.amount, +v.cell));
fx('fx.ripple', 'Ripple…', [range('amplitude', 'Amplitude (px)', 1, 50, 6), range('wavelength', 'Wavelength (px)', 4, 200, 24), ...center()], (r, v) => E.ripple(r, +v.amplitude, +v.wavelength, +v.cx / 100, +v.cy / 100));
fx('fx.pinch', 'Pinch…', [range('amount', 'Amount (−100 = bulge, +100 = pinch)', -100, 100, 50), range('radius', 'Radius (%)', 10, 150, 80), ...center()], (r, v) => E.pinch(r, +v.amount / 100, +v.radius / 100, +v.cx / 100, +v.cy / 100));
fx('fx.polar', 'Polar Coordinates…', [select('dir', 'Direction', [{ value: 'toPolar', label: 'Rectangular to polar' }, { value: 'fromPolar', label: 'Polar to rectangular' }], 'toPolar')], (r, v) => E.polar(r, v.dir === 'toPolar'));

// Frames and shadows (change the canvas; whole picture) ------------------------------------------
fx('fx.dropShadow', 'Drop Shadow…', [range('offset', 'Offset (px)', -64, 64, 12), range('blur', 'Softness (px)', 0, 40, 10), range('opacity', 'Opacity (%)', 1, 100, 60), color('color', 'Shadow', '#000000'), color('bg', 'Background', '#ffffff')], (r, v) => E.dropShadow(r, +v.offset, +v.blur, +v.opacity / 100, rgb(v.color), rgb(v.bg)), { canvas: true });
fx('fx.reflection', 'Reflection…', [range('height', 'Height (%)', 5, 100, 40), range('gap', 'Gap (px)', 0, 32, 2), range('opacity', 'Opacity (%)', 1, 100, 50), color('bg', 'Background', '#ffffff')], (r, v) => E.reflection(r, +v.height / 100, +v.gap, +v.opacity / 100, rgb(v.bg)), { canvas: true });
fx('fx.roundCorners', 'Round Corners…', [range('radius', 'Radius (px)', 1, 400, 24), check('transparent', 'Transparent corners', true), { key: 'bg', label: 'Corner color', type: 'color', value: '#ffffff', half: true, visibleIf: (v) => !v.transparent }], (r, v) => E.roundCorners(r, +v.radius, v.transparent ? null : rgb(v.bg)), { canvas: true, help: 'Save as PNG, WebP or GIF to keep transparent corners.' });
fx('fx.instantFrame', 'Instant-Print Frame…', [range('border', 'Border (%)', 1, 20, 5), range('bottom', 'Bottom strip (%)', 5, 50, 20), color('color', 'Frame color', '#fafaf5')], (r, v) => E.instantFrame(r, +v.border / 100, +v.bottom / 100, rgb(v.color)), { canvas: true });
fx('fx.vignetteFrame', 'Vignette Frame…', [range('width', 'Width (%)', 5, 100, 30), color('color', 'Color', '#ffffff'), check('oval', 'Oval', false)], (r, v) => E.vignetteFrame(r, +v.width / 100, rgb(v.color), !!v.oval), { canvas: true });

// Custom convolution -----------------------------------------------------------------------------
const KERNELS: Record<string, { size: number; kernel: number[]; divisor: number; bias: number }> = {
  'Sharpen': { size: 3, kernel: [0, -1, 0, -1, 5, -1, 0, -1, 0], divisor: 1, bias: 0 },
  'Blur': { size: 3, kernel: [1, 2, 1, 2, 4, 2, 1, 2, 1], divisor: 16, bias: 0 },
  'Edge enhance': { size: 3, kernel: [0, 0, 0, -1, 1, 0, 0, 0, 0], divisor: 1, bias: 0 },
  'Emboss': { size: 3, kernel: [-2, -1, 0, -1, 1, 1, 0, 1, 2], divisor: 1, bias: 0 },
  'Outline': { size: 3, kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1], divisor: 1, bias: 0 },
  'Motion blur 5×5': { size: 5, kernel: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1], divisor: 5, bias: 0 },
  'Gaussian 5×5': { size: 5, kernel: [1, 4, 6, 4, 1, 4, 16, 24, 16, 4, 6, 24, 36, 24, 6, 4, 16, 24, 16, 4, 1, 4, 6, 4, 1], divisor: 256, bias: 0 },
};
/** Parses a kernel typed as rows of numbers; pads or truncates to size². */
export function parseKernel(text: string, size: number): number[] {
  const nums = text.split(/[\s,;]+/).filter(Boolean).map(Number).map((n) => (Number.isFinite(n) ? n : 0));
  const out = new Array(size * size).fill(0); for (let i = 0; i < Math.min(nums.length, out.length); i++) out[i] = nums[i];
  return out;
}
const kernelText = (k: number[], size: number) => Array.from({ length: size }, (_, y) => k.slice(y * size, (y + 1) * size).join(' ')).join('\n');

async function convolutionDialog(app: App): Promise<void> {
  const saved = () => app.prefs.convolutions;
  const presetOptions = () => [{ value: '', label: '(custom)' }, ...Object.keys(KERNELS).map((k) => ({ value: `b:${k}`, label: k })), ...saved().map((s) => ({ value: `s:${s.name}`, label: `${s.name} (saved)` }))];
  const fields = (): Field[] => [
    { key: 'preset', label: 'Preset', type: 'select', options: presetOptions(), value: '', half: true },
    select('size', 'Size', [{ value: '3', label: '3×3' }, { value: '5', label: '5×5' }, { value: '7', label: '7×7' }], '3'),
    { key: 'kernel', label: 'Kernel (rows of numbers)', type: 'textarea', rows: 5, value: kernelText(KERNELS.Sharpen.kernel, 3) },
    { key: 'divisor', label: 'Divisor (0 = sum of the kernel)', type: 'number', value: 1, half: true }, { key: 'bias', label: 'Bias', type: 'number', value: 0, half: true },
    { key: 'name', label: 'Save as', type: 'text', placeholder: 'Name', half: true },
    { key: 'save', label: 'Save kernel', type: 'button', half: true, onClick: (v, ctl) => { const name = String(v.name || '').trim(); if (!name) { toast('Give the kernel a name first.'); return; } const size = +v.size; const entry = { name, size, kernel: parseKernel(v.kernel, size), divisor: +v.divisor || 0, bias: +v.bias || 0 }; app.prefs.convolutions = [...saved().filter((s) => s.name !== name), entry]; app.savePrefs(); toast(`Saved "${name}"`); ctl.rebuild(fields()); ctl.set('preset', `s:${name}`); ctl.set('size', String(size)); ctl.set('kernel', kernelText(entry.kernel, size)); ctl.set('divisor', entry.divisor); ctl.set('bias', entry.bias); } },
  ];
  const fn: Fn = (r, v) => { const size = +v.size; return E.convolve(r, parseKernel(v.kernel, size), size, +v.divisor || 0, +v.bias || 0); };
  const pic = app.picture!;
  const full = frameRaster(pic.currentFrame), sel = app.tab.selection, region = sel ? crop(full, sel) : full;
  const k = Math.min(1, 360 / Math.max(region.width, region.height));
  const small = k < 1 ? resample(region, Math.round(region.width * k), Math.round(region.height * k), 'bilinear') : region;
  let seq = 0;
  const render = async (v: Record<string, any>, ctl: any) => { const my = ++seq; await new Promise((r) => setTimeout(r, 0)); try { const out = fn(small, v); if (my === seq) ctl.setPreview(`<img src="${(rasterFrame(out, 0).image as HTMLCanvasElement).toDataURL()}" style="max-width:100%;max-height:36vh">`); } catch (e: any) { ctl.setPreview(`<div class="ql-help">${esc(String(e?.message || e))}</div>`); } };
  const r = await openDialog({
    title: 'Custom Filter (Convolution)', wide: true, ok: 'Apply', preview: true, fields: fields(),
    help: 'Each output pixel is the weighted sum of its neighbors, divided by the divisor plus the bias. Negative weights sharpen and find edges; positive ones blur.',
    onChange: (v, ctl, key) => {
      if (key === 'preset' && v.preset) { const p = v.preset.startsWith('b:') ? KERNELS[v.preset.slice(2)] : saved().find((s) => `s:${s.name}` === v.preset); if (p) { ctl.set('size', String(p.size)); ctl.set('kernel', kernelText(p.kernel, p.size)); ctl.set('divisor', p.divisor); ctl.set('bias', p.bias); } }
      else if (key && key !== 'name' && key !== 'preset' && v.preset) ctl.set('preset', '');
      void render(ctl.values(), ctl);
    },
    onOpen: (ctl) => { void render(ctl.values(), ctl); },
  });
  if (!r) return;
  editSelection(app, 'Custom Filter', (x) => fn(x, r));
  last = { fx: { id: 'fx.convolution', title: 'Custom Filter', fields: [], fn }, values: r };
}

// Effects browser --------------------------------------------------------------------------------
async function effectsBrowser(app: App): Promise<void> {
  const full = frameRaster(app.picture!.currentFrame), sel = app.tab.selection, region = sel ? crop(full, sel) : full;
  const k = Math.min(1, 128 / Math.max(region.width, region.height));
  const small = k < 1 ? resample(region, Math.round(region.width * k), Math.round(region.height * k), 'bilinear') : region;
  const defaults = (f: Effect) => Object.fromEntries(f.fields.filter((x) => x.key && x.type !== 'heading').map((x) => [x.key, x.value]));
  const grid = h('div', { class: 'qn-fxgrid' });
  const dialog = { close: null as null | ((r?: any) => void) };
  let chosen: Effect | null = null;
  const cards = EFFECTS.map((f) => { const img = h('img', { alt: '' }) as HTMLImageElement; const card = h('button', { class: 'qn-fxcard', type: 'button', title: f.title.replace(/…$/, ''), onclick: () => { chosen = f; dialog.close?.({}); } }, img, h('span', null, f.title.replace(/…$/, ''))); grid.appendChild(card); return { f, img }; });
  let i = 0, alive = true;
  const step = () => { if (!alive || i >= cards.length) return; const { f, img } = cards[i++]; try { img.src = (rasterFrame(f.fn(small, defaults(f)), 0).image as HTMLCanvasElement).toDataURL(); } catch { img.alt = '!'; } setTimeout(step, 0); };
  setTimeout(step, 0);
  await openDialog({ title: 'Effects Browser', wide: true, ok: false, cancel: 'Close', content: h('div', null, h('p', { class: 'ql-help' }, 'Every effect at its default settings; click one to open it with a live preview.'), grid), onOpen: (ctl) => { dialog.close = (r) => ctl.close(r); } });
  alive = false;
  if (chosen) await runEffect(app, chosen);
}

def([
  { id: 'fx.browser', icon: 'auto_awesome_mosaic', popular: true, isEnabled: has, noRecord: true, tip: 'Live thumbnails of every effect; click one to open it', run: effectsBrowser },
  { id: 'fx.repeatLast', icon: 'replay', edits: true, isEnabled: (app) => !!app.picture && !!last, tip: 'Applies the last effect again with the same settings', run: (app) => { if (!last) { toast('No effect applied yet.'); return; } const { fx: f, values } = last; if (f.canvas) editRaster(app, f.title.replace(/…$/, ''), (x) => f.fn(x, values)); else editSelection(app, f.title.replace(/…$/, ''), (x) => f.fn(x, values)); } },
  { id: 'fx.convolution', icon: 'grid_on', edits: true, isEnabled: has, tip: '3×3 to 7×7 kernels with divisor and bias; save and load', run: convolutionDialog },
  ...EFFECTS.map((f) => ({ id: f.id, icon: iconFor(f.id), edits: true, isEnabled: has, popular: ['fx.emboss', 'fx.pencilSketch', 'fx.pixelize', 'fx.dropShadow'].includes(f.id), run: (app: App) => runEffect(app, f) })),
]);

function iconFor(id: string): string {
  const m: Record<string, string> = { 'fx.emboss': 'texture', 'fx.oilPaint': 'brush', 'fx.edgeDetect': 'border_style', 'fx.median': 'blur_linear', 'fx.pencilSketch': 'draw', 'fx.watercolor': 'water_drop', 'fx.cartoon': 'face', 'fx.halftone': 'grain', 'fx.mosaic': 'grid_view', 'fx.pixelize': 'apps', 'fx.solarize': 'flare', 'fx.tiles': 'dashboard', 'fx.button3d': 'smart_button', 'fx.filmGrain': 'grain', 'fx.softFocus': 'blur_circular', 'fx.glow': 'light_mode', 'fx.focalBW': 'center_focus_strong', 'fx.graduatedTint': 'gradient', 'fx.orton': 'wb_twilight', 'fx.crossProcess': 'camera_roll', 'fx.toyCamera': 'photo_camera', 'fx.tiltShift': 'view_day', 'fx.duotone': 'invert_colors', 'fx.noise': 'blur_on', 'fx.swirl': 'cyclone', 'fx.explosion': 'scatter_plot', 'fx.rain': 'rainy', 'fx.fragment': 'filter_none', 'fx.spread': 'grain', 'fx.shift': 'view_headline', 'fx.radialBlur': 'rotate_right', 'fx.zoomBlur': 'zoom_out_map', 'fx.fishEye': 'lens', 'fx.wave': 'waves', 'fx.glass': 'window', 'fx.ripple': 'radio_button_checked', 'fx.pinch': 'pinch', 'fx.polar': 'explore', 'fx.dropShadow': 'layers', 'fx.reflection': 'flip', 'fx.roundCorners': 'rounded_corner', 'fx.instantFrame': 'photo', 'fx.vignetteFrame': 'vignette' };
  return m[id] || 'auto_fix';
}

export { EFFECTS };
