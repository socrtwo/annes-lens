/**
 * Adobe Photoshop PSD and PSB: the merged (composite) picture, 1/8/16/32 bits, bitmap, grayscale,
 * indexed, RGB, CMYK, Lab and duotone modes, raw or RLE (PackBits) image data, with the layer names,
 * resolution and ICC profile presence listed. Layers themselves are not decoded (composite only).
 */
import { makeRaster, type DecodeResult } from './raster';

export const isPsd = (u8: Uint8Array): boolean => u8.length > 26 && u8[0] === 0x38 && u8[1] === 0x42 && u8[2] === 0x50 && u8[3] === 0x53 && (u8[5] === 1 || u8[5] === 2);

const MODES: Record<number, string> = { 0: 'bitmap', 1: 'grayscale', 2: 'indexed', 3: 'RGB', 4: 'CMYK', 7: 'multichannel', 8: 'duotone', 9: 'Lab' };

export function decodePsd(u8: Uint8Array): DecodeResult {
  if (!isPsd(u8)) throw new Error('Not a Photoshop file');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const psb = u8[5] === 2;
  const channels = dv.getUint16(12), h = dv.getUint32(14), w = dv.getUint32(18), depth = dv.getUint16(22), mode = dv.getUint16(24);
  if (!w || !h || w * h > 80_000_000) throw new Error('Bad PSD dimensions');
  const warnings: string[] = [];
  const info: Record<string, string> = {};
  let p = 26;
  // Color mode data (the palette for indexed and duotone files).
  const cmLen = dv.getUint32(p); p += 4;
  let palette: Uint8Array | null = null;
  if (mode === 2 && cmLen >= 768) palette = u8.subarray(p, p + 768);
  p += cmLen;
  // Image resources: resolution (0x03ED), ICC profile (0x040F), version info, thumbnails, XMP.
  const resLen = dv.getUint32(p); p += 4;
  let dpi: [number, number] | undefined;
  let transparencyIndex = -1;
  const resEnd = p + resLen;
  let q = p;
  while (q + 12 <= resEnd && q + 12 <= u8.length) {
    if (!(u8[q] === 0x38 && u8[q + 1] === 0x42 && u8[q + 2] === 0x49 && u8[q + 3] === 0x4d)) break;
    const id = dv.getUint16(q + 4);
    const nameLen = u8[q + 6];
    let r = q + 7 + nameLen; if ((nameLen + 1) & 1) r++;
    const size = dv.getUint32(r); r += 4;
    if (id === 0x03ed && size >= 16) { const hres = dv.getUint32(r) / 65536, vres = dv.getUint32(r + 8) / 65536; const hu = dv.getUint16(r + 4), vu = dv.getUint16(r + 12); dpi = [Math.round(hu === 2 ? hres * 2.54 : hres), Math.round(vu === 2 ? vres * 2.54 : vres)]; }
    else if (id === 0x040f) info['Color profile'] = `embedded ICC profile (${size.toLocaleString()} bytes)`;
    else if (id === 0x0417 && size >= 2) transparencyIndex = dv.getUint16(r);
    else if (id === 0x0424) info.XMP = 'present';
    else if (id === 0x0422) info.EXIF = 'present';
    q = r + size + (size & 1);
  }
  p = resEnd;
  // Layer and mask information: list the layer names.
  const lmLen = psb ? Number(dv.getBigUint64(p)) : dv.getUint32(p); p += psb ? 8 : 4;
  const layers: string[] = [];
  try {
    if (lmLen > 0) {
      let r = p;
      const liLen = psb ? Number(dv.getBigUint64(r)) : dv.getUint32(r); r += psb ? 8 : 4;
      if (liLen > 0) {
        let count = dv.getInt16(r); r += 2;
        const mergedAlpha = count < 0; count = Math.abs(count);
        if (mergedAlpha) info['Merged alpha'] = 'the first alpha channel is the composite\'s transparency';
        for (let i = 0; i < count && r + 34 <= u8.length; i++) {
          r += 16; // rectangle
          const nch = dv.getUint16(r); r += 2;
          r += nch * (psb ? 10 : 6);
          r += 4; // '8BIM'
          r += 4 + 1 + 1 + 1 + 1; // blend key, opacity, clipping, flags, filler
          const extra = dv.getUint32(r); r += 4;
          const extraEnd = r + extra;
          const maskLen = dv.getUint32(r); r += 4 + maskLen;
          const blendLen = dv.getUint32(r); r += 4 + blendLen;
          const nameLen = u8[r];
          layers.push(new TextDecoder('latin1').decode(u8.subarray(r + 1, r + 1 + nameLen)));
          r = extraEnd;
        }
      }
    }
  } catch { warnings.push('The layer list could not be read'); }
  if (layers.length) info.Layers = `${layers.length}: ${layers.slice(0, 20).join(', ')}${layers.length > 20 ? ', …' : ''}`;
  p += lmLen;
  // Image data: compression, then every channel's rows (all channels planar), RLE byte counts first.
  if (p + 2 > u8.length) throw new Error('No composite picture data (the file holds layers only)');
  const compression = dv.getUint16(p); p += 2;
  const bytesPerSample = depth === 1 ? 1 : depth / 8;
  const rowBytes = depth === 1 ? Math.ceil(w / 8) : w * bytesPerSample;
  const planeBytes = rowBytes * h;
  const planes: Uint8Array[] = [];
  // The composite uses at most five channels (CMYK and alpha); a header may claim 56, each a plane of its own.
  const used = Math.min(channels, 5);
  if (compression === 0) {
    for (let c = 0; c < used; c++) { const s = p + c * planeBytes; if (s >= u8.length) { warnings.push(`Channel ${c + 1} is missing`); break; } const pl = new Uint8Array(planeBytes); pl.set(u8.subarray(s, Math.min(u8.length, s + planeBytes))); planes.push(pl); if (s + planeBytes > u8.length) warnings.push(`Channel ${c + 1} is truncated`); }
  } else if (compression === 1) {
    const countSize = psb ? 4 : 2;
    const counts: number[] = [];
    let r = p;
    for (let i = 0; i < channels * h; i++) { counts.push(psb ? dv.getUint32(r) : dv.getUint16(r)); r += countSize; }
    for (let c = 0; c < used; c++) {
      const pl = new Uint8Array(planeBytes);
      let truncated = false;
      for (let y = 0; y < h; y++) {
        const n = counts[c * h + y];
        if (r + n > u8.length) { truncated = true; break; }
        unpackBits(u8.subarray(r, r + n), pl, y * rowBytes, rowBytes);
        r += n;
      }
      planes.push(pl);
      if (truncated) { warnings.push(`Channel ${c + 1} is truncated`); break; }
    }
  } else throw new Error(`Unsupported image data compression ${compression} (ZIP); the composite cannot be shown`);
  const out = makeRaster(w, h);
  const d = out.data;
  const sample = (plane: Uint8Array, i: number): number => {
    if (depth === 8) return plane[i];
    if (depth === 16) return plane[i * 2];
    if (depth === 32) { const v = new DataView(plane.buffer, plane.byteOffset + i * 4, 4).getFloat32(0); return Math.round(255 * Math.max(0, Math.min(1, v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055))); }
    return 0;
  };
  const total = w * h;
  const colorChannels = mode === 3 ? 3 : mode === 4 ? 4 : mode === 9 ? 3 : 1;
  const alphaPlane = planes.length > colorChannels ? planes[colorChannels] : null;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    let r = 0, g = 0, b = 0;
    if (mode === 0) { const y = Math.floor(i / w), x = i % w; const bit = (planes[0][y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1; r = g = b = bit ? 0 : 255; }
    else if (mode === 3) { r = sample(planes[0], i); g = planes[1] ? sample(planes[1], i) : r; b = planes[2] ? sample(planes[2], i) : r; }
    else if (mode === 4) { const c = sample(planes[0], i), m = planes[1] ? sample(planes[1], i) : 255, yy = planes[2] ? sample(planes[2], i) : 255, k = planes[3] ? sample(planes[3], i) : 255; r = Math.round((c * k) / 255); g = Math.round((m * k) / 255); b = Math.round((yy * k) / 255); } // PSD stores CMYK inverted
    else if (mode === 2 && palette) { const idx = planes[0][i]; r = palette[idx]; g = palette[256 + idx]; b = palette[512 + idx]; if (idx === transparencyIndex) { d[o + 3] = 0; } }
    else if (mode === 9) { const L = sample(planes[0], i) / 255 * 100, A = (planes[1] ? sample(planes[1], i) : 128) - 128, B = (planes[2] ? sample(planes[2], i) : 128) - 128; [r, g, b] = labToRgb(L, A, B); }
    else { r = g = b = sample(planes[0], i); }
    d[o] = r; d[o + 1] = g; d[o + 2] = b;
    if (!(mode === 2 && planes[0][i] === transparencyIndex)) d[o + 3] = alphaPlane ? sample(alphaPlane, i) : 255;
  }
  let hasAlpha = false;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) { hasAlpha = true; break; }
  const notes = [`${psb ? 'PSB' : 'PSD'} composite, ${MODES[mode] || `mode ${mode}`}, ${depth} bits × ${channels} channel${channels > 1 ? 's' : ''}${compression === 1 ? ', RLE' : ''}`];
  if (layers.length) notes.push(`${layers.length} layer${layers.length > 1 ? 's' : ''} (merged view shown)`);
  return { pages: [{ width: w, height: h, frames: [{ raster: out, delay: 0 }], loops: 0, bitDepth: depth * channels, paletteSize: mode === 2 ? 256 : undefined, hasAlpha, dpi, notes }], info, warnings };
}

