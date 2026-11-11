/**
 * Memory budgets for decoding files that may be damaged or crafted. Each decoder checks the size of one picture; these
 * bound what one file's pages or frames may take together, what a decompressor may produce, and how far a size in a
 * header may be believed against the bytes the file holds.
 */

/** The pixel budgets (an object, so that tests can make them small). */
export const decodeLimits = {
  /** Pixels kept for one file's pages or frames together (RGBA rasters, four bytes each: about a gigabyte). */
  totalPixels: 250e6,
  /** Pixels of frames the app makes itself from one picture (color cycling): no file data stands behind them. */
  synthPixels: 64e6,
};
/** The most one decompressed stream or archive entry may hold. */
export const MAX_UNPACKED = 512 * 1024 * 1024;

/** The most a solid block of an archive (many files packed as one stream) may hold. */
export const MAX_SOLID = 1536 * 1024 * 1024;

/** How many frames of w × h fit a pixel budget (at least one). */
export const framesWithin = (w: number, h: number, budget = decodeLimits.totalPixels): number => Math.max(1, Math.floor(budget / Math.max(1, w * h)));
/** Throws when an archive entry or stream says it unpacks to more than MAX_UNPACKED. */
export function checkUnpacked(size: number, what: string, max = MAX_UNPACKED): void {
  if (!(size >= 0) || size > max) throw new Error(`${what} unpacks to more than ${Math.floor(max / 1048576)} MB, which is not opened`);
}
/** Bytes as text, one character per byte, in pieces: String.fromCharCode(...bytes) overflows the stack on long input. */
export function latin1(b: ArrayLike<number>, from = 0, to = b.length): string {
  to = Math.min(to, b.length); let s = '';
  for (let i = Math.max(0, from); i < to; i += 8192) {
    const e = Math.min(to, i + 8192);
    s += String.fromCharCode.apply(null, ((b as Uint8Array).subarray ? (b as Uint8Array).subarray(i, e) : Array.prototype.slice.call(b, i, e)) as unknown as number[]);
  }
  return s;
}
