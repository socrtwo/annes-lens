/**
 * A folder: the ordered list of pictures next/previous move through, and the current position in it.
 * Entries read their bytes lazily from a File (web), a File System Access handle (directory picker),
 * a platform URI (desktop file system, Android content URI, iOS document) or bytes already in memory
 * (a dropped or shared file).
 */
import { readUri, type FolderEntry } from '../platform/native';

export interface Entry {
  name: string;
  /** Platform address for re-reading and write-back; null for in-memory and web File entries. */
  uri: string | null;
  size?: number;
  mtime?: number;
  /** The folder the entry was listed from, when that is not the open folder (Include Subfolders, the catalog). */
  dirUri?: string;
  /** The picture an AI edit started from (its file bytes), for the Content Credentials ingredient when the result is saved. */
  ingredient?: { name: string; bytes: Uint8Array; mime: string };
  read(): Promise<ArrayBuffer>;
  /** Size and date without reading the file, where the backend can tell (browser file handles). */
  stat?(): Promise<{ size: number; mtime: number }>;
}

const PICTURE_EXT = /\.(jpe?g|jpe|jfif|png|apng|gif|webp|avif|heic|heif|hif|bmp|dib|rle|ico|cur|tiff?|svgz?|jxl|psd|psb|tga|tpic|icb|vda|vst|pnm|ppm|pgm|pbm|pam|pfm|qoi|pcx|dcx|xpm|xbm|wbmp|icns|dds|iff|ilbm|lbm|ham|ham8|mac|pntg|pnt|pcd|exr|jp2|jpx|jpf|jph|j2k|j2c|jpc|jhc|hdr|pic|rgbe|cr2|cr3|crw|nef|nrw|arw|srf|sr2|raf|orf|rw2|rwl|pef|dng|3fr|fff|iiq|x3f|srw|mrw|erf|mef|mos|kdc|dcr|raw|eps|epsf|ai|pdf|djvu|djv|pct|pict|ras|sun|im1|im8|im24|im32|sgi|rgb|rgba|bw|urt|pi1|pi2|pi3|pc1|pc2|pc3|neo|spu|koa|kla|art|aas|ximg|msp|fpx|fli|flc|flx|clp|jbg|jbig|bie|jb2|jbig2|psp|pspimage|tub|icl|cdr|cpt|wmf|emf|wmz|emz|dcm|dicom|fits|fit|fts|fits\.gz|mp4|m4v|mov|qt|3gp|3g2|webm|mkv|ogv|avi|mp3|mp2|m4a|m4b|aac|flac|wav|wave|ogg|oga|opus|spx|aif|aiff|aifc|mka|weba)$/i;

export function isPictureName(name: string): boolean { return PICTURE_EXT.test(name); }
/**
 * Extensions that pictures share with other kinds of file (GEM IMG and disk images, Doodle and disk dumps, SGI
 * .int): left out of folder listings, but a file the user opens or drops with one is read and identified by content.
 */
const SHARED_EXT = /\.(img|dd|ddl|int|inta|exe|dll|ocx|cpl|scr|mun)$/i;
export const isSharedPictureName = (name: string): boolean => SHARED_EXT.test(name);
/** Programs and libraries are opened for the icons inside them; large icon libraries (imageres.dll) run to tens of MB. */
export const sharedMaxBytes = (name: string): number => (/\.(exe|dll|ocx|cpl|scr|mun)$/i.test(name) ? 256 : 16) * 1024 * 1024;
/** The largest such file read to see whether it is a picture (disk images are larger). */
export const SHARED_MAX_BYTES = 16 * 1024 * 1024;

