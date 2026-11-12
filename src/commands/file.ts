/** File commands: open (files, folders, recent, dropped, launched), save, reload, print, share, close, options, settings transfer, portable mode. */
import { def } from './registry';
import type { App, PictureTab } from '../app';
import type { Picture } from '../picture/model';
import { Folder, entryFromFile, entryFromBytes, entryFromUri, entryFromHandle, isPictureName, isSharedPictureName, sharedMaxBytes, type Entry } from '../picture/folder';
import { canListSubfolders, listing, type FolderEntry } from '../platform/native';
import { openDocuments, openFolderDialog, listFolderOf, saveAs, writeBack, shareFile, readUri, printDocument, isDesktop, isCapacitor, desktopBridge, writeClipboardText, type OpenedFile } from '../platform/native';
import { OPEN_ACCEPT, OPEN_MIMES, FORMATS, encodeCanvas, ENCODERS, encoderFor, type EncodeFormat } from '../codecs/registry';
import { openDialog, toast, confirmDialog, choiceDialog } from '../ui/dialog';
import { sanitizePrefs, parseKeyList, DEFAULT_QAT, type Prefs, prefsWithoutKeys } from '../prefs';
import { allCommands, getCommand } from './registry';
import { h, esc } from '../ui/dom';
import { fmtSize } from '../ui/shell';
import { extractMeta, hasMeta, injectMeta, setExifOrientation } from '../meta/metaWrite';
import { parseXmp } from '../meta/xmp';
import { keepOriginalCopy } from '../picture/keepOriginal';
import { paintHooks } from '../paint/hooks';
import { installCustomMenus } from '../ui/classicMenus';
import { iccForSave, writeWithProfile, profileName } from '../color/embedded';

/** Archive file names that open as folders. */
export const ARCHIVE_NAME = /\.(zip|cbz|epub|7z|cb7|rar|cbr|tar|cbt|tgz|tbz2?|txz|tar\.(gz|bz2|xz))$/i;
/** A ZIP/CBZ/EPUB, 7z/CB7, RAR/CBR or tar/CBT (plain, gzip, bzip2 or xz) opened as a folder: the pictures inside, read on demand, in natural order. */
export async function archiveFolder(name: string, data: ArrayBuffer): Promise<Folder | null> {
  const u8 = new Uint8Array(data);
  type Item = { name: string; size: number; mtime: number; read: () => Promise<Uint8Array> };
  let items: Item[] = [], warnings: string[] = [];
  const { isZip, readZip, readZipEntry } = await import('../codecs/zip');
  const { isSevenZip, SevenZip } = await import('../codecs/sevenzip');
  try {
    if (isZip(u8)) {
      const r = readZip(u8); warnings = r.warnings;
      items = r.entries.map((e) => ({ name: e.name, size: e.size, mtime: e.mtime, read: async () => readZipEntry(u8, e) }));
    } else if (isSevenZip(u8)) {
      const z = await SevenZip.open(u8); warnings = z.warnings;
      if (z.encrypted) throw new Error('This 7z archive is encrypted (AES), which Anne\'s Lens does not open');
      items = z.entries.map((e) => ({ name: e.name, size: e.size, mtime: e.mtime, read: () => z.read(e) }));
    } else if (u8.length > 7 && u8[0] === 0x52 && u8[1] === 0x61 && u8[2] === 0x72 && u8[3] === 0x21) {
      const { Rar } = await import('../codecs/rar');
      const r = new Rar(u8); warnings = r.warnings;
      if (r.headersEncrypted) throw new Error('This RAR archive is encrypted, which Anne\'s Lens does not open');
      if (r.volume) warnings = [...warnings, 'This is one volume of a multi-volume RAR archive; files that continue in another volume are left out'];
      items = r.entries.filter((e) => !e.dir && !e.link && !e.split && !e.encrypted).map((e) => ({ name: e.name, size: e.size, mtime: e.mtime, read: async () => r.read(e) }));
      if (!items.length && r.encrypted) throw new Error('This RAR archive is encrypted, which Anne\'s Lens does not open');
    } else {
      const { untarable, readTar } = await import('../codecs/tar');
      const t = await untarable(u8); if (!t) return null;
      const r = readTar(t.tar); warnings = t.warning ? [t.warning, ...r.warnings] : r.warnings;
      items = r.entries.map((e) => ({ name: e.name, size: e.size, mtime: e.mtime, read: async () => t.tar.subarray(e.offset, e.offset + e.size) }));
    }
  } catch (e) { toast(`${name}: ${(e as Error).message}.`, { ms: 6000 }); return null; }
  const pics = items.filter((e) => isPictureName(e.name) && e.size > 0 && !/(^|\/)(__MACOSX|\.)/.test(e.name));
  if (!pics.length) { toast(`${name} holds no pictures Anne's Lens can open${warnings.length ? ` (${warnings[0]})` : ''}.`); return null; }
  const list: Entry[] = pics.map((e) => ({
    name: e.name.split('/').pop() || e.name, uri: null, size: e.size, mtime: e.mtime,
    read: async () => { const b = await e.read(); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; },
  }));
  const folder = new Folder(list, name);
  folder.sort('natural');
  if (warnings.length) toast(`${name}: ${warnings[0]}`, { ms: 6000 });
  return folder;
}

