// Anne's Lens desktop app (Windows, macOS, Linux, Raspberry Pi OS): Electron main process.
//
// The web build (dist/) is served from the privileged app:// scheme so module workers, fetch and
// IndexedDB behave as on the web. The renderer is sandboxed with context isolation and no Node;
// electron/preload.cjs exposes `window.quillDesktop`, the same interface as the Android plugin plus
// what a file system allows: listing the folder of an opened picture (next/previous), opening a
// folder, Show in Folder, Open With, window placement and portable mode.
// File access is limited to files the user opened or saved through a dialog, opened the app with, or
// that sit in a folder the user opened, so picture content cannot use the bridge to read arbitrary files.
'use strict';
const { app, BrowserWindow, protocol, net, ipcMain, dialog, shell, clipboard, powerSaveBlocker, Menu, session, desktopCapturer, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL, fileURLToPath } = require('node:url');

// Portable mode: a QuillLens-portable folder beside the program (or beside the portable .exe) holds the
// user data instead of the profile. docs: File ▸ Portable Mode.
const PORTABLE_NAME = 'QuillLens-portable';
const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
const portableDir = path.join(exeDir, PORTABLE_NAME);
const portableOn = fs.existsSync(portableDir) && fs.statSync(portableDir).isDirectory();
if (portableOn) app.setPath('userData', portableDir);
else app.setPath('userData', path.join(app.getPath('appData'), 'QuillLens'));
app.setPath('sessionData', app.getPath('userData'));

const DIST = path.join(__dirname, '..', 'dist');
const SCHEME = 'app';
const ORIGIN = `${SCHEME}://quilllens`;
const OPENABLE = ['jpg', 'jpeg', 'jpe', 'jfif', 'png', 'apng', 'gif', 'webp', 'avif', 'heic', 'heif', 'hif', 'bmp', 'dib', 'rle', 'ico', 'cur', 'tif', 'tiff', 'svg', 'svgz', 'jxl', 'psd', 'psb', 'tga', 'tpic', 'icb', 'vda', 'vst',
  'pnm', 'ppm', 'pgm', 'pbm', 'pam', 'pfm', 'qoi', 'pcx', 'dcx', 'xpm', 'xbm', 'wbmp', 'icns', 'dds', 'hdr', 'pic', 'rgbe',
  'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf', 'orf', 'rw2', 'rwl', 'pef', 'dng', '3fr', 'fff', 'iiq', 'x3f', 'srw', 'mrw', 'erf', 'mef', 'mos', 'kdc', 'dcr', 'raw', 'eps', 'epsf', 'ai', 'djvu', 'djv', 'pct', 'pict', 'ras', 'sun', 'im1', 'im8', 'im24', 'im32', 'sgi', 'rgb', 'rgba', 'bw', 'urt', 'pi1', 'pi2', 'pi3', 'pc1', 'pc2', 'pc3', 'neo', 'spu', 'koa', 'kla', 'art', 'aas', 'ximg', 'msp', 'fpx', 'fli', 'flc', 'flx', 'clp', 'jbg', 'jbig', 'bie', 'jb2', 'jbig2', 'psp', 'pspimage', 'tub', 'icl', 'cdr', 'cpt', 'iff', 'ilbm', 'lbm', 'ham', 'ham8', 'mac', 'pntg', 'pnt', 'pcd', 'exr', 'jp2', 'jpx', 'jpf', 'jph', 'j2k', 'j2c', 'jpc', 'jhc', 'wmf', 'emf', 'wmz', 'emz', 'zip', 'cbz', 'epub', '7z', 'cb7', 'rar', 'cbr', 'tar', 'cbt', 'tgz', 'tbz', 'tbz2', 'txz', 'gz', 'bz2', 'xz', 'pdf', 'dcm', 'dicom', 'fits', 'fit', 'fts',
  'mp4', 'm4v', 'mov', 'qt', '3gp', '3g2', 'webm', 'mkv', 'ogv', 'avi', 'mp3', 'mp2', 'm4a', 'm4b', 'aac', 'flac', 'wav', 'wave', 'ogg', 'oga', 'opus', 'spx', 'aif', 'aiff', 'aifc', 'mka', 'weba'];
const MIME = {
  dcm: 'application/dicom', dicom: 'application/dicom', fits: 'image/fits', fit: 'image/fits', fts: 'image/fits',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', qt: 'video/quicktime', '3gp': 'video/3gpp', '3g2': 'video/3gpp2', webm: 'video/webm', mkv: 'video/x-matroska', ogv: 'video/ogg', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', mp2: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', wave: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', spx: 'audio/ogg', aif: 'audio/aiff', aiff: 'audio/aiff', aifc: 'audio/aiff', mka: 'audio/x-matroska', weba: 'audio/webm',
  pdf: 'application/pdf', djvu: 'image/vnd.djvu', djv: 'image/vnd.djvu', pct: 'image/x-pict', pict: 'image/x-pict', ras: 'image/x-sun-raster', sun: 'image/x-sun-raster', im1: 'image/x-sun-raster', im8: 'image/x-sun-raster', im24: 'image/x-sun-raster', im32: 'image/x-sun-raster', sgi: 'image/sgi', rgb: 'image/sgi', rgba: 'image/sgi', bw: 'image/sgi', urt: 'image/x-utah-rle', msp: 'image/x-msp', fpx: 'image/vnd.fpx', fli: 'video/x-flic', flc: 'video/x-flic', flx: 'video/x-flic', clp: 'application/x-ms-clipboard', jbg: 'image/jbig', jbig: 'image/jbig', bie: 'image/jbig', jb2: 'image/x-jbig2', jbig2: 'image/x-jbig2', psp: 'image/x-paintshoppro', pspimage: 'image/x-paintshoppro', tub: 'image/x-paintshoppro', cdr: 'application/vnd.corel-draw', cpt: 'image/x-corelphotopaint', iff: 'image/x-ilbm', ilbm: 'image/x-ilbm', lbm: 'image/x-ilbm', ham: 'image/x-ilbm', ham8: 'image/x-ilbm', mac: 'image/x-macpaint', pntg: 'image/x-macpaint', pnt: 'image/x-macpaint', pcd: 'image/x-photo-cd', exr: 'image/x-exr', jp2: 'image/jp2', jpx: 'image/jpx', jpf: 'image/jpx', jph: 'image/jph', j2k: 'image/j2c', j2c: 'image/j2c', jpc: 'image/j2c', jhc: 'image/jhc', wmf: 'image/wmf', emf: 'image/emf', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', apng: 'image/apng', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif', hif: 'image/heif',
  bmp: 'image/bmp', dib: 'image/bmp', rle: 'image/bmp', ico: 'image/x-icon', cur: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml', svgz: 'image/svg+xml', jxl: 'image/jxl', psd: 'image/vnd.adobe.photoshop', psb: 'image/vnd.adobe.photoshop', tga: 'image/x-tga',
  pnm: 'image/x-portable-anymap', ppm: 'image/x-portable-pixmap', pgm: 'image/x-portable-graymap', pbm: 'image/x-portable-bitmap', pam: 'image/x-portable-anymap', pfm: 'image/x-portable-floatmap', qoi: 'image/qoi', pcx: 'image/x-pcx', dcx: 'image/x-pcx',
  xpm: 'image/x-xpixmap', xbm: 'image/x-xbitmap', wbmp: 'image/vnd.wap.wbmp', icns: 'image/icns', dds: 'image/vnd-ms.dds', hdr: 'image/vnd.radiance', pic: 'image/vnd.radiance', rgbe: 'image/vnd.radiance', dng: 'image/x-adobe-dng', eps: 'application/postscript', epsf: 'application/postscript', ai: 'application/postscript', zip: 'application/zip', cbz: 'application/vnd.comicbook+zip',
};

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