export function entryFromFile(f: File): Entry {
  return { name: f.name, uri: null, size: f.size, mtime: f.lastModified, read: () => f.arrayBuffer() };
}
export function entryFromBytes(name: string, data: ArrayBuffer, uri: string | null = null): Entry {
  let cached: ArrayBuffer | null = data;
  return {
    name, uri, size: data.byteLength,
    read: async () => {
      if (cached) return cached;
      const r = uri ? await readUri(uri) : null;
      if (!r) throw new Error('The file is no longer available.');
      return r.data;
    },
    // A shared or launched file keeps its bytes only until it is first shown; after that it is re-read by URI when possible.
    ...({ release: () => { if (uri) cached = null; } } as object),
  };
}
export function entryFromUri(e: FolderEntry): Entry {
  return { name: e.name, uri: e.uri, size: e.size, mtime: e.mtime, read: async () => { const r = await readUri(e.uri); if (!r) throw new Error('The file could not be read.'); return r.data; } };
}
export function entryFromHandle(name: string, handle: any): Entry {
  let uri: string | null = null;
  const id = async () => { if (!uri) { const { handleId } = await import('../platform/native'); uri = 'fsa:' + (await handleId(handle)); } return uri; };
  void id();
  return {
    name, get uri() { return uri; }, set uri(v) { uri = v; },
    read: async () => { const f: File = await handle.getFile(); await id(); return f.arrayBuffer(); },
    stat: async () => { const f: File = await handle.getFile(); return { size: f.size, mtime: f.lastModified }; },
  } as Entry;
}

export type SortKey = 'name' | 'natural' | 'date' | 'size' | 'type';

export class Folder {
  entries: Entry[] = [];
  index = -1;
  name = '';
  /** Platform address of the folder itself, when known (file: URL, Android tree URI, fsadir: handle id). */
  uri: string | null = null;
  /** The top of the folder tree Next / Previous Folder may walk (null: as high as the platform allows). */
  treeTop?: string | null;
  private listeners = new Set<() => void>();

  constructor(entries: Entry[] = [], name = '') { this.entries = entries; this.name = name; }

  get current(): Entry | null { return this.entries[this.index] || null; }
  get length(): number { return this.entries.length; }

  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private changed(): void { for (const l of this.listeners) l(); }

  select(i: number): boolean {
    if (!this.entries.length) { this.index = -1; this.changed(); return false; }
    const j = Math.max(0, Math.min(this.entries.length - 1, i));
    this.index = j;
    this.changed();
    return true;
  }
  /** Moves by `d` pictures; wraps at the ends when asked. Returns false at an end without wrapping. */
  step(d: number, wrap: boolean): boolean {
    if (!this.entries.length) return false;
    let j = this.index + d;
    if (j < 0 || j >= this.entries.length) { if (!wrap) return false; j = ((j % this.entries.length) + this.entries.length) % this.entries.length; }
    return this.select(j);
  }
  /** The entry `d` steps away (for prefetching), or null. */
  peek(d: number, wrap: boolean): Entry | null {
    if (!this.entries.length) return null;
    let j = this.index + d;
    if (j < 0 || j >= this.entries.length) { if (!wrap) return null; j = ((j % this.entries.length) + this.entries.length) % this.entries.length; }
    return this.entries[j] || null;
  }
  indexOfName(name: string): number { return this.entries.findIndex((e) => e.name === name); }
  add(entries: Entry[]): void { this.entries.push(...entries); this.changed(); }
  remove(e: Entry): void {
    const i = this.entries.indexOf(e);
    if (i < 0) return;
    this.entries.splice(i, 1);
    if (this.index >= this.entries.length) this.index = this.entries.length - 1;
    else if (i < this.index) this.index--;
    this.changed();
  }
  sort(key: SortKey, descending = false): void {
    const cur = this.current;
    const collator = new Intl.Collator(undefined, { numeric: key === 'natural', sensitivity: 'base' });
    const ext = (n: string) => (n.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
    this.entries.sort((a, b) => {
      let r = 0;
      if (key === 'date') r = (a.mtime || 0) - (b.mtime || 0);
      else if (key === 'size') r = (a.size || 0) - (b.size || 0);
      else if (key === 'type') r = collator.compare(ext(a.name), ext(b.name));
      return (r || collator.compare(a.name, b.name)) * (descending ? -1 : 1);
    });
    this.index = cur ? this.entries.indexOf(cur) : -1;
    this.changed();
  }
}
