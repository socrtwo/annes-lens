// Desktop (Electron) checks: Next / Previous Folder on a real folder tree (siblings and parents),
// Full Screen on Another Display (two displays faked in the main process), and Frameless Window
// (the window is rebuilt without its frame and reopens the picture). Needs a display: run with
// `xvfb-run -a npm run e2e:desktop` after `npm run build`.
import { _electron as electron } from 'playwright';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createServer } from 'node:http';

if (!existsSync('build/desktop-app/package.json')) execFileSync('node', ['scripts/prepare-desktop.mjs'], { stdio: 'inherit' });
const failures = [];
const check = (name, got, want, note) => { if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}${note ? ' [' + note + ']' : ''}`); };

// A tiny solid PNG.
const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const png = (r, g, b) => { const ih = Buffer.alloc(13); ih.writeUInt32BE(4, 0); ih.writeUInt32BE(4, 4); ih[8] = 8; ih[9] = 2; const row = Buffer.from([0, ...Array(4).fill([r, g, b]).flat()]); return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(Buffer.concat(Array(4).fill(row)))), chunk('IEND', Buffer.alloc(0))]); };

const base = mkdtempSync(join(tmpdir(), 'ql-desktop-')), lib = join(base, 'library');
const put = (rel, color) => { const p = join(lib, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, png(...color)); return p; };
const first = put('Photos/2023/01 Jan/a.png', [255, 0, 0]);
put('Photos/2023/02 Feb/raw/b.png', [0, 255, 0]);
mkdirSync(join(lib, 'Photos/2023/02 Feb/empty'), { recursive: true });
put('Photos/2024/c.png', [0, 0, 255]); put('Photos/2024/d.png', [0, 0, 255]);
put('Photos/.cache/x.png', [9, 9, 9]);
put('Scans/e.png', [255, 255, 0]);
writeFileSync(join(lib, 'Photos/2024/notes.txt'), 'trip notes');
writeFileSync(join(lib, 'Photos/2024/c.xmp'), '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmp:Rating="5" exif:GPSLatitude="45,30.0N" exif:GPSLongitude="73,34.2W"/></rdf:RDF></x:xmpmeta>');
const config = join(base, 'config');

const app = await electron.launch({ executablePath: 'node_modules/electron/dist/electron', args: ['--no-sandbox', 'build/desktop-app', first], env: { ...process.env, XDG_CONFIG_HOME: config } });
app.process().stderr?.on('data', (d) => process.stderr.write('[main] ' + d));
app.process().stdout?.on('data', (d) => process.stderr.write('[main] ' + d));
try {
  // Native permission questions are answered "Allow" unless a test says otherwise; each one is recorded.
  await app.evaluate(({ dialog }) => { globalThis.__asks = []; globalThis.__answer = 0; dialog.showMessageBox = async (_w, o) => { globalThis.__asks.push(o.message); return { response: globalThis.__answer }; }; });
  let w = await app.firstWindow();
  await w.waitForFunction(() => window.qn && window.qn.picture?.name === 'a.png', null, { timeout: 30000 });
  const where = () => w.evaluate(() => `${qn.folder.name}:${qn.folder.length}:${qn.picture?.name}`);
  const steps = [await where()];
  // Secrets (AI service keys) round-trip through the main process's safeStorage store.
  const secret = await w.evaluate(async () => { const d = window.quillDesktop; const info = await d.secretInfo(); await d.secretSet({ name: 'e2e.test', value: 'sk-e2e' }); const got = (await d.secretGet({ name: 'e2e.test' })).value; await d.secretDelete({ name: 'e2e.test' }); const gone = (await d.secretGet({ name: 'e2e.test' })).value; return [typeof info.available, got, gone]; });
  check('desktop: secrets round-trip through safeStorage', secret, ['boolean', 'sk-e2e', null]);
  for (const key of ['Control+ArrowRight', 'Control+ArrowRight', 'Control+ArrowRight', 'Control+ArrowLeft', 'Control+ArrowLeft', 'Control+ArrowLeft']) {
    const before = await where();
    await w.keyboard.press(key);
    await w.waitForFunction((b) => `${qn.folder.name}:${qn.folder.length}:${qn.picture?.name}` !== b, before, { timeout: 8000 }).catch(() => undefined);
    await w.waitForTimeout(200);
    steps.push(await where());
  }
  check('desktop next / previous folder: subfolders first, then siblings, then the parent\'s siblings', steps, ['01 Jan:1:a.png', 'raw:1:b.png', '2024:2:c.png', 'Scans:1:e.png', '2024:2:c.png', 'raw:1:b.png', '01 Jan:1:a.png']);

  // Folder Tree from the top of the drive down to the open folder; Include Subfolders across real
  // folders; Show All Files with a text file beside the pictures; a favorite folder.
  const bw = await w.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const rows = () => [...document.querySelectorAll('.qn-tree-body .qn-tree-row')].map((r) => r.textContent.replace(/^[▸▾]?(folder_open|folder)/, '').trim());
    const row = (name) => [...document.querySelectorAll('.qn-tree-body .qn-tree-row')].find((r) => r.textContent.endsWith(name));
    await qn.exec('browse.folderTree'); for (let i = 0; i < 60 && !row('01 Jan'); i++) await wait(50); await wait(200);
    const chain = rows(), out = { chain: ['library', 'Photos', '2023', '01 Jan'].map((n) => chain.indexOf(n)), sel: document.querySelector('.qn-tree-body .ql-sel')?.textContent.endsWith('01 Jan') };
    row('Photos').click(); await wait(400); // no pictures directly in it: its branch opens instead
    out.photos = [qn.folder.name, !!row('2024')];
    await qn.exec('browse.recursive'); await wait(300);
    row('Photos').click(); for (let i = 0; i < 60 && !/^Photos \(with subfolders\)/.test(qn.folder.name); i++) await wait(50); await wait(200);
    out.recursive = [qn.folder.name, qn.folder.entries.map((e) => e.name)];
    await qn.exec('browse.recursive'); await wait(300);
    row('2024').click(); for (let i = 0; i < 60 && qn.folder.name !== '2024'; i++) await wait(50); await wait(200);
    await qn.exec('browse.showAllFiles'); for (let i = 0; i < 60 && qn.folder.length < 3; i++) await wait(50); await wait(200);
    out.all = qn.folder.entries.map((e) => e.name);
    const txt = qn.folder.entries.find((e) => e.name === 'notes.txt'); out.readable = txt ? new TextDecoder().decode(await txt.read()) : null;
    await qn.exec('browse.showAllFiles'); await wait(300);
    await qn.exec('browse.favorites', 'add'); await wait(200);
    out.fav = [...document.querySelectorAll('.qn-tree-favs .qn-tree-row')].map((r) => r.textContent.replace(/^folder_special/, ''));
    row('2023').click(); for (let i = 0; i < 40 && !row('01 Jan'); i++) await wait(50); // 2023 has no pictures: it expands
    row('01 Jan').click(); for (let i = 0; i < 60 && qn.folder.name !== '01 Jan'; i++) await wait(50); await wait(200);
    await qn.exec('browse.favorites', 0); for (let i = 0; i < 60 && qn.folder.name !== '2024'; i++) await wait(50); await wait(200);
    out.favOpen = [qn.folder.name, qn.folder.length];
    row('2023').click(); for (let i = 0; i < 40 && !row('01 Jan'); i++) await wait(50); // 2023 has no pictures: it expands
    row('01 Jan').click(); for (let i = 0; i < 60 && qn.folder.name !== '01 Jan'; i++) await wait(50); await wait(200);
    await qn.exec('browse.folderTree'); await wait(100);
    return out;
  });
  check('desktop folder tree: the chain down to the open folder, selected', [bw.chain.every((v, i, a) => v >= 0 && (i === 0 || v > a[i - 1])), bw.sel], [true, true], JSON.stringify(bw));
  check('desktop include subfolders and show all files on real folders', [bw.photos, bw.recursive, bw.all, bw.readable], [['01 Jan (with subfolders)'.replace(' (with subfolders)', ''), true], ['Photos (with subfolders)', ['a.png', 'b.png', 'c.png', 'd.png']], ['c.png', 'c.xmp', 'd.png', 'notes.txt'], 'trip notes'], JSON.stringify(bw));
  check('desktop favorite folder: added and opened', [bw.fav, bw.favOpen], [['2024'], ['2024', 2]]);

  // A sidecar beside a picture is read (the listing includes .xmp files); the catalog holds a real
  // tree; a watched folder's new picture goes into the catalog.
  const cat = await w.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const M = await window.__qnMeta();
    const out = {};
    await qn.exec('browse.favorites', 0); for (let i = 0; i < 60 && qn.folder.name !== '2024'; i++) await wait(50); await wait(200);
    out.sidecar = (await M.readMeta(qn, qn.folder.entries.find((e) => e.name === 'c.png'))).props.rating;
    const photosUri = qn.folder.uri.replace(/\/2024$/, '');
    const { openFolderRef } = { openFolderRef: null };
    qn.folder.uri = photosUri; qn.folder.name = 'Photos';
    const rep = await qn.exec('browse.folderManager', { add: true, subfolders: true });
    out.added = rep.added;
    await qn.exec('browse.catalog'); for (let i = 0; i < 60 && !/^Catalog/.test(qn.folder.name); i++) await wait(50); await wait(300);
    out.view = [qn.folder.name, qn.folder.entries.map((e) => e.name).sort()];
    out.photosUri = photosUri;
    return out;
  });
  // Watch Photos (it holds no pictures directly yet): f.png appears, the tick adds it to the catalog.
  const cat2 = await w.evaluate(async (photosUri) => {
    // Photos holds no pictures directly, so it cannot be opened as a folder: point the open folder at it.
    qn.folder.uri = photosUri; qn.folder.name = 'Photos';
    const w1 = await qn.exec('browse.watchFolder', { add: 'catalog' });
    return { known: w1.known.length, folder: w1.folder.name };
  }, cat.photosUri);
  writeFileSync(join(lib, 'Photos/f.png'), png(9, 9, 9));
  const cat3 = await w.evaluate(async () => { const n = await qn.exec('browse.watchFolder', 'tick'); await qn.exec('browse.catalog', 'open'); await new Promise((r) => setTimeout(r, 300)); return { n, names: qn.folder.entries.map((e) => e.name).sort() }; });
  check('desktop sidecar read and catalog of a real tree', [cat.sidecar, cat.added, cat.view], [5, 4, ['Catalog (4 pictures)', ['a.png', 'b.png', 'c.png', 'd.png']]], JSON.stringify(cat));
  check('desktop watch folder: a new picture goes into the catalog', [cat2, cat3.n, cat3.names], [{ known: 0, folder: 'Photos' }, 1, ['a.png', 'b.png', 'c.png', 'd.png', 'f.png']], JSON.stringify(cat3));
  // External Tools may only start programs picked in the system dialog; Back Up Library onto disk.
  const tl = await w.evaluate(async (libUri) => {
    const refused = await window.quillDesktop.openWithProgram({ uri: qn.folder.entries[0].uri, program: '/bin/echo' }).then(() => 'ran', (e) => String(e));
    const rep = await qn.exec('tools.backup', { dest: { uri: libUri, name: 'library' }, library: true });
    const again = await qn.exec('tools.backup', { dest: { uri: libUri, name: 'library' }, library: true });
    return { refused, rep: [rep.copied, rep.library], again: [again.copied, again.skipped] };
  }, cat.photosUri.replace(/\/Photos$/, ''));
  const backed = (await import('node:fs')).readdirSync(join(lib, "Anne's Lens backup", 'Photos'), { recursive: true }).map(String).sort();
  check('desktop: unpicked programs are refused; the catalog backs up onto disk once', [/Choose this program again/.test(tl.refused), tl.rep, tl.again, backed, existsSync(join(lib, "Anne's Lens backup", 'annes-lens-library.json'))], [true, [6, true], [0, 6], ['2023', '2023/01 Jan', '2023/01 Jan/a.png', '2023/02 Feb', '2023/02 Feb/empty', '2023/02 Feb/raw', '2023/02 Feb/raw/b.png', '2024', '2024/c.png', '2024/c.xmp', '2024/d.png', 'f.png'], true], JSON.stringify(tl));
  await w.evaluate(async () => { const wait = (ms) => new Promise((r) => setTimeout(r, ms)); await qn.exec('browse.catalog'); const jan = qn.prefs.recentFolders.find((r) => r.name === '01 Jan'); await qn.exec('file.recentFolders', jan.key); for (let i = 0; i < 60 && qn.folder.name !== '01 Jan'; i++) await wait(50); await wait(300); });

  // Two displays (faked in the main process): the window moves to the second and goes full screen; leaving restores it.
  await app.evaluate(({ screen }) => {
    const d = [{ id: 1, label: 'Built-in', bounds: { x: 0, y: 0, width: 1280, height: 800 }, workArea: { x: 0, y: 0, width: 1280, height: 800 } }, { id: 2, label: 'Projector', bounds: { x: 1280, y: 0, width: 1024, height: 768 }, workArea: { x: 1280, y: 0, width: 1024, height: 768 } }];
    screen.getAllDisplays = () => d; screen.getPrimaryDisplay = () => d[0]; screen.getDisplayMatching = (b) => (b.x >= 1280 ? d[1] : d[0]);
  });
  const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  const listed = await w.evaluate(() => window.quillDesktop.listDisplays());
  await w.evaluate(() => qn.exec('view.fullScreenDisplay', 1));
  await w.waitForTimeout(1200);
  const during = await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; return { full: b.isFullScreen() }; });
  const cls = await w.evaluate(() => document.body.classList.contains('ql-fullscreen'));
  await w.evaluate(() => qn.exec('view.fullScreen'));
  await w.waitForTimeout(1500);
  const after = await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; return { full: b.isFullScreen(), bounds: b.getBounds() }; });
  check('desktop displays listed', listed.map((x) => [x.label, x.primary, x.current]), [['Built-in', true, true], ['Projector', false, false]]);
  check('desktop full screen on the second display, and back', [during.full, cls, after.full, after.bounds.x === before.x && after.bounds.width === before.width], [true, true, false, true], JSON.stringify({ before, during, after }));

  // Script Console under the desktop Content Security Policy (blob: worker, importScripts, no eval).
  const con = await w.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const run = qn.exec('dev.console', 'const p = await picture.pixels(); return [p.width, p.height, p.data[0], p.data[1], p.data[2]];');
    let dlg; for (let i = 0; i < 60 && !(dlg = [...document.querySelectorAll('.ql-dialog')].find((d) => /Script Console/.test(d.textContent))); i++) await wait(50);
    [...dlg.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Run').click();
    const log = () => dlg.querySelector('.qn-console-out').textContent;
    for (let i = 0; i < 100 && !/←|✖/.test(log()); i++) await wait(50);
    const text = log();
    [...dlg.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Close').click(); await run;
    return text.replace(/\s+/g, ' ');
  });
  check('desktop script console runs under the app\'s security policy', /← \[ 4, 4, 255, 0, 0 \]/.test(con), true, con);

  // Phone Remote: Node plays the phone. It loads the page through the token address, follows the state stream, and Next / Start / Pause / Stop drive the app.
  const rm = await w.evaluate(async () => { const wait = (ms) => new Promise((r) => setTimeout(r, ms)); await qn.exec('browse.favorites', 0); for (let i = 0; i < 60 && qn.folder.name !== '2024'; i++) await wait(50); await wait(300); const r = await qn.exec('show.remote', { quiet: true }); return { urls: r.urls, port: r.port, on: window.__qnGetCommand('show.remote').isActive(qn), name: qn.picture.name }; });
  const rbase = rm.urls[0].replace(/^http:\/\/[^/:]+/, 'http://127.0.0.1');
  const page = await (await fetch(rbase)).text(), js = await (await fetch(rbase + 'app.js')).text();
  const wrongToken = (await fetch(rbase.replace(/\/r\/[0-9a-f]+\//, '/r/0123/'))).status;
  const waitState = async (pred) => { for (let i = 0; i < 60; i++) { const st = await (await fetch(rbase + 'state')).json(); if (pred(st)) return st; await new Promise((r) => setTimeout(r, 100)); } return (await (await fetch(rbase + 'state')).json()); };
  const s0 = await waitState((st) => st.name);
  // The event stream sends the state at once.
  const ctl = new AbortController(), evRes = await fetch(rbase + 'events', { signal: ctl.signal }), rdr = evRes.body.getReader(); const firstEvent = new TextDecoder().decode((await rdr.read()).value); ctl.abort();
  const post = (cmd) => fetch(rbase + 'cmd', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd }) }).then((r) => r.status);
  const bad = await post('rm -rf');
  const n1 = await post('next'); const s1 = await waitState((st) => st.name && st.name !== s0.name);
  await w.evaluate(() => { qn.prefs.slideshow = { ...qn.prefs.slideshow, seconds: 30, transition: 'fade', transitionMs: 50, musicOn: false }; });
  await post('start'); const s2 = await waitState((st) => st.running);
  await post('pause'); const s3 = await waitState((st) => st.paused);
  await post('stop'); const s4 = await waitState((st) => !st.running);
  await w.evaluate(() => qn.exec('show.remote'));
  const offStatus = await fetch(rbase + 'state').then((r) => r.status, () => 'closed');
  check('desktop phone remote: page behind a token, live state, commands drive the app, off closes it', [rm.on, /Start slideshow/.test(page), /EventSource/.test(js), wrongToken, s0.name, /^data: \{/.test(firstEvent), bad, n1, s1.name, s1.index, /^data:image\/jpeg/.test(s1.thumb || ''), s2.running, s3.paused, s4.running, offStatus],
    [true, true, true, 404, 'c.png', true, 400, 204, 'd.png', 2, true, true, true, false, 'closed'], JSON.stringify({ s0: { ...s0, thumb: undefined }, s1: { ...s1, thumb: undefined }, rm }));
  // Stop AI on the desktop: a request to a service that never answers is cancelled by its id and ends at once.
  const slow = createServer(() => { /* never answers */ }); await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  const stop = await w.evaluate(async (port) => {
    const d = window.quillDesktop, t0 = Date.now();
    const p = d.request({ url: `http://127.0.0.1:${port}/v1/images`, method: 'GET', headers: {}, id: 'stop-me', timeoutMs: 60000 }).then(() => 'answered', (e) => String(e.message || e));
    await new Promise((r) => setTimeout(r, 300));
    const c = await d.cancelRequest({ id: 'stop-me' }), again = await d.cancelRequest({ id: 'stop-me' });
    return { result: await p, ms: Date.now() - t0, c, again };
  }, slow.address().port);
  slow.close();
  check('desktop: a request cancelled by its id (Stop AI) ends at once', [/Stopped/.test(stop.result), stop.ms < 3000, stop.c.cancelled, stop.again.cancelled], [true, true, true, false], JSON.stringify(stop));
  // Writes that must not replace a file ('rename'), and a folder that is gone is an error, not its parent's listing.
  // The folder was only read so far: saving into it asks the user first (a native question; refused once here, then allowed).
  await app.evaluate(() => { globalThis.__answer = 1; });
  const gwRefused = await w.evaluate(() => window.quillDesktop.createInFolder({ dirUri: qn.folder.uri, name: 'refused.png', mime: 'image/png', data: btoa('x'), ifExists: 'rename' }).then(() => 'written', (e) => String(e.message || e)));
  await app.evaluate(() => { globalThis.__answer = 0; });
  const gw = await w.evaluate(async () => {
    const b64 = btoa('new bytes');
    const dirUri = qn.folder.uri, first = qn.folder.entries[0];
    const kept = await window.quillDesktop.createInFolder({ dirUri, name: first.name, mime: 'image/png', data: b64, ifExists: 'rename' });
    const again = await window.quillDesktop.createInFolder({ dirUri, name: first.name, mime: 'image/png', data: b64, ifExists: 'rename' });
    const gone = await window.quillDesktop.listFolder({ uri: dirUri.replace(/\/[^/]+$/, '/no-such-folder-here') }).then(() => 'listed', (e) => String(e.message || e));
    return { first: first.name, kept: kept.name, again: again.name, gone };
  });
  gw.refused = gwRefused;
  const gwAsks = await app.evaluate(() => globalThis.__asks.filter((m) => /save files into “2024”/.test(m))); // (the backup test above names its destination directly, without the folder dialog, and was asked for it too)
  check('desktop: saving into a folder that was only read asks once, and writes nothing when refused', [/was not allowed/.test(gw.refused), gwAsks], [true, Array(2).fill('Allow Anne\'s Lens to save files into “2024”?')]);
  check('desktop: a write that must not replace a file takes the next free name; a missing folder is an error',
    [gw.kept, gw.again, readFileSync(join(lib, 'Photos/2024', gw.first)).length > 20, readFileSync(join(lib, 'Photos/2024', gw.kept)).toString(), /not available|no permission/i.test(gw.gone)],
    [gw.first.replace(/(\.[^.]+)$/, ' (2)$1'), gw.first.replace(/(\.[^.]+)$/, ' (3)$1'), true, 'new bytes', true], JSON.stringify(gw));
  for (const n of [gw.kept, gw.again]) rmSync(join(lib, 'Photos/2024', n), { force: true });
  await w.evaluate(async () => { const wait = (ms) => new Promise((r) => setTimeout(r, ms)); await qn.exec('browse.favorites', 0); for (let i = 0; i < 60 && qn.folder.length !== 2; i++) await wait(50); await wait(200); });
  // Network sharing on the desktop: the view room from Node (page, state, conditional state), following the own share in a
  // second window (the same file is shown from the open folder, not the rendition), an album room with files and an upload.
  mkdirSync(join(lib, 'Uploads'), { recursive: true });
  await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, join(lib, 'Uploads'));
  const shv = await w.evaluate(async () => { const wait = (ms) => new Promise((r) => setTimeout(r, ms)); const r = await qn.exec('view.shareView', { quiet: true, relay: '' }); await wait(600); return { urls: r.urls, token: r.token, relayUrl: r.relayUrl, name: qn.picture.name, on: window.__qnGetCommand('view.shareView').isActive(qn) }; });
  const sbase = shv.urls[0].replace(/^http:\/\/[^/:]+/, 'http://127.0.0.1');
  const spage = await (await fetch(sbase)).text(), sst = await (await fetch(sbase + 'state')).json();
  const sNotMod = (await fetch(sbase + 'state?since=' + encodeURIComponent(sst.sig))).status, sWrong = (await fetch(sbase.replace(/\/s\/[0-9a-f]+\//, '/s/' + '0'.repeat(32) + '/') + 'state')).status;
  const folv = await w.evaluate(async (base) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const r = await qn.exec('view.followView', { url: base, quiet: true });
    for (let i = 0; i < 80 && !(qn.folder.name === 'Shared view' && qn.picture); i++) await wait(100); await wait(200);
    const twin = qn.tabs[0].folder.entries.find((e) => e.name === qn.picture?.name);
    const out = { base: r?.base === base, folder: qn.folder.name, name: qn.picture?.name, tabs: qn.tabs.length, fullQuality: !!twin && qn.picture.entry === twin, on: window.__qnGetCommand('view.followView').isActive(qn) };
    await qn.exec('view.followView'); qn.closeTab(qn.tab); await qn.exec('view.shareView'); await wait(200);
    out.after = [qn.tabs.length, window.__qnGetCommand('view.followView').isActive(qn), window.__qnGetCommand('view.shareView').isActive(qn)];
    return out;
  }, sbase);
  const sGone = await fetch(sbase + 'state').then((r) => r.status, () => 'closed'); // the last room gone, the server closes
  const alb1 = await w.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const t = qn.tab; t.marked.clear(); for (const e of qn.folder.entries) t.marked.add(e);
    await qn.exec('browse.addToAlbum', { album: '', name: 'Desk' }); t.marked.clear(); await wait(100);
    const r = await qn.exec('browse.shareAlbum', { album: 'Desk', contribute: true, contribDir: 'file:///placeholder', quiet: true, relay: '' });
    return { pictures: r.pictures, contribute: r.contribute, urls: r.urls };
  });
  // The placeholder folder is not one the app may write to, so additions stay off; share again through the (stubbed) folder dialog.
  const alb2 = await w.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await qn.exec('browse.shareAlbum');
    const dir = await window.quillDesktop.pickFolder({ title: 'x' });
    const r = await qn.exec('browse.shareAlbum', { album: 'Desk', contribute: true, contribDir: dir.uri, quiet: true, relay: '' });
    for (let i = 0; i < 60; i++) { const st = await (await fetch(r.urls[0].replace(/^http:\/\/[^/:]+/, 'http://127.0.0.1') + 'state')).json(); if (st.items.length) break; await wait(100); }
    return { pictures: r.pictures, contribute: r.contribute, urls: r.urls };
  });
  const abase = alb2.urls[0].replace(/^http:\/\/[^/:]+/, 'http://127.0.0.1');
  const ast = await (await fetch(abase + 'state')).json(), apage = await (await fetch(abase)).text();
  const afile = await fetch(abase + 'file/' + ast.items[0].id), abytes = Buffer.from(await afile.arrayBuffer());
  let athumb = 404; for (let i = 0; i < 60 && athumb !== 200; i++) { athumb = (await fetch(abase + 'thumb/' + ast.items[0].id)).status; if (athumb !== 200) await new Promise((r) => setTimeout(r, 100)); }
  const up = await fetch(abase + 'add?name=guest.png', { method: 'POST', headers: { 'content-type': 'image/png' }, body: png(7, 7, 200) });
  const upBody = await up.json();
  const alb3 = await w.evaluate(async () => { const wait = (ms) => new Promise((r) => setTimeout(r, ms)); const { listAlbums } = await window.__qnAlbums(); let alb; for (let i = 0; i < 60; i++) { alb = (await listAlbums()).find((a) => a.name === 'Desk'); if (alb && alb.items.length === 3) break; await wait(100); } return { items: alb?.items.map((it) => it.name).sort() }; });
  let ast2 = await (await fetch(abase + 'state')).json(); for (let i = 0; i < 50 && ast2.items.length < 3; i++) { await new Promise((r) => setTimeout(r, 100)); ast2 = await (await fetch(abase + 'state')).json(); }
  await w.evaluate(() => qn.exec('browse.shareAlbum'));
  check('desktop shared view: token page and state, conditional fetch, following the own share in a second window at full quality, off closes the room',
    [shv.on, shv.urls.length > 0, shv.relayUrl, /Anne's Lens shared view/.test(spage), sst.name, sst.kind, /^data:image\/jpeg/.test(sst.picture || ''), typeof sst.rel, sNotMod, sWrong, folv.base, folv.folder, folv.name, folv.tabs, folv.fullQuality, folv.on, folv.after, sGone],
    [true, true, '', true, shv.name, 'view', true, 'number', 304, 404, true, 'Shared view', shv.name, 2, true, true, [1, false, false], 'closed'], JSON.stringify({ shv, sst: { ...sst, picture: undefined }, folv }));
  check('desktop shared album: files served from the album, thumbnails made, an upload lands in the chosen folder and in the album',
    [alb1.pictures, alb1.contribute, alb2.contribute, ast.name, ast.items.length, ast.contribute, /Anne's Lens shared album/.test(apage), afile.status, afile.headers.get('content-type'), abytes.length === readFileSync(join(lib, 'Photos/2024', ast.items[0].name)).length, athumb, up.status, upBody.name, existsSync(join(lib, 'Uploads/guest.png')), alb3.items, ast2.items.length],
    [2, false, true, 'Desk', 2, true, true, 200, 'image/png', true, 200, 200, 'guest.png', true, ['c.png', 'd.png', 'guest.png'], 3], JSON.stringify({ alb1, alb2, ast: { ...ast, items: ast.items.map((i) => i.name) }, upBody, alb3, ast2: ast2.items.map((i) => i.name) }));
  // Map on the desktop: the sidecar's location, and the offline outline loads under the app's security policy.
  const dm = await w.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const MAP = await window.__qnMap();
    const quiet = await qn.exec('browse.map', { source: 'folder', quiet: true });
    qn.prefs.mapTiles = { basemap: 'offline', template: '' };
    const run = qn.exec('browse.map', { source: 'folder' });
    for (let i = 0; i < 60 && !MAP.mapState.view; i++) await wait(50);
    const mv = MAP.mapState.view; for (let i = 0; i < 100 && !mv['rings']; i++) await wait(50); await wait(200); mv.paint();
    const out = { quiet: quiet.points.map((p) => [p.name, +p.lat.toFixed(2), +p.lon.toFixed(2)]), outline: !!mv['rings'], pins: document.querySelectorAll('.qn-map-pin').length, tiles: document.querySelectorAll('.qn-map-tile').length };
    [...document.querySelectorAll('.ql-dialog[aria-label="Map"] button')].find((b) => b.textContent.trim() === 'Close').click(); await run;
    qn.prefs.mapTiles = { basemap: 'osm', template: '' };
    return out;
  });
  check('desktop map: a sidecar location on a real file; the offline outline under the security policy', dm, { quiet: [['c.png', 45.5, -73.57]], outline: true, pins: 1, tiles: 0 });
  await w.evaluate(async () => { const wait = (ms) => new Promise((r) => setTimeout(r, ms)); const jan = qn.prefs.recentFolders.find((r) => r.name === '01 Jan'); await qn.exec('file.recentFolders', jan.key); for (let i = 0; i < 60 && qn.folder.name !== '01 Jan'; i++) await wait(50); await wait(300); });

  // Frameless: a new window without a frame, the same picture in it, the title bar's window buttons shown.
  // The window that asks is replaced, so the call itself never returns.
  // A view shared from the window that is about to be replaced ends with it (the new page knows nothing of it).
  const shBefore = await w.evaluate(async () => { const r = await qn.exec('view.shareView', { quiet: true, relay: '' }); return r.urls[0].replace(/^http:\/\/[^/:]+/, 'http://127.0.0.1'); });
  const shLive = await fetch(shBefore + 'state').then((r) => r.status, () => 'closed');
  const next = app.waitForEvent('window');
  void w.evaluate(() => qn.exec('view.frameless')).catch(() => undefined);
  w = await next;
  await w.waitForFunction(() => window.qn && window.qn.picture?.name === 'a.png' && document.body.classList.contains('qn-frameless'), null, { timeout: 30000 });
  const shAfter = await fetch(shBefore + 'state').then((r) => r.status, () => 'closed');
  check('desktop: a shared view ends when its window is replaced', [shLive, shAfter, await w.evaluate(() => window.__qnGetCommand('view.shareView').isActive(qn))], [200, 'closed', false]);
  const fl = await w.evaluate(() => ({ winctl: getComputedStyle(document.querySelector('.ql-winctl')).display !== 'none' && document.querySelector('.ql-winctl').getBoundingClientRect().width > 60, drag: getComputedStyle(document.querySelector('.ql-titlebar')).getPropertyValue('-webkit-app-region') || getComputedStyle(document.querySelector('.ql-titlebar')).getPropertyValue('app-region'), active: window.__qnGetCommand('view.frameless').isActive(qn), folder: qn.folder.name }));
  const count = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  check('desktop frameless window reopens the picture with window buttons', [fl, count], [{ winctl: true, drag: 'drag', active: true, folder: '01 Jan' }, 1]);
  await w.evaluate(() => window.quillDesktop.windowControl({ action: 'maximize' }));
  await w.waitForTimeout(300);
  const back = app.waitForEvent('window');
  void w.evaluate(() => qn.exec('view.frameless')).catch(() => undefined);
  w = await back;
  await w.waitForFunction(() => window.qn && window.qn.picture?.name === 'a.png', null, { timeout: 30000 });
  check('desktop framed again', await w.evaluate(() => [document.body.classList.contains('qn-frameless'), getComputedStyle(document.querySelector('.ql-winctl')).display]), [false, 'none']);
} finally {
  await app.close().catch(() => undefined);
}