// Command line (cli.cjs): --help, --version and usage errors answer in the terminal and exit; --convert
// runs without a window (and alongside a running copy); --fullscreen and --slideshow apply at start-up.
const { parseCli, usageText } = require('./cli.cjs');
const cliArgv = process.argv.slice(1);
if (process.defaultApp) { const i = cliArgv.findIndex((a) => !String(a).startsWith('-')); if (i >= 0) cliArgv.splice(i, 1); } // `electron <app folder> …`
const cli = parseCli(cliArgv);
if (cli.help || cli.version || cli.errors.length) {
  if (cli.errors.length) process.stderr.write(cli.errors.map((e) => `annes-lens: ${e}\n`).join('') + 'Run annes-lens --help for the options.\n');
  else process.stdout.write(cli.help ? usageText(app.getVersion()) : `${app.getVersion()}\n`);
  process.exit(cli.errors.length ? 2 : 0);
}
const cliConvert = cli.convert !== undefined;
if (!cliConvert && !app.requestSingleInstanceLock()) app.quit();

/** @type {BrowserWindow | null} */
let win = null;
/** Files opened before the page could receive them. Flushed when the page registers its fileOpened listener. */
const pendingFiles = [];
let rendererReady = false;
let wakeId = -1;

// ------------------------------------------------------------------------------------------
// Files and folders the renderer may read

const grantsFile = () => path.join(app.getPath('userData'), 'granted-files.json');
let grants = new Set();
/** Folders opened through a dialog or by opening a picture: every picture in them may be read. */
const grantedDirs = new Set();
// Folders the user chose to keep (catalog, favorites, watch folders, backup targets) stay readable
// after a restart; programs picked through the dialog are the only ones External Tools may start.
const foldersFile = () => path.join(app.getPath('userData'), 'remembered-folders.json');
const programsFile = () => path.join(app.getPath('userData'), 'programs.json');
// Remembered folders the user had picked in a folder dialog (or allowed when asked): written into again after a restart.
const writableFile_ = () => path.join(app.getPath('userData'), 'writable-folders.json');
let remembered = new Set(), programs = new Set(), rememberedWritable = new Set();
const readSet = (f) => { try { return new Set(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch { return new Set(); } };
const writeSet = (f, s) => { try { fs.writeFileSync(f, JSON.stringify([...s].slice(-500))); } catch { /* read-only profile */ } };
function loadGrants() {
  remembered = readSet(foldersFile()); programs = readSet(programsFile()); rememberedWritable = readSet(writableFile_());
  for (const d of remembered) grantedDirs.add(d);
  for (const d of rememberedWritable) if (remembered.has(d)) writableDirs.add(d);
  try { grants = new Set(JSON.parse(fs.readFileSync(grantsFile(), 'utf8'))); } catch { grants = new Set(); }
}
function grant(p) {
  grants.add(path.resolve(p));
  const list = [...grants].slice(-400);
  grants = new Set(list);
  try { fs.writeFileSync(grantsFile(), JSON.stringify(list)); } catch { /* read-only profile */ }
}
/** Whether `p` is `root` or inside it (names compared without case on Windows). */
function inside(p, root) {
  const norm = (x) => (process.platform === 'win32' ? path.resolve(x).toLowerCase() : path.resolve(x));
  const a = norm(p), b = norm(root);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}
/**
 * The app's own data folder: which folders are remembered, which programs External Tools may start, the stored keys.
 * The page reaches other folders by moving up and down from the ones the user opened; it never reaches this one that
 * way, and never writes into it.
 */
const isProtected = (dir) => inside(dir, app.getPath('userData'));
/** Lets the page read the pictures of a folder. `chosen`: the user named this folder (a dialog, the command line, a file opened from the system), which is the only way to the app's own data folder. */
function grantDir(dir, chosen = false) { const d = path.resolve(dir); if (!chosen && isProtected(d)) return false; grantedDirs.add(d); return true; }
// Folders that may be written into: their existing pictures (and .xmp sidecars) changed, files saved, copied or moved
// into them, subfolders made. Being able to read a folder is not enough (the page can read its way up and down the
// folder tree): these are the folders the user picked in a folder dialog and the ones they allowed when asked, until
// the app closes; a remembered folder is written into again after a restart only if it was writable when it was
// remembered (the page can ask to remember any folder it can read). Opening one picture grants only that file;
// anything else in its folder asks once per folder in a native dialog, which the page cannot answer for the user.
const writableDirs = new Set();
const asking = new Map();
/** Asks, once per folder at a time, whether the folder may be written into; the answer holds until the app closes. */
function allowFolder(dir, title, message, detail) {
  if (writableDirs.has(dir)) return Promise.resolve(true);
  if (!asking.has(dir)) asking.set(dir, dialog.showMessageBox(win, { type: 'question', buttons: ['Allow', 'Don\'t Allow'], defaultId: 0, cancelId: 1, noLink: true, title, message, detail })
    .then((r) => { const ok = r.response === 0; if (ok) writableDirs.add(dir); return ok; }).finally(() => asking.delete(dir)));
  return asking.get(dir);
}
/** A folder the page may write into: one it can read, that is not the app's own, and that the user picked or allows now. */
async function writableDir(dirUri) {
  const dir = grantedDir(dirUri);
  if (isProtected(dir)) throw new Error('Anne\'s Lens does not write into its own settings folder.');
  if (writableDirs.has(dir)) return dir;
  const ok = await allowFolder(dir, 'Save into this folder?', `Allow Anne's Lens to save files into “${path.basename(dir) || dir}”?`,
    `${dir}\n\nNeeded to save, copy or move files into a folder you did not choose in a folder dialog. The permission lasts until Anne's Lens closes.`);
  if (!ok) throw new Error('Saving into this folder was not allowed.');
  return dir;
}
async function writableFile(uri) {
  try { return grantedPath(uri, true); } catch (e) {
    if (typeof uri !== 'string' || !uri.startsWith('file:')) throw e;
    const p = path.resolve(fileURLToPath(uri)), dir = path.dirname(p);
    if (!grantedDirs.has(dir) || !(isPictureName(p) || /\.xmp$/i.test(p)) || !fs.existsSync(p)) throw e;
    if (isProtected(dir)) throw e;
    const ok = await allowFolder(dir, 'Change pictures in this folder?', `Allow Anne's Lens to change the pictures in “${path.basename(dir) || dir}”?`,
      `${dir}\n\nNeeded to write into pictures you did not open one by one (names, keywords, ratings or other metadata). The permission lasts until Anne's Lens closes.`);
    if (!ok) throw new Error('Changing the pictures in this folder was not allowed.');
    return p;
  }
}
function grantedPath(uri, write = false) {
  if (typeof uri !== 'string' || !uri.startsWith('file:')) throw new Error('Not a file address');
  const p = path.resolve(fileURLToPath(uri));
  if (grants.has(p)) return p;
  if (!write && grantedDirs.has(path.dirname(p)) && (isPictureName(p) || listedFiles.has(p))) return p;
  throw new Error('Anne\'s Lens has no permission for this file; open it again.');
}
const isPictureName = (p) => OPENABLE.includes(path.extname(p).slice(1).toLowerCase());
// Extensions pictures share with other files (GEM IMG and disk images, Doodle and dumps, SGI .int): not listed in
// folders, but a file named on the command line or chosen in the open dialog is passed on (up to 16 MB) for the
// app to identify by content.
const SHARED = ['img', 'dd', 'ddl', 'int', 'inta', 'exe', 'dll', 'ocx', 'cpl', 'scr', 'mun'];
const sharedMax = (p) => (/\.(exe|dll|ocx|cpl|scr|mun)$/i.test(p) ? 256 : 16) * 1024 * 1024; // programs: opened for their icons
const isSharedName = (p) => SHARED.includes(path.extname(p).slice(1).toLowerCase());

function fileResult(p) {
  const data = fs.readFileSync(p);
  const st = fs.statSync(p);
  const ext = path.extname(p).slice(1).toLowerCase();
  return { uri: pathToFileURL(p).href, name: path.basename(p), mime: MIME[ext] || 'application/octet-stream', data: data.toString('base64'), size: st.size, mtime: st.mtimeMs };
}
/** The picture files in a folder, natural-sorted, as {uri, name, size, mtime}. */
// Next / Previous Folder walk the folder tree the user is browsing: each folder reached that way is
// granted for listing and reading pictures (as when its pictures are opened), never for writing.
function listSubdirs(dir) {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const p = path.join(dir, name);
    try { if (fs.statSync(p).isDirectory()) out.push({ uri: pathToFileURL(p).href, name, p }); } catch { /* unreadable */ }
  }
  out.sort((a, b) => collator.compare(a.name, b.name));
  return out.filter(({ p }) => grantDir(p)).map(({ uri, name }) => ({ uri, name })); // the app's own data folder is not among them
}
function grantedDir(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file:')) throw new Error('Not a file address');
  const dir = path.resolve(fileURLToPath(uri));
  if (!grantedDirs.has(dir)) throw new Error('Anne\'s Lens has no permission for this folder; open it first.');
  return dir;
}
// Files other than pictures listed for Show All Files may be read (to show them as text or hex).
const listedFiles = new Set();
function listDir(dir, all = false) {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.') || (!all && !isPictureName(name))) continue;
    const p = path.join(dir, name);
    try { const st = fs.statSync(p); if (st.isFile()) { out.push({ uri: pathToFileURL(p).href, name, size: st.size, mtime: st.mtimeMs }); if (all && !isPictureName(name)) listedFiles.add(path.resolve(p)); } } catch { /* */ }
  }
  out.sort((a, b) => collator.compare(a.name, b.name));
  return out;
}
function filesFromArgs(argv) {
  const out = [];
  for (const a of argv.slice(1)) {
    if (!a || a.startsWith('-')) continue;
    try { if (fs.statSync(a).isFile() && (isPictureName(a) || !path.extname(a) || (isSharedName(a) && fs.statSync(a).size <= sharedMax(a)))) out.push(path.resolve(a)); else if (fs.statSync(a).isDirectory()) { for (const e of listDir(a)) out.push(fileURLToPath(e.uri)); } } catch { /* not a file */ }
  }
  return out;
}
function openExternalFiles(paths) {
  if (!paths.length) return;
  for (const p of paths) { grant(p); grantDir(path.dirname(p), true); }
  if (win && rendererReady) win.webContents.send('ql:fileOpened', { files: paths.map(fileResult) });
  else pendingFiles.push(...paths);
  if (!win && app.isReady()) createWindow();
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
}
function flushPendingFiles() {
  if (win && rendererReady && pendingFiles.length) { const list = pendingFiles.splice(0); win.webContents.send('ql:fileOpened', { files: list.map(fileResult) }); }
}

