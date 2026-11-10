/**
 * The catalog (Browse ▸ Use Catalog): a local database, in the app's IndexedDB store, of the
 * folders you add (with or without their subfolders) and the facts about each picture the Filter
 * Bar, Group By, Timeline and smart albums use, plus small thumbnails. The catalog view lists every
 * cataloged picture at once and filters without reading the files. Plain folders keep working
 * without it. Folders are kept by address (desktop, Android) or by directory handle (browsers);
 * pictures by their path inside the folder.
 */
import type { App } from '../app';
import type { Entry } from './folder';
import { entryFromUri, isPictureName } from './folder';
import { entryInfo, setInfo, forgetInfo, type EntryInfo } from './folderInfo';
import { decodeSmall } from './similar';
import { kvGet, kvSet, kvDel, kvKeys } from '../util/store';
import { listSubfolders, listFolderFiles, dirUriFor, handleFor, handleId, type FolderEntry } from '../platform/native';

export interface CatFolder { id: string; name: string; uri?: string; handle?: any; subfolders: boolean; lastScan?: number; count?: number }
export interface CatItem { key: string; folderId: string; path: string[]; name: string; uri: string | null; dirUri?: string; size: number; mtime: number; info: Record<string, unknown> }
export interface ScanReport { added: number; updated: number; removed: number; unchanged: number; thumbs: number; orphans: string[]; failed: number; /** Items kept because their subfolder could not be listed this time. */ unlisted?: number }

const FOLDERS = 'catalog.v1.folders', ITEMS = (id: string) => `catalog.v1.items.${id}`, THUMB = (key: string) => `catalog.v1.thumb.${key}`;
export const listCatFolders = async (): Promise<CatFolder[]> => (await kvGet<CatFolder[]>(FOLDERS)) || [];
export const saveCatFolders = (f: CatFolder[]): Promise<void> => kvSet(FOLDERS, f);
export const catItems = async (folderId: string): Promise<CatItem[]> => (await kvGet<CatItem[]>(ITEMS(folderId))) || [];
export const catThumb = (key: string): Promise<string | undefined> => kvGet<string>(THUMB(key));

export const infoToStore = (i: EntryInfo): Record<string, unknown> => ({ ...i, date: i.date ? i.date.toISOString() : null });
export const infoFromStore = (r: Record<string, unknown>): EntryInfo => ({ ...(r as unknown as EntryInfo), date: r.date ? new Date(String(r.date)) : null });

/** The folder's address for this session (registering a browser handle). */
export async function folderUri(f: CatFolder): Promise<string | null> {
  if (f.uri) return f.uri;
  if (!f.handle) return null;
  try {
    let ok = (await f.handle.queryPermission?.({ mode: 'read' })) ?? 'granted';
    if (ok === 'prompt') ok = await f.handle.requestPermission?.({ mode: 'read' });
    return ok === 'granted' || ok === undefined ? await dirUriFor(f.handle) : null;
  } catch { return null; }
}
/** A catalog folder for an open folder's address; null for a folder without one. */
export function catFolderFor(uri: string | null, name: string, subfolders: boolean): CatFolder | null {
  if (!uri) return null;
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  if (uri.startsWith('fsadir:')) { const handle = handleFor(uri); return handle ? { id, name, handle, subfolders } : null; }
  return { id, name, uri, subfolders };
}

interface Found { entry: Entry; path: string[]; size: number; mtime: number; uri: string | null; dirUri: string }
/** Every picture under a folder (with subfolders when asked), and the .xmp files with no picture beside them. */
async function walk(uri: string, subfolders: boolean, onFolder?: (n: number) => void): Promise<{ found: Found[]; orphans: string[]; unlisted: string[][] }> {
  const found: Found[] = [], orphans: string[] = [], unlisted: string[][] = []; // unlisted: subfolders that could not be listed (their items are kept, not dropped)
  let folders = 0;
  const visit = async (u: string, path: string[], depth: number) => {
    onFolder?.(++folders);
    const r = await listFolderFiles(u, { all: true }).catch(() => null);
    if (!r) { if (depth === 0) throw new Error('The folder could not be listed (a drive that is not connected, or permission refused); the catalog was left as it is.'); unlisted.push(path); return; }
    const files: { name: string; size: number; mtime: number; entry: () => Promise<Entry>; uri: string | null }[] = [];
    if (r?.entries) for (const e of r.entries as FolderEntry[]) files.push({ name: e.name, size: e.size || 0, mtime: e.mtime || 0, uri: e.uri, entry: async () => entryFromUri(e) });
    if (r?.handles) for (const x of r.handles) {
      let size = 0, mtime = 0; try { const f: File = await x.handle.getFile(); size = f.size; mtime = f.lastModified; } catch { /* unreadable */ }
      files.push({ name: x.name, size, mtime, uri: null, entry: async () => { const uriF = 'fsa:' + (await handleId(x.handle)); return { name: x.name, uri: uriF, size, mtime, read: async () => (await x.handle.getFile()).arrayBuffer() } as Entry; } });
    }
    const pics = files.filter((f) => isPictureName(f.name)), lower = new Set(pics.map((f) => f.name.toLowerCase())), bases = new Set(pics.map((f) => f.name.toLowerCase().replace(/\.[^.]+$/, '')));
    for (const f of files) if (/\.xmp$/i.test(f.name)) { const n = f.name.toLowerCase().replace(/\.xmp$/, ''); if (!lower.has(n) && !bases.has(n)) orphans.push([...path, f.name].join('/')); }
    for (const f of pics) { const entry = await f.entry(); entry.dirUri = u; found.push({ entry, path, size: f.size, mtime: f.mtime, uri: f.uri, dirUri: u }); }
    if (!subfolders || depth >= 16) return;
    for (const s of (await listSubfolders(u).catch(() => null)) || []) await visit(s.uri, [...path, s.name], depth + 1);
  };
  await visit(uri, [], 0);
  return { found, orphans, unlisted };
}

