/**
 * Platform bridge. One API, three back ends:
 * - Android: the `QuillNative` Capacitor plugin (android/app/src/main/java/.../QuillNativePlugin.java)
 *   provides the Storage Access Framework (real Open / Save As dialogs, write-back to the same file),
 *   the system print service, sharing, and pictures opened or shared from other apps.
 * - Desktop (Windows, macOS, Linux, Raspberry Pi OS): the Electron preload (electron/preload.cjs)
 *   exposes the same interface as `window.quillDesktop`, backed by native file dialogs and the file
 *   system, plus folder listing (next/previous through a folder), Show in Folder, Open With and
 *   portable mode.
 * - Browser and iOS: <input type=file>, the File System Access API or downloads, and window.print().
 *   On iOS, saved files go to the app's Documents folder (Files ▸ On My iPhone ▸ Anne's Lens).
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { download, pickFile } from '../ui/dom';

export interface OpenedFile { name: string; data: ArrayBuffer; uri: string | null; mime?: string; size?: number; mtime?: number }
export interface FolderEntry { uri: string; name: string; size?: number; mtime?: number }

interface NativeFile { uri?: string; name?: string; mime?: string; data?: string; files?: NativeFile[] }

interface QuillNativePlugin {
  /** ACTION_OPEN_DOCUMENT. Resolves {canceled:true} when dismissed; {files} when several were picked. */
  openDocument(opts: { mimeTypes: string[]; multiple?: boolean }): Promise<{ canceled?: boolean } & NativeFile>;
  /** ACTION_CREATE_DOCUMENT then write. */
  saveAs(opts: { name: string; mime: string; data: string /* base64 */ }): Promise<{ canceled?: boolean; uri?: string; name?: string }>;
  /** Overwrite an existing document URI obtained from openDocument/saveAs (persisted permission). */
  writeUri(opts: { uri: string; data: string /* base64 */ }): Promise<{ ok: boolean }>;
  /** Read a URI again (recent files, folder entries). */
  readUri(opts: { uri: string }): Promise<{ name?: string; mime?: string; data: string; size?: number; mtime?: number }>;
  /** Print the current WebView through PrintManager. */
  print(opts: { jobName: string }): Promise<void>;
  /** Share a file through ACTION_SEND. */
  share(opts: { name: string; mime: string; data: string; title?: string; subject?: string; text?: string; to?: string }): Promise<void>;
  /** File(s) the app was launched with (ACTION_VIEW / ACTION_SEND / ACTION_SEND_MULTIPLE), consumed once. */
  getLaunchFile(): Promise<NativeFile>;
  keepAwake(opts: { on: boolean }): Promise<void>;
  addListener(event: 'fileOpened', cb: (f: NativeFile) => void): Promise<{ remove: () => void }>;
  readClipboard(): Promise<{ text?: string | null }>;
  /** Secure storage for small secrets (AI service keys): the OS credential store or the Android Keystore. */
  secretInfo(): Promise<{ available: boolean; backend?: string }>;
  secretGet(o: { name: string }): Promise<{ value: string | null }>;
  secretSet(o: { name: string; value: string }): Promise<Record<string, never>>;
  secretDelete(o: { name: string }): Promise<Record<string, never>>;
  writeClipboard(opts: { text: string; sensitive?: boolean }): Promise<void>;
  openInApp?(opts: { packageName: string; name: string; mime: string; data: string }): Promise<{ opened: boolean; reason?: string }>;
  /** Platform-bound file commands (Android). */
  setWallpaper?(opts: { data: string; which: 'home' | 'lock' | 'both' }): Promise<{ ok: boolean }>;
  attachData?(opts: { name: string; mime: string; data: string }): Promise<{ ok: boolean }>;
  openCastSettings?(): Promise<{ ok: boolean; action?: string }>;
  copyFileToClipboard?(opts: { name?: string; mime?: string; data?: string; uri?: string }): Promise<{ ok: boolean; uri?: string; how?: string }>;
  capturePhoto?(): Promise<{ canceled?: boolean; name?: string; mime?: string; data?: string }>;
  createSubfolder?(opts: { dirUri: string; name: string }): Promise<{ uri: string; name: string }>;
  openDefaultApps?(): Promise<{ ok: boolean }>;
  /** HTTP request for AI services through the native layer (Android: HttpURLConnection). */
  request?(opts: { url: string; method: string; headers: Record<string, string>; body?: string; timeoutMs?: number }): Promise<{ status: number; headers: Record<string, string>; data: string }>;
  /** File operations (M2). Android: Storage Access Framework; desktop: the file system. */
  renameDocument?(opts: { uri: string; name: string }): Promise<{ uri: string; name: string }>;
  deleteDocument?(opts: { uri: string; permanent?: boolean }): Promise<{ ok: boolean; trashed?: boolean }>;
  /** ACTION_OPEN_DOCUMENT_TREE / a folder dialog: a folder files can be created in and listed. */
  pickFolder?(opts: { title?: string }): Promise<{ canceled?: boolean; uri?: string; name?: string }>;
  /** Creates (or replaces) a file in a picked folder. */
  createInFolder?(opts: { dirUri: string; name: string; mime: string; data: string; ifExists?: 'overwrite' | 'rename' }): Promise<{ uri: string; name: string }>;
  /** Lists the pictures in a picked folder. */
  listFolder?(opts: { uri: string; all?: boolean }): Promise<{ uri: string; name: string; entries: FolderEntry[] }>;
  /** The folders inside a picked tree (or a folder in it), as folder URIs. */
  listSubfolders?(opts: { uri: string }): Promise<{ folders: FolderRef[] }>;
}