// ------------------------------------------------------------------------------------------
// IPC

// What a page starts and only that page can stop (sharing rooms, the phone remote) ends when the page goes away: the
// window closes, is made again for Frameless, or reloads. Otherwise the room keeps serving, and taking uploads, with
// nothing on screen saying so.
const pageServices = [];
function endPageServices() { for (const end of pageServices) { try { end(); } catch { /* already gone */ } } }

const safeUrl = (u) => typeof u === 'string' && /^(https?|mailto|tel|ftp|sms|geo):/i.test(u.trim());
function handle(name, fn) {
  ipcMain.handle('ql:' + name, async (e, opts) => {
    if (!win || e.sender !== win.webContents || !e.senderFrame || !e.senderFrame.url.startsWith(ORIGIN)) throw new Error('Refused');
    return fn(opts || {});
  });
}

function registerIpc() {
  handle('openDocument', async ({ multiple }) => {
    const r = await dialog.showOpenDialog(win, {
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [{ name: 'Pictures', extensions: [...OPENABLE, ...SHARED] }, { name: 'All files', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    for (const p of r.filePaths) { grant(p); grantDir(path.dirname(p), true); }
    if (r.filePaths.length > 1) return { files: r.filePaths.map(fileResult) };
    return fileResult(r.filePaths[0]);
  });
  handle('openFolder', async ({ all }) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    const dir = r.filePaths[0];
    grantDir(dir, true);
    return { uri: pathToFileURL(dir).href, name: path.basename(dir) || dir, entries: listDir(dir, !!all) };
  });
  handle('listFolder', async ({ uri, all }) => {
    if (typeof uri !== 'string' || !uri.startsWith('file:')) throw new Error('Not a file address');
    let p = path.resolve(fileURLToPath(uri));
    let dir = p;
    // A file's address lists the folder it is in; a folder that is gone (an unplugged drive) is an error, never its parent's listing.
    let st = null; try { st = fs.statSync(p); } catch { st = null; }
    if (st ? !st.isDirectory() : grants.has(p)) dir = path.dirname(p); // also a granted file that is gone now
    else if (!st) throw new Error('This folder is not available (a drive that is not connected?).');
    if (!grantedDirs.has(dir) && !grants.has(p)) throw new Error('Anne\'s Lens has no permission for this folder; open a picture in it first.');
    grantDir(dir);
    return { uri: pathToFileURL(dir).href, name: path.basename(dir) || dir, entries: listDir(dir, !!all) };
  });
  // Phone Remote (slideshows): commands from the phone go to the page as 'remoteCommand' events.
  let remote = null;
  handle('remoteStart', async ({ port }) => {
    if (!remote) remote = await require('./remote.cjs').startRemote((cmd) => { if (win && !win.isDestroyed()) win.webContents.send('ql:remoteCommand', { cmd }); }, Number(port) || 0);
    return { urls: remote.urls, port: remote.port };
  });
  handle('remoteStop', async () => { if (remote) { remote.stop(); remote = null; } return { ok: true }; });
  handle('remoteState', async (state) => { if (remote) remote.setState(state); return { ok: true }; });
  pageServices.push(() => { if (remote) { remote.stop(); remote = null; } });
  app.on('before-quit', () => { if (remote) remote.stop(); });
  // Network sharing (shared views and albums): one server for every room, started when first needed.
  let share = null; const shares = new Map();
  const shareServer = async () => share || (share = await require('./netshare.cjs').startShare(0));
  handle('shareStart', async ({ kind }) => {
    const s = await shareServer(); const room = kind === 'album' ? s.album({}) : s.view(); shares.set(room.token, room);
    return { token: room.token, urls: room.urls, port: s.port };
  });
  handle('shareState', async ({ token, state }) => { const r = shares.get(String(token)); if (r && r.setState) r.setState(state && typeof state === 'object' ? state : {}); return { ok: !!r }; });
  handle('shareAlbum', async ({ token, name, items, contribute, contribDir }) => {
    const r = shares.get(String(token)); if (!r || !r.update) return { ok: false, servable: 0 };
    let dir = null; if (contribute && contribDir) { try { dir = grantedDir(contribDir); if (!writableDirs.has(path.resolve(dir))) dir = null; } catch { dir = null; } }
    const mapped = (Array.isArray(items) ? items : []).slice(0, 5000).map((it) => {
      let p = null; try { p = it.uri ? grantedPath(String(it.uri)) : null; } catch { p = null; }
      const ext = path.extname(String(it.name || '')).slice(1).toLowerCase();
      return { id: String(it.id), name: String(it.name || 'picture'), size: it.size, mtime: it.mtime, mime: MIME[ext] || 'application/octet-stream', thumb: typeof it.thumb === 'string' && it.thumb.startsWith('data:image/') ? it.thumb : null, path: p };
    });
    r.update({ name: String(name || ''), items: mapped, contribute: !!dir, contribDir: dir, onAdded: (f) => { grant(f.path); if (win && !win.isDestroyed()) win.webContents.send('ql:shareAdded', { token, uri: pathToFileURL(f.path).href, name: f.name, size: f.size }); } });
    return { ok: true, servable: mapped.filter((m) => m.path).length, contribute: !!dir };
  });
  handle('shareStop', async ({ token }) => { const r = shares.get(String(token)); if (r) { r.stop(); shares.delete(String(token)); } if (!shares.size && share) { share.stop(); share = null; } return { ok: true }; });
  pageServices.push(() => { for (const r of shares.values()) r.stop(); shares.clear(); if (share) { share.stop(); share = null; } });
  app.on('before-quit', () => { if (share) share.stop(); });
  handle('cliJob', async () => { const j = cliJob; if (j && j.mode === 'view') cliJob = null; return j; });
  handle('listSubfolders', async ({ uri }) => ({ folders: listSubdirs(grantedDir(uri)) }));
  handle('parentFolder', async ({ uri }) => {
    const dir = grantedDir(uri), parent = path.dirname(dir);
    if (parent === dir) return null;
    // Going up stops at the home folder: what is above it (other people's folders, the system) is reached only by opening it.
    const home = require('node:os').homedir();
    if (inside(dir, home) && !inside(parent, home)) return null;
    if (!grantDir(parent)) return null;
    return { uri: pathToFileURL(parent).href, name: path.basename(parent) || parent };
  });
  handle('listDisplays', async () => {
    const { screen } = require('electron');
    const cur = win ? screen.getDisplayMatching(win.getBounds()).id : null, primary = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d, i) => ({ id: d.id, label: d.label || `Display ${i + 1}`, bounds: d.bounds, primary: d.id === primary, current: d.id === cur }));
  });
  handle('moveToDisplay', async ({ id, fullScreen }) => {
    const { screen } = require('electron');
    const d = screen.getAllDisplays().find((x) => x.id === id);
    if (!d || !win) return { ok: false };
    if (win.isFullScreen()) win.setFullScreen(false);
    if (!restoreBounds) restoreBounds = win.getBounds();
    const b = win.getBounds(), wa = d.workArea, width = Math.min(b.width, wa.width), height = Math.min(b.height, wa.height);
    win.setBounds({ x: wa.x + Math.round((wa.width - width) / 2), y: wa.y + Math.round((wa.height - height) / 2), width, height });
    if (fullScreen) win.setFullScreen(true); else restoreBounds = null;
    return { ok: true };
  });
  handle('setFrameless', async ({ on, reopen }) => {
    saveWindowPrefs({ frameless: !!on });
    if (!!on === frameless || !win) return { ok: true };
    // The frame is fixed when a window is made: open a new one in the same place and close this one.
    const old = win, bounds = old.isMaximized() || old.isFullScreen() ? null : old.getBounds();
    if (typeof reopen === 'string' && reopen.startsWith('file:')) { try { pendingFiles.push(grantedPath(reopen)); } catch { /* no longer allowed */ } }
    rendererReady = false;
    endPageServices(); // the page that shared is going away with its window
    createWindow(bounds || undefined);
    old.destroy();
    return { ok: true };
  });
  handle('windowControl', async ({ action }) => {
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
    else if (action === 'close') win.close();
    else if (action === 'leaveFullScreen' && win.isFullScreen()) win.setFullScreen(false);
    return { maximized: win.isMaximized(), frameless, fullScreen: win.isFullScreen() };
  });
  handle('saveAs', async ({ name, data }) => {
    const ext = path.extname(String(name || '')).slice(1);
    const r = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath('pictures'), path.basename(String(name || 'picture'))),
      filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All files', extensions: ['*'] }] : undefined,
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    fs.writeFileSync(r.filePath, Buffer.from(String(data || ''), 'base64'));
    grant(r.filePath); grantDir(path.dirname(r.filePath), true);
    return { uri: pathToFileURL(r.filePath).href, name: path.basename(r.filePath) };
  });
  handle('writeUri', async ({ uri, data }) => {
    const p = await writableFile(uri);
    const tmp = p + '.ql-saving';
    fs.writeFileSync(tmp, Buffer.from(String(data || ''), 'base64'));
    fs.renameSync(tmp, p);
    return { ok: true };
  });
  handle('readUri', async ({ uri }) => fileResult(grantedPath(uri)));
  handle('print', async () => new Promise((res) => win.webContents.print({}, () => res())));
  handle('share', async ({ name, data }) => {
    // Desktops have no share sheet: offer Save As.
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('pictures'), path.basename(String(name || 'picture'))) });
    if (!r.canceled && r.filePath) { fs.writeFileSync(r.filePath, Buffer.from(String(data || ''), 'base64')); grant(r.filePath); }
  });
  handle('getLaunchFile', async () => {
    const list = pendingFiles.splice(0);
    if (!list.length) return {};
    const files = list.map(fileResult);
    return { ...files[0], files };
  });
  ipcMain.on('ql:fileListenerReady', (e) => { if (win && e.sender === win.webContents) { rendererReady = true; flushPendingFiles(); } });
  handle('keepAwake', async ({ on }) => {
    if (on && wakeId < 0) wakeId = powerSaveBlocker.start('prevent-display-sleep');
    if (!on && wakeId >= 0) { powerSaveBlocker.stop(wakeId); wakeId = -1; }
  });
  handle('readClipboard', async () => ({ text: clipboard.readText() }));
  // Secrets (AI service keys): encrypted by the OS credential store through safeStorage, kept in secrets.json beside the settings.
  const secretsFile = () => path.join(app.getPath('userData'), 'secrets.json');
  const readSecrets = () => { try { const s = JSON.parse(fs.readFileSync(secretsFile(), 'utf8')); return s && typeof s === 'object' ? s : {}; } catch { return {}; } };
  const writeSecrets = (s) => fs.writeFileSync(secretsFile(), JSON.stringify(s), { mode: 0o600 });
  const secretName = (n) => { if (typeof n !== 'string' || !/^[\w.-]{1,64}$/.test(n)) throw new Error('Bad secret name'); return n; };
  handle('secretInfo', async () => ({ available: safeStorage.isEncryptionAvailable(), backend: process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function' ? safeStorage.getSelectedStorageBackend() : process.platform }));
  // Without an OS credential store (a Linux desktop with no keyring), the value is kept as is in the file, marked, and the app says so.
  handle('secretGet', async ({ name }) => { const s = readSecrets(), v = s[secretName(name)]; if (typeof v !== 'string') return { value: null }; if (v.startsWith('plain:')) return { value: Buffer.from(v.slice(6), 'base64').toString('utf8') }; try { return { value: safeStorage.decryptString(Buffer.from(v, 'base64')) }; } catch { return { value: null }; } });
  handle('secretSet', async ({ name, value }) => { const s = readSecrets(), v = String(value ?? ''); s[secretName(name)] = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(v).toString('base64') : 'plain:' + Buffer.from(v, 'utf8').toString('base64'); writeSecrets(s); return {}; });
  handle('secretDelete', async ({ name }) => { const s = readSecrets(); delete s[secretName(name)]; writeSecrets(s); return {}; });
  handle('writeClipboard', async ({ text }) => { clipboard.writeText(String(text ?? '')); });
  handle('openExternal', async ({ url }) => { if (safeUrl(url)) await shell.openExternal(url); });
  handle('revealInFolder', async ({ uri }) => { shell.showItemInFolder(grantedPath(uri)); });
  handle('openWith', async ({ uri }) => { const err = await shell.openPath(grantedPath(uri)); return err ? { ok: false, error: err } : { ok: true }; });
  handle('setAlwaysOnTop', async ({ on }) => { if (win) win.setAlwaysOnTop(!!on); });
  handle('minimize', async () => { if (win) win.minimize(); });
  handle('fitWindow', async ({ width, height }) => {
    if (!win) return;
    const { screen } = require('electron');
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    win.setContentSize(Math.max(360, Math.min(area.width, Math.round(width))), Math.max(300, Math.min(area.height, Math.round(height))));
  });
  handle('getArgs', async () => ({ args: process.argv.slice(1) }));

  // File operations (M2). Every source must be a granted file; every destination a granted folder.
  const grantedDir = (uri) => {
    if (typeof uri !== 'string' || !uri.startsWith('file:')) throw new Error('Not a folder address');
    const dir = path.resolve(fileURLToPath(uri));
    if (!grantedDirs.has(dir)) throw new Error('Anne\'s Lens has no permission for this folder; choose it again.');
    return dir;
  };
  const safeName = (name) => { const n = path.basename(String(name || '')).trim(); if (!n || n === '.' || n === '..' || /[\\/:*?"<>|\0]/.test(n)) throw new Error('That is not a valid file name.'); return n; };
  // Names that start with a dot are hidden files and folders: shell start-up files, settings folders. The page makes none
  // (Batch Rename's own short-lived names aside) and is not led into existing ones.
  const visibleName = (name, allow) => { const n = safeName(name); if (n.startsWith('.') && !(allow && allow.test(n))) throw new Error('A name cannot start with a dot.'); return n; };
  const freeName = (dir, name, allowSame) => {
    if (allowSame || !fs.existsSync(path.join(dir, name))) return name;
    const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
    for (let i = 2; i < 10000; i++) { const n = `${base} (${i})${ext}`; if (!fs.existsSync(path.join(dir, n))) return n; }
    throw new Error('No free file name');
  };
  const done = (p) => { grant(p); grantDir(path.dirname(p)); return { uri: pathToFileURL(p).href, name: path.basename(p) }; };
  const sameFile = (a, b) => { try { const x = fs.statSync(a), y = fs.statSync(b); return x.ino === y.ino && x.dev === y.dev && (x.ino !== 0 || a.toLowerCase() === b.toLowerCase()); } catch { return false; } };
  handle('renameDocument', async ({ uri, name }) => {
    const p = grantedPath(uri, true);
    const target = path.join(path.dirname(p), visibleName(name, /^\.ql-batch-\d+-\d+\.[A-Za-z0-9]+$/));
    if (target !== p && fs.existsSync(target) && !sameFile(p, target)) throw new Error(`A file named "${path.basename(target)}" already exists.`); // a case-only rename is the same file on case-insensitive disks, another file elsewhere
    fs.renameSync(p, target);
    return done(target);
  });
  handle('deleteDocument', async ({ uri, permanent }) => {
    const p = grantedPath(uri, true);
    if (permanent) { fs.unlinkSync(p); return { ok: true, trashed: false }; }
    try { await shell.trashItem(p); return { ok: true, trashed: true }; }
    catch (e) { throw new Error(`Could not move the file to the ${process.platform === 'win32' ? 'Recycle Bin' : 'Trash'}: ${e && e.message ? e.message : e}`); }
  });
  handle('pickFolder', async ({ title }) => {
    const r = await dialog.showOpenDialog(win, { title: String(title || 'Choose a folder'), properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    const dir = r.filePaths[0];
    grantDir(dir, true); writableDirs.add(path.resolve(dir));
    return { uri: pathToFileURL(dir).href, name: path.basename(dir) || dir };
  });
  const transfer = (move) => async ({ uri, dirUri, name }) => {
    const p = grantedPath(uri, true);
    const dir = await writableDir(dirUri);
    const target = path.join(dir, freeName(dir, visibleName(name || path.basename(p)), false));
    if (move) { try { fs.renameSync(p, target); } catch { fs.copyFileSync(p, target, fs.constants.COPYFILE_EXCL); fs.unlinkSync(p); } }
    else fs.copyFileSync(p, target, fs.constants.COPYFILE_EXCL);
    return done(target);
  };
  handle('moveFile', transfer(true));
  handle('copyFile', transfer(false));
  handle('createInFolder', async ({ dirUri, name, data, ifExists }) => {
    const dir = await writableDir(dirUri); name = visibleName(name);
    const bytes = Buffer.from(String(data || ''), 'base64');
    if (ifExists === 'rename') { // never replace a file: the next free "name (2).ext", created exclusively
      for (let attempt = 0; attempt < 5; attempt++) {
        const target = path.join(dir, freeName(dir, safeName(name), false));
        try { fs.writeFileSync(target, bytes, { flag: 'wx' }); return done(target); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      }
      throw new Error(`No free name for "${name}".`);
    }
    const target = path.join(dir, safeName(name));
    fs.writeFileSync(target, bytes);
    return done(target);
  });
  // Open URL: fetched here so picture hosts need no CORS headers; the renderer gets bytes and a name.
  handle('fetchUrl', async ({ url }) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('Only http(s) addresses can be opened');
    const res = await net.fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`The server answered ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 256 * 1024 * 1024) throw new Error('The file is larger than 256 MB');
    let name = '';
    const cd = res.headers.get('content-disposition') || '';
    const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    if (m) { try { name = decodeURIComponent(m[1]); } catch { name = m[1]; } }
    if (!name) { try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch { /* */ } }
    return { name: name || 'picture', mime: res.headers.get('content-type') || 'application/octet-stream', data: buf.toString('base64') };
  });
  // AI services: an HTTP request from the main process (no cross-origin limits). Body and answer as base64.
  handle('request', async ({ url, method, headers, body, timeoutMs }) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('Only http(s) addresses can be requested');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.min(Math.max(Number(timeoutMs) || 180000, 1000), 600000));
    try {
      const h = {};
      for (const [k, v] of Object.entries(headers || {})) if (typeof v === 'string' && /^[\w-]+$/.test(k)) h[k] = v;
      const res = await net.fetch(url, { method: method === 'POST' ? 'POST' : 'GET', headers: h, body: body ? Buffer.from(String(body), 'base64') : undefined, signal: ctl.signal, redirect: 'follow' });
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 256 * 1024 * 1024) throw new Error('The answer is larger than 256 MB');
      const out = {}; res.headers.forEach((v, k) => { out[k] = v; });
      return { status: res.status, headers: out, data: buf.toString('base64') };
    } catch (e) {
      if (ctl.signal.aborted) throw new Error('The service did not answer in time');
      throw e;
    } finally { clearTimeout(timer); }
  });
  // Platform-bound file commands: wallpaper, the OS properties window, Copy as File, file associations,
  // scanners (SANE on Linux, WIA on Windows) and subfolders for Import from Camera.
  const { execFile, spawn: spawnProc } = require('node:child_process');
  const os = require('node:os');
  const run = (cmd, args, opts = {}) => new Promise((res) => execFile(cmd, args, { timeout: opts.timeout || 60000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout, stderr) => res({ err, stdout: String(stdout || ''), stderr: String(stderr || '') })));
  const which = (cmd) => new Promise((res) => execFile(process.platform === 'win32' ? 'where' : 'which', [cmd], { windowsHide: true }, (err) => res(!err)));
  const ps = (script) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 180000 });
  const tempPng = (prefix) => path.join(app.getPath('userData'), `${prefix}-${Date.now()}.png`);

  handle('setWallpaper', async ({ data, which: target }) => {
    const file = tempPng('wallpaper');
    fs.writeFileSync(file, Buffer.from(String(data || ''), 'base64'));
    if (process.platform === 'win32') {
      const r = await ps(`Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class W { [DllImport("user32.dll", SetLastError = true)] public static extern bool SystemParametersInfo(int a, int b, string c, int d); }'; [W]::SystemParametersInfo(20, 0, '${file.replace(/'/g, "''")}', 3)`);
      if (r.err) throw new Error(r.stderr.trim() || r.err.message);
      return { ok: true, how: 'SystemParametersInfo' };
    }
    if (process.platform === 'darwin') {
      const r = await run('osascript', ['-e', `tell application "System Events" to set picture of every desktop to POSIX file "${file.replace(/"/g, '\\"')}"`]);
      if (r.err) throw new Error(r.stderr.trim() || r.err.message);
      return { ok: true, how: 'System Events' };
    }
    const url = pathToFileURL(file).href;
    if (await which('gsettings')) {
      const a = await run('gsettings', ['set', 'org.gnome.desktop.background', 'picture-uri', url]);
      await run('gsettings', ['set', 'org.gnome.desktop.background', 'picture-uri-dark', url]);
      if (target === 'lock' || target === 'both') await run('gsettings', ['set', 'org.gnome.desktop.screensaver', 'picture-uri', url]);
      if (!a.err) return { ok: true, how: 'gsettings' };
    }
    if (await which('plasma-apply-wallpaperimage')) { const r = await run('plasma-apply-wallpaperimage', [file]); if (!r.err) return { ok: true, how: 'plasma-apply-wallpaperimage' }; }
    if (await which('xfconf-query')) { const r = await run('xfconf-query', ['-c', 'xfce4-desktop', '-p', '/backdrop/screen0/monitor0/workspace0/last-image', '-s', file]); if (!r.err) return { ok: true, how: 'xfconf-query' }; }
    if (await which('feh')) { const r = await run('feh', ['--bg-fill', file]); if (!r.err) return { ok: true, how: 'feh' }; }
    if (await which('pcmanfm')) { const r = await run('pcmanfm', ['--set-wallpaper', file]); if (!r.err) return { ok: true, how: 'pcmanfm' }; }
    throw new Error(`No supported desktop found to set the wallpaper; the picture is saved at ${file}`);
  });
  handle('showProperties', async ({ uri }) => {
    const p = grantedPath(uri);
    const st = fs.statSync(p);
    const info = { path: p, size: st.size, mtime: st.mtimeMs, ctime: st.birthtimeMs || st.ctimeMs, mode: (st.mode & 0o777).toString(8), uid: st.uid, gid: st.gid, os: process.platform };
    if (process.platform === 'win32') {
      const child = spawnProc('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', `$s = New-Object -ComObject Shell.Application; $f = $s.Namespace('${path.dirname(p).replace(/'/g, "''")}').ParseName('${path.basename(p).replace(/'/g, "''")}'); $f.InvokeVerb('Properties'); Start-Sleep -Seconds 900`], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      return { ...info, opened: true };
    }
    if (process.platform === 'darwin') {
      const r = await run('osascript', ['-e', `tell application "Finder" to open information window of (POSIX file "${p.replace(/"/g, '\\"')}" as alias)`, '-e', 'tell application "Finder" to activate']);
      return { ...info, opened: !r.err };
    }
    return { ...info, opened: false };
  });
  handle('copyFileToClipboard', async ({ uri }) => {
    const p = grantedPath(uri);
    if (process.platform === 'win32') { clipboard.writeBuffer('FileNameW', Buffer.from(p + '\0', 'ucs2')); return { ok: true, how: 'CF_HDROP-compatible FileNameW' }; }
    if (process.platform === 'darwin') { clipboard.writeBuffer('public.file-url', Buffer.from(pathToFileURL(p).href)); return { ok: true, how: 'public.file-url' }; }
    clipboard.writeBuffer('text/uri-list', Buffer.from(pathToFileURL(p).href + '\r\n'));
    return { ok: true, how: 'text/uri-list' };
  });
  handle('setAssociations', async ({ exts }) => {
    const list = Array.isArray(exts) ? exts.filter((e) => typeof e === 'string' && /^[a-z0-9]{1,6}$/i.test(e)) : [];
    const mimes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', apng: 'image/apng', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml', ico: 'image/vnd.microsoft.icon', jxl: 'image/jxl', psd: 'image/vnd.adobe.photoshop', tga: 'image/x-tga', pdf: 'application/pdf' };
    if (process.platform === 'linux') {
      const desktopFile = 'quilllens.desktop';
      const done = [], failed = [];
      for (const ext of list) { const m = mimes[ext.toLowerCase()]; if (!m) continue; const r = await run('xdg-mime', ['default', desktopFile, m]); (r.err ? failed : done).push(ext); }
      return { ok: !failed.length, how: 'xdg-mime', done, failed };
    }
    if (process.platform === 'win32') { await shell.openExternal('ms-settings:defaultapps'); return { ok: true, how: 'Settings ▸ Default apps (the installer registered the types; pick Anne\'s Lens there)', done: [], failed: [] }; }
    return { ok: false, how: 'Finder: Get Info ▸ Open with ▸ Change All…', done: [], failed: list };
  });
  handle('listScanners', async () => {
    if (process.platform === 'linux') {
      if (!(await which('scanimage'))) return { devices: [], note: 'SANE (scanimage) is not installed' };
      const r = await run('scanimage', ['-L'], { timeout: 30000 });
      const devices = [...r.stdout.matchAll(/device `([^']+)' is a (.+)/g)].map((m) => ({ id: m[1], name: m[2].trim() }));
      return { devices, note: devices.length ? '' : 'No scanner found by SANE' };
    }
    if (process.platform === 'win32') {
      const r = await ps(`$m = New-Object -ComObject WIA.DeviceManager; foreach ($d in $m.DeviceInfos) { if ($d.Type -eq 1) { Write-Output ($d.DeviceID + '|' + $d.Properties.Item('Name').Value) } }`);
      const devices = r.stdout.split(/\r?\n/).filter((l) => l.includes('|')).map((l) => { const [id, ...n] = l.split('|'); return { id: id.trim(), name: n.join('|').trim() }; });
      return { devices, note: devices.length ? '' : (r.stderr.trim() || 'No WIA scanner found') };
    }
    return { devices: [], note: 'Scanning through the system is not available on this platform; use the camera' };
  });
  handle('scan', async ({ device, dpi, mode }) => {
    const res = Math.max(50, Math.min(2400, Number(dpi) || 300)), gray = mode === 'gray';
    const file = tempPng('scan');
    try {
      if (process.platform === 'linux') {
        const args = ['--resolution', String(res), '--mode', gray ? 'Gray' : 'Color', '--format=png', '-o', file];
        if (device) args.unshift('-d', String(device));
        const r = await run('scanimage', args, { timeout: 300000 });
        if (r.err) throw new Error(r.stderr.trim() || r.err.message);
      } else if (process.platform === 'win32') {
        const r = await ps(`$m = New-Object -ComObject WIA.DeviceManager; $info = $null; foreach ($d in $m.DeviceInfos) { if ($d.Type -eq 1 -and (('${String(device || '').replace(/'/g, "''")}' -eq '') -or ($d.DeviceID -eq '${String(device || '').replace(/'/g, "''")}'))) { $info = $d; break } }; if ($info -eq $null) { throw 'No scanner' }; $dev = $info.Connect(); $item = $dev.Items.Item(1); foreach ($p in $item.Properties) { if ($p.PropertyID -eq 6146) { $p.Value = ${gray ? 2 : 1} }; if ($p.PropertyID -eq 6147 -or $p.PropertyID -eq 6148) { $p.Value = ${res} } }; $img = $item.Transfer('{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}'); $img.SaveFile('${file.replace(/'/g, "''")}')`);
        if (r.err) throw new Error(r.stderr.trim() || r.err.message);
      } else throw new Error('Scanning through the system is not available on this platform');
      const data = fs.readFileSync(file);
      return { name: path.basename(file), mime: 'image/png', data: data.toString('base64') };
    } finally { try { fs.unlinkSync(file); } catch { /* */ } }
  });
  handle('createSubfolder', async ({ dirUri, name }) => {
    const dir = await writableDir(dirUri);
    const target = path.join(dir, visibleName(name));
    fs.mkdirSync(target, { recursive: true });
    grantDir(target); writableDirs.add(path.resolve(target)); // a folder made inside a writable one is written into without asking again
    return { uri: pathToFileURL(target).href, name: path.basename(target) };
  });
  void os;
  // Open with External Editor: a configured program (picked through a dialog) gets the file's path.
  handle('pickProgram', async () => {
    const filters = process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe', 'bat', 'cmd'] }, { name: 'All files', extensions: ['*'] }] : undefined;
    const r = await dialog.showOpenDialog(win, { title: 'Choose a program', properties: ['openFile'], filters });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    programs.add(path.resolve(r.filePaths[0])); writeSet(programsFile(), programs);
    return { path: r.filePaths[0], name: path.basename(r.filePaths[0]).replace(/\.(exe|app)$/i, '') };
  });
  handle('rememberFolder', async ({ uri }) => {
    const dir = grantedDir(uri);
    if (isProtected(dir)) throw new Error('Anne\'s Lens does not keep its own settings folder among the remembered ones.');
    remembered.add(dir); writeSet(foldersFile(), remembered);
    if (writableDirs.has(dir)) { rememberedWritable.add(dir); writeSet(writableFile_(), rememberedWritable); }
    return { ok: true };
  });
  handle('openWithProgram', async ({ uri, program, args }) => {
    const p = grantedPath(uri);
    if (typeof program !== 'string' || !program) throw new Error('No program configured');
    if (!programs.has(path.resolve(program))) throw new Error('Choose this program again with Add a Program (programs must be picked in the dialog)');
    const argv = Array.isArray(args) && args.length ? args.map((a) => String(a).split('{file}').join(p).split('{folder}').join(path.dirname(p)).split('{name}').join(path.basename(p))) : [p];
    const { spawn } = require('node:child_process');
    try {
      let child;
      if (process.platform === 'darwin' && /\.app$/i.test(program)) child = spawn('open', ['-a', program, '--args', ...argv], { detached: true, stdio: 'ignore' });
      else child = spawn(program, argv, { detached: true, stdio: 'ignore' });
      child.on('error', () => undefined);
      child.unref();
      return { ok: true };
    } catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
  });
  handle('setFileTime', async ({ uri, mtime }) => {
    const p = grantedPath(uri, true);
    const t = new Date(Number(mtime));
    if (Number.isNaN(t.getTime())) throw new Error('Bad time');
    fs.utimesSync(p, t, t);
    return { ok: true };
  });
  handle('getPortableMode', async () => {
    let available = true;
    try { fs.accessSync(exeDir, fs.constants.W_OK); } catch { available = false; }
    return { on: portableOn, dir: portableDir, available };
  });
  handle('setPortableMode', async ({ on }) => {
    try {
      if (on && !portableOn) {
        fs.mkdirSync(portableDir, { recursive: true });
        // Carry the current settings along: the Chromium profile holds localStorage and IndexedDB.
        fs.cpSync(app.getPath('userData'), portableDir, { recursive: true, force: true, filter: (src) => !/[\\/](Cache|Code Cache|GPUCache|DawnCache|logs)([\\/]|$)/.test(src) });
      } else if (!on && portableOn) {
        const profile = path.join(app.getPath('appData'), 'QuillLens');
        fs.mkdirSync(profile, { recursive: true });
        fs.cpSync(portableDir, profile, { recursive: true, force: true, filter: (src) => !/[\\/](Cache|Code Cache|GPUCache|DawnCache|logs)([\\/]|$)/.test(src) });
        fs.renameSync(portableDir, portableDir + '.off');
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
  });
  handle('relaunch', async () => { app.relaunch(); app.exit(0); });
}

// ------------------------------------------------------------------------------------------
// Window

// Content Security Policy for the app. 'unsafe-eval' stays off until macros can run scripts; wasm is for
// future codec modules; http to localhost is for AI servers (M7).
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:* data: blob:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-src 'none'",
].join('; ');

// Screen Capture: getDisplayMedia in the renderer is answered with the primary screen (or a window by name).
function setupDisplayMedia() {
  // Browse ▸ Map: OpenStreetMap's tile policy asks for an identifying User-Agent.
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['https://tile.openstreetmap.org/*'] }, (details, cb) => {
    cb({ requestHeaders: { ...details.requestHeaders, 'User-Agent': `AnnesLens/${app.getVersion()} (+https://github.com/socrtwo/annes-lens)` } });
  });
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } }).then((sources) => {
      const want = String(request.frame && request.frame.url && new URL(request.frame.url).searchParams.get('capture') || '');
      const pick = (want && sources.find((s) => s.id === want)) || sources.find((s) => s.id.startsWith('screen')) || sources[0];
      if (!pick) { callback({}); return; }
      callback({ video: pick });
    }).catch(() => callback({}));
  }, { useSystemPicker: true });
}

