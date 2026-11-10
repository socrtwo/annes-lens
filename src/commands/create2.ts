/**
 * Create tab, part two: Exposure Merge (HDR by exposure fusion), Focus Stack, Web Gallery (a ZIP
 * with a static page, thumbnails and a lightbox), Calendar Page, Extract Embedded Pictures (from
 * .docx, .pptx, .xlsx, .odt, .epub and any ZIP; PDF and other files by carving), Slideshow
 * Video (WebM through the browser's recorder, with crossfades and pan-and-zoom) and Stitch Panorama.
 */
import { jsonForScript } from '../ui/dom';
import { def } from './registry';
import type { App } from '../app';
import type { Entry } from '../picture/folder';
import { Folder, entryFromBytes } from '../picture/folder';
import { openDialog, toast } from '../ui/dialog';
import { decodePicture, encodeCanvas } from '../codecs/registry';
import { isZip, readZip, readZipEntry } from '../codecs/zip';
import { carvePictures } from '../codecs/carve';
import { exposureFusion, focusStack, exposureFusionRefined, focusStackRefined } from '../picture/merge';
import { stitch, type Projection } from '../picture/stitch';
import { rasterFrame } from '../picture/edit';
import { resample } from '../picture/ops';
import { writeZip } from '../picture/batch';
import { openDocuments, saveAs } from '../platform/native';
import { fmtSize } from '../ui/shell';
import { isPictureName } from '../picture/folder';
import type { Raster } from '../codecs/raster';

const rasterOf = (c: HTMLCanvasElement): Raster => { const id = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height); return { width: c.width, height: c.height, data: id.data as Uint8ClampedArray<ArrayBuffer> }; };
const base = (n: string) => n.replace(/\.[^.]+$/, '') || 'picture';
const many = (app: App) => app.folder.length > 1 || app.tab.marked.size > 1;
function inputsOf(app: App): Entry[] { const t = app.tab; const m = t.folder.entries.filter((e) => t.marked.has(e)); return m.length ? m : [...t.folder.entries]; }
async function loadRasters(app: App, entries: Entry[], max = 0): Promise<{ entry: Entry; raster: Raster; exif: any }[]> {
  const out: { entry: Entry; raster: Raster; exif: any }[] = []; let i = 0;
  for (const e of entries) { i++; if (i % 3 === 0) toast(`Loading ${i} of ${entries.length}…`, { ms: 700 }); try { const cur = app.tab.picture; const pic = cur && cur.entry === e ? cur : await decodePicture(new Uint8Array(await e.read()), e); const c = pic.frameCanvas(); let r = rasterOf(c); if (max && Math.max(r.width, r.height) > max) { const k = max / Math.max(r.width, r.height); r = resample(r, Math.round(r.width * k), Math.round(r.height * k), 'bilinear'); } out.push({ entry: e, raster: r, exif: pic.exif }); if (pic !== cur) pic.release(); } catch { /* skipped */ } }
  return out;
}
/** Resamples all to the smallest common size (same-scene brackets usually match already). */
function sameSize(items: { raster: Raster }[]): Raster[] { const w = Math.min(...items.map((i) => i.raster.width)), h = Math.min(...items.map((i) => i.raster.height)); return items.map((i) => (i.raster.width === w && i.raster.height === h ? i.raster : resample(i.raster, w, h, 'bilinear'))); }
async function openRaster(app: App, r: Raster, name: string, folderName: string): Promise<void> { const blob = await encodeCanvas(rasterFrame(r, 0).image as HTMLCanvasElement, 'png'); await app.openFolder(new Folder([entryFromBytes(name, await blob.arrayBuffer())], folderName), 0, { newWindow: true }); }