/** The desktop bridge adds what a file system and a window manager make possible. */
interface DesktopBridge extends QuillNativePlugin {
  /** 'win32' | 'darwin' | 'linux' */
  platform: string;
  openExternal(opts: { url: string }): Promise<void>;
  /** Native folder dialog; resolves the folder's picture files. */
  openFolder(opts?: { all?: boolean }): Promise<{ canceled?: boolean; uri?: string; name?: string; entries?: FolderEntry[] }>;
  /** The picture files beside a file (or inside a folder URI), sorted by name. */
  listFolder(opts: { uri: string; all?: boolean }): Promise<{ uri: string; name: string; entries: FolderEntry[] }>;
  /** Show the file in the system file manager. */
  revealInFolder(opts: { uri: string }): Promise<void>;
  /** Open the file with the program registered for its type. */
  openWith(opts: { uri: string }): Promise<{ ok: boolean; error?: string }>;
  /** Settings beside the program instead of in the user profile. */
  getPortableMode(): Promise<{ on: boolean; dir: string; available: boolean }>;
  setPortableMode(opts: { on: boolean }): Promise<{ ok: boolean; error?: string }>;
  relaunch(): Promise<void>;
  setAlwaysOnTop(opts: { on: boolean }): Promise<void>;
  minimize(): Promise<void>;
  fitWindow(opts: { width: number; height: number }): Promise<void>;
  /** Arguments the app was started with (desktop command line), consumed once. */
  getArgs(): Promise<{ args: string[] }>;
  /** Moves or copies a file into a folder (both must have been opened or picked). */
  moveFile(opts: { uri: string; dirUri: string; name?: string }): Promise<{ uri: string; name: string }>;
  copyFile(opts: { uri: string; dirUri: string; name?: string }): Promise<{ uri: string; name: string }>;
  setFileTime(opts: { uri: string; mtime: number }): Promise<{ ok: boolean }>;
  /** Writes bytes to a new file in a folder the app may use (undo of a delete). */
  createInFolder(opts: { dirUri: string; name: string; mime: string; data: string; ifExists?: 'overwrite' | 'rename' }): Promise<{ uri: string; name: string }>;
  renameDocument(opts: { uri: string; name: string }): Promise<{ uri: string; name: string }>;
  deleteDocument(opts: { uri: string; permanent?: boolean }): Promise<{ ok: boolean; trashed?: boolean }>;
  pickFolder(opts: { title?: string }): Promise<{ canceled?: boolean; uri?: string; name?: string }>;
  /** Downloads a picture in the main process (no CORS). */
  fetchUrl(opts: { url: string }): Promise<{ name: string; mime: string; data: string }>;
  pickProgram(): Promise<{ canceled?: boolean; path?: string; name?: string }>;
  /** `args` may hold {file}, {folder} and {name}; without it the program gets the file's path. */
  openWithProgram(opts: { uri: string; program: string; args?: string[] }): Promise<{ ok: boolean; error?: string }>;
  /** Platform-bound file commands (desktop). */
  setWallpaper(opts: { data: string; which: 'home' | 'lock' | 'both' }): Promise<{ ok: boolean; how?: string }>;
  showProperties(opts: { uri: string }): Promise<{ path: string; size: number; mtime: number; ctime: number; mode: string; os: string; opened: boolean }>;
  copyFileToClipboard(opts: { name?: string; mime?: string; data?: string; uri?: string }): Promise<{ ok: boolean; uri?: string; how?: string }>;
  setAssociations(opts: { exts: string[] }): Promise<{ ok: boolean; how: string; done: string[]; failed: string[] }>;
  listScanners(): Promise<{ devices: { id: string; name: string }[]; note: string }>;
  scan(opts: { device?: string; dpi: number; mode: 'color' | 'gray' }): Promise<{ name: string; mime: string; data: string }>;
  createSubfolder(opts: { dirUri: string; name: string }): Promise<{ uri: string; name: string }>;
  /** HTTP request for AI services (no cross-origin limits). Body and answer travel as base64. */
  request(opts: { url: string; method: string; headers: Record<string, string>; body?: string; timeoutMs?: number }): Promise<{ status: number; headers: Record<string, string>; data: string }>;
  /** Phone Remote: the local-network server for slideshows, its state, and the phone's commands (addListener 'remoteCommand'). */
  remoteStart(opts: { port?: number }): Promise<{ urls: string[]; port: number }>;
  remoteStop(): Promise<{ ok: boolean }>;
  remoteState(state: Record<string, unknown>): Promise<{ ok: boolean }>;
  /** Network sharing (shared views and albums, electron/netshare.cjs): a room behind a token; its state; an album's listing; stop. Additions arrive as 'shareAdded' events. */
  shareStart(opts: { kind: 'view' | 'album' }): Promise<{ token: string; urls: string[]; port: number }>;
  shareState(opts: { token: string; state: Record<string, unknown> }): Promise<{ ok: boolean }>;
  shareAlbum(opts: { token: string; name: string; items: { id: string; name: string; size?: number; mtime?: number; uri: string | null; thumb: string | null }[]; contribute: boolean; contribDir: string }): Promise<{ ok: boolean; servable: number; contribute: boolean }>;
  shareStop(opts: { token: string }): Promise<{ ok: boolean }>;
  /** Keeps a chosen folder readable after a restart (catalog, favorites, watch folders, backups). */
  rememberFolder(opts: { uri: string }): Promise<{ ok: boolean }>;
  /** The folder above one the app may list. */
  parentFolder(opts: { uri: string }): Promise<FolderRef | null>;
  /** The displays, and moving the window onto one (full screen there when asked). */
  listDisplays(): Promise<DisplayInfo[]>;
  moveToDisplay(opts: { id: number; fullScreen?: boolean }): Promise<{ ok: boolean }>;
  /** Recreates the window with or without its frame, reopening `reopen` (a file URI) in it. */
  setFrameless(opts: { on: boolean; reopen?: string | null }): Promise<{ ok: boolean }>;
  windowControl(opts: { action: 'minimize' | 'maximize' | 'close' | 'state' | 'leaveFullScreen' }): Promise<{ maximized: boolean; frameless: boolean; fullScreen: boolean }>;
  /** The command line's request (--convert job, or --fullscreen / --slideshow), once. */
  cliJob(): Promise<CliJob | null>;
  cliWrite(opts: { name: string; data: string }): Promise<{ name: string; path: string }>;
  cliDone(opts: { done: { from: string; to: string; note?: string }[]; failed: { name: string; error: string }[] }): Promise<{ ok: boolean }>;
}
export interface FolderRef { uri: string; name: string }
export type CliJob =
  | { mode: 'view'; fullscreen: boolean; slideshow: boolean }
  | { mode: 'convert'; inputs: FolderEntry[]; format: string; quality: number; names: string; resize: { mode: 'long' | 'width' | 'height' | 'percent' | 'box'; value: number; value2?: number } | null; shrinkOnly: boolean; rotate: '90' | '180' | '270' | 'exif' | null; flip: 'h' | 'v' | null; gray: boolean; strip: boolean };
