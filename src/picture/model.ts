import type { Wcs } from '../codecs/wcs';
/**
 * The in-memory picture: pages (multipage TIFF, every size of an ICO), frames (animations) and the
 * metadata the Information dialog shows. Pixels live in canvases or ImageBitmaps, one per frame.
 */
import type { Entry } from './folder';
import type { FormatInfo } from '../codecs/registry';
import type { ExifData } from '../meta/exif';
import type { TextLayer } from '../codecs/raster';

/** One decoded frame. `image` is drawable by drawImage; `raster` keeps the bytes when a decoder produced them. */
export interface Frame {
  image: ImageBitmap | HTMLCanvasElement | HTMLImageElement | OffscreenCanvas;
  width: number;
  height: number;
  /** Frame delay in milliseconds (animations). */
  delay: number;
}

export interface Page {
  width: number;
  height: number;
  frames: Frame[];
  /** Loop count for animations: 0 = forever. */
  loops: number;
  /** Bits per pixel as stored in the file. */
  bitDepth: number;
  /** Palette entries when the page is color-mapped. */
  paletteSize?: number;
  hasAlpha: boolean;
  /** Pixels per inch, when the file says. */
  dpi?: [number, number];
  /** Descriptive notes from the decoder (compression, color type, "grayscale"...). */
  notes: string[];
  /** The ICC profile the pixel values are in (embedded, assigned or converted to); absent means sRGB. */
  icc?: Uint8Array;
  /** Text stored in the file (DjVu's text layer); dropped when the page is rotated, flipped or resized. */
  textLayer?: TextLayer;
  /** The world coordinate system of a FITS image; dropped when the page is rotated, flipped or resized. */
  world?: Wcs;
}

export class Picture {
  /** Bumped whenever pages change (viewer cache key). */
  version = 0;
  /** The EXIF orientation was applied to the pixels (on decode by the auto-rotate option, or by the command). */
  orientationApplied = false;
  /** The orientation from the file where it is not in readable EXIF (a RAW file's own header); overrides the EXIF tag. */
  fileOrientation: number | null = null;
  page = 0;
  frame = 0;
  loadMs = 0;
  /** A video or audio file: the pages are its first frame or cover art; the bytes play in the Media Player. */
  media: { kind: 'video' | 'audio'; mime: string; duration?: number; title?: string } | null = null;
  constructor(
    public entry: Entry,
    public bytes: Uint8Array,
    public format: FormatInfo,
    public pages: Page[],
    public exif: ExifData | null,
    /** What the decoder found in the container (JPEG markers, PNG chunks...). */
    public info: Record<string, string> = {},
    /** Decoder warnings (truncated data, unknown chunks). */
    public warnings: string[] = [],
    /** The decoder that produced the pages ('platform', 'gif', 'tiff', 'ico', 'bmp'). */
    public decoder = 'platform',
  ) {}

  get name(): string { return this.entry.name; }
  get current(): Page { return this.pages[this.page] || this.pages[0]; }
  get currentFrame(): Frame { const p = this.current; return p.frames[Math.min(this.frame, p.frames.length - 1)]; }
  get width(): number { return this.current.width; }
  get height(): number { return this.current.height; }
  get animated(): boolean { return this.current.frames.length > 1; }
  get multipage(): boolean { return this.pages.length > 1; }
  /** The EXIF Orientation tag (1–8), 1 when absent. */
  get orientation(): number { return this.fileOrientation ?? (this.exif?.orientation || 1); }

  /** A canvas with the current frame's pixels (for pixel info, histograms and edits). */
  frameCanvas(frame = this.currentFrame): HTMLCanvasElement {
    if (frame.image instanceof HTMLCanvasElement) return frame.image;
    const c = document.createElement('canvas');
    c.width = frame.width; c.height = frame.height;
    c.getContext('2d', { willReadFrequently: true })!.drawImage(frame.image as CanvasImageSource, 0, 0);
    return c;
  }

  /** Releases decoded bitmaps (when a picture leaves the prefetch cache). */
  release(): void {
    for (const p of this.pages) for (const f of p.frames) { if (typeof ImageBitmap !== 'undefined' && f.image instanceof ImageBitmap) f.image.close(); }
  }
}

/** Replaces each frame of `page` with the result of `fn` drawn on a fresh canvas of the given size. */
export function mapPage(page: Page, size: (w: number, h: number) => [number, number], draw: (ctx: CanvasRenderingContext2D, f: Frame, w: number, h: number) => void): Page {
  const frames = page.frames.map((f) => {
    const [w, h] = size(f.width, f.height);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d')!;
    draw(ctx, f, w, h);
    return { image: c, width: w, height: h, delay: f.delay };
  });
  const [w, h] = size(page.width, page.height);
  const { textLayer: _, world: _w, ...rest } = page; // the word boxes and sky coordinates no longer match
  return { ...rest, width: w, height: h, frames };
}

/** Rotates by 90° steps (positive = clockwise) or flips a page. */
export function transformPage(page: Page, op: 'cw' | 'ccw' | '180' | 'flipH' | 'flipV'): Page {
  const swap = op === 'cw' || op === 'ccw';
  return mapPage(page, (w, h) => (swap ? [h, w] : [w, h]), (ctx, f, w, h) => {
    ctx.save();
    ctx.translate(w / 2, h / 2);
    if (op === 'cw') ctx.rotate(Math.PI / 2);
    else if (op === 'ccw') ctx.rotate(-Math.PI / 2);
    else if (op === '180') ctx.rotate(Math.PI);
    else if (op === 'flipH') ctx.scale(-1, 1);
    else ctx.scale(1, -1);
    ctx.drawImage(f.image as CanvasImageSource, -f.width / 2, -f.height / 2);
    ctx.restore();
  });
}

/** The operations that bring an EXIF-oriented picture upright (applied in order). */
export function orientationOps(o: number): ('cw' | 'ccw' | '180' | 'flipH' | 'flipV')[] {
  switch (o) {
    case 2: return ['flipH'];
    case 3: return ['180'];
    case 4: return ['flipV'];
    case 5: return ['flipH', 'ccw'];
    case 6: return ['cw'];
    case 7: return ['flipH', 'cw'];
    case 8: return ['ccw'];
    default: return [];
  }
}
