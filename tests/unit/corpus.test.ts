/**
 * The downloadable corpus (scripts/fetch-corpus.py → tests/corpus): skipped when it has not been fetched.
 * Real camera files must be identified and yield a preview (or develop, for DNG); NASA's FITS samples must decode;
 * damaged copies must either decode or fail with a plain error within a time limit.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { identifyRaw, findEmbeddedJpegs, tiffThumbnail } from '../../src/codecs/rawpreview';
import { isDng, readDng } from '../../src/raw/dng';
import { readRaw, rawSupport } from '../../src/raw/families';
import { decodeFits, isFits } from '../../src/codecs/fits';
import { sniff } from '../../src/codecs/registry';

const DIR = 'tests/corpus/', MANIFEST = DIR + 'manifest.json';
interface Entry { name: string; format: string; bytes: number; camera?: string; note?: string }
const manifest: { files: Entry[]; damaged: { name: string; from: string; damage: string }[] } | null = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : null;
const fx = (n: string) => new Uint8Array(readFileSync(DIR + n));
/** LibRaw's reading of each RAW sample (scripts/fetch-corpus.py --refs): sizes, levels, pattern and the visible sensor values. */
interface Ref { bin?: string; width: number; height: number; rawWidth: number; rawHeight: number; left: number; top: number; black: number[]; white: number; pattern: number[][]; wb: number[]; skipped?: string }
const refs: Record<string, Ref> = existsSync(DIR + 'refs.json') ? JSON.parse(readFileSync(DIR + 'refs.json', 'utf8')) : {};
/** Families the reader refuses on purpose (their coding is not implemented); everything else must read and match LibRaw. */
const REFUSED = new Set(['CR3', 'CRW', 'X3F', 'IIQ', '3FR', 'FFF', 'SRF', 'KDC']);
/** Families whose sample holds neither a JPEG preview nor a TIFF thumbnail (Minolta's MRW stores no RGB preview): identified, shown as an error. */
const NO_PREVIEW = new Set(['MRW']);

describe.skipIf(!manifest)('the downloadable corpus (tests/corpus)', () => {
  for (const f of manifest?.files || []) {
    it(`${f.name}: ${f.camera || f.note || f.format} is identified and read`, async () => {
      const u8 = fx(f.name);
      expect(u8.length).toBe(f.bytes);
      if (f.format === 'raw') {
        const id = identifyRaw(u8, f.name);
        expect(id, 'identified as a RAW family').toBeTruthy();
        expect(sniff(u8, f.name)?.id).toBe('raw');
        if (isDng(u8)) { const r = readDng(u8); expect(r.width).toBeGreaterThan(0); expect(r.height).toBeGreaterThan(0); }
        else {
          // The RAW module: every family not refused on purpose reads, and where LibRaw's reference exists the sensor values match it exactly.
          const support = rawSupport(u8, f.name), ref = refs[f.name];
          if (REFUSED.has(id!.family)) expect(support.ok, `${id!.family} is refused with a reason`).toBe(false);
          else {
            expect(support.ok).toBe(true);
            let r: ReturnType<typeof readRaw> | null = null;
            try { r = readRaw(u8, f.name); } catch (e: any) { expect(String(e?.message), 'a refusal the reader explains').toMatch(/sRAW and mRAW|no sensor image/); } // Canon's sRAW and film-scanner NEFs
            if (!r) return;
            expect(r.width).toBeGreaterThan(100); expect(r.height).toBeGreaterThan(100);
            if (ref && !ref.skipped && ref.bin && r.samples === 1) {
              expect([r.width, r.height], 'the full sensor size LibRaw reports').toEqual([ref.rawWidth, ref.rawHeight]);
              const bin = new Uint8Array(readFileSync(DIR + ref.bin)), want = new Uint16Array(bin.buffer, bin.byteOffset, bin.byteLength / 2);
              let bad = 0;
              for (let y = 0; y < ref.height; y++) { const ro = (y + ref.top) * r.width + ref.left, wo = y * ref.width; for (let x = 0; x < ref.width; x++) if (r.data[ro + x] !== want[wo + x]) bad++; }
              expect(bad, 'sensor values differing from LibRaw').toBe(0);
              expect(r.white[0], 'white level: the file\'s own, or the bit depth\'s (LibRaw\'s camera table may say a little less)').toBeGreaterThanOrEqual(ref.white); expect(r.white[0]).toBeLessThanOrEqual(ref.white * 1.05 + 1);
              // The Bayer pattern at LibRaw's visible origin, by color (LibRaw's 3 is the second green).
              const at = (yy: number, xx: number) => r.cfa![((yy + ref.top) & 1) * 2 + ((xx + ref.left) & 1)];
              expect([at(0, 0), at(0, 1), at(1, 0), at(1, 1)]).toEqual(ref.pattern.flat().map((c) => (c === 3 ? 1 : c)));
            }
          }
        }
        if (!isDng(u8)) {
          const previews = findEmbeddedJpegs(u8);
          if (previews.length) expect(Math.max(...previews.map((p) => p.width))).toBeGreaterThan(100);
          else { const t = await tiffThumbnail(u8); if (!NO_PREVIEW.has(id!.family)) { expect(t, 'an uncompressed TIFF thumbnail when there is no JPEG').toBeTruthy(); expect(t!.page.width).toBeGreaterThan(50); } else expect(t).toBeNull(); }
        }
      } else if (f.format === 'fits') {
        expect(isFits(u8)).toBe(true);
        expect(sniff(u8, f.name)?.id).toBe('fits');
        let d: ReturnType<typeof decodeFits> | null = null, err = '';
        try { d = decodeFits(u8, f.name); } catch (e: any) { err = e?.message || String(e); }
        if (d) { expect(d.pages.length).toBeGreaterThan(0); expect(d.pages[0].width).toBeGreaterThan(0); }
        else expect(err, 'a table-only sample is reported as such').toMatch(/holds no image/);
      }
    });
  }
  for (const d of manifest?.damaged || []) {
    it(`${d.name}: a ${d.damage} copy of ${d.from} decodes or fails cleanly`, { timeout: 60000 }, () => {
      const u8 = fx(d.name), t0 = Date.now();
      try {
        if (isFits(u8) || /\.fits?$/i.test(d.name)) { const r = decodeFits(u8, d.name); expect(r.pages.length).toBeGreaterThan(0); }
        else { identifyRaw(u8, d.name); findEmbeddedJpegs(u8); if (isDng(u8)) readDng(u8); }
      } catch (e) { expect(e, 'a plain Error, not a crash').toBeInstanceOf(Error); expect((e as Error).message).not.toMatch(/undefined|null|NaN/); }
      expect(Date.now() - t0, 'finishes in time').toBeLessThan(45000);
    });
  }
});
