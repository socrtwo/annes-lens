// Browser smoke test: serves dist/ with `vite preview`, opens generated pictures through the drop command,
// walks the folder, zooms, rotates, undoes, reads pixel info, switches menus and saves a copy.
// Usage: npm run build:test && npm run e2e   (set QN_URL to test an already-running server instead)
import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { startMockAi } from './mockAi.mjs';
import { startRelay } from '../../scripts/relay.mjs';

// The on-device runtimes (ONNX Runtime, Tesseract with English, zxing) and the tiny AI fixture models
// are staged into dist/ with a runtimes.json, as the desktop build does (never committed there).
const LOCAL_RUNTIMES = [
  ['node_modules/onnxruntime-web/dist', 'ort', ['ort.webgpu.bundle.min.mjs', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.jspi.mjs', 'ort-wasm-simd-threaded.jspi.wasm', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']],
  ['node_modules/tesseract.js/dist', 'ocr', ['tesseract.esm.min.js', 'worker.min.js']],
  ['node_modules/tesseract.js-core', 'ocr/core', ['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js']],
  ['node_modules/@tesseract.js-data/eng/4.0.0_best_int', 'ocr/lang', ['eng.traineddata.gz']],
  ['node_modules/zxing-wasm/dist/reader', 'zxing', ['zxing_reader.wasm']],
  ['node_modules/pdfjs-dist', 'pdf', ['build/pdf.min.mjs', 'build/pdf.worker.min.mjs', 'image_decoders/pdf.image_decoders.min.mjs'], ['wasm', 'cmaps', 'standard_fonts', 'iccs']],
  ['node_modules/jxl-oxide-wasm', 'jxl', ['jxl_oxide_wasm.js', 'jxl_oxide_wasm_bg.wasm']],
  ['node_modules/@jsquash/avif', 'avif', ['decode.js', 'utils.js', 'codec/dec/avif_dec.js', 'codec/dec/avif_dec.wasm']],
  ['node_modules/@cornerstonejs/codec-openjph', 'openjph', ['dist/openjphjs.js', 'dist/openjphjs.wasm']],
  ['node_modules/@cornerstonejs/codec-openjpeg', 'openjpeg', ['dist/openjpegjs_decode.js', 'dist/openjpegwasm_decode.wasm']],
  ['node_modules/djvu-rs', 'djvu', ['djvu_rs.js', 'scalar/djvu_rs.js', 'scalar/djvu_rs_bg.wasm', 'simd128/djvu_rs.js', 'simd128/djvu_rs_bg.wasm']],
];
if (existsSync('dist')) {
  for (const [from, to, files, dirs = []] of LOCAL_RUNTIMES) {
    mkdirSync(`dist/${to}`, { recursive: true });
    for (const f of files) if (existsSync(`${from}/${f}`)) { mkdirSync(dirname(`dist/${to}/${f}`), { recursive: true }); copyFileSync(`${from}/${f}`, `dist/${to}/${f}`); }
    for (const d of dirs) if (existsSync(`${from}/${d}`)) cpSync(`${from}/${d}`, `dist/${to}/${d}`, { recursive: true });
  }
  writeFileSync('dist/runtimes.json', JSON.stringify({ ort: 'ort/', ocr: 'ocr/', zxing: 'zxing/', pdf: 'pdf/', jxl: 'jxl/', avif: 'avif/', openjph: 'openjph/', openjpeg: 'openjpeg/', djvu: 'djvu/', ocrLangs: ['eng'] }));
  mkdirSync('dist/ai-fixtures', { recursive: true });
  for (const f of readdirSync('tests/fixtures/ai')) copyFileSync(`tests/fixtures/ai/${f}`, `dist/ai-fixtures/${f}`);
  // People runs the real face models: YuNet is a fixture; SFace (9.9 MB) comes from the download cache.
  const SFACE = 'node_modules/.cache/annes-lens-models/face_recognition_sface_2021dec_int8.onnx';
  if (!existsSync(SFACE)) throw new Error(`${SFACE} is missing: run python3 scripts/gen-people-fixtures.py (it downloads the face models)`);
  copyFileSync(SFACE, 'dist/ai-fixtures/face_recognition_sface_2021dec_int8.onnx');
  copyFileSync('tests/fixtures/people/face_detection_yunet_2023mar.onnx', 'dist/ai-fixtures/face_detection_yunet_2023mar.onnx');
}
const AI_PORT = 4193;
const mockAi = await startMockAi(AI_PORT, 'tests/fixtures/ai');

const relay = await startRelay(0), relayUrl = `http://127.0.0.1:${relay.port}`;
const PORT = 4192;
let server = null;
let url = process.env.QN_URL;
if (!url) {
  server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore', detached: true });
  url = `http://localhost:${PORT}/`;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
}

