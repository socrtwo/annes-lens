/**
 * Albums (named lists of pictures from any folders) and smart albums (saved filters that apply to
 * whatever is open). Albums keep each picture's address: a file or content URI on the desktop and
 * Android, a File System Access handle in browsers (kept in IndexedDB, so the browser may ask for
 * permission again after a restart). Pictures without an address (dropped or pasted) cannot be kept.
 */
import { dayString } from '../util/days';
import type { Entry } from './folder';
import { entryFromUri, entryFromHandle } from './folder';
import type { FilterSpec } from './folderInfo';
import { kvGet, kvSet } from '../util/store';
import { handleFor } from '../platform/native';

export interface AlbumRef { uri: string | null; name: string; size?: number; mtime?: number; handle?: any; added: number }
export interface Album { id: string; name: string; created: number; items: AlbumRef[] }
export interface SmartAlbum { id: string; name: string; spec: Record<string, unknown> }

const KEY = 'albums.v1', SMART = 'smartAlbums.v1';
export const listAlbums = async (): Promise<Album[]> => (await kvGet<Album[]>(KEY)) || [];
export const saveAlbums = (a: Album[]): Promise<void> => kvSet(KEY, a);
export const listSmart = async (): Promise<SmartAlbum[]> => (await kvGet<SmartAlbum[]>(SMART)) || [];
export const saveSmart = (a: SmartAlbum[]): Promise<void> => kvSet(SMART, a);
export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** What an album keeps for an entry, or null when the picture has no address to come back to. */
export function refOf(e: Entry): AlbumRef | null {
  const uri = e.uri;
  if (uri && uri.startsWith('fsa:')) { const handle = handleFor(uri); return handle ? { uri: null, name: e.name, size: e.size, mtime: e.mtime, handle, added: Date.now() } : null; }
  if (uri) return { uri, name: e.name, size: e.size, mtime: e.mtime, added: Date.now() };
  return null;
}
/** The same picture? URIs match exactly; browser handles by isSameEntry, or by name and size. */
async function same(a: AlbumRef, b: AlbumRef): Promise<boolean> {
  if (a.uri || b.uri) return !!a.uri && a.uri === b.uri;
  try { if (a.handle?.isSameEntry && b.handle && (await a.handle.isSameEntry(b.handle))) return true; } catch { /* stale handle */ }
  return a.name === b.name && a.size !== undefined && a.size === b.size;
}
/** Adds refs not already in the album; returns how many were new. */
export async function addRefs(album: Album, refs: AlbumRef[]): Promise<number> {
  let n = 0;
  for (const r of refs) { let dup = false; for (const x of album.items) if (await same(x, r)) { dup = true; break; } if (!dup) { album.items.push(r); n++; } }
  return n;
}
/** Entries to open an album as a folder (handles ask for read permission when the browser wants it). */
export async function entriesOf(album: Album): Promise<{ entries: Entry[]; unavailable: number }> {
  const entries: Entry[] = []; let unavailable = 0;
  for (const r of album.items) {
    if (r.uri) { entries.push(entryFromUri({ uri: r.uri, name: r.name, size: r.size, mtime: r.mtime })); continue; }
    const hnd = r.handle;
    if (!hnd) { unavailable++; continue; }
    try {
      let ok = (await hnd.queryPermission?.({ mode: 'read' })) ?? 'granted';
      if (ok === 'prompt') ok = await hnd.requestPermission?.({ mode: 'read' });
      if (ok === 'granted' || ok === undefined) { const e = entryFromHandle(r.name, hnd); e.size = r.size; e.mtime = r.mtime; entries.push(e); } else unavailable++;
    } catch { unavailable++; }
  }
  return { entries, unavailable };
}

/** Filter specs travel through storage with dates as text. */
export const specToStore = (s: FilterSpec): Record<string, unknown> => JSON.parse(JSON.stringify(s));
export const specFromStore = (s: Record<string, unknown>): FilterSpec => ({ ...(s as FilterSpec), from: s.from ? new Date(String(s.from)) : null, to: s.to ? new Date(String(s.to)) : null });
/** A short description of a filter for lists ("★3+ · keyword family · 2019–2021"). */
export function describeSpec(s: FilterSpec): string {
  const p: string[] = [];
  if (s.minRating) p.push(`★${s.minRating}+`); if (s.label) p.push(`${s.label} label`); if (s.keyword) p.push(`keyword "${s.keyword}"`); if (s.text) p.push(`"${s.text}"`);
  if (s.types?.length) p.push(s.types.join('/')); if (s.camera) p.push(s.camera); if (s.flag) p.push(s.flag); if (s.favorite) p.push('favorites');
  if (s.hasGps === true) p.push('with location'); if (s.hasGps === false) p.push('without location'); if (s.orientation) p.push(s.orientation);
  const y = (d?: Date | null) => (d ? dayString(d) : '');
  if (s.from || s.to) p.push(`${y(s.from) || '…'} to ${y(s.to) || '…'}`);
  return p.join(' · ') || 'everything';
}
