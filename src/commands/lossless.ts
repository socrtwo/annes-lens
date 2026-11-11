/**
 * Lossless JPEG commands (M2): Lossless JPEG Transformations (Shift+J), Lossless Crop, Lossless
 * Auto-Rotate by EXIF, and Estimate JPEG Quality. The transformations rewrite the file's DCT
 * coefficients (src/codecs/jpegLossless.ts); the result is saved directly, never through the canvas.
 */
import { def } from './registry';
import type { App, PictureTab } from '../app';
import type { Picture } from '../picture/model';
import { keepOriginalCopy } from '../picture/keepOriginal';
import { openDialog, toast, confirmDialog } from '../ui/dialog';
import { Folder, entryFromBytes } from '../picture/folder';
import { losslessTransform, readJpegCoefficients, isPerfect, opForOrientation, type LosslessOp } from '../codecs/jpegLossless';
import { saveAs, writeBack } from '../platform/native';
import { fmtSize } from '../ui/shell';

const isJpegPicture = (app: App) => !!app.picture && app.picture.format.id === 'jpeg';

const OPS: { value: LosslessOp; label: string }[] = [
  { value: 'none', label: 'None (optimize Huffman tables only)' }, { value: 'rot90', label: 'Rotate 90° clockwise' }, { value: 'rot270', label: 'Rotate 90° counter-clockwise' }, { value: 'rot180', label: 'Rotate 180°' },
  { value: 'flipH', label: 'Flip horizontal' }, { value: 'flipV', label: 'Flip vertical' }, { value: 'transpose', label: 'Transpose (mirror on the diagonal)' }, { value: 'transverse', label: 'Transverse (mirror on the other diagonal)' },
];

/** Hands the transformed bytes over: write back, save as, or open as a new picture. */
async function deliver(app: App, from: { tab: PictureTab; pic: Picture }, bytes: Uint8Array, how: 'overwrite' | 'saveAs' | 'new', suffix: string): Promise<void> {
  // The picture the transform was computed from, in its own window: a dialog was open meanwhile, and the window may show another picture now.
  const { tab, pic } = from;
  const blob = new Blob([bytes as BlobPart], { type: 'image/jpeg' });
  if (how === 'overwrite' && pic.entry.uri) {
    if (!app.tabs.includes(tab) || tab.picture !== pic) { toast(`${pic.name} is no longer the picture shown, so its file was left alone. Use Save As.`, { ms: 7000 }); how = 'saveAs'; }
    else if (tab.dirty && !(await confirmDialog('Lossless JPEG', `${pic.name} has unsaved edits. Writing the lossless result back drops them (the lossless operation works on the file, not on the edits). Continue?`, 'Write back'))) return;
  }
  if (how === 'overwrite' && pic.entry.uri) {
    await keepOriginalCopy(app, tab);
    if (!(await writeBack(pic.entry.uri, blob))) { toast('The file could not be written; use Save As.'); how = 'saveAs'; }
    else {
      const e = entryFromBytes(pic.name, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, pic.entry.uri);
      const at = tab.folder.entries.indexOf(pic.entry); if (at >= 0) tab.folder.entries[at] = e;
      tab.loader.invalidate(pic.entry);
      tab.dirty = false; tab.clearHistory();
      await tab.show();
      toast(`${pic.name} rewritten losslessly (${fmtSize(bytes.length)})`);
      return;
    }
  }
  const base = pic.name.replace(/\.[^.]+$/, '');
  if (how === 'saveAs') {
    const r = await saveAs(blob, `${base}${suffix}.jpg`);
    if (r) toast(`Saved ${r.name} (${fmtSize(bytes.length)})`);
    return;
  }
  await app.openFolder(new Folder([entryFromBytes(`${base}${suffix}.jpg`, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)], 'Lossless result'), 0, { newWindow: true });
}