const exe = existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {};
// Audio may play without a click (in the app, a slideshow starts from a click or a key, which allows it).
const browser = await chromium.launch({ ...exe, args: ['--autoplay-policy=no-user-gesture-required'] });
const failures = [];
const check = (name, got, want, note) => { if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}${note ? ' [' + note + ']' : ''}`); };

try {
  const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await p.addInitScript(() => localStorage.setItem('quilllens.prefs.v1', JSON.stringify({ firstRun: false })));
  await p.goto(url, { waitUntil: 'networkidle' });
  await p.waitForSelector('.qn-viewer');
  if (!(await p.evaluate(() => !!window.qn))) throw new Error('dist/ was built without the test hooks: run npm run build:test before npm run e2e');
  await p.waitForTimeout(500);

  check('commands registered', await p.evaluate(() => window.__qnAllIds.length > 70), true);
  check('menu bar', await p.evaluate(() => [...document.querySelectorAll('.ql-menubar-item')].map((b) => b.textContent)), ['File', 'Edit', 'Image', 'Options', 'View', 'AI', 'Help']);

  // Three generated pictures (PNG, JPEG, BMP via the app's writer) dropped at once.
  const opened = await p.evaluate(async () => {
    const mk = (w, h, color) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, w, h); x.fillStyle = '#fff'; x.fillRect(0, 0, 1, 1); return c; };
    const blob = (c, t, q) => new Promise((r) => c.toBlob(r, t, q));
    const { encodeCanvas } = await window.__qnCodecs();
    const files = [
      new File([await blob(mk(40, 30, '#ff0000'), 'image/png')], 'b.png', { type: 'image/png' }),
      new File([await blob(mk(640, 480, '#00ff00'), 'image/jpeg', 0.9)], 'a.jpg', { type: 'image/jpeg' }),
      new File([await encodeCanvas(mk(20, 10, '#0000ff'), 'bmp')], 'c.bmp', { type: 'image/bmp' }),
    ];
    await qn.exec('file.openDropped', files);
    await new Promise((r) => setTimeout(r, 800));
    return { n: qn.folder.length, name: qn.picture?.name, w: qn.picture?.width, fmt: qn.picture?.format.id };
  });
  check('opened', opened, { n: 3, name: 'a.jpg', w: 640, fmt: 'jpeg' });

  // Next / previous / wrap, prefetch cache.
  await p.evaluate(() => qn.exec('view.next'));
  await p.waitForTimeout(400);
  check('next', await p.evaluate(() => [qn.picture.name, qn.picture.format.id, qn.picture.decoder]), ['b.png', 'png', 'platform']);
  await p.evaluate(() => qn.exec('view.next'));
  await p.waitForTimeout(400);
  check('bmp', await p.evaluate(() => [qn.picture.name, qn.picture.width, qn.picture.height]), ['c.bmp', 20, 10]);
  check('prefetched', await p.evaluate(() => qn.tab.loader.has(qn.folder.entries[0])), true);
  await p.evaluate(() => qn.exec('view.next'));
  await p.waitForTimeout(300);
  check('wrap', await p.evaluate(() => qn.picture.name), 'a.jpg');

  // Zoom modes and pixel info.
  await p.evaluate(() => qn.exec('view.actualSize'));
  check('actual size', await p.evaluate(() => qn.viewer.zoom), 1);
  await p.evaluate(() => qn.exec('view.zoomIn'));
  check('zoom in', await p.evaluate(() => Math.round(qn.viewer.zoom * 100)), 125);
  await p.evaluate(() => qn.exec('view.fitWindow'));
  check('fit', await p.evaluate(() => qn.viewer.mode), 'fit');
  check('pixel corner', await p.evaluate(() => { const [r, g] = qn.viewer.pixelAt(0, 0); return [r > 90, g > 240]; }), [true, true]);
  check('pixel green', await p.evaluate(() => { const [r, g, b] = qn.viewer.pixelAt(300, 200); return [r < 40, g > 200, b < 40]; }), [true, true, true]);

  // Rotate, undo, redo.
  await p.evaluate(() => qn.exec('image.rotateRight'));
  check('rotated', await p.evaluate(() => [qn.picture.width, qn.picture.height, qn.tab.dirty]), [480, 640, true]);
  await p.evaluate(() => qn.exec('edit.undo'));
  check('undo', await p.evaluate(() => [qn.picture.width, qn.tab.dirty]), [640, false]);
  await p.evaluate(() => qn.exec('edit.redo'));
  check('redo', await p.evaluate(() => qn.picture.width), 480);
  await p.evaluate(() => qn.exec('image.flipH'));
  check('flip', await p.evaluate(() => qn.tab.undoLabel), 'Flip Horizontal');

  // Information dialog opens and closes; menus switch; full screen toggles.
  await p.evaluate(() => { void qn.exec('image.info'); });
  await p.waitForSelector('.ql-dialog');
  check('info rows', await p.evaluate(() => document.querySelectorAll('.ql-dialog table tr').length > 8), true);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(200);
  await p.evaluate(() => qn.exec('view.menuMode', 'classic'));
  check('classic only', await p.evaluate(() => getComputedStyle(document.querySelector('.ql-ribbon')).display), 'none');
  await p.evaluate(() => qn.exec('view.menuLayout', 'xnview'));
  check('xnview bar', await p.evaluate(() => document.querySelector('.ql-menubar-item').textContent), 'File');
  await p.evaluate(() => qn.exec('view.menuMode', 'both'));
  await p.evaluate(() => qn.exec('view.fullScreen'));
  check('full screen', await p.evaluate(() => document.body.classList.contains('ql-fullscreen')), true);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(200);
  check('full screen off', await p.evaluate(() => document.body.classList.contains('ql-fullscreen')), false);

  // Keyboard: Space moves on, Backspace back (after undoing the edits, or the save prompt would ask first).
  await p.evaluate(() => { qn.exec('edit.undo'); qn.exec('edit.undo'); });
  check('clean again', await p.evaluate(() => qn.tab.dirty), false);
  await p.evaluate(() => qn.focus());
  await p.keyboard.press('Space');
  await p.waitForTimeout(400);
  check('space', await p.evaluate(() => qn.picture.name), 'b.png');
  await p.keyboard.press('Backspace');
  await p.waitForTimeout(400);
  check('backspace', await p.evaluate(() => qn.picture.name), 'a.jpg');

  // The shortcuts stand aside for a control reached with Tab (Enter and Space press it; they do not run Full Screen or
  // Next behind it). After a click on the control the keys belong to the picture again.
  await p.evaluate(() => { const b = document.createElement('button'); b.id = 'qn-key-probe'; b.textContent = 'probe'; b.style.cssText = 'position:fixed;left:4px;bottom:4px;z-index:99999'; b.onclick = () => { window.__probeClicks = (window.__probeClicks || 0) + 1; }; document.body.appendChild(b); });
  await p.keyboard.press('Tab');
  await p.evaluate(() => document.getElementById('qn-key-probe').focus());
  await p.keyboard.press('Enter'); await p.keyboard.press('Space'); await p.waitForTimeout(300);
  check('keys on a tabbed control press it', await p.evaluate(() => ({ clicks: window.__probeClicks, full: document.body.classList.contains('ql-fullscreen'), name: qn.picture.name })), { clicks: 2, full: false, name: 'a.jpg' });
  await p.click('#qn-key-probe');
  await p.keyboard.press('Space'); await p.waitForTimeout(400);
  check('after a click Space is Next again', await p.evaluate(() => ({ clicks: window.__probeClicks, name: qn.picture.name })), { clicks: 3, name: 'b.png' });
  await p.evaluate(() => { document.getElementById('qn-key-probe').remove(); qn.focus(); });
  await p.keyboard.press('Backspace'); await p.waitForTimeout(400);
  check('back on the first picture', await p.evaluate(() => qn.picture.name), 'a.jpg');

  // Save a copy through the download path (no file picker in headless Chromium): the encoder runs.
  const encoded = await p.evaluate(async () => { const { encodeCanvas } = await window.__qnCodecs(); const b = await encodeCanvas(qn.picture.frameCanvas(), 'webp', 0.8); return [b.type, b.size > 100]; });
  check('encode webp', encoded, ['image/webp', true]);

  // The app's own writers and readers through the real pipeline: TGA, QOI, PPM and a PSD composite open as pictures.
  const own = await p.evaluate(async () => {
    const { encodeCanvas } = await window.__qnCodecs();
    const mk = (w, h, color) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, w, h); return c; };
    const psd = Uint8Array.from([0x38, 0x42, 0x50, 0x53, 0, 1, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 1, 0, 0, 0, 2, 0, 8, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 255, 0, 0]);
    const files = [
      new File([await encodeCanvas(mk(12, 8, '#ff00ff'), 'tga')], 'd.tga'),
      new File([await encodeCanvas(mk(6, 5, '#00ffff'), 'qoi')], 'e.qoi'),
      new File([await encodeCanvas(mk(7, 3, '#ffff00'), 'ppm')], 'f.ppm'),
      new File([psd], 'g.psd'),
    ];
    await qn.exec('file.openDropped', files);
    await new Promise((r) => setTimeout(r, 600));
    const out = [];
    for (let i = 0; i < 4; i++) { const pic = await qn.tab.loader.get(qn.folder.entries[i]); out.push([pic.name, pic.format.id, pic.decoder, pic.width, pic.height]); }
    return out;
  });
  check('own formats', own, [['d.tga', 'tga', 'tga', 12, 8], ['e.qoi', 'qoi', 'qoi', 6, 5], ['f.ppm', 'pnm', 'pnm', 7, 3], ['g.psd', 'psd', 'psd', 2, 1]]);
  check('psd pixel', await p.evaluate(async () => { const pic = await qn.tab.loader.get(qn.folder.entries[3]); const d = pic.frameCanvas().getContext('2d').getImageData(0, 0, 2, 1).data; return [...d]; }), [255, 0, 0, 255, 0, 255, 0, 255]);

  // Open as Hex dumps the bytes (the TGA just written) with landmarks; the Recovery Report describes the picture.
  await p.evaluate(() => qn.folder.select(0));
  await p.waitForTimeout(400);
  check('hex subject', await p.evaluate(() => qn.picture.name), 'd.tga');
  await p.evaluate(() => { void qn.exec('file.openHex'); });
  await p.waitForSelector('.ql-hex');
  check('hex dump', await p.evaluate(() => document.querySelector('.ql-hex').textContent.startsWith('000000  00 00 02 00')), true);
  check('hex landmarks', await p.evaluate(() => [...document.querySelectorAll('.ql-dialog select option')].some((o) => /End of file/.test(o.textContent))), true);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(200);
  await p.evaluate(() => { void qn.exec('file.recoveryReport'); });
  await p.waitForSelector('.ql-dialog table');
  check('recovery report', await p.evaluate(() => [...document.querySelectorAll('.ql-dialog table tr')].map((r) => r.children[0].textContent)).then((k) => k.includes('Condition') && k.includes('Recognized as')), true);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(200);

  // Lossless JPEG: a platform-encoded JPEG rotated by its coefficients decodes to the rotated picture (within JPEG noise).
  const lossless = await p.evaluate(async () => {
    const { losslessTransform } = await window.__qnLossless();
    const c = document.createElement('canvas'); c.width = 96; c.height = 64;
    const x = c.getContext('2d');
    x.fillStyle = '#ff0000'; x.fillRect(0, 0, 48, 64); x.fillStyle = '#0000ff'; x.fillRect(48, 0, 48, 64); x.fillStyle = '#00ff00'; x.fillRect(0, 0, 96, 16);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
    const src = new Uint8Array(await blob.arrayBuffer());
    const out = losslessTransform(src, 'rot90', {});
    const bmp = await createImageBitmap(new Blob([out.bytes], { type: 'image/jpeg' }));
    const d = document.createElement('canvas'); d.width = bmp.width; d.height = bmp.height;
    const y = d.getContext('2d'); y.drawImage(bmp, 0, 0);
    const px = (px_, py_) => [...y.getImageData(px_, py_, 1, 1).data].slice(0, 3);
    // After a 90° clockwise turn: green strip (old top) is at the right; red (old left) at the top, blue at the bottom.
    return { size: [bmp.width, bmp.height], perfect: out.perfect, warnings: out.warnings, right: px(56, 32), top: px(20, 20), bottom: px(20, 80), smaller: out.bytes.length < src.length + 200 };
  });
  check('lossless size', lossless.size, [64, 96]);
  check('lossless perfect', lossless.perfect, true);
  check('lossless warnings', lossless.warnings, []);
  check('lossless green right', lossless.right[1] > 180 && lossless.right[0] < 90 && lossless.right[2] < 90, true);
  check('lossless red top', lossless.top[0] > 180 && lossless.top[1] < 90, true);
  check('lossless blue bottom', lossless.bottom[2] > 180 && lossless.bottom[0] < 90, true);
  check('lossless no bloat', lossless.smaller, true);

  // Damaged files: a JPEG cut in half opens through the coefficient rebuild; a truncated PNG through the tolerant reader.
  const damaged = await p.evaluate(async () => {
    const mk = (w, h, color) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, w, h); return c; };
    const blob = (c, t, q) => new Promise((r) => c.toBlob(r, t, q));
    // A textured picture, so the scan data (not the headers) makes up most of the file.
    const tex = mk(256, 256, '#3366cc'); const tx = tex.getContext('2d'); const id = tx.getImageData(0, 0, 256, 256);
    for (let i = 0; i < id.data.length; i += 4) { const x = (i / 4) % 256, y = Math.floor(i / 4 / 256); id.data[i] = (x * 7 + y * 3 + ((x * y) % 13) * 9) & 255; id.data[i + 1] = (x ^ y) & 255; id.data[i + 2] = (y * 5 + (x % 17) * 11) & 255; }
    tx.putImageData(id, 0, 0);
    const jpg = new Uint8Array(await (await blob(tex, 'image/jpeg', 0.9)).arrayBuffer());
    const whole = await createImageBitmap(new Blob([jpg], { type: 'image/jpeg' }));
    const wc = mk(256, 256, '#000'); wc.getContext('2d').drawImage(whole, 0, 0);
    const want = [...wc.getContext('2d').getImageData(2, 2, 1, 1).data].slice(0, 3);
    const png = new Uint8Array(await (await blob(mk(64, 64, '#cc6633'), 'image/png')).arrayBuffer());
    const files = [new File([jpg.subarray(0, Math.floor(jpg.length * 0.6))], 'cut.jpg'), new File([png.subarray(0, Math.floor(png.length * 0.7))], 'cut.png')];
    await qn.exec('file.openDropped', files);
    await new Promise((r) => setTimeout(r, 800));
    const out = [];
    for (let i = 0; i < 2; i++) { try { const pic = await qn.tab.loader.get(qn.folder.entries[i]); const d = pic.frameCanvas().getContext('2d').getImageData(2, 2, 1, 1).data; out.push([pic.name, pic.decoder, pic.width, pic.warnings.length > 0, [...d].slice(0, 3)]); } catch (e) { out.push([String(e)]); } }
    return { out, want, size: jpg.length };
  });
  check('cut jpeg', damaged.out[0] && damaged.out[0].slice(0, 4), ['cut.jpg', 'jpeg (repaired)', 256, true]);
  check('cut jpeg textured', damaged.size > 20000, true);
  check('cut jpeg pixel', damaged.out[0] && damaged.out[0][4] && damaged.out[0][4].every((v, i) => Math.abs(v - damaged.want[i]) <= 4), true);
  check('cut png', damaged.out[1] && damaged.out[1].slice(0, 4), ['cut.png', 'png (tolerant)', 64, true]);
  check('cut png pixel', damaged.out[1] && damaged.out[1][4] && damaged.out[1][4][0] === 204 && damaged.out[1][4][1] === 102, true);

  // PDF pages through pdf.js: three pages at 72 dpi against PDFium (vector shapes in RGB and CMYK, text, a JPEG, a
  // JPEG 2000 picture, a Group 4 fax strip, a rotated page); 150 dpi sizes; the page limit; a password-protected copy.
  const pdfFix = { pdf: readFileSync('tests/fixtures/pdf/sample.pdf').toString('base64'), locked: readFileSync('tests/fixtures/pdf/locked.pdf').toString('base64'), refs: [1, 2, 3].map((n) => readFileSync(`tests/fixtures/pdf/sample-${n}.png`).toString('base64')) };
  const pdfr = await p.evaluate(async (fx) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const until = async (f) => { for (let i = 0; i < 200 && !f(); i++) await wait(50); };
    qn.prefs.confirmClose = false;
    const open = async (name, b64) => { const before = qn.picture; await qn.exec('file.openDropped', [new File([bytes(b64)], name)]); await until(() => qn.picture && qn.picture !== before && qn.picture.name === name); };
    qn.prefs.pdf = { dpi: 72, maxPages: 100 }; qn.savePrefs();
    await open('sample.pdf', fx.pdf);
    const pic = qn.picture, out = { pages: pic.pages.length, info: [pic.info?.title || pic.info?.['title'], pic.info?.pages], notes: pic.pages.map((pg) => pg.notes.join(', ')), sizes: pic.pages.map((pg) => [pg.width, pg.height]), diff: [], spots: [] };
    for (let i = 0; i < 3; i++) {
      const img = new Image(); img.src = 'data:image/png;base64,' + fx.refs[i]; await img.decode();
      const rc = document.createElement('canvas'); rc.width = img.width; rc.height = img.height; rc.getContext('2d').drawImage(img, 0, 0);
      const ref = rc.getContext('2d').getImageData(0, 0, img.width, img.height).data;
      const f = pic.pages[i].frames[0].image, c = document.createElement('canvas'); c.width = f.width; c.height = f.height; c.getContext('2d').drawImage(f, 0, 0);
      const got = c.getContext('2d').getImageData(0, 0, f.width, f.height).data;
      let sum = 0; for (let k = 0; k < Math.min(got.length, ref.length); k += 4) sum += Math.abs(got[k] - ref[k]) + Math.abs(got[k + 1] - ref[k + 1]) + Math.abs(got[k + 2] - ref[k + 2]);
      out.diff.push(+(sum / (ref.length / 4 * 3)).toFixed(2));
      const at = (d, w, x, y) => [...d.subarray((y * w + x) * 4, (y * w + x) * 4 + 3)];
      const spots = i === 0 ? [[172, 132], [440, 132], [172, 312], [180, 52]] : i === 1 ? [[200, 182], [460, 157], [406, 473], [300, 520]] : [[100, 500], [700, 300]];
      out.spots.push(spots.map(([x, y]) => [at(got, f.width, x, y), at(ref, img.width, x, y)]));
    }
    // 150 dpi, then a limit of two pages.
    qn.prefs.pdf = { dpi: 150, maxPages: 2 }; qn.savePrefs();
    await open('sample.pdf', fx.pdf);
    out.big = [qn.picture.pages.length, qn.picture.pages[0].width, qn.picture.pages[0].height, qn.picture.warnings?.join(' ') || ''];
    // The locked copy: a wrong password, then the right one.
    qn.prefs.pdf = { dpi: 72, maxPages: 100 }; qn.savePrefs();
    const run = qn.exec('file.openDropped', [new File([bytes(fx.locked)], 'locked.pdf')]);
    const seen = new Set();
    const answer = async (pw) => { let d; for (let i = 0; i < 100 && !(d = [...document.querySelectorAll('.ql-dialog')].find((x) => x.getAttribute('aria-label') === 'Password' && !seen.has(x) && x.isConnected)); i++) await wait(50); seen.add(d); const help = d.querySelector('.ql-help')?.textContent || ''; d.querySelector('input').value = pw; d.querySelector('input').dispatchEvent(new Event('input', { bubbles: true })); d.querySelector('.ql-primary').click(); await wait(100); return help; };
    out.asked = [await answer('wrong'), await answer('anne')];
    await run; await until(() => qn.picture?.name === 'locked.pdf');
    out.locked = [qn.picture?.name, qn.picture?.pages.length];
    // Export Animation of the three pages (612×792, 595×842, 792×612): one canvas of 792×842 holds each page centered (W23).
    await open('sample.pdf', fx.pdf);
    const anim = [];
    for (const fmt of ['apng', 'gif']) {
      const saved = { parts: [] }, picker = window.showSaveFilePicker;
      window.showSaveFilePicker = async (o) => ({ name: o?.suggestedName || '', createWritable: async () => ({ write: async (b) => { saved.parts.push(b); }, close: async () => {} }) });
      for (let i = 0; i < 100 && document.querySelector('.ql-dialog'); i++) await wait(50); // the previous round's dialog is gone
      const done = qn.exec('file.export.animation');
      let d; for (let i = 0; i < 100 && !(d = document.querySelector('.ql-dialog')); i++) await wait(50);
      const radio = d?.querySelector(`input[type=radio][value=${fmt}]`);
      if (!radio) { anim.push(['no dialog', d?.getAttribute('aria-label') || '', document.querySelectorAll('.ql-dialog').length]); window.showSaveFilePicker = picker; break; }
      radio.click(); d.querySelector('.ql-primary').click();
      await Promise.race([done, wait(20000)]); for (let i = 0; i < 100 && !saved.parts.length; i++) await wait(50);
      window.showSaveFilePicker = picker;
      if (!saved.parts.length) { anim.push(['nothing saved', [...document.querySelectorAll('.ql-toast')].map((t) => t.textContent).join(' | '), document.querySelectorAll('.ql-dialog').length]); continue; }
      const u8 = new Uint8Array(await new Blob(saved.parts).arrayBuffer()), dv = new DataView(u8.buffer);
      anim.push(fmt === 'apng' ? [dv.getUint32(16), dv.getUint32(20)] : [dv.getUint16(6, true), dv.getUint16(8, true)]);
    }
    out.anim = anim;
    return out;
  }, pdfFix);
  check('export animation: pages of different sizes share one canvas of the largest width and height', pdfr.anim, [[792, 842], [792, 842]]);
  const close = (a, b, t) => a.every((v, i) => Math.abs(v - b[i]) <= t);
  check('pdf: three pages through pdf.js, sizes at 72 dpi, rotation, metadata', [pdfr.pages, pdfr.sizes, pdfr.info, /PDF page 1 of 3/.test(pdfr.notes[0])], [3, [[612, 792], [595, 842], [792, 612]], ["Anne's Lens PDF test", '3'], true], JSON.stringify(pdfr.notes));
  check('pdf: pages match PDFium (mean difference per channel)', pdfr.diff.map((d) => d < 6), [true, true, true], JSON.stringify(pdfr.diff));
  check('pdf: shapes, JPEG, JPEG 2000 and fax strip land where PDFium puts them', pdfr.spots.flat().map(([g, r]) => close(g, r, 24)), pdfr.spots.flat().map(() => true), JSON.stringify(pdfr.spots));
  check('pdf: 150 dpi and the page limit', [pdfr.big[0], pdfr.big[1], pdfr.big[2], /Pages 1–2 of 3/.test(pdfr.big[3])], [2, 1275, 1650, true], JSON.stringify(pdfr.big));
  check('pdf: a password-protected PDF asks, says when the password is wrong, then opens', [/protected by a password/.test(pdfr.asked[0]), /does not open/.test(pdfr.asked[1]), pdfr.locked], [true, true, ['locked.pdf', 3]], JSON.stringify(pdfr));

  // A Group 4 fax page and a CMYK TIFF with its press profile open through the app (libtiff and LittleCMS made the references).
  const tifMore = { fax: [...readFileSync('tests/fixtures/tiff/fax-g4.tif')], cmyk: [...readFileSync('tests/fixtures/tiff/cmyk-icc.tif')] };
  const tm = await p.evaluate(async (b) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    qn.prefs.confirmClose = false;
    await qn.exec('file.openDropped', [new File([Uint8Array.from(b.fax)], 'fax-g4.tif'), new File([Uint8Array.from(b.cmyk)], 'cmyk-icc.tif')]);
    for (let i = 0; i < 100 && qn.picture?.name !== 'cmyk-icc.tif'; i++) await wait(50);
    const at = (x, y) => [...qn.picture.frameCanvas().getContext('2d').getImageData(x, y, 1, 1).data].slice(0, 3);
    // Name order: the CMYK file first, then the fax page.
    const cmyk = [qn.picture.name, qn.picture.width, qn.picture.height, /CMYK through the embedded profile/.test(qn.picture.current.notes.join(', ')), at(5, 5), at(60, 44)];
    await qn.exec('view.next'); for (let i = 0; i < 100 && qn.picture?.name !== 'fax-g4.tif'; i++) await wait(50);
    const fax = [qn.picture.name, qn.picture.width, qn.picture.height, /CCITT G4/.test(qn.picture.current.notes.join(', ')), at(720, 160), at(800, 200)];
    return { cmyk, fax };
  }, tifMore);
  const near3 = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 3);
  check('tiff: CMYK through its press profile (LittleCMS reference)', [tm.cmyk.slice(0, 4), near3(tm.cmyk[4], [238, 234, 234]), near3(tm.cmyk[5], [36, 38, 58])], [['cmyk-icc.tif', 64, 48, true], true, true], JSON.stringify(tm));
  check('tiff: Group 4 fax page (a black block with white inside)', tm.fax, ['fax-g4.tif', 1000, 300, true, [0, 0, 0], [255, 255, 255]], JSON.stringify(tm));
  // A gzipped SVG (.svgz) is unpacked and rendered (W15).
  const svgz = await p.evaluate(async (b64) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms)), before = qn.picture;
    await qn.exec('file.openDropped', [new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'drawing.svgz')]);
    for (let i = 0; i < 100 && (!qn.picture || qn.picture === before); i++) await wait(50);
    const px = [...qn.picture.frameCanvas().getContext('2d').getImageData(10, 10, 1, 1).data].slice(0, 3);
    return [qn.picture.name, qn.picture.format.id, qn.picture.width, qn.picture.height, px];
  }, gzipSync(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="#ff0000"/></svg>')).toString('base64'));
  check('svgz: unpacked and rendered', svgz, ['drawing.svgz', 'svg', 40, 30, [255, 0, 0]]);
  // WebP-compressed tiles go through the platform's WebP decoder; ZSTD strips through fzstd.
  const tw = await p.evaluate(async (b) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms)), out = {};
    for (const [n, b64] of Object.entries(b)) {
      const before = qn.picture;
      await qn.exec('file.openDropped', [new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], n)]);
      for (let i = 0; i < 100 && (!qn.picture || qn.picture === before); i++) await wait(50);
      const at = (x, y) => [...qn.picture.frameCanvas().getContext('2d').getImageData(x, y, 1, 1).data].slice(0, 3);
      out[n] = [qn.picture.name, qn.picture.current.notes.join(', '), at(5, 5), at(15, 12), at(60, 44)];
    }
    return out;
  }, Object.fromEntries(['webp-rgb.tif', 'zstd-rgb.tif'].map((n) => [n, readFileSync(`tests/fixtures/tiff/${n}`).toString('base64')])));
  for (const n of ['webp-rgb.tif', 'zstd-rgb.tif']) check(`tiff: ${n} (pixels exact)`, [tw[n][0], tw[n][2], tw[n][3], tw[n][4]], [n, [20, 25, 20], [250, 20, 40], [240, 220, 208]], JSON.stringify(tw[n]));

  // JPEG-compressed TIFF (Pillow) decodes through the platform per strip; a CBZ opens as a folder of its pages.
  const tiffBytes = [...readFileSync('tests/fixtures/tiff/jpeg-strips.tif')];
  const tiffJpeg = await p.evaluate(async (bytes) => {
    const f = new File([Uint8Array.from(bytes)], 'jpeg-strips.tif');
    await qn.exec('file.openDropped', [f]);
    await new Promise((r) => setTimeout(r, 800));
    const pic = qn.picture;
    const d = pic.frameCanvas().getContext('2d').getImageData(60, 50, 1, 1).data;
    return [pic.format.id, pic.decoder, pic.width, pic.height, pic.warnings.length, pic.current.notes[0], [...d].slice(0, 3)];
  }, tiffBytes);
  check('tiff jpeg', tiffJpeg.slice(0, 5), ['tiff', 'tiff', 203, 112, 0]);
  check('tiff jpeg note', /JPEG-compressed strips/.test(tiffJpeg[5]), true);
  check('tiff jpeg pixel (inside the blue ellipse)', tiffJpeg[6][2] > 150 && tiffJpeg[6][0] < 90, true);
  const cbz = await p.evaluate(async () => {
    const { encodeCanvas } = await window.__qnCodecs();
    const mk = (w, h, color) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, w, h); return c; };
    const pages = [['p10.png', await (await encodeCanvas(mk(8, 8, '#f00'), 'png')).arrayBuffer()], ['p2.png', await (await encodeCanvas(mk(9, 7, '#0f0'), 'png')).arrayBuffer()]];
    // Stored-method zip written by hand (local headers + central directory).
    const le16 = (v) => [v & 255, (v >> 8) & 255], le32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
    const parts = [], central = [];
    for (const [name, buf] of pages) { const data = new Uint8Array(buf); const nm = [...new TextEncoder().encode(name)]; const off = parts.length; const common = [...le16(20), ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(data.length), ...le32(data.length), ...le16(nm.length)]; parts.push(...le32(0x04034b50), ...common, ...le16(0), ...nm, ...data); central.push(...le32(0x02014b50), ...le16(20), ...common, ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(off), ...nm); }
    const eocd = [...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(2), ...le16(2), ...le32(central.length), ...le32(parts.length), ...le16(0)];
    const zip = Uint8Array.from([...parts, ...central, ...eocd]);
    await qn.exec('file.openDropped', [new File([zip], 'book.cbz')]);
    await new Promise((r) => setTimeout(r, 800));
    return [qn.folder.name, qn.folder.entries.map((e) => e.name), qn.picture?.name, qn.picture?.width];
  });
  check('cbz as folder', cbz, ['book.cbz', ['p2.png', 'p10.png'], 'p2.png', 9]);

  // Print Layouts builds pages and previews the first one; Export Animation and Export Palette produce files.
  await p.evaluate(() => { void qn.exec('file.printLayouts'); });
  await p.waitForSelector('.ql-dialog .ql-print-page');
  check('layout preview', await p.evaluate(() => { const pg = document.querySelector('.ql-dialog .ql-print-page'); return [pg.style.display, pg.querySelectorAll('img').length]; }), ['grid', 1]);
  await p.evaluate(() => { const sel = document.querySelector('.ql-dialog select'); sel.value = 'wallet'; sel.dispatchEvent(new Event('change', { bubbles: true })); });
  await p.waitForTimeout(500);
  check('wallet cells', await p.evaluate(() => +(document.querySelector('.ql-dialog .ql-print-page').style.gridTemplateColumns.match(/repeat\((\d+)/) || [])[1] >= 2), true);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(200);
  const exported = await p.evaluate(async () => {
    const { medianCut, encodePalette } = await window.__qnPalette();
    const pic = qn.picture; const c = pic.frameCanvas(); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const pal = medianCut(d, 4);
    return [pal.colors.length, new TextDecoder().decode(encodePalette(pal, 'gpl').bytes).split('\n')[0]];
  });
  check('palette export', exported, [1, 'GIMP Palette']);
  // tar (gzip, bzip2, xz/CBT) and 7z (LZMA2 solid, Deflate CB7) open as folders of their pictures; an encrypted 7z says so.
  // RAR/CBR too (RAR 2.x–4.x and 5.0 headers); a RAR with encrypted headers says so.
  const arch = Object.fromEntries([...['pics.tar.gz', 'pics.tbz2', 'pics.cbt', 'pics-lzma2.7z', 'pics-deflate.cb7', 'pics-ppmd.7z', 'pics-aes.7z'].map((n) => `archives/${n}`), 'rar/comic4.cbr', 'rar/comic5.cbr', 'rar/la-rar-encryption-header.rar'].map((n) => [n.split('/')[1], readFileSync(`tests/fixtures/${n}`).toString('base64')]));
  const ar = await p.evaluate(async (files) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};
    for (const [n, b64] of Object.entries(files)) {
      const before = qn.picture;
      await qn.exec('file.openDropped', [new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], n)]);
      const opened = () => !!qn.picture && qn.picture !== before;
      for (let i = 0; i < 100 && !opened() && !document.querySelector('.ql-toast'); i++) await wait(50);
      await wait(200);
      const px = opened() ? [...qn.picture.frameCanvas().getContext('2d').getImageData(10, 15, 1, 1).data].slice(0, 3) : null;
      out[n] = opened() ? [qn.folder.name, qn.folder.entries.map((e) => e.name), qn.picture.name, px] : [...document.querySelectorAll('.ql-toast')].map((t) => t.textContent).join(' | ');
      document.querySelectorAll('.ql-toast').forEach((t) => t.remove());
    }
    return out;
  }, arch);
  for (const n of ['pics.tar.gz', 'pics.tbz2', 'pics.cbt', 'pics-lzma2.7z', 'pics-deflate.cb7', 'pics-ppmd.7z']) {
    const r = ar[n];
    check(`archive ${n} as folder`, Array.isArray(r) && [r[0], r[1], r[2], r[3] && r[3][0] > 150 && r[3][1] < 80], [n, ['page 1.png', 'page 2.jpg', 'page 10.png', 'photo with a long name.png'], 'page 1.png', true], JSON.stringify(r));
  }
  check('archive: an encrypted 7z says so', /encrypted/.test(String(ar['pics-aes.7z'])), true, JSON.stringify(ar['pics-aes.7z']));
  for (const n of ['comic4.cbr', 'comic5.cbr']) {
    const r = ar[n];
    check(`archive ${n} (RAR) as folder`, Array.isArray(r) && [r[0], r[1], r[2]], [n, ['cover.png', 'page-01.png', 'page-02.jpg', 'page-10.png'], 'cover.png'], JSON.stringify(r));
  }
  check('archive: a RAR with encrypted headers says so', /encrypted/.test(String(ar['la-rar-encryption-header.rar'])), true, JSON.stringify(ar['la-rar-encryption-header.rar']));
  // WMF and EMF through the app's GDI interpreter. LibreOffice's own exports must look like LibreOffice's renderings;
  // the hand-built files are probed where GDI puts their shapes (LibreOffice fills hatches solid and drops one
  // border there, so those are checked by GDI's rules instead).
  const mfFiles = Object.fromEntries(['shapes.wmf', 'shapes.emf', 'drawing.emf', 'drawing.wmf'].map((n) => [n, [readFileSync(`tests/fixtures/metafile/${n}`).toString('base64'), readFileSync(`tests/fixtures/metafile/${n.replace('.', '-')}.png`).toString('base64')]]));
  const mf = await p.evaluate(async (files) => {
    const M = await window.__qnMetafile(), out = {};
    for (const [n, [b64, ref]] of Object.entries(files)) {
      const u8 = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), r = n.endsWith('emf') ? await M.renderEmf(u8) : await M.renderWmf(u8);
      const w = document.createElement('canvas'); w.width = r.canvas.width; w.height = r.canvas.height; const g = w.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w.width, w.height); g.drawImage(r.canvas, 0, 0);
      const img = new Image(); img.src = 'data:image/png;base64,' + ref; await img.decode();
      const rc = document.createElement('canvas'); rc.width = img.width; rc.height = img.height; const rg = rc.getContext('2d'); rg.fillStyle = '#fff'; rg.fillRect(0, 0, rc.width, rc.height); rg.drawImage(img, 0, 0);
      const a = g.getImageData(0, 0, w.width, w.height).data, b = rg.getImageData(0, 0, rc.width, rc.height).data;
      let sum = 0; for (let i = 0; i < Math.min(a.length, b.length); i += 4) sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      const at = (x, y) => [...g.getImageData(x, y, 1, 1).data].slice(0, 3);
      const region = (x0, y0, x1, y1) => { const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data; let green = 0, white = 0, other = 0; for (let i = 0; i < d.length; i += 4) { if (d[i] > 240 && d[i + 1] > 240 && d[i + 2] > 240) white++; else if (d[i + 1] > d[i] + 40 && d[i + 1] > d[i + 2] + 40) green++; else other++; } return { green, white, other }; };
      out[n] = { size: [w.width, w.height], ref: [rc.width, rc.height], mean: +(sum / (a.length / 4 * 3)).toFixed(2), at, region };
      out[n].probes = n === 'shapes.wmf' ? { red: at(46, 40), blue: at(140, 40), pie: at(170, 123), bitmap: at(100, 85), hatch: region(35, 110, 58, 128) }
        : n === 'shapes.emf' ? { red: at(40, 35), lens: at(50, 110), orange: at(115, 105), clippedAway: at(150, 105), bitmap: at(160, 22), border: at(10, 35) } : null;
      delete out[n].at; delete out[n].region;
    }
    // Opened through the app as a picture.
    await qn.exec('file.openDropped', [new File([Uint8Array.from(atob(files['drawing.emf'][0]), (c) => c.charCodeAt(0))], 'drawing.emf')]);
    for (let i = 0; i < 60 && qn.picture?.name !== 'drawing.emf'; i++) await new Promise((r) => setTimeout(r, 50));
    out.opened = [qn.picture?.name, qn.picture?.format.id, qn.picture?.width, qn.picture?.height];
    return out;
  }, mfFiles);
  const mfNear = (a, b, t = 12) => a.every((v, i) => Math.abs(v - b[i]) <= t);
  check('metafile: LibreOffice-made EMF and WMF look like LibreOffice draws them', [mf['drawing.emf'].size, mf['drawing.emf'].ref, mf['drawing.emf'].mean < 1.5, mf['drawing.wmf'].mean < 5], [[373, 273], [373, 273], true, true], JSON.stringify([mf['drawing.emf'], mf['drawing.wmf']]));
  const mw = mf['shapes.wmf'].probes, me = mf['shapes.emf'].probes;
  check('metafile: WMF shapes, pie, bitmap and a cross-hatched brush', [mf['shapes.wmf'].size, mfNear(mw.red, [208, 48, 48]), mfNear(mw.blue, [48, 96, 208]), mfNear(mw.pie, [48, 96, 208]), mw.bitmap.some((v, i) => Math.abs(v - 255) > 30), mw.hatch.green > 20 && mw.hatch.white > 100], [[192, 144], true, true, true, true, true], JSON.stringify(mf['shapes.wmf']));
  check('metafile: EMF mapping, Save/RestoreDC, world transform, path, clipping, bitmap', [mfNear(me.red, [208, 48, 48]), mfNear(me.lens, [40, 160, 80]), mfNear(me.orange, [240, 170, 20]), mfNear(me.clippedAway, [48, 96, 208]), me.bitmap.some((v) => v < 200), me.border.every((v) => v < 60)], [true, true, true, true, true, true], JSON.stringify(mf['shapes.emf']));
  check('metafile: an EMF opens as a picture', mf.opened, ['drawing.emf', 'emf', 373, 273]);
  // OpenEXR: PIZ, premultiplied RGBA and lossy DWAB/DWAA (tiled) files open through the app (references from the OpenEXR library).
  const exrFiles = Object.fromEntries(['half-piz.exr', 'rgba-piz.exr', 'dwab.exr', 'dwaa-tiled.exr', 'zstd-half.exr', 'htj2k32.exr'].map((n) => [n, readFileSync(`tests/fixtures/exr/${n}`).toString('base64')]));
  const ex = await p.evaluate(async (files) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await qn.exec('file.openDropped', Object.entries(files).map(([n, b64]) => new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], n)));
    const at = (x, y) => [...qn.picture.frameCanvas().getContext('2d').getImageData(x, y, 1, 1).data];
    const out = {};
    for (const n of Object.keys(files)) {
      for (let i = 0; i < 100 && qn.picture?.name !== n; i++) { if (qn.picture?.name !== n) await qn.exec('view.next'); await wait(100); }
      out[n] = [qn.picture.format.id, qn.picture.width, qn.picture.height, at(5, 5), at(60, 10), at(10, 35)];
    }
    return out;
  }, exrFiles);
  const near1 = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 1);
  check('exr: PIZ half and premultiplied RGBA match the OpenEXR library', [ex['half-piz.exr'].slice(0, 3), near1(ex['half-piz.exr'][3], [157, 123, 235, 255]), near1(ex['half-piz.exr'][4], [255, 156, 181, 255]), ex['rgba-piz.exr'][0], Math.abs(ex['rgba-piz.exr'][5][3] - 44) <= 1], [['exr', 70, 50], true, true, 'exr', true], JSON.stringify(ex));
  check('exr: DWAB and tiled DWAA match the OpenEXR library', ['dwab.exr', 'dwaa-tiled.exr'].map((n) => [ex[n].slice(0, 3), near1(ex[n][3], [156, 122, 235, 255]), near1(ex[n][4], [255, 157, 182, 255]), near1(ex[n][5], [0, 157, 255, 255])]), [[['exr', 70, 50], true, true, true], [['exr', 70, 50], true, true, true]], JSON.stringify(ex));
  check('exr: ZSTD and HTJ2K (OpenJPH from its runtime) are lossless', ['zstd-half.exr', 'htj2k32.exr'].map((n) => ex[n] && [ex[n].slice(0, 3), near1(ex[n][3], [157, 123, 235, 255]), near1(ex[n][4], [255, 156, 181, 255])]), [[['exr', 70, 50], true, true], [['exr', 70, 50], true, true]], JSON.stringify([ex['zstd-half.exr'], ex['htj2k32.exr']]));
  // JPEG 2000 through OpenJPEG from the PDF runtime: lossless JP2, HTJ2K, a tagged JP2 (ICC, dpi) and an ICNS with a JPEG 2000 element.
  const jpxFiles = Object.fromEntries(['rgb-lossless.jp2', 'ht.j2c', 'tagged.jp2', 'icon.icns'].map((n) => [n, readFileSync(`tests/fixtures/jpx/${n}`).toString('base64')]));
  const jx = await p.evaluate(async (files) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};
    for (const [n, b64] of Object.entries(files)) {
      const before = qn.picture;
      await qn.exec('file.openDropped', [new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], n)]);
      for (let i = 0; i < 100 && (!qn.picture || qn.picture === before) && !document.querySelector('.ql-toast'); i++) await wait(50);
      const pic = qn.picture;
      if (!pic || pic === before) { out[n] = [...document.querySelectorAll('.ql-toast')].map((t) => t.textContent).join(' | '); document.querySelectorAll('.ql-toast').forEach((t) => t.remove()); continue; }
      const at = (x, y) => [...pic.frameCanvas().getContext('2d').getImageData(x, y, 1, 1).data].slice(0, 4);
      out[n] = [pic.format.id, pic.decoder, pic.width, pic.height, pic.current.notes.join(' | '), pic.current.dpi || null, at(15, 12), at(40, 5)];
    }
    return out;
  }, jpxFiles);
  check('jpeg 2000: lossless JP2 and HTJ2K open exactly', ['rgb-lossless.jp2', 'ht.j2c'].map((n) => jx[n] && [jx[n][0], jx[n][2], jx[n][3], jx[n][6], jx[n][7]]), [['jp2', 53, 37, [250, 20, 40, 255], [160, 30, 90, 255]], ['jp2', 53, 37, [250, 20, 40, 255], [160, 30, 90, 255]]], JSON.stringify(jx));
  check('jpeg 2000: ICC profile and resolution of a tagged JP2', jx['tagged.jp2'] && [/color profile: .*Adobe RGB/i.test(jx['tagged.jp2'][4]), jx['tagged.jp2'][5]], [true, [300, 300]], JSON.stringify(jx['tagged.jp2']));
  check('jpeg 2000: an ICNS icon with a JPEG 2000 element', jx['icon.icns'] && [jx['icon.icns'][0], jx['icon.icns'][2], /ic07: JPEG 2000 element/.test(jx['icon.icns'][4])], ['icns', 128, true], JSON.stringify(jx['icon.icns']));
  // Pictures from the 1980s and 1990s: MacPaint, Deluxe Paint (IFF ILBM with color cycling) and Kodak Photo CD.
  const retroFiles = Object.fromEntries(['paint.mac', 'cycle.iff', 'photo.pcd'].map((n) => [n, readFileSync(`tests/fixtures/retro/${n}`).toString('base64')]));
  const rt = await p.evaluate(async (files) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms)), out = {};
    for (const [n, b64] of Object.entries(files)) {
      const before = qn.picture;
      await qn.exec('file.openDropped', [new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], n)]);
      for (let i = 0; i < 100 && (!qn.picture || qn.picture === before) && !document.querySelector('.ql-toast'); i++) await wait(50);
      const pic = qn.picture;
      if (!pic || pic === before) { out[n] = [...document.querySelectorAll('.ql-toast')].map((t) => t.textContent).join(' | '); document.querySelectorAll('.ql-toast').forEach((t) => t.remove()); continue; }
      out[n] = [pic.format.id, pic.width, pic.height, pic.current.frames.length];
    }
    return out;
  }, retroFiles);
  check('retro: MacPaint, an animated Deluxe Paint picture and a Photo CD open', [rt['paint.mac'], rt['cycle.iff'], rt['photo.pcd']], [['macpaint', 576, 720, 1], ['iff', 50, 30, 8], ['pcd', 768, 512, 1]], JSON.stringify(rt));
  // JPEG XL (Chromium has no decoder: the app's jxl-oxide steps in) and AVIF through the app's libavif, from the staged runtimes.
  const modFiles = Object.fromEntries(['lossless.jxl', 'anim.jxl', 'alpha.avif'].map((n) => [n, readFileSync(`tests/fixtures/modern/${n}`).toString('base64')]));
  const mo = await p.evaluate(async (files) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms)), bytes = (n) => Uint8Array.from(atob(files[n]), (c) => c.charCodeAt(0));
    const out = {};
    for (const n of ['lossless.jxl', 'anim.jxl']) {
      const before = qn.picture;
      await qn.exec('file.openDropped', [new File([bytes(n)], n)]);
      for (let i = 0; i < 100 && (!qn.picture || qn.picture === before) && !document.querySelector('.ql-toast'); i++) await wait(50);
      const pic = qn.picture;
      if (!pic || pic === before) { out[n] = [...document.querySelectorAll('.ql-toast')].map((t) => t.textContent).join(' | '); document.querySelectorAll('.ql-toast').forEach((t) => t.remove()); continue; }
      out[n] = [pic.format.id, pic.decoder, pic.width, pic.height, pic.current.frames.length, pic.current.frames.map((f) => f.delay), [...pic.frameCanvas().getContext('2d').getImageData(15, 12, 1, 1).data].slice(0, 3)];
    }
    const M = await window.__qnModern(), a = await M.decodeAvif(bytes('alpha.avif'));
    out.avif = [a.pages[0].width, a.pages[0].height, a.pages[0].hasAlpha, a.pages[0].notes[0]];
    return out;
  }, modFiles);
  check('jpeg xl: opens through jxl-oxide where the platform cannot', mo['lossless.jxl'] && mo['lossless.jxl'].slice(0, 5).concat([mo['lossless.jxl'][6]]), ['jxl', 'jxl-oxide', 53, 37, 1, [250, 20, 40]], JSON.stringify(mo['lossless.jxl']));
  check('jpeg xl: an animation, every frame with its time', mo['anim.jxl'] && [mo['anim.jxl'][4], mo['anim.jxl'][5]], [3, [100, 100, 100]], JSON.stringify(mo['anim.jxl']));
  check('avif: the app\'s own decoder (libavif with libaom) from the staged runtime', mo.avif, [53, 37, true, 'AVIF, decoded by libavif with libaom (8 bits per sample)'], JSON.stringify(mo.avif));
  // Workstation and home-computer formats, and PICT (its text and QuickTime JPEG are drawn by the platform).
  const histNames = ['shapes.pct', 'jpeg.pct', 'v1.pct', 'sun24.ras', 'sgi-rle.sgi', 'urt.rle', 'low.pi1', 'spectrum.spu', 'koala.koa', 'ximg4.img', 'msp2.msp'];
  const histFiles = Object.fromEntries(histNames.map((n) => [n, readFileSync(`tests/fixtures/historic/${n}`).toString('base64')]));
  const hist = await p.evaluate(async (files) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms)), out = {};
    for (const [n, b64] of Object.entries(files)) {
      const before = qn.picture;
      await qn.exec('file.openDropped', [new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], n)]);
      for (let i = 0; i < 100 && (!qn.picture || qn.picture === before) && !document.querySelector('.ql-toast'); i++) await wait(50);
      const pic = qn.picture;
      if (!pic || pic === before) { out[n] = [...document.querySelectorAll('.ql-toast')].map((t) => t.textContent).join(' | '); document.querySelectorAll('.ql-toast').forEach((t) => t.remove()); continue; }
      const g = pic.frameCanvas().getContext('2d'), px = (x, y) => [...g.getImageData(x, y, 1, 1).data].slice(0, 3);
      out[n] = [pic.format.id, pic.width, pic.height];
      if (n === 'shapes.pct') { const d = g.getImageData(60, 58, 40, 16).data; let green = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 80 && d[i + 1] > 120 && d[i + 2] < 80) green++; out.text = green; out.shapesPx = px(20, 20); }
      if (n === 'jpeg.pct') out.jpegPx = px(30, 18);
    }
    return out;
  }, histFiles);
  check('historic formats open by content and name', histNames.map((n) => hist[n]), [['pict', 120, 80], ['pict', 61, 37], ['pict', 100, 60], ['sun', 61, 37], ['sgi', 61, 37], ['utahrle', 61, 37], ['atarist', 320, 200], ['atarist', 320, 200], ['c64', 320, 200], ['gem', 48, 20], ['msp', 75, 30]], JSON.stringify(hist));
  check('pict: the text is drawn in its color, the shapes as decoded', [hist.text > 15, hist.shapesPx], [true, [200, 30, 30]], JSON.stringify([hist.text, hist.shapesPx]));
  check('pict: the QuickTime JPEG is drawn by the platform (quality 95, near the source)', hist.jpegPx && hist.jpegPx.every((v, i) => Math.abs(v - [165, 125, 130][i]) <= 12), true, JSON.stringify(hist.jpegPx)); // jpeg-source.png at (30, 18)
  // FlashPix (JPEG tiles through pdf.js), Autodesk FLC, clipboard files (a DIB; metafiles drawn as the files themselves are), JBIG and JBIG2.
  const moreFiles = { 'view-rot90.fpx': 'flashpix', 'icons64.dll': 'iconlib', 'lib.icl': 'iconlib', 'layers.psp': 'psp', 'input_jpeg.fpx': 'flashpix', 'anim.flc': 'flic', 'dib31.clp': 'clipboard', 'wmf31.clp': 'clipboard', 'emfnt.clp': 'clipboard', 'layers.jbg': 'jbig', 'page.jb2': 'jbig', 'shapes.wmf': 'metafile', 'shapes.emf': 'metafile', 'ct-window.dcm': 'dicom', '693_J2KI.dcm': 'dicom', 'frames.dcm': 'dicom', 'extensions.fits': 'fits', 'int16-bzero.fits.gz': 'fits', 'SC_rgb_jls_lossy_sample.dcm': 'dicom', 'overlay.dcm': 'dicom', 'rice-f32-dither1.fits': 'fits', 'wcs-tan-cd.fits': 'fits' };
  const moreB64 = Object.fromEntries(Object.entries(moreFiles).map(([n, d]) => [n, readFileSync(`tests/fixtures/${d}/${n}`).toString('base64')]));
  const more = await p.evaluate(async (files) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms)), out = {}, pix = {};
    for (const [n, b64] of Object.entries(files)) {
      const before = qn.picture;
      await qn.exec('file.openDropped', [new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], n)]);
      for (let i = 0; i < 200 && (!qn.picture || qn.picture === before) && !document.querySelector('.ql-toast'); i++) await wait(50);
      const pic = qn.picture;
      if (!pic || pic === before) { out[n] = [...document.querySelectorAll('.ql-toast')].map((t) => t.textContent).join(' | '); document.querySelectorAll('.ql-toast').forEach((t) => t.remove()); continue; }
      out[n] = [pic.format.id, pic.width, pic.height, pic.current.frames.length];
      const c = pic.frameCanvas(); pix[n] = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      if (n === 'icons64.dll') out.dllPages = pic.pages.map((pg) => [pg.width, pg.height]);
      if (n === 'lib.icl') out.iclPages = pic.pages.map((pg) => [pg.width, pg.height]);
      if (n === '693_J2KI.dcm') { out.ctNote = pic.pages[0].notes.at(-1); out.ctInfo = [pic.info.modality, pic.info.window, pic.info['transfer syntax']]; out.ctWarn = pic.warnings; }
      if (n === 'frames.dcm' || n === 'extensions.fits') out[n + ':pages'] = pic.pages.length;
      if (n === 'wcs-tan-cd.fits') out.wcs = [pic.current.world?.proj, pic.pages[0].notes.find((t) => /projection/.test(t))];
      if (n === 'rice-f32-dither1.fits') { out.riceNote = pic.pages[0].notes[0]; out.riceAlpha = pic.frameCanvas().getContext('2d').getImageData(12, 59 - 6, 1, 1).data[3]; }
    }
    const same = (a, b) => { if (!a || !b || a.length !== b.length) return -1; let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
    const ps = pix['layers.psp']; out.pspPx = ps ? [ps[(18 * 64 + 42) * 4], ps[(18 * 64 + 42) * 4 + 1], ps[(18 * 64 + 42) * 4 + 2]] : null;
    out.wmfSame = same(pix['wmf31.clp'], pix['shapes.wmf']); out.emfSame = same(pix['emfnt.clp'], pix['shapes.emf']);
    const j = pix['input_jpeg.fpx']; out.fpxPx = j ? [j[(20 * 70 + 30) * 4], j[(20 * 70 + 30) * 4 + 1], j[(20 * 70 + 30) * 4 + 2]] : null;
    const g = pix['page.jb2']; let black = 0; if (g) for (let i = 0; i < g.length; i += 4) if (g[i] === 0) black++; out.jb2Black = black;
    const dc = pix['693_J2KI.dcm'], cw = pix['ct-window.dcm'], fz = pix['int16-bzero.fits.gz'];
    const jl = pix['SC_rgb_jls_lossy_sample.dcm'], ovl = pix['overlay.dcm'];
    out.jlsPx = jl ? [jl[(50 * 100 + 10) * 4], jl[(50 * 100 + 10) * 4 + 1], jl[(50 * 100 + 10) * 4 + 2]] : null; out.ovlPx = ovl ? [ovl[(5 * 44 + 20) * 4], ovl[(4 * 44 + 20) * 4]] : null;
    out.ctPx = dc ? dc[(256 * 512 + 256) * 4] : null; out.cwPx = cw ? [cw[(16 * 48 + 20) * 4], cw[(31 * 48 + 47) * 4]] : null; out.fitsPx = fz ? [fz[(19 * 30) * 4], fz[29 * 4]] : null;
    return out;
  }, moreB64);
  check('flashpix, flc, clipboard, jbig and jbig2 open', ['input_jpeg.fpx', 'anim.flc', 'dib31.clp', 'wmf31.clp', 'emfnt.clp', 'layers.jbg', 'page.jb2'].map((n) => more[n] && (n === 'layers.jbg' ? more[n] : more[n].slice(0, 1).concat(more[n].slice(3)))), [['fpx', 1], ['flic', 5], ['clp', 1], ['clp', 1], ['clp', 1], ['jbig', 800, 520, 1], ['jbig2', 1]], JSON.stringify(more));
  check('paint shop pro: two layers merged (the sun at half opacity over the gradient)', [more['layers.psp'] && more['layers.psp'].slice(0, 3), more.pspPx && more.pspPx.every((v, i) => Math.abs(v - [209, 154, 53][i]) <= 1)], [['psp', 64, 40], true], JSON.stringify([more['layers.psp'], more.pspPx])); // GIMP's layers.png at (42, 18)
  check('icons in a 64-bit DLL and a 16-bit icon library: a page each (cursor 3, icon 1, icon 7)', [more['icons64.dll'] && more['icons64.dll'].slice(0, 1).concat(more['icons64.dll'].slice(3)), more['lib.icl'] && more['lib.icl'][0], more.dllPages, more.iclPages], [['winres', 1], 'winres', [[32, 32], [256, 256], [32, 32]], [[32, 32], [256, 256], [32, 32]]], JSON.stringify([more['icons64.dll'], more.dllPages, more.iclPages]));
  check('flashpix: a viewing transform (a quarter turn) is applied on opening', more['view-rot90.fpx'], ['fpx', 46, 70, 1], JSON.stringify(more['view-rot90.fpx']));
  check('clipboard metafiles are drawn as the metafile files themselves', [more.wmfSame, more.emfSame], [0, 0], JSON.stringify([more.wmfSame, more.emfSame]));
  // DICOM: a CT in JPEG 2000 (OpenJPEG from the local runtime, full precision, the CT window applied), a 12-bit CT with a window, frames as pages; FITS: extensions as pages, a gzipped file shown bottom-up.
  check('dicom opens: JPEG 2000 at full precision with the window applied, 12-bit with a window, frames as pages', [more['693_J2KI.dcm'], more.ctPx, more['ct-window.dcm'], more.cwPx, more['frames.dcm:pages'], more.ctWarn], [['dicom', 512, 512, 1], 108, ['dicom', 48, 32, 1], [0, 255], 4, []], JSON.stringify([more['693_J2KI.dcm'], more.ctPx, more['ct-window.dcm'], more.cwPx, more['frames.dcm:pages'], more.ctWarn]));
  check('dicom: the details name the modality, window and transfer syntax, and every page says it is not for diagnosis', [more.ctInfo, /not a medical device/.test(more.ctNote || '')], [['CT', 'center 40, width 100', 'JPEG 2000 (1.2.840.10008.1.2.4.91)'], true], JSON.stringify([more.ctInfo, more.ctNote]));
  check('dicom: JPEG-LS color pixel data (sample interleaved) and an overlay plane drawn in white', [more['SC_rgb_jls_lossy_sample.dcm'], more.jlsPx, more['overlay.dcm'], more.ovlPx], [['dicom', 100, 100, 1], [130, 130, 255], ['dicom', 44, 30, 1], [255, 104]], JSON.stringify([more['SC_rgb_jls_lossy_sample.dcm'], more.jlsPx, more['overlay.dcm'], more.ovlPx]));
  check('fits: a tile-compressed, quantized and dithered image opens, its nulls transparent', [more['rice-f32-dither1.fits'], more.riceNote, more.riceAlpha], [['fits', 100, 60, 1], 'FITS image extension 1 "COMPRESSED_IMAGE", 32-bit floating-point, RICE_1 tiles (quantized with dither)', 0], JSON.stringify([more['rice-f32-dither1.fits'], more.riceNote, more.riceAlpha]));
  // A DICOM presentation state dropped together with the picture it refers to: the picture opens with the state's annotations, the text drawn by the browser.
  const psFiles = Object.fromEntries(['gsps-annot.dcm', 'ct-window.dcm'].map((n) => [n, readFileSync(`tests/fixtures/dicom/${n}`).toString('base64')]));
  const psGot = await p.evaluate(async (files) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const list = Object.entries(files).map(([n, b64]) => new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], n));
    const before = qn.picture;
    await qn.exec('file.openDropped', list);
    for (let i = 0; i < 200 && (!qn.picture || qn.picture === before) && !document.querySelector('.ql-toast'); i++) await wait(50);
    if (qn.folder.select(qn.folder.entries.findIndex((e) => e.name === 'gsps-annot.dcm'))) await qn.tab.show(); // the folder is sorted by name: the picture came first
    for (let i = 0; i < 200 && (!qn.picture || qn.picture.name !== 'gsps-annot.dcm') && !document.querySelector('.ql-toast'); i++) await wait(50);
    const pic = qn.picture;
    if (!pic || pic.name !== 'gsps-annot.dcm') return [...document.querySelectorAll('.ql-toast')].map((t) => t.textContent).concat([pic?.name]);
    const c = pic.frameCanvas(), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let text = 0; for (let y = 2; y < 14; y++) for (let x = 20; x < 46; x++) if (d[(y * c.width + x) * 4] === 191) text++;
    return [pic.format.id, pic.width, pic.height, pic.pages[0].notes.find((n) => /^presentation state/.test(n)), pic.warnings, text > 10, pic.info.annotations];
  }, psFiles);
  check('dicom: a presentation state dropped with its picture opens that picture with the annotations and text drawn', psGot, ['dicom', 48, 32, 'presentation state FIXTURE (graphic annotations: a filled rectangle, a circle, an ellipse, a point, text with an anchor) applied: 5 graphic objects and 1 text', [], true, 'Lesion'], JSON.stringify(psGot));
  // Window / Level previews the picture a presentation state shows and baseline-JPEG DICOM (both decoded as opening does; W27).
  const wlPrev = await p.evaluate(async (jpegB64) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms)), out = [];
    const previewOnce = async () => {
      void qn.exec('image.dicomWindow');
      let d; for (let i = 0; i < 100 && !(d = document.querySelector('.ql-dialog .ql-dialog-preview')); i++) await wait(50);
      let shown = null; for (let i = 0; i < 200 && !(shown = d?.querySelector('img') || d?.querySelector('.ql-help')); i++) await wait(50);
      const res = shown?.tagName === 'IMG' ? 'image' : shown?.textContent || 'nothing';
      [...document.querySelectorAll('.ql-dialog button')].find((b) => b.textContent === 'Cancel')?.click();
      for (let i = 0; i < 40 && document.querySelector('.ql-dialog'); i++) await wait(50);
      return res;
    };
    out.push([qn.picture?.name, await previewOnce()]);
    const before = qn.picture;
    await qn.exec('file.openDropped', [new File([Uint8Array.from(atob(jpegB64), (c) => c.charCodeAt(0))], 'jpeg-gray.dcm')]);
    for (let i = 0; i < 200 && (!qn.picture || qn.picture === before); i++) await wait(50);
    out.push([qn.picture?.name, await previewOnce()]);
    return out;
  }, readFileSync('tests/fixtures/dicom/jpeg-gray.dcm').toString('base64'));
  check('dicom: Window / Level previews a presentation state\'s picture and baseline-JPEG DICOM', wlPrev, [['gsps-annot.dcm', 'image'], ['jpeg-gray.dcm', 'image']]);
  // View ▸ DICOM Overlay Planes: the open DICOM file is decoded again without its overlay; a pseudo-color state colors its picture.
  const ovFiles = Object.fromEntries(['overlay.dcm', 'pcsps.dcm', 'ct-window.dcm'].map((n) => [n, readFileSync(`tests/fixtures/dicom/${n}`).toString('base64')]));
  const ovGot = await p.evaluate(async (files) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const list = Object.entries(files).map(([n, b64]) => new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], n));
    const before = qn.picture;
    await qn.exec('file.openDropped', list);
    for (let i = 0; i < 200 && (!qn.picture || qn.picture === before) && !document.querySelector('.ql-toast'); i++) await wait(50);
    const show = async (name) => { if (qn.folder.select(qn.folder.entries.findIndex((e) => e.name === name))) await qn.tab.show(); for (let i = 0; i < 200 && (!qn.picture || qn.picture.name !== name); i++) await wait(50); return qn.picture; };
    const whites = (pic) => { const c = pic.frameCanvas(), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] === 255 && d[i + 1] === 255) n++; return n; };
    let pic = await show('overlay.dcm');
    const withOverlay = whites(pic), noteOn = pic.pages[0].notes.find((n) => /overlay plane/.test(n));
    await qn.exec('view.dicomOverlays');
    for (let i = 0; i < 100 && (qn.picture === pic || !qn.picture); i++) await wait(50);
    pic = qn.picture;
    const without = whites(pic), noteOff = pic.pages[0].notes.find((n) => /overlay plane/.test(n)), pref = qn.prefs.dicomOverlays;
    await qn.exec('view.dicomOverlays');
    for (let i = 0; i < 100 && (qn.picture === pic || !qn.picture); i++) await wait(50);
    const back = whites(qn.picture);
    const pc = await show('pcsps.dcm');
    const c = pc.frameCanvas(), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let colored = 0; for (let i = 0; i < d.length; i += 4) if (d[i] !== d[i + 1] || d[i + 1] !== d[i + 2]) colored++;
    return [withOverlay > 0 && without < withOverlay, noteOn, noteOff, pref, back === withOverlay, qn.prefs.dicomOverlays, pc.pages[0].notes.find((n) => /^presentation state/.test(n)), colored > 100];
  }, ovFiles);
  check('dicom: View ▸ DICOM Overlay Planes decodes the file again without its overlay, and back; a pseudo-color state colors its picture', ovGot, [true, '1 overlay plane drawn in white', '1 overlay plane not drawn (View ▸ DICOM Overlay Planes)', false, true, true, 'presentation state FIXTURE (pseudo-color: window 100/600 through the segmented WINTER palette) applied: window center 100, width 600, pseudo-color palette (256 entries)', true], JSON.stringify(ovGot));
  // Scientific tools: Window / Level and DICOM Tags on a DICOM file, FITS Stretch and FITS Header on a FITS file.
  const sciFiles = Object.fromEntries([['ct-window.dcm', 'dicom'], ['extensions.fits', 'fits']].map(([n, d]) => [n, readFileSync(`tests/fixtures/${d}/${n}`).toString('base64')]));
  const sci = await p.evaluate(async (files) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const list = Object.entries(files).map(([n, b64]) => new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], n));
    const before = qn.picture;
    await qn.exec('file.openDropped', list);
    for (let i = 0; i < 200 && (!qn.picture || qn.picture === before) && !document.querySelector('.ql-toast'); i++) await wait(50);
    const show = async (name) => { if (qn.picture?.name !== name) { qn.folder.select(qn.folder.entries.findIndex((e) => e.name === name)); await qn.tab.show(); } for (let i = 0; i < 200 && (!qn.picture || qn.picture.name !== name); i++) await wait(50); return qn.picture; };
    const gray = (pic) => { const c = pic.frameCanvas(), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i]; return Math.round(s / (d.length / 4)); };
    const out = {};
    let pic = await show('ct-window.dcm');
    const g0 = gray(pic), w0 = pic.info.window;
    await qn.exec('image.dicomWindow', { wc: 100, ww: 600 }); for (let i = 0; i < 100 && qn.picture === pic; i++) await wait(50); pic = qn.picture;
    out.dicom = [w0, pic.info.window, gray(pic) !== g0, pic.pages[0].notes.includes('window center 100, width 600, after the rescale')];
    await qn.exec('image.dicomWindow', 'file'); for (let i = 0; i < 100 && qn.picture === pic; i++) await wait(50); pic = qn.picture;
    out.dicomReset = [pic.info.window, gray(pic) === g0];
    const tagsDlg = qn.exec('image.dicomTags');
    let dlg; for (let i = 0; i < 100 && !(dlg = [...document.querySelectorAll('.ql-dialog')].find((d) => /DICOM Tags/.test(d.textContent))); i++) await wait(50);
    const rows = dlg ? dlg.querySelectorAll('tbody tr').length : 0;
    const input = dlg?.querySelector('input[type=search]'); if (input) { input.value = 'patient'; input.dispatchEvent(new Event('input')); await wait(50); }
    const filtered = dlg ? dlg.querySelectorAll('tbody tr').length : 0, hasName = dlg ? /Patient's Name/.test(dlg.textContent) : false;
    dlg?.querySelector('.ql-dialog-foot button:last-child')?.click(); await tagsDlg; for (let i = 0; i < 40 && document.querySelector('.ql-dialog'); i++) await wait(50);
    out.tags = [rows > 20, filtered > 0 && filtered < rows, hasName, !document.querySelector('.ql-dialog')];
    pic = await show('extensions.fits');
    const f0 = gray(pic);
    await qn.exec('image.fitsStretch', { mode: 'log' }); for (let i = 0; i < 100 && qn.picture === pic; i++) await wait(50); pic = qn.picture;
    out.fits = [gray(pic) > f0, pic.pages[0].notes.some((n) => /^shown stretched logarithmically/.test(n))];
    await qn.exec('image.fitsStretch', 'default'); for (let i = 0; i < 100 && qn.picture === pic; i++) await wait(50); pic = qn.picture;
    out.fitsReset = gray(pic) === f0;
    const hdrDlg = qn.exec('image.fitsHeader');
    for (let i = 0; i < 100 && !(dlg = [...document.querySelectorAll('.ql-dialog')].find((d) => /FITS Header/.test(d.textContent))); i++) await wait(50);
    out.header = [dlg ? /SIMPLE/.test(dlg.textContent) : false, dlg ? /XTENSION/.test(dlg.textContent) : false, dlg ? /this page/.test(dlg.textContent) : false];
    dlg?.querySelector('.ql-dialog-foot button:last-child')?.click(); await hdrDlg; for (let i = 0; i < 40 && document.querySelector('.ql-dialog'); i++) await wait(50);
    out.headerClosed = !document.querySelector('.ql-dialog');
    return out;
  }, sciFiles);
  check('dicom: Window / Level decodes the file again with the user\'s window and back; DICOM Tags lists and filters the elements', [sci.dicom, sci.dicomReset, sci.tags], [['center 40, width 400 (first of 2)', 'center 100, width 600 (Window / Level)', true, true], ['center 40, width 400 (first of 2)', true], [true, true, true, true]], JSON.stringify(sci));
  check('fits: FITS Stretch applies a logarithmic stretch and back; FITS Header lists the cards of every HDU', [sci.fits, sci.fitsReset, sci.header, sci.headerClosed], [[true, true], true, [true, true, true], true], JSON.stringify([sci.fits, sci.fitsReset, sci.header]));
  check('fits: a world coordinate system is read and described', more.wcs, ['TAN', 'TAN projection: the center is at RA 10:00:24.00 Dec −20:30:00.0 (ICRS J2000); the pixel readout and Measure show sky positions'], JSON.stringify(more.wcs));
  check('fits opens: image extensions as pages; a gzipped file, stretched, the first stored row at the bottom', [more['extensions.fits'], more['extensions.fits:pages'], more['int16-bzero.fits.gz'], more.fitsPx], [['fits', 12, 8, 1], 2, ['fits', 30, 20, 1], [0, 255]], JSON.stringify([more['extensions.fits'], more['extensions.fits:pages'], more['int16-bzero.fits.gz'], more.fitsPx]));
  check('flashpix JPEG tiles (near libjpeg\'s decoding) and a JBIG2 page are decoded', [more.fpxPx && more.fpxPx.every((v, i) => Math.abs(v - [249, 43, 56][i]) <= 32), more.jb2Black > 1000], [true, true], JSON.stringify([more.fpxPx, more.jb2Black])); // input_jpeg.libjpeg.png at (30, 20)
  // A Corel file: recognized, not opened; the toast offers Send a Sample File, whose terms must be agreed to before the mail program opens.
  const sample = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const top = () => [...document.querySelectorAll('.ql-dialog')].pop(), title = (d) => d?.querySelector('h2')?.textContent || '';
    const waitFor = async (pred, ms = 20000) => { for (let i = 0; i < ms / 100; i++) { const d = top(); if (d && pred(d)) return d; await wait(100); } throw new Error('dialog not found; top is ' + title(top())); };
    const field = (d, key) => d.querySelector(`[id^="f_${key}_"]`);
    const out = { opened: [] };
    const realOpen = window.open; window.open = (u) => { out.opened.push(String(u)); return null; };
    try {
      const cdr = new Uint8Array([...'RIFF'].map((c) => c.charCodeAt(0)).concat([200, 0, 0, 0], [...'CDRBvrsn'].map((c) => c.charCodeAt(0)), new Array(190).fill(7)));
      document.querySelectorAll('.ql-toast').forEach((t) => t.remove());
      const before = qn.picture;
      await qn.exec('file.openDropped', [new File([cdr], 'parish-map.cdr')]);
      for (let i = 0; i < 100 && !document.querySelector('.ql-toast'); i++) await wait(50);
      const t = document.querySelector('.ql-toast');
      out.toast = t?.textContent || ''; out.pictureUnchanged = qn.picture === before || !qn.picture;
      const btn = t?.querySelector('button'); out.action = btn?.textContent || ''; btn?.click();
      let d = await waitFor((x) => title(x) === 'Send a Sample File');
      out.terms = /uploads nothing/.test(d.textContent) && /MIT license/.test(d.textContent) && /parish-map\.cdr/.test(d.textContent);
      d.querySelector('.ql-primary').click(); await wait(300); // without the agreement: refused, the dialog returns
      out.refused = [...document.querySelectorAll('.ql-toast')].some((x) => /Tick the agreement/.test(x.textContent));
      d = await waitFor((x) => title(x) === 'Send a Sample File');
      field(d, 'program').value = 'CorelDRAW 9'; field(d, 'program').dispatchEvent(new Event('input', { bubbles: true }));
      for (const k of ['publish', 'agree']) { const c = field(d, k); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); }
      d.querySelector('.ql-primary').click();
      for (let i = 0; i < 100 && !out.opened.length; i++) await wait(50);
      for (let i = 0; i < 40 && document.querySelector('.ql-dialog'); i++) await wait(50);
    } finally { window.open = realOpen; }
    const u = out.opened[0] || '', q = new URLSearchParams(u.slice(u.indexOf('?') + 1));
    out.mailto = u.split('?')[0]; out.subject = q.get('subject'); out.body = q.get('body') || '';
    return out;
  });
  check('corel: recognized, not opened, and the toast offers a sample', [/Could not open parish-map\.cdr: CorelDRAW/.test(sample.toast), sample.action, sample.pictureUnchanged], [true, 'Send a sample…', true], JSON.stringify(sample));
  check('send a sample: terms shown, agreement required, then the mail program opens with the message', [sample.terms, sample.refused, sample.mailto, sample.subject, /parish-map\.cdr \(1 KB\), recognized as CorelDRAW/.test(sample.body), /Made by: CorelDRAW 9/.test(sample.body), /public test suite: yes/.test(sample.body)], [true, true, 'mailto:socrtwo@gmail.com', "Anne's Lens sample file: parish-map.cdr", true, true, true], JSON.stringify(sample));
  // DjVu through djvu-rs from the staged runtime: a bundled book with a rotated page and a text layer, shown by Recognize Text.
  const djvuFiles = Object.fromEntries(['book.djvu', 'shared.djvu'].map((n) => [n, readFileSync(`tests/fixtures/djvu/${n}`).toString('base64')]));
  const dj = await p.evaluate(async (files) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms)), bytes = (n) => Uint8Array.from(atob(files[n]), (c) => c.charCodeAt(0));
    const top = () => [...document.querySelectorAll('.ql-dialog')].pop(), title = (d) => d?.querySelector('h2')?.textContent || '';
    const waitFor = async (pred, ms = 20000) => { for (let i = 0; i < ms / 100; i++) { const d = top(); if (d && pred(d)) return d; await wait(100); } throw new Error('dialog not found; top is ' + title(top())); };
    const noDialog = async () => { for (let i = 0; i < 80 && document.querySelector('.ql-dialog'); i++) await wait(50); };
    const open = async (n) => {
      const before = qn.picture;
      await qn.exec('file.openDropped', [new File([bytes(n)], n)]);
      for (let i = 0; i < 100 && (!qn.picture || qn.picture === before) && !document.querySelector('.ql-toast'); i++) await wait(50);
      return qn.picture !== before ? qn.picture : [...document.querySelectorAll('.ql-toast')].map((t) => t.textContent).join(' | ');
    };
    const out = {};
    qn.prefs.confirmClose = false;
    let pic = await open('book.djvu');
    if (typeof pic === 'string') return { error: pic };
    out.book = [pic.format.id, pic.decoder, pic.pages.length, pic.pages.map((pg) => [pg.width, pg.height]), pic.info.pages, [...pic.frameCanvas().getContext('2d').getImageData(200, 100, 1, 1).data].slice(0, 3)];
    await qn.exec('pages.next'); await qn.exec('pages.next'); await wait(100);
    out.page = [qn.picture.page, qn.picture.current.textLayer?.words.length];
    const O = await window.__qnOcr();
    const run = qn.exec('tools.ocr');
    let d = await waitFor((x) => title(x) === 'Recognize Text');
    out.ask = [/text layer stored in the file \(6 words\)/.test(d.textContent), d.querySelector('.ql-primary')?.textContent];
    d.querySelector('.ql-primary').click();
    d = await waitFor((x) => title(x) === 'Text Layer');
    out.text = d.querySelector('[id^="f_text_"]').value;
    out.help = /6 words in 2 lines, stored in the file \(DjVu text layer\)/.test(d.textContent);
    const qf = d.querySelector('[id^="f_q_"]'); qf.value = '1851'; qf.dispatchEvent(new Event('input', { bubbles: true })); qf.dispatchEvent(new Event('change', { bubbles: true })); await wait(100);
    out.match = O.viewState.ocr.words.filter((w) => O.ocrMatch(w.text, O.viewState.ocr.query)).map((w) => w.bbox);
    d.querySelector('.ql-primary').click(); await run; await noDialog();
    // Turning the page makes the word boxes wrong: the text layer goes.
    await qn.exec('image.rotateRight'); await wait(100);
    out.rotated = [qn.picture.current.width, qn.picture.current.height, qn.picture.current.textLayer === undefined];
    pic = await open('shared.djvu');
    out.shared = typeof pic === 'string' ? pic : [pic.pages.length, pic.pages[0].width, pic.pages[0].height, pic.warnings.length];
    return out;
  }, djvuFiles);
  check('djvu: a bundled book opens through djvu-rs with every page and its rotation', dj.book, ['djvu', 'djvu-rs', 4, [[320, 240], [150, 200], [600, 260], [600, 260]], '4', [240, 220, 39]], JSON.stringify(dj)); // ddjvu's value there (IW44 is lossy)
  check('djvu: Recognize Text offers the page\'s stored text layer and finds words on it', [dj.page, dj.ask, dj.text, dj.help, dj.match], [[2, 6], [true, 'Show the text layer'], 'Parish register 1851\nBaptisms and burials', true, [{ x0: 295, y0: 40, x1: 387, y1: 70 }]], JSON.stringify(dj));
  check('djvu: rotating a page drops its text layer; shared JB2 dictionaries', [dj.rotated, dj.shared], [[260, 600, true], [3, 600, 200, 0]], JSON.stringify(dj));

  // M3: selection, crop, resize, grayscale, canvas size and undo through the real commands.
  const editOps = await p.evaluate(async () => {
    const mk = (w, h, color) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, w, h); x.fillStyle = '#00ff00'; x.fillRect(10, 10, 20, 20); return c; };
    const blob = (c, t) => new Promise((r) => c.toBlob(r, t));
    await qn.exec('file.openDropped', [new File([await blob(mk(100, 80, '#ff0000'), 'image/png')], 'edit.png')]);
    await new Promise((r) => setTimeout(r, 600));
    const out = {};
    qn.tab.setSelection({ x: 10, y: 10, w: 20, h: 20 });
    await new Promise((r) => setTimeout(r, 120));
    out.sel = [...document.querySelectorAll('.ql-status .ql-status-item')].some((e) => /20 × 20 at 10, 10/.test(e.textContent));
    await qn.exec('edit.crop'); await new Promise((r) => setTimeout(r, 100));
    out.cropped = [qn.picture.width, qn.picture.height, [...qn.viewer.pixelAt(5, 5)].slice(0, 3), qn.tab.selection];
    await qn.exec('edit.undo');
    out.undone = [qn.picture.width, qn.picture.height];
    const { resizeTo } = await window.__qnImageOps();
    resizeTo(qn, 50, 40, 'lanczos3');
    out.resized = [qn.picture.width, qn.picture.height, [...qn.viewer.pixelAt(2, 2)].slice(0, 3), [...qn.viewer.pixelAt(10, 10)].slice(0, 3)];
    await qn.exec('image.grayscale');
    out.gray = [...qn.viewer.pixelAt(2, 2)].slice(0, 3);
    await qn.exec('image.negative', 'all');
    out.neg = [...qn.viewer.pixelAt(2, 2)].slice(0, 3);
    out.undoLabel = qn.tab.undoLabel;
    await qn.exec('edit.selectAll');
    out.all = qn.tab.selection;
    await qn.exec('edit.copy'); await new Promise((r) => setTimeout(r, 200));
    out.clip = qn.clipRaster ? [qn.clipRaster.width, qn.clipRaster.height] : null;
    return out;
  });
  check('selection in status', editOps.sel, true);
  check('crop', editOps.cropped, [20, 20, [0, 255, 0], null]);
  check('crop undo', editOps.undone, [100, 80]);
  check('resize', editOps.resized, [50, 40, [255, 0, 0], [0, 255, 0]]);
  check('grayscale', editOps.gray, [76, 76, 76]);
  check('negative', editOps.neg, [179, 179, 179]);
  check('negative label', editOps.undoLabel, 'Negative');
  check('select all', editOps.all, { x: 0, y: 0, w: 50, h: 40 });
  check('copy selection', editOps.clip, [50, 40]);

  // Thumbnails: the grid lists the folder, thumbnails decode lazily, clicking one shows it, T closes the grid.
  await p.evaluate(async () => {
    const mk = (w, h, color) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, w, h); return c; };
    const blob = (c, t) => new Promise((r) => c.toBlob(r, t));
    const files = [];
    for (const [n, col] of [['t1.png', '#f00'], ['t2.png', '#0f0'], ['t3.png', '#00f']]) files.push(new File([await blob(mk(64, 48, col), 'image/png')], n));
    await qn.exec('file.openDropped', files);
  });
  await p.waitForTimeout(600);
  await p.evaluate(() => qn.exec('browse.thumbnails'));
  await p.waitForSelector('.qn-thumb-pic canvas');
  await p.waitForTimeout(400);
  check('thumb grid', await p.evaluate(() => { const w = qn.tab.el; return [w.querySelectorAll('.qn-thumb').length, w.querySelectorAll('.qn-thumb-pic canvas').length, getComputedStyle(w.querySelector('.qn-viewer')).display, w.querySelector('.qn-thumb.qn-current .qn-thumb-name').textContent]; }), [3, 3, 'none', 't1.png']);
  await p.click('.qn-thumb:nth-child(2)');
  await p.waitForTimeout(400);
  check('thumb click', await p.evaluate(() => [qn.picture.name, document.querySelector('.qn-thumb.qn-current .qn-thumb-name').textContent]), ['t2.png', 't2.png']);
  await p.evaluate(() => { const t = document.querySelector('.qn-thumb:nth-child(3)'); t.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); });
  check('thumb mark', await p.evaluate(() => [qn.tab.marked.size, document.querySelectorAll('.qn-thumb.qn-marked').length]), [1, 1]);
  await p.evaluate(() => qn.exec('browse.viewMode', 'filmstrip'));
  await p.waitForTimeout(200);
  check('filmstrip', await p.evaluate(() => { const w = qn.tab.el; return [getComputedStyle(w.querySelector('.qn-viewer')).display !== 'none', w.querySelector('.qn-thumbs').classList.contains('qn-thumbs-strip')]; }), [true, true]);
  await p.evaluate(() => qn.exec('browse.viewMode', 'off'));
  check('thumbs off', await p.evaluate(() => qn.tab.el.querySelector('.qn-thumbs').style.display), 'none');

  // Batch: the engine converts the three thumbnails to JPEG at 32 px with a counter pattern into a collecting sink.
  const batch = await p.evaluate(async () => {
    const { runBatch } = await window.__qnBatch();
    const outputs = [];
    const job = { inputs: [...qn.folder.entries], format: 'jpeg', quality: 80, keepMeta: true, steps: { resize: { mode: 'long', value: 32, kernel: 'lanczos3', onlyShrink: true }, grayscale: true }, names: { pattern: 'out-{n:2}', start: 1, pad: 2 } };
    const res = await runBatch(qn, job, async (r) => { outputs.push({ name: r.name, size: r.data.length, head: [...r.data.subarray(0, 3)] }); return { uri: null, name: r.name }; }, { silent: true });
    const bmp = await createImageBitmap(new Blob([await (async () => { const { runBatch: rb } = await window.__qnBatch(); let d; await rb(qn, { ...job, inputs: [qn.folder.entries[1]] }, async (r) => { d = r.data; return { uri: null, name: r.name }; }, { silent: true }); return d; })()], { type: 'image/jpeg' }));
    return { names: outputs.map((o) => o.name), heads: outputs.map((o) => o.head), done: res.done.length, failed: res.failed.length, size: [bmp.width, bmp.height] };
  });
  check('batch names', batch.names, ['out-01.jpg', 'out-02.jpg', 'out-03.jpg']);
  check('batch jpeg', batch.heads.every((h) => h[0] === 255 && h[1] === 216), true);
  check('batch counts', [batch.done, batch.failed], [3, 0]);
  check('batch resize', batch.size, [32, 24]);

  // Adjust: auto-adjust, sharpen and Before/After through the real commands (on the picture the batch left open).
  const adj = await p.evaluate(async () => {
    const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); const g = x.createLinearGradient(0, 0, w, 0); g.addColorStop(0, '#303030'); g.addColorStop(1, '#a0a0a0'); x.fillStyle = g; x.fillRect(0, 0, w, h); return c; };
    const blob = (c, t) => new Promise((r) => c.toBlob(r, t));
    await qn.exec('file.openDropped', [new File([await blob(mk(80, 20), 'image/png')], 'adj.png')]);
    await new Promise((r) => setTimeout(r, 600));
    const before = [...qn.viewer.pixelAt(79, 10)].slice(0, 3);
    await qn.exec('adjust.auto');
    const after = [...qn.viewer.pixelAt(79, 10)].slice(0, 3);
    await qn.exec('adjust.sharpen');
    const label = qn.tab.undoLabel;
    await qn.exec('adjust.beforeAfter');
    const orig = [...qn.viewer.pixelAt(79, 10)].slice(0, 3);
    const showing = qn.tab.showingOriginal;
    await qn.exec('adjust.beforeAfter');
    return { before, after, label, orig, showing, back: qn.tab.showingOriginal, canUndo: qn.tab.canUndo };
  });
  check('auto adjust brightens the light end', adj.after[0] > adj.before[0] + 30, true);
  check('sharpen label', adj.label, 'Sharpen');
  check('before/after shows the original', [adj.orig, adj.showing, adj.back, adj.canUndo], [adj.before, true, false, true]);

  // Effects: a dialog effect accepted through its OK button, Repeat Last, a canvas-changing frame, the browser grid and the custom convolution.
  const fxr = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const ok = async () => { for (let i = 0; i < 40; i++) { const b = document.querySelector('.ql-dialog .ql-primary'); if (b && document.querySelector('.ql-dialog-preview img')) { b.click(); return true; } await wait(50); } return false; };
    const w0 = qn.picture.width, h0 = qn.picture.height;
    const before = [...qn.viewer.pixelAt(40, 10)].slice(0, 3);
    const run = qn.exec('fx.solarize'); const clicked = await ok(); await run; await wait(100);
    const sol = [...qn.viewer.pixelAt(40, 10)].slice(0, 3), label1 = qn.tab.undoLabel;
    await qn.exec('fx.repeatLast'); await wait(100);
    const twice = [...qn.viewer.pixelAt(40, 10)].slice(0, 3), label2 = qn.tab.undoLabel;
    const run2 = qn.exec('fx.instantFrame'); const clicked2 = await ok(); await run2; await wait(100);
    const framed = [qn.picture.width, qn.picture.height];
    const run3 = qn.exec('fx.browser'); let cards = 0; for (let i = 0; i < 40; i++) { cards = document.querySelectorAll('.qn-fxcard img[src^="data:"]').length; if (cards >= 10) break; await wait(50); }
    document.querySelector('.ql-dialog .ql-btn:not(.ql-primary)')?.click(); await run3;
    const run4 = qn.exec('fx.convolution'); const clicked4 = await ok(); await run4; await wait(100);
    return { clicked, clicked2, clicked4, before, sol, twice, label1, label2, w0, h0, framed, cards, label4: qn.tab.undoLabel, canUndo: qn.tab.canUndo };
  });
  check('solarize dialog applied', [fxr.clicked, fxr.label1], [true, 'Solarize']);
  check('solarize inverts the light end', fxr.sol[0] < fxr.before[0] && fxr.sol[0] === 255 - fxr.before[0], true);
  check('repeat last effect re-solarizes', [fxr.label2, fxr.twice[0] < fxr.sol[0] || fxr.twice[0] === fxr.sol[0]], ['Solarize', true]);
  check('instant frame grows the canvas', [fxr.clicked2, fxr.framed[0] > fxr.w0, fxr.framed[1] > fxr.h0 + (fxr.framed[0] - fxr.w0) / 2], [true, true, true]);
  check('effects browser renders thumbnails', fxr.cards >= 10, true);
  check('custom convolution applied', [fxr.clicked4, fxr.label4, fxr.canUndo], [true, 'Custom Filter', true]);

  // Metadata: rating and favorite through the commands, the caption dialog, Strip Metadata and a checksum (the web File has no URI, so writes go through the download path).
  const md = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const M = await window.__qnMeta(), N = await window.__qnNative();
    const dialog = async () => { for (let i = 0; i < 60; i++) { if (document.querySelector('.ql-dialog .ql-primary')) return true; await wait(50); } return false; };
    // A fake File System Access handle so the dropped file has somewhere to write back to.
    const store = { parts: [] };
    const handle = { name: qn.picture.name, kind: 'file', isSameEntry: async () => false, createWritable: async () => ({ write: async (b) => { store.parts.push(b); }, close: async () => {} }) };
    qn.picture.entry.uri = 'fsa:' + (await N.handleId(handle));
    await qn.exec('browse.rate', 4); await wait(150);
    const v1 = await M.readMeta(qn, qn.picture.entry);
    await qn.exec('browse.favorite'); await wait(150);
    const fav = (await M.readMeta(qn, qn.picture.entry)).props.favorite;
    const run = qn.exec('meta.caption'); const d1 = await dialog();
    const title = document.querySelector('.ql-dialog input[id^="f_title_"]'); title.value = 'E2E title'; title.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.ql-dialog .ql-primary').click(); await run; await wait(200);
    const v2 = await M.readMeta(qn, qn.picture.entry);
    const sizeBefore = qn.picture.bytes.length;
    const run2 = qn.exec('meta.strip'); const d2 = await dialog(); document.querySelector('.ql-dialog .ql-primary').click(); await run2; await wait(200);
    const v3 = await M.readMeta(qn, qn.picture.entry);
    return { writes: store.parts.length, uriKept: qn.picture.entry.uri.startsWith('fsa:'), d1, d2, format: qn.picture.format.id, rating: v1.props.rating, fav, title: v2.props.title, ratingKept: v2.props.rating, embeddedAfterStrip: v3.embedded, smaller: qn.picture.bytes.length < sizeBefore, md5: M.md5(new Uint8Array(0)), width: qn.picture.width };
  });
  check('rating written into the PNG', [md.format, md.rating, md.fav, md.writes, md.uriKept], ['png', 4, true, 4, true]);
  check('caption dialog saved the title and kept the rating', [md.d1, md.title, md.ratingKept], [true, 'E2E title', 4]);
  check('strip removed the packet', [md.d2, md.embeddedAfterStrip, md.smaller, md.md5], [true, null, true, 'd41d8cd98f00b204e9800998ecf8427e']);

  // Region Tags: add a region from the selection, save it into the PNG, read it back.
  const reg = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const M = await window.__qnMeta(), N = await window.__qnNative();
    const top = () => [...document.querySelectorAll('.ql-dialog')].pop();
    const title = (d) => d?.querySelector('h2')?.textContent || '';
    const waitFor = async (pred, ms = 6000) => { for (let i = 0; i < ms / 50; i++) { const d = top(); if (d && pred(d)) return d; await wait(50); } throw new Error('dialog not found; top is ' + title(top())); };
    const noDialog = async () => { for (let i = 0; i < 80 && document.querySelector('.ql-dialog'); i++) await wait(50); };
    const field = (d, key) => d.querySelector(`[id^="f_${key}_"]`);
    const btn = (d, text) => [...d.querySelectorAll('button')].find((b) => b.textContent.trim().replace(/…$/, '') === text);
    await noDialog();
    const store = { parts: [] };
    const handle = { name: qn.picture.name, kind: 'file', isSameEntry: async () => false, createWritable: async () => ({ write: async (b) => { store.parts.push(b); }, close: async () => {} }) };
    qn.picture.entry.uri = 'fsa:' + (await N.handleId(handle));
    qn.tab.setSelection({ x: 10, y: 8, w: 20, h: 16 });
    const run = qn.exec('meta.regions');
    let d = await waitFor((x) => title(x) === 'Region Tags');
    btn(d, 'Add region').click();
    d = await waitFor((x) => title(x) === 'Add Region' && !!field(x, 'name'));
    field(d, 'name').value = 'Anne'; field(d, 'name').dispatchEvent(new Event('input', { bubbles: true }));
    const fs = field(d, 'fromSel'); if (fs) { fs.checked = true; fs.dispatchEvent(new Event('change', { bubbles: true })); }
    d.querySelector('.ql-primary').click();
    // The Region Tags dialog reopens with the new region listed.
    d = await waitFor((x) => title(x) === 'Region Tags' && /Anne/.test(x.textContent) && !!btn(x, 'Save'));
    btn(d, 'Save').click();
    await run; await noDialog();
    for (let i = 0; i < 60 && !store.parts.length; i++) await wait(50);
    await wait(150);
    const view = await M.readMeta(qn, qn.picture.entry);
    const doc = M.readRegions(view.embedded);
    qn.tab.setSelection(null);
    return { writes: store.parts.length, count: doc.regions.length, name: doc.regions[0]?.name, type: doc.regions[0]?.type, dimsOk: !!(doc.dims && doc.dims.w > 0 && doc.dims.h > 0), cx: doc.regions[0] ? Math.round(doc.regions[0].area.x * 100) : 0, person: view.props.personInImage, left: document.querySelectorAll('.ql-dialog').length };
  });
  check('region written to the PNG and read back', [reg.writes > 0, reg.count, reg.name, reg.type, reg.dimsOk, reg.cx > 0 && reg.cx < 100, reg.person, reg.left], [true, 1, 'Anne', 'Face', true, true, ['Anne'], 0]);

  // Find Duplicates: two byte-identical files plus a resized copy and a different picture, grouped through the dialog.
  const dup = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const mk = (w, h, f) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); for (let y = 0; y < h; y += 8) for (let i = 0; i < w; i += 8) { x.fillStyle = f(i, y); x.fillRect(i, y, 8, 8); } return c; };
    const blob = (c) => new Promise((r) => c.toBlob(r, 'image/png'));
    const pat = (i, y) => `hsl(${(i * 3 + y * 5) % 360}, 70%, ${40 + ((i + y) % 32)}%)`;
    const big = mk(128, 96, pat), other = mk(128, 96, (i, y) => ((i / 8 + y / 8) % 2 ? '#fff' : '#000'));
    const small = document.createElement('canvas'); small.width = 64; small.height = 48; small.getContext('2d').drawImage(big, 0, 0, 64, 48);
    const b1 = await blob(big);
    await qn.exec('file.openDropped', [new File([b1], 'one.png'), new File([b1], 'two.png'), new File([await blob(small)], 'half.png'), new File([await blob(other)], 'other.png')]);
    await wait(600);
    const run = qn.exec('browse.findDuplicates');
    for (let i = 0; i < 60 && !document.querySelector('.ql-dialog .ql-primary'); i++) await wait(50);
    document.querySelector('.ql-dialog .ql-primary').click();
    let title = ''; for (let i = 0; i < 100; i++) { const t = document.querySelector('.ql-dialog-head'); if (t && /Duplicates —/.test(t.textContent)) { title = t.textContent; break; } await wait(50); }
    const cards = document.querySelectorAll('.ql-dialog .qn-fxcard').length;
    document.querySelector('.ql-dialog .ql-primary').click(); await run; await wait(100);
    return { title, cards, marked: qn.tab.marked.size, order: qn.folder.length };
  });
  check('duplicates grouped', [/1 group/.test(dup.title), dup.cards, dup.marked, dup.order], [true, 3, 2, 4]);

  // Adjust: Curves with the Brighten preset through its dialog, then Copy / Paste Adjustments onto the next picture.
  const cv = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const dialog = async () => { for (let i = 0; i < 60; i++) { if (document.querySelector('.ql-dialog .ql-primary') && document.querySelector('.ql-dialog-preview img')) return true; await wait(50); } return false; };
    const before = [...qn.viewer.pixelAt(10, 10)].slice(0, 3);
    const run = qn.exec('adjust.curves'); const d1 = await dialog();
    const curve = !!document.querySelector('.ql-dialog canvas.qn-curve');
    const presetSel = document.querySelectorAll('.ql-dialog select')[1]; presetSel.value = 'Brighten'; presetSel.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(300);
    document.querySelector('.ql-dialog .ql-primary').click(); await run; await wait(200);
    const after = [...qn.viewer.pixelAt(10, 10)].slice(0, 3);
    await qn.exec('adjust.copySettings'); await wait(50);
    qn.prefs.confirmClose = false; // leaving an edited picture must not prompt here
    await qn.exec('view.next'); await wait(500);
    const name2 = qn.picture.name; const b2 = [...qn.viewer.pixelAt(10, 10)].slice(0, 3);
    await qn.exec('adjust.pasteSettings'); await wait(200);
    const a2 = [...qn.viewer.pixelAt(10, 10)].slice(0, 3);
    return { d1, curve, before, after, name2, b2, a2, label: qn.tab.undoLabel };
  });
  check('curves preset brightens', [cv.d1, cv.curve, cv.after[1] > cv.before[1]], [true, true, true]);
  check('paste adjustments replays the curve', [cv.a2[1] > cv.b2[1], cv.label], [true, 'Paste Adjustments']);

  // Insert Text through its dialog (bottom-right corner changes), then Join Side by Side of the four pictures into a new window, and the History panel.
  const ins = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const dialog = async () => { for (let i = 0; i < 80; i++) { if (document.querySelector('.ql-dialog .ql-primary') && document.querySelector('.ql-dialog-preview img')) return true; await wait(50); } return false; };
    const w = qn.picture.width, h = qn.picture.height;
    const before = [...qn.viewer.pixelAt(w - 3, h - 3)].slice(0, 3);
    const run = qn.exec('edit.insertText'); const d1 = await dialog();
    const ta = document.querySelector('.ql-dialog textarea'); ta.value = 'HELLO {w}'; ta.dispatchEvent(new Event('input', { bubbles: true }));
    const anchor = [...document.querySelectorAll('.ql-dialog select')].find((s) => [...s.options].some((o) => o.value === 'br')); anchor.value = 'mc'; anchor.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(300); document.querySelector('.ql-dialog .ql-primary').click(); await run; await wait(200);
    let changed = false; for (let y = Math.floor(h * 0.3); y < h * 0.7 && !changed; y += 2) for (let x = Math.floor(w * 0.2); x < w * 0.8; x += 2) { const px = qn.viewer.pixelAt(x, y); if (px[0] > 240 && px[1] > 240 && px[2] > 240) { changed = true; break; } }
    const label = qn.tab.undoLabel;
    const runH = qn.exec('edit.history'); for (let i = 0; i < 40 && !document.querySelector('.ql-dialog .qn-fxcard'); i++) await wait(50);
    const cards = document.querySelectorAll('.ql-dialog .qn-fxcard').length; document.querySelector('.ql-dialog .ql-primary').click(); await runH;
    for (let i = 0; i < 40 && document.querySelector('.ql-dialog'); i++) await wait(50);
    const windowsBefore = qn.tabs.length;
    const run2 = qn.exec('create.panoramaJoin'); for (let i = 0; i < 40 && !document.querySelector('.ql-dialog .ql-primary'); i++) await wait(50);
    document.querySelector('.ql-dialog .ql-primary').click(); await run2; await wait(800);
    return { d1, before, changed, label, cards, windowsBefore, windowsAfter: qn.tabs.length, name: qn.picture?.name, width: qn.picture?.width, height: qn.picture?.height };
  });
  check('insert text drew white text', [ins.d1, ins.changed, ins.label], [true, true, 'Insert Text']);
  check('history panel lists the states', ins.cards >= 2, true);
  check('join side by side opened a new window', [ins.windowsAfter, /-joined\.png$/.test(ins.name), ins.height], [ins.windowsBefore + 1, true, 48]);

  // Geometry: Auto Straighten levels a picture of lines tilted by 5°; Crop Page from Photo flattens a bright page on a dark background.
  const geo = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const blob = (c) => new Promise((r) => c.toBlob(r, 'image/png'));
    const tilted = document.createElement('canvas'); tilted.width = 240; tilted.height = 180; { const x = tilted.getContext('2d'); x.fillStyle = '#eee'; x.fillRect(0, 0, 240, 180); x.translate(120, 90); x.rotate((5 * Math.PI) / 180); for (let y = -80; y < 80; y += 16) { const g = x.createLinearGradient(0, y, 0, y + 6); g.addColorStop(0, '#eee'); g.addColorStop(0.5, '#222'); g.addColorStop(1, '#eee'); x.fillStyle = g; x.fillRect(-150, y, 300, 6); } }
    const page = document.createElement('canvas'); page.width = 200; page.height = 150; { const x = page.getContext('2d'); x.fillStyle = '#222'; x.fillRect(0, 0, 200, 150); x.fillStyle = '#f4f4f4'; x.beginPath(); x.moveTo(50, 30); x.lineTo(160, 40); x.lineTo(150, 125); x.lineTo(40, 115); x.closePath(); x.fill(); }
    qn.prefs.confirmClose = false;
    await qn.exec('file.openDropped', [new File([await blob(tilted)], 'a-tilted.png'), new File([await blob(page)], 'b-page.png')]);
    await wait(600);
    await qn.exec('image.autoStraighten'); await wait(200);
    const label = qn.tab.undoLabel;
    await qn.exec('view.next'); await wait(500);
    const before = [qn.picture.width, qn.picture.height];
    await qn.exec('edit.cropPage'); await wait(300);
    const after = [qn.picture.width, qn.picture.height];
    const fc = qn.picture.frameCanvas(); const center = [...fc.getContext('2d').getImageData(Math.floor(fc.width / 2), Math.floor(fc.height / 2), 1, 1).data].slice(0, 3);
    return { label, before, after, center, label2: qn.tab.undoLabel };
  });
  check('auto straighten found about -5°', /^Auto Straighten -(4|5|6)\./.test(geo.label), true);
  check('crop page flattened the page', [geo.label2, geo.after[0] < geo.before[0], geo.after[1] < geo.before[1], geo.center[0] > 200], ['Crop Page from Photo', true, true, true]);

  // Batch Steps: an ordered job (resize, border, text watermark, metadata) through the runner with an in-memory sink.
  const bs = await p.evaluate(async () => {
    const B = await window.__qnBatch(), S = await window.__qnBatchSteps(), M = await window.__qnMeta();
    const entries = qn.tab.folder.entries;
    const actions = S.resolveActions([{ kind: 'resize', mode: 'long', value: 100, kernel: 'bilinear', onlyShrink: true }, { kind: 'border', size: 5, color: '#ff0000' }, { kind: 'text', text: '{basename}', size: 10, color: '#ffffff', anchor: 'mc', margin: 0, opacity: 1, outline: 1, font: 'sans-serif' }, { kind: 'metadata', patch: { rights: '© test', keywords: ['batch'] } }], 100);
    const job = { inputs: entries, format: 'png', quality: 90, keepMeta: true, steps: { actions }, names: { pattern: '{name}-steps' } };
    const outs = [];
    const res = await B.runBatch(qn, job, async (r) => { outs.push(r); return { uri: null, name: r.name }; }, { silent: true });
    const first = outs[0];
    const props = M.parseXmp(new TextDecoder().decode(M.extractMeta(first.data).xmp));
    const bmp = await createImageBitmap(new Blob([first.data], { type: 'image/png' }));
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
    const corner = [...x.getImageData(1, 1, 1, 1).data].slice(0, 3);
    return { n: res.done.length, names: outs.map((o) => o.name), size: [bmp.width, bmp.height], corner, rights: props.rights, keywords: props.keywords, desc: S.describeAction(actions[1]) };
  });
  check('batch steps ran in order', [bs.n, bs.names[0].endsWith('-steps.png'), bs.size, bs.corner, bs.rights, bs.keywords, bs.desc], [2, true, [110, 85], [255, 0, 0], '© test', ['batch'], 'Border 5 px']);

  // Frames and pages: an APNG with three frames reversed and its loop count set; a two-page TIFF with a page deleted.
  const pf = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const A = await window.__qnAnim();
    const mkr = (w, h, v) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255).map((x, i) => (i % 4 === 0 ? v : i % 4 === 3 ? 255 : 0)) });
    const apng = await A.encodeApng([{ raster: mkr(16, 16, 10), delay: 100 }, { raster: mkr(16, 16, 120), delay: 100 }, { raster: mkr(16, 16, 250), delay: 100 }], 0);
    const tif = A.encodeTiff([{ raster: mkr(20, 10, 30) }, { raster: mkr(12, 8, 200) }]);
    qn.prefs.confirmClose = false;
    await qn.exec('file.openDropped', [new File([apng], 'a-anim.png'), new File([tif], 'b-pages.tif')]);
    await wait(700);
    const frames = qn.picture.current.frames.length;
    const first = qn.picture.frameCanvas(qn.picture.current.frames[0]).getContext('2d').getImageData(0, 0, 1, 1).data[0];
    await qn.exec('frames.reverse'); await wait(100);
    const firstAfter = qn.picture.frameCanvas(qn.picture.current.frames[0]).getContext('2d').getImageData(0, 0, 1, 1).data[0];
    const run = qn.exec('frames.loopCount'); for (let i = 0; i < 40 && !document.querySelector('.ql-dialog .ql-primary'); i++) await wait(50);
    const inp = document.querySelector('.ql-dialog input[type=number]'); inp.value = '3'; inp.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.ql-dialog .ql-primary').click(); await run; await wait(100);
    const loops = qn.picture.current.loops;
    await qn.exec('view.next'); await wait(600);
    const pages = qn.picture.pages.length;
    await qn.exec('pages.delete'); await wait(100);
    return { frames, first, firstAfter, loops, pages, pagesAfter: qn.picture.pages.length, width: qn.picture.width, label: qn.tab.undoLabel };
  });
  check('frames reversed and loop count set', [pf.frames, pf.first, pf.firstAfter, pf.loops], [3, 10, 250, 3]);
  check('page deleted', [pf.pages, pf.pagesAfter, pf.width, pf.label], [2, 1, 12, 'Delete page 1']);

  // View overlays: the grid draws white lines on the picture, grayscale preview changes the display but not the pixels, clipping warnings mark the white page.
  const ov = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const O = await window.__qnOverlays();
    const blob = (c) => new Promise((r) => c.toBlob(r, 'image/png'));
    const c = document.createElement('canvas'); c.width = 120; c.height = 90; const x = c.getContext('2d'); x.fillStyle = '#c03030'; x.fillRect(0, 0, 120, 90); x.fillStyle = '#ffffff'; x.fillRect(80, 60, 40, 30);
    await qn.exec('file.openDropped', [new File([await blob(c)], 'ov.png')]); await wait(600);
    await qn.exec('view.actualSize'); await wait(200);
    const v = qn.viewer; const r = v.pictureRect(); const vc = v.el.querySelector('canvas'); const vx = vc.getContext('2d'); const dpr = vc.width / v.el.clientWidth;
    const at = (px, py) => [...vx.getImageData(Math.round((r.x + px) * dpr), Math.round((r.y + py) * dpr), 1, 1).data].slice(0, 3);
    const plain = at(40, 30);
    await qn.exec('view.grid', 'thirds'); await wait(150);
    const onLine = [39, 40, 41].map((xx) => at(xx, 30)).reduce((a, b) => (b[1] > a[1] ? b : a));
    await qn.exec('view.grid', 'off'); await qn.exec('view.grayscalePreview'); await wait(150);
    const gray = at(20, 20); const pixel = [...v.pixelAt(20, 20)].slice(0, 3);
    await qn.exec('view.grayscalePreview'); await qn.exec('view.clipping'); await wait(150);
    const clipped = at(100, 75);
    await qn.exec('view.clipping'); await qn.exec('view.osd'); await wait(150);
    const osd = O.viewState.osd; await qn.exec('view.osd');
    return { plain, onLine, gray, pixel, clipped, osd };
  });
  check('grid line is white over red', [ov.plain[0] > 150 && ov.plain[1] < 80, ov.onLine[1] > 150], [true, true]);
  check('grayscale preview leaves the pixels', [Math.abs(ov.gray[0] - ov.gray[1]) < 3, ov.pixel[0] > 150 && ov.pixel[1] < 80], [true, true]);
  check('clipping marks the white area red', [ov.clipped[0] > 200, ov.clipped[1] < 80, ov.osd], [true, true, true]);

  // Slideshow: a 1-second show over three pictures advances, pauses on Space and stops on Escape, restoring the view.
  const sl = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const blob = (c) => new Promise((r) => c.toBlob(r, 'image/png'));
    const mk = (v) => { const c = document.createElement('canvas'); c.width = 30; c.height = 20; const x = c.getContext('2d'); x.fillStyle = v; x.fillRect(0, 0, 30, 20); return c; };
    qn.prefs.confirmClose = false;
    await qn.exec('file.openDropped', [new File([await blob(mk('#f00'))], 's1.png'), new File([await blob(mk('#0f0'))], 's2.png'), new File([await blob(mk('#00f'))], 's3.png')]); await wait(600);
    qn.prefs.slideshow = { seconds: 0.6, transition: 'fade', transitionMs: 100, loop: true, random: false, captions: true };
    const SH = await window.__qnShow();
    await qn.exec('show.start'); await wait(100);
    const running = SH.show.running, full = document.body.classList.contains('ql-fullscreen'), osd = (await window.__qnOverlays()).viewState.osd;
    const i0 = qn.folder.index; await wait(900); const i1 = qn.folder.index;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })); await wait(50); const paused = SH.show.paused;
    await wait(900); const i2 = qn.folder.index;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(100);
    return { running, full, osd, i0, i1, paused, i2, stopped: !SH.show.running, fullAfter: document.body.classList.contains('ql-fullscreen'), osdAfter: (await window.__qnOverlays()).viewState.osd };
  });
  check('slideshow runs full screen with captions and advances', [sl.running, sl.full, sl.osd, sl.i0, sl.i1], [true, true, true, 0, 1]);
  check('slideshow pauses on Space and stops on Escape', [sl.paused, sl.i2, sl.stopped, sl.fullAfter, sl.osdAfter], [true, 1, true, false, false]);

  // Background Music: two generated WAV tracks (a third file that is not audio is refused) play during a slideshow, pause with it and fade out when it stops.
  const mu = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const wav = (secs, hz) => { const rate = 8000, n = rate * secs, b = new DataView(new ArrayBuffer(44 + n * 2)); const w = (o, t) => [...t].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
      w(0, 'RIFF'); b.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true); b.setUint32(24, rate, true); b.setUint32(28, rate * 2, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); w(36, 'data'); b.setUint32(40, n * 2, true);
      for (let i = 0; i < n; i++) b.setInt16(44 + i * 2, Math.round(3000 * Math.sin(2 * Math.PI * hz * i / rate)), true); return b.buffer; };
    const M = await window.__qnMusic(), SH = await window.__qnShow();
    const list = await qn.exec('show.music', { clear: true, files: [new File([wav(3, 440)], 'tone-a.wav', { type: 'audio/wav' }), new File([wav(3, 660)], 'tone-b.wav', { type: 'audio/wav' }), new File(['x'], 'notes.txt', { type: 'text/plain' })], on: true, volume: 0.5, shuffle: false });
    const names = list.map((t) => t.name);
    await qn.exec('show.start'); await wait(700);
    const playing = M.music.playing, track = M.music.track, t1 = M.music.audio?.currentTime || 0, vol = M.music.audio?.volume, err = M.music.error;
    SH.togglePause(qn); await wait(300); const pausedPlaying = M.music.playing, tp = M.music.audio.currentTime; await wait(300); const tp2 = M.music.audio.currentTime;
    SH.togglePause(qn); await wait(300); const resumed = M.music.playing;
    SH.stop(qn); await wait(1600);
    const stopped = !M.music.playing && !M.music.url;
    await qn.exec('show.music', { on: false });
    return { names, playing, track, t1: t1 > 0, vol, err, pausedPlaying, still: tp === tp2, resumed, stopped, remoteOff: window.__qnGetCommand('show.remote').isEnabled(qn) };
  });
  check('background music: audio files kept, plays with the show, pauses with it, fades out at the end', [mu.names, mu.playing, mu.track, mu.t1, mu.vol, mu.pausedPlaying, mu.still, mu.resumed, mu.stopped, mu.remoteOff], [['tone-a.wav', 'tone-b.wav'], true, 'tone-a.wav', true, 0.5, false, true, true, true, false], JSON.stringify(mu));

  // Map: three geotagged pictures (two in Paris, one in New York) and one without a location. Tiles come from a stand-in
  // server; markers group and ungroup with zoom; a marker opens its picture; the offline outline draws land without tiles.
  const tileReqs = [];
  const tilePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await p.route('https://tile.openstreetmap.org/**', (route) => { tileReqs.push(new URL(route.request().url()).pathname); route.fulfill({ status: 200, contentType: 'image/png', body: tilePng }); });
  const mp = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const MM = await window.__qnMeta(), MAP = await window.__qnMap();
    const X = MM.parseXmp ? MM : null;
    const mk = async (name, color, at) => {
      const c = document.createElement('canvas'); c.width = 40; c.height = 30; const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, 40, 30);
      let u8 = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
      if (at) u8 = MM.setXmp(u8, 'png', new TextEncoder().encode(MM.updateXmp(null, { lat: at[0], lon: at[1] })));
      return new File([u8], name, { type: 'image/png' });
    };
    await qn.exec('file.openDropped', [await mk('m1-paris.png', '#f00', [48.8566, 2.3522]), await mk('m2-paris.png', '#0f0', [48.8570, 2.3530]), await mk('m3-nyc.png', '#00f', [40.7128, -74.006]), await mk('m4-none.png', '#ff0', null)]); await wait(500);
    const quiet = await qn.exec('browse.map', { source: 'folder', quiet: true });
    qn.prefs.mapTiles = { basemap: 'osm', template: '' };
    const run = qn.exec('browse.map', { source: 'folder' });
    let dlg; for (let i = 0; i < 60 && !(dlg = [...document.querySelectorAll('.ql-dialog')].find((d) => d.getAttribute('aria-label') === 'Map')); i++) await wait(50);
    await wait(400); const mv = MAP.mapState.view; mv.paint();
    const pins = () => [...dlg.querySelectorAll('.qn-map-pin')].map((b) => b.textContent || '1').sort();
    const fitPins = pins(), fitZ = mv.view.z, tiles = dlg.querySelectorAll('.qn-map-tile').length, credit = dlg.querySelector('.qn-map-credit').textContent, status = dlg.querySelector('.qn-map-status').textContent;
    [...dlg.querySelectorAll('.qn-map-pin')].find((b) => b.textContent === '2').click(); mv.paint();
    const zoomedZ = mv.view.z, zoomedPins = pins();
    // Offline outline: no tiles, land drawn.
    const sel = dlg.querySelector('select[name="basemap"], [data-key="basemap"] select') || [...dlg.querySelectorAll('select')][1];
    sel.value = 'offline'; sel.dispatchEvent(new Event('change', { bubbles: true })); sel.dispatchEvent(new Event('input', { bubbles: true }));
    mv.fit(); for (let i = 0; i < 100 && !mv['rings']; i++) await wait(50); mv.paint();
    const offTiles = dlg.querySelectorAll('.qn-map-tile').length, cv = dlg.querySelector('.qn-map-base'), g = cv.getContext('2d');
    // Central France is land; a point in the mid-Atlantic is sea.
    const k = cv.width / mv.w, at = (lat, lon) => { const s = MAP.toScreen({ lat, lon }, mv.view, mv.w, mv.h); return [...g.getImageData(Math.round(s.x * k), Math.round(s.y * k), 1, 1).data].slice(0, 3); };
    const land = at(46.5, 2.5), sea = at(44, -40), saved = qn.prefs.mapTiles.basemap;
    mv.setBasemap('osm'); mv.fit(); mv.paint(); mv.zoomBy(18 - mv.view.z, ...Object.values(MAP.toScreen({ lat: 48.8566, lon: 2.3522 }, mv.view, mv.w, mv.h))); mv.paint();
    const single = [...dlg.querySelectorAll('.qn-map-pin')].find((b) => b.getAttribute('aria-label') === 'm1-paris.png');
    single.click(); await run; await wait(300);
    qn.prefs.mapTiles = { basemap: 'osm', template: '' };
    return { quiet: [quiet.total, quiet.points.map((x) => x.name)], fitPins, fitZ, tiles, credit, status, zoomedZ, zoomedPins, offTiles, land, sea, saved, opened: qn.picture.name, closed: !document.querySelector('.ql-dialog[aria-label="Map"]'), mapGone: MAP.mapState.view === null };
  });
  check('map: locations read from XMP; grouped at the fit, ungrouped when the group is clicked', [mp.quiet, mp.fitPins, mp.fitZ >= 2 && mp.fitZ <= 5, mp.tiles > 0, /OpenStreetMap/.test(mp.credit), /3 of 4 pictures have a location · 3 in view/.test(mp.status), mp.zoomedZ >= 15, mp.zoomedPins], [[4, ['m1-paris.png', 'm2-paris.png', 'm3-nyc.png']], ['1', '2'], true, true, true, true, true, ['1', '1']], JSON.stringify(mp));
  check('map: tiles requested by zoom, x and y from the tile server', [tileReqs.length > 0, tileReqs.every((u) => /^\/\d+\/\d+\/\d+\.png$/.test(u)), tileReqs.some((u) => u.startsWith(`/${mp.fitZ}/`))], [true, true, true], tileReqs.slice(0, 5).join(' '));
  check('map: offline outline draws land and sea without tiles; a marker opens its picture', [mp.offTiles, mp.saved, mp.land, mp.sea, mp.opened, mp.closed, mp.mapGone], [0, 'offline', [242, 239, 233], [170, 211, 223], 'm1-paris.png', true, true], JSON.stringify(mp));
  await p.unroute('https://tile.openstreetmap.org/**');

  // Stitch Panorama: three overlapping pieces of a generated scene (the middle one dropped first), joined through the dialog
  // (automatic projection) and again as flat scans; the result matches the scene.
  const st = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const hash = (x, y, c) => { let h = (x * 374761393 + y * 668265263 + c * 2147483647) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
    const sm = (x, y, s, c) => { const gx = x / s, gy = y / s, x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy); return (hash(x0, y0, c) * (1 - u) + hash(x0 + 1, y0, c) * u) * (1 - v) + (hash(x0, y0 + 1, c) * (1 - u) + hash(x0 + 1, y0 + 1, c) * u) * v; };
    const tex = (x, y, c) => 255 * (0.45 * sm(x, y, 40, c) + 0.3 * sm(x, y, 13, c + 3) + 0.25 * sm(x, y, 5, c + 7));
    const H = 360;
    const piece = async (x0, w, name) => { const c = document.createElement('canvas'); c.width = w; c.height = H; const g = c.getContext('2d'), id = g.createImageData(w, H);
      for (let y = 0; y < H; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; id.data[i] = tex(x + x0 + 0.5, y + 0.5, 0); id.data[i + 1] = tex(x + x0 + 0.5, y + 0.5, 1); id.data[i + 2] = tex(x + x0 + 0.5, y + 0.5, 2); id.data[i + 3] = 255; }
      g.putImageData(id, 0, 0); return new File([await new Promise((r) => c.toBlob(r, 'image/png'))], name, { type: 'image/png' }); };
    qn.prefs.confirmClose = false;
    await qn.exec('file.openDropped', [await piece(400, 520, 'p2.png'), await piece(0, 520, 'p1.png'), await piece(800, 400, 'p3.png')]); await wait(500);
    const run = qn.exec('create.panoramaStitch');
    let dlg; for (let i = 0; i < 60 && !(dlg = [...document.querySelectorAll('.ql-dialog')].find((d) => d.getAttribute('aria-label') === 'Stitch Panorama')); i++) await wait(50);
    const fields = [...dlg.querySelectorAll('select')].map((x) => x.value);
    dlg.querySelector('.ql-primary').click();
    const r1 = await run; await wait(300);
    const name1 = qn.picture.name, size1 = [qn.picture.width, qn.picture.height];
    const px = (x, y) => [...qn.picture.frameCanvas().getContext('2d').getImageData(x, y, 1, 1).data].slice(0, 3);
    let diff = 0, n = 0; for (let y = 20; y < H - 20; y += 23) for (let x = 20; x < 1180; x += 23) { const a = px(x, y); for (let c = 0; c < 3; c++) { diff += Math.abs(a[c] - tex(x + 0.5, y + 0.5, c)); n++; } }
    // Back to the pieces for the flat run.
    await qn.exec('file.openDropped', [await piece(400, 520, 'p2.png'), await piece(0, 520, 'p1.png'), await piece(800, 400, 'p3.png')]); await wait(500);
    const r2 = await qn.exec('create.panoramaStitch', { projection: 'flat', crop: true });
    return { fields, r1, name1, size1, diff: diff / n, r2: { ...r2, focal: undefined } };
  });
  check('stitch panorama: pieces out of order joined through the dialog, matching the scene', [st.fields, st.r1.used, st.r1.skipped, st.r1.projection, st.name1, Math.abs(st.size1[0] - 1200) <= 2 && Math.abs(st.size1[1] - 360) <= 2, st.diff < 3], [['auto', 'smooth'], ['p1.png', 'p2.png', 'p3.png'], [], 'planar', 'p1-panorama.png', true, true], JSON.stringify(st));
  check('stitch panorama: flat scans', [st.r2.projection, st.r2.used.length, Math.abs(st.r2.width - 1200) <= 2, Math.abs(st.r2.height - 360) <= 2], ['flat', 3, true, true], JSON.stringify(st.r2));

  // Develop RAW: a DNG without an embedded preview is developed when opened (Orientation 6 applied); the dialog's
  // preview follows the settings, and developing for a warm light makes the picture bluer, as one Undo step.
  const dngBytes = { a: [...readFileSync('tests/fixtures/raw/synth-lj92.dng')], b: [...readFileSync('tests/fixtures/raw/synth.dng')] };
  const rw = await p.evaluate(async (bytes) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    qn.prefs.confirmClose = false;
    await qn.exec('file.openDropped', [new File([new Uint8Array(bytes.a)], 'tiles.dng'), new File([new Uint8Array(bytes.b)], 'plain.dng')]); await wait(800);
    const opened = [qn.picture.name, qn.picture.format.id, qn.picture.width, qn.picture.height, window.__qnGetCommand('raw.develop').isEnabled(qn)];
    await qn.exec('view.next'); await wait(500);
    const name2 = qn.picture.name, size2 = [qn.picture.width, qn.picture.height];
    const upright2 = [qn.picture.orientation, qn.picture.orientationApplied];
    const mean = () => { const d = qn.picture.frameCanvas().getContext('2d').getImageData(0, 0, qn.picture.width, qn.picture.height).data; const m = [0, 0, 0]; for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) m[c] += d[i + c]; return m.map((v) => v / (d.length / 4)); };
    const before = mean();
    const run = qn.exec('raw.develop');
    let dlg; for (let i = 0; i < 60 && !(dlg = [...document.querySelectorAll('.ql-dialog')].find((d) => d.getAttribute('aria-label') === 'Develop RAW')); i++) await wait(50);
    let img; for (let i = 0; i < 60 && !(img = dlg.querySelector('.ql-dialog-preview img')); i++) await wait(50);
    const firstPreview = img?.src || '', note1 = dlg.querySelector('.ql-dialog-preview .ql-help')?.textContent || '';
    const wb = dlg.querySelectorAll('select')[0]; wb.value = 'custom'; wb.dispatchEvent(new Event('change', { bubbles: true }));
    const temp = [...dlg.querySelectorAll('input[type=range]')].find((x) => +x.max === 12000); temp.value = '3200'; temp.dispatchEvent(new Event('input', { bubbles: true })); temp.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 60 && (dlg.querySelector('.ql-dialog-preview img')?.src || '') === firstPreview; i++) await wait(50);
    const note2 = dlg.querySelector('.ql-dialog-preview .ql-help')?.textContent || '';
    dlg.querySelector('.ql-primary').click();
    const res = await run; await wait(300);
    const after = mean();
    return { opened, name2, size2, upright2, note1, note2, res: { ...res, multipliers: undefined }, undo: qn.tab.undoLabel, bluer: (after[2] - after[0]) - (before[2] - before[0]) };
  }, dngBytes);
  check('develop RAW: DNGs without a preview develop on open; the tiled one turned upright and marked so', [rw.opened, rw.name2, rw.size2, rw.upright2], [['plain.dng', 'raw', 192, 128, true], 'tiles.dng', [128, 192], [6, true]], JSON.stringify(rw));
  check('develop RAW: the dialog previews the settings; a warm light makes it bluer, one Undo step', [/6[45]\d\d K/.test(rw.note1), /3[12]\d\d K/.test(rw.note2), rw.res.width, rw.res.height, rw.undo, rw.bluer > 20], [true, true, 128, 192, 'Develop RAW', true], JSON.stringify(rw));

  // RAW orientation: a portrait shot's embedded preview is stored as the sensor saw it and is turned upright by the RAW
  // header's Orientation; a developed picture is upright already and is marked so (Auto-Rotate does not turn it again).
  const ro = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const cv = document.createElement('canvas'); cv.width = 60; cv.height = 40; const x = cv.getContext('2d'); x.fillStyle = '#c00'; x.fillRect(0, 0, 30, 40); x.fillStyle = '#00c'; x.fillRect(30, 0, 30, 40);
    const jpg = new Uint8Array(await (await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.95))).arrayBuffer());
    const le16 = (v) => [v & 255, v >> 8], le32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
    const make = [...'NIKON CORPORATION\0'].map((c) => c.charCodeAt(0));
    const tags = [[256, 3, 1, 60], [257, 3, 1, 40], [271, 2, make.length, 0], [273, 4, 1, 0], [274, 3, 1, 6], [279, 4, 1, jpg.length]];
    const ifdAt = 8, makeAt = ifdAt + 2 + tags.length * 12 + 4, jpgAt = makeAt + make.length + (make.length & 1);
    const head = [0x49, 0x49, 42, 0, ...le32(ifdAt), ...le16(tags.length), ...tags.flatMap(([t, ty, n, v]) => [...le16(t), ...le16(ty), ...le32(n), ...(ty === 3 && n === 1 ? [...le16(v), 0, 0] : le32(t === 271 ? makeAt : t === 273 ? jpgAt : v))]), ...le32(0), ...make, ...(make.length & 1 ? [0] : [])];
    const file = new Uint8Array(head.length + jpg.length); file.set(head); file.set(jpg, head.length);
    await qn.exec('file.openDropped', [new File([file], 'portrait.nef')]);
    for (let i = 0; i < 60 && qn.picture?.name !== 'portrait.nef'; i++) await wait(50); await wait(200);
    const pic = qn.picture, d = pic.frameCanvas().getContext('2d').getImageData(0, 0, pic.width, pic.height).data;
    const at = (xx, yy) => [...d.subarray((yy * pic.width + xx) * 4, (yy * pic.width + xx) * 4 + 3)];
    const preview = { size: [pic.width, pic.height], applied: pic.orientationApplied, orientation: pic.orientation, top: at(20, 5)[0] > 150, bottom: at(20, 55)[2] > 150 };
    return { preview };
  });
  check('RAW orientation: a portrait preview is turned upright by the RAW header (red on top after a quarter turn clockwise)', ro.preview, { size: [40, 60], applied: true, orientation: 6, top: true, bottom: true }, JSON.stringify(ro));

  // Tools: a QR code opened as a picture through its dialog, an encrypted package round trip, carving pictures out of junk, and Document Cleanup through its dialog.
  const tl = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const T = await window.__qnTools();
    const windows = qn.tabs.length;
    const run = qn.exec('tools.makeQr'); for (let i = 0; i < 60 && !(document.querySelector('.ql-dialog .ql-primary') && document.querySelector('.ql-dialog-preview svg')); i++) await wait(50);
    const ta = document.querySelector('.ql-dialog textarea'); ta.value = 'https://example.org/lens'; ta.dispatchEvent(new Event('input', { bubbles: true })); await wait(150);
    document.querySelector('.ql-dialog .ql-primary').click(); await run; await wait(600);
    const qrName = qn.picture?.name, qrSize = qn.picture?.width, qrWindows = qn.tabs.length;
    const px = qn.viewer.pixelAt(0, 0); const corner = px ? px[0] : -1; const finder = qn.viewer.pixelAt(4 * 8 + 4, 4 * 8 + 4)[0];
    const pkg = await T.encryptPicture(qn.picture.bytes, 'qr.png', 'pass-word-1', 3000); const back = await T.decryptPicture(pkg, 'pass-word-1');
    let wrong = ''; try { await T.decryptPicture(pkg, 'nope'); } catch (e) { wrong = e.message; }
    const junk = new Uint8Array(50).fill(7); const all = new Uint8Array([...junk, ...qn.picture.bytes, ...junk]); const carved = T.carvePictures(all);
    const run2 = qn.exec('tools.docCleanup'); for (let i = 0; i < 80 && !(document.querySelector('.ql-dialog .ql-primary') && document.querySelector('.ql-dialog-preview img')); i++) await wait(50);
    document.querySelector('.ql-dialog .ql-primary').click(); await run2; await wait(300);
    return { qrName, qrSize, newWindow: qrWindows === windows + 1, corner, finder, back: back.name === 'qr.png' && back.bytes.length === qn.picture.bytes.length, wrong, carved: carved.map((c) => [c.format, c.offset, c.width]), label: qn.tab.undoLabel };
  });
  check('qr code opened as a picture', [tl.qrName, tl.newWindow, tl.corner, tl.finder], ['qr-code.png', true, 255, 0]);
  check('qr size is version 2 with a quiet zone', tl.qrSize, (25 + 8) * 8);
  check('encrypted package round trip', [tl.back, /Wrong password/.test(tl.wrong)], [true, true]);
  check('carved the png out of junk', tl.carved, [['png', 50, (25 + 8) * 8]]);
  check('document cleanup applied', tl.label, 'Document Cleanup');

  // Organize: the Filter Bar through its dialog narrows the thumbnails by name; Group By puts headers in the grid.
  const org = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const blob = (c) => new Promise((r) => c.toBlob(r, 'image/png'));
    const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').fillRect(0, 0, w, h); return c; };
    qn.prefs.confirmClose = false;
    await qn.exec('file.openDropped', [new File([await blob(mk(30, 20))], 'wide-1.png'), new File([await blob(mk(20, 30))], 'tall-2.png'), new File([await blob(mk(30, 20))], 'wide-3.png')]); await wait(600);
    const run = qn.exec('browse.filter'); for (let i = 0; i < 80 && !document.querySelector('.ql-dialog .ql-primary'); i++) await wait(50);
    const inputs = [...document.querySelectorAll('.ql-dialog input[type=text]')]; const textField = inputs.find((i) => i.id.startsWith('f_text_')); textField.value = 'wide'; textField.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.ql-dialog .ql-primary').click(); await run; await wait(300);
    const shown = qn.tab.el.querySelectorAll('.qn-thumb').length, active = !!qn.tab.thumbs.filter;
    await qn.exec('browse.groupBy', 'type'); await wait(200);
    const headers = [...qn.tab.el.querySelectorAll('.qn-thumb-group')].map((x) => x.textContent);
    await qn.exec('browse.groupBy', 'none'); const run2 = qn.exec('browse.filter'); for (let i = 0; i < 80 && !document.querySelector('.ql-dialog .ql-btn'); i++) await wait(50);
    [...document.querySelectorAll('.ql-dialog .ql-btn')].find((b) => b.textContent === 'Clear filter').click(); await run2; await wait(200);
    return { shown, active, headers, after: qn.tab.el.querySelectorAll('.qn-thumb').length, cleared: !qn.tab.thumbs.filter };
  });
  check('filter bar narrows the thumbnails', [org.shown, org.active, org.headers, org.after, org.cleared], [2, true, ['PNG'], 3, true]);

  // Create, part two: a calendar page through its dialog, pictures pulled out of a ZIP document, and the fusion engines through the hooks.
  const cr = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const M = await window.__qnMerge(), B = await window.__qnBatch();
    const windows = qn.tabs.length;
    const run = qn.exec('create.calendar'); for (let i = 0; i < 60 && !document.querySelector('.ql-dialog .ql-primary'); i++) await wait(50);
    document.querySelector('.ql-dialog .ql-primary').click(); await run; await wait(800);
    const cal = { name: qn.picture?.name, w: qn.picture?.width, h: qn.picture?.height, newWindow: qn.tabs.length === windows + 1 };
    const zip = B.writeZip([{ name: 'word/document.xml', data: new TextEncoder().encode('<w/>') }, { name: 'word/media/image1.png', data: qn.tab.folder.entries[0] ? new Uint8Array(await qn.tab.folder.entries[0].read()) : new Uint8Array(0) }]);
    const inZip = M.picturesInZip(zip).map((p) => p.name);
    const mk = (v) => ({ width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4).map((_, i) => (i % 4 === 3 ? 255 : v)) });
    const fused = M.exposureFusion([mk(20), mk(230)], { levels: 2 }); const mid = fused.data[0];
    return { cal, inZip, mid, stack: M.focusStack([mk(50), mk(60)], 2).raster.width };
  });
  check('calendar page opened', [/^calendar-\d{4}-\d{2}\.png$/.test(cr.cal.name), cr.cal.w, cr.cal.h, cr.cal.newWindow], [true, 2480, 3508, true]);
  check('pictures found inside a docx-style zip', cr.inZip, ['image1.png']);
  check('fusion and stacking engines run', [cr.mid > 20 && cr.mid < 230, cr.stack], [true, 16]);

  // Selections with masks: Select All → Ellipse Selection turns the rectangle into an ellipse; Negative then changes the center but not the corner; Invert flips it; Magic Wand through its dialog selects one color region.
  const sm = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const blob = (c) => new Promise((r) => c.toBlob(r, 'image/png'));
    const c = document.createElement('canvas'); c.width = 40; c.height = 40; const x = c.getContext('2d'); x.fillStyle = '#ffffff'; x.fillRect(0, 0, 40, 40); x.fillStyle = '#0000ff'; x.fillRect(0, 0, 20, 40);
    qn.prefs.confirmClose = false;
    await qn.exec('file.openDropped', [new File([await blob(c)], 'mask.png')]); await wait(600);
    await qn.exec('edit.selectAll'); await qn.exec('edit.selectEllipse'); await wait(100);
    const hasMask = !!qn.tab.selectionMask, count = qn.tab.selectionMask ? [...qn.tab.selectionMask].filter((v) => v).length : 0;
    await qn.exec('image.negative'); await wait(200);
    const center = [...qn.viewer.pixelAt(30, 20)].slice(0, 3), inside = [...qn.viewer.pixelAt(10, 20)].slice(0, 3), corner = [...qn.viewer.pixelAt(0, 0)].slice(0, 3);
    await qn.exec('edit.selectInvert'); await wait(100);
    const inv = [...qn.tab.selectionMask].filter((v) => v).length;
    await qn.exec('edit.selectNone');
    const run = qn.exec('edit.selectWand'); for (let i = 0; i < 60 && !document.querySelector('.ql-dialog .ql-primary'); i++) await wait(50);
    document.querySelector('.ql-dialog .ql-primary').click(); await run; await wait(100);
    const wand = qn.tab.selectionMask ? [...qn.tab.selectionMask].filter((v) => v).length : 0, wandRect = qn.tab.selection;
    return { hasMask, count, center, inside, corner, inv, wand, wandRect };
  });
  check('ellipse mask limits the edit', [sm.hasMask, sm.count > 1100 && sm.count < 1300, sm.center, sm.inside, sm.corner], [true, true, [0, 0, 0], [255, 255, 0], [0, 0, 255]]);
  // The wand floods the black (negated) part of the right half: the ellipse's share of it, not the still-white corners.
  check('invert and magic wand', [sm.inv, sm.wand > 500 && sm.wand < 800, sm.wandRect && sm.wandRect.w], [1600 - sm.count, true, 20]);

  // Content-Aware Resize through its dialog narrows the picture by seams; Alpha from Mask makes the unselected area transparent.
  const sc = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await qn.exec('edit.selectNone');
    for (let i = 0; i < 40 && document.querySelector('.ql-dialog'); i++) await wait(50); // the previous dialog fades out
    const w0 = qn.picture.width;
    const run = qn.exec('image.seamCarve'); for (let i = 0; i < 60 && !document.querySelector('.ql-dialog input[id^="f_w_"]'); i++) await wait(50);
    const dlg = [...document.querySelectorAll('.ql-dialog')].pop(); const wf = dlg.querySelector('input[id^="f_w_"]'); wf.value = String(w0 - 10); wf.dispatchEvent(new Event('input', { bubbles: true }));
    dlg.querySelector('.ql-primary').click(); await run; await wait(500);
    const w1 = qn.picture.width, label = qn.tab.undoLabel;
    await qn.exec('edit.selectAll'); await qn.exec('edit.selectEllipse'); await wait(50);
    for (let i = 0; i < 40 && document.querySelector('.ql-dialog'); i++) await wait(50);
    const run2 = qn.exec('image.alphaFromMask'); for (let i = 0; i < 60 && !document.querySelector('.ql-dialog .ql-primary'); i++) await wait(50);
    document.querySelector('.ql-dialog .ql-primary').click(); await run2; await wait(300);
    const fc = qn.picture.frameCanvas(); const x = fc.getContext('2d'); const cornerA = x.getImageData(0, 0, 1, 1).data[3], centerA = x.getImageData(Math.floor(fc.width / 2), Math.floor(fc.height / 2), 1, 1).data[3];
    return { w0, w1, label, cornerA, centerA, hasAlpha: qn.picture.current.hasAlpha };
  });
  check('seam carving narrowed the picture', [sc.w1, sc.label], [sc.w0 - 10, 'Content-Aware Resize']);
  check('alpha from the ellipse mask', [sc.cornerA, sc.centerA, sc.hasAlpha], [0, 255, true]);

  // Command palette finds commands; QAT add all is idempotent.
  check('search', await p.evaluate(() => window.__qnGetCommand('view.next').label), 'Next Picture');
  await p.evaluate(() => qn.exec('view.qatAddAll'));
  const qat1 = await p.evaluate(() => qn.prefs.qat.length);
  await p.evaluate(() => qn.exec('view.qatAddAll'));
  check('qat add all idempotent', await p.evaluate(() => qn.prefs.qat.length), qat1);

  // Trace to Vector, Magnifier Callout, Search by Color, Export as PDF, New Folder.
  const vec = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const top = () => [...document.querySelectorAll('.ql-dialog')].pop();
    const title = (d) => d?.querySelector('h2')?.textContent || '';
    const waitFor = async (pred, ms = 6000) => { for (let i = 0; i < ms / 50; i++) { const d = top(); if (d && pred(d)) return d; await wait(50); } throw new Error('dialog not found; top is ' + title(top())); };
    const noDialog = async () => { for (let i = 0; i < 80 && document.querySelector('.ql-dialog'); i++) await wait(50); };
    const field = (d, key) => d.querySelector(`[id^="f_${key}_"]`);
    const set = (d, key, value) => { const f = field(d, key); if (f.type === 'checkbox') f.checked = !!value; else f.value = String(value); f.dispatchEvent(new Event('input', { bubbles: true })); f.dispatchEvent(new Event('change', { bubbles: true })); };
    const pixel = (x, y) => [...qn.picture.frameCanvas().getContext('2d').getImageData(x, y, 1, 1).data];
    const N = await window.__qnNative();
    await noDialog();
    const mk = (w, h, draw) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); draw(x); return new Promise((r) => c.toBlob(r, 'image/png')); };
    const files = [
      new File([await mk(120, 80, (x) => { x.fillStyle = '#fff'; x.fillRect(0, 0, 120, 80); x.fillStyle = '#000'; x.fillRect(20, 20, 40, 40); x.lineWidth = 6; x.strokeStyle = '#000'; x.beginPath(); x.arc(92, 40, 20, 0, Math.PI * 2); x.stroke(); })], 'v-logo.png', { type: 'image/png' }),
      new File([await mk(40, 40, (x) => { x.fillStyle = '#f00'; x.fillRect(0, 0, 40, 40); })], 'w-red.png', { type: 'image/png' }),
      new File([await mk(40, 40, (x) => { x.fillStyle = '#00f'; x.fillRect(0, 0, 40, 40); })], 'x-blue.png', { type: 'image/png' }),
    ];
    qn.prefs.confirmClose = false;
    await qn.exec('file.openDropped', files); await wait(600);
    const home = qn.tab; const back = async () => { if (qn.tab !== home) qn.closeTab(qn.tab); qn.activate(home); await wait(300); };
    const out = { first: qn.picture.name };
    // Trace to Vector: open the SVG as a picture and look at it.
    let run = qn.exec('tools.vectorize'); let d = await waitFor((x) => title(x).startsWith('Trace to Vector'));
    await wait(300); out.preview = /<svg/.test(d.querySelector('.ql-dialog-preview')?.innerHTML || '');
    d.querySelector('.ql-primary').click(); await run; await noDialog(); await wait(600);
    out.svg = { name: qn.picture.name, fmt: qn.picture.format.id, size: [qn.picture.width, qn.picture.height], square: pixel(40, 40)[3] > 200 && pixel(40, 40)[0] < 60, background: pixel(100, 8)[3], ringHole: pixel(92, 40)[3], ring: pixel(92, 21)[3] > 200 };
    await back();
    // Magnifier Callout over part of the black square: the inset lands bottom right.
    qn.tab.setSelection({ x: 20, y: 20, w: 20, h: 20 });
    const before = pixel(110, 72);
    run = qn.exec('edit.callout'); d = await waitFor((x) => title(x) === 'Magnifier Callout');
    set(d, 'shadow', false); d.querySelector('.ql-primary').click(); await run; await noDialog(); await wait(300);
    out.callout = { before: before.slice(0, 3), after: pixel(110, 72).slice(0, 3), label: qn.tab.undoLabel, size: [qn.picture.width, qn.picture.height], selection: qn.tab.selection };
    await qn.exec('edit.undo'); await wait(200);
    // Search by Color: only the red picture.
    run = qn.exec('browse.searchColor'); d = await waitFor((x) => title(x) === 'Search by Color');
    set(d, 'color', '#ff0000'); d.querySelector('.ql-primary').click();
    d = await waitFor((x) => title(x) === 'Color #ff0000'); out.color = { hits: [...d.querySelectorAll('.qn-ai-card')].map((c) => c.textContent), label: qn.tab.thumbs ? qn.tab.thumbs.filterLabel : '' };
    d.querySelector('.ql-primary').click(); await run; await noDialog();
    if (qn.tab.thumbs) { qn.tab.thumbs.filter = null; qn.tab.thumbs.filterLabel = ''; qn.tab.thumbs.refilter(); }
    // Export as PDF of the folder, captured through a stubbed save picker.
    const saved = { parts: [], name: '' };
    const picker = window.showSaveFilePicker;
    window.showSaveFilePicker = async (o) => { saved.name = o?.suggestedName || ''; return { name: saved.name, createWritable: async () => ({ write: async (b) => { saved.parts.push(b); }, close: async () => {} }) }; };
    run = qn.exec('file.export.pdf'); d = await waitFor((x) => title(x) === 'Export as PDF');
    set(d, 'which', 'folder'); set(d, 'captions', true); d.querySelector('.ql-primary').click(); await run; await noDialog();
    window.showSaveFilePicker = picker;
    const blob = new Blob(saved.parts); const u8 = new Uint8Array(await blob.arrayBuffer());
    let bin = ''; for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    out.pdf = { name: saved.name, b64: btoa(bin), head: String.fromCharCode(...u8.subarray(0, 5)) };
    // New Folder in a (fake) picked directory.
    const made = [];
    const dir = { kind: 'directory', name: 'root', isSameEntry: async () => false, getDirectoryHandle: async (name, o) => { made.push([name, !!o?.create]); return { kind: 'directory', name, isSameEntry: async () => false }; } };
    qn.folder.uri = 'fsadir:' + (await N.handleId(dir));
    out.newFolderEnabled = window.__qnGetCommand('browse.newFolder').isEnabled(qn);
    run = qn.exec('browse.newFolder'); d = await waitFor((x) => title(x) === 'New Folder');
    set(d, 'v', 'Scans 1926'); d.querySelector('.ql-primary').click(); await run; await noDialog();
    out.made = made;
    return out;
  });
  check('vector: opened as an SVG picture with the shapes and the hole', [vec.svg.fmt, vec.svg.size, vec.svg.square, vec.svg.background, vec.svg.ringHole, vec.svg.ring, vec.preview, /\.svg$/.test(vec.svg.name)], ['svg', [120, 80], true, 0, 0, true, true, true]);
  check('magnifier callout inset in the free corner', [vec.callout.before, vec.callout.after, vec.callout.label, vec.callout.size, vec.callout.selection], [[255, 255, 255], [0, 0, 0], 'Magnifier Callout', [120, 80], null]);
  check('search by color finds only the red picture', [vec.color.hits.length, /^w-red\.png — 100%/.test(vec.color.hits[0] || ''), vec.color.label], [1, true, 'Color #ff0000']);
  check('new folder created in the picked directory', [vec.newFolderEnabled, vec.made], [true, [['Scans 1926', true]]]);
  check('export as PDF captured', [vec.pdf.head, /\.pdf$/.test(vec.pdf.name)], ['%PDF-', true]);
  {
    const { execFileSync } = await import('node:child_process');
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const file = `${mkdtempSync(`${tmpdir()}/qn-pdf-`)}/export.pdf`;
    writeFileSync(file, Buffer.from(vec.pdf.b64, 'base64'));
    let info = '';
    try { info = execFileSync('pdfinfo', ['-f', '1', '-l', '3', file], { encoding: 'utf8' }); } catch { info = ''; }
    if (info) {
      const pages = +(info.match(/^Pages:\s+(\d+)/m) || [])[1];
      const sizes = [...info.matchAll(/^Page\s+\d+ size:\s+([\d.]+) x ([\d.]+)/gm)].map((m) => (+m[1] > +m[2] ? 'landscape' : 'portrait'));
      check('PDF has a page per picture, oriented by each picture', [pages, sizes], [3, ['landscape', 'portrait', 'portrait']]);
    }
  }

  // View tools, part two: Info Pane, Navigator and Measure with real mouse input, Filmstrip,
  // Reset All Adjustments, and Keep the Original / Revert to Original through a save.
  const vt0 = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 80 && document.querySelector('.ql-dialog'); i++) await wait(50);
    const mk = (w, h, draw) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); draw(x); return new Promise((r) => c.toBlob(r, 'image/png')); };
    const big = await mk(1600, 1000, (x) => { x.fillStyle = '#204080'; x.fillRect(0, 0, 800, 1000); x.fillStyle = '#e0c020'; x.fillRect(800, 0, 800, 1000); x.fillStyle = '#fff'; x.fillRect(100, 100, 300, 300); });
    qn.prefs.confirmClose = false;
    await qn.exec('file.openDropped', [new File([big], 'nav-big.png', { type: 'image/png' }), new File([await mk(60, 40, (x) => { x.fillStyle = '#888'; x.fillRect(0, 0, 60, 40); })], 'nav-small.png', { type: 'image/png' })]);
    for (let i = 0; i < 60 && qn.picture?.name !== 'nav-big.png'; i++) await wait(50);
    await wait(300);
    const out = { name: qn.picture.name };
    // Info Pane.
    await qn.exec('view.infoPane'); await wait(200);
    const pane = qn.viewer.el.querySelector('.qn-infopane');
    const hc = pane?.querySelector('canvas'); let histInk = 0;
    if (hc) { const d = hc.getContext('2d').getImageData(0, 0, hc.width, hc.height).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) histInk++; }
    out.info = { inViewer: !!pane, text: pane ? pane.textContent : '', histInk, active: window.__qnGetCommand('view.infoPane').isActive(qn) };
    await qn.exec('view.infoPane'); await wait(100);
    out.infoClosed = !qn.viewer.el.querySelector('.qn-infopane');
    // Navigator at 2x.
    await qn.exec('view.navigator');
    qn.viewer.setZoom(2); qn.viewer.panTo(400, 250); await wait(150);
    const vb = qn.viewer.el.getBoundingClientRect(); const nav = qn.viewer.navigatorBox();
    out.nav = { box: nav, view: { left: vb.left, top: vb.top, w: vb.width, h: vb.height }, start: qn.viewer.viewCenter };
    return out;
  });
  check('info pane shows the facts and a histogram, then closes', [vt0.name, vt0.info.inViewer, /nav-big\.png/.test(vt0.info.text), /1600 × 1000/.test(vt0.info.text), vt0.info.histInk > 500, vt0.info.active, vt0.infoClosed], ['nav-big.png', true, true, true, true, true, true]);
  check('navigator shown when zoomed in', !!vt0.nav.box, true);
  if (vt0.nav.box) {
    const n = vt0.nav.box, L = vt0.nav.view.left, T = vt0.nav.view.top;
    // A click in the navigator's lower right centers the view there (clamped to the picture's edge).
    await p.mouse.click(L + n.x + n.w * 0.85, T + n.y + n.h * 0.85);
    const afterClick = await p.evaluate(() => ({ c: qn.viewer.viewCenter, sel: qn.tab.selection }));
    // A drag inside it follows the pointer back toward the upper left.
    await p.mouse.move(L + n.x + n.w * 0.8, T + n.y + n.h * 0.8); await p.mouse.down();
    await p.mouse.move(L + n.x + n.w * 0.5, T + n.y + n.h * 0.4, { steps: 6 }); await p.mouse.move(L + n.x + n.w * 0.3, T + n.y + n.h * 0.3, { steps: 6 }); await p.mouse.up();
    const afterDrag = await p.evaluate(() => qn.viewer.viewCenter);
    check('navigator click pans to the lower right', [afterClick.c.x > 1150, afterClick.c.y > 700, afterClick.sel], [true, true, null]);
    check('navigator drag follows the pointer', [Math.abs(afterDrag.x - 0.3 * 1600) < 30, Math.abs(afterDrag.y - 0.3 * 1000) < 30], [true, true]);
  }
  // Measure: two clicks give the distance and angle; Set Scale from that line; then a closed shape.
  const mv = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await qn.exec('view.navigator'); qn.viewer.setZoom('fit'); await wait(150);
    await qn.exec('view.measure', 'toggle'); await wait(50);
    const r = qn.viewer.pictureRect(), z = qn.viewer.zoom, b = qn.viewer.el.getBoundingClientRect();
    const at = (x, y) => [b.left + r.x + x * z, b.top + r.y + y * z];
    return { a: at(100, 100), b: at(400, 500), c: at(700, 100), d: at(700, 500), z };
  });
  await p.mouse.click(...mv.a); await p.mouse.click(...mv.b);
  const m1 = await p.evaluate(async () => { const V = await window.__qnView2(); const m = V.viewState.measure; return { n: m.pts.length, len: V.dist(m.pts[0], m.pts[1]), lines: V.readout(m.pts, m.closed, m.scale) }; });
  check('measure: distance and angle from two clicks', [m1.n, Math.abs(m1.len - 500) < 5, /^Distance /.test(m1.lines[0]), /^Angle -5[23]\.\d+°$/.test(m1.lines[1])], [2, true, true, true]);
  const msc = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const top = () => [...document.querySelectorAll('.ql-dialog')].pop();
    const run = qn.exec('view.measure', 'scale'); let d; for (let i = 0; i < 80 && !(d = top())?.querySelector('[id^="f_known_"]'); i++) await wait(50);
    const k = d.querySelector('[id^="f_known_"]'); k.value = '50'; k.dispatchEvent(new Event('input', { bubbles: true }));
    const u = d.querySelector('[id^="f_unit_"]'); u.value = 'cm'; u.dispatchEvent(new Event('input', { bubbles: true }));
    d.querySelector('.ql-primary').click(); await run; for (let i = 0; i < 80 && document.querySelector('.ql-dialog'); i++) await wait(50);
    const V = await window.__qnView2(); const m = V.viewState.measure;
    const lines = V.readout(m.pts, m.closed, m.scale);
    await qn.exec('view.measure', 'clear');
    return { unit: m.scale?.unit, line: lines[0] };
  });
  check('measure: scale set from the measured line', [msc.unit, /^Distance 50 cm \(/.test(msc.line)], ['cm', true]);
  await p.mouse.click(...mv.a); await p.mouse.click(...mv.c); await p.mouse.dblclick(...mv.d);
  const m2 = await p.evaluate(async () => {
    const V = await window.__qnView2(); const m = V.viewState.measure;
    const out = { n: m.pts.length, closed: m.closed, areaPx: V.polygonArea(m.pts), lines: V.readout(m.pts, m.closed, m.scale) };
    await qn.exec('view.measure', 'toggle');
    out.offPts = V.viewState.measure.pts.length; out.on = V.viewState.measure.on;
    return out;
  });
  // Triangle (100,100) (700,100) (700,500): 0.5 × 600 × 400 = 120000 px².
  check('measure: a closed shape gives its area in the scale\'s unit', [m2.n, m2.closed, Math.abs(m2.areaPx - 120000) / 120000 < 0.03, /^Perimeter .* cm /.test(m2.lines[0]), /^Area .* cm² /.test(m2.lines[1]), m2.on, m2.offPts], [3, true, true, true, true, false, 0]);
  const vt1 = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const pixel = (x, y) => [...qn.picture.frameCanvas().getContext('2d').getImageData(x, y, 1, 1).data].slice(0, 3);
    const N = await window.__qnNative();
    const out = {};
    // Filmstrip.
    await qn.exec('view.filmstrip'); await wait(100);
    out.strip = [qn.tab.thumbs.open, qn.tab.thumbs.mode];
    await qn.exec('view.filmstrip'); await wait(100);
    out.stripOff = qn.tab.thumbs.open;
    // Reset All Adjustments.
    out.resetDisabled = !window.__qnGetCommand('adjust.resetAll').isEnabled(qn);
    const p0 = pixel(200, 200);
    await qn.exec('image.negative', 'all'); await wait(150);
    const p1 = pixel(200, 200);
    await qn.exec('adjust.resetAll'); await wait(250);
    out.reset = { p0, p1, p2: pixel(200, 200), label: qn.tab.undoLabel };
    qn.tab.undo(); await wait(150); out.reset.undone = pixel(200, 200);
    qn.tab.undo(); await wait(150);
    // Keep the original on save, then Revert to Original.
    const files = new Map(); const fileHandle = (name, bytes) => ({ kind: 'file', name, isSameEntry: async (o) => o === undefined, getFile: async () => new File([bytes.value], name, { type: 'image/png' }), createWritable: async () => { const parts = []; return { write: async (b) => { parts.push(b); }, close: async () => { bytes.value = new Uint8Array(await new Blob(parts).arrayBuffer()); } }; } });
    const origBytes = qn.picture.bytes.slice();
    const self = { value: origBytes };
    const fh = fileHandle('nav-big.png', self);
    const dir = { kind: 'directory', name: 'scans', isSameEntry: async () => false, getFileHandle: async (name, o) => { if (!files.has(name)) { if (!o?.create) throw new DOMException('missing', 'NotFoundError'); files.set(name, { value: new Uint8Array() }); } return fileHandle(name, files.get(name)); } };
    qn.picture.entry.uri = 'fsa:' + (await N.handleId(fh));
    qn.folder.uri = 'fsadir:' + (await N.handleId(dir));
    qn.prefs.keepOriginal = true;
    await qn.exec('image.negative', 'all'); await wait(150);
    await qn.exec('file.save'); await wait(600);
    out.kept = { names: [...files.keys()], sameAsOriginal: files.has('nav-big (original).png') && files.get('nav-big (original).png').value.length === origBytes.length && files.get('nav-big (original).png').value.every((v, i) => v === origBytes[i]), savedChanged: self.value.length > 0 && !(self.value.length === origBytes.length && self.value.every((v, i) => v === origBytes[i])), inFolder: qn.folder.entries.some((e) => e.name === 'nav-big (original).png'), afterSave: pixel(200, 200) };
    // A second save keeps the first original.
    await qn.exec('image.negative', 'all'); await wait(150); await qn.exec('file.save'); await wait(600);
    out.kept.count = [...files.keys()].filter((n) => /original/.test(n)).length;
    await qn.exec('image.negative', 'all'); await wait(150);
    await qn.exec('adjust.revertOriginal'); await wait(600);
    out.revert = { pixel: pixel(200, 200), label: qn.tab.undoLabel, dirty: qn.tab.dirty };
    qn.prefs.keepOriginal = false;
    for (let i = 0; i < 80 && document.querySelector('.ql-dialog'); i++) await wait(50);
    return out;
  });
  check('filmstrip toggles the thumbnail strip', [vt1.strip, vt1.stripOff], [[true, 'strip'], false]);
  check('reset all adjustments returns to the opened pixels as one undoable step', [vt1.resetDisabled, vt1.reset.p1.join() !== vt1.reset.p0.join(), vt1.reset.p2, vt1.reset.label, vt1.reset.undone], [true, true, vt1.reset.p0, 'Reset All Adjustments', vt1.reset.p1]);
  check('keep the original on the first save over a file', [vt1.kept.names.includes('nav-big (original).png'), vt1.kept.sameAsOriginal, vt1.kept.savedChanged, vt1.kept.inFolder, vt1.kept.count], [true, true, true, true, 1]);
  check('revert to original restores the kept pixels', [vt1.revert.pixel, vt1.revert.label, vt1.revert.dirty], [[255, 255, 255], 'Revert to Original', true]);

  // Recognize Text (OCR) on rendered text, Find on the picture, Read QR Code from the app's own QR encoder.
  const external = []; const onReq = (r) => { const u = r.url(); if (!/^(http:\/\/localhost|blob:|data:)/.test(u)) external.push(u); };
  p.on('request', onReq);
  const ocr = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const top = () => [...document.querySelectorAll('.ql-dialog')].pop();
    const title = (d) => d?.querySelector('h2')?.textContent || '';
    const waitFor = async (pred, ms = 60000) => { for (let i = 0; i < ms / 100; i++) { const d = top(); if (d && pred(d)) return d; await wait(100); } throw new Error('dialog not found; top is ' + title(top())); };
    const noDialog = async () => { for (let i = 0; i < 80 && document.querySelector('.ql-dialog'); i++) await wait(50); };
    const field = (d, key) => d.querySelector(`[id^="f_${key}_"]`);
    await noDialog();
    const O = await window.__qnOcr(), T = await window.__qnTools();
    const c = document.createElement('canvas'); c.width = 900; c.height = 260; const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, 900, 260); x.fillStyle = '#111'; x.font = 'bold 64px sans-serif'; x.fillText("ANNE'S LENS 1926", 40, 100); x.font = '44px serif'; x.fillText('Family records of Bath', 40, 190);
    const qr = T.qrRaster(T.encodeQr('https://example.org/annes-lens', 'M'), 8, 4);
    const q = document.createElement('canvas'); q.width = qr.width; q.height = qr.height; q.getContext('2d').putImageData(new ImageData(qr.data, qr.width, qr.height), 0, 0);
    const blob = (cv) => new Promise((r) => cv.toBlob(r, 'image/png'));
    qn.prefs.confirmClose = false;
    await qn.exec('file.openDropped', [new File([await blob(c)], 'o-text.png', { type: 'image/png' }), new File([await blob(q)], 'p-qr.png', { type: 'image/png' })]);
    for (let i = 0; i < 60 && qn.picture?.name !== 'o-text.png'; i++) await wait(50);
    await wait(200);
    const out = {};
    let run = qn.exec('tools.ocr'); let d = await waitFor((x) => title(x) === 'Recognize Text (OCR)');
    d.querySelector('.ql-primary').click();
    d = await waitFor((x) => title(x) === 'Recognized Text');
    out.text = field(d, 'text').value; out.help = d.textContent.match(/(\d+) words? in (\d+) lines?, (\d+)% confidence/)?.slice(1).map(Number);
    out.boxes = O.viewState.ocr.words.length; out.shown = O.viewState.ocr.show;
    const qf = field(d, 'q'); qf.value = '1926'; qf.dispatchEvent(new Event('input', { bubbles: true })); qf.dispatchEvent(new Event('change', { bubbles: true })); await wait(100);
    out.matches = O.viewState.ocr.words.filter((w) => O.ocrMatch(w.text, O.viewState.ocr.query)).map((w) => w.text);
    out.matchBox = O.viewState.ocr.words.find((w) => w.text === '1926')?.bbox;
    out.count = d.querySelector('.qn-ocr-count')?.textContent;
    d.querySelector('.ql-primary').click(); await run; await noDialog();
    out.clearedAfter = O.viewState.ocr.words.length;
    // Read Code on the QR picture.
    await qn.exec('view.next'); for (let i = 0; i < 60 && qn.picture?.name !== 'p-qr.png'; i++) await wait(50); await wait(200);
    run = qn.exec('tools.readCode'); d = await waitFor((x) => /^Codes? Found$/.test(title(x)));
    out.code = { text: d.textContent, outlines: O.viewState.codes.length, corner: O.viewState.codes[0]?.corners[0], hasOpen: [...d.querySelectorAll('button')].some((b) => /Open link/.test(b.textContent)) };
    d.querySelector('.ql-primary').click(); await run; await noDialog();
    out.codesAfter = O.viewState.codes.length;
    return out;
  });
  p.off('request', onReq);
  check('OCR recognized the rendered text', [/ANNE'S LENS 1926/.test(ocr.text), /Family records of Bath/.test(ocr.text), (ocr.help || [])[0] >= 6, (ocr.help || [])[2] >= 80, ocr.boxes >= 6, ocr.shown], [true, true, true, true, true, true]);
  check('OCR find highlights the word where it is', [ocr.matches, ocr.count, ocr.matchBox && ocr.matchBox.x0 > 400 && ocr.matchBox.x1 < 900 && ocr.matchBox.y0 > 40 && ocr.matchBox.y1 < 110, ocr.clearedAfter], [['1926'], '1 match', true, 0]);
  check('QR code read with its outline', [/QRCode/.test(ocr.code.text), /https:\/\/example\.org\/annes-lens/.test(ocr.code.text), ocr.code.outlines, ocr.code.corner, ocr.code.hasOpen, ocr.codesAfter], [true, true, 1, [32, 32], true, 0]);
  check('OCR and code reading made no requests off the machine', external, []);

  // Paint pane and Markup Board with real mouse input.
  const pz = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 80 && document.querySelector('.ql-dialog'); i++) await wait(50);
    const c = document.createElement('canvas'); c.width = 400; c.height = 300; const x = c.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, 200, 300); x.fillStyle = '#2050c0'; x.fillRect(200, 0, 200, 300);
    x.fillStyle = '#e02020'; x.beginPath(); x.arc(300, 150, 20, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#505050'; x.fillRect(60, 60, 40, 40);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    qn.prefs.confirmClose = false;
    await qn.exec('file.openDropped', [new File([blob], 'q-paint.png', { type: 'image/png' })]);
    for (let i = 0; i < 60 && qn.picture?.name !== 'q-paint.png'; i++) await wait(50);
    qn.viewer.setZoom(1); qn.viewer.center(); await wait(200);
    const r = qn.viewer.pictureRect(), b = qn.viewer.el.getBoundingClientRect();
    return { ox: b.left + r.x, oy: b.top + r.y, z: qn.viewer.zoom, folder: qn.folder.length };
  });
  const at = (x, y) => [pz.ox + (x + 0.5) * pz.z, pz.oy + (y + 0.5) * pz.z];
  const px = (x, y) => p.evaluate(([x, y]) => [...qn.picture.frameCanvas().getContext('2d').getImageData(x, y, 1, 1).data], [x, y]);
  const setPaint = (o) => p.evaluate(async (o) => { const P = await window.__qnPaint(); Object.assign(P.paint, o); P.paint.onChange(); }, o);
  const drag = async (a, b, steps = 12) => { await p.mouse.move(...at(...a)); await p.mouse.down(); await p.mouse.move(...at(...b), { steps }); await p.mouse.up(); await p.waitForTimeout(120); };
  const click = async (x, y) => { await p.mouse.click(...at(x, y)); await p.waitForTimeout(120); };
  const label = () => p.evaluate(() => qn.tab.undoLabel);
  // Brush.
  await p.evaluate(() => qn.exec('paint.brush'));
  await setPaint({ color: '#000000', size: 10, opacity: 100, hardness: 100 });
  await drag([20, 200], [180, 200]);
  const brush = { on: await px(100, 200), off: await px(100, 185), label: await label(), paneOpen: await p.evaluate(() => !!qn.viewer.el.querySelector('.qn-paintbar')) };
  await p.evaluate(() => qn.tab.undo()); await p.waitForTimeout(100);
  brush.undone = await px(100, 200);
  check('brush stroke painted, one undoable step', [brush.paneOpen, brush.on[0] < 30, brush.off, brush.label, brush.undone], [true, true, [255, 255, 255, 255], 'Brush', [255, 255, 255, 255]]);
  // Flood fill the white half.
  await p.evaluate(() => qn.exec('paint.fill')); await setPaint({ color: '#00ff00', tolerance: 16, contiguous: true });
  await click(30, 30);
  const fill = { inside: await px(30, 30), blue: await px(350, 30), gray: await px(80, 80), label: await label() };
  await p.evaluate(() => qn.tab.undo()); await p.waitForTimeout(100);
  check('flood fill stays in the clicked area', [fill.inside, fill.blue, fill.gray, fill.label], [[0, 255, 0, 255], [32, 80, 192, 255], [80, 80, 80, 255], 'Flood Fill']);
  // Color picker.
  await p.evaluate(() => qn.exec('paint.colorPicker')); await click(350, 30);
  const picked = await p.evaluate(async () => (await window.__qnPaint()).paint.color);
  check('color picker took the blue', picked, '#2050c0');
  // Red-eye brush across the red disc.
  await p.evaluate(() => qn.exec('paint.redEye')); await setPaint({ size: 60, hardness: 100 });
  await drag([300, 150], [302, 151], 3);
  const eye = await px(300, 150);
  check('red-eye neutralized the red', [eye[0] < 60, eye[1], eye[2], await label()], [true, 32, 32, 'Red-Eye Brush']);
  // Clone: Alt+click the gray square, then paint on the white area.
  await p.evaluate(() => qn.exec('paint.clone')); await setPaint({ size: 16, hardness: 100, opacity: 100, cloneSource: null, cloneOffset: null });
  await p.keyboard.down('Alt'); await click(80, 80); await p.keyboard.up('Alt');
  await drag([30, 250], [40, 250], 4);
  const cloned = await px(35, 250);
  check('clone copied the gray square', [cloned, await label()], [[80, 80, 80, 255], 'Clone Stamp']);
  // Rectangle outline.
  await p.evaluate(() => qn.exec('paint.rect')); await setPaint({ color: '#000000', size: 4, opacity: 100, fillShapes: false });
  await drag([140, 20], [190, 60]);
  const rect = { edge: await px(140, 40), inside: await px(165, 40), label: await label() };
  check('rectangle outline drawn, inside untouched', [rect.edge[0] < 40, rect.inside, rect.label], [true, [255, 255, 255, 255], 'Rectangle']);
  // Markup Board: an arrow, select and move it, Delete removes it (the file stays), Undo, steps, Flatten.
  await p.evaluate(() => qn.exec('edit.markup'));
  await p.evaluate(async () => { const P = await window.__qnPaint(); P.paint.markupTool = 'arrow'; P.paint.markupColor = '#e02020'; P.paint.markupWidth = 4; P.paint.onChange(); });
  const underStart = await p.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e ? `${e.tagName}.${e.className} ${e.textContent?.slice(0, 40) || ''}` : null; }, at(40, 280));
  await drag([40, 280], [140, 230]);
  const mk = await p.evaluate(async () => { const P = await window.__qnPaint(); const it = P.markup.itemsOf(qn.picture); return { n: it.length, kind: it[0]?.kind, pts: it[0]?.pts.map((q) => q.map(Math.floor)) }; });
  const pixelNotChanged = await px(90, 255);
  await p.evaluate(async () => { const P = await window.__qnPaint(); P.paint.markupTool = 'select'; P.paint.onChange(); });
  await click(90, 255);
  const sel = await p.evaluate(async () => (await window.__qnPaint()).paint.selected);
  await drag([90, 255], [110, 255], 5);
  const moved = await p.evaluate(async () => (await window.__qnPaint()).markup.itemsOf(qn.picture)[0]?.pts.map((q) => q.map(Math.floor)));
  await p.keyboard.press('Delete'); await p.waitForTimeout(150);
  const afterDelete = await p.evaluate(async () => ({ items: (await window.__qnPaint()).markup.itemsOf(qn.picture).length, folder: qn.folder.length, name: qn.picture?.name, dialogs: document.querySelectorAll('.ql-dialog').length }));
  for (let i = 0; i < 20 && afterDelete.dialogs; i++) { await p.keyboard.press('Escape'); await p.waitForTimeout(100); afterDelete.dialogs = await p.evaluate(() => document.querySelectorAll('.ql-dialog').length); }
  check('markup arrow created over the picture, not in it', [mk.n, mk.kind, mk.pts, pixelNotChanged], [1, 'arrow', [[40, 280], [140, 230]], [255, 255, 255, 255]], 'under the start point: ' + underStart);
  check('markup select, move and Delete (the file is not deleted)', [sel > 0, moved, afterDelete.items, afterDelete.folder, afterDelete.name, afterDelete.dialogs], [true, [[60, 280], [160, 230]], 0, pz.folder, 'q-paint.png', 0]);
  await p.evaluate(async () => { const P = await window.__qnPaint(); P.markup.undoMarkup(qn.picture); P.paint.markupTool = 'step'; P.paint.markupColor = '#e02020'; P.paint.onChange(); });
  await click(250, 250); await click(330, 250);
  const steps = await p.evaluate(async () => (await window.__qnPaint()).markup.itemsOf(qn.picture).filter((i) => i.kind === 'step').map((i) => i.n));
  const beforeFlat = await px(260, 250);
  await p.evaluate(() => qn.exec('edit.flattenMarkup')); await p.waitForTimeout(200);
  const flat = { px: await px(260, 250), items: await p.evaluate(async () => (await window.__qnPaint()).markup.itemsOf(qn.picture).length), label: await label() };
  await p.evaluate(() => qn.exec('edit.markup')); await p.waitForTimeout(100);
  const closed = await p.evaluate(async () => ({ open: (await window.__qnPaint()).paint.open, pane: !!qn.viewer.el.querySelector('.qn-paintbar') }));
  check('numbered steps count up and Flatten draws the markup in', [steps, beforeFlat[0] < 100 && beforeFlat[2] > 150, flat.px[0] > 180 && flat.px[1] < 80, flat.items, flat.label], [[1, 2], true, true, 0, 'Flatten Markup']);
  check('closing the pane hands the mouse back', [closed.open, closed.pane], [false, false]);

  // Before/After Slider, Compare Pictures and Synchronize Windows, with real mouse input.
  const sp = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 80 && document.querySelector('.ql-dialog'); i++) await wait(50);
    const mk = (w, h, color) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, w, h); return new Promise((r) => c.toBlob(r, 'image/png')); };
    qn.prefs.confirmClose = false;
    await qn.exec('file.openDropped', [new File([await mk(300, 200, '#ffffff')], 'r-split.png', { type: 'image/png' }), new File([await mk(300, 200, '#00c000')], 'r-zz.png', { type: 'image/png' })]);
    for (let i = 0; i < 60 && qn.picture?.name !== 'r-split.png'; i++) await wait(50);
    qn.viewer.setZoom(1); qn.viewer.center(); await wait(150);
    await qn.exec('image.negative', 'all'); await wait(150);
    await qn.exec('view.compareSplit'); await wait(300);
    const C = await window.__qnCompare();
    const canvas = qn.viewer.el.querySelector('canvas.qn-canvas'), dpr = canvas.width / qn.viewer.el.clientWidth;
    const r = qn.viewer.pictureRect(), b = qn.viewer.el.getBoundingClientRect();
    const sample = (x, y) => [...canvas.getContext('2d').getImageData(Math.round((r.x + x) * dpr), Math.round((r.y + y) * dpr), 1, 1).data].slice(0, 3);
    return { on: C.split.on, label: C.split.labelA, left: sample(50, 100), right: sample(250, 100), handle: [b.left + r.x + 150, b.top + r.y + 100], to: [b.left + r.x + 30, b.top + r.y + 100], dpr };
  });
  check('slider shows the picture as opened left of the divider', [sp.on, sp.label, sp.left, sp.right], [true, 'As opened', [255, 255, 255], [0, 0, 0]]);
  await p.mouse.move(...sp.handle); await p.mouse.down(); await p.mouse.move(...sp.to, { steps: 8 }); await p.mouse.up(); await p.waitForTimeout(150);
  const sp2 = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const C = await window.__qnCompare();
    const canvas = qn.viewer.el.querySelector('canvas.qn-canvas'), dpr = canvas.width / qn.viewer.el.clientWidth, r = qn.viewer.pictureRect();
    const out = { x: C.split.x, at50: [...canvas.getContext('2d').getImageData(Math.round((r.x + 50) * dpr), Math.round((r.y + 100) * dpr), 1, 1).data].slice(0, 3), sel: qn.tab.selection };
    await qn.exec('view.next'); for (let i = 0; i < 60 && qn.picture?.name !== 'r-zz.png'; i++) await wait(50); await wait(150);
    out.offAfterNav = !C.split.on;
    return out;
  });
  check('dragging the divider moves it (no selection drawn); a new picture turns the slider off', [Math.abs(sp2.x - 0.1) < 0.02, sp2.at50, sp2.sel, sp2.offAfterNav], [true, [0, 0, 0], null, true]);
  // Compare three marked pictures.
  const cmp = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const mk = (w, h, color) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, w, h); x.fillStyle = '#000'; x.fillRect(w / 2 - 2, 0, 4, h); return new Promise((r) => c.toBlob(r, 'image/png')); };
    await qn.exec('file.openDropped', [new File([await mk(400, 300, '#e00000')], 's-red.png', { type: 'image/png' }), new File([await mk(400, 300, '#00b000')], 't-green.png', { type: 'image/png' }), new File([await mk(400, 300, '#0000e0')], 'u-blue.png', { type: 'image/png' })]);
    for (let i = 0; i < 60 && qn.picture?.name !== 's-red.png'; i++) await wait(50); await wait(200);
    for (const e of qn.folder.entries) qn.tab.marked.add(e);
    await qn.exec('view.compare'); await wait(400);
    const C = await window.__qnCompare(), cv = C.compareOpen();
    const panes = [...qn.viewer.el.querySelectorAll('.qn-cmp-pane')];
    const color = (pane) => { const c = pane.querySelector('canvas'); const d = c.getContext('2d').getImageData(Math.round(c.width * 0.25), Math.round(c.height / 2), 1, 1).data; return [d[0], d[1], d[2]]; };
    const box = (pane) => { const r = pane.querySelector('canvas').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r.width, r.height]; };
    return { open: !!cv, n: panes.length, labels: panes.map((x) => x.querySelector('.qn-cmp-label').textContent.split(' · ')[0]), colors: panes.map(color), boxes: panes.map(box) };
  });
  check('compare opens three panes with their pictures', [cmp.open, cmp.n, cmp.labels, cmp.colors.map((c) => c.indexOf(Math.max(...c)))], [true, 3, ['s-red.png', 't-green.png', 'u-blue.png'], [0, 1, 2]]);
  if (cmp.boxes.length === 3) {
    await p.mouse.move(cmp.boxes[1][0], cmp.boxes[1][1]); for (let i = 0; i < 4; i++) { await p.mouse.wheel(0, -100); await p.waitForTimeout(40); } await p.waitForTimeout(120);
    await p.mouse.move(cmp.boxes[0][0], cmp.boxes[0][1]); await p.mouse.down(); await p.mouse.move(cmp.boxes[0][0] + 60, cmp.boxes[0][1], { steps: 6 }); await p.mouse.up(); await p.waitForTimeout(150);
  }
  const cmp2 = await p.evaluate(async () => {
    const C = await window.__qnCompare(), cv = C.compareOpen();
    const zooms = [...qn.viewer.el.querySelectorAll('.qn-cmp-label')].map((l) => l.textContent.split(' · ')[2]);
    const st = cv ? { ...cv.state } : null;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    return { st, zooms, closed: !C.compareOpen() && !qn.viewer.el.querySelector('.qn-compare') };
  });
  check('compare: wheel zooms and a drag pans every pane together; Esc closes', [cmp2.st && cmp2.st.rel > 1.5, cmp2.st && cmp2.st.nx < 0.5, new Set(cmp2.zooms).size, cmp2.closed], [true, true, 1, true]);
  // Synchronize two windows.
  const sw = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const mk = (w, h, color) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, w, h); return new Promise((r) => c.toBlob(r, 'image/png')); };
    qn.tab.marked.clear();
    await qn.exec('file.openDropped', [new File([await mk(800, 600, '#aa0000')], 'v1.png', { type: 'image/png' }), new File([await mk(800, 600, '#aa5500')], 'v2.png', { type: 'image/png' }), new File([await mk(800, 600, '#aaaa00')], 'v3.png', { type: 'image/png' })]);
    for (let i = 0; i < 60 && qn.picture?.name !== 'v1.png'; i++) await wait(50);
    const A = qn.tab; // the window that received v1–v3 (a window with unsaved edits makes the drop open a new one)
    for (const t of [...qn.tabs]) if (t !== A) qn.closeTab(t);
    qn.activate(A);
    let B = qn.createTab(); qn.activate(B);
    await qn.exec('file.openDropped', [new File([await mk(400, 300, '#0000aa')], 'w1.png', { type: 'image/png' }), new File([await mk(400, 300, '#0055aa')], 'w2.png', { type: 'image/png' }), new File([await mk(400, 300, '#00aaaa')], 'w3.png', { type: 'image/png' })]);
    for (let i = 0; i < 60 && qn.picture?.name !== 'w1.png'; i++) await wait(50);
    B = qn.tab;
    for (const t of [...qn.tabs]) if (t !== A && t !== B) qn.closeTab(t);
    qn.activate(A); await wait(150);
    await qn.exec('view.syncWindows'); await wait(300);
    const out = { tiled: qn.ui.workspace.classList.contains('qn-tiled'), hidden: qn.tabs.map((t) => t.el.classList.contains('ql-hidden-tab')), activeFramed: A.el.classList.contains('qn-window-active') };
    await qn.exec('view.next'); for (let i = 0; i < 60 && !(A.picture?.name === 'v2.png' && B.picture?.name === 'w2.png'); i++) await wait(50);
    out.afterNext = [A.picture?.name, B.picture?.name];
    A.ui.setZoom(A.ui.zoom * 2); await wait(250);
    out.rel = [A.ui.viewRel().rel, B.ui.viewRel().rel].map((v) => +v.toFixed(3));
    const bb = B.ui.el.getBoundingClientRect(); out.clickB = [bb.left + bb.width / 2, bb.top + bb.height / 2];
    return out;
  });
  await p.mouse.click(...sw.clickB); await p.waitForTimeout(150);
  const sw2 = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const B = qn.tabs[qn.tabs.length - 1];
    const out = { bActive: qn.tab === B };
    await qn.exec('view.syncWindows'); await wait(150);
    out.untiled = !qn.ui.workspace.classList.contains('qn-tiled'); out.hiddenAfter = qn.tabs.filter((t) => t.el.classList.contains('ql-hidden-tab')).length;
    qn.closeTab(B); await wait(150);
    out.tabs = qn.tabs.length;
    return out;
  });
  check('synchronize windows: side by side, next steps both, zoom follows', [sw.tiled, sw.hidden, sw.activeFramed, sw.afterNext, sw.rel[0] === sw.rel[1]], [true, [false, false], true, ['v2.png', 'w2.png'], true]);
  check('a click makes the other window the one followed; turning sync off hides it again', [sw2.bActive, sw2.untiled, sw2.hiddenAfter, sw2.tabs], [true, true, 1, 1]);

  // Special views: Stereo (a real two-JPEG MPO), 360° (mouse drag), Two-Page with right-to-left
  // reading (keyboard), and a motion photo (a JPEG with a VP9 clip appended): play, pause, frame.
  const vp9 = readFileSync('tests/fixtures/media/blue-vp9.mp4').toString('base64');
  const stv = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 80 && document.querySelector('.ql-dialog'); i++) await wait(50);
    const eye = (x0) => { const c = document.createElement('canvas'); c.width = 300; c.height = 200; const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, 300, 200); x.fillStyle = '#fff'; x.fillRect(x0, 50, 50, 100); return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.97)); };
    const L = new Uint8Array(await (await eye(100)).arrayBuffer()), R = new Uint8Array(await (await eye(120)).arrayBuffer());
    const mpo = new Uint8Array(L.length + R.length); mpo.set(L); mpo.set(R, L.length);
    const bands = document.createElement('canvas'); bands.width = 400; bands.height = 200; const bx = bands.getContext('2d'); ['#ff0000', '#00ff00', '#0000ff', '#ffff00'].forEach((c, i) => { bx.fillStyle = c; bx.fillRect(i * 100, 0, 100, 200); });
    qn.prefs.confirmClose = false;
    await qn.exec('file.openDropped', [new File([mpo], 'x-pair.jpg', { type: 'image/jpeg' }), new File([await new Promise((r) => bands.toBlob(r, 'image/png'))], 'x-sphere.png', { type: 'image/png' })]);
    for (let i = 0; i < 60 && qn.picture?.name !== 'x-pair.jpg'; i++) await wait(50); await wait(200);
    const S = await window.__qnSpecial();
    await qn.exec('view.stereo', 'gray'); await wait(300);
    const sv = S.specialOpen(), comp = sv.stereo.composite, at = (x, y) => [...comp.data.subarray((y * comp.width + x) * 4, (y * comp.width + x) * 4 + 3)];
    const out = { how: sv.el.querySelector('b').textContent, size: [comp.width, comp.height], leftOnly: at(110, 100), both: at(135, 100), rightOnly: at(160, 100), none: at(250, 100) };
    const sel = sv.el.querySelector('select'); sel.value = 'crossEye'; sel.dispatchEvent(new Event('change')); await wait(100);
    out.cross = [sv.stereo.composite.width, sv.stereo.composite.height];
    sv.close();
    // 360°: yaw 45° faces the blue band; then a drag turns the view.
    await qn.exec('view.next'); for (let i = 0; i < 60 && qn.picture?.name !== 'x-sphere.png'; i++) await wait(50); await wait(150);
    await qn.exec('view.sphere'); await wait(200);
    const sp = S.specialOpen(); sp.look = { yaw: 45, pitch: 0, fov: 40 }; sp.paint();
    const cv = sp.canvas, d = cv.getContext('2d').getImageData(Math.floor(cv.width / 2), Math.floor(cv.height / 2), 1, 1).data;
    out.sphere = { kind: sp.kind, center: [d[0], d[1], d[2]] };
    const r = cv.getBoundingClientRect(); out.drag = [r.left + r.width / 2, r.top + r.height / 2]; out.yaw0 = sp.look.yaw; out.vw = cv.clientWidth; out.fov = sp.look.fov;
    return out;
  });
  check('stereo: an MPO pair as a gray anaglyph', [stv.how, stv.size, stv.leftOnly[0] > 200 && stv.leftOnly[1] < 60, stv.both.every((v) => v > 200), stv.rightOnly[0] < 60 && stv.rightOnly[2] > 200, stv.none.every((v) => v < 40), stv.cross], ['Stereo View · MPO pair', [300, 200], true, true, true, true, [600, 200]]);
  check('360° view faces the band at its yaw', [stv.sphere.kind, stv.sphere.center], ['sphere', [0, 0, 255]]);
  await p.mouse.move(...stv.drag); await p.mouse.down(); await p.mouse.move(stv.drag[0] - 120, stv.drag[1], { steps: 6 }); await p.mouse.up(); await p.waitForTimeout(100);
  const sph2 = await p.evaluate(async () => { const S = await window.__qnSpecial(); const sv = S.specialOpen(); const yaw = sv.look.yaw; await qn.exec('view.previous'); await new Promise((r) => setTimeout(r, 300)); return { yaw, closedOnNav: !S.specialOpen() }; });
  check('360° drag turns the view by the dragged share of the field of view; a new picture closes it', [Math.abs(sph2.yaw - (stv.yaw0 + 120 * stv.fov / stv.vw)) < 0.5, sph2.closedOnNav], [true, true], `yaw ${sph2.yaw}, expected ${stv.yaw0 + 120 * stv.fov / stv.vw}`);
  // Two-page view over four pictures.
  await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const mk = (c) => { const cv = document.createElement('canvas'); cv.width = 200; cv.height = 300; const x = cv.getContext('2d'); x.fillStyle = c; x.fillRect(0, 0, 200, 300); return new Promise((r) => cv.toBlob(r, 'image/png')); };
    const files = []; for (const [i, c] of ['#ff0000', '#00ff00', '#0000ff', '#ffff00'].entries()) files.push(new File([await mk(c)], `y${i + 1}.png`, { type: 'image/png' }));
    await qn.exec('file.openDropped', files); for (let i = 0; i < 60 && qn.picture?.name !== 'y1.png'; i++) await wait(50); await wait(150);
    await qn.exec('view.twoPage'); await wait(300);
  });
  const spread = () => p.evaluate(async () => { const S = await window.__qnSpecial(); const sv = S.specialOpen(); const c = sv.image, x = c.getContext('2d'); const at = (f) => [...x.getImageData(Math.floor(c.width * f), Math.floor(c.height / 2), 1, 1).data].slice(0, 3); return { w: c.width, h: c.height, left: at(0.25), right: at(0.75), info: sv.el.querySelector('.ql-help').textContent }; });
  const sp0 = await spread();
  await p.keyboard.press('ArrowRight'); await p.waitForTimeout(250);
  const spA = await spread();
  await p.evaluate(() => qn.exec('view.rtl')); await p.waitForTimeout(250);
  const spB = await spread();
  await p.keyboard.press('ArrowLeft'); await p.waitForTimeout(250);
  const spC = await spread();
  await p.keyboard.press('Escape'); await p.waitForTimeout(250);
  const spEnd = await p.evaluate(async () => { const S = await window.__qnSpecial(); const out = { closed: !S.specialOpen(), current: qn.picture?.name }; if (S.reading.rtl) await qn.exec('view.rtl'); return out; });
  check('two-page view: the cover alone, then facing pages', [sp0.w, sp0.left, spA.w, spA.left, spA.right, spA.info], [200, [255, 0, 0], 400, [0, 255, 0], [0, 0, 255], '2–3 of 4']);
  check('right-to-left reading swaps the pages and the arrow keys', [spB.left, spB.right, /right to left/.test(spB.info), spC.w, spC.left, spEnd.closed, spEnd.current], [[0, 0, 255], [0, 255, 0], true, 200, [255, 255, 0], true, 'y4.png']);
  // Motion photo.
  const mov = await p.evaluate(async (vp9) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const c = document.createElement('canvas'); c.width = 256; c.height = 144; const x = c.getContext('2d'); x.fillStyle = '#d02020'; x.fillRect(0, 0, 256, 144);
    const jpg = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9))).arrayBuffer());
    const clip = Uint8Array.from(atob(vp9), (ch) => ch.charCodeAt(0));
    const both = new Uint8Array(jpg.length + clip.length); both.set(jpg); both.set(clip, jpg.length);
    await qn.exec('file.openDropped', [new File([both], 'z-motion.jpg', { type: 'image/jpeg' })]);
    for (let i = 0; i < 60 && qn.picture?.name !== 'z-motion.jpg'; i++) await wait(50); await wait(150);
    const S = await window.__qnSpecial();
    const out = { enabled: window.__qnGetCommand('view.motionPhoto').isEnabled(qn), clipLen: S.clipOf(qn.picture)?.length, expected: clip.length };
    await qn.exec('view.motionPhoto'); await wait(100);
    const v = S.specialOpen()?.video;
    out.loaded = await new Promise((r) => { if (!v) return r('no video'); if (v.readyState >= 2) return r('loaded'); v.onloadeddata = () => r('loaded'); v.onerror = () => r('error'); setTimeout(() => r('timeout'), 8000); });
    out.size = v ? [v.videoWidth, v.videoHeight] : null;
    await wait(300);
    await qn.exec('view.mediaPlay'); await wait(100); out.pausedAfterToggle = v.paused;
    await qn.exec('view.mediaPlay'); await wait(200); out.playingAgain = !v.paused;
    const tabs0 = qn.tabs.length;
    await qn.exec('view.mediaFrame'); for (let i = 0; i < 80 && qn.tabs.length === tabs0; i++) await wait(50); await wait(300);
    out.frame = { name: qn.picture?.name, size: [qn.picture?.width, qn.picture?.height], px: qn.picture ? [...qn.picture.frameCanvas().getContext('2d').getImageData(128, 72, 1, 1).data].slice(0, 3) : null };
    if (qn.tabs.length > tabs0) qn.closeTab(qn.tab);
    await wait(150); S.specialOpen()?.close();
    return out;
  }, vp9);
  check('motion photo: the appended clip found and played', [mov.enabled, mov.clipLen, mov.loaded, mov.size, mov.pausedAfterToggle, mov.playingAgain], [true, mov.expected, 'loaded', [256, 144], true, true]);
  check('save current frame opens the clip frame as a picture', [/^z-motion \(frame [\d.]+ s\)\.png$/.test(mov.frame.name || ''), mov.frame.size, mov.frame.px && mov.frame.px[2] > 200 && mov.frame.px[0] < 40], [true, [256, 144], true]);

  // Video and audio files met while browsing: the first frame or the cover art is the picture, the Media Player opens by itself.
  const mediaFiles = Object.fromEntries(['clip-vp9.webm', 'tone.flac', 'clip-h264.mov'].map((n) => [n, readFileSync(`tests/fixtures/media/${n}`).toString('base64')]));
  const med = await p.evaluate(async (files) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const S = await window.__qnSpecial();
    const list = Object.entries(files).map(([n, b64]) => new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], n));
    const before = qn.picture;
    await qn.exec('file.openDropped', list);
    for (let i = 0; i < 200 && (!qn.picture || qn.picture === before) && !document.querySelector('.ql-toast'); i++) await wait(50);
    const show = async (name) => { if (qn.picture?.name !== name) { qn.folder.select(qn.folder.entries.findIndex((e) => e.name === name)); await qn.tab.show(); } for (let i = 0; i < 200 && (!qn.picture || qn.picture.name !== name); i++) await wait(50); await wait(200); return qn.picture; };
    const out = {};
    let pic = await show('clip-vp9.webm');
    const sv = S.specialOpen();
    out.video = [pic.format.id, pic.width, pic.height, pic.media?.kind, pic.info.duration, pic.info.video, pic.info.audio, pic.info.title, pic.warnings, sv?.kind, !!sv?.video];
    const v = sv?.video;
    out.loaded = await new Promise((r) => { if (!v) return r('no video'); if (v.readyState >= 2) return r('loaded'); v.onloadeddata = () => r('loaded'); v.onerror = () => r('error'); setTimeout(() => r('timeout'), 8000); });
    out.playing = await new Promise((r) => { if (!v) return r(false); if (!v.paused) return r(true); v.onplaying = () => r(true); setTimeout(() => r(!v.paused), 3000); });
    const d = pic.frameCanvas().getContext('2d').getImageData(0, 0, 64, 48).data; let bright = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) bright++; out.posterBright = bright > 500; // testsrc's colored pattern, not a black frame
    await qn.exec('view.mediaPlay'); await wait(100); out.pausedAfterToggle = !!v?.paused;
    const tabs0 = qn.tabs.length;
    await qn.exec('view.mediaFrame'); for (let i = 0; i < 80 && qn.tabs.length === tabs0; i++) await wait(50); await wait(200);
    out.frame = [/^clip-vp9 \(frame [\d.]+ s\)\.png$/.test(qn.picture?.name || ''), qn.picture?.width, qn.picture?.height];
    if (qn.tabs.length > tabs0) qn.closeTab(qn.tab);
    await wait(150);
    out.afterClose = [qn.picture?.name, S.specialOpen()?.kind ?? null];
    if (S.specialOpen()?.kind !== 'media') await qn.exec('view.media'); await wait(100);
    out.reopened = S.specialOpen()?.kind; await qn.exec('view.media'); await wait(50); out.closedAgain = S.specialOpen() === null;
    pic = await show('tone.flac');
    const sa = S.specialOpen();
    out.audio = [pic.format.id, pic.width, pic.height, pic.media?.kind, pic.info.duration, pic.info.audio, pic.info['cover art'], pic.info.artist, sa?.kind, !!sa?.audio, !!sa?.video];
    const a = sa?.audio;
    out.audioLoaded = await new Promise((r) => { if (!a) return r('no audio'); if (a.readyState >= 2) return r('loaded'); a.onloadeddata = () => r('loaded'); a.onerror = () => r('error'); setTimeout(() => r('timeout'), 8000); });
    out.coverPx = [...pic.frameCanvas().getContext('2d').getImageData(32, 32, 1, 1).data].slice(0, 3); // the yellow disc of the cover
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await wait(100);
    out.escClosed = S.specialOpen() === null;
    pic = await show('clip-h264.mov'); // the open-source browser build has no H.264: a placeholder or a frame, either way a video picture
    out.mov = [pic.format.id, pic.media?.kind, pic.info.video, pic.pages[0].notes.some((n) => /Media Player/.test(n)), S.specialOpen()?.kind ?? null];
    S.specialOpen()?.close();
    return out;
  }, mediaFiles);
  check('media: a WebM file opens as its first frame with duration, codecs and tags; the Media Player opens, plays, pauses and saves a frame', [med.video, med.loaded, med.playing, med.posterBright, med.pausedAfterToggle, med.frame, med.afterClose, med.reopened, med.closedAgain], [['video', 64, 48, 'video', '1.01 s', 'VP9, 64 × 48, 10 fps', 'Opus, 48 kHz, mono', 'Fixture Title', [], 'media', true], 'loaded', true, true, true, [true, 64, 48], ['clip-vp9.webm', null], 'media', true], JSON.stringify(med));
  check('media: a FLAC file shows its cover art with the audio player; Esc closes it; a QuickTime file opens as a video picture', [med.audio, med.audioLoaded, med.coverPx, med.escClosed, med.mov], [['audio', 64, 64, 'audio', '1.00 s', 'FLAC, 44.1 kHz, mono, 16-bit', 'PNG, 0.3 KB', 'Anne Lens', 'media', true, false], 'loaded', [240, 200, 40], true, ['video', 'video', 'H.264 Baseline, 64 × 48, 10 fps', true, 'media']], JSON.stringify([med.audio, med.audioLoaded, med.coverPx, med.escClosed, med.mov]));

  // Script Console: JavaScript in a worker edits the picture (one Undo step), lists the folder,
  // reports a syntax error, and Stop ends a runaway loop. Command-Line Help lists the options.
  const scon = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 80 && document.querySelector('.ql-dialog'); i++) await wait(50);
    const pixel = () => [...qn.picture.frameCanvas().getContext('2d').getImageData(2, 2, 1, 1).data].slice(0, 3);
    const out = { before: pixel() };
    const run = qn.exec('dev.console', 'const i = await picture.info();\nprint("size", i.width, i.height);\nconst p = await picture.pixels();\nfor (let k = 0; k < p.data.length; k += 4) p.data[k] = 255 - p.data[k];\nawait picture.setPixels(p, "Invert red (script)");\nglobalThis.kept = 41;\nreturn { files: (await folder.list()).length, cur: (await folder.current()).name };');
    let dlg; for (let i = 0; i < 60 && !(dlg = [...document.querySelectorAll('.ql-dialog')].find((d) => /Script Console/.test(d.textContent))); i++) await wait(50);
    const btn = (label) => [...dlg.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
    const log = () => dlg.querySelector('.qn-console-out').textContent;
    const input = dlg.querySelector('textarea');
    btn('Run').click(); for (let i = 0; i < 100 && !/←/.test(log()); i++) await wait(50);
    out.first = log(); out.after = pixel(); out.undo = qn.tab.undoLabel;
    input.value = 'return globalThis.kept + 1;'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    for (let i = 0; i < 60 && !/← 42/.test(log()); i++) await wait(50); out.kept = /← 42/.test(log());
    input.value = 'return (;'; btn('Run').click(); for (let i = 0; i < 60 && !/✖/.test(log()); i++) await wait(50);
    out.syntax = (log().match(/✖ [^\n]*/) || [''])[0];
    input.value = 'await app.exec("no.such.command");'; btn('Run').click(); for (let i = 0; i < 60 && !/Unknown command/.test(log()); i++) await wait(50); out.unknown = /Unknown command: no\.such\.command/.test(log());
    input.value = 'while (true) {}'; btn('Run').click(); await wait(300); btn('Stop').click(); await wait(100);
    out.stopped = /Stopped; the console starts fresh/.test(log());
    input.value = 'return typeof globalThis.kept;'; btn('Run').click(); for (let i = 0; i < 60 && !/← undefined/.test(log()); i++) await wait(50); out.fresh = /← undefined/.test(log());
    btn('Close').click(); await run; await wait(100);
    qn.tab.undo(); await wait(100); out.undone = pixel();
    const help = qn.exec('dev.cliHelp'); let hd; for (let i = 0; i < 60 && !(hd = [...document.querySelectorAll('.ql-dialog')].find((d) => /Command-Line Help/.test(d.textContent))); i++) await wait(50);
    out.help = ['--convert=PATTERN', '--resize=WxH | W | xH | N%', '--slideshow', 'Exit status'].map((t) => hd.textContent.includes(t)); out.helpNote = /desktop app/.test(hd.textContent);
    [...hd.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Close').click(); await help;
    for (let i = 0; i < 80 && document.querySelector('.ql-dialog'); i++) await wait(50);
    return out;
  });
  check('script console edits the picture in one undo step', [scon.after[0] === 255 - scon.before[0], scon.after[1] === scon.before[1], scon.undo, /size \d+ \d+/.test(scon.first), /"files": \d+/.test(scon.first), scon.undone], [true, true, 'Invert red (script)', true, true, scon.before], JSON.stringify(scon));
  check('script console keeps globals, reports errors, stops runaway scripts', [scon.kept, /^✖ SyntaxError/.test(scon.syntax), scon.unknown, scon.stopped, scon.fresh], [true, true, true, true, true], scon.syntax);
  check('command-line help lists the options', [scon.help, scon.helpNote], [[true, true, true, true], true]);

  // Next / Previous Folder through a File System Access tree (a folder of folders: Open Folder shows
  // the first one with pictures), with the keyboard; Full Screen on Another Display on a stubbed
  // two-screen Window Management API.
  const fnav = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 80 && document.querySelector('.ql-dialog'); i++) await wait(50);
    const seen = []; new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.classList?.contains('ql-toast')) seen.push(n.textContent); }).observe(document.body, { childList: true, subtree: true });
    const png = async (color) => { const c = document.createElement('canvas'); c.width = 8; c.height = 8; const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, 8, 8); return new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer()); };
    const file = (name, bytes) => { const f = { kind: 'file', name, isSameEntry: async (o) => o === f, getFile: async () => new File([bytes], name, { type: 'image/png' }) }; return f; };
    const dir = (name, kids) => { const d = { kind: 'directory', name, isSameEntry: async (o) => o === d, entries: async function* () { for (const k of kids) yield [k.name, k]; } }; return d; };
    const root = dir('Family', [file('notes.txt', new Uint8Array([1])), dir('2019 Reunion', [file('a.png', await png('#ff0000')), dir('extras', [file('b.png', await png('#00ff00'))])]), dir('.hidden', [file('h.png', await png('#ffffff'))]), dir('2020 Wedding', [file('c.png', await png('#0000ff')), file('d.png', await png('#0000ff'))]), dir('Empty', [])]);
    window.showDirectoryPicker = async () => root;
    const where = () => ({ folder: qn.folder.name, n: qn.folder.length, pic: qn.picture?.name });
    const settle = async (name) => { for (let i = 0; i < 60 && qn.folder.name !== name; i++) await wait(50); await wait(250); };
    const out = {};
    await qn.exec('file.openFolder'); await settle('2019 Reunion'); out.opened = where();
    out.enabled = window.__qnGetCommand('view.nextFolder').isEnabled(qn);
    return out;
  });
  check('open folder of folders shows the first with pictures', [fnav.opened, fnav.enabled], [{ folder: '2019 Reunion', n: 1, pic: 'a.png' }, true]);
  const fsteps = [];
  for (const key of ['Control+ArrowRight', 'Control+ArrowRight', 'Control+ArrowRight', 'Control+ArrowLeft', 'Control+ArrowLeft']) {
    await p.keyboard.press(key); await p.waitForTimeout(700);
    fsteps.push(await p.evaluate(() => `${qn.folder.name}:${qn.folder.length}:${qn.picture?.name}`));
  }
  check('next / previous folder walk the tree (subfolders first, hidden and empty skipped)', fsteps, ['extras:1:b.png', '2020 Wedding:2:c.png', '2020 Wedding:2:c.png', 'extras:1:b.png', '2019 Reunion:1:a.png']);
  const fsd = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const seen = []; new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.classList?.contains('ql-toast')) seen.push(n.textContent); }).observe(document.body, { childList: true, subtree: true });
    const screens = [{ label: 'Built-in', width: 1920, height: 1080, isPrimary: true }, { label: 'Projector', width: 1280, height: 720, isPrimary: false }];
    let count = 2;
    window.getScreenDetails = async () => ({ screens: screens.slice(0, count), currentScreen: screens[0] });
    const asked = []; const orig = document.documentElement.requestFullscreen; document.documentElement.requestFullscreen = function (o) { asked.push(o); return Promise.resolve(); };
    const out = { enabled: window.__qnGetCommand('view.fullScreenDisplay').isEnabled(qn), framelessEnabled: window.__qnGetCommand('view.frameless').isEnabled(qn) };
    // The dialog lists both displays and preselects the one the window is not on.
    const run = qn.exec('view.fullScreenDisplay'); let d; for (let i = 0; i < 60 && !(d = document.querySelector('.ql-dialog .ql-primary')); i++) await wait(50);
    const dlg = document.querySelector('.ql-dialog'); out.labels = [...dlg.querySelectorAll('label')].map((l) => l.textContent.trim()).filter((t) => /Built-in|Projector/.test(t));
    out.preselected = dlg.querySelector('input[type=radio]:checked')?.value; d.click(); await run; await wait(100);
    out.screen = asked[0]?.screen?.label; out.fullscreen = document.body.classList.contains('ql-fullscreen');
    await qn.exec('view.fullScreen'); await wait(100); out.after = document.body.classList.contains('ql-fullscreen');
    count = 1; await qn.exec('view.fullScreenDisplay'); await wait(150); out.single = seen.find((t) => /Only one display/.test(t)) || null; out.calls = asked.length;
    document.documentElement.requestFullscreen = orig;
    for (let i = 0; i < 80 && document.querySelector('.ql-dialog'); i++) await wait(50);
    return out;
  });
  check('full screen on another display uses the chosen screen', [fsd.enabled, fsd.framelessEnabled, fsd.labels.length, fsd.preselected, fsd.screen, fsd.fullscreen, fsd.after, fsd.single, fsd.calls], [true, false, 2, '1', 'Projector', true, false, 'Only one display is connected.', 1], JSON.stringify(fsd));

  // Color management: a PNG and a JPEG tagged with the Adobe RGB-compatible profile decode to their
  // own values and display through the profile (LittleCMS: (180, 60, 60) shows as (208, 57, 57));
  // the toggle, soft proof (gray, a CMYK press with the gamut warning), Convert and Assign, and a
  // save that carries the new profile and looks the same after reopening.
  const cref = JSON.parse(readFileSync('tests/fixtures/color/lcms-reference.json', 'utf8'));
  const cfx = ['tagged-adobergb.png', 'tagged-adobergb.jpg', 'press-cmyk.icc'].map((f) => readFileSync('tests/fixtures/color/' + f).toString('base64'));
  const cm = await p.evaluate(async ([png64, jpg64, press64]) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const b64 = (s) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
    for (let i = 0; i < 80 && document.querySelector('.ql-dialog'); i++) await wait(50);
    const C = await window.__qnColor(), N = await window.__qnNative();
    const seen = []; new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.classList?.contains('ql-toast')) seen.push(n.textContent); }).observe(document.body, { childList: true, subtree: true });
    const raw = (fx) => [...qn.picture.frameCanvas().getContext('2d').getImageData(Math.floor(qn.picture.width * fx), 24, 1, 1).data].slice(0, 3);
    const shown = (fx) => { const v = qn.viewer, r = v.pictureRect(), dpr = window.devicePixelRatio || 1; return [...v.canvas.getContext('2d').getImageData(Math.round((r.x + r.w * fx) * dpr), Math.round((r.y + r.h / 2) * dpr), 1, 1).data].slice(0, 3); };
    const both = () => ({ raw: [raw(0.25), raw(0.75)], shown: [shown(0.25), shown(0.75)] });
    const redraw = async () => { qn.tab.ui.draw(); await wait(120); };
    const pngBytes = b64(png64), jpgBytes = b64(jpg64);
    await qn.exec('file.openDropped', [new File([pngBytes], 'cm-adobe.png', { type: 'image/png' }), new File([jpgBytes], 'cm-adobe.jpg', { type: 'image/jpeg' })]);
    for (let i = 0; i < 60 && qn.picture?.name !== 'cm-adobe.png'; i++) await wait(50); await wait(250); await redraw();
    const out = { png: { ...both(), note: qn.picture.current.notes.find((n) => /color profile/.test(n)) } };
    await qn.exec('view.colorManaged'); await redraw(); out.unmanaged = both().shown; await qn.exec('view.colorManaged'); await redraw(); out.managedAgain = both().shown;
    // The platform's own default decode converts to sRGB (what the app used to show).
    const bmp = await createImageBitmap(new Blob([jpgBytes], { type: 'image/jpeg' })); const c0 = document.createElement('canvas'); c0.width = bmp.width; c0.height = bmp.height; c0.getContext('2d').drawImage(bmp, 0, 0);
    out.platformDefault = [...c0.getContext('2d').getImageData(16, 24, 1, 1).data].slice(0, 3);
    const goto = async (name) => { const i = qn.folder.entries.findIndex((e) => e.name === name); if (i >= 0 && qn.folder.select(i)) await qn.tab.show(); for (let k = 0; k < 60 && qn.picture?.name !== name; k++) await wait(50); await wait(250); await redraw(); };
    await goto('cm-adobe.jpg');
    out.jpg = { ...both(), tagged: !!qn.picture.current.icc };
    await goto('cm-adobe.png'); out.backOnPng = qn.picture.name;
    // Soft proof: gray, then the CMYK press with the gamut warning; both leave the values alone.
    await qn.exec('image.softProof', { profile: 'S:gray22' }); await redraw(); out.proofGray = both(); out.proofActive = window.__qnGetCommand('image.softProof').isActive(qn);
    await qn.exec('image.softProof'); await redraw(); out.proofOff = both().shown;
    const press = await C.loadProfileFile([new File([b64(press64)], 'press.icc')]);
    await qn.exec('image.softProof', { profile: 'L:' + C.loadedProfiles.indexOf(press), gamutWarning: true }); await redraw(); out.proofPress = both().shown;
    await qn.exec('image.softProof', { profile: 'L:' + C.loadedProfiles.indexOf(press), gamutWarning: false }); await redraw(); out.proofPressPlain = both().shown;
    await qn.exec('image.softProof'); await redraw();
    // Convert keeps the look and changes the values; Assign keeps the values and changes the look.
    await qn.exec('image.convertProfile', { to: 'S:srgb' }); await redraw(); out.toSrgb = { ...both(), name: C.profileName(qn.picture.current.icc), label: qn.tab.undoLabel };
    qn.tab.undo(); await redraw(); out.undone = { ...both(), name: C.profileName(qn.picture.current.icc) };
    await qn.exec('image.assignProfile', 'S:srgb'); await redraw(); out.assigned = both(); qn.tab.undo(); await redraw();
    await qn.exec('image.convertProfile', { to: 'L:' + C.loadedProfiles.indexOf(press) }); out.refusedCmyk = seen.some((t) => /pictures can be in RGB or gray profiles only/.test(t)) && C.profileName(qn.picture.current.icc) === 'Adobe RGB (1998) compatible';
    await qn.exec('image.convertProfile', { to: 'S:gray22' }); await redraw(); out.gray = both(); qn.tab.undo(); await redraw();
    // Convert to Display P3 and save through a writable handle; the file reopens tagged and looks the same.
    await qn.exec('image.convertProfile', { to: 'S:p3' }); await redraw(); const p3 = both();
    const saved = { value: null }; const fh = { kind: 'file', name: 'cm-adobe.png', isSameEntry: async (o) => o === undefined, getFile: async () => new File([saved.value || pngBytes], 'cm-adobe.png', { type: 'image/png' }), createWritable: async () => { const parts = []; return { write: async (b) => { parts.push(b); }, close: async () => { saved.value = new Uint8Array(await new Blob(parts).arrayBuffer()); } }; } };
    qn.picture.entry.uri = 'fsa:' + (await N.handleId(fh)); qn.prefs.keepOriginal = false;
    await qn.exec('file.save'); for (let i = 0; i < 60 && !saved.value; i++) await wait(50); await wait(500); await redraw();
    const embedded = saved.value && (await C.pngIcc(saved.value));
    out.saved = { p3, embedded: embedded && C.profileName(embedded), reopened: { ...both(), name: C.profileName(qn.picture.current.icc), dirty: qn.tab.dirty } };
    for (let i = 0; i < 80 && document.querySelector('.ql-dialog'); i++) await wait(50);
    out.toasts = seen;
    return out;
  }, cfx);
  const near = (a, b, t = 2) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= t);
  const [adobeRed, adobeGreen] = cref.tagged['adobergb>srgb'];
  check('color: a tagged PNG keeps its values and displays through its profile', [near(cm.png.raw[0], [180, 60, 60], 1) && near(cm.png.raw[1], [0, 200, 0], 1), near(cm.png.shown[0], adobeRed), near(cm.png.shown[1], adobeGreen), cm.png.note], [true, true, true, 'color profile: Adobe RGB (1998) compatible'], JSON.stringify(cm.png.shown));
  check('color: Color-Managed Display off shows the raw values, on again the managed ones', [near(cm.unmanaged[0], [180, 60, 60], 1) && near(cm.unmanaged[1], [0, 200, 0], 1), near(cm.managedAgain[0], adobeRed)], [true, true], JSON.stringify(cm.unmanaged));
  check('color: the platform converts by default (why the app decodes tagged files itself)', near(cm.platformDefault, adobeRed, 3), true, JSON.stringify(cm.platformDefault));
  check('color: a tagged JPEG (APP2) too', [cm.backOnPng === 'cm-adobe.png', cm.jpg.tagged, near(cm.jpg.raw[0], [180, 60, 60], 2), near(cm.jpg.shown[0], adobeRed, 3)], [true, true, true, true], JSON.stringify(cm.jpg));
  const g = cm.proofGray.shown[0];
  check('color: soft proof on gray shows neutral tones and leaves the values', [cm.proofActive, g[0] === g[1] && g[1] === g[2], Math.abs(g[0] - cref.tagged['adobergb>gray22'][0][0]) <= 3, near(cm.proofGray.raw[0], [180, 60, 60], 1), near(cm.proofOff[0], adobeRed)], [true, true, true, true, true], JSON.stringify(cm.proofGray));
  check('color: press proof marks the out-of-gamut green in magenta; without the warning it prints duller', [cm.proofPress[1], cm.proofPressPlain[1][0] - adobeGreen[0] > 30 && cm.proofPressPlain[1][2] - adobeGreen[2] > 30], [[255, 0, 255], true], JSON.stringify([cm.proofPress, cm.proofPressPlain]));
  check('color: Convert to sRGB changes the values, keeps the look, and undoes', [near(cm.toSrgb.raw[0], adobeRed, 1), near(cm.toSrgb.shown[0], adobeRed), cm.toSrgb.name, cm.toSrgb.label, near(cm.undone.raw[0], [180, 60, 60], 1), cm.undone.name], [true, true, 'sRGB IEC61966-2.1', 'Convert to sRGB IEC61966-2.1', true, 'Adobe RGB (1998) compatible'], JSON.stringify(cm.toSrgb));
  check('color: Assign sRGB keeps the values and changes the look', [near(cm.assigned.raw[0], [180, 60, 60], 1), near(cm.assigned.shown[0], cm.assigned.raw[0], 1)], [true, true], JSON.stringify(cm.assigned));
  check('color: a CMYK profile is refused for the pixels', cm.refusedCmyk, true);
  check('color: Convert to gray makes neutral values', [cm.gray.raw[0][0] === cm.gray.raw[0][1] && cm.gray.raw[0][1] === cm.gray.raw[0][2], Math.abs(cm.gray.raw[0][0] - cref.tagged['adobergb>gray22'][0][0]) <= 1], [true, true], JSON.stringify(cm.gray));
  check('color: Convert to P3 and save; the file carries the profile and looks the same reopened', [cm.saved.embedded, cm.saved.reopened.name, near(cm.saved.reopened.raw[0], cm.saved.p3.raw[0], 1) && near(cm.saved.reopened.raw[1], cm.saved.p3.raw[1], 1), near(cm.saved.reopened.shown[0], adobeRed), cm.saved.reopened.dirty], ['Display P3', 'Display P3', true, true, false], JSON.stringify(cm.saved));
  if (cm.toasts.some((t) => /Not converted|failed/i.test(t))) failures.push('color toasts: ' + cm.toasts.join(' | '));

  // AI tab: a mock OpenAI-compatible service (text, vision, generation, masked edits) and the on-device
  // runtime (ONNX Runtime Web, WebAssembly) with tiny fixture models shaped like the real ones.
  const ai = await p.evaluate(async (AI_PORT) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const noDialog = async () => { for (let i = 0; i < 60 && document.querySelector('.ql-dialog'); i++) await wait(50); };
    const dialog = async () => { for (let i = 0; i < 100; i++) { const d = [...document.querySelectorAll('.ql-dialog')].pop(); if (d && d.querySelector('.ql-primary')) return d; await wait(50); } throw new Error('no dialog; toasts: ' + seen.join(' | ') + '; tab ' + (qn.picture && qn.picture.name) + ' tabs ' + qn.tabs.length); };
    const field = (d, key) => d.querySelector(`[id^="f_${key}_"]`);
    const setField = (d, key, value) => { const f = field(d, key); if (!f) throw new Error('no field ' + key); if (f.type === 'checkbox') f.checked = !!value; else f.value = String(value); f.dispatchEvent(new Event(f.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); f.dispatchEvent(new Event('change', { bubbles: true })); };
    const seen = []; new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.classList?.contains('ql-toast')) seen.push(n.textContent); }).observe(document.body, { childList: true, subtree: true });
    const toasts = () => seen.slice();
    const done = (p) => Promise.race([p, wait(60000).then(() => { throw new Error('timeout; toasts: ' + seen.join(' | ') + '; dialogs ' + document.querySelectorAll('.ql-dialog').length + ' ' + [...document.querySelectorAll('.ql-dialog h2, .ql-dialog .ql-dialog-title')].map((e) => e.textContent).join('/')); })]);
    const pixel = (x, y) => [...qn.picture.frameCanvas().getContext('2d').getImageData(x, y, 1, 1).data];
    const out = {};
    const A = await window.__qnAi();
    window.__qnOrtBase = './ort/';
    const MAP = { modnet: 'matte-test.onnx', 'depth-anything-v2-small': 'depth-test.onnx', lama: 'inpaint-test.onnx', 'swin2sr-x2': 'sr-x2-test.onnx', 'swin2sr-x4-real': 'sr-x4-test.onnx' };
    A.device.setModelUrlOverride((spec, path) => `./ai-fixtures/${MAP[spec.id] || ({ 'onnx/vision_model_quantized.onnx': 'clip-vision-test.onnx', 'onnx/text_model_quantized.onnx': 'clip-text-test.onnx' })[path] || path.split('/').pop()}`);
    for (const spec of A.device.MODELS) await A.device.ensureModel(spec, 'quantized'); // the fixtures: no download dialog later
    const mk = (w, h, draw) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); draw(x); return new Promise((r) => c.toBlob(r, 'image/png')); };
    const files = [
      new File([await mk(160, 120, (x) => { x.fillStyle = '#000'; x.fillRect(0, 0, 160, 120); x.fillStyle = '#fff'; x.fillRect(40, 30, 80, 60); })], 'a-subject.png', { type: 'image/png' }),
      new File([await mk(40, 40, (x) => { x.fillStyle = '#f00'; x.fillRect(0, 0, 40, 40); })], 'b-red.png', { type: 'image/png' }),
      new File([await mk(40, 40, (x) => { x.fillStyle = '#0f0'; x.fillRect(0, 0, 40, 40); })], 'c-green.png', { type: 'image/png' }),
      new File([await mk(40, 40, (x) => { x.fillStyle = '#e00'; x.fillRect(0, 0, 40, 40); })], 'd-red2.png', { type: 'image/png' }),
    ];
    qn.prefs.confirmClose = false;
    await qn.exec('file.openDropped', files); await wait(600);
    const aiTab = qn.tab; const back = async () => { if (qn.tab !== aiTab) qn.closeTab(qn.tab); qn.activate(aiTab); await wait(300); };
    qn.prefs.ai.services = [{ id: 'mock', name: 'Mock', api: 'openai', baseUrl: `http://localhost:${AI_PORT}/v1`, key: 'k', textModel: 'mock-vision', imageModel: 'mock-image' }, { id: 'mock2', name: 'Mock Two', api: 'openai', baseUrl: `http://localhost:${AI_PORT}/v1`, key: 'k2', textModel: 'mock-vision', imageModel: '' }];
    qn.prefs.ai.textService = 'mock'; qn.prefs.ai.imageService = 'mock'; qn.prefs.ai.privacy.confirmSend = false; qn.prefs.ai.prefer = 'device'; qn.savePrefs();
    { const pd = await dialog(); out.passDialog = pd.querySelector('h2, .ql-dialog-title')?.textContent; pd.querySelector('.ql-cancel, .ql-btn:not(.ql-primary)').click(); await noDialog(); out.keysStored = JSON.parse(localStorage.getItem('annes-lens.ai.keys.v1') || 'null'); out.prefsHaveKey = /"key":"k"/.test(localStorage.getItem('quilllens.prefs.v1') || ''); } // saving a key on the web asks for a passphrase; declined: unencrypted
    out.enabled = ['ai.describe', 'ai.generate', 'ai.fill', 'ai.removeBackground', 'ai.stop'].map((id) => { const c = window.__qnGetCommand(id); return !c.isEnabled || c.isEnabled(qn); });
    out.first = qn.picture.name;
    // Describe: the answer appears in a text dialog.
    let run = qn.exec('ai.describe'); let d = await dialog(); out.describe = field(d, 'text').value; d.querySelector('.ql-primary').click(); await done(run); await noDialog();
    // Alt Text: JSON parsed into two fields.
    run = qn.exec('ai.altText'); d = await dialog(); out.alt = [field(d, 'alt').value, field(d, 'ext').value]; d.querySelector('.ql-cancel, .ql-btn:not(.ql-primary)').click(); await done(run); await noDialog();
    // Suggest Keywords: one checkbox per keyword.
    run = qn.exec('ai.autoTag'); d = await dialog(); out.tags = [...d.querySelectorAll('input[type=checkbox]')].map((c) => c.parentElement.textContent.trim()).filter((t) => t && !/existing/i.test(t)).slice(0, 3); d.querySelector('.ql-cancel, .ql-btn:not(.ql-primary)').click(); await done(run); await noDialog();
    // Select by Description: a normalized box becomes the selection.
    run = qn.exec('ai.selectByPrompt'); d = await dialog(); setField(d, 'what', 'the square'); d.querySelector('.ql-primary').click(); await done(run); await wait(200); out.box = qn.tab.selection && [qn.tab.selection.x, qn.tab.selection.y, qn.tab.selection.w, qn.tab.selection.h];
    // Generate: a new picture with provenance metadata opens in a new window.
    const tabs0 = qn.tabs.length;
    run = qn.exec('ai.generate'); d = await dialog(); setField(d, 'prompt', 'a bicycle'); d.querySelector('.ql-primary').click(); await done(run); await wait(800);
    const M = await window.__qnMeta();
    out.gen = { tabs: qn.tabs.length - tabs0, name: qn.picture.name, w: qn.picture.width, center: pixel(32, 32).slice(0, 3), xmp: (M.extractMeta(qn.picture.bytes).xmp ? new TextDecoder().decode(M.extractMeta(qn.picture.bytes).xmp) : '') };
    out.genProv = { source: /trainedAlgorithmicMedia/.test(out.gen.xmp), prompt: /AiPrompt>a bicycle</.test(out.gen.xmp), provider: /AiProvider>Mock</.test(out.gen.xmp) }; delete out.gen.xmp;
    // Saved as PNG through a writable handle, the generated picture carries a signed C2PA manifest that reads back as valid.
    { const N = await window.__qnNative(); const saved = { value: null }; const fh = { kind: 'file', name: 'generated.png', isSameEntry: async (o) => o === undefined, getFile: async () => new File([saved.value || qn.picture.bytes], 'generated.png', { type: 'image/png' }), createWritable: async () => ({ write: async (d) => { saved.value = new Uint8Array(d instanceof Blob ? await d.arrayBuffer() : d); }, close: async () => {} }) };
      qn.picture.entry.uri = 'fsa:' + (await N.handleId(fh)); qn.prefs.keepOriginal = false; qn.prefs.keepMetadata = true;
      await qn.exec('file.save'); for (let i = 0; i < 100 && !saved.value; i++) await wait(50); await wait(300);
      const m = saved.value ? await M.c2pa.readManifest(saved.value) : null;
      out.c2pa = m ? { checks: m.checks, action: m.actions[0]?.action, source: m.actions[0]?.digitalSourceType?.replace(/^.*\//, ''), prompt: m.actions[0]?.parameters?.prompt, signer: m.signer?.subject, selfSigned: m.signer?.selfSigned, info: qn.picture.info['Content Credentials'] } : { saved: !!saved.value, toasts: seen.slice(-3) }; }
    await back();
    // Generate on this device: a fake generator stands in for the 2 GB model; the download dialog shows the license first.
    { const DG = A.deviceGenerate; const loads = [];
      DG.deviceGenHooks.loader = async (spec, progress) => { loads.push(spec.id); progress?.('loading the fake'); return { model: spec, device: 'wasm', release() {}, generate: async (req) => { out.devicePrompt = req.prompt; return [{ width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4).map((_, i) => (i % 4 === 3 ? 255 : i % 4 === 2 ? 40 : 200)) }]; } }; };
      qn.prefs.ai.services.push({ id: 'device', name: 'This device', api: 'device', baseUrl: 'device://local', key: '', textModel: '', imageModel: 'janus-pro-1b' }); qn.prefs.ai.imageService = 'device'; qn.savePrefs();
      const tabs1 = qn.tabs.length;
      const dialogWith = async (re) => { for (let i = 0; i < 100; i++) { const x = [...document.querySelectorAll('.ql-dialog')].find((e) => re.test(e.textContent)); if (x) return x; await wait(50); } return null; };
      run = qn.exec('ai.generate'); d = await dialogWith(/Generate Picture/); out.deviceHelp = d.textContent.includes('Runs on this device'); setField(d, 'prompt', 'a lighthouse'); d.querySelector('.ql-primary').click();
      d = await dialogWith(/Download the picture model/); out.deviceLicense = [/Download the picture model/.test(d.textContent), /DeepSeek Model License/.test(d.textContent), /not a permissive license/.test(d.textContent), d.querySelector('.ql-primary')?.textContent]; d.querySelector('.ql-primary').click();
      await done(run); await wait(800);
      out.deviceGen = { loads, tabs: qn.tabs.length - tabs1, w: qn.picture.width, center: pixel(32, 32).slice(0, 3), xmp: (M.extractMeta(qn.picture.bytes).xmp ? new TextDecoder().decode(M.extractMeta(qn.picture.bytes).xmp) : '') };
      out.deviceProv = { provider: /AiProvider>this device</.test(out.deviceGen.xmp), model: /Janus-Pro-1B/.test(out.deviceGen.xmp) }; delete out.deviceGen.xmp;
      if (qn.tabs.length > tabs1) qn.closeTab(qn.tab); await back();
      qn.prefs.ai.services = qn.prefs.ai.services.filter((x) => x.id !== 'device'); qn.prefs.ai.imageService = 'mock'; qn.savePrefs(); }
    // Generative Fill: the service's blue answer is blended inside the selection only.
    qn.tab.setSelection({ x: 50, y: 40, w: 30, h: 20 });
    run = qn.exec('ai.fill'); d = await dialog(); setField(d, 'prompt', 'a pond'); d.querySelector('.ql-primary').click(); await done(run); await wait(800);
    out.fill = { name: qn.picture.name, size: [qn.picture.width, qn.picture.height], inside: pixel(65, 50).slice(0, 3), outsideWhite: pixel(100, 60).slice(0, 3), outsideBlack: pixel(5, 5).slice(0, 3) };
    await back();
    // Remove Background on the device: the matting fixture keeps the white subject.
    qn.tab.setSelection(null);
    run = qn.exec('ai.removeBackground'); d = await dialog(); setField(d, 'where', 'device'); d.querySelector('.ql-primary').click(); await done(run); await wait(1500);
    out.rb = { name: qn.picture.name, subjectA: pixel(80, 60)[3], cornerA: pixel(5, 5)[3], provider: A.device.runtimeStatus.provider };
    await back();
    // Erase Object on the device: the inpainting fixture fills the selection with mid-gray.
    qn.tab.setSelection({ x: 50, y: 40, w: 30, h: 20 });
    run = qn.exec('ai.erase'); d = await dialog(); setField(d, 'where', 'device'); d.querySelector('.ql-primary').click(); await done(run); await wait(1500);
    out.erase = { inside: pixel(65, 50)[0], outside: pixel(100, 60)[0], black: pixel(5, 5)[0] };
    await back();
    // Upscale 2× on the device.
    qn.tab.setSelection(null);
    run = qn.exec('ai.upscale'); d = await dialog(); d.querySelector('.ql-primary').click(); await done(run); await wait(2500);
    out.up = { size: [qn.picture.width, qn.picture.height], center: pixel(160, 120)[0], corner: pixel(2, 2)[0] };
    await back();
    // Depth Map as a selection by distance: the near (white) subject.
    run = qn.exec('ai.depth'); d = await dialog(); setField(d, 'out', 'selection'); d.querySelector('.ql-primary').click(); await done(run); await wait(1500);
    out.depthSel = qn.tab.selection && [qn.tab.selection.x, qn.tab.selection.y, qn.tab.selection.w, qn.tab.selection.h];
    qn.tab.setSelection(null);
    // Search by Content (CLIP fixture): every picture scores; the thumbnails are filtered.
    run = qn.exec('ai.searchContent'); d = await dialog(); setField(d, 'q', 'red'); setField(d, 'min', 0); d.querySelector('.ql-primary').click(); await done(run); await wait(500);
    d = await dialog(); out.search = { hits: d.querySelectorAll('.qn-ai-card').length, top: (d.querySelector('.qn-ai-card') || {}).textContent, label: qn.tab.thumbs ? qn.tab.thumbs.filterLabel : '' }; d.querySelector('.ql-primary').click(); await noDialog();
    if (qn.tab.thumbs) { qn.tab.thumbs.filter = null; qn.tab.thumbs.filterLabel = ''; qn.tab.thumbs.refilter(); }
    // Find Similar by Content from the red picture: the other red one comes first.
    for (let i = 0; i < 6 && qn.picture?.name !== 'b-red.png'; i++) { await qn.exec('view.next'); await wait(250); }
    out.simCur = qn.picture?.name;
    run = qn.exec('ai.findSimilarSemantic'); await done(run); await wait(300); d = await dialog(); out.similar = [...d.querySelectorAll('.qn-ai-card')].map((c) => c.textContent.split(' — ')[0]); d.querySelector('.ql-primary').click(); await noDialog();
    if (qn.tab.thumbs) { qn.tab.thumbs.filter = null; qn.tab.thumbs.filterLabel = ''; qn.tab.thumbs.refilter(); }
    // Several AIs (master): two members answer, the master combines; the discussion is shown.
    qn.prefs.ai.ensemble = { mode: 'master', members: ['mock', 'mock2'], master: 'mock', showDeliberation: true }; qn.savePrefs();
    run = qn.exec('ai.describe'); d = await dialog(); out.ensemble = { text: field(d, 'text').value, discussion: /## Mock .*round 1[\s\S]*## Mock Two[\s\S]*## Master: Mock/.test(field(d, 'delib').value) }; d.querySelector('.ql-primary').click(); await done(run); await noDialog();
    qn.prefs.ai.ensemble.mode = 'single'; qn.savePrefs();
    out.history = A.history.readHistory().map((e) => `${e.command}:${e.service}`);
    out.models = (await A.device.downloadedModels()).map((m) => m.spec.id).sort();
    out.toasts = toasts();
    return out;
  }, AI_PORT);
  check('ai commands enabled with a service', ai.enabled, [true, true, false, true, false]);
  check('ai: a generated picture saved as PNG carries a signed, valid C2PA manifest with the prompt, and the details show it', ai.c2pa && [ai.c2pa.checks, ai.c2pa.action, ai.c2pa.source, ai.c2pa.prompt, ai.c2pa.selfSigned, typeof ai.c2pa.info === 'string' && /^unchanged since it was signed; signed on this device \(“Anne's Lens on this device/.test(ai.c2pa.info)], [{ hash: true, assertions: true, signature: true }, 'c2pa.created', 'trainedAlgorithmicMedia', 'a bicycle', true, true], JSON.stringify(ai.c2pa));
  check('ai keys: saving a key on the web asks for a passphrase; declined, the keys are stored unencrypted and never in the settings', [ai.passDialog, ai.keysStored && ai.keysStored.mode, ai.keysStored && ai.keysStored.keys && ai.keysStored.keys.mock, ai.prefsHaveKey], ['Protect Your AI Keys', 'plain', 'k', false], JSON.stringify([ai.passDialog, ai.keysStored, ai.prefsHaveKey]));
  check('ai describe', ai.describe, 'A red rectangle on a white background.');
  check('ai alt text', ai.alt, ['A red square', 'A plain red square on a white background.']);
  check('ai keywords', ai.tags, ['sunset', 'beach', 'sea']);
  check('ai select by description', ai.box, [40, 30, 80, 60]);
  check('ai generate opens a labeled picture', [ai.gen.tabs, ai.gen.w, ai.gen.center, ai.genProv], [1, 64, [255, 220, 0], { source: true, prompt: true, provider: true }]);
  check('ai generate on this device: the license is shown before the download, the fake generator makes the picture, provenance names the device and the model', [ai.deviceHelp, ai.deviceLicense, ai.deviceGen, ai.devicePrompt, ai.deviceProv], [true, [true, true, true, 'Download and accept the license'], { loads: ['janus-pro-1b'], tabs: 1, w: 64, center: [200, 200, 40] }, 'a lighthouse', { provider: true, model: true }], JSON.stringify([ai.deviceHelp, ai.deviceLicense, ai.deviceGen, ai.devicePrompt, ai.deviceProv]));
  check('ai fill blends inside the selection', [ai.fill.size, ai.fill.inside, ai.fill.outsideWhite, ai.fill.outsideBlack, /AI edit/.test(ai.fill.name)], [[160, 120], [0, 0, 255], [255, 255, 255], [0, 0, 0], true]);
  check('ai remove background on the device', [ai.rb.subjectA, ai.rb.cornerA, ai.rb.provider], [255, 0, 'wasm']);
  check('ai erase on the device', [Math.abs(ai.erase.inside - 128) < 6, ai.erase.outside, ai.erase.black], [true, 255, 0]);
  check('ai upscale on the device', [ai.up.size, ai.up.center, ai.up.corner], [[320, 240], 255, 0]);
  check('ai depth selection', ai.depthSel, [40, 30, 80, 60]);
  check('ai search by content filters the panel to matches', [ai.search.hits >= 1 && ai.search.hits <= 4, /^[bd]-red/.test(ai.search.top || ''), ai.search.label], [true, true, 'Search: red']);
  check('ai find similar by content ranks a red picture first', [/red/.test(ai.similar[0] || ''), ai.simCur], [true, 'b-red.png']);
  check('ai block started on the subject picture', ai.first, 'a-subject.png');
  check('ai ensemble master', [ai.ensemble.text, ai.ensemble.discussion], ['Combined: a red rectangle on a white background.', true]);
  check('ai history', [ai.history.includes('ai.generate:Mock'), ai.history.includes('ai.describe:Mock (master of 2)'), ai.history.some((h) => /^ai\.upscale:this device/.test(h))], [true, true, true]);
  check('ai models cached', ai.models, ['clip-vit-b32', 'depth-anything-v2-small', 'lama', 'modnet', 'sface', 'swin2sr-x2', 'swin2sr-x4-real', 'yunet']);
  const sent = mockAi.requests;
  check('ai requests carried the picture and the key', [sent.find((r) => r.kind === 'chat')?.images, sent.find((r) => r.kind === 'chat')?.auth, sent.find((r) => r.kind === 'generate')?.prompt, sent.find((r) => r.kind === 'edit')?.hasMask, sent.filter((r) => r.kind === 'chat' && r.json).length > 0], [1, 'Bearer k', 'a bicycle', true, true]);
  if (ai.toasts.some((t) => /: the service|Could not|failed|stopped/i.test(t))) failures.push('ai toasts: ' + ai.toasts.join(' | '));

  // People: the real YuNet and SFace models on five public-domain portraits (Obama, Biden, Harris, and two of Obama
  // with Biden). Faces are found where OpenCV finds them, grouped into three people, named, opened as a folder.
  const peopleRef = JSON.parse(readFileSync('tests/fixtures/people/opencv-reference.json', 'utf8')).faces;
  const portraits = Object.fromEntries(['obama', 'biden', 'harris', 'both-2009', 'both-2012'].map((n) => [n, [...readFileSync(`tests/fixtures/people/${n}.jpg`)]]));
  const pe = await p.evaluate(async (files) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 80 && document.querySelector('.ql-dialog'); i++) await wait(50);
    qn.prefs.confirmClose = false;
    await qn.exec('file.openDropped', Object.entries(files).map(([n, b]) => new File([new Uint8Array(b)], `${n}.jpg`, { type: 'image/jpeg' }))); await wait(800);
    const disabled = qn.prefs.faces.enabled;
    await qn.exec('browse.people', { enable: true, forget: true });
    const t0 = performance.now(); const rep = await qn.exec('browse.people', { scan: 'folder' }); const ms = Math.round(performance.now() - t0);
    const again = await qn.exec('browse.people', { scan: 'folder' });
    const groups = await qn.exec('browse.people', { list: true });
    const obama = groups.findIndex((g) => g.files.includes('obama.jpg'));
    await qn.exec('browse.people', { name: { group: obama, name: 'Barack Obama', born: '1961' } });
    const named = await qn.exec('browse.people', { list: true });
    const opened = await qn.exec('browse.people', { open: 0 }); await wait(300);
    const folder = [qn.folder.name, qn.folder.entries.map((e) => e.name).sort()];
    // The window: one card per person, the named one first.
    const run = qn.exec('browse.people');
    let dlg; for (let i = 0; i < 60 && !(dlg = [...document.querySelectorAll('.ql-dialog')].find((d) => d.getAttribute('aria-label') === 'People')); i++) await wait(50);
    const cards = [...dlg.querySelectorAll('.qn-person')].map((c) => [c.querySelector('b').textContent, c.querySelector('img') ? 'img' : 'none']);
    dlg.querySelector('.ql-primary').click(); await run;
    return { disabled, rep, ms, again: [again.pictures, again.skipped], faces: groups.flatMap((g) => g.files.map((f, i) => [f, g.boxes[i]])), groups: groups.map((g) => [g.files.slice().sort(), g.boxes, g.scores]), named: named.map((g) => [g.name, g.named, g.files.length]), opened, folder, cards };
  }, portraits);
  const sortedGroups = pe.groups.map((g) => g[0].join(',')).sort();
  check('people: off until turned on; five portraits scanned, seven faces, nothing scanned twice', [pe.disabled, pe.rep.pictures, pe.rep.faces, pe.rep.failed, pe.again], [false, 5, 7, [], [0, 5]], JSON.stringify(pe));
  check('people: grouped into Biden, Obama and Harris', sortedGroups, ['biden.jpg,both-2009.jpg,both-2012.jpg', 'both-2009.jpg,both-2012.jpg,obama.jpg', 'harris.jpg'], JSON.stringify(pe.groups));
  // Each face found where OpenCV finds it (box corners within 4% of the picture's long side, 480 px).
  let worst = 0; for (const [file, b] of pe.faces) { const best = Math.min(...peopleRef.filter((r) => r.file === file).map((r) => Math.max(...r.box.map((v, k) => Math.abs(v - b[k]))))); worst = Math.max(worst, best); }
  check('people: boxes agree with OpenCV\'s FaceDetectorYN (within 4% of the long side)', [pe.faces.length, worst <= 19], [7, true], `worst ${worst} px`);
  check('people: a named person comes first and opens as a folder', [pe.named[0], pe.opened, pe.folder, pe.cards.length, pe.cards[0]], [['Barack Obama', true, 3], 3, ['People: Barack Obama (3 pictures)', ['both-2009.jpg', 'both-2012.jpg', 'obama.jpg']], 3, ['Barack Obama', 'img']], JSON.stringify(pe));

  // Suite hand-offs: a JPEG with an embedded caption, alt text and title goes to Anne's Pen (DOCX),
  // Stage (PPTX) and Folio (PDF); in a browser each is saved (the Android app opens the suite app).
  // The files are checked with python-docx / python-pptx and pdfinfo when present.
  const hand = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 80 && document.querySelector('.ql-dialog'); i++) await wait(50);
    const M = await window.__qnMeta();
    const c = document.createElement('canvas'); c.width = 400; c.height = 300; const x = c.getContext('2d'); x.fillStyle = '#c03030'; x.fillRect(0, 0, 400, 300);
    const jpg = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9))).arrayBuffer());
    const xmp = new TextEncoder().encode(M.updateXmp(null, { description: 'Grandma & the barn, 1952', altText: 'A red barn', title: 'Barn' }));
    const tagged = M.injectMeta(jpg, 'jpeg', { xmp });
    c.width = 200; c.height = 300; c.getContext('2d').fillStyle = '#3030c0'; c.getContext('2d').fillRect(0, 0, 200, 300);
    const png = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
    await qn.exec('file.openDropped', [new File([tagged], 'h1-barn.jpg', { type: 'image/jpeg' }), new File([png], 'h2-blue.png', { type: 'image/png' })]);
    for (let i = 0; i < 60 && qn.picture?.name !== 'h1-barn.jpg'; i++) await wait(50); await wait(250);
    const saved = []; const picker = window.showSaveFilePicker;
    window.showSaveFilePicker = async (o) => { const rec = { name: o?.suggestedName || '', parts: [] }; saved.push(rec); return { name: rec.name, createWritable: async () => ({ write: async (b) => { rec.parts.push(b); }, close: async () => {} }) }; };
    const seen = []; new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.classList?.contains('ql-toast')) seen.push(n.textContent); }).observe(document.body, { childList: true, subtree: true });
    await qn.exec('file.export.pen', { number: true, paper: 'letter' }); await wait(200);
    qn.tab.marked.clear(); for (const e of qn.folder.entries) qn.tab.marked.add(e);
    await qn.exec('file.export.stage', { titles: true }); await wait(200);
    await qn.exec('file.export.folio', { paper: 'letter', captions: true }); await wait(200);
    await qn.exec('file.export.press', { size: 'letter', perPage: 1, captions: true }); await wait(200);
    await qn.exec('create.photoBook', { size: 'square8', perPage: 1, captions: true, title: 'Family Book', facing: true }); await wait(200);
    qn.tab.marked.clear();
    window.showSaveFilePicker = picker;
    const b64 = async (rec) => { const u8 = new Uint8Array(await new Blob(rec.parts).arrayBuffer()); let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
    return { folder: qn.folder.name || 'Pictures', names: saved.map((r) => r.name), files: await Promise.all(saved.map(b64)), toast: seen.find((t) => /works in the Android app/.test(t)) || null };
  });
  check('suite hand-offs save a DOCX, a PPTX, a PDF and two IDML files in the browser', [hand.names, !!hand.toast], [['h1-barn.docx', `${hand.folder}.pptx`, `${hand.folder}.pdf`, `${hand.folder}.idml`, 'Family Book (photo book).idml'], true], JSON.stringify(hand.names));
  {
    const { execFileSync } = await import('node:child_process');
    const { writeFileSync, mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(`${tmpdir()}/qn-suite-`);
    ['h.docx', 'h.pptx', 'h.pdf'].forEach((n, i) => hand.files[i] && writeFileSync(`${dir}/${n}`, Buffer.from(hand.files[i], 'base64')));
    let py = '';
    try { py = execFileSync('python3', ['-c', `import docx, pptx, zipfile, re, json
d = docx.Document('${dir}/h.docx'); x = zipfile.ZipFile('${dir}/h.docx').read('word/document.xml').decode()
p = pptx.Presentation('${dir}/h.pptx')
print(json.dumps({'caption': [q.text for q in d.paragraphs if q.style.name == 'Caption'], 'docPr': re.findall(r'descr="([^"]*)" title="([^"]*)"', x), 'shapes': len(d.inline_shapes), 'slides': [[s.shapes.title.text if s.shapes.title else None, [sh._element.nvPicPr.cNvPr.get('descr') for sh in s.shapes if sh.shape_type == 13]] for s in p.slides]}))`], { encoding: 'utf8' }); } catch (e) { py = ''; }
    if (py) {
      const r = JSON.parse(py);
      check('Pen document: picture, alt text and title, numbered caption', [r.shapes, r.docPr, r.caption.map((t) => t.replace(/^Figure\s*\d*:\s*/, ''))], [1, [['A red barn', 'Barn']], ['Grandma & the barn, 1952']]);
      check('Stage deck: one slide per picture, caption as title, alt text kept', r.slides, [['Grandma & the barn, 1952', ['A red barn']], [null, ['']]]);
    }
    let info = ''; try { info = execFileSync('pdfinfo', [`${dir}/h.pdf`], { encoding: 'utf8' }); } catch { info = ''; }
    ['h-press.idml', 'h-book.idml'].forEach((n, i) => hand.files[3 + i] && writeFileSync(`${dir}/${n}`, Buffer.from(hand.files[3 + i], 'base64')));
    let hasScribus = false; try { execFileSync('which', ['scribus', 'xvfb-run']); hasScribus = true; } catch { /* not installed */ }
    if (hasScribus) {
      const sc = (n) => { try { execFileSync('xvfb-run', ['-a', 'scribus', '-g', '-ns', '-py', 'tests/e2e/scribus-check.py', `${dir}/${n}`], { timeout: 120000, stdio: 'ignore' }); return JSON.parse(readFileSync(`${dir}/${n}.json`, 'utf8')); } catch (e) { return { error: String(e).slice(0, 200) }; } };
      const press = sc('h-press.idml'), book = sc('h-book.idml');
      check('Press IDML opens in Scribus: a letter page per picture, both pictures loaded, the caption', [press.pages, press.size, press.images?.map((x) => x[1]), press.texts], [2, [216, 279], [true, true], [[1, 'Grandma & the barn, 1952']]], JSON.stringify(press));
      check('Photo book IDML opens in Scribus: title page, then the pictures, 8 × 8 in', [book.pages, book.size, book.images?.map((x) => x[0]), book.texts[0]], [3, [203, 203], [2, 3], [1, 'Family Book']], JSON.stringify(book));
    }
    if (info) check('Folio PDF: a letter page per picture (landscape for the wide one)', [+(info.match(/^Pages:\s+(\d+)/m) || [])[1], /792 x 612/.test(info)], [2, true], info);
  }

  // Customize Menus: a built-in layout is copied, a command and a separator are added to its first
  // menu, and the copy becomes the menu bar.
  const cm2 = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 80 && document.querySelector('.ql-dialog'); i++) await wait(50);
    qn.prefs.menuStyle = 'both'; qn.prefs.menuLayout = 'irfanview'; qn.savePrefs(); qn.ui.applyPrefs();
    const run = qn.exec('file.customizeMenus'); let dlg; for (let i = 0; i < 60 && !(dlg = [...document.querySelectorAll('.ql-dialog')].find((d) => /Customize Menus/.test(d.textContent))); i++) await wait(50);
    const btn = (label) => [...dlg.querySelectorAll('button')].find((b) => (b.querySelector('.ql-cust-btn-label')?.textContent || b.textContent).trim() === label);
    dlg.querySelector('.qn-menu-tree .ql-group-row').click(); await wait(50);
    const cats = dlg.querySelector('.ql-cust-col select'); cats.value = 'all'; cats.dispatchEvent(new Event('change')); await wait(50);
    const filter = dlg.querySelector('input[placeholder="Filter commands…"]'); filter.value = 'rotate right'; filter.dispatchEvent(new Event('input')); await wait(50);
    [...dlg.querySelectorAll('.ql-cust-col')][0].querySelector('.ql-cmdlist-row').click(); await wait(30);
    btn('Add').click(); await wait(50); btn('Separator').click(); await wait(50);
    const rows = [...dlg.querySelectorAll('.qn-menu-tree .ql-cmdlist-row')].map((r) => r.textContent.trim());
    const layoutName = dlg.querySelector('.qn-menu-layout').selectedOptions[0].textContent;
    dlg.querySelector('.ql-primary').click(); await run; await wait(150);
    const first = document.querySelector('.ql-menubar .ql-menubar-item'); first.click(); await wait(150);
    const menuItems = [...document.querySelectorAll('.ql-menu .ql-menu-item, .ql-menu [role=menuitem]')].map((m) => m.textContent.trim());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(50);
    const out = { layoutName, rowsHasRotate: rows.some((t) => t.endsWith('Rotate Right')), pref: qn.prefs.menuLayout.startsWith('custom-'), saved: qn.prefs.customMenus.map((l) => l.name), lastItems: qn.prefs.customMenus[0]?.menus[0].items.slice(-2), menuHasRotate: menuItems.some((t) => /Rotate Right/.test(t)) };
    qn.prefs.menuLayout = 'irfanview'; qn.savePrefs(); qn.ui.applyPrefs();
    return out;
  });
  check('customize menus: an edited copy of a built-in layout becomes the menu bar', cm2, { layoutName: 'IrfanView style (mine)', rowsHasRotate: true, pref: true, saved: ['IrfanView style (mine)'], lastItems: ['image.rotateRight', '|'], menuHasRotate: true }, JSON.stringify(cm2));

  // The Browser window: Folder Tree (click and expand), Browser layout (F3), Include Subfolders and
  // Show All Files on a File System Access tree.
  const bw = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 80 && document.querySelector('.ql-dialog'); i++) await wait(50);
    const png = async (color) => { const c = document.createElement('canvas'); c.width = 8; c.height = 8; const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, 8, 8); return new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer()); };
    const file = (name, bytes, type = 'image/png') => { const f = { kind: 'file', name, isSameEntry: async (o) => o === f, getFile: async () => new File([bytes], name, { type }) }; return f; };
    const dir = (name, kids) => { const d = { kind: 'directory', name, isSameEntry: async (o) => o === d, entries: async function* () { for (const k of kids) yield [k.name, k]; } }; return d; };
    const lib = dir('Library', [file('a.png', await png('#f00')), file('notes.txt', new TextEncoder().encode('hello'), 'text/plain'), dir('Kids', [file('b.png', await png('#0f0')), file('c.png', await png('#00f')), dir('Party', [file('d.png', await png('#ff0'))])])]);
    const picker = window.showDirectoryPicker; window.showDirectoryPicker = async () => lib;
    await qn.exec('file.openFolder'); window.showDirectoryPicker = picker;
    for (let i = 0; i < 60 && qn.folder.name !== 'Library'; i++) await wait(50); await wait(250);
    const rows = () => [...document.querySelectorAll('.qn-window-active .qn-tree-body .qn-tree-row, .qn-window .qn-tree-body .qn-tree-row')].map((r) => r.textContent.replace(/^[▸▾]/, '').replace(/^(folder_open|folder)/, '').trim());
    const row = (name) => [...document.querySelectorAll('.qn-tree-body .qn-tree-row')].find((r) => r.textContent.endsWith(name));
    const out = { start: [qn.folder.name, qn.folder.length] };
    await qn.exec('browse.folderTree'); for (let i = 0; i < 40 && rows().length < 2; i++) await wait(50);
    out.tree = rows(); out.treeShown = !!document.querySelector('.qn-window.qn-has-tree .qn-tree');
    row('Kids').click(); for (let i = 0; i < 60 && qn.folder.name !== 'Kids'; i++) await wait(50); await wait(250);
    out.kids = [qn.folder.name, qn.folder.length, document.querySelector('.qn-tree-row.ql-sel')?.textContent.endsWith('Kids')];
    row('Kids').querySelector('.qn-tree-toggle').click(); for (let i = 0; i < 40 && !row('Party'); i++) await wait(50);
    row('Party').click(); for (let i = 0; i < 60 && qn.folder.name !== 'Party'; i++) await wait(50); await wait(250);
    out.party = [qn.folder.name, qn.folder.length, rows()];
    await qn.exec('browse.browser'); await wait(250);
    const win = document.querySelector('.qn-window'); out.browser = [win.classList.contains('qn-window-browser'), qn.tab.thumbs.open && qn.tab.thumbs.mode, getComputedStyle(win.querySelector('.qn-viewer')).display !== 'none', getComputedStyle(win.querySelector('.qn-tree')).display !== 'none'];
    row('Library').click(); for (let i = 0; i < 60 && qn.folder.name !== 'Library'; i++) await wait(50); await wait(250);
    await qn.exec('browse.recursive'); for (let i = 0; i < 60 && !/with subfolders/.test(qn.folder.name); i++) await wait(50); await wait(250);
    out.recursive = [qn.folder.name, qn.folder.entries.map((e) => e.name)];
    await qn.exec('browse.recursive'); await wait(300); out.flat = [qn.folder.name, qn.folder.length];
    await qn.exec('browse.showAllFiles'); for (let i = 0; i < 60 && qn.folder.length < 2; i++) await wait(50); await wait(400);
    out.all = [qn.folder.entries.map((e) => e.name), !!document.querySelector('.qn-thumb .qn-thumb-file')];
    await qn.exec('browse.showAllFiles'); await wait(300); out.pictures = qn.folder.entries.map((e) => e.name);
    return out;
  });
  check('folder tree: the opened folder and its subfolders; click opens, the branch expands', [bw.start, bw.treeShown, bw.tree, bw.kids, bw.party], [['Library', 1], true, ['Library', 'Kids'], ['Kids', 2, true], ['Party', 1, ['Library', 'Kids', 'Party']]], JSON.stringify(bw));
  check('browser layout: tree, thumbnail grid and preview together', bw.browser, [true, 'grid', true, true]);
  check('include subfolders lists the whole tree, depth first', [bw.recursive, bw.flat], [['Library (with subfolders)', ['a.png', 'b.png', 'c.png', 'd.png']], ['Library', 1]]);
  check('show all files lists other files with an icon', [bw.all, bw.pictures], [[['a.png', 'notes.txt'], true], ['a.png']]);
  await p.keyboard.press('F3'); await p.waitForTimeout(200);
  check('F3 toggles the Browser off', await p.evaluate(() => [qn.prefs.browserLayout, document.querySelector('.qn-window').classList.contains('qn-window-browser')]), [false, false]);
  await p.evaluate(async () => { if (qn.prefs.folderTree) await qn.exec('browse.folderTree'); });

  // View ▸ Language: the built-in Spanish table (ribbon, menu bar, tooltips' names), a table loaded
  // from a file, and one translated by the (mock) AI service in batches; back to English.
  const lang = await p.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 80 && document.querySelector('.ql-dialog'); i++) await wait(50);
    const tabs = () => [...document.querySelectorAll('.ql-tabs .ql-tab')].map((b) => b.textContent.trim());
    const menus = () => [...document.querySelectorAll('.ql-menubar .ql-menubar-item')].map((b) => b.textContent.trim());
    const out = {};
    await qn.exec('view.language', 'es'); await wait(150);
    out.es = { tabs: tabs().slice(0, 4), menus: menus().slice(0, 2), label: window.__qnGetCommand('image.rotateRight').label, pref: qn.prefs.language, lang: document.documentElement.lang };
    // The dialog lists the languages with their coverage; choosing English there switches back.
    const run = qn.exec('view.language'); let d; for (let i = 0; i < 60 && !(d = document.querySelector('.ql-dialog .ql-primary')); i++) await wait(50);
    const dlg = document.querySelector('.ql-dialog');
    out.listed = [...dlg.querySelectorAll('option, [role=option], .ql-listbox *')].map((o) => o.textContent).filter((t) => /Español|English/.test(t)).slice(0, 2);
    const list = dlg.querySelector('[id^="f_lang_"]'); if (list.tagName === 'SELECT') { list.value = 'en-US'; list.dispatchEvent(new Event('change', { bubbles: true })); } else { const opt = [...list.querySelectorAll('[data-value]')].find((o) => o.dataset.value === 'en-US'); opt?.click(); }
    d.click(); await run; await wait(150);
    out.en = { tabs: tabs().slice(0, 2), pref: qn.prefs.language };
    const de = { format: 'annes-lens-strings', version: 1, language: 'de', name: 'Deutsch', labels: { 'file.open': 'Öffnen…', 'view.fullScreen': 'Vollbild' }, tabs: { File: 'Datei', View: 'Ansicht' } };
    await qn.exec('view.language', { action: 'load', files: [new File([JSON.stringify(de)], 'de.json', { type: 'application/json' })] }); await wait(150);
    out.de = { tabs: tabs().slice(0, 1), label: window.__qnGetCommand('file.open').label, untranslated: window.__qnGetCommand('file.save').label };
    await qn.exec('view.language', { action: 'ai', code: 'fr', name: 'Français' });
    for (let i = 0; i < 200 && qn.prefs.language !== 'fr'; i++) await wait(50); await wait(150);
    out.ai = { pref: qn.prefs.language, label: window.__qnGetCommand('file.open').label, tab: tabs()[1], menu: menus()[0] };
    await qn.exec('view.language', 'en-US'); await wait(150);
    out.back = [window.__qnGetCommand('file.open').label, tabs()[0], menus()[0]];
    return out;
  });
  check('language: built-in Spanish on the ribbon and menus', lang.es, { tabs: ['Archivo', 'Inicio', 'Archivo', 'Edición'], menus: ['Archivo', 'Edición'], label: 'Girar a la derecha', pref: 'es', lang: 'es' }, JSON.stringify(lang.es));
  check('language: the dialog lists the languages and switches back to English', [lang.listed.length, lang.en], [2, { tabs: ['File', 'Home'], pref: 'en-US' }], JSON.stringify(lang.listed));
  check('language: a loaded table (English where it has no entry)', lang.de, { tabs: ['Datei'], label: 'Öffnen…', untranslated: 'Save' });
  const langReqs = mockAi.requests.filter((r) => /STRINGS:|user interfaces/.test(r.text + r.system));
  check('language: AI translation in batches applies and switches', [lang.ai, langReqs.length >= 7, lang.back], [{ pref: 'fr', label: '[de] Open…', tab: '[de] Home', menu: '[de] File' }, true, ['Open…', 'File', 'File']], `${langReqs.length} requests`);

  // Albums with real File System Access handles (the origin-private file system stands in for a
  // picked folder): Add to Album, open it, a smart album from the Filter Bar, Search by Sketch, and
  // the album still opening after a page reload (handles kept in IndexedDB).
  // Its own persistent profile: headless Chromium's default (incognito-like) context crashes when a
  // file handle is stored in IndexedDB, which normal browser profiles do routinely.
  const { mkdtempSync: mkdtempA } = await import('node:fs'); const { tmpdir: tmpA } = await import('node:os');
  const pctx = await chromium.launchPersistentContext(mkdtempA(`${tmpA()}/qn-albums-`), exe);
  const pa = await pctx.newPage();
  await pa.addInitScript(() => { if (!localStorage.getItem('quilllens.prefs.v1')) localStorage.setItem('quilllens.prefs.v1', JSON.stringify({ firstRun: false })); });
  await pa.goto(url); await pa.waitForFunction(() => window.qn && window.__qnGetCommand, null, { timeout: 30000 }); await pa.waitForTimeout(400);
  const alb = await pa.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 80 && document.querySelector('.ql-dialog'); i++) await wait(50);
    const root = await navigator.storage.getDirectory(); const dir = await root.getDirectoryHandle('Trip 2024', { create: true });
    const paint = async (name, top, bottom) => { const c = document.createElement('canvas'); c.width = 96; c.height = 72; const x = c.getContext('2d'); x.fillStyle = top; x.fillRect(0, 0, 96, 36); x.fillStyle = bottom; x.fillRect(0, 36, 96, 36); const fh = await dir.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(await new Promise((r) => c.toBlob(r, 'image/png'))); await w.close(); };
    await paint('a-landscape.png', '#4682dc', '#328c3c'); await paint('b-beach.png', '#4682dc', '#dcc88c'); await paint('c-night.png', '#0f0f1e', '#0f0f1e');
    const picker = window.showDirectoryPicker; window.showDirectoryPicker = async () => dir;
    await qn.exec('file.openFolder'); for (let i = 0; i < 60 && qn.folder.name !== 'Trip 2024'; i++) await wait(50); await wait(300);
    window.showDirectoryPicker = picker;
    const out = { folder: [qn.folder.name, qn.folder.length] };
    const t = qn.tab; t.marked.clear(); for (const e of qn.folder.entries.filter((e) => /landscape|beach/.test(e.name))) t.marked.add(e);
    await qn.exec('browse.addToAlbum', { album: '', name: 'Seaside and hills' }); await wait(150);
    t.marked.clear();
    await qn.exec('browse.albums', 'Seaside and hills'); await wait(400);
    out.album = [qn.folder.name, qn.folder.entries.map((e) => e.name), qn.picture?.name];
    await qn.exec('browse.addToAlbum', { album: 'Seaside and hills' }); await wait(150); // the shown picture again: a duplicate
    // Favorite Folders: the picked folder is added, listed in the tree, and opened from there.
    window.showDirectoryPicker = async () => dir; await qn.exec('file.openFolder'); window.showDirectoryPicker = picker;
    for (let i = 0; i < 60 && qn.folder.name !== 'Trip 2024'; i++) await wait(50); await wait(200);
    await qn.exec('browse.favorites', 'add'); await qn.exec('browse.favorites', 'add'); await wait(100);
    await qn.exec('browse.folderTree'); await wait(400);
    out.favRows = [...document.querySelectorAll('.qn-tree-favs .qn-tree-row')].map((r) => r.textContent.replace(/^folder_special/, ''));
    await qn.exec('browse.folderTree');
    // Smart album: back in the folder, filter by name, save, clear, re-apply.
    window.showDirectoryPicker = async () => dir; await qn.exec('file.openFolder'); window.showDirectoryPicker = picker;
    for (let i = 0; i < 60 && qn.folder.name !== 'Trip 2024'; i++) await wait(50); await wait(300);
    for (let i = 0; i < 80 && document.querySelector('.ql-dialog'); i++) await wait(50);
    const run = qn.exec('browse.filter'); let d; for (let i = 0; i < 60 && !(d = document.querySelector('.ql-dialog .ql-primary')); i++) await wait(50);
    const txt = document.querySelector('.ql-dialog [id^="f_text_"]'); txt.value = 'beach'; txt.dispatchEvent(new Event('input', { bubbles: true }));
    d.click(); await run; await wait(200);
    await qn.exec('browse.smartAlbum', { save: 'Beaches' }); await wait(100);
    qn.tab.thumbs.filter = null; qn.tab.thumbs.refilter();
    await qn.exec('browse.smartAlbum', 'Beaches'); await wait(200);
    out.smart = [qn.tab.thumbs.filterLabel, qn.folder.entries.filter((e) => qn.tab.thumbs.filter?.(e)).map((e) => e.name)];
    qn.tab.thumbs.filter = null; qn.tab.thumbs.refilter();
    // Search by Sketch: blue on top, green below.
    const sk = document.createElement('canvas'); sk.width = 240; sk.height = 180; const sx = sk.getContext('2d'); sx.fillStyle = '#3c7dd7'; sx.fillRect(0, 0, 240, 60); sx.fillStyle = '#2d913a'; sx.fillRect(0, 120, 240, 60);
    const raster = { width: 240, height: 180, data: sx.getImageData(0, 0, 240, 180).data };
    const top = await qn.exec('browse.searchSketch', raster); await wait(200);
    out.sketch = { order: top.map((x) => x.entry.name), label: qn.tab.thumbs.filterLabel, shown: qn.picture?.name };
    qn.tab.thumbs.filter = null; qn.tab.thumbs.refilter();
    return out;
  });
  check('albums: add the marked pictures, open the album as a folder', [alb.folder, alb.album], [['Trip 2024', 3], ['Album: Seaside and hills', ['a-landscape.png', 'b-beach.png'], 'a-landscape.png']], JSON.stringify(alb));
  check('smart album: a saved Filter Bar filter re-applied', alb.smart, ['Smart album: Beaches', ['b-beach.png']]);
  check('search by sketch: blue over green finds the landscape first, the night picture last', [alb.sketch.order, alb.sketch.label, alb.sketch.shown], [['a-landscape.png', 'b-beach.png', 'c-night.png'], 'Sketch: 3 closest', 'a-landscape.png']);
  await pa.reload(); await pa.waitForFunction(() => window.qn && window.__qnGetCommand, null, { timeout: 30000 }); await pa.waitForTimeout(500);
  const alb2 = await pa.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 80 && document.querySelector('.ql-dialog'); i++) await wait(50);
    await qn.exec('browse.albums', 'Seaside and hills'); for (let i = 0; i < 60 && !qn.picture; i++) await wait(50); await wait(300);
    const albumState = { folder: qn.folder.name, names: qn.folder.entries.map((e) => e.name) };
    await qn.exec('browse.favorites', 0); for (let i = 0; i < 60 && qn.folder.name !== 'Trip 2024'; i++) await wait(50); await wait(300);
    const favOpened = [qn.folder.name, qn.folder.length];
    await qn.exec('browse.albums', 'Seaside and hills'); for (let i = 0; i < 60 && qn.folder.name !== 'Album: Seaside and hills'; i++) await wait(50); await wait(300);
    const px = qn.picture ? [...qn.picture.frameCanvas().getContext('2d').getImageData(10, 60, 1, 1).data].slice(0, 3) : null;
    return { folder: qn.folder.name, names: qn.folder.entries.map((e) => e.name), px, favOpened, albumState };
  });
  check('albums survive a reload (handles kept in IndexedDB)', { folder: alb2.folder, names: alb2.names, px: alb2.px }, { folder: 'Album: Seaside and hills', names: ['a-landscape.png', 'b-beach.png'], px: [50, 140, 60] });
  check('favorite folders: added once, shown in the tree, open after a reload', [alb.favRows, alb2.favOpened], [['Trip 2024'], ['Trip 2024', 3]]);

  // The catalog: a folder with a subfolder (a sidecar gives one picture 4 stars) is cataloged; the
  // catalog view shows both with stored facts and thumbnails; a smart album searches the whole
  // catalog; a new picture is picked up by a rescan; maintenance drops a deleted one and lists
  // orphaned sidecars; a watch adds a new picture to the catalog, another copies one into a folder;
  // after a reload the catalog and the watches are still there.
  const cat = await pa.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 80 && document.querySelector('.ql-dialog'); i++) await wait(50);
    const N = await window.__qnNative();
    const root = await navigator.storage.getDirectory(), lib = await root.getDirectoryHandle('Library 2', { create: true }), kids = await lib.getDirectoryHandle('Kids', { create: true }), outDir = await root.getDirectoryHandle('Out', { create: true });
    const put = async (dir, name, data) => { const fh = await dir.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(data); await w.close(); };
    const png = async (color) => { const c = document.createElement('canvas'); c.width = 40; c.height = 30; const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, 40, 30); return await new Promise((r) => c.toBlob(r, 'image/png')); };
    await put(lib, 'a.png', await png('#c00')); await put(kids, 'b.png', await png('#0c0'));
    await put(kids, 'b.xmp', '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="4"/></rdf:RDF></x:xmpmeta>');
    await put(lib, 'gone.xmp', '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>');
    const picker = window.showDirectoryPicker; window.showDirectoryPicker = async () => lib; await qn.exec('file.openFolder'); window.showDirectoryPicker = picker;
    for (let i = 0; i < 60 && qn.folder.name !== 'Library 2'; i++) await wait(50); await wait(200);
    const out = {};
    const added = await qn.exec('browse.folderManager', { add: true, subfolders: true });
    out.added = [added.added, added.orphans];
    await qn.exec('browse.catalog'); for (let i = 0; i < 60 && !/^Catalog/.test(qn.folder.name); i++) await wait(50); await wait(400);
    out.view = [qn.prefs.useCatalog, qn.folder.name, qn.folder.entries.map((e) => e.name).sort(), qn.folder.entries.every((e) => !!e.catalogKey)];
    for (let i = 0; i < 40 && document.querySelectorAll('.qn-thumbs .qn-thumb-pic canvas').length < 2; i++) await wait(50);
    out.thumbs = document.querySelectorAll('.qn-thumbs .qn-thumb-pic canvas').length;
    // A smart album over the whole catalog: rating 4 or more.
    const run = qn.exec('browse.filter'); let d; for (let i = 0; i < 60 && !(d = document.querySelector('.ql-dialog .ql-primary')); i++) await wait(50);
    const sel = document.querySelector('.ql-dialog [id^="f_minRating_"]'); sel.value = '4'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    d.click(); await run; await wait(200);
    await qn.exec('browse.smartAlbum', { save: 'Four stars' }); qn.tab.thumbs.filter = null; qn.tab.thumbs.refilter();
    window.showDirectoryPicker = async () => lib; await qn.exec('file.openFolder'); window.showDirectoryPicker = picker; await wait(300);
    await qn.exec('browse.smartAlbum', 'Four stars'); await wait(400);
    out.smart = [qn.folder.name.startsWith('Catalog'), qn.tab.thumbs.filterLabel, qn.folder.entries.filter((e) => qn.tab.thumbs.filter?.(e)).map((e) => e.name)];
    qn.tab.thumbs.filter = null; qn.tab.thumbs.refilter();
    // A new picture, a rescan; then a deleted one and maintenance.
    await put(lib, 'c.png', await png('#00c'));
    const rescan = await qn.exec('browse.folderManager', { rescan: 'all' }); out.rescan = rescan;
    await lib.removeEntry('a.png');
    const mrun = qn.exec('browse.maintenance', { reread: false, thumbs: false }); let md; for (let i = 0; i < 100 && !(md = [...document.querySelectorAll('.ql-dialog')].find((x) => /Orphaned|orphaned/.test(x.textContent))); i++) await wait(100);
    out.maint = md ? md.querySelector('pre').textContent : null; [...md.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Close').click(); await mrun;
    // Watches: one into the catalog, one copying into Out.
    window.showDirectoryPicker = async () => lib; await qn.exec('file.openFolder'); window.showDirectoryPicker = picker;
    for (let i = 0; i < 60 && qn.folder.name !== 'Library 2'; i++) await wait(50); await wait(200);
    const w1 = await qn.exec('browse.watchFolder', { add: 'catalog' });
    const w2 = await qn.exec('browse.watchFolder', { add: 'copy', dest: { uri: 'fsadir:' + (await N.handleId(outDir)), name: 'Out' } });
    out.watchKnown = [w1.known.length, w2.known.length];
    await put(lib, 'd.png', await png('#cc0'));
    out.tick0 = await qn.exec('browse.watchFolder', 'tick'); // first sight: it may still be being written (D11)
    out.tick = await qn.exec('browse.watchFolder', 'tick'); // the same size again: handled
    out.copied = []; for await (const [n] of outDir.entries()) out.copied.push(n);
    out.tick2 = await qn.exec('browse.watchFolder', 'tick');
    await qn.exec('browse.catalog', 'open'); await wait(300);
    out.afterWatch = qn.folder.entries.map((e) => e.name).sort();
    for (let i = 0; i < 80 && document.querySelector('.ql-dialog'); i++) await wait(50);
    return out;
  });
  check('catalog: a folder with its subfolder cataloged, orphaned sidecar seen', cat.added, [2, ['gone.xmp']], JSON.stringify(cat));
  check('catalog view: every picture, stored facts and thumbnails', [cat.view, cat.thumbs >= 2], [[true, 'Catalog (2 pictures)', ['a.png', 'b.png'], true], true]);
  check('smart album over the whole catalog (a rating from a sidecar)', cat.smart, [true, 'Smart album: Four stars', ['b.png']]);
  check('rescan picks up a new picture; maintenance drops a deleted one and lists orphaned sidecars', [cat.rescan.length, /1 added/.test(cat.rescan[0]), /1 removed/.test(cat.maint || ''), /Library 2\/gone\.xmp/.test(cat.maint || '')], [1, true, true, true], cat.maint);
  check('watch folders: a new picture goes into the catalog and is copied once its size has settled; nothing twice', [cat.watchKnown, cat.tick0, cat.tick, cat.copied, cat.tick2, cat.afterWatch], [[1, 1], 0, 2, ['d.png'], 0, ['b.png', 'c.png', 'd.png']]);
  await pa.reload(); await pa.waitForFunction(() => window.qn && window.__qnGetCommand, null, { timeout: 30000 }); await pa.waitForTimeout(500);
  const cat2 = await pa.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 80 && document.querySelector('.ql-dialog'); i++) await wait(50);
    await qn.exec('browse.catalog', 'open'); for (let i = 0; i < 60 && !/^Catalog/.test(qn.folder.name); i++) await wait(50); await wait(300);
    const out = { view: [qn.folder.name, qn.prefs.useCatalog], picture: qn.picture?.name };
    return out;
  });
  check('catalog and its setting survive a reload', cat2, { view: ['Catalog (3 pictures)', true], picture: 'b.png' });

  // Tools: a web External Tool (and one this picture cannot fill), a script plug-in run as a command
  // (one Undo step; gone when disabled), the components with their versions, and Back Up Library of
  // the catalog with the library JSON, twice (the second copies nothing).
  const tools = await pa.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 80 && document.querySelector('.ql-dialog'); i++) await wait(50);
    const N = await window.__qnNative(), out = {};
    const opened = []; const ow = window.open; window.open = (u) => { opened.push(String(u)); return null; };
    const t1 = await qn.exec('tools.external', { add: 'web', name: 'Search the name', url: 'https://example.org/search?q={name}' });
    const t2 = await qn.exec('tools.external', { add: 'web', name: 'Map', url: 'https://osm.example/?{lat},{lon}' });
    await qn.exec('tool:' + t1.id); await qn.exec('tool:' + t2.id); await wait(100);
    window.open = ow;
    out.tools = [opened, window.__qnGetCommand('tool:' + t1.id)?.label, qn.picture.name];
    const px = () => [...qn.picture.frameCanvas().getContext('2d').getImageData(5, 5, 1, 1).data].slice(0, 3);
    const p = await qn.exec('tools.plugins', { add: { name: 'Halve green', code: 'const p = await picture.pixels(); for (let i = 0; i < p.data.length; i += 4) p.data[i + 1] = p.data[i + 1] >> 1; await picture.setPixels(p, "Halve green"); print("done", p.width);' } });
    const before = px(); await qn.exec('plugin:' + p.id); await wait(200);
    out.plugin = [before, px(), qn.tab.undoLabel];
    qn.tab.undo(); await qn.exec('tools.plugins', { toggle: p.id });
    out.disabled = window.__qnGetCommand('plugin:' + p.id) === undefined;
    const list = await qn.exec('tools.plugins', 'list');
    out.comps = [list.comps.length, /ONNX Runtime Web 1\.31\.1/.test(list.comps[0]), /Tesseract 7\.0\.0/.test(list.comps[1]), /Español/.test(list.comps[3])];
    // Back Up Library.
    const root = await navigator.storage.getDirectory(), dest = await root.getDirectoryHandle('Backups', { create: true });
    const destRef = { uri: 'fsadir:' + (await N.handleId(dest)), name: 'Backups' };
    const r1 = await qn.exec('tools.backup', { dest: destRef, library: true }), r2 = await qn.exec('tools.backup', { dest: destRef, library: true });
    out.backup = [r1.copied, r1.skipped, r2.copied, r2.skipped, r1.library];
    const tree = []; const walk = async (d, pre) => { for await (const [n, hh] of d.entries()) { if (hh.kind === 'directory') await walk(hh, pre + n + '/'); else tree.push(pre + n); } };
    await walk(dest, ''); out.tree = tree.sort();
    const lib = JSON.parse(await (await (await (await dest.getDirectoryHandle("Anne's Lens backup")).getFileHandle('annes-lens-library.json')).getFile()).text());
    out.lib = [lib.kind, lib.catalog.length, lib.catalog[0].items.length, Array.isArray(lib.albums), !!lib.prefs, lib.watches.length];
    return out;
  });
  check('external tools: a web address filled from the picture; one needing a location refuses', tools.tools, [[`https://example.org/search?q=${tools.tools[2]}`], 'Search the name', tools.tools[2]], JSON.stringify(tools));
  check('script plug-in runs as a command (one Undo step) and is gone when disabled', [tools.plugin[0][1] > 100, tools.plugin[1][1] === tools.plugin[0][1] >> 1, tools.plugin[2], tools.disabled], [true, true, 'Halve green', true], JSON.stringify(tools.plugin));
  check('plug-ins lists the components with their versions', tools.comps, [4, true, true, true]);
  check('back up library: pictures and sidecars of the catalog, the library JSON, nothing twice', [tools.backup, tools.tree, tools.lib], [[5, 0, 0, 5, true], ["Anne's Lens backup/Library 2/Kids/b.png", "Anne's Lens backup/Library 2/Kids/b.xmp", "Anne's Lens backup/Library 2/c.png", "Anne's Lens backup/Library 2/d.png", "Anne's Lens backup/Library 2/gone.xmp", "Anne's Lens backup/annes-lens-library.json"], ['library-backup', 1, 3, true, true, 2]], JSON.stringify(tools));

  // Saving goes to the right file with the right pixels: Save while Before / After shows the original writes the edit;
  // Save from the "Save changes?" prompt after Next keeps the folder list and moves on; and saving a window that is not
  // the active one writes that window's own picture (it used to take the active window's).
  const sv = await pa.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const root = await navigator.storage.getDirectory(), dir = await root.getDirectoryHandle('Trip 2024');
    const pixel = async (name) => { const bmp = await createImageBitmap(await (await dir.getFileHandle(name)).getFile()); const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const x = c.getContext('2d'); x.drawImage(bmp, 0, 0); return [...x.getImageData(5, 5, 1, 1).data].slice(0, 3); };
    const clickSave = async () => { let b; for (let i = 0; i < 80 && !(b = [...document.querySelectorAll('.ql-dialog button')].find((x) => x.textContent.trim() === 'Save')); i++) await wait(50); b?.click(); return !!b; };
    const openTrip = async () => { const picker = window.showDirectoryPicker; window.showDirectoryPicker = async () => dir; await qn.exec('file.openFolder'); window.showDirectoryPicker = picker; for (let i = 0; i < 60 && !(qn.folder.name === 'Trip 2024' && qn.picture); i++) await wait(50); await wait(200); };
    for (const t of [...qn.tabs].slice(1)) qn.closeTab(t);
    await openTrip();
    const out = { before: await pixel('a-landscape.png') };
    // 1. Edit, show "Before", save: the file gets the edit.
    await qn.exec('image.negative', 'all'); qn.tab.showOriginal(true);
    out.showingBefore = qn.tab.showingOriginal;
    await qn.exec('file.save'); for (let i = 0; i < 60 && qn.tab.dirty; i++) await wait(50); await wait(200);
    out.afterBeforeSave = [await pixel('a-landscape.png'), qn.tab.dirty, qn.tab.showingOriginal];
    // 2. Edit again (back to the first colors), Next, "Save": the list is intact and the window is on the next picture.
    await qn.exec('image.negative', 'all');
    const nav = qn.exec('view.next'); out.prompted = await clickSave(); await nav; for (let i = 0; i < 60 && qn.picture?.name !== 'b-beach.png'; i++) await wait(50); await wait(200);
    out.afterPrompt = [qn.folder.entries.map((e) => e.name), qn.picture?.name, qn.tab.dirty, await pixel('a-landscape.png')];
    // 3. Window 1 has an unsaved edit on a-landscape; window 2 (active) shows c-night. Window 1 moves on and saves.
    await qn.exec('view.first'); for (let i = 0; i < 60 && qn.picture?.name !== 'a-landscape.png'; i++) await wait(50);
    await qn.exec('image.negative', 'all');
    await openTrip(); // the first window is dirty, so the folder opens in a second one
    qn.folder.select(2); await qn.tab.show(); await wait(200);
    const first = qn.tabs[0]; out.windows = [qn.tabs.length, qn.tab !== first, qn.picture?.name, first.picture?.name, first.dirty];
    first.folder.select(1); const moved = first.show(); out.prompted2 = await clickSave(); await moved; await wait(300);
    out.afterOther = [await pixel('a-landscape.png'), await pixel('c-night.png'), first.picture?.name, first.dirty];
    qn.closeTab(qn.tab);
    return out;
  });
  check('save: the edit is written while Before / After shows the original', [sv.before, sv.showingBefore, sv.afterBeforeSave], [[70, 130, 220], true, [[185, 125, 35], false, false]], JSON.stringify(sv));
  check('save from the "Save changes?" prompt: the folder list is intact and the window moves on', [sv.prompted, sv.afterPrompt], [true, [['a-landscape.png', 'b-beach.png', 'c-night.png'], 'b-beach.png', false, [70, 130, 220]]], JSON.stringify(sv));
  check('saving a window that is not the active one writes its own picture', [sv.windows, sv.prompted2, sv.afterOther], [[2, true, 'c-night.png', 'a-landscape.png', true], true, [[185, 125, 35], [15, 15, 30], 'b-beach.png', false]], JSON.stringify(sv));

  // Network sharing through the relay (the web app has no server of its own): the album page hosts a view and an
  // album; a second browser follows the view (picture, zoom and pan) and opens the album (thumbnails through a relay).
  const pFollow = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await pFollow.addInitScript(() => localStorage.setItem('quilllens.prefs.v1', JSON.stringify({ firstRun: false })));
  await pFollow.goto(url); await pFollow.waitForFunction(() => window.qn && window.__qnGetCommand, null, { timeout: 30000 }); await pFollow.waitForTimeout(300);
  const hostA = await pa.evaluate(async (relayUrl) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await qn.exec('browse.albums', 'Seaside and hills'); for (let i = 0; i < 60 && qn.folder.name !== 'Album: Seaside and hills'; i++) await wait(50); await wait(300);
    qn.folder.select(0); await qn.tab.show(); await wait(200);
    const noRelay = await qn.exec('view.shareView', { quiet: true, relay: '' }); // the web app cannot share without a relay
    const r = await qn.exec('view.shareView', { quiet: true, relay: relayUrl });
    await wait(600);
    return { noRelay: noRelay === undefined, relayUrl: r.relayUrl, urls: r.urls, name: qn.picture.name, on: window.__qnGetCommand('view.shareView').isActive(qn) };
  }, relayUrl);
  const relayState = await (await fetch(hostA.relayUrl + 'state')).json();
  const fol = await pFollow.evaluate(async (base) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const bad = await qn.exec('view.followView', { url: base.replace(/\/s\//, '/a/'), quiet: true });
    const r = await qn.exec('view.followView', { url: base, quiet: true });
    for (let i = 0; i < 80 && qn.picture?.name !== 'a-landscape.png'; i++) await wait(100);
    return { bad: bad === undefined, base: r?.base, name: qn.picture?.name, folder: qn.folder.name, tabs: qn.tabs.length, on: window.__qnGetCommand('view.followView').isActive(qn), rel: +qn.viewer.viewRel().rel.toFixed(2) };
  }, hostA.relayUrl);
  // The host zooms in; the follower's zoom comes along. Then the host moves on; the follower shows the next picture (at fit again).
  const hostZ = await pa.evaluate(async () => { const wait = (ms) => new Promise((r) => setTimeout(r, ms)); await qn.exec('view.zoomIn'); await qn.exec('view.zoomIn'); await wait(100); return +qn.viewer.viewRel().rel.toFixed(2); });
  const folZ = await pFollow.evaluate(async (want) => { const wait = (ms) => new Promise((r) => setTimeout(r, ms)); for (let i = 0; i < 80 && Math.abs(qn.viewer.viewRel().rel - want) > 0.01; i++) await wait(100); return +qn.viewer.viewRel().rel.toFixed(2); }, hostZ);
  const hostB = await pa.evaluate(async () => { const wait = (ms) => new Promise((r) => setTimeout(r, ms)); await qn.exec('view.next'); await wait(700); return { rel: +qn.viewer.viewRel().rel.toFixed(2), name: qn.picture.name }; });
  const fol2 = await pFollow.evaluate(async () => { const wait = (ms) => new Promise((r) => setTimeout(r, ms)); for (let i = 0; i < 80 && qn.picture?.name !== 'b-beach.png'; i++) await wait(100); await wait(300); return { name: qn.picture?.name, history: qn.folder.length, rel: +qn.viewer.viewRel().rel.toFixed(2) }; });
  // The album: shared with thumbnails; opened as a folder in the follower; the host's stop ends both.
  const albA = await pa.evaluate(async (relayUrl) => { const wait = (ms) => new Promise((r) => setTimeout(r, ms)); const r = await qn.exec('browse.shareAlbum', { album: 'Seaside and hills', quiet: true, relay: relayUrl }); for (let i = 0; i < 60; i++) { const st = await (await fetch(r.relayUrl + 'state')).json(); if (st.items?.length && st.items.every((it) => it.thumb)) break; await wait(100); } return r; }, relayUrl);
  const albSt = await (await fetch(albA.relayUrl + 'state')).json();
  // A plain browser at the relay address: the thumbnails come from the state; no download links or upload box (those
  // need the host's own address), and nothing on the page asks the relay for a file it does not have.
  const pPlain = await browser.newPage({ viewport: { width: 900, height: 600 } }); const plain404 = [];
  pPlain.on('response', (r) => { if (r.status() >= 400) plain404.push(new URL(r.url()).pathname.split('/').slice(3).join('/')); });
  await pPlain.goto(albA.relayUrl); await pPlain.waitForFunction(() => document.querySelectorAll('#grid figure').length === 2, null, { timeout: 15000 });
  await pPlain.waitForFunction(() => [...document.querySelectorAll('#grid img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 15000 }).catch(() => undefined);
  const plain = await pPlain.evaluate(() => ({ title: document.getElementById('title').textContent, thumbs: [...document.querySelectorAll('#grid img')].map((i) => i.src.startsWith('data:image/jpeg') && i.naturalWidth > 0), links: document.querySelectorAll('#grid a').length, upload: !document.getElementById('up').hidden, note: document.getElementById('st').textContent }));
  await pPlain.close();
  check('shared album through the relay in a plain browser: thumbnails shown, nothing offered that would fail', [plain, plain404], [{ title: 'Seaside and hills', thumbs: [true, true], links: 0, upload: false, note: 'thumbnails only through the relay' }, []]);
  const albF = await pFollow.evaluate(async (base) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const r = await qn.exec('browse.openSharedAlbum', { url: base, quiet: true });
    for (let i = 0; i < 60 && qn.folder.name !== 'Shared album: Seaside and hills'; i++) await wait(100); for (let i = 0; i < 60 && !qn.picture; i++) await wait(100);
    return { r, folder: qn.folder.name, n: qn.folder.length, pic: qn.picture ? [qn.picture.name, qn.picture.width > 0] : null };
  }, albA.relayUrl);
  await pa.evaluate(async () => { await qn.exec('view.shareView'); await qn.exec('browse.shareAlbum'); });
  const ended = await pFollow.evaluate(async () => { const wait = (ms) => new Promise((r) => setTimeout(r, ms)); for (let i = 0; i < 60 && window.__qnGetCommand('view.followView').isActive(qn); i++) await wait(100); return window.__qnGetCommand('view.followView').isActive(qn); });
  const gone = (await fetch(hostA.relayUrl + 'state')).ok ? (await (await fetch(hostA.relayUrl + 'state')).json()).ended : 'missing';
  check('shared view through the relay: a second browser follows the picture, zoom and navigation; stopping ends it', [hostA.noRelay, hostA.on, hostA.urls, relayState.name, fol.bad, fol.base === hostA.relayUrl, fol.name, fol.folder, fol.tabs, fol.on, fol.rel, hostZ > 1.5, folZ === hostZ, hostB.name, fol2.name, fol2.history, fol2.rel === hostB.rel, ended, gone],
    [true, true, [], 'a-landscape.png', true, true, 'a-landscape.png', 'Shared view', 2, true, 1, true, true, 'b-beach.png', 'b-beach.png', 2, true, false, true], JSON.stringify({ hostA, fol, hostZ, folZ, hostB, fol2 }));
  check('shared album through the relay: listing with thumbnails, opened as a folder on the other side', [albA.pictures, albA.contribute, albSt.name, albSt.items.length, albSt.items.every((it) => /^data:image\/jpeg/.test(it.thumb)), albSt.files, albF.r, albF.folder, albF.n, albF.pic],
    [2, false, 'Seaside and hills', 2, true, false, { name: 'Seaside and hills', pictures: 2, contribute: false }, 'Shared album: Seaside and hills', 2, ['a-landscape.png', true]], JSON.stringify({ albA, albSt: { ...albSt, items: albSt.items.map((i) => i.name) }, albF }));
  await pFollow.close();
  await pctx.close();

  // Offline (U9): after one visit the service worker holds the release's scripts, so the app starts with no
  // network; a cache from an earlier release is removed when the worker takes over.
  {
    const octx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    const po = await octx.newPage();
    await po.addInitScript(() => localStorage.setItem('quilllens.prefs.v1', JSON.stringify({ firstRun: false })));
    await po.goto(url, { waitUntil: 'networkidle' });
    const first = await po.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      let reg = null; for (let i = 0; i < 100 && !(reg = await navigator.serviceWorker.getRegistration()); i++) await wait(100);
      await navigator.serviceWorker.ready;
      for (let i = 0; i < 100 && !navigator.serviceWorker.controller; i++) await wait(100);
      const keys = await caches.keys(), name = keys.find((k) => /^quilllens-[0-9a-f]{12}$/.test(k));
      const scripts = [...document.querySelectorAll('script[src]')].map((s) => s.src);
      const c = name ? await caches.open(name) : null, held = c ? await Promise.all(scripts.map(async (s) => !!(await c.match(s)))) : [];
      // An earlier release's cache, then a fresh install of this one.
      await (await caches.open('quilllens-v1')).put('./old.js', new Response('old'));
      await reg.unregister();
      return { name, scripts: scripts.length, held: held.every(Boolean) };
    });
    await po.reload({ waitUntil: 'networkidle' });
    const second = await po.evaluate(async () => { const wait = (ms) => new Promise((r) => setTimeout(r, ms)); await navigator.serviceWorker.ready; for (let i = 0; i < 100 && (await caches.keys()).includes('quilllens-v1'); i++) await wait(100); return caches.keys(); });
    await octx.setOffline(true);
    await po.reload({ waitUntil: 'load' });
    const off = await po.waitForSelector('.qn-viewer', { timeout: 15000 }).then(() => true, () => false);
    check('offline after one visit: the release is precached and the app starts without the network; old caches are removed', [!!first.name, first.scripts > 0, first.held, second, off], [true, true, true, [first.name], true], JSON.stringify(first));
    await octx.close();
  }

  if (errs.length) failures.push(...errs);
} finally {
  relay.close();
  await browser.close();
  if (server) try { process.kill(-server.pid); } catch { /* already gone */ }
  mockAi.close();
}

if (failures.length) { console.error('E2E failures:\n' + failures.join('\n')); process.exit(1); }
console.log('E2E smoke test passed');
