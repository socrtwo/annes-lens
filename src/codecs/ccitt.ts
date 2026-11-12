/**
 * CCITT fax decoding for TIFF: Modified Huffman run lengths (TIFF compression 2, rows byte-aligned),
 * T.4 / Group 3 one- and two-dimensional (compression 3, with or without EOLs and fill bits) and
 * T.6 / Group 4 (compression 4). FillOrder 2 (least significant bit first) is handled. The result is
 * packed rows, one bit per pixel, most significant bit first: 0 for the runs T.4 calls white, 1 for black
 * (bit values; the TIFF's PhotometricInterpretation decides which is dark, as in libtiff).
 */

// [code, run] for terminating (0–63) and make-up (64–1728) codes, white and black, then the shared
// extended make-up codes (1792–2560). ITU-T T.4 tables 2 and 3.
const WHITE = '00110101 000111 0111 1000 1011 1100 1110 1111 10011 10100 00111 01000 001000 000011 110100 110101 101010 101011 0100111 0001100 0001000 0010111 0000011 0000100 0101000 0101011 0010011 0100100 0011000 00000010 00000011 00011010 00011011 00010010 00010011 00010100 00010101 00010110 00010111 00101000 00101001 00101010 00101011 00101100 00101101 00000100 00000101 00001010 00001011 01010010 01010011 01010100 01010101 00100100 00100101 01011000 01011001 01011010 01011011 01001010 01001011 00110010 00110011 00110100';
const WHITE_MAKEUP = '11011 10010 010111 0110111 00110110 00110111 01100100 01100101 01101000 01100111 011001100 011001101 011010010 011010011 011010100 011010101 011010110 011010111 011011000 011011001 011011010 011011011 010011000 010011001 010011010 011000 010011011';
const BLACK = '0000110111 010 11 10 011 0011 0010 00011 000101 000100 0000100 0000101 0000111 00000100 00000111 000011000 0000010111 0000011000 0000001000 00001100111 00001101000 00001101100 00000110111 00000101000 00000010111 00000011000 000011001010 000011001011 000011001100 000011001101 000001101000 000001101001 000001101010 000001101011 000011010010 000011010011 000011010100 000011010101 000011010110 000011010111 000001101100 000001101101 000011011010 000011011011 000001010100 000001010101 000001010110 000001010111 000001100100 000001100101 000001010010 000001010011 000000100100 000000110111 000000111000 000000100111 000000101000 000001011000 000001011001 000000101011 000000101100 000001011010 000001100110 000001100111';
const BLACK_MAKEUP = '0000001111 000011001000 000011001001 000001011011 000000110011 000000110100 000000110101 0000001101100 0000001101101 0000001001010 0000001001011 0000001001100 0000001001101 0000001110010 0000001110011 0000001110100 0000001110101 0000001110110 0000001110111 0000001010010 0000001010011 0000001010100 0000001010101 0000001011010 0000001011011 0000001100100 0000001100101';
const EXT_MAKEUP = '00000001000 00000001100 00000001101 000000010010 000000010011 000000010100 000000010101 000000010110 000000010111 000000011100 000000011101 000000011110 000000011111';

/** A decoding table: key (length << 16 | code) → run length. */
function table(term: string, makeup: string): Map<number, number> {
  const m = new Map<number, number>();
  const add = (codes: string, run: (i: number) => number) => codes.split(' ').forEach((c, i) => m.set((c.length << 16) | parseInt(c, 2), run(i)));
  add(term, (i) => i); add(makeup, (i) => (i + 1) * 64); add(EXT_MAKEUP, (i) => 1792 + i * 64);
  return m;
}
let tables: [Map<number, number>, Map<number, number>] | null = null;

class Bits {
  pos = 0; // bit position
  constructor(private u8: Uint8Array, private lsb: boolean) {}
  get end(): boolean { return this.pos >= this.u8.length * 8; }
  bit(): number {
    const i = this.pos >> 3; if (i >= this.u8.length) { this.pos++; return 0; }
    const b = this.u8[i], s = this.pos & 7; this.pos++;
    return this.lsb ? (b >> s) & 1 : (b >> (7 - s)) & 1;
  }
  peek(n: number): number { const p = this.pos; let v = 0; for (let k = 0; k < n; k++) v = (v << 1) | this.bit(); this.pos = p; return v; }
  align(): void { this.pos = (this.pos + 7) & ~7; }
}

/** One run length of a color (make-up codes summed with the terminating code). */
function run(b: Bits, black: boolean): number {
  const t = tables![black ? 1 : 0];
  let total = 0;
  for (;;) {
    let code = 0, found = -1;
    for (let len = 1; len <= 13; len++) { code = (code << 1) | b.bit(); const r = t.get((len << 16) | code); if (r !== undefined) { found = r; break; } }
    if (found < 0) throw new Error('Bad CCITT run code');
    total += found;
    if (found < 64) return total;
  }
}
/** Skips fill bits and an EOL (eleven or more zeros and a one) when one is next; true when it was there. */
function eol(b: Bits): boolean {
  if (b.peek(11) !== 0) return false;
  let zeros = 0; while (!b.end && b.peek(1) === 0) { b.bit(); zeros++; }
  if (b.end) return true;
  b.bit(); return zeros >= 11;
}

