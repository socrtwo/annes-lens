/**
 * Tools for scientific pictures: Window / Level and the tag listing for DICOM files, the stretch and the header
 * listing for FITS files. The display settings are kept per file (decodeOptions.perEntry) and the file is decoded
 * again with them; the listings are read-only dialogs with a filter and a copy button.
 */
import { def } from './registry';
import type { App } from '../app';
import { openDialog, toast, type Field, type DialogControl } from '../ui/dialog';
import { h, esc } from '../ui/dom';
import { decodeOptions } from '../codecs/registry';
import type { DicomWindow } from '../codecs/dicom';
import type { FitsStretch, FitsStretchMode } from '../codecs/fits';

const isDicom = (app: App) => app.picture?.format.id === 'dicom';
const isFits = (app: App) => app.picture?.format.id === 'fits';
/** Decodes the open file again with its new per-file settings. */
async function redecode(app: App): Promise<void> { const tab = app.active, pic = tab?.picture; if (!tab || !pic) return; tab.loader.invalidate(pic.entry); await tab.show(); }
const setting = (app: App) => { const e = app.picture!.entry; let s = decodeOptions.perEntry.get(e); if (!s) { s = {}; decodeOptions.perEntry.set(e, s); } return s; };

/** CT presets in Hounsfield units (after the rescale), the usual radiology values. */
export const WINDOW_PRESETS: { id: string; label: string; wc: number; ww: number }[] = [
  { id: 'brain', label: 'Brain (40 / 80)', wc: 40, ww: 80 }, { id: 'subdural', label: 'Subdural (75 / 215)', wc: 75, ww: 215 }, { id: 'stroke', label: 'Stroke (40 / 40)', wc: 40, ww: 40 },
  { id: 'soft', label: 'Soft tissue (50 / 400)', wc: 50, ww: 400 }, { id: 'liver', label: 'Liver (60 / 160)', wc: 60, ww: 160 }, { id: 'mediastinum', label: 'Mediastinum (50 / 350)', wc: 50, ww: 350 },
  { id: 'lung', label: 'Lung (−600 / 1500)', wc: -600, ww: 1500 }, { id: 'bone', label: 'Bone (400 / 1800)', wc: 400, ww: 1800 }, { id: 'angio', label: 'Angiography (300 / 600)', wc: 300, ww: 600 },
];

/** A small preview of the open DICOM or FITS file decoded again with trial settings (the first page only). */
async function previewOf(app: App, decode: (bytes: Uint8Array) => Promise<{ pages: { frames: { raster: { width: number; height: number; data: Uint8ClampedArray } }[] }[] }>): Promise<string> {
  const pic = app.picture!, r0 = await decode(pic.bytes);
  const pg = r0.pages[Math.min(pic.page, r0.pages.length - 1)] || r0.pages[0], r = pg.frames[0].raster;
  const c = document.createElement('canvas'); c.width = r.width; c.height = r.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height), 0, 0);
  const k = Math.min(1, 420 / Math.max(r.width, r.height));
  if (k < 1) { const s = document.createElement('canvas'); s.width = Math.max(1, Math.round(r.width * k)); s.height = Math.max(1, Math.round(r.height * k)); s.getContext('2d')!.drawImage(c, 0, 0, s.width, s.height); return s.toDataURL(); }
  return c.toDataURL();
}
function livePreview(render: (v: Record<string, any>, ctl: DialogControl) => Promise<string>): (v: Record<string, any>, ctl: DialogControl) => void {
  let seq = 0, busy = false, pending: Record<string, any> | null = null;
  const run = async (v: Record<string, any>, ctl: DialogControl) => {
    if (busy) { pending = v; return; }
    busy = true; const my = ++seq;
    try { const url = await render(v, ctl); if (my === seq) ctl.setPreview(`<img src="${url}" style="max-width:100%;max-height:420px">`); } catch (e: any) { ctl.setPreview(`<div class="ql-help">${esc(e?.message || String(e))}</div>`); }
    busy = false;
    if (pending) { const p = pending; pending = null; void run(p, ctl); }
  };
  return (v, ctl) => { void run(v, ctl); };
}