export interface DisplayInfo { id: number; label: string; bounds: { x: number; y: number; width: number; height: number }; primary: boolean; current: boolean }

const desktop: DesktopBridge | undefined = typeof window !== 'undefined' ? (window as any).quillDesktop : undefined;
export const Native: QuillNativePlugin = desktop || registerPlugin<QuillNativePlugin>('QuillNative');

/** Running in the Capacitor app shell (Android or iOS). */
export const isCapacitor = (): boolean => Capacitor.isNativePlatform();
/** A native bridge is present: real file dialogs, write-back (Android app or desktop app). */
export const isNative = (): boolean => !!desktop || (Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('QuillNative'));
export const isDesktop = (): boolean => !!desktop;
export const isIOS = (): boolean => Capacitor.getPlatform() === 'ios';
/** 'android' | 'ios' | 'web' | 'windows' | 'macos' | 'linux' */
export const platformName = (): string => (desktop ? ({ win32: 'windows', darwin: 'macos' } as Record<string, string>)[desktop.platform] || 'linux' : Capacitor.getPlatform());
export const desktopBridge = (): DesktopBridge | undefined => desktop;

// iOS: files live in the app's Documents folder, which the Files app shows.
const IOS_PREFIX = 'ios-doc:';
async function iosWrite(blob: Blob, name: string): Promise<string> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const safe = name.replace(/[\\/:*?"<>|]/g, '_') || 'picture';
  await Filesystem.writeFile({ path: safe, data: b64FromBuffer(await blob.arrayBuffer()), directory: Directory.Documents });
  return safe;
}
/** Save As on iOS has no picker: never replace another file, use "Name (2).ext" instead. */
async function iosFreeName(name: string): Promise<string> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const safe = name.replace(/[\\/:*?"<>|]/g, '_') || 'picture';
  const dot = safe.lastIndexOf('.');
  const base = dot > 0 ? safe.slice(0, dot) : safe, ext = dot > 0 ? safe.slice(dot) : '';
  for (let i = 1; i < 500; i++) {
    const candidate = i === 1 ? safe : `${base} (${i})${ext}`;
    try { await Filesystem.stat({ path: candidate, directory: Directory.Documents }); } catch { return candidate; }
  }
  return `${base} (${Date.now()})${ext}`;
}

export function b64FromBuffer(buf: ArrayBuffer): string {
  const u8 = new Uint8Array(buf);
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode(...u8.subarray(i, i + chunk));
  return btoa(s);
}

export function bufferFromB64(b64: string): ArrayBuffer {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8.buffer;
}

const fromNative = (r: NativeFile): OpenedFile => ({ name: r.name || 'picture', data: bufferFromB64(r.data || ''), uri: r.uri || null, mime: r.mime });

/** Opens one or several files with the platform's picker. */
export async function openDocuments(accept: string, mimeTypes: string[], multiple = true): Promise<OpenedFile[]> {
  if (isNative()) {
    const r = await Native.openDocument({ mimeTypes, multiple });
    if (r.canceled) return [];
    if (r.files?.length) return r.files.filter((f) => f.data).map(fromNative);
    return r.data ? [fromNative(r)] : [];
  }
  const files = await pickFile(accept, multiple);
  return Promise.all(files.map(async (f) => ({ name: f.name, data: await f.arrayBuffer(), uri: null, mime: f.type, size: f.size, mtime: f.lastModified })));
}

/**
 * Opens a folder: the desktop dialog (entries by URI), the File System Access directory picker (entries
 * by handle), or a directory <input> (entries as File objects). Null when canceled or unavailable.
 */
/** Show All Files: folder listings include files that are not pictures (set from the preference). */
export const listing = { allFiles: false };

export async function openFolderDialog(): Promise<{ name: string; uri: string | null; entries?: FolderEntry[]; files?: File[]; handles?: { name: string; handle: any }[]; dirHandle?: any } | null> {
  if (desktop) {
    const r = await desktop.openFolder({ all: listing.allFiles });
    if (r.canceled || !r.entries) return null;
    return { name: r.name || 'Folder', uri: r.uri || null, entries: r.entries };
  }
  if (isNative() && Native.pickFolder && Native.listFolder) {
    const r = await Native.pickFolder({ title: 'Open Folder' });
    if (r.canceled || !r.uri) return null;
    const listed = await Native.listFolder({ uri: r.uri, all: listing.allFiles });
    return { name: listed.name || r.name || 'Folder', uri: listed.uri, entries: listed.entries };
  }
  const anyWin = window as any;
  if (anyWin.showDirectoryPicker) {
    try {
      const dir = await anyWin.showDirectoryPicker({ mode: 'read' });
      const handles: { name: string; handle: any }[] = [];
      for await (const [name, h] of dir.entries()) if (h.kind === 'file') handles.push({ name, handle: h });
      return { name: dir.name, uri: 'fsadir:' + (await handleId(dir)), handles, dirHandle: dir };
    } catch (e: any) {
      if (e?.name === 'AbortError') return null;
    }
  }
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    (inp as any).webkitdirectory = true;
    inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.addEventListener('change', () => { const files = inp.files ? [...inp.files] : []; inp.remove(); resolve(files.length ? { name: (files[0] as any).webkitRelativePath?.split('/')[0] || 'Folder', uri: null, files } : null); });
    inp.addEventListener('cancel', () => { inp.remove(); resolve(null); });
    inp.click();
  });
}

