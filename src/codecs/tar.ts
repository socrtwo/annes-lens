/**
 * tar archives (POSIX ustar, GNU long names, pax extended headers, base-256 sizes), plain or
 * compressed with gzip, bzip2 or xz: the regular files with their names, sizes and dates.
 */
import { withPartial, partialOf } from './limits';
import { bzip2Decode, isBzip2 } from './bzip2';
import { xzDecode, isXz } from './lzma';

export interface TarEntry { name: string; size: number; offset: number; mtime: number }

const str = (u8: Uint8Array, o: number, n: number) => { let e = o; while (e < o + n && u8[e]) e++; return new TextDecoder().decode(u8.subarray(o, e)); };
function num(u8: Uint8Array, o: number, n: number): number {
  if (u8[o] & 0x80) { let v = u8[o] & 0x7f; for (let i = 1; i < n; i++) v = v * 256 + u8[o + i]; return v; } // base-256
  const s = str(u8, o, n).trim(); return s ? parseInt(s, 8) || 0 : 0;
}
function checksumOk(u8: Uint8Array, o: number): boolean {
  let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : u8[o + i];
  return num(u8, o + 148, 8) === sum;
}
export const isTar = (u8: Uint8Array): boolean => u8.length >= 512 && (str(u8, 257, 5) === 'ustar' || checksumOk(u8, 0));
export const isGzip = (u8: Uint8Array): boolean => u8.length > 18 && u8[0] === 0x1f && u8[1] === 0x8b && u8[2] === 8;

/** The regular files in a tar archive. */
export function readTar(u8: Uint8Array): { entries: TarEntry[]; warnings: string[] } {
  const entries: TarEntry[] = [], warnings: string[] = [];
  let o = 0, longName = '', pax: Record<string, string> = {};
  while (o + 512 <= u8.length) {
    if (u8.subarray(o, o + 512).every((b) => b === 0)) break; // end of archive
    if (!checksumOk(u8, o)) { warnings.push(`The archive is damaged after ${entries.length} files`); break; }
    const type = String.fromCharCode(u8[o + 156] || 48), size = pax.size !== undefined ? +pax.size : num(u8, o + 124, 12);
    if (!(size >= 0) || size > u8.length - o) { warnings.push(`The archive is damaged after ${entries.length} files (a size that does not fit the file)`); break; } // a negative size would step backwards for ever
    const data = o + 512, next = data + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = str(u8, data, size); o = next; continue; }
    if (type === 'x') {
      // pax records: "<length> <key>=<value>\n"
      const text = new TextDecoder().decode(u8.subarray(data, data + size)); pax = {};
      for (const m of text.matchAll(/\d+ ([^=]+)=([^\n]*)\n/g)) pax[m[1]] = m[2];
      o = next; continue;
    }
    if (type === 'g' || type === 'K') { o = next; continue; }
    let name = pax.path || longName || str(u8, o, 100);
    const prefix = str(u8, o + 345, 155);
    if (!pax.path && !longName && prefix && str(u8, o + 257, 5) === 'ustar') name = `${prefix}/${name}`;
    if (type === '0' || type === '\0' || type === '7') {
      if (data + size > u8.length) { warnings.push(`${name} is cut off`); break; }
      const mtime = (pax.mtime ? parseFloat(pax.mtime) : num(u8, o + 136, 12)) * 1000;
      entries.push({ name, size, offset: data, mtime });
    }
    longName = ''; pax = {};
    o = next;
  }
  return { entries, warnings };
}

async function gunzip(u8: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip'), w = ds.writable.getWriter();
  void w.write(u8.slice()).catch(() => undefined); void w.close().catch(() => undefined);
  const parts: Uint8Array[] = []; const r = ds.readable.getReader(); let n = 0;
  const join = () => { const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
  try { for (;;) { const { done, value } = await r.read(); if (done) break; parts.push(value); n += value.length; } } catch (e) { throw withPartial(e, join()); }
  return join();
}
/** The tar inside a gzip, bzip2 or xz file (or the bytes as they are); null when it is not a tar. */
export async function untarable(u8: Uint8Array): Promise<{ tar: Uint8Array; compression: string; warning?: string } | null> {
  if (isTar(u8)) return { tar: u8, compression: '' };
  let inner: Uint8Array | null = null, warning: string | undefined;
  const compression = isGzip(u8) ? 'gzip' : isBzip2(u8) ? 'bzip2' : isXz(u8) ? 'xz' : '';
  try {
    if (compression === 'gzip') inner = await gunzip(u8);
    else if (compression === 'bzip2') inner = bzip2Decode(u8);
    else if (compression === 'xz') inner = xzDecode(u8);
  } catch (e) {
    // Damage part-way: the files unpacked before it are listed (R17).
    const part = partialOf(e), msg = (e as Error)?.message || String(e);
    if (!part || !isTar(part)) throw new Error(`The ${compression || 'compressed'} data could not be read (${msg})`);
    inner = part; warning = `The ${compression} data is damaged after ${Math.round(part.length / 1024)} KB (${msg}); the files before that are shown`;
  }
  return inner && isTar(inner) ? { tar: inner, compression, warning } : null;
}
