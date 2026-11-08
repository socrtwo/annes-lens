/**
 * Content sniffing and codec selection. A picture is recognized by its bytes, never by its name; the
 * decoder is the platform (createImageBitmap, ImageDecoder) for the formats it handles and the app's own
 * readers for GIF (every frame), TIFF, BMP, ICO and CUR, TGA, Netpbm, QOI, PCX, XPM, XBM, WBMP, PSD, ICNS,
 * DDS and Radiance HDR; camera RAW files show their largest embedded JPEG preview. Decoding happens off the main thread where the
 * platform allows (createImageBitmap) and is tolerant: a damaged GIF or TIFF shows what was readable.
 */
import { Picture, transformPage, orientationOps, type Page, type Frame } from '../picture/model';
import { keepEmbedded } from '../color/embedded';
import type { Entry } from '../picture/folder';
import { decodeGif, isGif } from './gif';
import { decodeTiff, isTiff } from './tiff';
import { decodeBmp, isBmp } from './bmp';
import { isIco, readIco, decodeIcoDibs } from './ico';
import { jpegInfo, pngInfo, webpInfo, type ContainerInfo } from './info';
import { decodeTga, isTga } from './tga';
import { decodePnm, isPnm } from './pnm';
import { decodeQoi, isQoi } from './qoi';
import { decodePcx, isPcx, isDcx } from './pcx';
import { decodeXpm, decodeXbm, isXpm, isXbm } from './xpm';
import { decodeWbmp, isWbmp } from './wbmp';
import { decodePsd, isPsd } from './psd';
import { isIcns, readIcns, decodeIcnsClassic } from './icns';
import { isJp2, isJ2k } from './jpx';
import { isIff, isPcd, isMacBinaryPaint, decodeIff, decodePcd, decodeMacPaint } from './retro';
import { decodeDds, isDds } from './dds';
import { decodeHdr, isHdr } from './hdr';
import { decodeExr, isExr, exrNeedsHtj2k } from './exr';
import { isEmf, isWmf } from './metafile';
import { identifyRaw, findEmbeddedJpegs, tiffThumbnail, RAW_EXTENSIONS } from './rawpreview';
import { isDng } from '../raw/dng';
import { isPdf } from './pdf';
import { isDjvu } from './djvu';
import { isSunRaster, isSgi, isUtahRle, decodeSun, decodeSgi, decodeUtahRle } from './workstation';
import { isAtariSt, isC64, isGemImg, isMsp, decodeAtariSt, decodeC64, decodeGemImg, decodeMsp } from './homecomputer';
import { isPict } from './pict';
import { isFlic, decodeFlic } from './flic';
import { isCfb } from './cfb';
import { isFlashPix } from './flashpix';
import { isClp } from './clipboard';
import { isJbig, isJbig2 } from './jbig';
import { isPsp } from './psp';
import { isDicom, isRawDicom } from './dicom';
import { sniffMedia } from './media';
import { isFits } from './fits';
import { winModuleKind } from './winres';
import { decodePngTolerant } from './png';
import { repairJpeg } from './jpegLossless';
import { isEps, epsPreview } from './eps';
import { isZip } from './zip';
import { readExif } from '../meta/exif';
import type { DecodedPage, Raster } from './raster';

export interface FormatInfo {
  id: string;
  label: string;
  mime: string;
  extensions: string[];
  /** How Anne's Lens decodes it: its own reader, the platform's codec, or both. */
  decoder: 'own' | 'platform' | 'platform+own';
  /** Writable by Save As (through the canvas encoders or the app's own writers). */
  save: boolean;
  notes?: string;
  /** Recognized by content but not opened yet, for want of a file to build the reader from: the app asks for a sample. */
  sample?: boolean;
}