function serveApp() {
  protocol.handle(SCHEME, async (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(DIST, rel);
    if (!file.startsWith(DIST + path.sep) && file !== DIST) return new Response('Forbidden', { status: 403 });
    const target = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(DIST, 'index.html');
    const res = await net.fetch(pathToFileURL(target).href);
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', CSP);
    return new Response(res.body, { status: res.status, headers });
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }])] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Window settings kept between runs (the frameless choice).
const windowFile = () => path.join(app.getPath('userData'), 'window.json');
function windowPrefs() { try { return JSON.parse(fs.readFileSync(windowFile(), 'utf8')) || {}; } catch { return {}; } }
function saveWindowPrefs(p) { try { fs.writeFileSync(windowFile(), JSON.stringify({ ...windowPrefs(), ...p })); } catch { /* read-only profile */ } }
let frameless = false;
let restoreBounds = null; // where the window was before Full Screen on Another Display

function createWindow(bounds, opts = {}) {
  frameless = !opts.hidden && !!windowPrefs().frameless;
  const w = new BrowserWindow({
    show: !opts.hidden,
    width: bounds ? bounds.width : 1280,
    height: bounds ? bounds.height : 860,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    frame: !frameless,
    minWidth: 360,
    minHeight: 480,
    title: 'Anne\'s Lens',
    backgroundColor: '#3a3f4a',
    autoHideMenuBar: process.platform !== 'darwin',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: !opts.hidden,
    },
  });
  win = w;
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (safeUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN)) { e.preventDefault(); if (safeUrl(url)) void shell.openExternal(url); } });
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Close without saving', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Unsaved changes', message: 'Some pictures have unsaved changes. Close Anne\'s Lens anyway?' });
    if (choice === 0) e.preventDefault();
  });
  win.webContents.on('did-start-loading', () => { if (win === w) rendererReady = false; });
  win.on('closed', () => { if (win === w) { win = null; rendererReady = false; endPageServices(); } });
  // A reload starts the page again without what it had running.
  win.webContents.on('did-start-navigation', (e, _url, isInPlace, isMainFrame) => { const main = e && e.isMainFrame !== undefined ? e.isMainFrame : isMainFrame, same = e && e.isSameDocument !== undefined ? e.isSameDocument : isInPlace; if (win === w && main && !same) endPageServices(); });
  win.on('leave-full-screen', () => { if (restoreBounds && win === w) { const b = restoreBounds; restoreBounds = null; setTimeout(() => { if (!w.isDestroyed()) w.setBounds(b); }, 50); } });
  void win.loadURL(`${ORIGIN}/index.html`);
}

