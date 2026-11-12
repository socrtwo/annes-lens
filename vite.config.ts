import { defineConfig } from 'vite';

import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const here = dirname(fileURLToPath(import.meta.url));

/**
 * On-device runtimes: ONNX Runtime Web (AI models), Tesseract (OCR, with the English language
 * data), zxing (barcodes), pdf.js (PDF pages, JPEG 2000) and the JPEG XL and AVIF decoders. With QN_ORT_LOCAL=1 (the desktop build; its Content Security Policy
 * only allows the app's own scripts) they are copied into dist/ and listed in dist/runtimes.json,
 * which src/platform/runtimes.ts reads; without it the app loads them from their pinned CDN
 * addresses. `npm run e2e` stages the same files itself.
 */
export const ORT_FILES = ['ort.webgpu.bundle.min.mjs', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.jspi.mjs', 'ort-wasm-simd-threaded.jspi.wasm', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];
export const LOCAL_RUNTIMES: { from: string; to: string; files: string[]; dirs?: string[] }[] = [
  { from: 'node_modules/onnxruntime-web/dist', to: 'ort', files: ORT_FILES },
  { from: 'node_modules/tesseract.js/dist', to: 'ocr', files: ['tesseract.esm.min.js', 'worker.min.js'] },
  { from: 'node_modules/tesseract.js-core', to: 'ocr/core', files: ['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js'] },
  { from: 'node_modules/@tesseract.js-data/eng/4.0.0_best_int', to: 'ocr/lang', files: ['eng.traineddata.gz'] },
  { from: 'node_modules/zxing-wasm/dist/reader', to: 'zxing', files: ['zxing_reader.wasm'] },
  // pdf.js: the library and its worker, its standalone image decoders (JPEG 2000 files), the WebAssembly decoders
  // (JPEG 2000, JBIG2, color management), CMaps and standard fonts.
  { from: 'node_modules/pdfjs-dist', to: 'pdf', files: ['build/pdf.min.mjs', 'build/pdf.worker.min.mjs', 'image_decoders/pdf.image_decoders.min.mjs', 'LICENSE'], dirs: ['wasm', 'cmaps', 'standard_fonts', 'iccs'] },
  // JPEG XL (jxl-oxide) and AVIF (libavif with libaom, from jSquash) decoders, for platforms that lack them.
  { from: 'node_modules/jxl-oxide-wasm', to: 'jxl', files: ['jxl_oxide_wasm.js', 'jxl_oxide_wasm_bg.wasm', 'LICENSE-MIT', 'LICENSE-APACHE'] },
  { from: 'node_modules/@jsquash/avif', to: 'avif', files: ['decode.js', 'utils.js', 'codec/dec/avif_dec.js', 'codec/dec/avif_dec.wasm', 'LICENSE'] },
  // OpenJPH (HTJ2K) for OpenEXR's HTJ2K compression.
  { from: 'node_modules/@cornerstonejs/codec-openjph', to: 'openjph', files: ['dist/openjphjs.js', 'dist/openjphjs.wasm', 'LICENSE'] },
  // OpenJPEG (decode-only build) for JPEG 2000 pixel data at full precision in DICOM files.
  { from: 'node_modules/@cornerstonejs/codec-openjpeg', to: 'openjpeg', files: ['dist/openjpegjs_decode.js', 'dist/openjpegwasm_decode.wasm', 'LICENSE'] },
  // Transformers.js (on-device picture generation) with the ONNX Runtime Web build it bundles (its own version, beside the app's).
  { from: 'node_modules/@huggingface/transformers/dist', to: 'transformers', files: ['transformers.min.js', 'ort-wasm-simd-threaded.jsep.mjs'] },
  { from: 'node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist', to: 'transformers', files: ['ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.jspi.wasm'] },
  { from: 'node_modules/@huggingface/transformers', to: 'transformers', files: ['LICENSE'] },
  // djvu-rs (DjVu): its loader picks the SIMD or the scalar WebAssembly build.
  { from: 'node_modules/djvu-rs', to: 'djvu', files: ['djvu_rs.js', 'scalar/djvu_rs.js', 'scalar/djvu_rs_bg.wasm', 'simd128/djvu_rs.js', 'simd128/djvu_rs_bg.wasm', 'LICENSE', 'THIRD_PARTY_NOTICES'] },
];
export const RUNTIME_MANIFEST = { ort: 'ort/', ocr: 'ocr/', zxing: 'zxing/', pdf: 'pdf/', jxl: 'jxl/', avif: 'avif/', openjph: 'openjph/', openjpeg: 'openjpeg/', djvu: 'djvu/', transformers: 'transformers/', ocrLangs: ['eng'] };
export function stageRuntimes(dist: string): void {
  for (const r of LOCAL_RUNTIMES) {
    const out = join(dist, r.to); mkdirSync(out, { recursive: true });
    for (const f of r.files) if (existsSync(join(here, r.from, f))) { mkdirSync(dirname(join(out, f)), { recursive: true }); copyFileSync(join(here, r.from, f), join(out, f)); }
    for (const d of r.dirs || []) if (existsSync(join(here, r.from, d))) cpSync(join(here, r.from, d), join(out, d), { recursive: true });
  }
  writeFileSync(join(dist, 'runtimes.json'), JSON.stringify(RUNTIME_MANIFEST));
}
function localRuntimes() {
  return {
    name: 'annes-lens-local-runtimes',
    closeBundle() { if (process.env.QN_ORT_LOCAL === '1') stageRuntimes(join(here, 'dist')); },
  };
}

/**
 * The service worker learns the release's own files: dist/sw.js (copied from public/) gets the list
 * of the page, its icons and every built script, stylesheet and font, and a cache name made from that
 * list, so a new release replaces the old cache instead of adding to it.
 */
export function precacheList(dist: string): string[] {
  const out = ['./', './index.html'];
  for (const f of ['manifest.webmanifest', 'favicon.svg']) if (existsSync(join(dist, f))) out.push(`./${f}`);
  for (const dir of ['icons', 'assets']) if (existsSync(join(dist, dir))) for (const f of readdirSync(join(dist, dir)).sort()) if (!f.endsWith('.map')) out.push(`./${dir}/${f}`);
  return out;
}
export function writeServiceWorker(dist: string): void {
  const sw = join(dist, 'sw.js');
  if (!existsSync(sw)) return;
  const list = precacheList(dist);
  const name = 'quilllens-' + createHash('sha256').update(list.join('\n')).update(readFileSync(join(dist, 'index.html'))).digest('hex').slice(0, 12);
  let text = readFileSync(sw, 'utf8');
  const before = text;
  text = text.replace(/\/\* precache \*\/ \[[^\]]*\]/, () => `/* precache */ ${JSON.stringify(list)}`).replace(/\/\* cache \*\/ '[^']*'/, () => `/* cache */ '${name}'`);
  if (text === before) throw new Error('public/sw.js: the precache list or cache name placeholder is missing');
  writeFileSync(sw, text);
}
function serviceWorker() {
  return { name: 'annes-lens-service-worker', apply: 'build' as const, closeBundle() { writeServiceWorker(join(here, 'dist')); } };
}

export default defineConfig({
  plugins: [localRuntimes(), serviceWorker()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version), __QN_TEST_HOOKS__: JSON.stringify(process.env.QN_TEST_HOOKS === '1' || process.env.VITEST === 'true') },
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    assetsInlineLimit: 0,
  },
  worker: { format: 'es' },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.ts'],
  },
} as any);