export const FORMATS: FormatInfo[] = [
  { id: 'jpeg', label: 'JPEG', mime: 'image/jpeg', extensions: ['jpg', 'jpeg', 'jpe', 'jfif'], decoder: 'platform', save: true, notes: 'baseline and progressive; CMYK and 12-bit where the platform decodes them' },
  { id: 'png', label: 'PNG', mime: 'image/png', extensions: ['png'], decoder: 'platform', save: true, notes: 'APNG animation where the platform has ImageDecoder' },
  { id: 'apng', label: 'Animated PNG', mime: 'image/apng', extensions: ['apng', 'png'], decoder: 'platform', save: false },
  { id: 'gif', label: 'GIF', mime: 'image/gif', extensions: ['gif'], decoder: 'own', save: false, notes: 'every frame, delays, loop count, comments' },
  { id: 'webp', label: 'WebP', mime: 'image/webp', extensions: ['webp'], decoder: 'platform', save: true, notes: 'animation where the platform has ImageDecoder' },
  { id: 'avif', label: 'AVIF', mime: 'image/avif', extensions: ['avif'], decoder: 'platform+own', save: false, notes: 'the platform\'s decoder, else libavif with libaom (WebAssembly; the first frame of a sequence)' },
  { id: 'heic', label: 'HEIC / HEIF', mime: 'image/heic', extensions: ['heic', 'heif', 'hif'], decoder: 'platform', save: false, notes: 'where the platform decodes it (iOS, macOS, recent Android)' },
  { id: 'jxl', label: 'JPEG XL', mime: 'image/jxl', extensions: ['jxl'], decoder: 'platform+own', save: false, notes: 'the platform\'s decoder, else jxl-oxide (WebAssembly; animations, HDR and wide gamut converted to sRGB)' },
  { id: 'bmp', label: 'Windows Bitmap', mime: 'image/bmp', extensions: ['bmp', 'dib', 'rle'], decoder: 'platform+own', save: true, notes: '1–32 bits, RLE, bit fields, OS/2 headers' },
  { id: 'ico', label: 'Windows Icon', mime: 'image/x-icon', extensions: ['ico'], decoder: 'own', save: false, notes: 'every size as a page' },
  { id: 'cur', label: 'Windows Cursor', mime: 'image/x-icon', extensions: ['cur'], decoder: 'own', save: false, notes: 'every size as a page, with the hotspot' },
  { id: 'tiff', label: 'TIFF', mime: 'image/tiff', extensions: ['tif', 'tiff'], decoder: 'own', save: false, notes: 'baseline: uncompressed, PackBits, LZW, Deflate; strips and tiles; 1–16 bits; multipage; BigTIFF' },
  { id: 'svg', label: 'SVG', mime: 'image/svg+xml', extensions: ['svg', 'svgz'], decoder: 'platform', save: false, notes: 'rendered by the platform with scripts disabled' },
  { id: 'tga', label: 'Truevision TGA', mime: 'image/x-tga', extensions: ['tga', 'tpic', 'icb', 'vda', 'vst'], decoder: 'own', save: true, notes: 'color-mapped, true color and grayscale; RLE; TGA 2.0 extension area' },
  { id: 'pnm', label: 'Netpbm', mime: 'image/x-portable-anymap', extensions: ['pnm', 'ppm', 'pgm', 'pbm', 'pam', 'pfm'], decoder: 'own', save: true, notes: 'PBM, PGM, PPM (plain and raw), PAM, PFM; 16-bit; several pictures per file as pages' },
  { id: 'qoi', label: 'QOI', mime: 'image/qoi', extensions: ['qoi'], decoder: 'own', save: true },
  { id: 'pcx', label: 'ZSoft PCX', mime: 'image/x-pcx', extensions: ['pcx', 'dcx'], decoder: 'own', save: false, notes: '1–24 bits, EGA and VGA palettes; DCX multipage' },
  { id: 'xpm', label: 'X PixMap', mime: 'image/x-xpixmap', extensions: ['xpm'], decoder: 'own', save: false, notes: 'XPM 2 and 3; X11 color names' },
  { id: 'xbm', label: 'X BitMap', mime: 'image/x-xbitmap', extensions: ['xbm'], decoder: 'own', save: false },
  { id: 'wbmp', label: 'Wireless Bitmap', mime: 'image/vnd.wap.wbmp', extensions: ['wbmp'], decoder: 'own', save: true, notes: 'type 0, 1 bit' },
  { id: 'psd', label: 'Photoshop', mime: 'image/vnd.adobe.photoshop', extensions: ['psd', 'psb'], decoder: 'own', save: false, notes: 'the merged composite; bitmap, grayscale, indexed, RGB, CMYK, Lab; 8/16/32 bits; layer names listed' },
  { id: 'icns', label: 'Apple Icon', mime: 'image/icns', extensions: ['icns'], decoder: 'platform+own', save: false, notes: 'every size as a page; PNG elements by the platform, classic packed and 1-bit elements by the app' },
  { id: 'dds', label: 'DirectDraw Surface', mime: 'image/vnd-ms.dds', extensions: ['dds'], decoder: 'own', save: false, notes: 'uncompressed and BC1–BC5 (DXT1/3/5); cube faces as pages' },
  { id: 'emf', label: 'Enhanced Metafile', mime: 'image/emf', extensions: ['emf', 'emz'], decoder: 'own', save: false, notes: 'drawn by a GDI interpreter of the app\'s own at 96 dpi; EMF+ records are skipped' },
  { id: 'wmf', label: 'Windows Metafile', mime: 'image/wmf', extensions: ['wmf', 'wmz'], decoder: 'own', save: false, notes: 'drawn by a GDI interpreter of the app\'s own at 96 dpi' },
  { id: 'jp2', label: 'JPEG 2000', mime: 'image/jp2', extensions: ['jp2', 'jpx', 'jpf', 'jph', 'j2k', 'j2c', 'jpc', 'jhc'], decoder: 'own', save: false, notes: 'JP2/JPX files and codestreams, HTJ2K too, decoded by OpenJPEG (WebAssembly); shown at 8 bits; very large pictures at a reduced resolution level' },
  { id: 'iff', label: 'Amiga IFF (ILBM/PBM)', mime: 'image/x-ilbm', extensions: ['iff', 'ilbm', 'lbm', 'ham', 'ham8'], decoder: 'own', save: false, notes: 'Deluxe Paint and Amiga pictures: 1–8 bitplanes, Extra Half-Brite, HAM6/HAM8, 24/32-bit, chunky PBM, masks; color cycling as an animation' },
  { id: 'macpaint', label: 'MacPaint', mime: 'image/x-macpaint', extensions: ['mac', 'pntg', 'pnt'], decoder: 'own', save: false, notes: '576 × 720, 1 bit; MacBinary files too' },
  { id: 'pcd', label: 'Kodak Photo CD', mime: 'image/x-photo-cd', extensions: ['pcd'], decoder: 'own', save: false, notes: 'the Base image (768 × 512) with Kodak\'s Photo YCC conversion; 4Base and 16Base not decoded' },
  { id: 'exr', label: 'OpenEXR', mime: 'image/x-exr', extensions: ['exr'], decoder: 'own', save: false, notes: 'scanline, tiled and multi-part; none, RLE, ZIPS, ZIP, PIZ, PXR24, B44, B44A, DWAA, DWAB, ZSTD, HTJ2K (half channels); half, float and uint channels; tone-mapped for display' },
  { id: 'hdr', label: 'Radiance HDR', mime: 'image/vnd.radiance', extensions: ['hdr', 'pic', 'rgbe'], decoder: 'own', save: false, notes: 'RGBE, tone-mapped for display' },
  { id: 'raw', label: 'Camera RAW', mime: 'image/x-raw', extensions: RAW_EXTENSIONS, decoder: 'platform+own', save: false, notes: 'the largest embedded JPEG preview, with the file\'s EXIF; DNG files also develop (Develop RAW); other families need the RAW module' },
  { id: 'pict', label: 'QuickDraw picture (PICT)', mime: 'image/x-pict', extensions: ['pct', 'pict'], decoder: 'own', save: false, notes: 'versions 1 and 2: bitmaps and pixel maps (1–32 bits, every packing), QuickTime JPEG, shapes with patterns, regions, lines and text; drawn at the bitmap\'s resolution' },
  { id: 'sun', label: 'Sun raster', mime: 'image/x-sun-raster', extensions: ['ras', 'sun', 'im1', 'im8', 'im24', 'im32', 'rs'], decoder: 'own', save: false, notes: '1, 8, 24 and 32 bits; standard, RLE and RGB types; color maps' },
  { id: 'sgi', label: 'SGI image', mime: 'image/sgi', extensions: ['sgi', 'rgb', 'rgba', 'bw', 'int', 'inta'], decoder: 'own', save: false, notes: 'verbatim and RLE; 8 and 16 bits; gray, RGB, with alpha' },
  { id: 'utahrle', label: 'Utah RLE', mime: 'image/x-utah-rle', extensions: ['urt'], decoder: 'own', save: false, notes: 'Utah Raster Toolkit (.rle files are recognized by content): channels, alpha, color maps' },
  { id: 'atarist', label: 'Atari ST picture', mime: 'image/x-atari-st', extensions: ['pi1', 'pi2', 'pi3', 'pc1', 'pc2', 'pc3', 'neo', 'spu'], decoder: 'own', save: false, notes: 'Degas and Degas Elite (all three resolutions), NEOchrome, Spectrum 512' },
  { id: 'c64', label: 'Commodore 64 picture', mime: 'image/x-c64', extensions: ['koa', 'kla', 'art', 'aas', 'dd', 'ddl'], decoder: 'own', save: false, notes: 'Koala Painter (multicolor), Art Studio and Doodle (hires), in the Pepto palette' },
  { id: 'gem', label: 'GEM IMG', mime: 'image/x-gem', extensions: ['img', 'ximg'], decoder: 'own', save: false, notes: '1–8 planes, XIMG palettes' },
  { id: 'msp', label: 'Microsoft Paint', mime: 'image/x-msp', extensions: ['msp'], decoder: 'own', save: false, notes: 'Paint for Windows 1.x and 2.x' },
  { id: 'fpx', label: 'FlashPix', mime: 'image/vnd.fpx', extensions: ['fpx'], decoder: 'own', save: false, notes: 'the full resolution: uncompressed, single-color and JPEG tiles; monochrome, NIF RGB, Photo YCC, opacity' },
  { id: 'winres', label: 'Icons in a Windows program or icon library', mime: 'application/x-msdownload', extensions: ['icl', 'exe', 'dll', 'ocx', 'cpl', 'scr', 'mun'], decoder: 'own', save: false, notes: 'the icons and cursors inside 32/64-bit and 16-bit (NE) programs, DLLs and .icl libraries, one page each (its largest size)' },
  { id: 'corel', label: 'CorelDRAW / Corel PHOTO-PAINT', mime: 'application/vnd.corel-draw', extensions: ['cdr', 'cpt'], decoder: 'own', save: false, sample: true, notes: 'recognized, not opened yet: no file was available to build the reader from (Help ▸ Send a Sample File)' },
  { id: 'psp', label: 'Paint Shop Pro', mime: 'image/x-paintshoppro', extensions: ['psp', 'pspimage', 'tub'], decoder: 'own', save: false, notes: 'Paint Shop Pro 5 to 9 and later (format versions 3–6+): the raster layers merged with their masks, opacity and blend modes' },
  { id: 'dicom', label: 'DICOM', mime: 'application/dicom', extensions: ['dcm', 'dicom'], decoder: 'own', save: false, notes: 'medical pictures: every frame as a page, window/level, rescale, palettes; implicit/explicit VR, big endian, deflated, RLE, JPEG (baseline, 12-bit extended, lossless), JPEG 2000 and HTJ2K pixel data; for viewing only, not diagnosis' },
  { id: 'fits', label: 'FITS', mime: 'image/fits', extensions: ['fits', 'fit', 'fts'], decoder: 'own', save: false, notes: 'astronomy: the primary array and image extensions as pages, data cubes, BZERO/BSCALE, BLANK; stretched between the 0.5th and 99.5th percentiles for display; gzipped files too' },
  { id: 'jbig', label: 'JBIG', mime: 'image/jbig', extensions: ['jbg', 'jbig', 'bie'], decoder: 'own', save: false, notes: 'T.82 bilevel and bit-plane pictures (the lowest layer of multi-layer files)' },
  { id: 'jbig2', label: 'JBIG2', mime: 'image/x-jbig2', extensions: ['jb2', 'jbig2'], decoder: 'own', save: false, notes: 'T.88 files, every page, through pdf.js (PDFium\'s JBIG2 decoder, WebAssembly)' },
  { id: 'clp', label: 'Windows clipboard file', mime: 'application/x-ms-clipboard', extensions: ['clp'], decoder: 'own', save: false, notes: 'Windows 3.x and NT: the bitmap (DIB or device-dependent) or metafile it holds' },
  { id: 'video', label: 'Video', mime: 'video/mp4', extensions: ['mp4', 'm4v', 'mov', 'qt', '3gp', '3g2', 'webm', 'mkv', 'ogv', 'avi'], decoder: 'platform', save: false, notes: 'video files met while browsing: the first frame as the picture, the file in the Media Player (which codecs play depends on the platform); duration, size, codecs and tags read by the app' },
  { id: 'audio', label: 'Audio', mime: 'audio/mpeg', extensions: ['mp3', 'mp2', 'm4a', 'm4b', 'aac', 'flac', 'wav', 'wave', 'ogg', 'oga', 'opus', 'spx', 'aif', 'aiff', 'aifc', 'mka', 'weba'], decoder: 'platform', save: false, notes: 'audio files met while browsing: the cover art as the picture, the file in the Media Player; duration, codec, sample rate, channels and tags read by the app' },
  { id: 'flic', label: 'Autodesk FLI/FLC', mime: 'video/x-flic', extensions: ['fli', 'flc', 'flx'], decoder: 'own', save: false, notes: 'Animator and Animator Pro animations: every frame with its time, palette changes' },
  { id: 'djvu', label: 'DjVu', mime: 'image/vnd.djvu', extensions: ['djvu', 'djv'], decoder: 'own', save: false, notes: 'single and bundled multipage documents with their text layer, rendered by djvu-rs (WebAssembly; Options: PDF and DjVu pages)' },
  { id: 'pdf', label: 'PDF', mime: 'application/pdf', extensions: ['pdf', 'ai'], decoder: 'own', save: false, notes: 'pages rendered by pdf.js (Options: PDF pages); Illustrator files saved PDF-compatible too' },
  { id: 'eps', label: 'Encapsulated PostScript', mime: 'application/postscript', extensions: ['eps', 'epsf', 'ps', 'ai'], decoder: 'own', save: false, notes: 'the embedded preview only (DOS EPS TIFF preview or %%BeginPreview bitmap); PostScript is not interpreted' },
  { id: 'zip', label: 'ZIP archive / comic book', mime: 'application/zip', extensions: ['zip', 'cbz', 'epub'], decoder: 'own', save: false, notes: 'opened as a folder of the pictures inside (stored and deflate entries)' },
];