function gridNote(app: App): { mw: number; mh: number; width: number; height: number; progressive: boolean; comps: number } | null {
  const pic = app.picture;
  if (!pic || pic.format.id !== 'jpeg') return null;
  try {
    // Headers only: a quick parse of the frame header without the scan data.
    const u8 = pic.bytes;
    let p = 2;
    while (p + 4 <= u8.length && u8[p] === 0xff) {
      const m = u8[p + 1];
      if (m === 0xff) { p++; continue; }
      if (m === 0xda || m === 0xd9) break;
      const len = (u8[p + 2] << 8) | u8[p + 3];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        const nc = u8[p + 9];
        let hmax = 1, vmax = 1;
        for (let i = 0; i < nc; i++) { hmax = Math.max(hmax, u8[p + 11 + i * 3] >> 4); vmax = Math.max(vmax, u8[p + 11 + i * 3] & 15); }
        return { mw: 8 * hmax, mh: 8 * vmax, width: (u8[p + 7] << 8) | u8[p + 8], height: (u8[p + 5] << 8) | u8[p + 6], progressive: m === 0xc2 || m === 0xc6 || m === 0xca, comps: nc };
      }
      p += 2 + len;
    }
  } catch { /* fall through */ }
  return null;
}

def([
  {
    id: 'image.losslessJpeg', icon: 'rotate_90_degrees_cw', popular: true, noRecord: true, isEnabled: isJpegPicture,
    tip: 'Rotate, flip, transpose, crop, grayscale and optimize a JPEG without re-encoding its pixels',
    run: async (app) => {
      const pic = app.picture!, from = { tab: app.tab, pic };
      const g = gridNote(app);
      const orient = pic.exif?.orientation || 1;
      const perfectText = (op: LosslessOp, trim: boolean) => {
        if (!g) return '';
        const f = { width: g.width, height: g.height, components: [{ h: g.mw / 8, v: g.mh / 8 }] } as any;
        const ok = trim || isPerfect(f, op);
        return ok ? `Exact: the whole picture is transformed losslessly.` : `The size (${g.width} × ${g.height}) is not a multiple of the ${g.mw} × ${g.mh} block grid: the partial edge strip stays in place (as jpegtran does). Trim the edges to make it exact.`;
      };
      const r = await openDialog({ title: 'Lossless JPEG Transformations', wide: true, ok: 'Save As…',
        help: `${pic.name}: ${g ? `${g.width} × ${g.height}, ${g.progressive ? 'progressive' : 'baseline'}, ${g.comps === 1 ? 'grayscale' : `${g.comps} components`}, block grid ${g.mw} × ${g.mh}` : ''}. The DCT coefficients are rearranged; nothing is decoded or re-quantized. The output is a baseline JPEG with optimized Huffman tables (usually a little smaller).`,
        fields: [
          { key: 'op', label: 'Transformation', type: 'select', options: OPS, value: orient !== 1 ? opForOrientation(orient) : 'rot90' },
          { key: 'trim', label: 'Trim edges to the block grid first (exact; loses up to 15 pixels at the right and bottom)', type: 'checkbox', value: false },
          { key: 'gray', label: 'Convert to grayscale (drop the color channels)', type: 'checkbox', value: false },
          { key: 'meta', label: 'Metadata', type: 'select', options: [{ value: 'keep', label: 'Keep everything (EXIF, XMP, ICC, comments, thumbnails)' }, { value: 'essential', label: 'Keep EXIF, XMP and the color profile only' }, { value: 'strip', label: 'Strip all metadata' }], value: 'keep' },
          { key: 'resetOrientation', label: 'Reset the EXIF Orientation tag to upright', type: 'checkbox', value: orient !== 1 },
          { key: 'how', label: 'Then', type: 'radio', options: [{ value: 'saveAs', label: 'Save as a new file' }, ...(pic.entry.uri ? [{ value: 'overwrite', label: 'Write back into the original file' }] : []), { value: 'new', label: 'Open the result as a new picture (not saved)' }], value: 'saveAs' },
          { key: 'i', type: 'info', label: perfectText(orient !== 1 ? opForOrientation(orient) : 'rot90', false) },
        ],
        onChange: (v, ctl) => { ctl.set; const el = ctl.body.querySelector('.ql-field-i, [data-key="i"]'); void el; (ctl as any).__note = perfectText(v.op, !!v.trim); const info = [...ctl.body.querySelectorAll('.ql-help, .ql-info')].pop(); if (info) info.textContent = perfectText(v.op, !!v.trim); },
      });
      if (!r) return;
      const how = r.how as 'overwrite' | 'saveAs' | 'new';
      if (how === 'overwrite' && !(await confirmDialog('Write Back', `Replace ${pic.name} on disk with the transformed file? (Undo is not possible after writing.)`, 'Write'))) return;
      toast('Transforming…', { ms: 1500 });
      await new Promise((res) => setTimeout(res, 20));
      const out = losslessTransform(pic.bytes, r.op, { trim: !!r.trim, grayscale: !!r.gray, stripMetadata: r.meta === 'strip', keepEssential: r.meta === 'essential', orientation: r.resetOrientation ? 1 : undefined });
      if (out.warnings.length) toast(`Note: ${out.warnings[0]}`, { ms: 6000 });
      const suffix = { none: '-optimized', rot90: '-rot90', rot180: '-rot180', rot270: '-rot270', flipH: '-fliph', flipV: '-flipv', transpose: '-transposed', transverse: '-transversed' }[r.op as LosslessOp] + (r.gray ? '-gray' : '');
      await deliver(app, from, out.bytes, how, suffix);
    },
  },
  {
    id: 'image.losslessCrop', icon: 'crop', noRecord: true, isEnabled: isJpegPicture,
    tip: 'Crop a JPEG on its block grid without re-encoding (a selection tool comes in M3; enter the rectangle here)',
    run: async (app) => {
      const pic = app.picture!, from = { tab: app.tab, pic };
      const g = gridNote(app);
      if (!g) { toast('The JPEG header could not be read.'); return; }
      const r = await openDialog({ title: 'Lossless Crop', ok: 'Save As…', help: `The left and top edges snap down to the ${g.mw} × ${g.mh} block grid; width and height are free. Pixels are copied, not re-encoded.`,
        fields: [
          { key: 'x', label: 'Left', type: 'number', min: 0, max: g.width - 1, step: g.mw, value: 0, half: true }, { key: 'y', label: 'Top', type: 'number', min: 0, max: g.height - 1, step: g.mh, value: 0, half: true },
          { key: 'w', label: 'Width', type: 'number', min: 1, max: g.width, value: g.width, half: true }, { key: 'h', label: 'Height', type: 'number', min: 1, max: g.height, value: g.height, half: true },
          { key: 'how', label: 'Then', type: 'radio', options: [{ value: 'saveAs', label: 'Save as a new file' }, ...(pic.entry.uri ? [{ value: 'overwrite', label: 'Write back into the original file' }] : []), { value: 'new', label: 'Open the result as a new picture' }], value: 'saveAs' },
        ] });
      if (!r) return;
      const out = losslessTransform(pic.bytes, 'none', { crop: { x: +r.x || 0, y: +r.y || 0, width: +r.w || g.width, height: +r.h || g.height } });
      if (r.how === 'overwrite' && !(await confirmDialog('Write Back', `Replace ${pic.name} on disk with the cropped file? The pixels outside the crop are gone from the file after writing.`, 'Write'))) return;
      if (out.warnings.length) toast(`Note: ${out.warnings[0]}`, { ms: 6000 });
      await deliver(app, from, out.bytes, r.how, `-crop${out.width}x${out.height}`);
    },
  },
  {
    id: 'image.losslessAutoRotate', icon: 'screen_rotation_alt', noRecord: true, isEnabled: (app) => isJpegPicture(app) && (app.picture!.exif?.orientation || 1) !== 1,
    tip: 'Turns the JPEG upright by its EXIF Orientation tag without re-encoding, and resets the tag',
    run: async (app) => {
      const pic = app.picture!, from = { tab: app.tab, pic };
      const o = pic.exif?.orientation || 1;
      const op = opForOrientation(o);
      if (op === 'none') { toast('The picture is already upright.'); return; }
      const g = gridNote(app);
      const exact = g ? isPerfect({ width: g.width, height: g.height, components: [{ h: g.mw / 8, v: g.mh / 8 }] } as any, op) : true;
      const how = pic.entry.uri ? (await confirmDialog('Lossless Auto-Rotate', `Rotate ${pic.name} upright (${OPS.find((x) => x.value === op)!.label.toLowerCase()}) and write it back losslessly?${exact ? '' : ' The size is not a multiple of the block grid, so a partial edge strip stays in place.'}`, 'Rotate and Write') ? 'overwrite' : null) : 'saveAs';
      if (!how) return;
      const out = losslessTransform(pic.bytes, op, { orientation: 1 });
      if (out.warnings.length) toast(`Note: ${out.warnings[0]}`, { ms: 6000 });
      await deliver(app, from, out.bytes, how, '-upright');
    },
  },
  {
    id: 'image.jpegQuality', icon: 'speed', noRecord: true, isEnabled: isJpegPicture,
    tip: 'Quality estimate from the quantization tables; flags re-saved and non-standard files',
    run: async (app) => {
      const pic = app.picture!;
      let f;
      try { f = readJpegCoefficients(pic.bytes); } catch (e: any) { toast(e?.message || String(e)); return; }
      const std = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
      const stdC = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99];
      const zz = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];
      const est = (t: Uint16Array, base: number[]) => { let sum = 0; for (let i = 0; i < 64; i++) sum += (t[i] * 100) / base[zz[i]]; const scale = sum / 64; return { q: Math.max(1, Math.min(100, scale <= 100 ? Math.round((200 - scale) / 2) : Math.round(5000 / scale))), scale }; };
      const fit = (t: Uint16Array, base: number[], q: number) => { const s = q < 50 ? 5000 / q : 200 - 2 * q; let diff = 0; for (let i = 0; i < 64; i++) { const v = Math.max(1, Math.min(255, Math.floor((base[zz[i]] * s + 50) / 100))); diff += Math.abs(v - t[i]); } return diff / 64; };
      const rows: [string, string][] = [['File', pic.name], ['Size', `${fmtSize(pic.bytes.length)}, ${(pic.bytes.length * 8 / (f.width * f.height)).toFixed(2)} bits per pixel`], ['Coding', `${f.progressive ? 'progressive' : 'baseline'} Huffman, ${f.components.length === 1 ? 'grayscale' : `${f.components.length} components`}${f.restartInterval ? `, restart interval ${f.restartInterval}` : ''}`]];
      const y = f.qt[f.components[0].tq];
      if (y) { const e = est(y, std); const d = fit(y, std, e.q); rows.push(['Luminance table', `quality about ${e.q}${d < 1.5 ? ' (standard IJG table)' : d < 6 ? ' (close to the IJG table)' : ' (non-standard table: Photoshop, a camera, or a tool with its own tables)'}`]); }
      const cc = f.components[1] ? f.qt[f.components[1].tq] : null;
      if (cc) { const e = est(cc, stdC); const d = fit(cc, stdC, e.q); rows.push(['Chrominance table', `quality about ${e.q}${d < 1.5 ? ' (standard)' : d < 6 ? ' (close to standard)' : ' (non-standard)'}`]); if (y) { const ey = est(y, std).q; if (Math.abs(ey - e.q) >= 8) rows.push(['Mismatch', `luminance and chrominance tables suggest different qualities (${ey} vs ${e.q}): the file was likely re-saved or produced by software with separate settings`]); } }
      if (f.components.length === 3) { const c = f.components; rows.push(['Chroma subsampling', c[0].h === 2 && c[0].v === 2 ? '4:2:0' : c[0].h === 2 && c[0].v === 1 ? '4:2:2' : c[0].h === 1 && c[0].v === 1 ? '4:4:4' : `${c[0].h}×${c[0].v}`]); }
      // Double compression hint: histogram of a low-frequency AC coefficient shows periodic gaps when quantized twice.
      if (y) {
        const c = f.components[0];
        const hist = new Map<number, number>();
        for (let b = 0; b < c.blocksPerLine * c.blocksPerColumn; b++) { const v = c.coefs[b * 64 + 1]; hist.set(v, (hist.get(v) || 0) + 1); }
        const vals = [...hist.entries()].filter(([v]) => Math.abs(v) <= 12 && v !== 0);
        const total = vals.reduce((s, [, n]) => s + n, 0);
        if (total > 2000) {
          const zeros = vals.filter(([, n]) => n < total * 0.002).length;
          if (zeros >= 6) rows.push(['Double compression', `the coefficient histogram has periodic gaps (${zeros} empty bins of 24): the picture was very likely compressed more than once`]);
          else rows.push(['Double compression', 'no sign of it in the coefficient histogram']);
        }
      }
      const software = pic.exif?.software;
      if (software) rows.push(['Software (EXIF)', software]);
      const { h } = await import('../ui/dom');
      const table = h('table', { class: 'ql-stats qn-info' }, ...rows.map(([k, v]) => h('tr', null, h('td', null, k), h('td', null, v))));
      await openDialog({ title: 'Estimate JPEG Quality', wide: true, content: table, cancel: false, ok: 'Close' });
    },
  },
]);
