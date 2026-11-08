/**
 * Lossless JPEG (ITU T.81 process 14, SOF3) as used inside DNG and many camera RAW files: Huffman-coded
 * differences from one of seven predictors, any number of interleaved components (1×1 sampling), any
 * precision from 2 to 16 bits, restart intervals and the point transform. Output is the frame's
 * samples in order (each row: x0c0 x0c1 … x1c0 …), which a DNG tile then reads row by row.
 */
export interface LjpegFrame { width: number; height: number; comps: number; precision: number; data: Uint16Array }

interface Huff { lookup: Int32Array; maxcode: Int32Array; valptr: Int32Array; mincode: Int32Array; vals: Uint8Array }
function buildHuff(counts: Uint8Array, vals: Uint8Array): Huff {
  // A 9-bit fast table (length << 8 | value) and the canonical decoding arrays for longer codes.
  const lookup = new Int32Array(512).fill(-1), maxcode = new Int32Array(18).fill(-1), valptr = new Int32Array(17), mincode = new Int32Array(17);
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    valptr[len] = k; mincode[len] = code;
    for (let i = 0; i < counts[len - 1]; i++, k++, code++) {
      if (len <= 9) { const shift = 9 - len; for (let j = 0; j < 1 << shift; j++) lookup[(code << shift) | j] = (len << 8) | vals[k]; }
    }
    maxcode[len] = counts[len - 1] ? code - 1 : -1;
    code <<= 1;
  }
  maxcode[17] = 0x7fffffff;
  return { lookup, maxcode, valptr, mincode, vals };
}

