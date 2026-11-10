/**
 * Keep the Original When Saving Over a File (Options ▸ Saving, off by default): the first time a
 * file is overwritten, its bytes as they were on disk are written beside it as "name (original).ext".
 * Revert to Original restores from that copy (or from an existing "name.original.ext").
 */
import type { App, PictureTab } from '../app';
import { entryFromUri, type Entry } from './folder';
import { listFolderOf, writeIntoFolder } from '../platform/native';
import { toast } from '../ui/dialog';

const split = (name: string) => { const i = name.lastIndexOf('.'); return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, '']; };
export const originalName = (name: string): string => { const [b, e] = split(name); return `${b} (original)${e}`; };
/** The names a kept original of `name` may have. */
export const originalNames = (name: string): string[] => { const [b, e] = split(name); return [`${b} (original)${e}`, `${b}.original${e}`]; };
export const isOriginalName = (name: string): boolean => /( \(original\)|\.original)\.[^.]+$/i.test(name);

/** The folder address an entry lives in (the opened folder, or a desktop file's parent). */
export function dirOf(entry: Entry, folderUri: string | null): string | null {
  if (folderUri) return folderUri;
  const u = entry.uri;
  return u && u.startsWith('file:') ? u.replace(/\/[^/]*$/, '') || null : null;
}

/** Finds a kept original beside `entry`: in the open folder's list, else by listing its folder. */
export async function findOriginal(app: App, tab: PictureTab, entry: Entry): Promise<Entry | null> {
  const names = originalNames(entry.name).map((n) => n.toLowerCase());
  const inFolder = tab.folder.entries.find((e) => e !== entry && names.includes(e.name.toLowerCase()));
  if (inFolder) return inFolder;
  const dir = dirOf(entry, tab.folder.uri);
  if (!dir) return null;
  const listing = await listFolderOf(dir).catch(() => null);
  const hit = listing?.entries.find((e) => names.includes(e.name.toLowerCase()));
  return hit ? entryFromUri(hit) : null;
}

let warned = false;
/** Before a write-back: keeps the on-disk bytes as "name (original).ext" when none exists yet. */
export async function keepOriginalCopy(app: App, tab: PictureTab): Promise<void> {
  const pic = tab.picture; if (!pic || !app.prefs.keepOriginal || isOriginalName(pic.name)) return;
  const dir = dirOf(pic.entry, tab.folder.uri);
  if (!dir) { if (!warned) { warned = true; toast('The original could not be kept: the folder is not known (open the folder, not just the file).', { ms: 6000 }); } return; }
  if (await findOriginal(app, tab, pic.entry)) return;
  const name = originalName(pic.name);
  const data = pic.bytes.buffer.slice(pic.bytes.byteOffset, pic.bytes.byteOffset + pic.bytes.byteLength) as ArrayBuffer;
  try {
    const r = await writeIntoFolder(dir, name, data);
    // Beside the picture's own entry; the folder's index (which may already point at the next picture) stays on the entry it was on.
    const f = tab.folder, cur = f.current, own = f.entries.indexOf(pic.entry), at = own >= 0 ? own : f.index;
    f.entries.splice(at + 1, 0, entryFromUri({ uri: r.uri, name: r.name, size: data.byteLength, mtime: Date.now() }));
    if (cur) f.index = f.entries.indexOf(cur);
    toast(`The original was kept as ${r.name}.`, { ms: 4000 });
  } catch (e) { toast(`The original could not be kept: ${(e as Error).message}`, { ms: 7000 }); }
}
