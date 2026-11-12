import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { decodeDicom, isDicom, isRawDicom, NOT_FOR_DIAGNOSIS, isPresentationState, readPresentationState, dumpDicom, dicomSopInstanceUid } from '../../src/codecs/dicom';
import { decodePicture, decodeOptions } from '../../src/codecs/registry';
import { decodePngTolerant } from '../../src/codecs/png';
import { sniff } from '../../src/codecs/registry';
import { setOpenJpeg } from '../../src/codecs/openjpeg16';
import { createRequire } from 'node:module';

let pdfjs: any;
beforeAll(async () => {
  const path = 'pdfjs-dist/image_decoders/pdf.image_decoders.mjs';
  pdfjs = await import(/* @vite-ignore */ path);
  const W = 'node_modules/pdfjs-dist/wasm/';
  pdfjs.JpxImage.setOptions({ useWasm: true, useWorkerFetch: false, wasmUrl: '', getHandler: () => ({ sendWithPromise: async (_k: string, { filename }: { filename: string }) => new Uint8Array(readFileSync(W + filename)) }) });
  const factory = createRequire(import.meta.url)(process.cwd() + '/node_modules/@cornerstonejs/codec-openjpeg/dist/openjpegjs_decode.js'); // by file (package exports hide it)
  openjpeg = await factory({ wasmBinary: readFileSync('node_modules/@cornerstonejs/codec-openjpeg/dist/openjpegwasm_decode.wasm'), print: () => {}, printErr: () => {} });
  setOpenJpeg(openjpeg);
});
let openjpeg: any;
const DIR = 'tests/fixtures/dicom/';
const fx = (n: string) => new Uint8Array(readFileSync(DIR + n));
const ref = (n: string) => decodePngTolerant(fx(n)).pages[0].frames[0].raster;
const expected: Record<string, { frames: number; width: number; height: number; pi: string; ts: string | null; what: string; unsupported?: string; references?: string; superimposed?: string; annotations?: boolean }> = JSON.parse(readFileSync(DIR + 'expected.json', 'utf8'));

/** Mean and greatest absolute difference over the RGB channels. */
function diff(a: { width: number; height: number; data: Uint8ClampedArray }, b: { width: number; height: number; data: Uint8ClampedArray }): { mean: number; max: number } {
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  let sum = 0, max = 0, n = 0;
  for (let i = 0; i < a.data.length; i += 4) for (let c = 0; c < 3; c++) { const d = Math.abs(a.data[i + c] - b.data[i + c]); sum += d; n++; if (d > max) max = d; }
  return { mean: sum / n, max };
}
// Tolerances: exact (rounding aside) for native, RLE, lossless, JPEG 2000 and palette pixel data; a little for DCT
// JPEGs: pdf.js's and the app's IDCTs differ from libjpeg's by a level, and pdf.js replicates subsampled chroma where
// libjpeg interpolates it, which shows at sharp color edges (the dcmtk 4:2:2 test pattern).
const TOL: Record<string, [number, number]> = { '1.2.840.10008.1.2.4.50': [3, 80], '1.2.840.10008.1.2.4.51': [0.6, 4] };

