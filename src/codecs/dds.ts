/**
 * DirectDraw Surface (.dds): uncompressed RGB/RGBA/luminance surfaces with bit masks, and the block-
 * compressed BC1 (DXT1), BC2 (DXT3), BC3 (DXT5), BC4 and BC5 formats, including the DX10 header. The
 * first mip level of the first face is shown; cube maps list their faces as pages.
 */
import { makeRaster, type DecodeResult, type DecodedPage, type Raster } from './raster';

export const isDds = (u8: Uint8Array): boolean => u8.length > 128 && u8[0] === 0x44 && u8[1] === 0x44 && u8[2] === 0x53 && u8[3] === 0x20;

const FOURCC = (s: string) => s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24);
type Block = 'bc1' | 'bc2' | 'bc3' | 'bc4' | 'bc5' | null;

export function decodeDds(u8: Uint8Array): DecodeResult {
  if (!isDds(u8)) throw new Error('Not a DDS file');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const h = dv.getUint32(12, true), w = dv.getUint32(16, true);
  const mips = Math.min(32, Math.max(1, dv.getUint32(28, true))); // a picture has at most 32 levels, whatever the header claims
  const pfFlags = dv.getUint32(80, true), fourcc = dv.getUint32(84, true), bpp = dv.getUint32(88, true);
  const masks = [dv.getUint32(92, true), dv.getUint32(96, true), dv.getUint32(100, true), dv.getUint32(104, true)];
  const caps2 = dv.getUint32(112, true);
  if (!w || !h || w * h > 80_000_000) throw new Error('Bad DDS dimensions');
  let p = 128;
  let block: Block = null;
  let note = '';
  let dxgi = 0;
  let uncompressed: { bpp: number; masks: number[]; lum?: boolean } | null = null;
  if (pfFlags & 4) {
    if (fourcc === FOURCC('DX10')) {
      dxgi = dv.getUint32(128, true); p = 148;
      const map: Record<number, [Block, string] | [null, string, number, number[]]> = {
        70: ['bc1', 'BC1'], 71: ['bc1', 'BC1'], 72: ['bc1', 'BC1 sRGB'], 73: ['bc2', 'BC2'], 74: ['bc2', 'BC2'], 75: ['bc2', 'BC2 sRGB'], 76: ['bc3', 'BC3'], 77: ['bc3', 'BC3'], 78: ['bc3', 'BC3 sRGB'], 79: ['bc4', 'BC4'], 80: ['bc4', 'BC4'], 82: ['bc5', 'BC5'], 83: ['bc5', 'BC5'],
        27: [null, 'R8G8B8A8', 32, [0xff, 0xff00, 0xff0000, 0xff000000]], 28: [null, 'R8G8B8A8', 32, [0xff, 0xff00, 0xff0000, 0xff000000]], 29: [null, 'R8G8B8A8 sRGB', 32, [0xff, 0xff00, 0xff0000, 0xff000000]],
        87: [null, 'B8G8R8A8', 32, [0xff0000, 0xff00, 0xff, 0xff000000]], 88: [null, 'B8G8R8X8', 32, [0xff0000, 0xff00, 0xff, 0]], 91: [null, 'B8G8R8A8 sRGB', 32, [0xff0000, 0xff00, 0xff, 0xff000000]],
        85: [null, 'B5G6R5', 16, [0xf800, 0x7e0, 0x1f, 0]], 86: [null, 'B5G5R5A1', 16, [0x7c00, 0x3e0, 0x1f, 0x8000]], 61: [null, 'R8', 8, [0xff, 0, 0, 0]], 49: [null, 'R8G8', 16, [0xff, 0xff00, 0, 0]],
      };
      const m = map[dxgi];
      if (!m) throw new Error(`DXGI format ${dxgi} is not supported`);
      if (m[0]) { block = m[0]; note = m[1]; } else { note = m[1]; uncompressed = { bpp: m[2]!, masks: m[3]!, lum: dxgi === 61 }; }
    } else if (fourcc === FOURCC('DXT1')) { block = 'bc1'; note = 'DXT1'; }
    else if (fourcc === FOURCC('DXT2') || fourcc === FOURCC('DXT3')) { block = 'bc2'; note = 'DXT3'; }
    else if (fourcc === FOURCC('DXT4') || fourcc === FOURCC('DXT5')) { block = 'bc3'; note = 'DXT5'; }
    else if (fourcc === FOURCC('ATI1') || fourcc === FOURCC('BC4U')) { block = 'bc4'; note = 'BC4'; }
    else if (fourcc === FOURCC('ATI2') || fourcc === FOURCC('BC5U')) { block = 'bc5'; note = 'BC5'; }
    else throw new Error(`Compression ${String.fromCharCode(fourcc & 255, (fourcc >> 8) & 255, (fourcc >> 16) & 255, fourcc >>> 24)} is not supported`);
  } else if (pfFlags & 0x40) { uncompressed = { bpp, masks: [masks[0], masks[1], masks[2], pfFlags & 1 ? masks[3] : 0] }; note = `${bpp}-bit RGB${pfFlags & 1 ? 'A' : ''}`; }
  else if (pfFlags & 0x20000) { uncompressed = { bpp, masks: [masks[0], masks[0], masks[0], pfFlags & 1 ? masks[3] : 0], lum: true }; note = `${bpp}-bit luminance`; }
  else if (pfFlags & 2) { uncompressed = { bpp, masks: [0, 0, 0, masks[3]] }; note = `${bpp}-bit alpha only`; }
  else throw new Error('Unknown DDS pixel format');
  const faces = caps2 & 0x200 ? ['+X', '-X', '+Y', '-Y', '+Z', '-Z'].filter((_, i) => caps2 & (0x400 << i)) : [''];
  const warnings: string[] = [];
  const pages: DecodedPage[] = [];
  const levelBytes = (lw: number, lh: number) => (block ? Math.max(1, Math.ceil(lw / 4)) * Math.max(1, Math.ceil(lh / 4)) * (block === 'bc1' || block === 'bc4' ? 8 : 16) : Math.ceil((lw * uncompressed!.bpp) / 8) * lh);
  let faceBytes = 0;
  for (let m = 0, lw = w, lh = h; m < mips; m++, lw = Math.max(1, lw >> 1), lh = Math.max(1, lh >> 1)) faceBytes += levelBytes(lw, lh);
  for (const face of faces) {
    if (p + levelBytes(w, h) > u8.length) { warnings.push(`${face ? `Face ${face}` : 'The picture'} is truncated`); if (p >= u8.length) break; }
    const raster = block ? decodeBlocks(u8, p, w, h, block) : decodeUncompressed(u8, p, w, h, uncompressed!);
    let hasAlpha = false;
    for (let i = 3; i < raster.data.length; i += 4) if (raster.data[i] !== 255) { hasAlpha = true; break; }
    pages.push({ width: w, height: h, frames: [{ raster, delay: 0 }], loops: 0, bitDepth: block ? (block === 'bc1' ? 4 : 8) : uncompressed!.bpp, hasAlpha, notes: [`${note}${face ? `, cube face ${face}` : ''}${mips > 1 ? `, ${mips} mip levels (largest shown)` : ''}`] });
    p += faceBytes;
  }
  if (!pages.length) throw new Error('No picture data');
  const info: Record<string, string> = {};
  if (dxgi) info['DXGI format'] = String(dxgi);
  if (caps2 & 0x200000) info.Volume = `${dv.getUint32(24, true)} slices (first shown)`;
  return { pages, info, warnings };
}

