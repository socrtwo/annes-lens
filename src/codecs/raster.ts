/** A decoded frame as plain RGBA bytes (what the app's own decoders produce; works without a DOM). */
export interface Raster {
  width: number;
  height: number;
  /** RGBA, row-major, not premultiplied. */
  data: Uint8ClampedArray<ArrayBuffer>;
}

/**
 * Bilinear blend of four RGBA pixels (at a, b on the upper row, c, d on the lower) weighted by their alpha, so a
 * transparent pixel's color does not bleed into its neighbours (the average of premultiplied values, unpremultiplied).
 */
export function blend4(s: ArrayLike<number>, a: number, b: number, c: number, d: number, fx: number, fy: number, out: Uint8ClampedArray, o: number): void {
  const wa = (1 - fx) * (1 - fy), wb = fx * (1 - fy), wc = (1 - fx) * fy, wd = fx * fy;
  const aa = s[a + 3] * wa, ab = s[b + 3] * wb, ac = s[c + 3] * wc, ad = s[d + 3] * wd, alpha = aa + ab + ac + ad;
  if (alpha > 0) for (let i = 0; i < 3; i++) out[o + i] = (s[a + i] * aa + s[b + i] * ab + s[c + i] * ac + s[d + i] * ad) / alpha;
  else for (let i = 0; i < 3; i++) out[o + i] = s[a + i] * wa + s[b + i] * wb + s[c + i] * wc + s[d + i] * wd;
  out[o + 3] = alpha;
}

export function makeRaster(width: number, height: number): Raster {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

import type { Wcs } from './wcs';
import { latin1 } from './limits';

export interface DecodedPage {
  width: number;
  height: number;
  frames: { raster: Raster; delay: number }[];
  loops: number;
  bitDepth: number;
  paletteSize?: number;
  hasAlpha: boolean;
  dpi?: [number, number];
  notes: string[];
  /** Text stored in the file with word positions (DjVu's text layer). */
  textLayer?: TextLayer;
  /** The world coordinate system of a FITS image (sky positions for the pixel readout and measurements). */
  world?: Wcs;
}

/** Text that comes with a page (not recognized by OCR): its words with boxes in page pixels. */
export interface TextLayer {
  source: string;
  text: string;
  words: { text: string; conf: number; bbox: { x0: number; y0: number; x1: number; y1: number } }[];
}

export interface DecodeResult {
  pages: DecodedPage[];
  info: Record<string, string>;
  warnings: string[];
}

/** Reads a 4-byte big-endian tag as ASCII. */
export const ascii = (u8: Uint8Array, o: number, n: number): string => latin1(u8, o, o + n);