/** A filterable, copyable listing (tags or header cards) in a dialog. */
async function listingDialog(title: string, help: string, rows: { cells: string[]; depth?: number; dim?: boolean }[], headers: string[], copyText: () => string): Promise<void> {
  await openDialog({
    title, wide: true, ok: 'Close', help, fields: [], buttons: [{ label: 'Copy as text', onClick: async () => { try { await navigator.clipboard.writeText(copyText()); toast('Copied.'); } catch { toast('The clipboard is not available here.'); } } }],
    onOpen: (ctl) => {
      const input = h('input', { type: 'search', class: 'ql-input', placeholder: 'Filter…', 'aria-label': 'Filter' }) as HTMLInputElement;
      const count = h('span', { class: 'ql-help' });
      const table = h('table', { class: 'qn-listing' }, h('thead', null, h('tr', null, ...headers.map((x) => h('th', null, x)))));
      const body = h('tbody'); table.append(body);
      const render = () => {
        const q = input.value.trim().toLowerCase();
        body.replaceChildren();
        let n = 0;
        for (const r of rows) {
          if (q && !r.cells.some((c) => c.toLowerCase().includes(q))) continue;
          n++;
          body.append(h('tr', { class: r.dim ? 'qn-dim' : '' }, ...r.cells.map((c, i) => h('td', { style: i === 0 && r.depth ? `padding-left:${8 + r.depth * 14}px` : '' }, c))));
        }
        count.textContent = `${n} of ${rows.length}`;
      };
      input.addEventListener('input', render);
      ctl.body.append(h('div', { class: 'qn-listing-bar' }, input, count), h('div', { class: 'qn-listing-wrap' }, table));
      render();
      setTimeout(() => input.focus(), 50);
    },
  });
}