/** Opens a set of files (picker, drop, launch). One file on the desktop pulls in its folder; an archive opens as a folder. */
export async function openFiles(app: App, files: OpenedFile[], opts: { newWindow?: boolean } = {}): Promise<void> {
  if (!files.length) return;
  if (files.length === 1 && /\.qlpe$/i.test(files[0].name)) { const { openEncrypted } = await import('./tools'); await openEncrypted(app, files[0].name, new Uint8Array(files[0].data)); return; }
  if (files.length === 1 && (ARCHIVE_NAME.test(files[0].name) || /^(80,75,3,4|55,122,188,175|82,97,114,33)$/.test(new Uint8Array(files[0].data, 0, 4).join(',')))) {
    const folder = await archiveFolder(files[0].name, files[0].data);
    if (folder) { await app.openFolder(folder, 0, opts); return; }
  }
  const entries = files.map((f) => entryFromBytes(f.name, f.data, f.uri));
  let folder = new Folder(entries, files.length === 1 ? 'Opened file' : `${files.length} files`);
  let index = 0;
  if (files.length === 1 && files[0].uri && isDesktop()) {
    const listed = await listFolderOf(files[0].uri);
    if (listed && listed.entries.length) {
      const all = listed.entries.map((e) => (e.uri === files[0].uri ? entries[0] : entryFromUri(e)));
      if (!all.includes(entries[0])) all.push(entries[0]); // a name the listing leaves out (.img and the like)
      folder = new Folder(all, listed.name);
      folder.uri = listed.uri;
      index = Math.max(0, all.indexOf(entries[0]));
      addRecentFolder(app, listed.name, listed.uri);
    }
  }
  folder.sort(app.prefs.sort, app.prefs.sortDescending);
  if (files.length === 1 && folder.length > 1) index = folder.entries.indexOf(entries[0]);
  await app.openFolder(folder, index, opts);
}

export async function openDroppedFiles(app: App, files: File[]): Promise<void> {
  if (files.length === 1 && ARCHIVE_NAME.test(files[0].name)) { const folder = await archiveFolder(files[0].name, await files[0].arrayBuffer()); if (folder) await app.openFolder(folder, 0); return; }
  const list: File[] = [];
  for (const f of files) {
    if (isPictureName(f.name) || f.type.startsWith('image/') || !/\./.test(f.name)) list.push(f);
    else if (isSharedPictureName(f.name) && f.size <= sharedMaxBytes(f.name)) { // .img and the like: a picture only if its content says so
      const { sniff } = await import('../codecs/registry');
      if (sniff(new Uint8Array(await f.arrayBuffer()), f.name)) list.push(f);
    }
  }
  if (!list.length) { toast('None of the dropped files is a picture Anne\'s Lens can open.'); return; }
  const folder = new Folder(list.map(entryFromFile), list.length === 1 ? list[0].name : `${list.length} dropped files`);
  folder.sort(app.prefs.sort, app.prefs.sortDescending);
  await app.openFolder(folder, 0);
}

function addRecentFolder(app: App, name: string, uri: string | null): void {
  if (!uri) return;
  const list = app.prefs.recentFolders.filter((r) => r.key !== uri);
  list.unshift({ key: uri, name, when: Date.now(), uri });
  app.prefs.recentFolders = list.slice(0, 20);
  app.savePrefs();
}

/** Entries for a folder listing: platform URIs, File System Access handles or File objects. */
export function listingEntries(r: { entries?: FolderEntry[]; handles?: { name: string; handle: any }[]; files?: File[] }): Entry[] {
  if (r.entries) return r.entries.map(entryFromUri);
  if (r.handles) return r.handles.filter((x) => listing.allFiles || isPictureName(x.name)).map((x) => entryFromHandle(x.name, x.handle));
  if (r.files) return r.files.filter((f) => listing.allFiles || isPictureName(f.name)).map(entryFromFile);
  return [];
}
/** Shows a listed folder in the current window, sorted as the preferences say. */
export async function showFolder(app: App, name: string, uri: string | null, entries: Entry[], treeTop: string | null | undefined, index = 0): Promise<void> {
  const folder = new Folder(entries, name);
  folder.uri = uri; folder.treeTop = treeTop;
  folder.sort(app.prefs.sort, app.prefs.sortDescending);
  addRecentFolder(app, name, uri);
  await app.openFolder(folder, index);
}

async function openFolderFromDialog(app: App): Promise<void> {
  const r = await openFolderDialog();
  if (!r) return;
  const top = isDesktop() ? null : r.uri;
  const entries = listingEntries(r);
  if (!entries.length) {
    // A folder of folders (years, events): show the first folder inside it that has pictures.
    if (r.uri && canListSubfolders(r.uri)) { const { firstInside } = await import('./viewWindow'); if (await firstInside(app, { uri: r.uri, name: r.name }, top)) return; }
    toast(`No pictures in ${r.name}.`); return;
  }
  await showFolder(app, r.name, r.uri, entries, top);
}

export type SaveFormat = EncodeFormat;
const EXT = Object.fromEntries(Object.entries(ENCODERS).map(([k, v]) => [k, v.ext])) as Record<SaveFormat, string>;
const SAVE_OPTIONS = Object.entries(ENCODERS).map(([value, v]) => ({ value, label: v.label }));

