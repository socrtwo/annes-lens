/**
 * Radiance HDR (.hdr, .pic): RGBE pixels, flat or new-style run-length encoded, with the header's
 * exposure and format. Displayed through a simple exposure and gamma tone map; the decoded floats stay
 * available for the Adjust tab later.
 */
import { makeRaster, type DecodeResult } from './raster';
import { latin1 } from './limits';

export const isHdr = (u8: Uint8Array): boolean => u8.length > 16 && String.fromCharCode(...u8.subarray(0, 10)) === '#?RADIANCE' || (u8.length > 16 && String.fromCharCode(...u8.subarray(0, 6)) === '#?RGBE');

export function decodeHdr(u8: Uint8Array, opts: { exposure?: number } = {}): DecodeResult {
  if (!isHdr(u8)) throw new Error('Not a Radiance HDR file');
  // Header: lines until an empty line, then the resolution string.
  let p = 0;
  const lines: string[] = [];
  for (;;) {
    let e = p; while (e < u8.length && u8[e] !== 0x0a) e++;
    const line = latin1(u8, p, e);
    p = e + 1;
    if (!line.length) break;
    lines.push(line);
    if (p >= u8.length) throw new Error('Header is incomplete');
  }
  let e = p; while (e < u8.length && u8[e] !== 0x0a) e++;
  const res = latin1(u8, p, e).trim();
  p = e + 1;
  const m = res.match(/^([-+])Y\s+(\d+)\s+([-+])X\s+(\d+)$/);
  if (!m) throw new Error(`Unsupported orientation "${res}"`);
  const h = +m[2], w = +m[4], flipY = m[1] === '+', flipX = m[3] === '-';
  if (!w || !h || w * h > 80_000_000) throw new Error('Bad dimensions');
  const info: Record<string, string> = {};
  let exposure = 1;
  for (const l of lines) {
    const kv = l.match(/^(\w+)=(.*)$/);
    if (!kv) continue;
    if (kv[1] === 'EXPOSURE') exposure *= parseFloat(kv[2]) || 1;
    else if (kv[1] === 'FORMAT') { if (kv[2].trim() !== '32-bit_rle_rgbe') throw new Error(`Format ${kv[2].trim()} is not supported (only RGBE)`); }
    else info[kv[1]] = kv[2].trim();
  }
  const warnings: string[] = [];
  const rgbe = new Uint8Array(w * h * 4);
  let truncated = false;
  for (let y = 0; y < h && !truncated; y++) {
    const row = y * w * 4;
    if (p + 4 > u8.length) { truncated = true; break; }
    const newRle = w >= 8 && w < 32768 && u8[p] === 2 && u8[p + 1] === 2 && !(u8[p + 2] & 128);
    if (newRle && ((u8[p + 2] << 8) | u8[p + 3]) === w) {
      p += 4;
      for (let c = 0; c < 4; c++) {
        let x = 0;
        while (x < w) {
          if (p >= u8.length) { truncated = true; break; }
          let n = u8[p++];
          if (n > 128) { n -= 128; const v = u8[p++]; for (let k = 0; k < n && x < w; k++) rgbe[row + (x++) * 4 + c] = v; }
          else { for (let k = 0; k < n && x < w; k++) { if (p >= u8.length) { truncated = true; break; } rgbe[row + (x++) * 4 + c] = u8[p++]; } }
          if (truncated) break;
        }
        if (truncated) break;
      }
    } else {
      // Flat or old-style RLE (repeat count in the exponent position).
      let x = 0, shift = 0;
      while (x < w) {
        if (p + 4 > u8.length) { truncated = true; break; }
        const r = u8[p], g = u8[p + 1], b = u8[p + 2], ex = u8[p + 3];
        p += 4;
        if (r === 1 && g === 1 && b === 1) { const n = ex << shift; const prev = row + (x - 1) * 4; for (let k = 0; k < n && x < w; k++) { rgbe.set(rgbe.subarray(prev, prev + 4), row + x * 4); x++; } shift += 8; }
        else { rgbe[row + x * 4] = r; rgbe[row + x * 4 + 1] = g; rgbe[row + x * 4 + 2] = b; rgbe[row + x * 4 + 3] = ex; x++; shift = 0; }
      }
    }
  }
  if (truncated) warnings.push('Pixel data is truncated; the rest is left black');
  // Tone map: linear value × exposure, clipped, sRGB gamma.
  const out = makeRaster(w, h);
  const d = out.data;
  const scale = (opts.exposure ?? 1) / exposure;
  let maxLum = 0;
  const lin = new Float32Array(3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = (y * w + x) * 4;
    const ex = rgbe[s + 3];
    const f = ex ? Math.pow(2, ex - 136) * scale : 0;
    lin[0] = rgbe[s] * f; lin[1] = rgbe[s + 1] * f; lin[2] = rgbe[s + 2] * f;
    if (!ex) lin[0] = lin[1] = lin[2] = 0;
    const lum = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    if (lum > maxLum) maxLum = lum;
    const yy = flipY ? h - 1 - y : y, xx = flipX ? w - 1 - x : x;
    const o = (yy * w + xx) * 4;
    for (let c = 0; c < 3; c++) { const v = Math.max(0, Math.min(1, lin[c])); d[o + c] = Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)); }
    d[o + 3] = 255;
  }
  if (exposure !== 1) info.EXPOSURE = String(exposure);
  return { pages: [{ width: w, height: h, frames: [{ raster: out, delay: 0 }], loops: 0, bitDepth: 32, hasAlpha: false, notes: [`Radiance RGBE, tone-mapped at exposure 1 (brightest pixel ${maxLum.toPrecision(3)}×)`] }], info, warnings };
}