async function makeThumb(app: App, e: Entry): Promise<string | null> {
  const c = await decodeSmall(app, e, 160).catch(() => null);
  return c ? c.toDataURL('image/jpeg', 0.75) : null;
}

/**
 * Scans a catalog folder: new and changed pictures are read (facts and, with `thumbs`, a thumbnail),
 * unchanged ones kept, missing ones dropped. `reread` reads every picture's facts again.
 */
export async function scanFolder(app: App, f: CatFolder, o: { thumbs?: boolean; reread?: boolean; progress?: (text: string) => void } = {}): Promise<ScanReport> {
  const rep: ScanReport = { added: 0, updated: 0, removed: 0, unchanged: 0, thumbs: 0, orphans: [], failed: 0 };
  const uri = await folderUri(f);
  if (!uri) throw new Error(`${f.name} cannot be reached (moved, or permission refused).`);
  const old = new Map((await catItems(f.id)).map((x) => [x.key, x]));
  const { found, orphans, unlisted } = await walk(uri, f.subfolders, (n) => o.progress?.(`${f.name}: folder ${n}…`));
  rep.orphans = orphans;
  const items: CatItem[] = [];
  for (const [i, x] of found.entries()) {
    if (i % 20 === 0) o.progress?.(`${f.name}: ${i} of ${found.length}…`);
    const key = `${f.id}/${[...x.path, x.entry.name].join('/')}`, prev = old.get(key);
    old.delete(key);
    if (prev && !o.reread && prev.size === x.size && prev.mtime === x.mtime) {
      items.push(prev); rep.unchanged++;
      if (o.thumbs && !(await catThumb(key))) { const t = await makeThumb(app, x.entry); if (t) { await kvSet(THUMB(key), t); rep.thumbs++; } }
      continue;
    }
    try {
      forgetInfo(x.entry);
      const info = await entryInfo(app, x.entry);
      items.push({ key, folderId: f.id, path: x.path, name: x.entry.name, uri: x.uri, dirUri: x.uri ? x.dirUri : undefined, size: x.size, mtime: x.mtime, info: infoToStore(info) });
      if (prev) rep.updated++; else rep.added++;
      if (o.thumbs !== false) { const t = await makeThumb(app, x.entry); if (t) { await kvSet(THUMB(key), t); rep.thumbs++; } }
    } catch { rep.failed++; if (prev) items.push(prev); }
  }
  // Items under a subfolder that could not be listed this time stay in the catalog; only pictures seen to be gone are dropped.
  const under = (p: string[]) => unlisted.some((u) => u.every((part, i) => p[i] === part));
  for (const [key, prev] of old) { if (under(prev.path || [])) { items.push(prev); rep.unlisted = (rep.unlisted || 0) + 1; continue; } await kvDel(THUMB(key)); rep.removed++; }
  await kvSet(ITEMS(f.id), items);
  const all = await listCatFolders(), me = all.find((x) => x.id === f.id);
  if (me) { me.lastScan = Date.now(); me.count = items.length; await saveCatFolders(all); }
  return rep;
}

/** Forgets a folder's catalog data (the files are not touched). */
export async function removeCatFolder(id: string): Promise<void> {
  for (const it of await catItems(id)) await kvDel(THUMB(it.key));
  await kvDel(ITEMS(id));
  await saveCatFolders((await listCatFolders()).filter((f) => f.id !== id));
}
/** Every cataloged picture as an entry (facts primed, so filters need no file reads), with how many folders could not be reached. */
export async function catalogEntries(): Promise<{ entries: Entry[]; unreachable: string[] }> {
  const entries: Entry[] = [], unreachable: string[] = [];
  for (const f of await listCatFolders()) {
    const items = await catItems(f.id);
    let dirHandle: any = null;
    if (!f.uri) { const u = await folderUri(f); if (!u) { unreachable.push(f.name); continue; } dirHandle = f.handle; }
    for (const it of items) {
      let e: Entry;
      if (it.uri) { e = entryFromUri({ uri: it.uri, name: it.name, size: it.size, mtime: it.mtime }); if (it.dirUri) e.dirUri = it.dirUri; }
      else {
        const path = it.path, name = it.name;
        e = { name, uri: null, size: it.size, mtime: it.mtime, read: async () => { let d = dirHandle; for (const p of path) d = await d.getDirectoryHandle(p); const fh = await d.getFileHandle(name); e.uri = 'fsa:' + (await handleId(fh)); return (await fh.getFile()).arrayBuffer(); } } as Entry;
      }
      (e as any).catalogKey = it.key;
      setInfo(e, infoFromStore(it.info));
      entries.push(e);
    }
  }
  return { entries, unreachable };
}
/** How much the catalog holds. */
export async function catalogStats(): Promise<{ folders: number; pictures: number; thumbs: number }> {
  const fs = await listCatFolders();
  return { folders: fs.length, pictures: fs.reduce((n, f) => n + (f.count || 0), 0), thumbs: (await kvKeys('catalog.v1.thumb.')).length };
}