def([
  {
    id: 'image.dicomWindow', icon: 'contrast', isEnabled: isDicom, tip: 'Window center and width (level and contrast) for a DICOM picture, with the usual CT presets; the file is decoded again with them',
    run: async (app, arg?: DicomWindow | 'full' | 'file') => {
      const pic = app.picture!;
      const { decodeDicom } = await import('../codecs/dicom');
      const apply = async (w: DicomWindow | 'full' | undefined) => { const s = setting(app); if (w) s.dicomWindow = w; else delete s.dicomWindow; await redecode(app); };
      if (arg === 'file') { await apply(undefined); return; }
      if (arg) { await apply(arg); return; }
      const current = decodeOptions.perEntry.get(pic.entry)?.dicomWindow;
      const file = /center (-?[\d.]+), width (-?[\d.]+)/.exec(pic.info['file window'] || (current ? '' : pic.info.window || ''));
      const start: DicomWindow = current && current !== 'full' ? current : { wc: file ? +file[1] : 0, ww: file ? +file[2] : 400, fn: 'LINEAR' };
      const fields: Field[] = [
        { key: 'preset', label: 'Preset', type: 'select', value: current === 'full' ? 'full' : 'custom', options: [{ value: 'file', label: file ? `The file's window (${file[1]} / ${file[2]})` : 'The file\'s own display (no window)' }, { value: 'full', label: 'Full range of the frame' }, { value: 'custom', label: 'Custom' }, ...WINDOW_PRESETS.map((p) => ({ value: p.id, label: p.label }))] },
        { key: 'wc', label: 'Center', type: 'number', value: start.wc, step: 1, half: true, visibleIf: (v) => v.preset !== 'file' && v.preset !== 'full' },
        { key: 'ww', label: 'Width', type: 'number', value: start.ww, min: 1, step: 1, half: true, visibleIf: (v) => v.preset !== 'file' && v.preset !== 'full' },
        { key: 'fn', label: 'Function', type: 'select', value: start.fn || 'LINEAR', options: [{ value: 'LINEAR', label: 'Linear (DICOM default)' }, { value: 'LINEAR_EXACT', label: 'Linear exact' }, { value: 'SIGMOID', label: 'Sigmoid' }], visibleIf: (v) => v.preset !== 'file' && v.preset !== 'full' },
        { key: 'note', type: 'info', html: '<span class="ql-help">Values are in the units after the modality rescale (Hounsfield units for CT). The setting is kept for this file while the app runs; Save As writes the picture as shown.</span>' },
      ];
      const windowOf = (v: Record<string, any>): DicomWindow | 'full' | undefined => (v.preset === 'file' ? undefined : v.preset === 'full' ? 'full' : { wc: +v.wc || 0, ww: Math.max(1, +v.ww || 1), fn: String(v.fn || 'LINEAR') });
      const r = await openDialog({
        title: 'Window / Level', ok: 'Apply', wide: true, preview: true, fields, help: 'Live preview of the current frame.',
        onChange: (v, ctl, key) => {
          if (key === 'preset') { const p = WINDOW_PRESETS.find((x) => x.id === v.preset); if (p) { ctl.set('wc', p.wc); ctl.set('ww', p.ww); v = { ...v, wc: p.wc, ww: p.ww }; } }
          else if ((key === 'wc' || key === 'ww' || key === 'fn') && v.preset !== 'custom' && v.preset !== 'file' && v.preset !== 'full') { ctl.set('preset', 'custom'); v = { ...v, preset: 'custom' }; }
          livePreview((vv) => previewOf(app, (bytes) => decodeDicom(bytes, null, { window: windowOf(vv), maxFrames: pic.page + 1, overlays: decodeOptions.dicomOverlays })))(v, ctl);
        },
        onOpen: (ctl) => livePreview((vv) => previewOf(app, (bytes) => decodeDicom(bytes, null, { window: windowOf(vv), maxFrames: pic.page + 1, overlays: decodeOptions.dicomOverlays })))(ctl.values(), ctl),
      });
      if (!r) return;
      await apply(windowOf(r));
    },
  },
  {
    id: 'image.dicomTags', icon: 'list_alt', isEnabled: isDicom, tip: 'Every data element of the DICOM file: tag, VR, name and value, sequences nested; filter and copy',
    run: async (app) => {
      const pic = app.picture!;
      const { dumpDicom } = await import('../codecs/dicom');
      const { rows, transferSyntax } = dumpDicom(pic.bytes);
      const text = () => rows.map((r) => `${'  '.repeat(r.depth)}${r.tag} ${r.vr.padEnd(2)} ${r.name}${r.value ? ` = ${r.value}` : ''}`).join('\n');
      await listingDialog(`DICOM Tags · ${pic.name}`, `${rows.length} elements; transfer syntax ${transferSyntax || 'unknown'}. Patient details are personal data: mind where you paste them.`, rows.map((r) => ({ cells: [r.tag, r.vr, r.name, r.value], depth: r.depth, dim: !r.tag })), ['Tag', 'VR', 'Name', 'Value'], text);
    },
  },
  {
    id: 'image.fitsStretch', icon: 'gradient', isEnabled: isFits, tip: 'How FITS values map to gray: linear, square root, square, logarithmic or asinh, between percentiles or fixed values; the file is decoded again',
    run: async (app, arg?: FitsStretch | 'default') => {
      const pic = app.picture!;
      const { decodeFits } = await import('../codecs/fits');
      const apply = async (st: FitsStretch | undefined) => { const s = setting(app); if (st) s.fitsStretch = st; else delete s.fitsStretch; await redecode(app); };
      if (arg === 'default') { await apply(undefined); return; }
      if (arg) { await apply(arg); return; }
      const cur = decodeOptions.perEntry.get(pic.entry)?.fitsStretch || {};
      const shown = /from (\S+) to (\S+)/.exec(pic.current.notes.find((n) => /^shown stretched/.test(n)) || '');
      const fields: Field[] = [
        { key: 'mode', label: 'Stretch', type: 'select', value: cur.mode || 'linear', options: [{ value: 'linear', label: 'Linear' }, { value: 'sqrt', label: 'Square root' }, { value: 'square', label: 'Square' }, { value: 'log', label: 'Logarithmic' }, { value: 'asinh', label: 'Inverse hyperbolic sine (asinh)' }] },
        { key: 'limits', label: 'Limits', type: 'radio', value: cur.lo !== undefined ? 'values' : 'percentiles', options: [{ value: 'percentiles', label: 'Percentiles of the values' }, { value: 'values', label: 'Fixed values' }] },
        { key: 'plo', label: 'Low percentile', type: 'number', value: cur.percentiles?.[0] ?? 0.5, min: 0, max: 100, step: 0.1, half: true, visibleIf: (v) => v.limits === 'percentiles' },
        { key: 'phi', label: 'High percentile', type: 'number', value: cur.percentiles?.[1] ?? 99.5, min: 0, max: 100, step: 0.1, half: true, visibleIf: (v) => v.limits === 'percentiles' },
        { key: 'lo', label: 'Black at', type: 'number', value: cur.lo ?? (shown ? +shown[1] : 0), step: 'any' as any, half: true, visibleIf: (v) => v.limits === 'values' },
        { key: 'hi', label: 'White at', type: 'number', value: cur.hi ?? (shown ? +shown[2] : 1), step: 'any' as any, half: true, visibleIf: (v) => v.limits === 'values' },
        { key: 'note', type: 'info', html: '<span class="ql-help">The logarithmic stretch is log₁₀(1 + 1000 t) / 3 and asinh is asinh(10 t) / asinh(10) of the normalized value t, as in SAOImage DS9. The setting is kept for this file while the app runs.</span>' },
      ];
      const stretchOf = (v: Record<string, any>): FitsStretch => (v.limits === 'values' ? { mode: v.mode as FitsStretchMode, lo: +v.lo, hi: +v.hi } : { mode: v.mode as FitsStretchMode, percentiles: [+v.plo, +v.phi] });
      const preview = livePreview((vv) => previewOf(app, async (bytes) => decodeFits(bytes, pic.name, stretchOf(vv))));
      const r = await openDialog({ title: 'FITS Stretch', ok: 'Apply', wide: true, preview: true, fields, help: 'Live preview of the current page.', onChange: (v, ctl) => preview(v, ctl), onOpen: (ctl) => preview(ctl.values(), ctl) });
      if (!r) return;
      await apply(stretchOf(r));
    },
  },
  {
    id: 'image.fitsHeader', icon: 'description', isEnabled: isFits, tip: 'The header cards of the open page\'s HDU (and the others): keyword, value and comment; filter and copy',
    run: async (app) => {
      const pic = app.picture!;
      const { fitsCards, fitsPageHdus, fitsBytes, fitsHdus } = await import('../codecs/fits');
      const u8 = fitsBytes(pic.bytes, pic.name), hdus = fitsHdus(u8), pageHdus = fitsPageHdus(u8), current = pageHdus[pic.page] ?? 0;
      const rows: { cells: string[]; dim?: boolean }[] = [];
      const order = [current, ...hdus.map((_, i) => i).filter((i) => i !== current)];
      const lines: string[] = [];
      for (const i of order) {
        const h0 = hdus[i], title = `HDU ${i}${i === 0 ? ' (primary)' : ''}: ${h0.kind}${h0.cards.get('EXTNAME') ? ` "${h0.cards.get('EXTNAME')}"` : ''}${h0.axes.length ? `, ${h0.axes.join(' × ')}` : ''}${i === current ? ' — this page' : ''}`;
        rows.push({ cells: [title, '', ''], dim: true }); lines.push(`# ${title}`);
        for (const c of fitsCards(u8, i)) {
          const m = /^([A-Z0-9_\-]{1,8})\s*=\s*(.*)$/.exec(c);
          if (m) { const [val, cmt] = splitValue(m[2]); rows.push({ cells: [m[1], val, cmt] }); }
          else if (/^(COMMENT|HISTORY|CONTINUE)/.test(c)) rows.push({ cells: [c.slice(0, 8).trim(), '', c.slice(8).trim()] });
          else if (c.trim()) rows.push({ cells: [c.trim() === 'END' ? 'END' : '', '', c.trim() === 'END' ? '' : c.trim()] });
          lines.push(c);
        }
      }
      await listingDialog(`FITS Header · ${pic.name}`, `${hdus.length} HDU${hdus.length === 1 ? '' : 's'}; the open page's HDU first.`, rows, ['Keyword', 'Value', 'Comment'], () => lines.join('\n'));
    },
  },
]);

/** A card's value field split into the value and its comment (a slash outside quotes starts the comment). */
export function splitValue(rest: string): [string, string] {
  let inQ = false;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === "'") { if (inQ && rest[i + 1] === "'") { i++; continue; } inQ = !inQ; }
    else if (ch === '/' && !inQ) return [rest.slice(0, i).trim(), rest.slice(i + 1).trim()];
  }
  return [rest.trim(), ''];
}