const enum Mode { Pass, Horiz, V }
function mode2d(b: Bits): [Mode, number] {
  if (b.bit()) return [Mode.V, 0];
  if (b.bit()) return b.bit() ? [Mode.V, 1] : [Mode.V, -1]; // 011, 010
  if (b.bit()) return [Mode.Horiz, 0]; // 001
  if (b.bit()) return [Mode.Pass, 0]; // 0001
  if (b.bit()) return b.bit() ? [Mode.V, 2] : [Mode.V, -2]; // 000011, 000010
  if (b.bit()) return b.bit() ? [Mode.V, 3] : [Mode.V, -3]; // 0000011, 0000010
  throw new Error('Unsupported CCITT code (uncompressed mode or a broken line)');
}

export interface CcittOptions { compression: 2 | 3 | 4; t4Options?: number; t6Options?: number; lsbFirst?: boolean; /** Filled in when lines were damaged: how many, and the first error. */ report?: { damaged: number; error: string } }

/** Moves past the next EOL (eleven or more zeros and a one); false at the end of the data. */
function seekEol(b: Bits): boolean {
  let zeros = 0;
  while (!b.end) { const v = b.bit(); if (v === 0) zeros++; else if (zeros >= 11) return true; else zeros = 0; }
  return false;
}

/** Decodes `rows` rows of `width` pixels. Rows the data does not reach stay white. */
export function decodeCcitt(u8: Uint8Array, width: number, rows: number, o: CcittOptions): Uint8Array {
  tables ??= [table(WHITE, WHITE_MAKEUP), table(BLACK, BLACK_MAKEUP)];
  const rowBytes = (width + 7) >> 3, out = new Uint8Array(rowBytes * rows);
  const b = new Bits(u8, !!o.lsbFirst);
  const twoD = o.compression === 4 || (o.compression === 3 && ((o.t4Options || 0) & 1) !== 0);
  let ref: number[] = [width, width]; // changing elements of the line above (all white)
  const setRun = (row: number, from: number, to: number) => { for (let x = Math.max(0, from); x < Math.min(width, to); x++) out[row * rowBytes + (x >> 3)] |= 0x80 >> (x & 7); };
  // A damaged line (a code that is not in the tables) is left white: G3 data resumes at the next EOL, G4 and the
  // RLE variant, which have no resynchronization point, keep the lines decoded before it (R17). When no line
  // decodes at all, the error is thrown: that is not a fax picture with damage but no fax picture.
  let good = 0, firstError: unknown = null, eols = 0;
  for (let y = 0; y < rows; y++) {
    if (b.end) break;
    try {
    let lineIs2d = o.compression === 4;
    if (o.compression === 3) {
      const hadEol = eol(b);
      if (y === 0 && !hadEol) { /* files may omit the first EOL */ }
      // Data that marks its lines with EOLs and then misses one is out of step (the line before was damaged).
      if (hadEol) eols++; else if (eols > 1 && !b.end) throw new Error('Missing CCITT end of line');
      lineIs2d = twoD ? b.bit() === 0 : false;
      if (b.end) break;
    }
    const cur: number[] = [];
    if (!lineIs2d) {
      // One-dimensional: alternating white and black runs.
      let x = 0, black = false;
      while (x < width) {
        const r = run(b, black);
        if (black) setRun(y, x, x + r);
        x += r; if (x > width) x = width;
        cur.push(x); black = !black;
      }
      if (cur.length && cur[cur.length - 1] === width) cur.pop();
    } else {
      let a0 = -1, black = false;
      const changes = (p: number) => cur.push(p);
      while (a0 < width) {
        // b1: the first changing element on the line above to the right of a0 whose color is opposite
        // to the current color (even indexes start black runs); b2: the next one.
        let i = 0; while (i < ref.length && (ref[i] <= a0 || (i & 1) !== (black ? 1 : 0))) i++;
        const b1 = i < ref.length ? ref[i] : width, b2 = i + 1 < ref.length ? ref[i + 1] : width;
        const [m, d] = mode2d(b);
        if (m === Mode.Pass) { if (black) setRun(y, a0, b2); a0 = b2; }
        else if (m === Mode.Horiz) {
          const start = Math.max(0, a0), r1 = run(b, black), r2 = run(b, !black), a1 = Math.min(width, start + r1), a2 = Math.min(width, a1 + r2);
          if (black) setRun(y, start, a1); else setRun(y, a1, a2);
          changes(a1); changes(a2); a0 = a2;
        } else {
          const a1 = Math.max(0, Math.min(width, b1 + d));
          if (black) setRun(y, Math.max(0, a0), a1);
          changes(a1); a0 = a1; black = !black;
        }
      }
      while (cur.length && cur[cur.length - 1] >= width) cur.pop();
    }
    ref = [...cur.filter((p) => p < width), width, width];
    if (o.compression === 2) b.align();
    else if (o.compression === 4 && ((o.t6Options || 0) & 2) !== 0) b.align();
    good++;
    } catch (e) {
      firstError ??= e;
      out.fill(0, y * rowBytes, (y + 1) * rowBytes);
      if (o.report) { if (!o.report.damaged) o.report.error = (e as Error)?.message || String(e); o.report.damaged += o.compression === 3 ? 1 : rows - y; }
      if (o.compression !== 3 || !seekEol(b)) break;
      ref = [width, width];
      // seekEol consumed the EOL: the next line's own EOL check must not look for it again.
      b.pos -= 12;
    }
  }
  if (!good && firstError) throw firstError;
  return out;
}
