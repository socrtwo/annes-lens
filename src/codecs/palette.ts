/**
 * Color quantization (median cut) and palette files: GIMP .gpl, Adobe .act, JASC .pal, Photoshop .aco
 * and CSS custom properties. Used by Export Palette and the GIF writer.
 */

export interface Palette { colors: [number, number, number][] }

/** Up to `n` colors chosen by median cut over the given RGBA pixels (transparent pixels ignored). */
export function medianCut(data: Uint8ClampedArray | Uint8Array, n: number, maxSamples = 262144): Palette {
  const px = data.length / 4;
  const step = Math.max(1, Math.floor(px / maxSamples));
  const samples: number[] = [];
  for (let i = 0; i < px; i += step) { const o = i * 4; if (data[o + 3] < 128) continue; samples.push((data[o] << 16) | (data[o + 1] << 8) | data[o + 2]); }
  if (!samples.length) return { colors: [] };
  // Unique colors first: if there are few, they are the palette.
  const uniq = new Map<number, number>();
  for (const c of samples) uniq.set(c, (uniq.get(c) || 0) + 1);
  if (uniq.size <= n) return { colors: [...uniq.keys()].map((c) => [c >> 16, (c >> 8) & 255, c & 255] as [number, number, number]) };
  type Box = { colors: number[]; counts: number[] };
  const boxes: Box[] = [{ colors: [...uniq.keys()], counts: [...uniq.values()] }];
  const range = (b: Box) => {
    let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0;
    for (const c of b.colors) { const r = c >> 16, g = (c >> 8) & 255, bl = c & 255; if (r < rmin) rmin = r; if (r > rmax) rmax = r; if (g < gmin) gmin = g; if (g > gmax) gmax = g; if (bl < bmin) bmin = bl; if (bl > bmax) bmax = bl; }
    const dr = rmax - rmin, dg = gmax - gmin, db = bmax - bmin;
    return dg >= dr && dg >= db ? { axis: 8, span: dg } : dr >= db ? { axis: 16, span: dr } : { axis: 0, span: db };
  };
  while (boxes.length < n) {
    let best = -1, bestSpan = 0;
    for (let i = 0; i < boxes.length; i++) { if (boxes[i].colors.length < 2) continue; const { span } = range(boxes[i]); if (span > bestSpan) { bestSpan = span; best = i; } }
    if (best < 0) break;
    const b = boxes[best];
    const { axis } = range(b);
    const order = b.colors.map((c, i) => i).sort((x, y) => ((b.colors[x] >> axis) & 255) - ((b.colors[y] >> axis) & 255));
    const total = b.counts.reduce((s, v) => s + v, 0);
    let acc = 0, cut = 0;
    for (; cut < order.length - 1; cut++) { acc += b.counts[order[cut]]; if (acc * 2 >= total) break; }
    cut = Math.min(cut, order.length - 2); // both halves keep at least one color, even when the last color outweighs all the others (a white page)
    const left: Box = { colors: [], counts: [] }, right: Box = { colors: [], counts: [] };
    order.forEach((idx, k) => { const t = k <= cut ? left : right; t.colors.push(b.colors[idx]); t.counts.push(b.counts[idx]); });
    if (!left.colors.length || !right.colors.length) break;
    boxes.splice(best, 1, left, right);
  }
  const colors = boxes.map((b) => {
    let r = 0, g = 0, bl = 0, w = 0;
    for (let i = 0; i < b.colors.length; i++) { const c = b.colors[i], k = b.counts[i]; r += (c >> 16) * k; g += ((c >> 8) & 255) * k; bl += (c & 255) * k; w += k; }
    return [Math.round(r / w), Math.round(g / w), Math.round(bl / w)] as [number, number, number];
  });
  return { colors };
}

/** Maps RGBA pixels to palette indexes (nearest color, with a cache); alpha below 128 gets `transparent` when given. */
export function mapToPalette(data: Uint8ClampedArray | Uint8Array, pal: Palette, transparent = -1): Uint8Array {
  const out = new Uint8Array(data.length / 4);
  const cache = new Map<number, number>();
  const cols = pal.colors;
  for (let i = 0, o = 0; i < data.length; i += 4, o++) {
    if (transparent >= 0 && data[i + 3] < 128) { out[o] = transparent; continue; }
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    let idx = cache.get(key);
    if (idx === undefined) {
      let best = 0, bd = Infinity;
      for (let k = 0; k < cols.length; k++) { const dr = cols[k][0] - data[i], dg = cols[k][1] - data[i + 1], db = cols[k][2] - data[i + 2]; const d = dr * dr * 2 + dg * dg * 4 + db * db * 3; if (d < bd) { bd = d; best = k; } }
      idx = best; cache.set(key, idx);
    }
    out[o] = idx;
  }
  return out;
}

const hex = (c: [number, number, number]) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');

export type PaletteFormat = 'gpl' | 'act' | 'pal' | 'aco' | 'css' | 'txt';

