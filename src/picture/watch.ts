/**
 * Watch Folder: while Anne's Lens is open, each watched folder is listed again every few seconds;
 * pictures that were not there before are added to the catalog, shown, copied into a folder, or run
 * through a saved batch recipe into a folder. What a folder held is remembered between sessions,
 * so pictures that arrived while the app was closed count as new the next time.
 */
import type { App } from '../app';
import type { Entry } from './folder';
import { kvGet, kvSet } from '../util/store';
import { listFolderFiles, dirUriFor, handleFor, writeIntoFolder } from '../platform/native';
import { listingEntries } from '../commands/file';
import { isPictureName } from './folder';

export type WatchAction = 'catalog' | 'open' | 'copy' | 'recipe';
export interface DirRef { name: string; uri?: string; handle?: any }
export interface Watch { id: string; folder: DirRef; action: WatchAction; dest?: DirRef; recipe?: string; known: string[]; created: number; lastNew?: number; total?: number; /** New pictures seen once, by name and size: acted on when the next check finds the same size (D11). */ pending?: string[] }

const KEY = 'watch.v1';
export const listWatches = async (): Promise<Watch[]> => (await kvGet<Watch[]>(KEY)) || [];
export const saveWatches = (w: Watch[]): Promise<void> => kvSet(KEY, w);
export const dirRefFor = (uri: string, name: string): DirRef | null => (uri.startsWith('fsadir:') ? (handleFor(uri) ? { name, handle: handleFor(uri) } : null) : { name, uri });
export async function dirUri(d: DirRef, mode: 'read' | 'readwrite' = 'read'): Promise<string | null> {
  if (d.uri) return d.uri;
  if (!d.handle) return null;
  try { let ok = (await d.handle.queryPermission?.({ mode })) ?? 'granted'; if (ok === 'prompt') ok = await d.handle.requestPermission?.({ mode }); return ok === 'granted' || ok === undefined ? await dirUriFor(d.handle) : null; } catch { return null; }
}
const fileKey = (e: Entry) => `${e.name}|${e.size ?? ''}`;

/** The pictures in a watched folder that it did not hold before (pure: `known` keys against a listing). */
export const newOnes = (entries: Entry[], known: string[]): Entry[] => { const k = new Set(known); return entries.filter((e) => isPictureName(e.name) && !k.has(fileKey(e))); };

/**
 * New pictures split by whether they have settled: one is ready when the last check already saw it at the same size
 * (a camera or a copy still writing it would have grown in between); the rest wait for the next check.
 */
export function settled(fresh: Entry[], pending: string[]): { ready: Entry[]; waiting: Entry[] } {
  const p = new Set(pending), ready: Entry[] = [], waiting: Entry[] = [];
  for (const e of fresh) (p.has(fileKey(e)) ? ready : waiting).push(e);
  return { ready, waiting };
}

/** The folder's pictures, or null when it could not be listed (a drive that is away): that is not an empty folder. */
async function listPictures(uri: string): Promise<Entry[] | null> {
  const r = await listFolderFiles(uri).catch(() => null);
  if (!r) return null;
  const es = listingEntries(r).filter((e) => isPictureName(e.name));
  // Browser handles carry no size in the listing: ask the handle (no file is read), so a rewritten file counts as new.
  for (const e of es) { if (e.size === undefined) { try { if (e.stat) e.size = (await e.stat()).size; else if (e.uri === null) e.size = (await e.read()).byteLength; } catch { /* */ } } }
  return es;
}

/** Remembers what a folder holds now (a new watch starts from here). */
export async function primeWatch(w: Watch): Promise<void> { const u = await dirUri(w.folder); const now = u ? await listPictures(u) : null; if (now) w.known = now.map(fileKey); }

/** One pass over every watch; returns how many new pictures were handled. */
let ticking = false;
export async function watchTick(app: App, act: (w: Watch, fresh: Entry[], uri: string) => Promise<void>): Promise<number> {
  if (ticking) return 0; // the last pass is still at work (a long recipe): no second pass over the same files
  ticking = true;
  try {
    const all = await listWatches(); let n = 0;
    for (const w of all) {
      const u = await dirUri(w.folder); if (!u) continue;
      const now = await listPictures(u);
      if (!now) continue; // the folder is not reachable right now: what it held is kept, so nothing counts as new when it returns
      const { ready, waiting } = settled(newOnes(now, w.known), w.pending || []);
      w.pending = waiting.map(fileKey);
      if (ready.length) {
        try { await act(w, ready, u); w.lastNew = Date.now(); w.total = (w.total || 0) + ready.length; n += ready.length; } catch (e) { console.warn('watch', e); }
      }
      // A file still being written (its size changed since the last check) stays new until it settles.
      const wait = new Set(w.pending);
      w.known = now.filter((e) => !wait.has(fileKey(e))).map(fileKey);
    }
    await saveWatches(all);
    return n;
  } finally { ticking = false; }
}

let timer: ReturnType<typeof setInterval> | null = null;
/** Starts (or stops, with 0 watches) the periodic check. */
export function runWatches(app: App, act: Parameters<typeof watchTick>[1], everyMs = 15000): void {
  if (timer) { clearInterval(timer); timer = null; }
  void listWatches().then((w) => { if (w.length) timer = setInterval(() => { void watchTick(app, act); }, everyMs); });
}
/** Copies a picture's bytes into a folder. */
export async function copyInto(destUri: string, e: Entry): Promise<void> { await writeIntoFolder(destUri, e.name, await e.read(), 'rename'); } // never over a file already there