describe('DICOM (pydicom test files and files written with pydicom)', () => {
  it('is recognized by the Part 10 header, and raw data sets by their first element', () => {
    expect(isDicom(fx('CT_small.dcm'))).toBe(true);
    expect(isDicom(fx('raw-noheader.dcm'))).toBe(false);
    expect(isRawDicom(fx('raw-noheader.dcm'))).toBe(true);
    expect(isRawDicom(fx('CT_small.dcm'))).toBe(false);
    expect(sniff(fx('MR_small.dcm'), 'x.bin')?.id).toBe('dicom');
    expect(sniff(fx('raw-noheader.dcm'), 'scan.dcm')?.id).toBe('dicom');
    expect(sniff(fx('raw-noheader.dcm'), 'scan.bin')?.id ?? null).not.toBe('dicom');
  });
  for (const [name, e] of Object.entries(expected)) {
    if (e.unsupported) continue;
    it(`${name}: ${e.what}`, async () => {
      let d;
      if (e.references) {
        const ps = readPresentationState(fx(name), name);
        const superimposed = e.superimposed ? (await decodeDicom(fx(e.superimposed), pdfjs, { window: ps.blend?.window })).pages[0].frames[0].raster : undefined; // a blending state's second picture
        d = await decodeDicom(fx(e.references), pdfjs, { presentation: ps, superimposed });
      } else d = await decodeDicom(fx(name), pdfjs);
      if (e.annotations) { expect(d.pages.length).toBe(e.frames); expect([d.pages[0].width, d.pages[0].height]).toEqual([e.width, e.height]); return; } // checked pixel by pixel below
      expect(d.pages.length).toBe(e.frames);
      expect([d.pages[0].width, d.pages[0].height]).toEqual([e.width, e.height]);
      const [meanTol, maxTol] = TOL[e.ts || ''] || [0.05, 1];
      for (const f of e.frames > 1 ? [0, e.frames - 1] : [0]) {
        const png = e.frames > 1 ? `${name.slice(0, -4)}.f${f}.png` : `${name.slice(0, -4)}.png`;
        expect(existsSync(DIR + png), png).toBe(true);
        const r = diff(d.pages[f].frames[0].raster, ref(png));
        expect(r.mean, `${name} frame ${f} mean`).toBeLessThanOrEqual(meanTol);
        expect(r.max, `${name} frame ${f} max`).toBeLessThanOrEqual(maxTol);
      }
      expect(d.info.notice).toBe(NOT_FOR_DIAGNOSIS);
      expect(d.pages[0].notes.at(-1)).toBe(NOT_FOR_DIAGNOSIS);
    });
  }
  it('Window / Level: a window of the user\'s replaces the file\'s (and its VOI LUT); \'full\' shows the whole range', async () => {
    const file = await decodeDicom(fx('ct-window.dcm'), pdfjs), own = await decodeDicom(fx('ct-window.dcm'), pdfjs, { window: { wc: 100, ww: 600 } }), full = await decodeDicom(fx('ct-window.dcm'), pdfjs, { window: 'full' });
    expect(file.info.window).toBe('center 40, width 400 (first of 2)');
    expect(own.info.window).toBe('center 100, width 600 (Window / Level)');
    expect(own.info['file window']).toBe('center 40, width 400');
    expect(full.info.window).toBe('the full range (Window / Level)');
    expect(own.pages[0].notes).toContain('window center 100, width 600, after the rescale');
    expect(full.pages[0].notes.some((n) => /^shown over the frame's range/.test(n))).toBe(true);
    const px = (d: typeof file, i: number) => d.pages[0].frames[0].raster.data[i * 4];
    let diff = 0; for (let i = 0; i < 48 * 32; i++) if (px(file, i) !== px(own, i)) diff++;
    expect(diff).toBeGreaterThan(100);
    const sig = await decodeDicom(fx('ct-window.dcm'), pdfjs, { window: { wc: 40, ww: 400, fn: 'sigmoid' } });
    expect(sig.info.window).toBe('center 40, width 400 (SIGMOID) (Window / Level)');
    const lut = await decodeDicom(fx('luts.dcm'), pdfjs, { window: { wc: 100, ww: 200 } });
    expect(lut.pages[0].notes.some((n) => /VOI lookup table/.test(n))).toBe(false); // the user's window sets the file's VOI LUT aside
  });
  it('DICOM Tags: every element named, sequences nested, values as text', () => {
    const { rows, transferSyntax } = dumpDicom(fx('ct-window.dcm'));
    expect(transferSyntax).toBe('1.2.840.10008.1.2.1');
    const by = (tag: string) => rows.find((r) => r.tag === tag && r.depth === 0)!;
    expect(by('(0002,0010)').value).toBe('1.2.840.10008.1.2.1 (explicit VR little endian)');
    expect([by('(0010,0010)').name, by('(0010,0010)').vr, by('(0010,0010)').value]).toEqual(['Patient\'s Name', 'PN', 'Lens^Anne']);
    expect([by('(0028,0010)').name, by('(0028,0010)').value, by('(0028,1050)').value]).toEqual(['Rows', '32', '40.0\\300.0']);
    expect(by('(7fe0,0010)').value).toMatch(/^\d+ bytes \(/);
    const ps = dumpDicom(fx('gsps-annot.dcm')).rows;
    const seq = ps.find((r) => r.tag === '(0070,0001)')!;
    expect([seq.name, seq.vr, seq.value]).toEqual(['Graphic Annotation Sequence', 'SQ', '1 item']);
    expect(ps.some((r) => r.name === 'item 1' && r.depth === 1)).toBe(true);
    expect(ps.some((r) => r.tag === '(0070,0023)' && r.depth >= 2 && r.value === 'POLYLINE')).toBe(true);
    const txt = rows.map((r) => `${r.tag} ${r.vr} ${r.name}`).join('\n');
    expect(txt).toContain('(0008,0060) CS Modality');
  });
  it('names the transfer syntax, the window, the rescale and the patient in the details', async () => {
    const d = await decodeDicom(fx('ct-window.dcm'), pdfjs);
    expect(d.info.modality).toBe('CT');
    expect(d.info.kind).toBe('Secondary capture');
    expect(d.info.patient).toBe('Lens Anne');
    expect(d.info['patient ID']).toBe('AL-0001');
    expect(d.info['study date']).toBe('2024-03-11');
    expect(d.info['transfer syntax']).toBe('explicit VR little endian (1.2.840.10008.1.2.1)');
    expect(d.info.window).toBe('center 40, width 400 (first of 2)');
    expect(d.info.rescale).toBe('× 1 + -1024 (Hounsfield units)');
    expect(d.info['pixel spacing']).toBe('0.5 × 0.5 mm');
    expect(d.info['slice thickness']).toBe('2.5 mm');
    expect(d.info['body part']).toBe('CHEST');
    expect(d.info.pixels).toBe('monochrome, 12 of 16 bits, MONOCHROME2');
    expect(d.pages[0].dpi).toEqual([50.8, 50.8]);
    const pc = readPresentationState(fx('pcsps.dcm'), 'pcsps.dcm'); // pseudo-color: the state's palette over the presentation values
    expect(isPresentationState(fx('pcsps.dcm'))).toBe(true);
    expect([pc.palette?.n, pc.palette?.first, pc.window]).toEqual([256, 0, { wc: 100, ww: 600, fn: 'LINEAR' }]);
    const pcd = await decodeDicom(fx('ct-window.dcm'), pdfjs, { presentation: pc });
    const bs = readPresentationState(fx('bsps.dcm'), 'bsps.dcm'); // blending: a second picture through its palette over the first
    expect(isPresentationState(fx('bsps.dcm'))).toBe(true);
    expect(bs.window).toEqual({ wc: 100, ww: 600, fn: 'LINEAR' }); expect(bs.references.length).toBe(1);
    expect(bs.blend!.opacity).toBeCloseTo(0.6, 5); expect(bs.blend!.window).toEqual({ wc: 1200, ww: 2400, fn: 'LINEAR' }); expect(bs.blend!.references.length).toBe(1); expect(bs.blend!.palette!.n).toBe(256);
    const pet = (await decodeDicom(fx('pet-blob.dcm'), pdfjs, { window: bs.blend!.window })).pages[0].frames[0].raster;
    const bd = await decodeDicom(fx('ct-window.dcm'), pdfjs, { presentation: bs, superimposed: pet });
    expect(bd.pages[0].notes).toContain('presentation state FIXTURE (blending: the PET blob through the WINTER palette at opacity 0.6 over the CT windowed 100/600) applied: window center 100, width 600, the superimposed picture through its palette (256 entries) at opacity 0.60');
    const alone = await decodeDicom(fx('ct-window.dcm'), pdfjs, { presentation: bs }); // without the second picture: a warning, the CT alone
    expect(alone.warnings.some((w) => /superimposed picture .* is not in this folder/.test(w))).toBe(true);
    expect(pcd.pages[0].notes).toContain('presentation state FIXTURE (pseudo-color: window 100/600 through the segmented WINTER palette) applied: window center 100, width 600, pseudo-color palette (256 entries)');
    expect(d.pages[0].notes[0]).toBe('window center 40, width 400, after the rescale');
    expect(d.warnings).toEqual([]);
  });
  it('frames become pages, each with its number', async () => {
    const d = await decodeDicom(fx('frames.dcm'), pdfjs);
    expect(d.pages.map((p) => p.notes[0])).toEqual(['frame 1 of 4', 'frame 2 of 4', 'frame 3 of 4', 'frame 4 of 4']);
    expect(d.info.pixels).toBe('monochrome, 8 of 8 bits, MONOCHROME2, 4 frames');
    const r = await decodeDicom(fx('rtdose.dcm'), pdfjs, { maxFrames: 5 });
    expect(r.pages.length).toBe(5);
    expect(r.warnings).toEqual(['Only the first 5 of 15 frames are shown']);
  });
  it('explains what it cannot open', async () => {
    setOpenJpeg(null);
    try { await expect(decodeDicom(fx('MR_small_jp2klossless.dcm'), null)).rejects.toThrow(/JPEG 2000 lossless pixel data needs the JPEG decoders/); } finally { setOpenJpeg(openjpeg); }
    await expect(decodeDicom(fx('jpeg-gray.dcm'), null)).rejects.toThrow(/JPEG baseline pixel data needs the JPEG decoders/);
    expect((await decodeDicom(fx('JPGExtended.dcm'), null)).pages.length).toBe(1); // 12-bit JPEG: the app's own decoder
    await expect(decodeDicom(fx('CT_small.dcm').subarray(0, 300), pdfjs)).rejects.toThrow(/no picture|No DICOM data set/);
    const cut = await decodeDicom(fx('frames.dcm').subarray(0, fx('frames.dcm').length - 24 * 16 * 2 - 10), pdfjs);
    expect(cut.pages.length).toBe(2);
    expect(cut.warnings).toEqual(['The pixel data ends after frame 2 of 4']);
  });
  it('JPEG-LS: near-lossless files say so; lookup tables and overlay planes are applied and described', async () => {
    const j = await decodeDicom(fx('jls-12bit-near.dcm'), pdfjs);
    expect(j.info['lossy compression']).toBe('JPEG-LS near-lossless, error up to 2');
    expect(j.info['transfer syntax']).toBe('JPEG-LS near-lossless (1.2.840.10008.1.2.4.81)');
    expect((await decodeDicom(fx('MR_small_jpeg_ls_lossless.dcm'), pdfjs)).info['lossy compression']).toBeUndefined();
    const l = await decodeDicom(fx('luts.dcm'), pdfjs);
    expect(l.info['modality LUT']).toBe('4096 entries from 0 (square root)');
    expect(l.info['VOI LUT']).toBe('2048 entries from 1024 (gamma 2.2); used instead of the window');
    expect(l.pages[0].notes[0]).toBe("the file's VOI lookup table (2048 entries, gamma 2.2) applied, after the modality lookup table");
    const o = await decodeDicom(fx('overlay.dcm'), pdfjs);
    expect(o.info.overlays).toBe('16 × 20 at (12, 6)');
    expect(o.pages[0].notes).toContain('1 overlay plane drawn in white');
    const off = await decodeDicom(fx('overlay.dcm'), pdfjs, { overlays: false }); // View ▸ DICOM Overlay Planes off
    expect(off.pages[0].notes).toContain('1 overlay plane not drawn (View ▸ DICOM Overlay Planes)');
    expect(off.pages[0].notes).not.toContain('1 overlay plane drawn in white');
    const a = o.pages[0].frames[0].raster.data, b = off.pages[0].frames[0].raster.data;
    let onlyOn = 0, onlyOff = 0;
    for (let i = 0; i < a.length; i += 4) { if (a[i] === 255 && b[i] !== 255) onlyOn++; if (b[i] === 255 && a[i] !== 255) onlyOff++; }
    expect(onlyOn).toBeGreaterThan(0); // the plane's set bits were white
    expect(onlyOff).toBe(0);
    const e = await decodeDicom(fx('overlay-embedded.dcm'), pdfjs);
    expect(e.info.overlays).toBe('20 × 24 at (1, 1) (embedded)');
    expect(e.pages[0].notes).toContain('1 overlay plane drawn in white');
    expect(e.warnings).toEqual([]);
  });
  it('1-bit frames that do not end on a byte boundary (3 × 5 pixels: a segmentation written by pydicom)', async () => {
    const want: number[][][] = JSON.parse(readFileSync('tests/fixtures/dicom/seg-1bit-frames.json', 'utf8'));
    const d = await decodeDicom(fx('seg-1bit-frames.dcm'), pdfjs);
    const pages = d.pages.length === want.length ? d.pages : null, frames = pages ? pages.map((p) => p.frames[0]) : d.pages[0].frames;
    expect(frames.length).toBe(want.length);
    frames.forEach((fr, f) => {
      const r = fr.raster!, got = Array.from({ length: 3 }, (_, y) => Array.from({ length: 5 }, (_, x) => (r.data[(y * 5 + x) * 4] > 127 ? 1 : 0)));
      expect(got, `frame ${f + 1}`).toEqual(want[f]);
    });
  });
  it('presentation states in implicit VR (the default transfer syntax; copies written by pydicom) read as the explicit ones do', async () => {
    for (const n of ['gsps', 'gsps-annot']) {
      const ex = readPresentationState(fx(`${n}.dcm`), 'x'), im = readPresentationState(fx(`${n}-implicit.dcm`), 'x');
      expect(isPresentationState(fx(`${n}-implicit.dcm`)), n).toBe(true);
      expect(JSON.parse(JSON.stringify(im)), n).toEqual(JSON.parse(JSON.stringify(ex)));
      const a = (await decodeDicom(fx('ct-window.dcm'), pdfjs, { presentation: ex })).pages[0].frames[0].raster, b = (await decodeDicom(fx('ct-window.dcm'), pdfjs, { presentation: im })).pages[0].frames[0].raster;
      expect([b.width, b.height], n).toEqual([a.width, a.height]);
      let diff = 0; for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) diff++;
      expect(diff, n).toBe(0);
    }
  });
  it('presentation states: recognized, read, applied with their annotations; the referenced picture is found among the folder\'s files', async () => {
    expect(isPresentationState(fx('gsps.dcm'))).toBe(true);
    expect(isPresentationState(fx('ct-window.dcm'))).toBe(false);
    const ps = readPresentationState(fx('gsps.dcm'), 'gsps.dcm');
    expect(ps.label).toBe('FIXTURE');
    expect(ps.window).toEqual({ wc: 100, ww: 600, fn: 'LINEAR' });
    expect([ps.inverse, ps.flip, ps.rotation, ps.shutters.length, ps.area]).toEqual([true, true, 90, 1, { tl: [3, 2], br: [46, 31] }]);
    const d = await decodeDicom(fx('ct-window.dcm'), pdfjs, { presentation: ps });
    expect(d.pages[0].notes).toContain('presentation state FIXTURE (window 100/600, inverse presentation LUT, rectangular shutter, displayed area, rotation 90 and horizontal flip) applied: window center 100, width 600, inverse presentation, rectangular shutter, displayed area 44 × 30, rotation 90°, horizontal flip'); // in the order applied: the rotation before the flip (PS3.3 C.10.6)
    expect(d.info['presentation state']).toBe('gsps.dcm (FIXTURE)');
    // The picture against one computed by the standard's rules (scripts/gen-dicom-fixtures.py with numpy): window,
    // inverse, shutter, displayed area, then the 90° clockwise rotation, then the horizontal flip (PS3.3 C.10.6).
    const want = ref('gsps.png'), got = d.pages[0].frames[0].raster;
    expect([got.width, got.height]).toEqual([want.width, want.height]);
    expect(diff(got, want).max).toBeLessThanOrEqual(1);
    // MONOCHROME1 is ignored under a presentation state (PS3.4 N.2): only the presentation LUT shape decides.
    const m1 = fx('ct-window.dcm').slice(); const at = new TextDecoder('latin1').decode(m1).indexOf('MONOCHROME2'); m1.set(new TextEncoder().encode('MONOCHROME1'), at);
    expect(diff((await decodeDicom(m1, pdfjs, { presentation: ps })).pages[0].frames[0].raster, got).max).toBe(0);
    expect(diff((await decodeDicom(m1, pdfjs)).pages[0].frames[0].raster, (await decodeDicom(fx('ct-window.dcm'), pdfjs)).pages[0].frames[0].raster).max).toBe(255); // without one, MONOCHROME1 still inverts
    // Displayed-area corners name the pixels that end up top left and bottom right, so either may be the smaller.
    const swapped = { ...ps, area: { tl: ps.area!.br, br: ps.area!.tl } };
    expect(diff((await decodeDicom(fx('ct-window.dcm'), pdfjs, { presentation: swapped })).pages[0].frames[0].raster, got).max).toBe(0);
    expect(d.pages[0].dpi).toEqual([50.8, 50.8]);
    const a = await decodeDicom(fx('ct-window.dcm'), pdfjs, { presentation: readPresentationState(fx('gsps-annot.dcm'), 'gsps-annot.dcm') });
    const r = a.pages[0].frames[0].raster, px = (x: number, y: number) => r.data[(y * r.width + x) * 4];
    expect(px(8, 8)).toBe(191); // inside the filled rectangle (layer gray 0xC000 → 191)
    expect(px(36, 10)).toBe(191); // on the circle
    expect(px(44, 26)).toBe(191); // the ellipse's major-axis end
    expect(px(2, 30)).toBe(191); // the point's marker
    expect(px(30, 10)).toBe(191); // the text's anchor marker
    expect(px(18, 1)).toBe(191); // the text's bounding box
    expect(px(40, 20)).not.toBe(191); // untouched picture
    expect(a.info.annotations).toBe('Lesion');
    expect(a.warnings).toEqual(["The presentation state's text could not be drawn here (no text renderer); its words are in the details"]);
    expect(a.pages[0].notes.some((n) => /applied: 5 graphic objects and 1 text$/.test(n))).toBe(true);
    // Through the registry: the state's picture is looked up among the entries of its folder (the browser e2e opens one; here the miss).
    const mk = (n: string) => ({ name: n, uri: null, size: fx(n).length, read: async () => fx(n).buffer as ArrayBuffer });
    decodeOptions.siblings = (e) => (e.name === 'gsps-missing.dcm' ? [mk('jls-12bit-near.dcm'), mk('ct-window.dcm')] : []);
    try {
      await expect(decodePicture(fx('gsps-missing.dcm'), mk('gsps-missing.dcm'))).rejects.toThrow(/gsps-missing\.dcm is a presentation state \(FIXTURE\): display settings for a picture in another DICOM file, which is not in this folder \(SOP instance 1\.2\.826\.0\.1\.3680043\.8\.498\.99999999999999999999\)/);
    } finally { decodeOptions.siblings = null; }
    // The picture found under a UID name (as PACS exports write them) beside a Siemens .IMA file and a note; each
    // sibling's UID is read once, so opening the state again reads only the picture it needs.
    const reads: Record<string, number> = {};
    const as = (name: string, from: string, mtime = 1) => ({ name, uri: null, size: fx(from).length, mtime, read: async () => { reads[name] = (reads[name] || 0) + 1; return fx(from).buffer as ArrayBuffer; } });
    const folder = [as('IM0001.IMA', 'jls-12bit-near.dcm'), as('1.2.826.0.1.3680043.8.498.77', 'ct-window.dcm'), as('notes.txt', 'ct-window.dcm')];
    const { findReferenced, dicomLikeName } = await import('../../src/codecs/registry');
    const candidates = folder.filter((e) => dicomLikeName(e.name)), refs = readPresentationState(fx('gsps.dcm'), 'gsps.dcm').references;
    expect(candidates.map((e) => e.name)).toEqual(['IM0001.IMA', '1.2.826.0.1.3680043.8.498.77']);
    const first = await findReferenced(candidates, refs, dicomSopInstanceUid);
    expect(first?.entry.name).toBe('1.2.826.0.1.3680043.8.498.77'); expect(first?.bytes.length).toBe(fx('ct-window.dcm').length);
    const before = { ...reads };
    await findReferenced(candidates, refs, dicomSopInstanceUid);
    expect(reads['IM0001.IMA']).toBe(before['IM0001.IMA']);                        // known not to be the one: not read again
    expect(reads['1.2.826.0.1.3680043.8.498.77']).toBe(before['1.2.826.0.1.3680043.8.498.77'] + 1); // the picture itself, for its pixels
    expect(reads['notes.txt']).toBeUndefined();
  });
  it('MONOCHROME1 is inverted and the first window of several is used; the JPEG 2000 depth note', async () => {
    const m = await decodeDicom(fx('mono1.dcm'), pdfjs);
    expect(m.pages[0].notes).toContain('MONOCHROME1: low values are bright');
    setOpenJpeg(null); // without the full-precision decoder: pdf.js's 8-bit samples, said so in the notes
    try {
      const j = await decodeDicom(fx('j2k-12bit.dcm'), pdfjs);
      expect(j.pages[0].notes.some((n) => /full-precision JPEG 2000 decoder was not available.*steps of 256$/.test(n))).toBe(true);
      const r = diff(j.pages[0].frames[0].raster, ref('j2k-12bit.png'));
      expect(r.max).toBeLessThanOrEqual(24);
      const s = await decodeDicom(fx('693_J2KI.dcm'), pdfjs);
      expect(s.pages[0].notes.some((n) => /and negative values are lost$/.test(n))).toBe(true);
    } finally { setOpenJpeg(openjpeg); }
  });
});
