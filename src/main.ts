/** Anne's Lens entry point. */
import { runCliConvert, applyCliView } from './platform/cli';
import 'material-symbols/outlined.css';
import './styles/app.css';
import './styles/lens.css';
import './ui/scrollcue.css';
import './commands';
import { App } from './app';
import { Shell } from './ui/shell';
import { launchFiles, onFilesOpened, onBackButton, isNative, isDesktop, isCapacitor, desktopBridge, listing, type OpenedFile } from './platform/native';
import { closeMenus, inDialog } from './ui/dialog';
import { allCommands, getCommand } from './commands/registry';
import { installScrollCues } from './ui/scrollcue';
import { openFiles, openDroppedFiles } from './commands/file';
import { pasteAsNew } from './commands/edit';
import { applyPreferred } from './i18n/languages';
import { installCustomMenus } from './ui/classicMenus';
import { closePalette } from './ui/shell';

const host = document.getElementById('app')!;

installScrollCues({
  selector: ['.ql-menu', '.ql-dialog-body', '.ql-cmdlist', '.ql-listbox', '.ql-bs-nav', '.ql-bs-body', '.ql-palette-list', '.ql-notices'].join(', '),
});

const app = new App(host);
installCustomMenus(app.prefs.customMenus); // Customize Menus layouts
listing.allFiles = app.prefs.showAllFiles; // Show All Files
applyPreferred(app.prefs.language); // the interface language, before the ribbon is drawn
app.ui = new Shell(app);
app.rebuildKeyIndex();
app.createTab();
app.ui.tabsChanged();
(window as any).qn = app;
(window as any).__qnAllIds = allCommands().map((c) => c.id);
(window as any).__qnGetCommand = getCommand;
(window as any).__qnCodecs = () => import('./codecs/registry');
(window as any).__qnLossless = () => import('./codecs/jpegLossless');
(window as any).__qnPalette = () => import('./codecs/palette');
(window as any).__qnImageOps = () => import('./commands/imageOps');
(window as any).__qnBatch = () => Promise.all([import('./commands/batch'), import('./picture/batch')]).then(([c, p]) => ({ ...c, ...p }));
(window as any).__qnBatchSteps = () => import('./commands/batchSteps');
(window as any).__qnAlbums = () => import('./picture/albums');
(window as any).__qnEffects = () => import('./picture/effects');
(window as any).__qnSimilar = () => import('./picture/similar');
(window as any).__qnAnim = () => Promise.all([import('./codecs/pngenc'), import('./codecs/tiffwrite'), import('./commands/pagesEdit')]).then(([a, t, pe]) => ({ ...a, ...t, ...pe }));
(window as any).__qnSeam = () => Promise.all([import('./picture/seam'), import('./codecs/palette')]).then(([s, p]) => ({ ...s, ...p }));
(window as any).__qnMask = () => import('./picture/mask');
(window as any).__qnMerge = () => Promise.all([import('./picture/merge'), import('./commands/create2')]).then(([m, c]) => ({ ...m, ...c }));
(window as any).__qnFolderInfo = () => import('./picture/folderInfo');
(window as any).__qnTools = () => Promise.all([import('./codecs/qr'), import('./codecs/carve'), import('./codecs/encrypt'), import('./commands/tools')]).then(([q, c, e, t]) => ({ ...q, ...c, ...e, ...t }));
(window as any).__qnShow = () => import('./picture/slideshow');
(window as any).__qnMusic = () => Promise.all([import('./picture/music'), import('./commands/slideshowMedia')]).then(([m, s]) => ({ ...m, ...s }));
(window as any).__qnMetafile = () => import('./codecs/metafile');
(window as any).__qnModern = () => import('./codecs/modern');
(window as any).__qnMap = () => Promise.all([import('./commands/map'), import('./geo/slippy')]).then(([m, s]) => ({ ...m, ...s }));
(window as any).__qnOverlays = () => import('./ui/overlays');
(window as any).__qnNative = () => import('./platform/native');
(window as any).__qnAi = () => Promise.all([import('./ai'), import('./ai/hosted'), import('./ai/device'), import('./ai/transport'), import('./ai/ensemble'), import('./ai/history'), import('./commands/aiEdit'), import('./commands/aiGenerate'), import('./ai/deviceGenerate')]).then(([a, h, d, t, e, hi, ae, ag, dg]) => ({ ...a, hosted: h, device: d, transport: t, ensemble: e, history: hi, aiEdit: ae, aiGenerate: ag, deviceGenerate: dg }));
(window as any).__qnVector = () => Promise.all([import('./picture/trace'), import('./picture/callout'), import('./picture/colorSearch'), import('./codecs/pdfwrite'), import('./commands/vectorPdf')]).then(([a, b, c, d, e]) => ({ ...a, ...b, ...c, ...d, ...e }));
(window as any).__qnView2 = () => Promise.all([import('./ui/overlays'), import('./picture/measure'), import('./ui/infoPane'), import('./picture/keepOriginal')]).then(([a, b, c, d]) => ({ ...a, ...b, ...c, ...d }));
(window as any).__qnOcr = () => Promise.all([import('./picture/ocr'), import('./picture/barcode'), import('./platform/runtimes'), import('./ui/overlays')]).then(([a, b, c, d]) => ({ ...a, ...b, ...c, viewState: d.viewState, ocrMatch: d.ocrMatch }));
(window as any).__qnPaint = () => Promise.all([import('./paint/session'), import('./paint/markup'), import('./paint/engine')]).then(([a, b, c]) => ({ ...a, markup: b, engine: c }));
(window as any).__qnCompare = () => Promise.all([import('./ui/viewHooks'), import('./ui/compareView'), import('./ui/syncWindows'), import('./commands/compare2')]).then(([a, b, c, d]) => ({ ...a, ...b, ...c, ...d }));
(window as any).__qnSpecial = () => Promise.all([import('./ui/specialView'), import('./picture/stereo'), import('./picture/sphere'), import('./picture/motionPhoto'), import('./commands/specialViews')]).then(([a, b, c, d, e]) => ({ ...a, ...b, ...c, ...d, ...e }));
(window as any).__qnColor = () => Promise.all([import('./color/embedded'), import('./color/display'), import('./color/spaces'), import('./commands/colorMgmt'), import('./meta/metaWrite')]).then(([a, b, c, d, e]) => ({ ...a, ...b, ...c, ...d, pngIcc: e.pngIcc }));
(window as any).__qnMeta = () => Promise.all([import('./picture/metadata'), import('./meta/xmp'), import('./meta/metaEdit'), import('./meta/iptc'), import('./meta/metaWrite'), import('./meta/geo'), import('./meta/places'), import('./meta/c2pa')]).then(([m, x, e, i, w, , , c]) => ({ ...m, ...x, ...e, ...i, ...w, c2pa: c }));

