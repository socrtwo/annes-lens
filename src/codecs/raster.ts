/** A decoded frame as plain RGBA bytes (what the app's own decoders produce; works without a DOM). */
export interface Raster {
  width: number;
  height: number;
  /** RGBA, row-major, not premultiplied. */
  data: Uint8ClampedArray<ArrayBuffer>;
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