/** Encodes the tab's picture (its current page) in the format chosen, asking for options unless given. The tab is the one being saved, which is not always the active window. */
async function produce(app: App, tab: PictureTab, format?: SaveFormat, quality?: number): Promise<{ blob: Blob; name: string } | null> {
  const pic = tab.picture!;
  const base = pic.name.replace(/\.[^.]+$/, '') || 'picture';
  let fmt = format, q = quality;
  let opts: { rle?: boolean; threshold?: number } = { rle: app.prefs.tgaRle };
  if (!fmt) {
    const current = encoderFor(pic.format.id) || (ENCODERS[app.prefs.defaultSaveFormat as SaveFormat] ? (app.prefs.defaultSaveFormat as SaveFormat) : 'png');
    const r = await openDialog({ title: 'Save As', fields: [
      { key: 'format', label: 'Format', type: 'select', options: SAVE_OPTIONS, value: current },
      { key: 'quality', label: 'Quality', type: 'range', min: 1, max: 100, value: app.prefs.jpegQuality, visibleIf: (v) => !!ENCODERS[v.format as SaveFormat]?.lossy },
      { key: 'rle', label: 'Compress runs (RLE)', type: 'checkbox', value: app.prefs.tgaRle, visibleIf: (v) => v.format === 'tga' },
      { key: 'threshold', label: 'Black below this brightness', type: 'range', min: 1, max: 254, value: 128, visibleIf: (v) => v.format === 'wbmp' },
      { key: 'keepMeta', label: 'Keep metadata (EXIF, XMP, color profile)', type: 'checkbox', value: app.prefs.keepMetadata, visibleIf: (v) => ['jpeg', 'png', 'webp'].includes(v.format) },
      ...(pic.current.icc ? [{ key: 'icc', type: 'info' as const, label: `Color profile: ${profileName(pic.current.icc)}. JPEG, PNG and WebP embed it whether or not metadata is kept; the other formats save the values untagged, so convert to sRGB first (Image ▸ Convert to Color Profile) for them.` }] : []),
      { key: 'i', type: 'info', label: `${pic.current.hasAlpha ? 'Transparent pixels: kept in PNG, WebP, BMP, TGA, PAM and QOI; flattened onto white in JPEG, PPM, PGM and WBMP. ' : ''}${hasMeta(extractMeta(pic.bytes)) ? 'The file\'s EXIF, XMP and color profile go into JPEG, PNG and WebP output when "Keep metadata" is on; the orientation tag is reset when the picture was turned upright.' : 'This file carries no EXIF, XMP or color profile to pass on.'}` },
    ], ok: 'Save' });
    if (!r) return null;
    fmt = r.format; q = r.quality; opts = { rle: !!r.rle, threshold: +r.threshold || 128 };
    app.prefs.jpegQuality = q!; app.prefs.defaultSaveFormat = fmt!; app.prefs.tgaRle = !!r.rle; app.prefs.keepMetadata = !!r.keepMeta; app.savePrefs();
  }
  const c = pic.frameCanvas();
  let blob = await encodeCanvas(c, fmt!, (q ?? app.prefs.jpegQuality) / 100, opts);
  if ((app.prefs.keepMetadata || pic.current.icc) && (fmt === 'jpeg' || fmt === 'png' || fmt === 'webp')) blob = await withMetadata(blob, pic.bytes, fmt, pic.orientationApplied || tab.dirty, { keep: app.prefs.keepMetadata, icc: pic.current.icc });
  if (app.prefs.ai.credentials && (fmt === 'jpeg' || fmt === 'png' || fmt === 'webp')) blob = await withCredentials(app, blob, pic.bytes, fmt, `${base}.${EXT[fmt!]}`, pic.entry.ingredient, tab.dirty);
  return { blob, name: `${base}.${EXT[fmt!]}` };
}

/**
 * Adds the source file's EXIF and XMP (unless `keep` is false) and the color profile to an encoded
 * JPEG, PNG or WebP: the page's profile (`icc`), or the source's own when the pixels are sRGB and it
 * is an sRGB profile. `upright` resets the Orientation tag.
 */
export async function withMetadata(blob: Blob, source: Uint8Array, format: 'jpeg' | 'png' | 'webp', upright: boolean, o: { keep?: boolean; icc?: Uint8Array } = {}): Promise<Blob> {
  const meta = o.keep === false ? {} : extractMeta(source);
  const icc = iccForSave(o.icc, meta.icc);
  if (!hasMeta({ ...meta, icc })) return blob;
  if (meta.exif && upright) meta.exif = setExifOrientation(meta.exif, 1);
  const bytes = await writeWithProfile(new Uint8Array(await blob.arrayBuffer()), format, meta, icc);
  return new Blob([bytes as BlobPart], { type: blob.type });
}

declare const __APP_VERSION__: string;
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
/**
 * Content Credentials: when the source carries the app's AI provenance (an AI result), the saved JPEG or PNG gets a
 * signed C2PA manifest (the action, its source type, the service and model, the prompt), signed with this device's
 * own self-signed certificate from the keystore. Pictures without AI provenance are left as they are.
 */
export async function withCredentials(app: App, blob: Blob, source: Uint8Array, format: 'jpeg' | 'png' | 'webp', name: string, ingredient?: { name: string; bytes: Uint8Array; mime: string }, edited = !!app.tab?.dirty): Promise<Blob> {
  try {
    const xmp = extractMeta(source).xmp;
    if (!xmp) return blob;
    const props = parseXmp(new TextDecoder().decode(xmp));
    if (!props.aiCommand) return blob;
    const [{ embedManifest, makeSigner, loadSigner }, { keysReady, getExtra, setExtra }] = await Promise.all([import('../meta/c2pa'), import('../ai/keystore')]);
    await keysReady();
    let stored = getExtra('c2pa.signer');
    if (!stored) { stored = JSON.stringify(await makeSigner("Anne's Lens on this device", "Anne's Lens")); await setExtra('c2pa.signer', stored); }
    const signer = await loadSigner(JSON.parse(stored));
    const generated = /trainedAlgorithmicMedia$/.test(props.digitalSourceType || '') && !/composite/.test(props.digitalSourceType || '');
    const agent = `Anne's Lens/${APP_VERSION}`, now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const parameters: Record<string, string> = {};
    if (props.aiProvider) parameters.service = props.aiProvider;
    if (props.aiModel) parameters.model = props.aiModel;
    if (props.aiPrompt) parameters.prompt = props.aiPrompt;
    const bytes = await embedManifest(new Uint8Array(await blob.arrayBuffer()), {
      title: name, format: format === 'jpeg' ? 'image/jpeg' : format === 'png' ? 'image/png' : 'image/webp', generator: { name: "Anne's Lens", version: APP_VERSION },
      ingredient: ingredient ? { title: ingredient.name, format: ingredient.mime, bytes: ingredient.bytes, thumbnail: await thumbnailOf(ingredient.bytes) } : undefined,
      action: { action: generated ? 'c2pa.created' : 'c2pa.edited', when: props.aiDate && !Number.isNaN(Date.parse(props.aiDate)) ? new Date(props.aiDate).toISOString().replace(/\.\d{3}Z$/, 'Z') : now, softwareAgent: agent, digitalSourceType: props.digitalSourceType || 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia', description: `${props.aiCommand}${props.aiProvider ? ` with ${props.aiProvider}` : ''}${props.aiModel ? ` (${props.aiModel})` : ''}`, parameters },
      more: edited ? [{ action: 'c2pa.edited', when: now, softwareAgent: agent, description: 'edited in Anne\'s Lens before saving' }] : [],
    }, signer);
    return new Blob([bytes as BlobPart], { type: blob.type });
  } catch (e) { toast(`Content Credentials could not be added: ${(e as Error).message}`); return blob; }
}

/** A small JPEG of a picture's file for the ingredient (the platform decodes it; null where it cannot). */
async function thumbnailOf(bytes: Uint8Array): Promise<{ bytes: Uint8Array; mime: string } | undefined> {
  try {
    const bmp = await createImageBitmap(new Blob([bytes as BlobPart]));
    const scale = Math.min(1, 256 / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale)); c.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = c.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
    const b = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.8));
    return b ? { bytes: new Uint8Array(await b.arrayBuffer()), mime: 'image/jpeg' } : undefined;
  } catch { return undefined; }
}