function decodeUncompressed(u8: Uint8Array, p: number, w: number, h: number, f: { bpp: number; masks: number[]; lum?: boolean }): Raster {
  const out = makeRaster(w, h);
  const d = out.data;
  const bytes = f.bpp / 8;
  const stride = Math.ceil((w * f.bpp) / 8);
  const shiftOf = (m: number) => { if (!m) return [0, 0]; let s = 0; while (s < 32 && !((m >>> s) & 1)) s++; let b = 0; while (s + b < 32 && ((m >>> (s + b)) & 1)) b++; return [s, b]; }; // shift counts wrap at 32: a full mask must stop there
  const sh = f.masks.map(shiftOf);
  const to8 = (v: number, bits: number) => (bits >= 8 ? v >>> (bits - 8) : bits ? Math.round((v * 255) / ((1 << bits) - 1)) : 0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = p + y * stride + x * bytes;
    if (i + bytes > u8.length) return out;
    let v = 0;
    for (let k = 0; k < bytes; k++) v |= u8[i + k] << (8 * k);
    v >>>= 0;
    const o = (y * w + x) * 4;
    const r = f.masks[0] ? to8((v & f.masks[0]) >>> sh[0][0], sh[0][1]) : 0;
    d[o] = r; d[o + 1] = f.lum ? r : f.masks[1] ? to8((v & f.masks[1]) >>> sh[1][0], sh[1][1]) : 0; d[o + 2] = f.lum ? r : f.masks[2] ? to8((v & f.masks[2]) >>> sh[2][0], sh[2][1]) : 0;
    d[o + 3] = f.masks[3] ? to8((v & f.masks[3]) >>> sh[3][0], sh[3][1]) : 255;
  }
  return out;
}