export function encodePalette(pal: Palette, format: PaletteFormat, name = 'Anne\'s Lens palette'): { bytes: Uint8Array; ext: string; mime: string } {
  const enc = (s: string) => new TextEncoder().encode(s);
  const c = pal.colors;
  switch (format) {
    case 'gpl': return { bytes: enc(`GIMP Palette\nName: ${name}\nColumns: ${Math.min(16, c.length)}\n#\n${c.map((x) => `${String(x[0]).padStart(3)} ${String(x[1]).padStart(3)} ${String(x[2]).padStart(3)}\t${hex(x)}`).join('\n')}\n`), ext: 'gpl', mime: 'text/plain' };
    case 'pal': return { bytes: enc(`JASC-PAL\r\n0100\r\n${c.length}\r\n${c.map((x) => x.join(' ')).join('\r\n')}\r\n`), ext: 'pal', mime: 'text/plain' };
    case 'css': return { bytes: enc(`:root {\n${c.map((x, i) => `  --color-${i + 1}: ${hex(x)};`).join('\n')}\n}\n`), ext: 'css', mime: 'text/css' };
    case 'txt': return { bytes: enc(c.map((x) => `${hex(x)}\t${x.join(', ')}`).join('\n') + '\n'), ext: 'txt', mime: 'text/plain' };
    case 'act': { const b = new Uint8Array(772); for (let i = 0; i < Math.min(256, c.length); i++) b.set(c[i], i * 3); b[768] = c.length >> 8; b[769] = c.length & 255; b[770] = 0xff; b[771] = 0xff; return { bytes: b, ext: 'act', mime: 'application/octet-stream' }; }
    case 'aco': {
      // Version 1 block, then version 2 with names.
      const v1 = [0, 1, c.length >> 8, c.length & 255];
      for (const x of c) v1.push(0, 0, x[0], x[0], x[1], x[1], x[2], x[2], 0, 0);
      const v2 = [0, 2, c.length >> 8, c.length & 255];
      c.forEach((x, i) => { const nm = `Color ${i + 1}`; v2.push(0, 0, x[0], x[0], x[1], x[1], x[2], x[2], 0, 0, 0, 0, 0, nm.length + 1); for (const ch of nm) v2.push(0, ch.charCodeAt(0)); v2.push(0, 0); });
      return { bytes: Uint8Array.from([...v1, ...v2]), ext: 'aco', mime: 'application/octet-stream' };
    }
  }
}

/** Reads a palette file: GIMP .gpl, Adobe .act, JASC .pal, Photoshop .aco (version 1 RGB), or any text with hex colors. */
export function parsePalette(bytes: Uint8Array, name = ''): Palette {
  const ext = (name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
  const text = (() => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return ''; } })();
  const colors: [number, number, number][] = [];
  if (ext === 'act' || (!text && bytes.length >= 768 && bytes.length <= 772)) { const n = bytes.length >= 770 ? Math.min(256, (bytes[768] << 8) | bytes[769]) || 256 : 256; for (let i = 0; i < n && i * 3 + 2 < bytes.length; i++) colors.push([bytes[i * 3], bytes[i * 3 + 1], bytes[i * 3 + 2]]); return { colors }; }
  if (ext === 'aco' && bytes.length >= 4) { const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const n = dv.getUint16(2); for (let i = 0; i < n && 4 + i * 10 + 10 <= bytes.length; i++) { const o = 4 + i * 10; const space = dv.getUint16(o); if (space === 0) colors.push([dv.getUint16(o + 2) >> 8, dv.getUint16(o + 4) >> 8, dv.getUint16(o + 6) >> 8]); else if (space === 1) { const h = dv.getUint16(o + 2) / 65535, s = dv.getUint16(o + 4) / 65535, v = dv.getUint16(o + 6) / 65535; const k = (n2: number) => { const kk = (n2 + h * 6) % 6; return Math.round(255 * v * (1 - s * Math.max(0, Math.min(kk, 4 - kk, 1)))); }; colors.push([k(5), k(3), k(1)]); } } return { colors }; }
  if (/^JASC-PAL/i.test(text)) { for (const line of text.split(/\r?\n/).slice(3)) { const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)/); if (m) colors.push([+m[1], +m[2], +m[3]]); } return { colors }; }
  if (/^GIMP Palette/i.test(text) || (text && /^\s*\d+\s+\d+\s+\d+/m.test(text) && !/#[0-9a-f]{6}/i.test(text))) { for (const line of text.split(/\r?\n/)) { if (/^(GIMP|Name:|Columns:|#)/i.test(line.trim())) continue; const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)/); if (m) colors.push([Math.min(255, +m[1]), Math.min(255, +m[2]), Math.min(255, +m[3])]); } return { colors }; }
  for (const m of text.matchAll(/#?\b([0-9a-f]{6})\b/gi)) { const v = parseInt(m[1], 16); colors.push([(v >> 16) & 255, (v >> 8) & 255, v & 255]); }
  return { colors: colors.slice(0, 256) };
}