/** The picture files beside `uri` (desktop), or in a picked Android folder; elsewhere null. */
export async function listFolderOf(uri: string, opts: { all?: boolean } = {}): Promise<{ uri: string; name: string; entries: FolderEntry[] } | null> {
  const all = opts.all ?? listing.allFiles;
  if (desktop) { try { return await desktop.listFolder({ uri, all }); } catch { return null; } }
  if (isNative() && Native.listFolder && /^content:/.test(uri)) { try { return await Native.listFolder({ uri, all }); } catch { return null; } }
  return null;
}

// ------------------------------------------------------------------------------------------
// File operations (M2): rename, delete, move, copy, folder picking, file times. Each backend says what
// it can do; the commands disable themselves for the rest.

export interface FileOpCaps { rename: boolean; delete: boolean; trash: boolean; move: boolean; copy: boolean; pickFolder: boolean; setTime: boolean; restore: boolean }

const FSA_DIR = 'fsadir:';
const fsaDir = (uri: string | null | undefined): any => (uri && uri.startsWith(FSA_DIR) ? handles.get(uri.slice(FSA_DIR.length)) : undefined);
const mimeOf = (name: string) => { const ext = (name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase(); return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', avif: 'image/avif', heic: 'image/heic', svg: 'image/svg+xml' } as Record<string, string>)[ext] || 'application/octet-stream'; };

/** What file operations the entry's backend supports. `dirUri` is the folder the entry was listed from. */
export function fileOpCaps(uri: string | null, dirUri: string | null): FileOpCaps {
  const none: FileOpCaps = { rename: false, delete: false, trash: false, move: false, copy: false, pickFolder: false, setTime: false, restore: false };
  if (!uri) return none;
  if (desktop) return { rename: true, delete: true, trash: true, move: true, copy: true, pickFolder: true, setTime: true, restore: true };
  if (uri.startsWith('fsa:')) { const dir = fsaDir(dirUri); const fsa = !!(window as any).showDirectoryPicker; return { rename: !!dir, delete: !!dir, trash: false, move: !!dir && fsa, copy: fsa, pickFolder: fsa, setTime: false, restore: !!dir }; }
  if (uri.startsWith(IOS_PREFIX)) return { rename: true, delete: true, trash: false, move: false, copy: false, pickFolder: false, setTime: false, restore: true };
  if (isNative() && /^content:/.test(uri)) { const tree = !!Native.pickFolder && !!Native.createInFolder; return { rename: !!Native.renameDocument, delete: !!Native.deleteDocument, trash: false, move: tree, copy: tree, pickFolder: tree, setTime: false, restore: tree && !!dirUri && /^content:/.test(dirUri) }; }
  return none;
}

export async function renameFile(uri: string, dirUri: string | null, newName: string): Promise<{ uri: string; name: string }> {
  if (desktop) return desktop.renameDocument({ uri, name: newName });
  if (uri.startsWith('fsa:')) {
    const h = handles.get(uri.slice(4)), dir = fsaDir(dirUri);
    if (!h || !dir) throw new Error('The folder is not available for renaming.');
    if (newName.toLowerCase() !== String(h.name).toLowerCase()) { let taken = false; try { await dir.getFileHandle(newName); taken = true; } catch { /* free */ } if (taken) throw new Error(`A file named "${newName}" already exists.`); } // neither move() nor the copy below may replace another file
    if (typeof h.move === 'function') { try { await h.move(newName); return { uri: 'fsa:' + (await handleId(h)), name: newName }; } catch { /* fall through to copy + remove */ } }
    const f: File = await h.getFile();
    const nh = await dir.getFileHandle(newName, { create: true });
    const w = await nh.createWritable(); await w.write(f); await w.close();
    await dir.removeEntry(h.name);
    return { uri: 'fsa:' + (await handleId(nh)), name: newName };
  }
  if (uri.startsWith(IOS_PREFIX)) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const safe = newName.replace(/[\\/:*?"<>|]/g, '_');
    await Filesystem.rename({ from: uri.slice(IOS_PREFIX.length), to: safe, directory: Directory.Documents });
    return { uri: IOS_PREFIX + safe, name: safe };
  }
  if (isNative() && Native.renameDocument) return Native.renameDocument({ uri, name: newName });
  throw new Error('Renaming is not available here.');
}

/** Deletes a file: to the Recycle Bin / Trash on the desktop unless `permanent`. */
export async function deleteFile(uri: string, dirUri: string | null, permanent: boolean): Promise<{ trashed: boolean }> {
  if (desktop) { const r = await desktop.deleteDocument({ uri, permanent }); return { trashed: !!r.trashed }; }
  if (uri.startsWith('fsa:')) {
    const h = handles.get(uri.slice(4)), dir = fsaDir(dirUri);
    if (!h || !dir) throw new Error('The folder is not available for deleting.');
    await dir.removeEntry(h.name);
    handles.delete(uri.slice(4));
    return { trashed: false };
  }
  if (uri.startsWith(IOS_PREFIX)) { const { Filesystem, Directory } = await import('@capacitor/filesystem'); await Filesystem.deleteFile({ path: uri.slice(IOS_PREFIX.length), directory: Directory.Documents }); return { trashed: false }; }
  if (isNative() && Native.deleteDocument) { await Native.deleteDocument({ uri, permanent }); return { trashed: false }; }
  throw new Error('Deleting is not available here.');
}

/** A destination folder: {uri, name}, or null when canceled or unavailable. */
export async function pickFolder(title: string): Promise<{ uri: string; name: string } | null> {
  if (desktop) { const r = await desktop.pickFolder({ title }); return r.canceled || !r.uri ? null : { uri: r.uri, name: r.name || r.uri }; }
  if (isNative() && Native.pickFolder) { const r = await Native.pickFolder({ title }); return r.canceled || !r.uri ? null : { uri: r.uri, name: r.name || 'Folder' }; }
  const anyWin = window as any;
  if (anyWin.showDirectoryPicker) {
    try { const dir = await anyWin.showDirectoryPicker({ mode: 'readwrite' }); return { uri: FSA_DIR + (await handleId(dir)), name: dir.name }; } catch (e: any) { if (e?.name === 'AbortError') return null; throw e; }
  }
  return null;
}

/** Writes `data` as `name` into a folder from pickFolder / openFolder; replaces an existing file of that name. */
/** "name (2).ext", "name (3).ext"… for the first `n` for which `taken` says no. */
export async function freeNameWith(name: string, taken: (n: string) => Promise<boolean>): Promise<string> {
  if (!(await taken(name))) return name;
  const i = name.lastIndexOf('.'), base = i > 0 ? name.slice(0, i) : name, ext = i > 0 ? name.slice(i) : '';
  for (let k = 2; k < 10000; k++) { const n = `${base} (${k})${ext}`; if (!(await taken(n))) return n; }
  throw new Error(`No free name for ${name}.`);
}
/**
 * Writes a file into a folder. `ifExists` says what happens when the name is taken: 'overwrite' replaces the file
 * (sidecars, the library file), 'rename' never touches an existing file and writes "name (2).ext" instead (batch
 * outputs, imports, copies). The name actually used comes back.
 */
export async function writeIntoFolder(dirUri: string, name: string, data: ArrayBuffer, ifExists: 'overwrite' | 'rename' = 'overwrite'): Promise<{ uri: string; name: string }> {
  if (desktop) return desktop.createInFolder({ dirUri, name, mime: mimeOf(name), data: b64FromBuffer(data), ifExists });
  const dir = fsaDir(dirUri);
  if (dir) {
    if (dir.requestPermission && (await dir.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('Writing to the folder was not allowed.');
    const used = ifExists === 'rename' ? await freeNameWith(name, async (n) => { try { await dir.getFileHandle(n); return true; } catch { return false; } }) : name;
    const nh = await dir.getFileHandle(used, { create: true });
    const w = await nh.createWritable(); await w.write(data); await w.close();
    return { uri: 'fsa:' + (await handleId(nh)), name: used };
  }
  if (dirUri.startsWith(IOS_PREFIX)) { const used = await iosWrite(new Blob([data]), ifExists === 'rename' ? await iosFreeName(name) : name); return { uri: IOS_PREFIX + used, name: used }; }
  if (isNative() && Native.createInFolder) return Native.createInFolder({ dirUri, name, mime: mimeOf(name), data: b64FromBuffer(data), ifExists });
  throw new Error('The folder cannot be written to here.');
}

/** Copies (or, with `move`, moves) the file into `dirUri`. Returns the new file. */
export async function copyFileTo(uri: string, dirUri: string | null, destDirUri: string, name: string, move: boolean): Promise<{ uri: string; name: string }> {
  if (desktop) return move ? desktop.moveFile({ uri, dirUri: destDirUri, name }) : desktop.copyFile({ uri, dirUri: destDirUri, name });
  const src = await readUri(uri);
  if (!src) throw new Error('The file could not be read.');
  const out = await writeIntoFolder(destDirUri, name, src.data);
  if (move) await deleteFile(uri, dirUri, true);
  return out;
}

/** Downloads a picture: through the desktop main process, or fetch() where the host allows cross-origin reads. */
export async function fetchPicture(url: string): Promise<OpenedFile> {
  if (!/^https?:\/\//i.test(url)) throw new Error('Enter an http(s) address.');
  if (desktop) { const r = await desktop.fetchUrl({ url }); return { name: r.name, data: bufferFromB64(r.data), uri: null, mime: r.mime }; }
  const res = await fetch(url, { mode: 'cors', redirect: 'follow' });
  if (!res.ok) throw new Error(`The server answered ${res.status}`);
  let name = '';
  try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch { /* */ }
  return { name: name || 'picture', data: await res.arrayBuffer(), uri: null, mime: res.headers.get('content-type') || undefined };
}

/** An HTTP request through the native layer; null when running in a plain browser (use fetch). */
export async function nativeRequest(o: { url: string; method: string; headers: Record<string, string>; body?: string | Uint8Array; timeoutMs?: number }): Promise<{ status: number; headers: Record<string, string>; bytes: Uint8Array } | null> {
  const bridge: any = desktop || (Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('QuillNative') ? Native : null);
  if (!bridge?.request) return null;
  const body = o.body === undefined ? undefined : typeof o.body === 'string' ? b64FromBuffer(new TextEncoder().encode(o.body).buffer as ArrayBuffer) : b64FromBuffer(o.body.buffer.slice(o.body.byteOffset, o.body.byteOffset + o.body.byteLength) as ArrayBuffer);
  const r = await bridge.request({ url: o.url, method: o.method, headers: o.headers, body, timeoutMs: o.timeoutMs });
  const headers: Record<string, string> = {}; for (const [k, v] of Object.entries(r.headers || {})) headers[k.toLowerCase()] = String(v);
  return { status: r.status, headers, bytes: new Uint8Array(bufferFromB64(r.data || '')) };
}

// ------------------------------------------------------------------------------------------
// Platform-bound file commands: what each shell can do, and the calls.

export interface PlatformCaps { wallpaper: boolean; lockScreen: boolean; contactPhoto: boolean; cast: boolean; copyAsFile: boolean; properties: boolean; associations: boolean; scanner: boolean; cameraIntent: boolean; subfolders: boolean }
export function platformCaps(): PlatformCaps {
  const android = Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('QuillNative');
  const d = !!desktop;
  return { wallpaper: android || d, lockScreen: android || (d && desktop!.platform === 'linux'), contactPhoto: android, cast: android, copyAsFile: android || d, properties: d, associations: android || d, scanner: d && (desktop!.platform === 'linux' || desktop!.platform === 'win32'), cameraIntent: android, subfolders: android || d };
}
const nativeOnly = (): QuillNativePlugin => { if (desktop) throw new Error('Not on the desktop'); return Native; };
export const setWallpaper = (png: ArrayBuffer, which: 'home' | 'lock' | 'both') => (desktop ? desktop.setWallpaper({ data: b64FromBuffer(png), which }) : nativeOnly().setWallpaper!({ data: b64FromBuffer(png), which }));
export const attachData = (name: string, mime: string, data: ArrayBuffer) => nativeOnly().attachData!({ name, mime, data: b64FromBuffer(data) });
export const openCastSettings = () => nativeOnly().openCastSettings!();
export const copyFileToClipboard = (o: { uri: string | null; name: string; mime: string; data?: ArrayBuffer }) => (desktop ? desktop.copyFileToClipboard({ uri: o.uri! }) : nativeOnly().copyFileToClipboard!({ name: o.name, mime: o.mime, data: b64FromBuffer(o.data!) }));
export const showProperties = (uri: string) => desktop!.showProperties({ uri });
export const setAssociations = (exts: string[]) => (desktop ? desktop.setAssociations({ exts }) : nativeOnly().openDefaultApps!().then((r) => ({ ok: r.ok, how: 'Settings ▸ Default apps', done: [], failed: [] })));
export const listScanners = () => (desktop ? desktop.listScanners() : Promise.resolve({ devices: [], note: 'No scanner support in this shell' }));
export async function scanPage(o: { device?: string; dpi: number; mode: 'color' | 'gray' }): Promise<OpenedFile> { const r = await desktop!.scan(o); return { name: r.name, data: bufferFromB64(r.data), uri: null, mime: r.mime }; }
export async function capturePhoto(): Promise<OpenedFile | null> { const r = await nativeOnly().capturePhoto!(); if (r.canceled || !r.data) return null; return { name: r.name || 'photo.jpg', data: bufferFromB64(r.data), uri: null, mime: r.mime }; }
export async function createSubfolder(dirUri: string, name: string): Promise<{ uri: string; name: string }> {
  if (desktop) return desktop.createSubfolder({ dirUri, name });
  const dir = fsaDir(dirUri);
  if (dir) { const child = await dir.getDirectoryHandle(name, { create: true }); return { uri: FSA_DIR + (await handleId(child)), name: child.name }; }
  return nativeOnly().createSubfolder!({ dirUri, name });
}
/** Whether a new folder can be made inside `dirUri` here. */
export const canCreateSubfolder = (dirUri: string | null): boolean => !!dirUri && (!!desktop || !!fsaDir(dirUri) || (Capacitor.getPlatform() === 'android' && /^content:/.test(dirUri)));

export async function setFileTime(uri: string, mtime: number): Promise<boolean> {
  if (desktop) return (await desktop.setFileTime({ uri, mtime })).ok;
  return false;
}

function toastSaved(name: string): void {
  import('../ui/dialog').then(({ toast }) => toast(`Saved "${name}" to Files ▸ On My iPhone ▸ Anne's Lens`)).catch(() => undefined);
}

export async function saveAs(blob: Blob, name: string): Promise<{ uri: string | null; name: string } | null> {
  if (isNative()) {
    const r = await Native.saveAs({ name, mime: blob.type || 'application/octet-stream', data: b64FromBuffer(await blob.arrayBuffer()) });
    if (r.canceled) return null;
    return { uri: r.uri || null, name: r.name || name };
  }
  if (isIOS()) {
    const n = await iosWrite(blob, await iosFreeName(name));
    toastSaved(n);
    return { uri: IOS_PREFIX + n, name: n };
  }
  const anyWin = window as any;
  if (anyWin.showSaveFilePicker) {
    try {
      const handle = await anyWin.showSaveFilePicker({ suggestedName: name });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return { uri: 'fsa:' + (await handleId(handle)), name: handle.name };
    } catch (e: any) {
      if (e?.name === 'AbortError') return null;
    }
  }
  download(blob, name);
  return { uri: null, name };
}

/** File System Access handles by id. Names alone are not unique: two folders can hold "IMG_0001.jpg". */
const handles = new Map<string, any>();
let handleSeq = 0;
export async function handleId(handle: any): Promise<string> {
  for (const [id, h] of handles) {
    try { if (await h.isSameEntry?.(handle)) { handles.set(id, handle); return id; } } catch { /* stale handle */ }
  }
  const id = `${Date.now().toString(36)}${(++handleSeq).toString(36)}:${handle.name}`;
  handles.set(id, handle);
  return id;
}
export const handleFor = (uri: string): any => (uri.startsWith('fsa:') ? handles.get(uri.slice(4)) : uri.startsWith(FSA_DIR) ? handles.get(uri.slice(FSA_DIR.length)) : undefined);
/** The fsadir: address of a directory handle (registering it for this session). */
export const dirUriFor = async (dir: any): Promise<string> => FSA_DIR + (await handleId(dir));

export async function writeBack(uri: string, blob: Blob): Promise<boolean> {
  if (uri.startsWith('fsa:')) {
    const h = handles.get(uri.slice(4));
    if (!h) return false;
    if (h.requestPermission && (await h.requestPermission({ mode: 'readwrite' })) !== 'granted') return false;
    const w = await h.createWritable();
    await w.write(blob);
    await w.close();
    return true;
  }
  if (uri.startsWith(IOS_PREFIX)) { await iosWrite(blob, uri.slice(IOS_PREFIX.length)); return true; }
  if (!isNative()) return false;
  const r = await Native.writeUri({ uri, data: b64FromBuffer(await blob.arrayBuffer()) });
  return !!r.ok;
}

export async function readUri(uri: string): Promise<OpenedFile | null> {
  if (uri.startsWith('fsa:')) {
    const h = handles.get(uri.slice(4));
    if (!h) return null;
    try { const f: File = await h.getFile(); return { name: f.name, data: await f.arrayBuffer(), uri, mime: f.type, size: f.size, mtime: f.lastModified }; } catch { return null; }
  }
  if (uri.startsWith(IOS_PREFIX)) {
    try {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      const r = await Filesystem.readFile({ path: uri.slice(IOS_PREFIX.length), directory: Directory.Documents });
      return { name: uri.slice(IOS_PREFIX.length), data: bufferFromB64(typeof r.data === 'string' ? r.data : b64FromBuffer(await (r.data as Blob).arrayBuffer())), uri };
    } catch { return null; }
  }
  if (!isNative()) return null;
  try {
    const r = await Native.readUri({ uri });
    return { name: r.name || 'picture', data: bufferFromB64(r.data), uri, mime: r.mime, size: r.size, mtime: r.mtime };
  } catch {
    return null;
  }
}

export async function printDocument(jobName: string): Promise<void> {
  if (isNative()) { await Native.print({ jobName }); return; }
  window.print();
}

/** Whether the share sheet can take a file here (the app's native plugin, iOS, or a browser with file sharing). */
export async function canShareFiles(blob: Blob, name: string): Promise<boolean> {
  if (isNative() || isIOS()) return true;
  const nav = navigator as any;
  try { return !!(nav.canShare && nav.canShare({ files: [new File([blob], name, { type: blob.type })] })); } catch { return false; }
}
/** `extra`: a subject, message text and address for a mail app (the share sheet passes what the platform allows). */
export async function shareFile(blob: Blob, name: string, title?: string, extra: { subject?: string; text?: string; to?: string } = {}): Promise<void> {
  if (isNative()) {
    await Native.share({ name, mime: blob.type || 'application/octet-stream', data: b64FromBuffer(await blob.arrayBuffer()), title, ...extra });
    return;
  }
  if (isIOS()) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const w = await Filesystem.writeFile({ path: name.replace(/[\\/:*?"<>|]/g, '_') || 'picture', data: b64FromBuffer(await blob.arrayBuffer()), directory: Directory.Cache });
    await Share.share({ title: title || name, text: extra.text, files: [w.uri] });
    return;
  }
  const file = new File([blob], name, { type: blob.type });
  const nav = navigator as any;
  if (nav.canShare && nav.canShare({ files: [file] })) { await nav.share({ files: [file], title: title || name, text: extra.text }); return; }
  download(blob, name);
}

/**
 * iOS has no QuillNative plugin: "Open in Anne's Lens" and Share arrive as file:// URLs through the
 * Capacitor App plugin; iOS copies the file into the app's Documents/Inbox first.
 */
let lastIosUrl = '';
async function readIosUrl(url: string): Promise<OpenedFile | null> {
  if (!/^file:/i.test(url) || url === lastIosUrl) return null;
  lastIosUrl = url;
  try {
    const { Filesystem } = await import('@capacitor/filesystem');
    const r = await Filesystem.readFile({ path: url });
    const data = typeof r.data === 'string' ? bufferFromB64(r.data) : await (r.data as Blob).arrayBuffer();
    let name = url.split(/[?#]/)[0].split('/').pop() || 'picture';
    try { name = decodeURIComponent(name); } catch { /* keep the raw name */ }
    return { name, data, uri: null };
  } catch {
    return null;
  }
}

/** The file(s) the app was started with ("Open with", "Share to", command line), consumed once. */
export async function launchFiles(): Promise<OpenedFile[]> {
  if (isCapacitor() && isIOS() && !isNative()) {
    try {
      const { App } = await import('@capacitor/app');
      const r = await App.getLaunchUrl();
      const f = r?.url ? await readIosUrl(r.url) : null;
      return f ? [f] : [];
    } catch {
      return [];
    }
  }
  if (!isNative()) return [];
  try {
    const r = await Native.getLaunchFile();
    if (!r) return [];
    if (r.files?.length) return r.files.filter((f) => f.data).map(fromNative);
    return r.data ? [fromNative(r)] : [];
  } catch {
    return [];
  }
}

export function onFilesOpened(cb: (f: OpenedFile[]) => void): void {
  if (isCapacitor() && isIOS() && !isNative()) {
    void import('@capacitor/app').then(({ App }) => App.addListener('appUrlOpen', (e) => { void readIosUrl(e.url).then((f) => { if (f) cb([f]); }); }));
    return;
  }
  if (!isNative()) return;
  Native.addListener('fileOpened', (r) => { if (r.files?.length) cb(r.files.filter((f) => f.data).map(fromNative)); else if (r.data) cb([fromNative(r)]); });
}

export async function keepAwake(on: boolean): Promise<void> {
  if (!isNative()) {
    try { if (on) (window as any).__wake = await (navigator as any).wakeLock?.request('screen'); else (window as any).__wake?.release(); } catch { /* */ }
    return;
  }
  try { await Native.keepAwake({ on }); } catch { /* */ }
}

/** Open a URL outside the app (system browser or mail app). */
export function openExternal(url: string): void {
  if (!/^(https?|mailto|tel|ftp|sms|geo):/i.test(url.trim())) return;
  if (desktop) { void desktop.openExternal({ url }); return; }
  if (isCapacitor()) { window.location.href = url; return; }
  window.open(url, '_blank', 'noopener');
}

export async function onBackButton(cb: () => boolean): Promise<void> {
  if (!isCapacitor() || isIOS()) return;
  const { App } = await import('@capacitor/app');
  App.addListener('backButton', () => { if (!cb()) App.minimizeApp(); });
}

/** Read clipboard text. Returns null when the platform refuses (no permission, no focus). */
export async function readClipboardText(): Promise<string | null> {
  try {
    if (isNative()) return (await Native.readClipboard()).text ?? null;
    if (navigator.clipboard?.readText) return await navigator.clipboard.readText();
  } catch { /* denied */ }
  return null;
}

export async function writeClipboardText(text: string): Promise<boolean> {
  try {
    if (isNative()) { await Native.writeClipboard({ text }); return true; }
    await navigator.clipboard.writeText(text);
    return true;
  } catch { return false; }
}

// ------------------------------------------------------------------------------------------
// Sibling Anne's Office apps

export type QuillApp = 'Anne\'s Pen' | 'Anne\'s Post' | 'Anne\'s Grid' | 'Anne\'s Stage' | 'Anne\'s Loom' | 'Anne\'s Press' | 'Anne\'s Folio';
export const QUILL_APP_IDS: Record<QuillApp, string> = {
  'Anne\'s Pen': 'io.github.socrtwo.quillpen', 'Anne\'s Post': 'io.github.socrtwo.quillpost', 'Anne\'s Grid': 'io.github.socrtwo.quillgrid',
  'Anne\'s Stage': 'io.github.socrtwo.quillstage', 'Anne\'s Loom': 'io.github.socrtwo.quillloom', 'Anne\'s Press': 'io.github.socrtwo.quillpress', 'Anne\'s Folio': 'io.github.socrtwo.quillfolio',
};

export async function openInQuillApp(app: QuillApp, data: ArrayBuffer, name: string, mime: string): Promise<{ opened: boolean; reason: 'not-installed' | 'unsupported' | 'error' | ''; message?: string }> {
  try {
    if (isNative() && !desktop && Native.openInApp) {
      const r = await Native.openInApp({ packageName: QUILL_APP_IDS[app], name, mime, data: b64FromBuffer(data) });
      return r.opened ? { opened: true, reason: '' } : { opened: false, reason: 'not-installed' };
    }
  } catch (e: any) {
    return { opened: false, reason: 'error', message: e?.message || String(e) };
  }
  return { opened: false, reason: 'unsupported' };
}

/** Called when the app returns to the foreground (Android resume, browser tab visible again). */
export function onAppResume(cb: () => void): () => void {
  const vis = () => { if (document.visibilityState === 'visible') cb(); };
  document.addEventListener('visibilitychange', vis);
  let remove: (() => void) | null = null;
  if (isCapacitor()) {
    import('@capacitor/app').then(({ App }) => App.addListener('resume', cb)).then((h) => { remove = () => h.remove(); }).catch(() => undefined);
  }
  return () => { document.removeEventListener('visibilitychange', vis); remove?.(); };
}

// ------------------------------------------------------------------------------------------
// Folder tree (Next / Previous Folder): subfolders of a folder the app can list, and its parent.

const folderCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
/** True when this platform can list the folders inside `uri`. */
export function canListSubfolders(uri: string | null | undefined): boolean {
  if (!uri) return false;
  if (desktop) return uri.startsWith('file:');
  if (uri.startsWith(FSA_DIR)) return !!fsaDir(uri);
  return isNative() && /^content:/.test(uri) && !!Native.listSubfolders;
}
/** The folders inside `uri` in name order (numbers in order: 2 before 10); null where it cannot be listed. */
export async function listSubfolders(uri: string): Promise<FolderRef[] | null> {
  let out: FolderRef[] | null = null;
  if (desktop && uri.startsWith('file:')) out = (await desktop.listSubfolders!({ uri })).folders;
  else if (uri.startsWith(FSA_DIR)) {
    const dir = fsaDir(uri); if (!dir) return null;
    out = [];
    for await (const [name, h] of dir.entries()) if (h.kind === 'directory' && !name.startsWith('.')) out.push({ name, uri: FSA_DIR + (await handleId(h)) });
  } else if (isNative() && /^content:/.test(uri) && Native.listSubfolders) out = (await Native.listSubfolders({ uri })).folders;
  return out ? out.sort((a, b) => folderCollator.compare(a.name, b.name)) : null;
}
/** The folder above `uri` (desktop file systems only; elsewhere the opened folder is the top). */
export async function parentFolderOf(uri: string): Promise<FolderRef | null> {
  if (desktop && uri.startsWith('file:')) { try { return await desktop.parentFolder({ uri }); } catch { return null; } }
  return null;
}
/** The picture files directly in a folder, as entries for listFolderOf-style results or File System Access handles. */
export async function listFolderFiles(uri: string, opts: { all?: boolean } = {}): Promise<{ entries?: FolderEntry[]; handles?: { name: string; handle: any }[] } | null> {
  if (uri.startsWith(FSA_DIR)) {
    const dir = fsaDir(uri); if (!dir) return null;
    const handles: { name: string; handle: any }[] = [];
    for await (const [name, h] of dir.entries()) if (h.kind === 'file') handles.push({ name, handle: h });
    return { handles };
  }
  const r = await listFolderOf(uri, opts);
  return r ? { entries: r.entries } : null;
}

/** On the desktop, keeps a folder the user chose readable after a restart (elsewhere the platform keeps it). */
export async function rememberFolder(uri: string | null | undefined): Promise<void> {
  if (desktop && uri && uri.startsWith('file:')) { try { await desktop.rememberFolder({ uri }); } catch { /* not granted */ } }
}