// Files dropped on the window open as a folder of their own.
window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  void openDroppedFiles(app, files);
});
// Ctrl+V with a picture on the clipboard (browsers allow reading it from the paste event).
document.addEventListener('paste', (e) => {
  const t = e.target as HTMLElement;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  const file = item?.getAsFile();
  if (file) { e.preventDefault(); void pasteAsNew(app, file); }
});
document.addEventListener('ql-layout', () => { for (const t of app.tabs) t.ui.layout(); });

async function start() {
  if (await runCliConvert(app)) return; // the desktop command line's --convert: no viewer start-up
  let ready = false;
  const queued: OpenedFile[] = [];
  onFilesOpened((fs) => { if (ready) void openFiles(app, fs); else queued.push(...fs); });
  const lf = await launchFiles();
  if (lf.length) await openFiles(app, lf);
  const openedAny = lf.length > 0 || queued.length > 0;
  if (queued.length) await openFiles(app, queued.splice(0));
  ready = true;
  // PWA file handling ("Open with" from the operating system's file manager).
  const lq = (window as any).launchQueue;
  if (lq?.setConsumer) lq.setConsumer(async (params: any) => { const files: File[] = []; for (const hnd of params.files || []) { try { files.push(await hnd.getFile()); } catch { /* */ } } if (files.length) void openDroppedFiles(app, files); });
  if (isDesktop()) { try { const st = await desktopBridge()!.getPortableMode(); (window as any).__qlPortable = st.on; } catch { /* */ } }
  // On the desktop a launch file can arrive just after this point; skip the tour when a picture is open by then.
  void applyCliView(app);
  void import('./commands/catalog').then((m) => m.startWatching(app)); // Watch Folder (nothing runs without watches)
  if (app.prefs.firstRun && !openedAny) setTimeout(() => { if (!app.picture) app.ui.tour(); }, 600);
  app.focus();
}
void start();

if (!isNative() && !isCapacitor() && 'serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !import.meta.env.DEV) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => undefined); });
}

onBackButton(() => {
  if (closePalette()) return true; // the command palette, before anything under it
  if (document.querySelector('.ql-menu')) { closeMenus(); return true; }
  if (inDialog()) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true; }
  if (host.classList.contains('ql-backstage-open')) { app.ui.hideBackstage(); return true; }
  if (document.body.classList.contains('ql-fullscreen')) { app.exec('view.fullScreen'); return true; }
  return false;
});

window.addEventListener('beforeunload', (e) => {
  if ((!isNative() || isDesktop()) && app.tabs.some((d) => d.dirty)) { e.preventDefault(); e.returnValue = ''; }
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => app.ui.applyPrefs());