export function formatById(id: string): FormatInfo | undefined { return FORMATS.find((f) => f.id === id); }
export function formatFromName(name: string): FormatInfo | undefined { const ext = (name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase(); return FORMATS.find((f) => f.extensions.includes(ext)); }

export const OPEN_ACCEPT = 'image/*,' + FORMATS.flatMap((f) => f.extensions).map((e) => '.' + e).join(',');
export const OPEN_MIMES = ['image/*', ...new Set(FORMATS.map((f) => f.mime)), 'application/octet-stream'];

const at = (u8: Uint8Array, o: number, s: string) => { for (let i = 0; i < s.length; i++) if (u8[o + i] !== s.charCodeAt(i)) return false; return true; };

/** The format of `u8` from its first bytes (the name only settles formats without a magic number), or null. */
export function sniff(u8: Uint8Array, name = ''): FormatInfo | null {
  if (u8.length < 4) return null;
  if (isPsd(u8)) return formatById('psd')!;
  if (isQoi(u8)) return formatById('qoi')!;
  if (isIcns(u8)) return formatById('icns')!;
  if (isDds(u8)) return formatById('dds')!;
  if (isExr(u8)) return formatById('exr')!;
  if (isJp2(u8) || isJ2k(u8)) return formatById('jp2')!;
  if (isDjvu(u8)) return formatById('djvu')!;
  if (isIff(u8)) return formatById('iff')!;
  if (isPcd(u8)) return formatById('pcd')!;
  if (isMacBinaryPaint(u8)) return formatById('macpaint')!;
  if (isFlic(u8)) return formatById('flic')!;
  if (isClp(u8)) return formatById('clp')!;
  if (isJbig2(u8)) return formatById('jbig2')!;
  if (isPsp(u8)) return formatById('psp')!;
  if (isDicom(u8)) return formatById('dicom')!;
  { const m = sniffMedia(u8, name); if (m) return formatById(m.kind)!; }
  if (isFits(u8)) return formatById('fits')!;
  if (isCorel(u8)) return formatById('corel')!;
  if (winModuleKind(u8)) return formatById('winres')!;
  if (isCfb(u8) && isFlashPix(u8)) return formatById('fpx')!;
  if (isSunRaster(u8)) return formatById('sun')!;
  if (isSgi(u8)) return formatById('sgi')!;
  if (isUtahRle(u8)) return formatById('utahrle')!;
  if (isMsp(u8)) return formatById('msp')!;
  if (isPict(u8, '')) return formatById('pict')!; // a version 2 picture behind its 512-byte header
  if (isEmf(u8)) return formatById('emf')!;
  if (isWmf(u8)) return formatById('wmf')!;
  if (isHdr(u8)) return formatById('hdr')!;
  if (isPnm(u8)) return formatById('pnm')!;
  if (isDcx(u8)) return formatById('pcx')!;
  if (isZip(u8)) return formatById('zip')!;
  if (isPdf(u8)) return formatById('pdf')!;
  if (isEps(u8)) return formatById('eps')!;
  if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return formatById('jpeg')!;
  if (at(u8, 0, '\x89PNG\r\n\x1a\n')) { return pngInfo(u8).animated ? formatById('apng')! : formatById('png')!; }
  if (isGif(u8)) return formatById('gif')!;
  if (at(u8, 0, 'RIFF') && at(u8, 8, 'WEBP')) return formatById('webp')!;
  if (u8.length >= 12 && at(u8, 4, 'ftyp')) {
    const brand = String.fromCharCode(...u8.subarray(8, 12));
    const compat = String.fromCharCode(...u8.subarray(16, Math.min(u8.length, 64)));
    if (/avi[fs]/.test(brand) || /avi[fs]/.test(compat)) return formatById('avif')!;
    if (/hei[cfxms]|mif1|msf1/.test(brand) || /heic|mif1/.test(compat)) return formatById('heic')!;
  }
  if ((u8[0] === 0xff && u8[1] === 0x0a) || at(u8, 0, '\0\0\0\x0cJXL ')) return formatById('jxl')!;
  if (isBmp(u8)) return formatById('bmp')!;
  if (isIco(u8)) return (u8[2] | (u8[3] << 8)) === 2 ? formatById('cur')! : formatById('ico')!;
  if (isTiff(u8)) return identifyRaw(u8, name) ? formatById('raw')! : formatById('tiff')!;
  if (identifyRaw(u8, name)) return formatById('raw')!;
  if (u8[0] === 0x1f && u8[1] === 0x8b) return /\.emz$/i.test(name) ? formatById('emf')! : /\.wmz$/i.test(name) ? formatById('wmf')! : /\.(fits?|fts)\.gz$/i.test(name) ? formatById('fits')! : formatById('svg')!; // gzip: emz, wmz, fits.gz or svgz
  if (isPcx(u8)) return formatById('pcx')!;
  const head = new TextDecoder('utf-8', { fatal: false }).decode(u8.subarray(0, Math.min(u8.length, 2048)));
  if (/<svg[\s>]/i.test(head) && !/<script/i.test(head.slice(0, 200))) return formatById('svg')!;
  if (isXpm(u8)) return formatById('xpm')!;
  if (isXbm(u8)) return formatById('xbm')!;
  // Formats without a magic number come last: a plausible header, or the name.
  if (/\.(jbg|jbig|bie)$/i.test(name) && isJbig(u8)) return formatById('jbig')!; // no magic number
  if (/\.(dcm|dicom)$/i.test(name) && isRawDicom(u8)) return formatById('dicom')!; // a data set without the Part 10 header
  if (isAtariSt(u8, name)) return formatById('atarist')!;
  if (isC64(u8, name)) return formatById('c64')!;
  if (isGemImg(u8, name)) return formatById('gem')!;
  if (isPict(u8, name)) return formatById('pict')!;
  if (isTga(u8, name)) return formatById('tga')!;
  if (isWbmp(u8, name)) return formatById('wbmp')!;
  if (/\.(mac|pntg|pnt)$/i.test(name) && u8.length >= 512 + 720 && u8[0] === 0 && u8[1] === 0 && u8[2] === 0 && u8[3] <= 3) return formatById('macpaint')!; // no magic number
  return null;
}

/** Decoding options the app sets from its preferences. */
export const decodeOptions = {
  /** Turn pictures upright by their EXIF Orientation tag when decoding (Options ▸ Auto-rotate by EXIF orientation). */
  autoRotate: true,
  /** Draw the overlay planes of DICOM files (View ▸ DICOM Overlay Planes). */
  dicomOverlays: true,
  /** RAW files open as their embedded preview; when off, DNG files are developed (Use Embedded Preview by Default). */
  rawPreferPreview: true,
  /** Per-file display settings the tools set (Window / Level, FITS Stretch), by entry; the file is decoded again when they change. */
  perEntry: new WeakMap<Entry, { dicomWindow?: import('./dicom').DicomWindow | 'full'; fitsStretch?: import('./fits').FitsStretch }>(),
  /** Asks for a document's password (set by the app's interface); null: the user gave up. */
  askPassword: null as null | ((name: string, wrong: boolean) => Promise<string | null>),
  /** The other entries of the folder an entry was opened from (set by the app), for files that refer to their neighbours (DICOM presentation states). */
  siblings: null as null | ((entry: Entry) => Entry[]),
};

/** Decodes bytes into a Picture. Throws with a readable message when nothing can be shown. */
export async function decodePicture(u8: Uint8Array, entry: Entry): Promise<Picture> {
  const fmt = sniff(u8, entry.name) || formatFromName(entry.name);
  if (fmt?.sample) throw Object.assign(new Error(`${fmt.label} files are recognized but not opened yet: no file was available to build the reader from. If you have one you may share, Help ▸ Send a Sample File sends it to the developer`), { sample: fmt.id });
  if (!fmt) throw new Error('Not a picture format Anne\'s Lens can open');
  const exif = safe(() => readExif(u8));
  let decoded: { pages: Page[]; info: Record<string, string>; warnings: string[]; decoder: string };
  let media: import('./media').MediaInfo | null = null;
  if (fmt.id === 'video' || fmt.id === 'audio') { const r = await (await import('./mediaPoster')).decodeMediaPicture(u8, entry.name); decoded = r; media = r.media; }
  else if (fmt.id === 'gif') decoded = fromOwn(decodeGif(u8), 'gif');
  else if (fmt.id === 'tiff') decoded = fromOwn(await decodeTiff(u8), 'tiff');
  else if (fmt.id === 'ico' || fmt.id === 'cur') decoded = await decodeIcoFile(u8);
  else if (fmt.id === 'tga') decoded = fromOwn(decodeTga(u8), 'tga');
  else if (fmt.id === 'pnm') decoded = fromOwn(decodePnm(u8), 'pnm');
  else if (fmt.id === 'qoi') decoded = fromOwn(decodeQoi(u8), 'qoi');
  else if (fmt.id === 'pcx') decoded = fromOwn(decodePcx(u8), 'pcx');
  else if (fmt.id === 'xpm') decoded = fromOwn(decodeXpm(u8), 'xpm');
  else if (fmt.id === 'xbm') decoded = fromOwn(decodeXbm(u8), 'xbm');
  else if (fmt.id === 'wbmp') decoded = fromOwn(decodeWbmp(u8), 'wbmp');
  else if (fmt.id === 'psd') decoded = fromOwn(decodePsd(u8), 'psd');
  else if (fmt.id === 'dds') decoded = fromOwn(decodeDds(u8), 'dds');
  else if (fmt.id === 'exr') {
    if (exrNeedsHtj2k(u8)) await (await import('./openjph')).loadOpenJph();
    decoded = fromOwn(decodeExr(u8), 'exr');
  }
  else if (fmt.id === 'iff') decoded = fromOwn(decodeIff(u8), 'iff');
  else if (fmt.id === 'macpaint') decoded = fromOwn(decodeMacPaint(u8), 'macpaint');
  else if (fmt.id === 'pcd') decoded = fromOwn(decodePcd(u8), 'pcd');
  else if (fmt.id === 'sun') decoded = fromOwn(decodeSun(u8), 'sun');
  else if (fmt.id === 'flic') decoded = fromOwn(decodeFlic(u8), 'flic');
  else if (fmt.id === 'winres') {
    const { iconGroups } = await import('./winres');
    const groups = iconGroups(u8);
    if (!groups.length) throw new Error('This program or library holds no icons or cursors');
    const pages: Page[] = [], warnings: string[] = [];
    for (const [i, g] of groups.entries()) {
      try {
        const r = await decodeIcoFile(g.file);
        const best = r.pages.reduce((a, b) => (b.width * b.height > a.width * a.height || (b.width === a.width && b.bitDepth > a.bitDepth) ? b : a));
        best.notes = [`${g.kind === 'cursor' ? 'Cursor' : 'Icon'} ${g.id} (${i + 1} of ${groups.length}), shown at its largest size`, `sizes: ${g.sizes.join(', ')}`];
        pages.push(best);
      } catch (e: any) { warnings.push(`${g.kind === 'cursor' ? 'Cursor' : 'Icon'} ${g.id} could not be read (${e?.message || e})`); }
    }
    if (!pages.length) throw new Error(`The icons in this file could not be read (${warnings.join('; ')})`);
    const icons = groups.filter((g) => g.kind === 'icon').length;
    decoded = { pages, info: { icons: String(icons), cursors: String(groups.length - icons) }, warnings, decoder: 'windows resources' };
  }
  else if (fmt.id === 'psp') { const { decodePsp } = await import('./psp'); decoded = fromOwn(decodePsp(u8), 'psp'); }
  else if (fmt.id === 'jbig') { const { decodeJbig } = await import('./jbig'); decoded = fromOwn(decodeJbig(u8), 'jbig'); }
  else if (fmt.id === 'dicom') {
    const [{ decodeDicom, dicomTransferSyntax, isJ2kTransferSyntax, isPresentationState, readPresentationState, dicomSopInstanceUid }, { imageDecoders }] = await Promise.all([import('./dicom'), import('./jpx')]);
    const dec = await imageDecoders().catch(() => null);
    let bytes = u8, presentation;
    if (isPresentationState(u8)) { // display instructions for a picture in another file of the same folder
      presentation = readPresentationState(u8, entry.name);
      const sibs = (decodeOptions.siblings?.(entry) || []).filter((s) => s !== entry && s.name !== entry.name && (/\.(dcm|dicom)$/i.test(s.name) || !/\./.test(s.name)) && (s.size ?? 0) <= 512e6).slice(0, 500);
      let found: Uint8Array | null = null;
      for (const s of sibs) { const b = new Uint8Array(await s.read()); if (presentation.references.includes(dicomSopInstanceUid(b))) { found = b; presentation.name = s.name === entry.name ? entry.name : `${entry.name} on ${s.name}`; break; } }
      if (!found) throw new Error(`${entry.name} is a presentation state${presentation.label ? ` (${presentation.label})` : ''}: display settings for a picture in another DICOM file, which is not in this folder (${presentation.references.length ? `SOP instance ${presentation.references[0]}` : 'no image is referenced'}). Open it from the folder that holds the picture.`);
      bytes = found;
    }
    let fallback = '';
    if (isJ2kTransferSyntax(dicomTransferSyntax(bytes))) { try { await (await import('./openjpeg16')).loadOpenJpeg(); } catch (e) { fallback = (e as Error).message; } }
    decoded = fromOwn(await decodeDicom(bytes, dec, { presentation, drawText: presentation ? textRasterizer() : undefined, overlays: decodeOptions.dicomOverlays, window: decodeOptions.perEntry.get(entry)?.dicomWindow }), 'dicom');
    if (fallback) decoded.warnings.push(fallback);
  }
  else if (fmt.id === 'fits') { const { decodeFits } = await import('./fits'); decoded = fromOwn(decodeFits(u8, entry.name, decodeOptions.perEntry.get(entry)?.fitsStretch), 'fits'); }
  else if (fmt.id === 'jbig2') {
    const [{ decodeJbig2 }, { imageDecoders }] = await Promise.all([import('./jbig'), import('./jpx')]);
    decoded = fromOwn(await decodeJbig2(u8, await imageDecoders()), 'jbig2 (pdf.js)');
  }
  else if (fmt.id === 'clp') {
    const { clpPicture, decodeDdb } = await import('./clipboard');
    const c = clpPicture(u8), formats = c.entries.map((e) => e.name).join(', ');
    if (!c.picture) throw new Error(`This clipboard file holds no picture (it has: ${formats})`);
    const from = `from its ${c.picture.entry.name} (${c.nt ? 'Windows NT' : 'Windows 3.x'} clipboard file)`;
    if (c.picture.kind === 'bmp') decoded = fromOwn(decodeBmp(c.picture.bytes), 'clipboard');
    else if (c.picture.kind === 'ddb') decoded = fromOwn(decodeDdb(c.picture.entry.data, c.nt), 'clipboard');
    else {
      const mf = await import('./metafile');
      const r = c.picture.kind === 'emf' ? await mf.renderEmf(c.picture.bytes) : await mf.renderWmf(c.picture.bytes), cv = r.canvas;
      decoded = { pages: [{ width: cv.width, height: cv.height, frames: [{ image: cv, width: cv.width, height: cv.height, delay: 0 }], loops: 0, bitDepth: 32, hasAlpha: true, dpi: [96, 96], notes: r.notes }], info: {}, warnings: r.warnings, decoder: 'clipboard (metafile)' };
    }
    decoded.pages[0].notes.unshift(`Clipboard picture ${from}`);
    decoded.info = { ...decoded.info, 'clipboard formats': formats };
  }
  else if (fmt.id === 'fpx') {
    const [{ decodeFlashPix }, { imageDecoders }] = await Promise.all([import('./flashpix'), import('./jpx')]);
    decoded = fromOwn(decodeFlashPix(u8, await imageDecoders()), 'flashpix');
  }
  else if (fmt.id === 'sgi') decoded = fromOwn(decodeSgi(u8), 'sgi');
  else if (fmt.id === 'utahrle') decoded = fromOwn(decodeUtahRle(u8), 'utah rle');
  else if (fmt.id === 'atarist') decoded = fromOwn(decodeAtariSt(u8, entry.name), 'atari st');
  else if (fmt.id === 'c64') decoded = fromOwn(decodeC64(u8, entry.name), 'c64');
  else if (fmt.id === 'gem') decoded = fromOwn(decodeGemImg(u8), 'gem img');
  else if (fmt.id === 'msp') decoded = fromOwn(decodeMsp(u8), 'msp');
  else if (fmt.id === 'pict') {
    const { decodePict } = await import('./pict');
    const r = decodePict(u8);
    decoded = fromOwn(r, 'pict');
    if (r.texts.length || r.jpegs.length) await drawPictExtras(decoded.pages[0], r, decoded.warnings);
  }
  else if (fmt.id === 'jp2') { const { decodeJpx } = await import('./jpx'); decoded = fromOwn(await decodeJpx(u8), 'openjpeg'); }
  else if (fmt.id === 'emf' || fmt.id === 'wmf') {
    const mf = await import('./metafile');
    if (u8[0] === 0x1f && u8[1] === 0x8b) { const ds = new DecompressionStream('gzip'); const w = ds.writable.getWriter(); void w.write(u8.slice()).catch(() => undefined); void w.close().catch(() => undefined); u8 = new Uint8Array(await new Response(ds.readable).arrayBuffer()); } // .emz / .wmz
    const r = fmt.id === 'emf' ? await mf.renderEmf(u8) : await mf.renderWmf(u8);
    const c = r.canvas;
    decoded = { pages: [{ width: c.width, height: c.height, frames: [{ image: c, width: c.width, height: c.height, delay: 0 }], loops: 0, bitDepth: 32, hasAlpha: true, dpi: [96, 96], notes: r.notes }], info: {}, warnings: r.warnings, decoder: 'metafile' };
  }
  else if (fmt.id === 'hdr') decoded = fromOwn(decodeHdr(u8), 'hdr');
  else if (fmt.id === 'icns') decoded = await decodeIcnsFile(u8);
  else if (fmt.id === 'raw') decoded = await decodeRawPreview(u8, entry.name);
  else if (fmt.id === 'pdf') {
    const { decodePdf, pdfOptions } = await import('./pdf');
    let password: string | undefined, r;
    for (let attempt = 0; ; attempt++) {
      try { r = await decodePdf(u8, pdfOptions, password); break; }
      catch (e: any) {
        if (!e?.password || !decodeOptions.askPassword || attempt >= 5) throw e;
        const p = await decodeOptions.askPassword(entry.name, e.password === 'wrong'); if (p === null) throw e;
        password = p;
      }
    }
    decoded = { ...r, decoder: 'pdf.js' };
  }
  else if (fmt.id === 'djvu') { const { decodeDjvu, djvuOptions } = await import('./djvu'); decoded = fromOwn(await decodeDjvu(u8, djvuOptions), 'djvu-rs'); }
  else if (fmt.id === 'eps') decoded = await decodeEpsFile(u8);
  else if (fmt.id === 'zip') throw new Error('This is an archive: open it to browse the pictures inside (File ▸ Open)');
  else if (fmt.id === 'bmp') {
    try { decoded = await fromPlatform(u8, fmt, null); } catch { decoded = fromOwn(decodeBmp(u8), 'bmp'); }
  } else {
    const info: ContainerInfo | null = fmt.id === 'jpeg' ? safe(() => jpegInfo(u8)) : fmt.id === 'png' || fmt.id === 'apng' ? safe(() => pngInfo(u8)) : fmt.id === 'webp' ? safe(() => webpInfo(u8)) : null;
    try { decoded = await fromPlatform(u8, fmt, info); }
    catch (e: any) {
      // The platform refused (damaged file): the app's tolerant readers show what can be read.
      if (fmt.id === 'png' || fmt.id === 'apng') { const r = decodePngTolerant(u8); decoded = fromOwn(r, 'png (tolerant)'); decoded.warnings.unshift(`The platform could not decode the file (${e?.message || e}); shown by the app's tolerant reader`); }
      else if (fmt.id === 'jpeg') {
        const rep = repairJpeg(u8);
        const r = await fromPlatform(rep.bytes, fmt, info);
        decoded = { ...r, decoder: 'jpeg (repaired)', warnings: [`The platform could not decode the file (${e?.message || e}); rebuilt from its coefficients: ${rep.decodedUnits} of ${rep.totalUnits} blocks present`, ...rep.warnings, ...r.warnings] };
      } else if (fmt.id === 'jxl' || fmt.id === 'avif') {
        // The platform does not decode it (JPEG XL in Chromium, AVIF on older systems): the app's own decoders.
        const m = await import('./modern');
        decoded = fromOwn(fmt.id === 'jxl' ? await m.decodeJxl(u8) : await m.decodeAvif(u8), fmt.id === 'jxl' ? 'jxl-oxide' : 'libavif');
      } else throw e;
    }
  }
  if (fmt.id === 'tiff' || fmt.id === 'jp2') { const own = await keepEmbedded(u8, fmt.id); if (own) for (const pg of decoded.pages) { pg.icc = own.icc; pg.notes.push(`color profile: ${own.profile.description || 'embedded'}`); } }
  const pic = new Picture(entry, u8, fmt, decoded.pages, exif, decoded.info, decoded.warnings, decoded.decoder);
  if (media) pic.media = { kind: media.kind, mime: media.mime, duration: media.duration, title: media.tags.title };
  if (exif?.dpi) for (const p of pic.pages) if (!p.dpi) p.dpi = exif.dpi;
  // EXIF orientation: the platform decodes with imageOrientation 'none', so the pixels are as stored.
  if (fmt.id === 'jpeg' || fmt.id === 'png' || fmt.id === 'webp') { try { const { findManifestStore, readManifest, describeManifest } = await import('../meta/c2pa'); if (findManifestStore(u8)) { const m = await readManifest(u8); if (m) decoded.info['Content Credentials'] = describeManifest(m); } } catch (e) { decoded.info['Content Credentials'] = `present but unreadable (${(e as Error).message})`; } }
  const ops = decodeOptions.autoRotate && fmt.id !== 'tiff' && fmt.id !== 'raw' ? orientationOps(pic.orientation) : [];
  if (ops.length && typeof document !== 'undefined') { pic.pages = pic.pages.map((pg) => ops.reduce((acc, op) => transformPage(acc, op), pg)); pic.orientationApplied = true; }
  return pic;
}

/** CorelDRAW (a RIFF file whose form is CDR plus a version letter, or cdr for the newer ones) and Corel PHOTO-PAINT (CPT<version>FILE). */
export const isCorel = (u8: Uint8Array): boolean => (u8.length >= 12 && at(u8, 0, 'RIFF') && /^(CDR|cdr)/.test(String.fromCharCode(u8[8], u8[9], u8[10]))) || (u8.length >= 8 && /^CPT[0-9A-Z]FILE$/.test(String.fromCharCode(...u8.subarray(0, 8))));

function safe<T>(fn: () => T): T | null { try { return fn(); } catch { return null; } }

function rasterToFrame(r: Raster, delay: number): Frame {
  const c = document.createElement('canvas');
  c.width = r.width; c.height = r.height;
  c.getContext('2d')!.putImageData(new ImageData(r.data, r.width, r.height), 0, 0);
  return { image: c, width: r.width, height: r.height, delay };
}

/** What a PICT leaves to the platform: QuickTime JPEG pictures and text, drawn onto the decoded page. */
async function drawPictExtras(page: Page, r: import('./pict').PictResult, warnings: string[]): Promise<void> {
  const c = page.frames[0].image as HTMLCanvasElement, ctx = c.getContext('2d');
  if (!ctx) return;
  for (const j of r.jpegs) {
    try { const bmp = await createImageBitmap(new Blob([j.bytes as BlobPart], { type: 'image/jpeg' })); ctx.drawImage(bmp, j.x, j.y, j.w, j.h); bmp.close(); }
    catch (e: any) { warnings.push(`A QuickTime JPEG picture could not be decoded (${e?.message || e})`); }
  }
  for (const t of r.texts) {
    ctx.font = `${t.face & 2 ? 'italic ' : ''}${t.face & 1 ? 'bold ' : ''}${Math.max(1, t.size)}px ${t.font}`;
    ctx.fillStyle = `rgb(${t.color.join(',')})`; ctx.textBaseline = 'alphabetic';
    ctx.fillText(t.text, t.x, t.y);
    if (t.face & 4) { const w = ctx.measureText(t.text).width; ctx.fillRect(t.x, t.y + Math.max(1, t.size / 12), w, Math.max(1, t.size / 14)); }
  }
}

function pageFromDecoded(d: DecodedPage): Page {
  return { width: d.width, height: d.height, frames: d.frames.map((f) => rasterToFrame(f.raster, f.delay)), loops: d.loops, bitDepth: d.bitDepth, paletteSize: d.paletteSize, hasAlpha: d.hasAlpha, dpi: d.dpi, notes: d.notes, ...(d.textLayer ? { textLayer: d.textLayer } : {}), ...(d.world ? { world: d.world } : {}) };
}

function fromOwn(r: { pages: DecodedPage[]; info: Record<string, string>; warnings: string[] }, decoder: string) {
  return { pages: r.pages.map(pageFromDecoded), info: r.info, warnings: r.warnings, decoder };
}

async function decodeIcoFile(u8: Uint8Array) {
  const { entries, cursor } = readIco(u8);
  const { pages, warnings } = decodeIcoDibs(entries);
  const out: Page[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (pages[i]) { out.push(pageFromDecoded(pages[i]!)); continue; }
    if (!e.png) continue;
    try {
      const bmp = await createImageBitmap(new Blob([e.bytes as BlobPart], { type: 'image/png' }));
      out.push({ width: bmp.width, height: bmp.height, frames: [{ image: bmp, width: bmp.width, height: bmp.height, delay: 0 }], loops: 0, bitDepth: 32, hasAlpha: true, notes: ['PNG inside the icon'] });
    } catch (err: any) { warnings.push(`Icon ${i + 1}: ${err?.message || err}`); }
  }
  if (!out.length) throw new Error(warnings[0] || 'No readable icon');
  return { pages: out, info: { entries: String(entries.length), kind: cursor ? 'cursor' : 'icon' }, warnings, decoder: 'ico' };
}

async function decodeIcnsFile(u8: Uint8Array) {
  const { elements, warnings } = readIcns(u8);
  const classic = decodeIcnsClassic(elements);
  warnings.push(...classic.warnings);
  const out: { page: Page; size: number }[] = classic.pages.map((p) => ({ page: pageFromDecoded(p), size: p.width }));
  for (const e of elements) {
    if (!e.png && !e.jp2) continue;
    try {
      const label = (w: number) => `${e.type}: ${e.png ? 'PNG' : 'JPEG 2000'} element${e.size && e.size !== w ? ` (${e.size} pt, ${Math.round(w / e.size)}×)` : ''}`;
      if (e.jp2) { // the app's JPEG 2000 decoder
        const { decodeJpx } = await import('./jpx');
        const pg = pageFromDecoded((await decodeJpx(e.bytes)).pages[0]); pg.notes = [label(pg.width)];
        out.push({ page: pg, size: pg.width }); continue;
      }
      const bmp = await createImageBitmap(new Blob([e.bytes as BlobPart], { type: 'image/png' }));
      out.push({ page: { width: bmp.width, height: bmp.height, frames: [{ image: bmp, width: bmp.width, height: bmp.height, delay: 0 }], loops: 0, bitDepth: 32, hasAlpha: true, notes: [label(bmp.width)] }, size: bmp.width });
    } catch (err: any) { warnings.push(`${e.type}: ${err?.message || err}`); }
  }
  if (!out.length) throw new Error(warnings[0] || 'No readable icon element');
  out.sort((a, b) => b.size - a.size);
  return { pages: out.map((x) => x.page), info: { elements: elements.map((e) => e.type).join(', ') }, warnings, decoder: 'icns' };
}

async function decodeEpsFile(u8: Uint8Array) {
  const pv = epsPreview(u8);
  if (pv.kind === 'tiff' && pv.bytes) { const r = fromOwn(await decodeTiff(pv.bytes), 'eps preview (tiff)'); r.pages[0].notes.unshift('EPS preview (TIFF)'); return { ...r, info: { ...pv.info, ...r.info }, warnings: [...pv.warnings, ...r.warnings] }; }
  if (pv.kind === 'raster' && pv.raster) return fromOwn(pv.raster, 'eps preview');
  if (pv.kind === 'wmf') throw new Error('This EPS file has only a WMF preview, which Anne\'s Lens cannot render yet (planned with the WMF/EMF reader)');
  throw new Error('This PostScript file has no embedded preview, and PostScript itself is not interpreted (see FORMATS-PLAN.md)');
}

async function decodeRawPreview(u8: Uint8Array, name: string) {
  const id = identifyRaw(u8, name) || { family: 'RAW', make: 'unknown camera' };
  const previews = findEmbeddedJpegs(u8);
  const info: Record<string, string> = { 'RAW family': `${id.family} (${id.make})`, previews: previews.length ? previews.map((p) => `${p.width}×${p.height}`).join(', ') : 'none' };
  const warnings: string[] = [];
  // DNG: developed here when there is no preview or previews are not preferred.
  if ((!previews.length || !decodeOptions.rawPreferPreview) && isDng(u8)) {
    try {
      const { develop } = await import('../raw/develop');
      const d = develop(u8, {});
      const r = fromOwn({ pages: [{ width: d.raster.width, height: d.raster.height, frames: [{ raster: d.raster, delay: 0 }], loops: 0, bitDepth: 24, hasAlpha: false, notes: [`developed from the DNG's raw data (${d.raw.width}×${d.raw.height}, as shot ${d.temp} K); Develop RAW changes the settings`] }], info: { ...info, 'white balance': `${d.temp} K, tint ${d.tint}` }, warnings: [] }, 'dng develop');
      return r;
    } catch (e: any) { if (!previews.length) throw new Error(`DNG: ${e?.message || e}`); warnings.push(`Develop: ${e?.message || e}`); }
  }
  if (!previews.length) {
    const t = await tiffThumbnail(u8); // older TIFF-based RAW files: an uncompressed RGB thumbnail instead of a JPEG
    if (t) { const pg = pageFromDecoded(t.page); pg.notes = [`embedded ${pg.width}×${pg.height} uncompressed thumbnail of a ${id.family} file (no JPEG preview; developing ${id.family} files needs the RAW module)`]; return { pages: [pg], info: { ...info, previews: `${pg.width}×${pg.height} uncompressed thumbnail` }, warnings, decoder: 'raw preview' }; }
    throw new Error(`${id.family} file from ${id.make}: no embedded preview, and developing ${id.family} files needs the RAW module (DNG files develop without it)`);
  }
  for (const pv of previews) {
    try {
      const bytes = u8.subarray(pv.offset, pv.offset + pv.length);
      const r = await fromPlatform(bytes, formatById('jpeg')!, safe(() => jpegInfo(bytes)));
      r.pages[0].notes.unshift(`embedded ${pv.width}×${pv.height} JPEG preview of a ${id.family} file`);
      return { pages: r.pages, info: { ...info, ...r.info }, warnings: [...warnings, ...r.warnings], decoder: 'raw preview' };
    } catch (e: any) { warnings.push(`Preview ${pv.width}×${pv.height}: ${e?.message || e}`); }
  }
  if (isDng(u8) && decodeOptions.rawPreferPreview) {
    // No usable preview: develop the DNG instead.
    try {
      const { develop } = await import('../raw/develop');
      const d = develop(u8, {});
      return fromOwn({ pages: [{ width: d.raster.width, height: d.raster.height, frames: [{ raster: d.raster, delay: 0 }], loops: 0, bitDepth: 24, hasAlpha: false, notes: [`developed from the DNG's raw data (${d.raw.width}×${d.raw.height}, as shot ${d.temp} K); its previews could not be decoded`] }], info, warnings }, 'dng develop');
    } catch (e: any) { warnings.push(`Develop: ${e?.message || e}`); }
  }
  throw new Error(warnings[0] || 'The embedded previews could not be decoded');
}

/** The platform's decoders: ImageDecoder (every frame of an animation) where available, else createImageBitmap. */
async function fromPlatform(u8: Uint8Array, fmt: FormatInfo, info: ContainerInfo | null) {
  const blob = new Blob([u8 as BlobPart], { type: fmt.mime });
  const warnings = [...(info?.warnings || [])];
  const notes = info?.notes || [];
  const meta = { loops: info?.loops ?? 0, bitDepth: info?.bitDepth ?? 24, hasAlpha: info?.hasAlpha ?? false, dpi: info?.dpi, paletteSize: info?.paletteSize };
  const ImageDecoderCtor = (globalThis as any).ImageDecoder;
  if (info?.animated && ImageDecoderCtor) {
    try {
      if (!(await ImageDecoderCtor.isTypeSupported(fmt.mime))) throw new Error('type not supported');
      const dec = new ImageDecoderCtor({ data: u8, type: fmt.mime });
      await dec.tracks.ready;
      const track = dec.tracks.selectedTrack;
      const count = Math.min(track?.frameCount || 1, 2000);
      const frames: Frame[] = [];
      for (let i = 0; i < count; i++) {
        const { image } = await dec.decode({ frameIndex: i, completeFramesOnly: true });
        const bmp = await createImageBitmap(image);
        frames.push({ image: bmp, width: bmp.width, height: bmp.height, delay: image.duration ? Math.max(10, image.duration / 1000) : 100 });
        image.close();
      }
      dec.close();
      if (frames.length) {
        return { pages: [{ width: frames[0].width, height: frames[0].height, frames, ...meta, loops: track?.repetitionCount === Infinity ? 0 : meta.loops, notes: [...notes, `${frames.length} frames`] }], info: info?.info || {}, warnings, decoder: 'platform (ImageDecoder)' };
      }
    } catch (e: any) {
      warnings.push(`Animation frames could not be decoded (${e?.message || e}); showing the first frame`);
    }
  }
  let bmp: ImageBitmap;
  // A tagged JPEG, PNG or WebP in a profile other than sRGB keeps its own pixel values; the viewer color-manages them.
  let own = fmt.id === 'jpeg' || fmt.id === 'png' || fmt.id === 'webp' ? await keepEmbedded(u8, fmt.id) : null;
  try {
    bmp = await createImageBitmap(blob, { imageOrientation: 'none' as any, premultiplyAlpha: 'none' as any, ...(own ? { colorSpaceConversion: 'none' as any } : {}) });
  } catch (e: any) {
    // Some engines reject the options or the format through createImageBitmap but render it in an <img>.
    bmp = await viaImageElement(blob, fmt);
    own = null; // an <img> always converts to sRGB
  }
  const page: Page = { width: bmp.width, height: bmp.height, frames: [{ image: bmp, width: bmp.width, height: bmp.height, delay: 0 }], loops: 0, bitDepth: meta.bitDepth, hasAlpha: meta.hasAlpha, dpi: meta.dpi, paletteSize: meta.paletteSize, notes: [...notes] };
  if (fmt.id === 'svg') page.notes.push('vector, rendered at its intrinsic size');
  if (own) { page.icc = own.icc; page.notes.push(`color profile: ${own.profile.description || 'embedded'}`); }
  return { pages: [page], info: info?.info || {}, warnings, decoder: 'platform' };
}

function viaImageElement(blob: Blob, fmt: FormatInfo): Promise<ImageBitmap> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    img.onload = async () => {
      try { resolve(await createImageBitmap(img)); } catch (e) { reject(e); } finally { URL.revokeObjectURL(url); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`${fmt.label} is not decodable on this platform`)); };
    img.src = url;
  });
}