/** Save: back into the same file when the format can be written and the file is writable; otherwise Save As. */
export async function saveTab(app: App, tab: PictureTab, opts: { as?: boolean; format?: SaveFormat; copy?: boolean } = {}): Promise<boolean> {
  if (!tab.picture) return false;
  if (!(await paintHooks.beforeSave(app, tab))) return false;
  if (tab.showingOriginal) tab.showOriginal(false); // Before / After shows the original; what is saved is the edited picture
  const pic = tab.picture;
  if (!pic) return false;
  const writable = encoderFor(pic.format.id);
  if (!opts.as && !opts.copy && pic.entry.uri && writable && writesBackWhole(pic, writable)) {
    try {
      const out = await produce(app, tab, writable, app.prefs.jpegQuality);
      if (!out) return false;
      if (tab.picture !== pic) return false; // the window moved on while the picture was encoded
      await keepOriginalCopy(app, tab);
      if (await writeBack(pic.entry.uri, out.blob)) { await reloadAfterSave(app, tab, pic, out.blob); toast(`Saved ${pic.name}`); return true; }
    } catch (e) { console.warn(e); }
  }
  const out = await produce(app, tab, opts.format);
  if (!out) return false;
  const r = await saveAs(out.blob, out.name);
  if (!r) return false;
  if (!opts.copy) {
    const data = await out.blob.arrayBuffer();
    const e = entryFromBytes(r.name, data, r.uri);
    // The saved file joins the folder after the picture it came from (or replaces that entry when it is the same file).
    // The picture's own place is looked up: the folder's index may already point at the next picture (Save from "Save changes?").
    const f = tab.folder;
    const at = f.entries.indexOf(pic.entry), i = at >= 0 ? at : f.index, same = r.name === pic.name && pic.entry.uri === r.uri;
    if (same && at >= 0) f.entries[i] = e; else f.entries.splice(i + 1, 0, e);
    tab.loader.invalidate(pic.entry);
    f.select(same && at >= 0 ? i : i + 1);
    tab.dirty = false; tab.clearHistory();
    await tab.show();
  }
  toast(`Saved ${r.name}`);
  return true;
}

/**
 * Whether writing the picture back in its own format keeps what the file holds: one page, one frame, and for the
 * Netpbm family the same kind (an 8-bit color PPM). Anything else (an animation, a multi-page file, a PAM with
 * transparency, a 16-bit or float map) goes through Save As instead of being flattened into the old name.
 */
export function writesBackWhole(pic: { pages: { frames: unknown[]; bitDepth?: number; hasAlpha?: boolean }[]; name: string; format: { id: string } }, encoder: SaveFormat): boolean {
  if (pic.pages.length !== 1 || pic.pages[0].frames.length !== 1) return false;
  if (pic.format.id === 'pnm') return encoder === 'ppm' && /\.ppm$/i.test(pic.name) && !pic.pages[0].hasAlpha && (pic.pages[0].bitDepth ?? 24) <= 24;
  return true;
}

async function reloadAfterSave(app: App, tab: PictureTab, pic: Picture, blob: Blob): Promise<void> {
  const data = await blob.arrayBuffer();
  const e = entryFromBytes(pic.name, data, pic.entry.uri);
  // The saved picture's own entry, wherever the folder's index points now (it has moved on when the save came from "Save changes?").
  const at = tab.folder.entries.indexOf(pic.entry);
  if (at >= 0) tab.folder.entries[at] = e;
  tab.loader.invalidate(pic.entry);
  tab.dirty = false; tab.clearHistory();
  await tab.show();
}

