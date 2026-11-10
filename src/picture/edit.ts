/**
 * Applying raster operations to the picture in a window as undoable edits: every frame of the current
 * page (or every page) goes canvas → RGBA → operation → canvas.
 */
import type { App, PictureTab } from '../app';
import type { Page, Frame } from './model';
import type { Raster } from '../codecs/raster';
import { crop } from './ops';
import { composeMasked } from './mask';

export function frameRaster(f: Frame): Raster {
  const c = f.image instanceof HTMLCanvasElement ? f.image : (() => { const cv = document.createElement('canvas'); cv.width = f.width; cv.height = f.height; cv.getContext('2d')!.drawImage(f.image as CanvasImageSource, 0, 0); return cv; })();
  const id = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, f.width, f.height);
  return { width: f.width, height: f.height, data: id.data as Uint8ClampedArray<ArrayBuffer> };
}

export function rasterFrame(r: Raster, delay: number): Frame {
  const c = document.createElement('canvas'); c.width = r.width; c.height = r.height;
  c.getContext('2d')!.putImageData(new ImageData(r.data, r.width, r.height), 0, 0);
  return { image: c, width: r.width, height: r.height, delay };
}

/** The page with every frame replaced by `fn(raster)`. */
export function mapPageRaster(page: Page, fn: (r: Raster, index: number) => Raster, patch: Partial<Page> = {}): Page {
  const frames = page.frames.map((f, i) => rasterFrame(fn(frameRaster(f), i), f.delay));
  const out: Page = { ...page, width: frames[0].width, height: frames[0].height, frames, ...patch };
  if (out.width !== page.width || out.height !== page.height) delete out.textLayer; // the word boxes no longer match
  return out;
}

/** One undoable edit of the current page (or all pages). Clears the selection when the size changes unless `keepSelection`. */
export function editRaster(app: App, label: string, fn: (r: Raster, index: number) => Raster, opts: { allPages?: boolean; keepSelection?: boolean; patch?: Partial<Page>; /** The window to edit when it is not the active one (a result that arrives later). */ tab?: PictureTab } = {}): void {
  const tab = opts.tab || app.tab;
  const pic = tab.picture;
  if (!pic) return;
  const before = { w: pic.width, h: pic.height };
  tab.edit(label, (p) => { p.pages = p.pages.map((pg, i) => (opts.allPages || i === p.page ? mapPageRaster(pg, fn, opts.patch) : pg)); });
  if (!opts.keepSelection && (pic.width !== before.w || pic.height !== before.h)) tab.setSelection(null);
  else if (opts.keepSelection === false) tab.setSelection(null);
}

/** Applies `fn` to the selected area only (the rest unchanged); whole picture when nothing is selected. */
export function editSelection(app: App, label: string, fn: (r: Raster) => Raster): void {
  const sel = app.tab.selection, mask = app.tab.selectionMask;
  editRaster(app, label, (r) => {
    if (!sel) return fn(r);
    if (mask && mask.length === r.width * r.height) { const done = fn(crop(r, sel)); return done.width === sel.w && done.height === sel.h ? composeMasked(r, done, sel, mask) : r; }
    const sub = { width: sel.w, height: sel.h, data: new Uint8ClampedArray(sel.w * sel.h * 4) as Uint8ClampedArray<ArrayBuffer> };
    for (let y = 0; y < sel.h; y++) sub.data.set(r.data.subarray(((sel.y + y) * r.width + sel.x) * 4, ((sel.y + y) * r.width + sel.x + sel.w) * 4), y * sel.w * 4);
    const done = fn(sub);
    const out = { width: r.width, height: r.height, data: r.data.slice() as Uint8ClampedArray<ArrayBuffer> };
    if (done.width === sel.w && done.height === sel.h) for (let y = 0; y < sel.h; y++) out.data.set(done.data.subarray(y * sel.w * 4, (y + 1) * sel.w * 4), ((sel.y + y) * r.width + sel.x) * 4);
    return out;
  }, { keepSelection: true });
}