export const GALLERY_HTML = (title: string, items: { file: string; thumb: string; caption: string; w: number; h: number }[]) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#111;color:#eee}header{padding:20px 24px 8px}h1{margin:0;font-size:22px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;padding:16px 24px}.grid a{display:block;aspect-ratio:4/3;overflow:hidden;border-radius:6px;background:#222}.grid img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .2s}.grid a:hover img{transform:scale(1.04)}#lb{position:fixed;inset:0;background:rgba(0,0,0,.92);display:none;align-items:center;justify-content:center;flex-direction:column}#lb.on{display:flex}#lb img{max-width:96vw;max-height:84vh;object-fit:contain}#lb figcaption{padding:10px;color:#ddd}#lb button{position:fixed;top:50%;transform:translateY(-50%);background:none;border:0;color:#fff;font-size:40px;cursor:pointer;padding:20px}#prev{left:0}#next{right:0}#x{top:8px;right:8px;transform:none;font-size:28px}footer{padding:12px 24px;color:#888;font-size:12px}</style></head>
<body><header><h1>${esc(title)}</h1><div style="color:#aaa">${items.length} pictures</div></header>
<div class="grid">${items.map((i, k) => `<a href="${i.file}" data-i="${k}" title="${esc(i.caption)}"><img src="${i.thumb}" alt="${esc(i.caption)}" loading="lazy"></a>`).join('')}</div>
<figure id="lb"><img alt=""><figcaption></figcaption><button id="prev" aria-label="Previous">‹</button><button id="next" aria-label="Next">›</button><button id="x" aria-label="Close">×</button></figure>
<footer>Made with Anne's Lens</footer>
<script>const items=${jsonForScript(items.map((i) => ({ file: i.file, caption: i.caption })))};let cur=-1;const lb=document.getElementById('lb'),img=lb.querySelector('img'),cap=lb.querySelector('figcaption');
function show(i){cur=(i+items.length)%items.length;img.src=items[cur].file;cap.textContent=items[cur].caption;lb.classList.add('on');}
document.querySelectorAll('.grid a').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();show(+a.dataset.i)}));
document.getElementById('prev').onclick=()=>show(cur-1);document.getElementById('next').onclick=()=>show(cur+1);document.getElementById('x').onclick=()=>lb.classList.remove('on');
document.addEventListener('keydown',e=>{if(!lb.classList.contains('on'))return;if(e.key==='ArrowRight')show(cur+1);else if(e.key==='ArrowLeft')show(cur-1);else if(e.key==='Escape')lb.classList.remove('on');});</script></body></html>`;
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/** The pictures inside a ZIP-based document (Office, OpenDocument, EPUB) or any ZIP. */
export function picturesInZip(u8: Uint8Array): { name: string; data: Uint8Array }[] {
  const { entries } = readZip(u8); const out: { name: string; data: Uint8Array }[] = [];
  for (const e of entries) { if (e.encrypted || !isPictureName(e.name) || e.size === 0) continue; try { out.push({ name: e.name.replace(/^.*\//, ''), data: readZipEntry(u8, e) }); } catch { /* skip */ } }
  return out;
}

def([
  {
    id: 'create.hdr', icon: 'hdr_strong', noRecord: true, isEnabled: many, tip: 'Exposure fusion of a bracket (dark, normal, bright) into one natural-looking picture',
    run: async (app) => {
      const entries = inputsOf(app);
      const r = await openDialog({ title: 'Exposure Merge (HDR)', ok: 'Merge', help: `${entries.length} pictures of the same scene; they are lined up first unless you say not to.`, fields: [{ key: 'align', label: 'Line the pictures up (shift, turn, scale)', type: 'checkbox', value: true, half: true }, { key: 'deghost', label: 'Take moving things from one exposure', type: 'checkbox', value: true, half: true }, { key: 'contrast', label: 'Weight: contrast', type: 'range', min: 0, max: 200, value: 100, half: true }, { key: 'saturation', label: 'Weight: saturation', type: 'range', min: 0, max: 200, value: 100, half: true }, { key: 'exposedness', label: 'Weight: well-exposedness', type: 'range', min: 0, max: 200, value: 100, half: true }, { key: 'maxSide', label: 'Longest side (px, 0 = keep)', type: 'number', min: 0, max: 8000, value: 0, half: true }] });
      if (!r) return;
      const items = await loadRasters(app, entries, +r.maxSide || 0); if (items.length < 2) { toast('Fewer than two pictures could be loaded.'); return; }
      toast('Fusing…', { ms: 2000 }); await new Promise((res) => setTimeout(res, 30));
      const fused = exposureFusionRefined(sameSize(items), { contrast: +r.contrast / 100, saturation: +r.saturation / 100, exposedness: +r.exposedness / 100, align: !!r.align, deghost: !!r.deghost });
      await openRaster(app, fused.raster, `${base(items[0].entry.name)}-fused.png`, 'Exposure merge');
      if (fused.moved || fused.failed) toast(`${fused.moved ? `${fused.moved} picture${fused.moved > 1 ? 's' : ''} lined up` : ''}${fused.moved && fused.failed ? '; ' : ''}${fused.failed ? `${fused.failed} could not be matched and stayed as taken` : ''}.`, { ms: 5000 });
    },
  },
  {
    id: 'create.panoramaStitch', icon: 'panorama', noRecord: true, isEnabled: many, tip: 'Joins overlapping pictures into one panorama: features matched, perspective or cylinder, exposure evened out, seams blended',
    run: async (app, arg?: { projection?: Projection; blend?: 'smooth' | 'sharp'; evenExposure?: boolean; crop?: boolean; maxMp?: number }) => {
      const entries = inputsOf(app);
      const r = arg || await openDialog({ title: 'Stitch Panorama', ok: 'Stitch', help: `${entries.length} pictures that overlap by a quarter or more, in any order. Turn the camera about the lens; a tripod helps but is not needed.`, fields: [
        { key: 'projection', label: 'Projection', type: 'select', value: 'auto', options: [{ value: 'auto', label: 'Automatic' }, { value: 'planar', label: 'Planar (straight lines stay straight; up to about 100°)' }, { value: 'cylindrical', label: 'Cylindrical (wide pans)' }, { value: 'flat', label: 'Flat (scanned pieces of a large page or map)' }] },
        { key: 'blend', label: 'Seams', type: 'select', value: 'smooth', half: true, options: [{ value: 'smooth', label: 'Smooth blend' }, { value: 'sharp', label: 'Sharp (fewer ghosts of moving things)' }] },
        { key: 'maxMp', label: 'Largest result (megapixels)', type: 'number', value: 40, min: 1, max: 200, half: true },
        { key: 'evenExposure', label: 'Even out exposure', type: 'checkbox', value: true },
        { key: 'crop', label: 'Crop to the filled rectangle', type: 'checkbox', value: true },
      ] });
      if (!r) return;
      let items = await loadRasters(app, entries); if (items.length < 2) { toast('Fewer than two pictures could be loaded.'); return; }
      // Same-shaped pictures of different sizes are brought to the first one's size (one camera's pixels).
      const w0 = items[0].raster.width, h0 = items[0].raster.height;
      items = items.map((it) => (it.raster.width !== w0 || it.raster.height !== h0) && Math.abs(it.raster.width / it.raster.height - w0 / h0) < 0.01 ? { ...it, raster: resample(it.raster, w0, h0) } : it);
      await new Promise((res) => setTimeout(res, 30));
      let res;
      try {
        res = stitch(items.map((i) => i.raster), { projection: r.projection || 'auto', blend: r.blend || 'smooth', evenExposure: r.evenExposure !== false, crop: r.crop !== false, maxPixels: (+r.maxMp || 40) * 1e6, focal35: items.map((i) => i.exif?.focal35), progress: (t) => toast(t, { ms: 1500 }) });
      } catch (e) { toast(`Stitch Panorama: ${(e as Error).message}.`, { ms: 5000 }); return; }
      await openRaster(app, res.raster, `${base(items[res.used[0]].entry.name)}-panorama.png`, 'Panorama');
      const left = res.skipped.map((i) => items[i].entry.name);
      toast(`Joined ${res.used.length} pictures (${res.projection}${res.focal ? `, focal length ≈ ${Math.round(res.focal)} px` : ''}), ${res.raster.width} × ${res.raster.height}${left.length ? `. Left out (no overlap found): ${left.join(', ')}` : ''}.`, { ms: left.length ? 7000 : 4000 });
      return { used: res.used.map((i) => items[i].entry.name), skipped: left, projection: res.projection, width: res.raster.width, height: res.raster.height, focal: res.focal, cropped: res.cropped };
    },
  },
  {
    id: 'create.focusStack', icon: 'center_focus_strong', noRecord: true, isEnabled: many, tip: 'Merges a focus bracket (near to far) into one picture that is sharp throughout',
    run: async (app) => {
      const entries = inputsOf(app);
      const r = await openDialog({ title: 'Focus Stack', ok: 'Stack', help: `${entries.length} pictures focused at different distances; they are lined up first unless you say not to.`, fields: [{ key: 'align', label: 'Line the pictures up (shift, turn, scale)', type: 'checkbox', value: true }, { key: 'radius', label: 'Smoothing of the choice (px)', type: 'range', min: 1, max: 16, value: 4 }, { key: 'map', label: 'Also open the map of which picture was used where', type: 'checkbox', value: false }] });
      if (!r) return;
      const items = await loadRasters(app, entries); if (items.length < 2) { toast('Fewer than two pictures could be loaded.'); return; }
      toast('Stacking…', { ms: 2000 }); await new Promise((res) => setTimeout(res, 30));
      const { raster, map, moved, failed } = focusStackRefined(sameSize(items), { radius: +r.radius, align: !!r.align });
      if (moved || failed) toast(`${moved ? `${moved} picture${moved > 1 ? 's' : ''} lined up` : ''}${moved && failed ? '; ' : ''}${failed ? `${failed} could not be matched and stayed as taken` : ''}.`, { ms: 5000 });
      await openRaster(app, raster, `${base(items[0].entry.name)}-stacked.png`, 'Focus stack');
      if (r.map) { const m = { width: raster.width, height: raster.height, data: new Uint8ClampedArray(raster.width * raster.height * 4) as Uint8ClampedArray<ArrayBuffer> }; for (let j = 0; j < map.length; j++) { const v = Math.round((map[j] * 255) / Math.max(1, items.length - 1)); m.data[j * 4] = v; m.data[j * 4 + 1] = 255 - v; m.data[j * 4 + 2] = 128; m.data[j * 4 + 3] = 255; } await openRaster(app, m, 'focus-map.png', 'Focus map'); }
    },
  },
  {
    id: 'create.webGallery', icon: 'web', noRecord: true, isEnabled: (app) => app.folder.length > 0, tip: 'A ZIP with index.html, thumbnails and resized pictures: a static gallery with a lightbox',
    run: async (app) => {
      const entries = inputsOf(app); const f = app.tab.folder;
      const r = await openDialog({ title: 'Web Gallery', ok: 'Save ZIP…', help: `${entries.length} pictures.`, fields: [{ key: 'title', label: 'Title', type: 'text', value: f.name || 'Gallery' }, { key: 'maxSide', label: 'Picture longest side (px)', type: 'number', min: 400, max: 6000, value: 1600, half: true }, { key: 'thumb', label: 'Thumbnail size (px)', type: 'number', min: 80, max: 800, value: 360, half: true }, { key: 'quality', label: 'JPEG quality (%)', type: 'number', min: 40, max: 100, value: 82, half: true }, { key: 'captions', label: 'Captions', type: 'select', options: [{ value: 'name', label: 'File name' }, { value: 'title', label: 'Title or caption from the metadata, else the name' }], value: 'title', half: true }] });
      if (!r) return;
      const { readMeta } = await import('../picture/metadata');
      const files: { name: string; data: Uint8Array }[] = []; const items: { file: string; thumb: string; caption: string; w: number; h: number }[] = []; let i = 0;
      for (const e of entries) {
        i++; if (i % 3 === 0) toast(`Encoding ${i} of ${entries.length}…`, { ms: 700 });
        try {
          const pic = await decodePicture(new Uint8Array(await e.read()), e);
          try {
            const src = pic.frameCanvas(); const make = async (max: number) => { const k = Math.min(1, max / Math.max(src.width, src.height)); const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(src.width * k)); c.height = Math.max(1, Math.round(src.height * k)); const x = c.getContext('2d')!; x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, c.width, c.height); return { c, data: new Uint8Array(await (await encodeCanvas(c, 'jpeg', +r.quality / 100)).arrayBuffer()) }; };
            const big = await make(+r.maxSide), th = await make(+r.thumb);
            const fn = `pictures/${String(i).padStart(3, '0')}-${base(e.name).replace(/[^\w.-]+/g, '_')}.jpg`, tn = `thumbs/${String(i).padStart(3, '0')}.jpg`;
            files.push({ name: fn, data: big.data }, { name: tn, data: th.data });
            let caption = e.name; if (r.captions === 'title') { const m = await readMeta(app, e); caption = m?.props.title || m?.props.description || e.name; }
            items.push({ file: fn, thumb: tn, caption, w: big.c.width, h: big.c.height });
          } finally { pic.release(); }
        } catch { /* skipped */ }
      }
      if (!items.length) { toast('No picture could be encoded.'); return; }
      files.unshift({ name: 'index.html', data: new TextEncoder().encode(GALLERY_HTML(String(r.title || 'Gallery'), items)) });
      const zip = writeZip(files);
      const saved = await saveAs(new Blob([zip as BlobPart], { type: 'application/zip' }), `${String(r.title || 'gallery').replace(/[\\/:*?"<>|]/g, '_')}-gallery.zip`);
      if (saved) toast(`Saved ${saved.name} (${items.length} pictures, ${fmtSize(zip.length)}); unzip and open index.html`);
    },
  },
  {
    id: 'create.calendar', icon: 'calendar_month', noRecord: true, isEnabled: (app) => !!app.picture, tip: 'A printable month page with this picture on top',
    run: async (app) => {
      const pic = app.picture!; const now = new Date();
      const r = await openDialog({ title: 'Calendar Page', ok: 'Create', fields: [{ key: 'year', label: 'Year', type: 'number', min: 1900, max: 2200, value: now.getFullYear(), half: true }, { key: 'month', label: 'Month', type: 'select', options: Array.from({ length: 12 }, (_, m) => ({ value: String(m), label: new Date(2000, m, 1).toLocaleString(undefined, { month: 'long' }) })), value: String(now.getMonth()), half: true }, { key: 'paper', label: 'Page', type: 'select', options: [{ value: 'a4', label: 'A4 portrait (300 dpi)' }, { value: 'letter', label: 'Letter portrait (300 dpi)' }], value: 'a4', half: true }, { key: 'monday', label: 'Weeks start on Monday', type: 'checkbox', value: true, half: true }, { key: 'bg', label: 'Background', type: 'color', value: '#ffffff', half: true }, { key: 'ink', label: 'Ink', type: 'color', value: '#222222', half: true }, { key: 'title', label: 'Title (blank for the month name)', type: 'text', value: '' }] });
      if (!r) return;
      const [W, H] = r.paper === 'a4' ? [2480, 3508] : [2550, 3300]; const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d')!;
      x.fillStyle = r.bg; x.fillRect(0, 0, W, H); const m = W * 0.06; const picH = H * 0.5;
      const src = pic.frameCanvas(); const k = Math.min((W - 2 * m) / src.width, picH / src.height), pw = src.width * k, ph = src.height * k; x.imageSmoothingQuality = 'high'; x.drawImage(src, (W - pw) / 2, m, pw, ph);
      const year = +r.year, month = +r.month; const monthName = new Date(year, month, 1).toLocaleString(undefined, { month: 'long' });
      x.fillStyle = r.ink; x.textAlign = 'center'; x.textBaseline = 'top'; x.font = `bold ${Math.round(W * 0.045)}px sans-serif`; x.fillText(String(r.title || `${monthName} ${year}`), W / 2, m + ph + W * 0.03);
      const days = (r.monday ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']); const top = m + ph + W * 0.11, cellW = (W - 2 * m) / 7, first = new Date(year, month, 1).getDay(), offset = r.monday ? (first + 6) % 7 : first, nDays = new Date(year, month + 1, 0).getDate(), rows = Math.ceil((offset + nDays) / 7), cellH = Math.min(W * 0.11, (H - top - m) / (rows + 0.6));
      x.font = `bold ${Math.round(W * 0.018)}px sans-serif`; days.forEach((d, i) => x.fillText(d, m + cellW * (i + 0.5), top)); x.strokeStyle = r.ink; x.lineWidth = 2;
      x.font = `${Math.round(W * 0.022)}px sans-serif`; x.textAlign = 'left';
      for (let d = 1; d <= nDays; d++) { const idx = offset + d - 1, col = idx % 7, row = Math.floor(idx / 7); const cx = m + col * cellW, cy = top + W * 0.035 + row * cellH; x.strokeRect(cx, cy, cellW, cellH); x.fillText(String(d), cx + W * 0.008, cy + W * 0.006); }
      const blob = await encodeCanvas(c, 'png'); await app.openFolder(new Folder([entryFromBytes(`calendar-${year}-${String(month + 1).padStart(2, '0')}.png`, await blob.arrayBuffer())], 'Calendar'), 0, { newWindow: true });
    },
  },
  {
    id: 'create.extractEmbedded', icon: 'unarchive', noRecord: true, tip: 'Pictures inside .docx, .pptx, .xlsx, .odt, .epub or any ZIP; from PDF, e-mail and other files by carving',
    run: async (app) => {
      const files = await openDocuments('*/*', ['*/*'], false); if (!files.length) return;
      const u8 = new Uint8Array(files[0].data); const bn = base(files[0].name);
      let found: { name: string; data: Uint8Array }[] = [];
      if (isZip(u8)) found = picturesInZip(u8);
      if (!found.length) { const exts = { jpeg: 'jpg', png: 'png', gif: 'gif', webp: 'webp', bmp: 'bmp', tiff: 'tif' }; found = carvePictures(u8).map((c, i) => ({ name: `${bn}-${String(i + 1).padStart(3, '0')}.${exts[c.format]}`, data: u8.slice(c.offset, c.offset + c.length) })); }
      if (!found.length) { toast(`No pictures found in ${files[0].name}.`); return; }
      const used = new Set<string>(); const entries = found.map((f) => { let n = f.name; let k = 2; while (used.has(n.toLowerCase())) n = f.name.replace(/(\.[^.]+)$/, ` (${k++})$1`); used.add(n.toLowerCase()); return entryFromBytes(n, f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength) as ArrayBuffer); });
      await app.openFolder(new Folder(entries, `Pictures in ${files[0].name}`), 0, { newWindow: true });
      toast(`${entries.length} picture${entries.length === 1 ? '' : 's'} from ${files[0].name}`);
    },
  },
  {
    id: 'create.movie', icon: 'movie', noRecord: true, isEnabled: (app) => app.folder.length > 0 && typeof (window as any).MediaRecorder === 'function', tip: 'A WebM video of the pictures with crossfades and gentle pan-and-zoom, recorded in the browser',
    run: async (app) => {
      const entries = inputsOf(app);
      const r = await openDialog({ title: 'Slideshow Video', ok: 'Record…', help: `${entries.length} pictures. The video is rendered in real time, so a 10-picture show at 3 s each takes about 30 s.`, fields: [{ key: 'seconds', label: 'Seconds per picture', type: 'number', min: 1, max: 30, value: 3, half: true }, { key: 'fade', label: 'Crossfade (s)', type: 'number', min: 0, max: 5, step: 0.5, value: 1, half: true }, { key: 'size', label: 'Size', type: 'select', options: [{ value: '1280x720', label: '1280 × 720' }, { value: '1920x1080', label: '1920 × 1080' }, { value: '1080x1080', label: '1080 × 1080 (square)' }], value: '1280x720', half: true }, { key: 'kenburns', label: 'Pan and zoom', type: 'checkbox', value: true, half: true }, { key: 'title', label: 'Title card (blank for none)', type: 'text', value: '' }] });
      if (!r) return;
      const items = await loadRasters(app, entries, 2000); if (!items.length) return;
      const [W, H] = String(r.size).split('x').map(Number); const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H; const x = canvas.getContext('2d')!;
      const imgs = items.map((it) => rasterFrame(it.raster, 0).image as HTMLCanvasElement);
      const stream = (canvas as any).captureStream(30) as MediaStream; const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => (window as any).MediaRecorder.isTypeSupported(m)) || 'video/webm';
      const rec = new (window as any).MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 }); const chunks: Blob[] = []; rec.ondataavailable = (e: any) => { if (e.data.size) chunks.push(e.data); };
      const done = new Promise<Blob>((res) => { rec.onstop = () => res(new Blob(chunks, { type: 'video/webm' })); });
      const per = +r.seconds * 1000, fade = Math.min(+r.fade * 1000, per / 2), titleMs = r.title ? 2500 : 0, total = titleMs + items.length * per;
      const drawPic = (i: number, t: number, alpha: number) => { const img = imgs[i]; const z = r.kenburns ? 1 + 0.08 * t : 1, k = Math.max(W / img.width, H / img.height) * z, w = img.width * k, h = img.height * k, px = (W - w) / 2 + (r.kenburns ? (i % 2 ? 1 : -1) * (w - W) * 0.3 * (t - 0.5) : 0), py = (H - h) / 2; x.globalAlpha = alpha; x.drawImage(img, px, py, w, h); x.globalAlpha = 1; };
      rec.start(100); const t0 = performance.now(); toast('Recording…', { ms: total });
      await new Promise<void>((res) => { const frame = () => { const el = performance.now() - t0; x.fillStyle = '#000'; x.fillRect(0, 0, W, H); if (el < titleMs) { x.fillStyle = '#fff'; x.font = `bold ${Math.round(H * 0.08)}px sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(String(r.title), W / 2, H / 2); } else { const e2 = el - titleMs, i = Math.min(items.length - 1, Math.floor(e2 / per)), t = (e2 - i * per) / per; drawPic(i, t, 1); const into = e2 - i * per; if (fade && i + 1 < items.length && into > per - fade) drawPic(i + 1, 0, (into - (per - fade)) / fade); } if (el < total) requestAnimationFrame(frame); else res(); }; requestAnimationFrame(frame); });
      rec.stop(); const blob = await done;
      const saved = await saveAs(blob, `${(app.tab.folder.name || 'slideshow').replace(/[\\/:*?"<>|]/g, '_')}.webm`);
      if (saved) toast(`Saved ${saved.name} (${fmtSize(blob.size)})`);
    },
  },
]);