def([
  {
    id: 'file.open', icon: 'folder_open', popular: true, noRecord: true,
    tip: 'One or several pictures; on the desktop the rest of the folder follows',
    run: async (app) => { const files = await openDocuments(OPEN_ACCEPT, OPEN_MIMES, true); if (!files.length) return; await openFiles(app, files); app.ui.hideBackstage(); },
  },
  { id: 'file.openFolder', icon: 'folder', popular: true, noRecord: true, tip: 'Every picture in a folder, in the current sort order', run: async (app) => { await openFolderFromDialog(app); app.ui.hideBackstage(); } },
  {
    id: 'file.openDropped', label: 'Open Dropped Files', icon: 'file_open', tab: 'File', internal: true, noRecord: true,
    run: (app, files: File[]) => openDroppedFiles(app, files || []),
  },
  {
    id: 'file.openRecent', icon: 'history', kind: 'menu', noRecord: true,
    run: async (app, key?: string) => {
      if (!key) return app.ui.showBackstage('open');
      const rec = app.prefs.recent.find((r) => r.key === key);
      if (!rec || !rec.uri) return;
      const f = await readUri(rec.uri);
      if (!f) { toast('That file is no longer available. Use Open to locate it.'); app.prefs.recent = app.prefs.recent.filter((r) => r !== rec); app.savePrefs(); return; }
      await openFiles(app, [f]);
      app.ui.hideBackstage();
    },
    menu: (app) => app.prefs.recent.length ? app.prefs.recent.slice(0, 15).map((r) => ({ id: 'file.openRecent', arg: r.key, label: (r.pinned ? '📌 ' : '') + r.name })) : [{ label: '(no recent pictures)' }],
  },
  {
    id: 'file.recentFolders', icon: 'folder_special', kind: 'menu', noRecord: true,
    isEnabled: () => isDesktop(),
    run: async (app, key?: string) => {
      const rec = app.prefs.recentFolders.find((r) => r.key === key) || app.prefs.recentFolders[0];
      if (!rec?.uri) { toast('No recent folders yet.'); return; }
      const listed = await listFolderOf(rec.uri);
      if (!listed || !listed.entries.length) { toast(`${rec.name} has no pictures now.`); return; }
      const folder = new Folder(listed.entries.map(entryFromUri), listed.name); folder.uri = listed.uri;
      folder.sort(app.prefs.sort, app.prefs.sortDescending);
      await app.openFolder(folder, 0);
    },
    menu: (app) => app.prefs.recentFolders.length ? app.prefs.recentFolders.map((r) => ({ id: 'file.recentFolders', arg: r.key, label: r.name })) : [{ label: '(no recent folders)' }],
  },
  { id: 'file.clearRecent', icon: 'delete_sweep', noRecord: true, run: (app) => { app.prefs.recent = app.prefs.recent.filter((r) => r.pinned); app.prefs.recentFolders = []; app.savePrefs(); toast('Recent lists cleared'); } },
  {
    id: 'file.newWindow', icon: 'open_in_new', noRecord: true, tip: 'Another window (tab) on the same folder, or a new empty one',
    run: async (app) => {
      const f = app.folder;
      if (!f.length) { app.createTab(); return; }
      const folder = new Folder([...f.entries], f.name); folder.uri = f.uri;
      await app.openFolder(folder, f.index, { newWindow: true });
    },
  },
  {
    id: 'file.revealInFolder', icon: 'folder_open', noRecord: true, isEnabled: (app) => isDesktop() && !!app.picture?.entry.uri,
    run: (app) => desktopBridge()!.revealInFolder({ uri: app.picture!.entry.uri! }),
  },
  {
    id: 'file.openWith', icon: 'open_in_new', noRecord: true, isEnabled: (app) => isDesktop() && !!app.picture?.entry.uri,
    run: async (app) => { const r = await desktopBridge()!.openWith({ uri: app.picture!.entry.uri! }); if (!r.ok) toast(r.error || 'No program is registered for this type.'); },
  },
  { id: 'file.copyName', icon: 'content_copy', noRecord: true, isEnabled: (app) => !!app.picture, run: async (app) => { await writeClipboardText(app.picture!.name); toast('File name copied'); } },
  { id: 'file.copyPath', icon: 'content_copy', noRecord: true, isEnabled: (app) => !!app.picture?.entry.uri, run: async (app) => { await writeClipboardText(app.picture!.entry.uri!.replace(/^file:\/\//, '')); toast('Path copied'); } },
]);

// Save ----------------------------------------------------------------------------------------

def([
  { id: 'file.save', icon: 'save', popular: true, noRecord: true, isEnabled: (app) => !!app.picture, tip: 'Writes back to the same file when its format can be written (PNG, JPEG, WebP, BMP, TGA, PPM, QOI, WBMP); otherwise asks where', run: (app) => saveTab(app, app.tab) },
  { id: 'file.saveAs', icon: 'save_as', popular: true, noRecord: true, isEnabled: (app) => !!app.picture, run: (app, format?: SaveFormat) => saveTab(app, app.tab, { as: true, format: format && EXT[format] ? format : undefined }) },
  { id: 'file.saveCopy', icon: 'file_copy', noRecord: true, isEnabled: (app) => !!app.picture, run: (app) => saveTab(app, app.tab, { as: true, copy: true }) },
  { id: 'file.saveAll', icon: 'library_add_check', noRecord: true, run: async (app) => { for (const t of app.tabs) if (t.dirty && t.picture) { app.activate(t); await saveTab(app, t); } } },
  {
    id: 'file.reload', icon: 'refresh', noRecord: true, isEnabled: (app) => !!app.picture || !!app.folder.current,
    run: async (app) => {
      const t = app.tab;
      if (t.dirty && !(await confirmDialog('Reload', 'Discard the unsaved changes and read the file again?'))) return;
      const e = t.folder.current; if (!e) return;
      t.loader.invalidate(e); t.dirty = false; t.clearHistory();
      await t.show();
    },
  },
]);

// Print, share ----------------------------------------------------------------------------------

/** Prints the active picture: fitted to the page, or at `dpi` (the file's, or given) times the calibration `scale`. */
export async function printPicture(app: App, opts: { fit: 'page' | 'actual'; title?: boolean; dpi?: number; scale?: number; extra?: HTMLElement } = { fit: 'page' }): Promise<void> {
  const pic = app.picture;
  if (!pic) return;
  const blob = await encodeCanvas(pic.frameCanvas(), 'png');
  const url = URL.createObjectURL(blob);
  const root = document.getElementById('ql-print-root') || document.body.appendChild(h('div', { id: 'ql-print-root' }));
  root.innerHTML = '';
  const dpi = opts.dpi || pic.current.dpi?.[0] || 96;
  const scale = opts.scale || 1;
  const img = h('img', { src: url, alt: pic.name, style: opts.fit === 'actual' ? `width:${((pic.width / dpi) * scale).toFixed(4)}in;height:auto;max-width:none` : 'max-width:100%;max-height:95vh;object-fit:contain' });
  root.appendChild(h('div', { class: 'ql-print-page' }, img, opts.title ? h('div', { style: 'font:11px sans-serif;margin-top:4px' }, pic.name) : null, opts.extra || null));
  await new Promise((r) => { img.onload = () => r(null); img.onerror = () => r(null); });
  document.body.classList.add('ql-printing');
  try { await printDocument(pic.name); } finally { setTimeout(() => { document.body.classList.remove('ql-printing'); root.innerHTML = ''; URL.revokeObjectURL(url); }, 1000); }
}

def([
  {
    id: 'file.print', icon: 'print', popular: true, noRecord: true, isEnabled: (app) => !!app.picture,
    run: async (app) => {
      const r = await openDialog({ title: 'Print', fields: [
        { key: 'fit', label: 'Size', type: 'radio', options: [{ value: 'page', label: 'Fit to the page' }, { value: 'actual', label: `Actual size at the picture's resolution (${app.picture!.current.dpi?.[0] || 96} dpi)` }], value: app.prefs.print.fit },
        { key: 'title', label: 'Print the file name under the picture', type: 'checkbox', value: app.prefs.print.captions },
        { key: 'i', type: 'info', label: 'Several pictures per page: Print Layouts. Copies and posters: Print Copies and Posters. Paper and margins: Print Setup.' },
      ], ok: 'Print', buttons: [{ label: 'Setup…', onClick: (_v, ctl) => { ctl.close(null); app.exec('file.printSetup'); } }] });
      if (!r) return;
      app.ui.hideBackstage();
      await printPicture(app, { fit: r.fit, title: r.title });
    },
  },
  { id: 'file.quickPrint', icon: 'print', noRecord: true, isEnabled: (app) => !!app.picture, run: (app) => printPicture(app) },
  {
    id: 'file.printPreview', icon: 'preview', noRecord: true, isEnabled: (app) => !!app.picture,
    run: async (app) => {
      const pic = app.picture!;
      const blob = await encodeCanvas(pic.frameCanvas(), 'png');
      const url = URL.createObjectURL(blob);
      const page = h('div', { class: 'qn-print-preview' }, h('img', { src: url, alt: pic.name }));
      const r = await openDialog({ title: 'Print Preview', wide: true, content: page, ok: 'Print…', cancel: 'Close' });
      URL.revokeObjectURL(url);
      if (r) app.exec('file.print');
    },
  },
  {
    id: 'file.share', icon: 'share', popular: true, noRecord: true, isEnabled: (app) => !!app.picture,
    run: async (app) => { const pic = app.picture!; await shareFile(new Blob([pic.bytes as BlobPart], { type: pic.format.mime }), pic.name, pic.name); },
  },
  {
    id: 'file.email', icon: 'attach_email', noRecord: true, isEnabled: (app) => !!app.picture, tip: 'Attach to an email through the share sheet (Anne\'s Post when installed)',
    run: async (app) => { const pic = app.picture!; await shareFile(new Blob([pic.bytes as BlobPart], { type: pic.format.mime }), pic.name, pic.name); },
  },
]);

// Close and options ------------------------------------------------------------------------------

def([
  {
    id: 'file.close', icon: 'close', popular: true, noRecord: true,
    run: async (app, arg) => {
      const tab = app.tabs.find((d) => d.id === arg) || app.tab;
      if (tab.dirty && app.prefs.confirmClose && tab.picture) {
        const c = await choiceDialog('Save Changes?', `Save changes to "${tab.displayName}" before closing?`, ['Save', "Don't Save"]);
        if (c < 0) return;
        if (c === 0 && !(await saveTab(app, tab))) return;
      }
      if (app.tabs.length === 1) { tab.folder = new Folder(); tab.loader.setFolder(tab.folder); tab.dirty = false; await tab.show(); }
      else app.closeTab(tab);
      app.ui.hideBackstage();
    },
  },
  { id: 'file.closeAll', icon: 'tab_close', noRecord: true, run: async (app) => { for (const d of [...app.tabs]) { app.activate(d); await app.exec('file.close', d.id); } } },
  {
    id: 'file.exit', icon: 'logout', noRecord: true, tip: 'Esc leaves full screen first; closing the app with Esc is an option (desktop)',
    run: async (app, how?: string) => {
      // `how` is 'esc' when the Esc key ran the command: Esc leaves full screen, and closes the app only with the option on.
      const esc = how === 'esc';
      if (document.fullscreenElement || document.body.classList.contains('ql-fullscreen')) { app.exec('view.fullScreen'); return; }
      if (esc && !app.prefs.escExits) return;
      if (!isDesktop() && !isCapacitor()) { if (!esc) toast('Close the browser tab to leave Anne\'s Lens.'); return; }
      for (const d of [...app.tabs]) if (d.dirty) { app.activate(d); await app.exec('file.close', d.id); if (app.tabs.includes(d) && d.dirty) return; }
      if (isDesktop()) { window.close(); return; }
      try { const { App: CapApp } = await import('@capacitor/app'); await CapApp.exitApp(); } catch { window.close(); }
    },
  },
  {
    id: 'file.options', icon: 'settings', popular: true, noRecord: true,
    run: async (app) => {
      const p = app.prefs;
      const { CLASSIC_LAYOUT_NAMES } = await import('../ui/classicMenus');
      const r = await openDialog({ title: 'Anne\'s Lens Options', wide: true, fields: [
        { key: 'h1', type: 'heading', label: 'Viewing' },
        { key: 'zoomMode', label: 'When a picture opens', type: 'select', options: [{ value: 'fit-large', label: 'Fit only large pictures to the window' }, { value: 'fit', label: 'Fit every picture to the window' }, { value: 'fit-width', label: 'Fit width' }, { value: 'fit-height', label: 'Fit height' }, { value: 'fill', label: 'Fill the window' }, { value: 'actual', label: 'Original size (100%)' }], value: p.zoomMode, half: true },
        { key: 'wheel', label: 'Mouse wheel', type: 'select', options: [{ value: 'navigate', label: 'Next / previous picture (scrolls a large picture)' }, { value: 'zoom', label: 'Zoom' }, { value: 'scroll', label: 'Scroll only' }], value: p.wheel, half: true },
        { key: 'zoomLock', label: 'Lock zoom between pictures', type: 'checkbox', value: p.zoomLock, half: true },
        { key: 'keepPosition', label: 'Keep the panned position too', type: 'checkbox', value: p.keepPosition, half: true },
        { key: 'wrap', label: 'Wrap around at the ends of the folder', type: 'checkbox', value: p.wrap, half: true },
        { key: 'autoRotateExif', label: 'Auto-rotate by EXIF orientation', type: 'checkbox', value: p.autoRotateExif, half: true },
        { key: 'smoothZoom', label: 'Smooth pixels when zoomed in (off: see each pixel)', type: 'checkbox', value: p.smoothZoom, half: true },
        { key: 'pixelInfo', label: 'Pixel position and color in the status bar', type: 'checkbox', value: p.pixelInfo, half: true },
        { key: 'prefetch', label: 'Pictures decoded ahead (each direction)', type: 'number', min: 0, max: 8, value: p.prefetch, half: true },
        { key: 'alphaDisplay', label: 'Transparent pixels show', type: 'select', options: [{ value: 'checkerboard', label: 'Checkerboard' }, { value: 'white', label: 'White' }, { value: 'black', label: 'Black' }, { value: 'custom', label: 'A color…' }], value: p.alphaDisplay, half: true },
        { key: 'alphaColor', label: 'Transparency color', type: 'color', value: p.alphaColor, half: true, visibleIf: (v) => v.alphaDisplay === 'custom' },
        { key: 'background', label: 'Window background (empty: theme)', type: 'text', value: p.background, half: true, placeholder: '#202020' },
        { key: 'fullScreenBackground', label: 'Full-screen background', type: 'color', value: p.fullScreenBackground, half: true },
        { key: 'pdfDpi', label: 'PDF pages: resolution (dpi)', type: 'number', min: 36, max: 600, value: p.pdf.dpi, half: true },
        { key: 'pdfPages', label: 'PDF and DjVu pages: how many open', type: 'number', min: 1, max: 2000, value: p.pdf.maxPages, half: true },
        { key: 'h2', type: 'heading', label: 'Folder' },
        { key: 'sort', label: 'Sort pictures by', type: 'select', options: [{ value: 'natural', label: 'Name (natural: 2 before 10)' }, { value: 'name', label: 'Name (plain)' }, { value: 'date', label: 'File date' }, { value: 'size', label: 'Size' }, { value: 'type', label: 'Type' }], value: p.sort, half: true },
        { key: 'sortDescending', label: 'Descending', type: 'checkbox', value: p.sortDescending, half: true },
        { key: 'h3', type: 'heading', label: 'Interface' },
        { key: 'theme', label: 'Theme', type: 'select', options: [{ value: 'system', label: 'Follow the system' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'black', label: 'Black (OLED)' }], value: p.theme, half: true },
        { key: 'uiScale', label: 'Toolbar size', type: 'select', options: [{ value: '0.85', label: 'Compact' }, { value: '1', label: 'Normal' }, { value: '1.15', label: 'Large (touch)' }], value: String(p.uiScale), half: true },
        { key: 'menuStyle', label: 'Menus', type: 'select', options: [{ value: 'ribbon', label: 'Ribbon' }, { value: 'classic', label: 'Classic menu bar' }, { value: 'both', label: 'Both' }], value: p.menuStyle, half: true },
        { key: 'menuLayout', label: 'Classic menu layout', type: 'select', options: Object.entries(CLASSIC_LAYOUT_NAMES).map(([value, label]) => ({ value, label })), value: p.menuLayout, half: true },
        { key: 'qatPosition', label: 'Quick Access Bar', type: 'select', options: [{ value: 'top', label: 'Above the ribbon' }, { value: 'below', label: 'Below the ribbon (the classic toolbar place)' }, { value: 'bottom', label: 'At the bottom (near keyboard)' }], value: p.qatPosition, half: true },
        { key: 'qatLabels', label: 'Show labels on Quick Access Bar', type: 'checkbox', value: p.qatLabels, half: true },
        { key: 'statusBar', label: 'Status bar', type: 'checkbox', value: p.statusBar, half: true },
        { key: 'escExits', label: 'Esc closes the app (IrfanView habit; desktop)', type: 'checkbox', value: p.escExits, half: true },
        { key: 'confirmClose', label: 'Ask to save when leaving an edited picture', type: 'checkbox', value: p.confirmClose, half: true },
        { key: 'confirmDelete', label: 'Ask before deleting a file (Del)', type: 'checkbox', value: p.confirmDelete, half: true },
        { key: 'bqf', type: 'button', label: 'Quick Move / Quick Copy folders (Alt+1…9)…', onClick: () => app.exec('file.quickMove', 'setup') },
        { key: 'h4', type: 'heading', label: 'Saving' },
        { key: 'jpegQuality', label: 'JPEG / WebP quality', type: 'range', min: 1, max: 100, value: p.jpegQuality, half: true },
        { key: 'defaultSaveFormat', label: 'Default Save As format', type: 'select', options: SAVE_OPTIONS, value: p.defaultSaveFormat, half: true },
        { key: 'keepMetadata', label: 'Keep EXIF, XMP and color profile when saving JPEG, PNG, WebP', type: 'checkbox', value: p.keepMetadata, half: true },
        { key: 'keepOriginal', label: 'Keep the original when saving over a file ("name (original).ext" beside it, once)', type: 'checkbox', value: p.keepOriginal, half: true },
        { key: 'h5', type: 'heading', label: 'Customize' },
        { key: 'bq', type: 'button', label: 'Customize Quick Access Bar…', onClick: () => app.exec('file.customizeQat') },
        { key: 'br', type: 'button', label: 'Customize Tabs (Ribbon)…', onClick: () => app.exec('file.customizeRibbon') },
        { key: 'bk', type: 'button', label: 'Customize Keyboard…', onClick: () => app.exec('file.customizeKeyboard') },
        { key: 'bx', type: 'button', label: 'Export / Import Settings…', onClick: () => app.exec('file.exportSettings') },
        ...(isDesktop() ? [{ key: 'bp', type: 'button' as const, label: 'Portable Mode…', onClick: () => app.exec('file.portableMode') }] : []),
      ] });
      if (!r) return;
      Object.assign(p, {
        zoomMode: r.zoomMode, wheel: r.wheel, zoomLock: r.zoomLock, keepPosition: r.keepPosition, wrap: r.wrap, autoRotateExif: r.autoRotateExif, smoothZoom: r.smoothZoom, pixelInfo: r.pixelInfo, prefetch: Math.max(0, Math.min(8, +r.prefetch || 0)),
        alphaDisplay: r.alphaDisplay, alphaColor: r.alphaColor, background: String(r.background || '').trim(), fullScreenBackground: r.fullScreenBackground,
        sort: r.sort, sortDescending: r.sortDescending,
        theme: r.theme, uiScale: parseFloat(r.uiScale), menuStyle: r.menuStyle, menuLayout: r.menuLayout, qatPosition: r.qatPosition, qatLabels: r.qatLabels, statusBar: r.statusBar, escExits: r.escExits, confirmClose: r.confirmClose, confirmDelete: r.confirmDelete,
        pdf: { dpi: Math.max(36, Math.min(600, Math.round(+r.pdfDpi) || 150)), maxPages: Math.max(1, Math.min(2000, Math.round(+r.pdfPages) || 100)) },
        jpegQuality: +r.jpegQuality || 90, defaultSaveFormat: r.defaultSaveFormat, keepMetadata: !!r.keepMetadata, keepOriginal: !!r.keepOriginal,
      } satisfies Partial<Prefs>);
      app.savePrefs();
      app.ui.applyPrefs();
      for (const d of app.tabs) { d.ui.layout(); d.ui.draw(); }
      app.folder.sort(p.sort, p.sortDescending);
      app.refresh();
    },
  },
  { id: 'file.customizeQat', icon: 'tune', popular: true, noRecord: true, run: (app) => app.ui.customizeQat() },
  { id: 'file.customizeRibbon', icon: 'view_quilt', noRecord: true, run: (app) => app.ui.customizeRibbon() },
  { id: 'file.customizeKeyboard', icon: 'keyboard', noRecord: true, run: (app) => app.ui.customizeKeyboard() },
  { id: 'file.customizeMenus', icon: 'menu_open', noRecord: true, tip: 'Edit any classic menu layout (a built-in one is copied) or build your own: menus, submenus, commands, separators', run: async (app) => { const { customizeMenus } = await import('../ui/customize'); await customizeMenus(app); } },
  {
    id: 'file.exportSettings', icon: 'import_export', noRecord: true,
    tip: 'One JSON text for every setting, shared with the sister apps; or an IrfanView-style key list',
    run: async (app) => {
      const r = await openDialog({ title: 'Settings Transfer', wide: true, help: 'Copy this text to back up your Quick Access Bar, custom tabs, shortcuts, macros and preferences. Paste settings text here and choose Import to restore. The format is shared with the other Anne\'s Office apps; settings that do not apply to Anne\'s Lens are ignored. An IrfanView-style key list (lines such as "Rotate left=L" or "view.next=Space") can be pasted instead.', fields: [{ key: 'json', label: 'Settings (JSON) or key list', type: 'textarea', rows: 12, value: JSON.stringify({ ...prefsWithoutKeys(app.prefs), recent: [], recentFolders: [] }, null, 1) }], ok: 'Import', buttons: [{ label: 'Copy', onClick: (x) => { navigator.clipboard?.writeText(x.json); toast('Copied'); } }] });
      if (!r) return;
      const text = String(r.json || '').trim();
      let p: unknown = null;
      try { p = JSON.parse(text); } catch { /* maybe a key list */ }
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        const ids = new Set(allCommands().map((c) => c.id));
        const { keymap, unknown } = parseKeyList(text, ids);
        const n = Object.keys(keymap).length;
        if (!n) { toast(unknown.length ? `No usable lines; first unknown: ${unknown[0]}` : 'That is neither settings JSON nor a key list.'); return; }
        app.prefs.keymap = { ...app.prefs.keymap, ...keymap };
        app.savePrefs(); app.ui.rebuild();
        toast(`${n} shortcut(s) imported${unknown.length ? `; ${unknown.length} line(s) not understood` : ''}`);
        return;
      }
      const before = JSON.parse(JSON.stringify(app.prefs));
      Object.assign(app.prefs, sanitizePrefs(p), { recent: app.prefs.recent, recentFolders: app.prefs.recentFolders });
      try { app.ui.applyPrefs(); app.ui.rebuild(); } catch (e: any) {
        Object.assign(app.prefs, before); app.ui.applyPrefs(); app.ui.rebuild();
        toast(`These settings could not be applied: ${e?.message || e}`);
        return;
      }
      app.savePrefs();
      toast('Settings imported');
    },
  },
  {
    id: 'file.portableMode', icon: 'usb', kind: 'toggle', noRecord: true,
    tip: 'Keep settings in a folder beside the program instead of the user profile (desktop)',
    isActive: () => !!(window as any).__qlPortable,
    run: async (app) => {
      const d = desktopBridge();
      if (!d) { toast('Portable mode applies to the Windows, macOS and Linux apps: settings then live in a QuillLens-portable folder beside the program.'); return; }
      const st = await d.getPortableMode();
      (window as any).__qlPortable = st.on;
      if (!st.available) { toast(`The folder beside the program is not writable (${st.dir}); portable mode is not available here.`); return; }
      const r = await openDialog({ title: 'Portable Mode', fields: [{ key: 'i', type: 'info', html: `<p>Portable mode keeps every setting (preferences, Quick Access Bar, keys, macros, recent lists) in <code>${esc(st.dir)}</code>, so Anne's Lens can run from a USB stick or a folder you carry along.</p><p>It is currently <b>${st.on ? 'on' : 'off'}</b>. Turning it ${st.on ? 'off' : 'on'} copies the current settings and restarts the app.</p>` }], ok: st.on ? 'Turn Off and Restart' : 'Turn On and Restart' });
      if (!r) return;
      const res = await d.setPortableMode({ on: !st.on });
      if (!res.ok) { toast(res.error || 'Could not change portable mode.'); return; }
      await d.relaunch();
      void app;
    },
  },
  { id: 'file.resetCustomizations', icon: 'restart_alt', noRecord: true, run: async (app) => { if (!(await confirmDialog('Reset', 'Reset the Quick Access Bar, custom tabs, menus and keyboard shortcuts to defaults?'))) return; app.prefs.qat = [...DEFAULT_QAT]; app.prefs.customTabs = []; app.prefs.hiddenTabs = []; app.prefs.tabOrder = []; app.prefs.keymap = {}; app.prefs.customMenus = []; installCustomMenus([]); app.prefs.menuLayout = 'irfanview'; app.prefs.menuStyle = 'both'; app.savePrefs(); app.ui.applyPrefs(); app.ui.rebuild(); } },
]);

export { FORMATS, getCommand, fmtSize };