// The command line: help, version, usage errors, and --convert without a window.
const ELECTRON = 'node_modules/electron/dist/electron', APPDIR = 'build/desktop-app';
const cliRun = (args, cwd) => { const r = spawnSync(join(process.cwd(), ELECTRON), ['--no-sandbox', join(process.cwd(), APPDIR), ...args], { cwd: cwd || process.cwd(), encoding: 'utf8', timeout: 90000, env: { ...process.env, XDG_CONFIG_HOME: config } }); return { code: r.status, out: r.stdout, err: (r.stderr || '').split('\n').filter((l) => /annes-lens|Run annes-lens/.test(l)).join('\n') }; };
const pngSize = (p) => { const b = readFileSync(p); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
try {
  const help = cliRun(['--help']), ver = cliRun(['--version']), bad = cliRun(['--rotate=45', '--convert=*.png', 'x.png']);
  check('cli --help', [help.code, /--convert=PATTERN/.test(help.out), /Exit status/.test(help.out)], [0, true, true], help.out.slice(0, 200));
  check('cli --version', [ver.code, /^\d+\.\d+\.\d+/.test(ver.out)], [0, true], ver.out);
  check('cli usage error', [bad.code, /--rotate=45: use 90, 180, 270 or exif/.test(bad.err)], [2, true], bad.err);
  const out1 = cliRun(['--convert=small/*-s.png', '--resize=2x2', '--rotate=90', '--gray', join(lib, 'Photos/2024'), join(lib, 'Scans/e.png')], base);
  const made = existsSync(join(base, 'small')) ? readdirSync(join(base, 'small')).sort() : [];
  check('cli --convert writes resized, turned, gray pictures and reports them', [out1.code, made, made.map((f) => pngSize(join(base, 'small', f))), out1.out.trim().split('\n').length], [0, ['c-s.png', 'd-s.png', 'e-s.png'], [[2, 2], [2, 2], [2, 2]], 3], out1.out + out1.err);
  const again = cliRun(['--convert=small/*-s.png', join(lib, 'Scans/e.png')], base), over = cliRun(['--convert=small/*-s.png', '--overwrite', join(lib, 'Scans/e.png')], base);
  check('cli --convert keeps existing files unless --overwrite', [again.code, /e\.png -> e-s \(2\)\.png/.test(again.out), over.code, /e\.png -> e-s\.png/.test(over.out), readdirSync(join(base, 'small')).length], [0, true, 0, true, 4], again.out + over.out);
  const none = cliRun(['--convert=x/*.png', join(base, 'missing.png')], base);
  check('cli --convert with nothing to convert', [none.code, /no pictures to convert/.test(none.err)], [2, true], none.err);
  // After a restart the catalog's folders are still readable (remembered), so the catalog view shows its pictures.
  const re = await electron.launch({ executablePath: ELECTRON, args: ['--no-sandbox', APPDIR], env: { ...process.env, XDG_CONFIG_HOME: config } });
  const rw = await re.firstWindow(); await rw.waitForFunction(() => window.qn && window.__qnGetCommand, null, { timeout: 30000 });
  const after = await rw.evaluate(async () => { await qn.exec('browse.catalog', 'open'); for (let i = 0; i < 60 && !qn.picture; i++) await new Promise((r) => setTimeout(r, 100)); return [qn.folder.name, qn.picture?.name || null, qn.picture?.width || 0]; });
  await re.close().catch(() => undefined);
  check('desktop catalog after a restart (remembered folders)', after, ['Catalog (5 pictures)', 'a.png', 4]);
  // --fullscreen at start-up.
  const fsApp = await electron.launch({ executablePath: ELECTRON, args: ['--no-sandbox', APPDIR, '--fullscreen', first], env: { ...process.env, XDG_CONFIG_HOME: config } });
  const fw = await fsApp.firstWindow();
  const fsOn = await fw.waitForFunction(() => window.qn?.picture?.name === 'a.png' && document.body.classList.contains('ql-fullscreen'), null, { timeout: 30000 }).then(() => true).catch(() => false);
  await fsApp.close().catch(() => undefined);
  check('cli --fullscreen opens the picture full screen', fsOn, true);
  // A PDF from the command line: pdf.js and its worker run under the desktop Content Security Policy.
  const pdfPath = join(base, 'sample.pdf'); writeFileSync(pdfPath, readFileSync('tests/fixtures/pdf/sample.pdf'));
  const pdfApp = await electron.launch({ executablePath: ELECTRON, args: ['--no-sandbox', APPDIR, pdfPath], env: { ...process.env, XDG_CONFIG_HOME: config } });
  try {
    const pw = await pdfApp.firstWindow();
    const ok = await pw.waitForFunction(() => window.qn?.picture?.name === 'sample.pdf', null, { timeout: 60000 }).then(() => true).catch(() => false);
    const got = ok ? await pw.evaluate(() => { const f = qn.picture.pages[0].frames[0].image, c = document.createElement('canvas'); c.width = f.width; c.height = f.height; const g = c.getContext('2d'); g.drawImage(f, 0, 0); const at = (x, y) => [...g.getImageData(x, y, 1, 1).data].slice(0, 3); const k = f.width / 612; return [qn.picture.pages.length, f.width, at(Math.round(172 * k), Math.round(132 * k))]; }) : await pw.evaluate(() => [...document.querySelectorAll('.ql-toast')].map((t) => t.textContent));
    check('desktop: a PDF opens through pdf.js (three pages, 150 dpi, the red block)', got, [3, 1275, [255, 0, 0]]);
  } finally { await pdfApp.close().catch(() => undefined); }
  // A JPEG 2000 file from the command line: OpenJPEG (pdf.js's image decoders) compiles in the page under the same policy.
  const jp2Path = join(base, 'scan.jp2'); writeFileSync(jp2Path, readFileSync('tests/fixtures/jpx/tagged.jp2'));
  const jApp = await electron.launch({ executablePath: ELECTRON, args: ['--no-sandbox', APPDIR, jp2Path], env: { ...process.env, XDG_CONFIG_HOME: config } });
  try {
    const jw = await jApp.firstWindow();
    const ok = await jw.waitForFunction(() => window.qn?.picture?.name === 'scan.jp2', null, { timeout: 60000 }).then(() => true).catch(() => false);
    const got = ok ? await jw.evaluate(() => [qn.picture.format.id, qn.picture.width, qn.picture.height, qn.picture.current.dpi, [...qn.picture.frameCanvas().getContext('2d').getImageData(15, 12, 1, 1).data].slice(0, 3)]) : await jw.evaluate(() => [...document.querySelectorAll('.ql-toast')].map((t) => t.textContent));
    check('desktop: a JPEG 2000 file opens through OpenJPEG', [got[0], got[1], got[2], got[3]], ['jp2', 53, 37, [300, 300]], JSON.stringify(got));
  } finally { await jApp.close().catch(() => undefined); }
  // A JPEG XL file: Chromium has no decoder, so the app's jxl-oxide (a local runtime) decodes it under the same policy.
  const jxlPath = join(base, 'photo.jxl'); writeFileSync(jxlPath, readFileSync('tests/fixtures/modern/lossless.jxl'));
  const xApp = await electron.launch({ executablePath: ELECTRON, args: ['--no-sandbox', APPDIR, jxlPath], env: { ...process.env, XDG_CONFIG_HOME: config } });
  try {
    const xw = await xApp.firstWindow();
    const ok = await xw.waitForFunction(() => window.qn?.picture?.name === 'photo.jxl', null, { timeout: 60000 }).then(() => true).catch(() => false);
    const got = ok ? await xw.evaluate(() => [qn.picture.format.id, qn.picture.decoder, qn.picture.width, qn.picture.height]) : await xw.evaluate(() => [...document.querySelectorAll('.ql-toast')].map((t) => t.textContent));
    check('desktop: a JPEG XL file opens through jxl-oxide', got, ['jxl', 'jxl-oxide', 53, 37]);
  } finally { await xApp.close().catch(() => undefined); }
  // A DjVu book: djvu-rs's loader picks its SIMD or scalar WebAssembly build from the local runtime under the same policy.
  const djPath = join(base, 'register.djvu'); writeFileSync(djPath, readFileSync('tests/fixtures/djvu/book.djvu'));
  const dApp = await electron.launch({ executablePath: ELECTRON, args: ['--no-sandbox', APPDIR, djPath], env: { ...process.env, XDG_CONFIG_HOME: config } });
  try {
    const dw = await dApp.firstWindow();
    const ok = await dw.waitForFunction(() => window.qn?.picture?.name === 'register.djvu', null, { timeout: 60000 }).then(() => true).catch(() => false);
    const got = ok ? await dw.evaluate(() => [qn.picture.format.id, qn.picture.decoder, qn.picture.pages.length, qn.picture.pages[2].textLayer?.words.map((w) => w.text).join(' ')]) : await dw.evaluate(() => [...document.querySelectorAll('.ql-toast')].map((t) => t.textContent));
    check('desktop: a DjVu book opens through djvu-rs, with its text layer', got, ['djvu', 'djvu-rs', 4, 'Parish register 1851 Baptisms and burials']);
  } finally { await dApp.close().catch(() => undefined); }
  // A GEM IMG named .img (a name folder listings leave out) opened from the command line: identified by content, shown with its folder.
  const gemPath = join(base, 'scan.img'); writeFileSync(gemPath, readFileSync('tests/fixtures/historic/ximg4.img'));
  const gApp = await electron.launch({ executablePath: ELECTRON, args: ['--no-sandbox', APPDIR, gemPath], env: { ...process.env, XDG_CONFIG_HOME: config } });
  try {
    const gw = await gApp.firstWindow();
    const ok = await gw.waitForFunction(() => window.qn?.picture?.name === 'scan.img', null, { timeout: 60000 }).then(() => true).catch(() => false);
    const got = ok ? await gw.evaluate(() => [qn.picture.format.id, qn.picture.width, qn.picture.height, qn.folder.entries.some((e) => e.name === 'scan.img')]) : await gw.evaluate(() => [...document.querySelectorAll('.ql-toast')].map((t) => t.textContent));
    check('desktop: a GEM IMG named .img opens from the command line, in its folder', got, ['gem', 48, 20, true]);
  } finally { await gApp.close().catch(() => undefined); }
  // A JBIG2 page: pdf.js's JBIG2 WebAssembly decoder from the local runtime under the same policy.
  const jb2Path = join(base, 'scan.jb2'); writeFileSync(jb2Path, readFileSync('tests/fixtures/jbig/page.jb2'));
  const bApp = await electron.launch({ executablePath: ELECTRON, args: ['--no-sandbox', APPDIR, jb2Path], env: { ...process.env, XDG_CONFIG_HOME: config } });
  try {
    const bw = await bApp.firstWindow();
    const ok = await bw.waitForFunction(() => window.qn?.picture?.name === 'scan.jb2', null, { timeout: 60000 }).then(() => true).catch(() => false);
    const got = ok ? await bw.evaluate(() => [qn.picture.format.id, qn.picture.width, qn.picture.height]) : await bw.evaluate(() => [...document.querySelectorAll('.ql-toast')].map((t) => t.textContent));
    check('desktop: a JBIG2 file opens through pdf.js', got, ['jbig2', 320, 200]);
  } finally { await bApp.close().catch(() => undefined); }
  // A DICOM CT with JPEG 2000 pixel data: OpenJPEG's decode-only build imported from a Blob under the same policy, at full precision.
  const dcmPath = join(base, 'ct.dcm'); writeFileSync(dcmPath, readFileSync('tests/fixtures/dicom/693_J2KI.dcm'));
  const cApp = await electron.launch({ executablePath: ELECTRON, args: ['--no-sandbox', APPDIR, dcmPath], env: { ...process.env, XDG_CONFIG_HOME: config } });
  try {
    const cw = await cApp.firstWindow();
    const ok = await cw.waitForFunction(() => window.qn?.picture?.name === 'ct.dcm', null, { timeout: 60000 }).then(() => true).catch(() => false);
    const got = ok ? await cw.evaluate(() => { const c = qn.picture.frameCanvas(); return [qn.picture.format.id, qn.picture.width, qn.picture.height, c.getContext('2d').getImageData(256, 256, 1, 1).data[0], qn.picture.warnings, qn.picture.info.modality]; }) : await cw.evaluate(() => [...document.querySelectorAll('.ql-toast')].map((t) => t.textContent));
    check('desktop: a DICOM CT with JPEG 2000 pixel data opens through OpenJPEG at full precision', got, ['dicom', 512, 512, 108, [], 'CT']);
  } finally { await cApp.close().catch(() => undefined); }
  // A DLL named on the command line (programs are not listed in folders): its icons, one page each.
  const dllPath = join(base, 'shell.dll'); writeFileSync(dllPath, readFileSync('tests/fixtures/iconlib/icons32.dll'));
  const lApp = await electron.launch({ executablePath: ELECTRON, args: ['--no-sandbox', APPDIR, dllPath], env: { ...process.env, XDG_CONFIG_HOME: config } });
  try {
    const lw = await lApp.firstWindow();
    const ok = await lw.waitForFunction(() => window.qn?.picture?.name === 'shell.dll', null, { timeout: 60000 }).then(() => true).catch(() => false);
    const got = ok ? await lw.evaluate(() => [qn.picture.format.id, qn.picture.pages.length, qn.picture.pages[1].width]) : await lw.evaluate(() => [...document.querySelectorAll('.ql-toast')].map((t) => t.textContent));
    check('desktop: the icons in a DLL from the command line', got, ['winres', 3, 256]);
  } finally { await lApp.close().catch(() => undefined); }
  // An HTJ2K OpenEXR file: OpenJPH's classic script is imported as a module from a Blob under the same policy.
  const htPath = join(base, 'render.exr'); writeFileSync(htPath, readFileSync('tests/fixtures/exr/htj2k32.exr'));
  const hApp = await electron.launch({ executablePath: ELECTRON, args: ['--no-sandbox', APPDIR, htPath], env: { ...process.env, XDG_CONFIG_HOME: config } });
  try {
    const hw = await hApp.firstWindow();
    const ok = await hw.waitForFunction(() => window.qn?.picture?.name === 'render.exr', null, { timeout: 60000 }).then(() => true).catch(() => false);
    const got = ok ? await hw.evaluate(() => [qn.picture.format.id, qn.picture.width, qn.picture.height, /HTJ2K32/.test(qn.picture.current.notes.join(' '))]) : await hw.evaluate(() => [...document.querySelectorAll('.ql-toast')].map((t) => t.textContent));
    check('desktop: an HTJ2K OpenEXR file opens through OpenJPH', got, ['exr', 70, 50, true]);
  } finally { await hApp.close().catch(() => undefined); }
  // People on real files: the face models are served from 127.0.0.1 (as from the model host), three portraits are
  // scanned, a person is named, and the names go into the JPEG files as MWG face regions.
  const SFACE = 'node_modules/.cache/annes-lens-models/face_recognition_sface_2021dec_int8.onnx';
  if (!existsSync(SFACE)) throw new Error(`${SFACE} is missing: run python3 scripts/gen-people-fixtures.py (it downloads the face models)`);
  const faces = join(base, 'faces'); mkdirSync(faces, { recursive: true });
  for (const n of ['obama', 'both-2009', 'harris']) writeFileSync(join(faces, `${n}.jpg`), readFileSync(`tests/fixtures/people/${n}.jpg`));
  const models = { 'face_detection_yunet_2023mar.onnx': readFileSync('tests/fixtures/people/face_detection_yunet_2023mar.onnx'), 'face_recognition_sface_2021dec_int8.onnx': readFileSync(SFACE) };
  const srv = createServer((req, res) => { const b = models[req.url.split('/').pop()]; res.writeHead(b ? 200 : 404, { 'access-control-allow-origin': '*', 'content-type': 'application/octet-stream' }); res.end(b); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const mport = srv.address().port;
  const pa = await electron.launch({ executablePath: ELECTRON, args: ['--no-sandbox', APPDIR, join(faces, 'obama.jpg')], env: { ...process.env, XDG_CONFIG_HOME: config } });
  try {
    const pw = await pa.firstWindow(); await pw.waitForFunction(() => window.qn?.picture?.name === 'obama.jpg' && qn.folder.length === 3, null, { timeout: 30000 });
    const ppl = await pw.evaluate(async (port) => {
      const A = await window.__qnAi();
      A.device.setModelUrlOverride((spec, path) => `http://127.0.0.1:${port}/${path}`);
      for (const id of ['yunet', 'sface']) await A.device.ensureModel(A.device.modelById(id), 'quantized');
      await qn.exec('browse.people', { enable: true, forget: true });
      const rep = await qn.exec('browse.people', { scan: 'folder' });
      const groups = await qn.exec('browse.people', { list: true });
      const g = groups.findIndex((x) => x.files.includes('obama.jpg'));
      await qn.exec('browse.people', { name: { group: g, name: 'Barack Obama', externalId: '@I1@' } });
      return { rep: [rep.pictures, rep.faces, rep.failed], groups: groups.map((x) => x.files.slice().sort().join(',')).sort() };
    }, mport);
    // Writing into both-2009.jpg (not opened one by one) asks once for the folder: first "Don't Allow", then "Allow".
    const answer = (n) => pa.evaluate(({ dialog }, n) => { globalThis.__asked = 0; dialog.showMessageBox = async (_w, o) => { globalThis.__asked++; globalThis.__msg = o.message; return { response: n }; }; }, n);
    await answer(1);
    const refused = await pw.evaluate(() => qn.exec('browse.people', { write: true }));
    const asked1 = await pa.evaluate(() => [globalThis.__asked, globalThis.__msg]), untouched = !readFileSync(join(faces, 'both-2009.jpg')).toString('latin1').includes('Barack Obama');
    await answer(0);
    ppl.wrote = await pw.evaluate(() => qn.exec('browse.people', { write: true }));
    await pw.evaluate(() => qn.exec('browse.people', { write: true }));
    const asked2 = await pa.evaluate(() => globalThis.__asked);
    check('desktop people: changing unopened pictures asks once per folder; refusing leaves them alone', [refused, asked1, untouched, asked2], [{ pictures: 1, unreachable: 0 }, [1, 'Allow Anne\'s Lens to change the pictures in “faces”?'], true, 1]);
    const regionsIn = (n) => { const t = readFileSync(join(faces, n)).toString('latin1'); return [/mwg-rs:Regions/.test(t), /Barack Obama/.test(t)]; };
    check('desktop people: scan, group, and write the names into the JPEG files', [ppl.rep, ppl.groups, ppl.wrote, regionsIn('obama.jpg'), regionsIn('both-2009.jpg'), regionsIn('harris.jpg')],
      [[3, 4, []], ['both-2009.jpg', 'both-2009.jpg,obama.jpg', 'harris.jpg'], { pictures: 2, unreachable: 0 }, [true, true], [true, true], [false, false]], JSON.stringify(ppl));
  } finally { await pa.close().catch(() => undefined); srv.close(); }
} finally {
  rmSync(base, { recursive: true, force: true });
}
if (failures.length) { console.error('Desktop e2e failures:\n' + failures.join('\n')); process.exit(1); }
console.log('Desktop e2e passed');