export function decodeLjpeg(u8: Uint8Array): LjpegFrame {
  let p = 0;
  const u16 = (o: number) => (u8[o] << 8) | u8[o + 1];
  if (u16(0) !== 0xffd8) throw new Error('Not a JPEG stream');
  p = 2;
  const tables: (Huff | null)[] = [null, null, null, null];
  let width = 0, height = 0, precision = 0, comps = 0, restart = 0;
  const compIds: number[] = [];
  let predictor = 1, pt = 0, scanTables: number[] = [];
  for (;;) {
    while (p < u8.length && u8[p] !== 0xff) p++;
    while (u8[p] === 0xff) p++;
    const m = u8[p++]; if (p >= u8.length) throw new Error('Truncated lossless JPEG');
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7)) continue;
    if (m === 0xd9) throw new Error('Lossless JPEG without a scan');
    const len = u16(p), seg = p + 2, end = p + len; p = end;
    if (m === 0xc4) {
      let q = seg;
      while (q < end) { const tc = u8[q] & 0x0f, counts = u8.subarray(q + 1, q + 17); let n = 0; for (const c of counts) n += c; tables[tc & 3] = buildHuff(counts, u8.subarray(q + 17, q + 17 + n)); q += 17 + n; }
    } else if (m === 0xc3 || m === 0xc7) {
      precision = u8[seg]; height = u16(seg + 1); width = u16(seg + 3); comps = u8[seg + 5];
      for (let i = 0; i < comps; i++) { compIds.push(u8[seg + 6 + i * 3]); if (u8[seg + 7 + i * 3] !== 0x11 && comps > 1) throw new Error('Subsampled lossless JPEG is not supported'); }
    } else if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      throw new Error('Not a lossless JPEG (process 14)');
    } else if (m === 0xdd) {
      restart = u16(seg);
    } else if (m === 0xda) {
      const ns = u8[seg];
      scanTables = [];
      // Components by id, or by position when the scan's ids do not match the frame's (Leaf backs number them 1-based in the scan).
      const ids = Array.from({ length: ns }, (_, i) => u8[seg + 1 + i * 2]), byId = ids.every((id) => compIds.includes(id)) && new Set(ids).size === ns;
      for (let i = 0; i < ns; i++) scanTables[byId ? compIds.indexOf(ids[i]) : i] = u8[seg + 2 + i * 2] >> 4;
      predictor = u8[seg + 1 + ns * 2]; pt = u8[seg + 3 + ns * 2] & 0x0f;
      if (ns !== comps) throw new Error('Lossless JPEG with several scans is not supported');
      break;
    }
  }
  if (!width || !height || !comps) throw new Error('Lossless JPEG without a frame header');
  const huffs = scanTables.map((t) => { const h = tables[t]; if (!h) throw new Error('Missing Huffman table'); return h; });
  const data = new Uint16Array(width * height * comps), rowLen = width * comps, mask = (1 << precision) - 1;
  // Bit reader with byte stuffing; stops at markers (returning zeros), which a restart then skips.
  let bitBuf = 0, bitCnt = 0, marker = false;
  const fill = () => {
    while (bitCnt <= 24) {
      let b = 0;
      if (!marker && p < u8.length) {
        b = u8[p];
        if (b === 0xff) { const nx = u8[p + 1]; if (nx === 0) p += 2; else { marker = true; b = 0; } } else p++;
      }
      bitBuf = ((bitBuf << 8) | b) >>> 0; bitCnt += 8;
    }
  };
  const bits = (n: number) => { if (!n) return 0; if (bitCnt < n) fill(); bitCnt -= n; return (bitBuf >>> bitCnt) & ((1 << n) - 1); };
  const decode = (h: Huff): number => {
    if (bitCnt < 16) fill();
    const look = h.lookup[(bitBuf >>> (bitCnt - 9)) & 511];
    if (look >= 0) { bitCnt -= look >> 8; return look & 255; }
    let code = (bitBuf >>> (bitCnt - 10)) & 1023, len = 10;
    while (code > h.maxcode[len]) { len++; if (len > 16) throw new Error('Bad Huffman code'); code = (bitBuf >>> (bitCnt - len)) & ((1 << len) - 1); }
    bitCnt -= len;
    return h.vals[h.valptr[len] + code - h.mincode[len]];
  };
  const diff = (h: Huff): number => {
    const s = decode(h);
    if (s === 0) return 0; if (s === 16) return 32768;
    const v = bits(s);
    return v < 1 << (s - 1) ? v - (1 << s) + 1 : v;
  };
  const initial = 1 << (precision - pt - 1);
  let sinceRestart = 0, firstRow = 0;
  for (let y = 0; y < height; y++) {
    if (restart && sinceRestart >= restart) {
      // Skip to the marker after the restart interval; prediction starts again.
      bitCnt = 0; bitBuf = 0;
      while (p < u8.length - 1 && !(u8[p] === 0xff && u8[p + 1] >= 0xd0 && u8[p + 1] <= 0xd7)) p++;
      p += 2; marker = false; sinceRestart = 0; firstRow = y;
    }
    const row = y * rowLen;
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < comps; c++) {
        const i = row + x * comps + c;
        let pred: number;
        if (y === firstRow && x === 0) pred = initial;
        else if (y === firstRow) pred = data[i - comps];
        else if (x === 0) pred = data[i - rowLen];
        else {
          const a = data[i - comps], b = data[i - rowLen], cc = data[i - rowLen - comps];
          switch (predictor) {
            case 1: pred = a; break; case 2: pred = b; break; case 3: pred = cc; break;
            case 4: pred = a + b - cc; break; case 5: pred = a + ((b - cc) >> 1); break;
            case 6: pred = b + ((a - cc) >> 1); break; case 7: pred = (a + b) >> 1; break;
            default: pred = a;
          }
        }
        data[i] = (pred + diff(huffs[c])) & 0xffff & (mask | 0xffff);
      }
    }
    // Restart intervals count MCUs (pixels); DNG writers use whole rows.
    sinceRestart += restart ? width : 0;
  }
  if (pt) for (let i = 0; i < data.length; i++) data[i] = data[i] << pt;
  return { width, height, comps, precision, data };
}