export type EncodeFormat = 'png' | 'jpeg' | 'webp' | 'bmp' | 'tga' | 'ppm' | 'pgm' | 'pam' | 'qoi' | 'wbmp';
/** The formats Save As writes, with the extension used and the MIME type. */
export const ENCODERS: Record<EncodeFormat, { label: string; ext: string; mime: string; lossy?: boolean; platform?: boolean }> = {
  png: { label: 'PNG (lossless)', ext: 'png', mime: 'image/png', platform: true },
  jpeg: { label: 'JPEG', ext: 'jpg', mime: 'image/jpeg', lossy: true, platform: true },
  webp: { label: 'WebP', ext: 'webp', mime: 'image/webp', lossy: true, platform: true },
  bmp: { label: 'Windows Bitmap (BMP)', ext: 'bmp', mime: 'image/bmp' },
  tga: { label: 'Truevision TGA', ext: 'tga', mime: 'image/x-tga' },
  ppm: { label: 'Netpbm PPM (color)', ext: 'ppm', mime: 'image/x-portable-pixmap' },
  pgm: { label: 'Netpbm PGM (grayscale)', ext: 'pgm', mime: 'image/x-portable-graymap' },
  pam: { label: 'Netpbm PAM (with transparency)', ext: 'pam', mime: 'image/x-portable-anymap' },
  qoi: { label: 'QOI', ext: 'qoi', mime: 'image/qoi' },
  wbmp: { label: 'Wireless Bitmap (WBMP, 1 bit)', ext: 'wbmp', mime: 'image/vnd.wap.wbmp' },
};
/** The encoder that writes the format a picture was read from, when one exists. */
export function encoderFor(formatId: string): EncodeFormat | undefined {
  return ({ png: 'png', jpeg: 'jpeg', webp: 'webp', bmp: 'bmp', tga: 'tga', pnm: 'ppm', qoi: 'qoi', wbmp: 'wbmp' } as Record<string, EncodeFormat>)[formatId];
}