app.on('second-instance', (_e, argv) => {
  const files = filesFromArgs(argv);
  if (files.length) openExternalFiles(files);
  else if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});
// macOS: files opened from Finder (before or after launch).
app.on('open-file', (e, p) => { e.preventDefault(); if (app.isReady()) openExternalFiles([p]); else pendingFiles.push(p); });

// --convert: the hidden window decodes, processes and encodes with the app's own code (the Batch
// engine); the main process writes the files and reports.
let cliJob = null;
function startCliConvert() {
  const inputs = [];
  for (const a of cli.inputs) {
    const p = path.resolve(String(a));
    try { const st = fs.statSync(p); if (st.isDirectory()) { for (const e of listDir(p)) inputs.push(fileURLToPath(e.uri)); } else if (st.isFile()) inputs.push(p); else throw new Error(); } catch { process.stderr.write(`annes-lens: ${a}: not found\n`); }
  }
  if (!inputs.length) { process.stderr.write('annes-lens: no pictures to convert\n'); app.exit(2); return; }
  for (const p of inputs) { grant(p); grantDir(path.dirname(p), true); }
  const pattern = path.resolve(String(cli.convert)), outDir = path.dirname(pattern);
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { process.stderr.write(`annes-lens: cannot create ${outDir}: ${e.message}\n`); app.exit(2); return; }
  const stem = path.basename(pattern, path.extname(pattern)).split('*').map((s) => s.replace(/[{}]/g, '')).join('{name}');
  cliJob = { mode: 'convert', inputs: inputs.map((p) => { const st = fs.statSync(p); return { uri: pathToFileURL(p).href, name: path.basename(p), size: st.size, mtime: st.mtimeMs }; }), format: cli.format, quality: cli.quality ? +cli.quality : 90, names: stem, resize: cli.resizeSpec || null, shrinkOnly: !!cli['shrink-only'], rotate: cli.rotate || null, flip: cli.flip || null, gray: !!cli.gray, strip: !!cli.strip };
  const written = new Set();
  handle('cliWrite', async ({ name, data }) => {
    const ext = path.extname(String(name)), base = path.basename(String(name), ext);
    let target = path.join(outDir, base + ext);
    for (let n = 2; (written.has(target) || (!cli.overwrite && fs.existsSync(target))) && n < 10000; n++) target = path.join(outDir, `${base} (${n})${ext}`);
    fs.writeFileSync(target, Buffer.from(String(data || ''), 'base64'));
    written.add(target);
    return { name: path.basename(target), path: target };
  });
  handle('cliDone', async ({ done, failed }) => {
    for (const d of done || []) process.stdout.write(`${d.from} -> ${d.to}${d.note ? ` (${d.note})` : ''}\n`);
    for (const f of failed || []) process.stderr.write(`annes-lens: ${f.name}: ${f.error}\n`);
    setTimeout(() => app.exit(failed && failed.length ? 1 : 0), 10);
    return { ok: true };
  });
  createWindow(undefined, { hidden: true });
  win.webContents.on('render-process-gone', (_e, d) => { process.stderr.write(`annes-lens: the converter stopped (${d.reason})\n`); app.exit(3); });
}

app.whenReady().then(() => {
  loadGrants();
  if (cliConvert) { serveApp(); registerIpc(); startCliConvert(); return; }
  if (cli.fullscreen || cli.slideshow) cliJob = { mode: 'view', fullscreen: !!cli.fullscreen, slideshow: !!cli.slideshow };
  const files = filesFromArgs(process.argv);
  pendingFiles.unshift(...files);
  for (const f of pendingFiles) { grant(f); grantDir(path.dirname(f), true); }
  serveApp();
  registerIpc();
  try { setupDisplayMedia(); } catch (e) { console.warn('display media handler', e); }
  buildMenu();
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