function unpackBits(src: Uint8Array, dst: Uint8Array, at: number, max: number): void {
  let i = 0, o = at;
  const end = at + max;
  while (i < src.length && o < end) {
    const n = (src[i++] << 24) >> 24;
    if (n >= 0) { for (let k = 0; k <= n && i < src.length && o < end; k++) dst[o++] = src[i++]; }
    else if (n !== -128) { const v = src[i++]; for (let k = 0; k < 1 - n && o < end; k++) dst[o++] = v; }
  }
}

function labToRgb(L: number, a: number, b: number): [number, number, number] {
  let y = (L + 16) / 116, x = a / 500 + y, z = y - b / 200;
  const f = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  x = 0.95047 * f(x); y = 1.0 * f(y); z = 1.08883 * f(z);
  let r = x * 3.2406 + y * -1.5372 + z * -0.4986, g = x * -0.9689 + y * 1.8758 + z * 0.0415, bb = x * 0.0557 + y * -0.204 + z * 1.057;
  const gam = (v: number) => { v = Math.max(0, Math.min(1, v)); return Math.round(255 * (v > 0.0031308 ? 1.055 * Math.pow(v, 1 / 2.4) - 0.055 : 12.92 * v)); };
  return [gam(r), gam(g), gam(bb)];
}