function decodeBlocks(u8: Uint8Array, p: number, w: number, h: number, kind: Exclude<Block, null>): Raster {
  const out = makeRaster(w, h);
  const d = out.data;
  const bw = Math.ceil(w / 4), bh = Math.ceil(h / 4);
  const size = kind === 'bc1' || kind === 'bc4' ? 8 : 16;
  const px = new Uint8Array(64);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const o = p + (by * bw + bx) * size;
    if (o + size > u8.length) return out;
    px.fill(255);
    if (kind === 'bc1') colorBlock(u8, o, px, true);
    else if (kind === 'bc2') { colorBlock(u8, o + 8, px, false); for (let i = 0; i < 16; i++) { const a = (u8[o + (i >> 1)] >> ((i & 1) * 4)) & 15; px[i * 4 + 3] = a * 17; } }
    else if (kind === 'bc3') { colorBlock(u8, o + 8, px, false); alphaBlock(u8, o, px, 3); }
    else if (kind === 'bc4') { alphaBlock(u8, o, px, 0); for (let i = 0; i < 16; i++) { px[i * 4 + 1] = px[i * 4 + 2] = px[i * 4]; px[i * 4 + 3] = 255; } }
    else { alphaBlock(u8, o, px, 0); alphaBlock(u8, o + 8, px, 1); for (let i = 0; i < 16; i++) { px[i * 4 + 2] = 0; px[i * 4 + 3] = 255; } }
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const xx = bx * 4 + x, yy = by * 4 + y;
      if (xx >= w || yy >= h) continue;
      const s = (y * 4 + x) * 4, t = (yy * w + xx) * 4;
      d[t] = px[s]; d[t + 1] = px[s + 1]; d[t + 2] = px[s + 2]; d[t + 3] = px[s + 3];
    }
  }
  return out;
}

function colorBlock(u8: Uint8Array, o: number, px: Uint8Array, dxt1: boolean): void {
  const c0 = u8[o] | (u8[o + 1] << 8), c1 = u8[o + 2] | (u8[o + 3] << 8);
  const rgb = (c: number) => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];
  const a = rgb(c0), b = rgb(c1);
  const colors: number[][] = [a, b];
  if (!dxt1 || c0 > c1) { colors.push(a.map((v, i) => (2 * v + b[i]) / 3), a.map((v, i) => (v + 2 * b[i]) / 3)); }
  else { colors.push(a.map((v, i) => (v + b[i]) / 2), [0, 0, 0]); }
  for (let i = 0; i < 16; i++) {
    const idx = (u8[o + 4 + (i >> 2)] >> ((i & 3) * 2)) & 3;
    const c = colors[idx];
    px[i * 4] = Math.round(c[0]); px[i * 4 + 1] = Math.round(c[1]); px[i * 4 + 2] = Math.round(c[2]);
    if (dxt1 && idx === 3 && c0 <= c1) px[i * 4 + 3] = 0;
  }
}

function alphaBlock(u8: Uint8Array, o: number, px: Uint8Array, channel: number): void {
  const a0 = u8[o], a1 = u8[o + 1];
  const table = [a0, a1];
  if (a0 > a1) for (let i = 1; i <= 6; i++) table.push(Math.round(((7 - i) * a0 + i * a1) / 7));
  else { for (let i = 1; i <= 4; i++) table.push(Math.round(((5 - i) * a0 + i * a1) / 5)); table.push(0, 255); }
  let bits = 0n;
  for (let i = 0; i < 6; i++) bits |= BigInt(u8[o + 2 + i]) << BigInt(8 * i);
  for (let i = 0; i < 16; i++) px[i * 4 + channel] = table[Number((bits >> BigInt(3 * i)) & 7n)];
}