/** Encodes raw RGBA pixels with one of the app's own writers (no DOM needed). */
export async function encodeRaster(r: Raster, format: Exclude<EncodeFormat, 'png' | 'jpeg' | 'webp'>, opts: { rle?: boolean; threshold?: number } = {}): Promise<Uint8Array> {
  switch (format) {
    case 'bmp': return (await import('./bmp')).encodeBmp(r);
    case 'tga': return (await import('./tga')).encodeTga(r, { rle: opts.rle });
    case 'ppm': case 'pgm': case 'pam': return (await import('./pnm')).encodePnm(r, format);
    case 'qoi': return (await import('./qoi')).encodeQoi(r);
    case 'wbmp': return (await import('./wbmp')).encodeWbmp(r, opts.threshold);
  }
}

/** Encodes a canvas to the chosen format through the platform (PNG, JPEG, WebP) or the app's writers. */
export async function encodeCanvas(c: HTMLCanvasElement, format: EncodeFormat, quality = 0.9, opts: { rle?: boolean; threshold?: number } = {}): Promise<Blob> {
  if (format !== 'png' && format !== 'jpeg' && format !== 'webp') {
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    const id = ctx.getImageData(0, 0, c.width, c.height);
    const bytes = await encodeRaster({ width: c.width, height: c.height, data: id.data as Uint8ClampedArray<ArrayBuffer> }, format, opts);
    return new Blob([bytes as BlobPart], { type: ENCODERS[format].mime });
  }
  const mime = format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : 'image/webp';
  let src = c;
  if (format === 'jpeg') { // JPEG has no alpha: flatten onto white.
    src = document.createElement('canvas'); src.width = c.width; src.height = c.height;
    const x = src.getContext('2d')!; x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(c, 0, 0);
  }
  const blob = await new Promise<Blob | null>((res) => src.toBlob(res, mime, quality));
  if (!blob) throw new Error(`Could not encode ${format.toUpperCase()}`);
  if (blob.type !== mime) throw new Error(`${format.toUpperCase()} encoding is not available on this platform`);
  return blob;
}

/** Text as an alpha mask through a canvas (12 px sans-serif), where the platform has one; null elsewhere (tests). */
function textRasterizer(): ((text: string) => { width: number; height: number; alpha: Uint8ClampedArray } | null) | undefined {
  if (typeof OffscreenCanvas === 'undefined' && typeof document === 'undefined') return undefined;
  return (text) => {
    try {
      const font = '12px sans-serif';
      const cv: any = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(8, 8) : Object.assign(document.createElement('canvas'), { width: 8, height: 8 });
      let ctx = cv.getContext('2d'); if (!ctx) return null;
      ctx.font = font;
      const m = ctx.measureText(text), width = Math.ceil(m.width) + 2, height = 16;
      if (width > 4096) return null;
      cv.width = width; cv.height = height; ctx = cv.getContext('2d'); ctx.font = font; ctx.textBaseline = 'top'; ctx.fillStyle = '#fff'; ctx.fillText(text, 1, 1);
      const img = ctx.getImageData(0, 0, width, height).data, alpha = new Uint8ClampedArray(width * height);
      for (let i = 0; i < alpha.length; i++) alpha[i] = img[i * 4 + 3];
      return { width, height, alpha };
    } catch { return null; }
  };
}
