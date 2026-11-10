/** Application preferences (per device), persisted to localStorage (or beside the program in portable mode). */
import { kvGet, kvSet } from './util/store';
import { defaultAiPrefs, type AiPrefs } from './ai/types';
import { PLAN_LAYOUTS } from './plan.generated';

export interface CustomGroup { id: string; label: string; items: string[] }
export interface CustomTab { id: string; label: string; groups: CustomGroup[]; hidden?: boolean }
export interface RecentEntry { key: string; name: string; when: number; uri?: string; format?: string; pinned?: boolean }
export interface Macro { name: string; steps: { id: string; arg?: any }[]; description?: string; key?: string; created: number }

export type MenuStyle = 'ribbon' | 'classic' | 'both';
export type ZoomMode = 'fit' | 'fit-large' | 'fit-width' | 'fit-height' | 'fill' | 'actual';
export type AlphaDisplay = 'checkerboard' | 'white' | 'black' | 'custom';

export interface Prefs {
  author: string;
  qat: string[];
  qatPosition: 'top' | 'below' | 'bottom';
  qatLabels: boolean;
  qatHidden: boolean;
  customTabs: CustomTab[];
  /** Classic menu layouts made with Customize Menus (keys start with "custom-"). */
  customMenus: CustomMenuLayout[];
  hiddenTabs: string[];
  tabOrder: string[];
  keymap: Record<string, string>;
  theme: 'system' | 'light' | 'dark' | 'black';
  /** Browse: folder listings include non-picture files; folders include their subfolders' pictures; the Browser layout and the folder tree pane. */
  showAllFiles: boolean;
  /** Use Catalog: the catalog view, smart albums over the whole catalog, watch folders running. */
  useCatalog: boolean;
  includeSubfolders: boolean;
  browserLayout: boolean;
  folderTree: boolean;
  /** Interface language: 'en-US', a built-in table ('es') or one loaded or translated on this device. */
  language: string;
  ribbon: 'full' | 'tabs' | 'hidden';
  /** The menu system: the suite ribbon, a classic menu bar, or both. */
  menuStyle: MenuStyle;
  /** Which viewer's arrangement the classic menu bar follows (a key of PLAN_LAYOUTS). */
  menuLayout: string;
  statusBar: boolean;
  recent: RecentEntry[];
  recentFolders: RecentEntry[];
  macros: Macro[];
  confirmClose: boolean;
  highContrastUI: boolean;
  uiScale: number;
  pinnedCommands: string[];
  firstRun: boolean;
  touchMode: boolean;
  /** Viewing */
  zoomMode: ZoomMode;
  /** Keep the zoom factor when moving to another picture. */
  zoomLock: boolean;
  /** Keep the panned position too. */
  keepPosition: boolean;
  /** Next/previous wrap around at the ends of the folder. */
  wrap: boolean;
  /** Apply the EXIF Orientation tag when showing a picture. */
  autoRotateExif: boolean;
  /** Smooth (bilinear) or nearest-neighbor display when zoomed in. */
  smoothZoom: boolean;
  /** What shows through transparent pixels. */
  alphaDisplay: AlphaDisplay;
  alphaColor: string;
  /** Canvas color around the picture ('' = the theme's canvas color). */
  background: string;
  fullScreenBackground: string;
  /** Pictures decoded ahead of the current one in each direction. */
  prefetch: number;
  /** Show pixel position and color in the status bar. */
  pixelInfo: boolean;
  /** Esc closes the app (IrfanView) after leaving full screen; off in browsers by default. */
  escExits: boolean;
  /** Mouse wheel without a modifier: next/previous picture, or scroll/zoom. */
  wheel: 'navigate' | 'zoom' | 'scroll';
  /** Saving */
  jpegQuality: number;
  defaultSaveFormat: string;
  /** Save and Save As: carry EXIF, XMP and the color profile into JPEG, PNG and WebP output. */
  keepMetadata: boolean;
  /** Keep the file's original bytes as "name (original).ext" the first time it is saved over. */
  keepOriginal: boolean;
  /** Save As: run-length encode TGA files. */
  tgaRle: boolean;
  /** Print at True Size: measured ÷ expected length from the calibration ruler (1 = the printer is exact). */
  printScale: number;
  /** Print Setup: paper, orientation, margins (mm), captions, default fit. */
  print: { paper: string; orientation: 'auto' | 'portrait' | 'landscape'; margin: number; captions: boolean; fit: 'page' | 'actual' };
  /** Open with External Editor: up to nine programs (desktop). */
  externalEditors: { name: string; path: string }[];
  /** External Tools: programs (desktop; args may hold {file} {folder} {name}) or web addresses ({name} {lat} {lon} {date} {title}); each is a command "tool:<id>". */
  /** Browse ▸ Map: the basemap and, for 'custom', a tile address such as https://tiles.example/{z}/{x}/{y}.png. */
  mapTiles: { basemap: 'osm' | 'offline' | 'custom'; template: string };
  externalTools: { id: string; name: string; kind: 'program' | 'web'; program?: string; args?: string; url?: string }[];
  /** Script plug-ins: JavaScript run in the Script Console's worker; each enabled one is a command "plugin:<id>". */
  scriptPlugins: { id: string; name: string; code: string; enabled: boolean; icon?: string; added: number }[];
  /** Quick Move / Quick Copy targets 1–9 (Alt+1…9, Alt+Shift+1…9); an empty uri is an unset slot. */
  quickFolders: { name: string; uri: string }[];
  /** Ask before deleting a file. */
  confirmDelete: boolean;
  /** Metadata: where edits go for formats that can embed XMP ('embed', 'sidecar' or 'both'); other formats always use a sidecar. */
  sidecarMode: 'embed' | 'sidecar' | 'both';
  /** Metadata Template: saved field sets. */
  metaTemplates: { name: string; fields: Record<string, string> }[];
  /** Keywords typed so far (autocomplete). */
  keywordHistory: string[];
  /** Slideshow settings (partial; defaults fill the rest). */
  slideshow: Record<string, any>;
  /** The relay for sharing views and albums beyond the local network (docs/NETSHARE.md); empty: local network only. */
  netRelay: string;
  /** Information Overlay template. */
  osdTemplate: string;
  /** Copy Color Under Pointer format. */
  colorFormat: 'hex' | 'rgb' | 'hsl' | 'name';
  /** RAW files open as their embedded preview. */
  rawPreferPreview: boolean;
  /** Draw the overlay planes of DICOM files. */
  dicomOverlays: boolean;
  /** Batch recipes: named Batch Steps jobs. */
  batchRecipes: { name: string; actions: any[]; format: string; quality: number; keepMeta: boolean; pattern: string }[];
  /** Adjust presets: named lists of adjustment steps (command id and dialog values). */
  adjustPresets: { name: string; steps: { id: string; values: Record<string, any> }[] }[];
  /** Custom Filter (Convolution): saved kernels. */
  convolutions: { name: string; size: number; kernel: number[]; divisor: number; bias: number }[];
  /** Thumbnails: size in CSS pixels and the last panel mode. */
  /** AI tab: services, active choices, privacy, ensemble, prompt library (src/ai/types.ts). */
  ai: AiPrefs;
  /** Hidden pictures: `${folder uri or name}|${file name}` (the file is not changed). */
  hiddenFiles: string[];
  /** The default scanner (device id) for Scan…; '' = ask. */
  scanSource: string;
  /** Import with Rules presets. */
  importRules: { name: string; subfolder: string; rename: string; skipDuplicates: boolean; deleteAfter: boolean }[];
  /** People roster for Link Person (name, dates, an external GEDCOM/FamilySearch id). */
  people: { name: string; born: string; died: string; externalId: string }[];
  /** Browse ▸ People: off until turned on; how alike two faces must be to group them (cosine, SFace). */
  faces: { enabled: boolean; threshold: number };
  /** PDF pages: rendering resolution and how many pages open. */
  pdf: { dpi: number; maxPages: number };
  /** An imported place-name table (CSV rows) for Look Up Place Names; searched before the built-in one. */
  importedPlaces: { city: string; state?: string; country: string; countryCode: string; lat: number; lon: number }[];
  /** Recognize Text: the languages and the page layout last used. */
  ocrLangs: string[];
  ocrLayout: 'auto' | 'block' | 'column' | 'line' | 'sparse';
  thumbSize: number;
  thumbMode: 'grid' | 'strip';
  /** Sort order for folders */
  sort: 'name' | 'natural' | 'date' | 'size' | 'type';
  sortDescending: boolean;
}

export const DEFAULT_QAT = ['file.open', 'file.saveAs', 'view.previous', 'view.next', 'image.rotateLeft', 'image.rotateRight', 'view.fullScreen', 'view.cmdSearch'];

/**
 * The Quick Access Bar drop-down checklist (docs/QAT.md): the suite's standard choices (AutoSave left out,
 * New mapped to Paste as New Picture) plus the union of the surveyed viewers' default toolbar buttons.
 */
export const QAT_STANDARD = ['edit.pasteAsNew', 'file.open', 'file.save', 'file.email', 'file.quickPrint', 'file.printPreview', 'file.print', 'edit.undo', 'edit.redo', 'view.touchMode', 'file.openRecent'];
export const QAT_EXTRAS = ['file.saveAs', 'view.previous', 'view.next', 'view.zoomIn', 'view.zoomOut', 'view.actualSize', 'view.fitWindow', 'image.rotateLeft', 'image.rotateRight', 'view.fullScreen', 'show.start', 'browse.thumbnails', 'edit.copy', 'edit.paste', 'file.delete', 'edit.crop', 'edit.markup', 'adjust.colorCorrections', 'image.info', 'browse.favorite', 'file.share', 'file.options', 'batch.convert', 'view.cmdSearch'];
export const QAT_CHOICES = [...QAT_STANDARD, ...QAT_EXTRAS];
/** Kept first, in this order, by addAllQatChoices. */
export const QAT_PINNED_FIRST = ['file.save', 'file.print'];

/**
 * Adds every drop-down choice to the bar: Save and Print first, then the remaining choices sorted by
 * label (case-insensitive), then anything else already on the bar, in its existing order.
 */
export function addAllQatChoices(current: string[], labelOf: (id: string) => string | undefined, choices: string[] = QAT_CHOICES): string[] {
  const known = choices.filter((id) => labelOf(id) !== undefined);
  const first = QAT_PINNED_FIRST.filter((id) => known.includes(id));
  const rest = known.filter((id) => !first.includes(id))
    .sort((a, b) => labelOf(a)!.localeCompare(labelOf(b)!, undefined, { sensitivity: 'base' }));
  const head = [...first, ...rest];
  return [...head, ...current.filter((id) => id === '|' || !head.includes(id))];
}

export function defaultPrefs(): Prefs {
  return {
    author: '',
    qat: [...DEFAULT_QAT], qatPosition: 'top', qatLabels: false, qatHidden: false,
    customTabs: [], customMenus: [], hiddenTabs: [], tabOrder: [], keymap: {},
    theme: 'system', showAllFiles: false, useCatalog: false, includeSubfolders: false, browserLayout: false, folderTree: false, language: 'en-US', ribbon: 'full', menuStyle: 'both', menuLayout: 'irfanview', statusBar: true,
    recent: [], recentFolders: [], macros: [],
    confirmClose: true, highContrastUI: false, uiScale: 1, pinnedCommands: [], firstRun: true, touchMode: false,
    zoomMode: 'fit-large', zoomLock: false, keepPosition: false, wrap: true, autoRotateExif: true, smoothZoom: true,
    alphaDisplay: 'checkerboard', alphaColor: '#ffffff', background: '', fullScreenBackground: '#000000', prefetch: 2, pixelInfo: true,
    escExits: false, wheel: 'navigate',
    jpegQuality: 90, defaultSaveFormat: 'png', keepMetadata: true, keepOriginal: false, tgaRle: true, printScale: 1,
    print: { paper: 'a4', orientation: 'auto', margin: 10, captions: false, fit: 'page' }, externalEditors: [], mapTiles: { basemap: 'osm', template: '' }, externalTools: [], scriptPlugins: [],
    quickFolders: [], confirmDelete: true, convolutions: [], sidecarMode: 'embed', metaTemplates: [], adjustPresets: [], batchRecipes: [], rawPreferPreview: true, dicomOverlays: true, osdTemplate: '{name}  {w} × {h}  {zoom}%\n{exifdate}  {camera}  {exposure}\n{n} / {total}', colorFormat: 'hex', slideshow: {}, netRelay: '', keywordHistory: [], thumbSize: 160, thumbMode: 'grid',
    ai: defaultAiPrefs(), hiddenFiles: [], scanSource: '', importRules: [], people: [], faces: { enabled: false, threshold: 0.42 }, pdf: { dpi: 150, maxPages: 100 }, importedPlaces: [], ocrLangs: ['eng'], ocrLayout: 'auto',
    sort: 'natural', sortDescending: false,
  };
}

const KEY = 'quilllens.prefs.v1';

export function loadPrefs(): Prefs {
  const d = defaultPrefs();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const p = sanitizePrefs(JSON.parse(raw));
    return { ...d, ...p };
  } catch {
    return d;
  }
}

const ENUMS: Partial<Record<keyof Prefs, readonly string[]>> = {
  qatPosition: ['top', 'below', 'bottom'], theme: ['system', 'light', 'dark', 'black'], ribbon: ['full', 'tabs', 'hidden'],
  menuStyle: ['ribbon', 'classic', 'both'], menuLayout: Object.keys(PLAN_LAYOUTS),
  zoomMode: ['fit', 'fit-large', 'fit-width', 'fit-height', 'fill', 'actual'], alphaDisplay: ['checkerboard', 'white', 'black', 'custom'],
  wheel: ['navigate', 'zoom', 'scroll'], sort: ['name', 'natural', 'date', 'size', 'type'],
};
/** One classic menu item: a command id, '|' (separator) or a submenu. */
export type MenuItemPref = string | { label: string; items: MenuItemPref[] };
export interface CustomMenuLayout { key: string; name: string; menus: { label: string; items: MenuItemPref[] }[] }
function sanitizeMenuItems(v: unknown, depth = 0): MenuItemPref[] {
  if (!Array.isArray(v) || depth > 4) return [];
  return v.flatMap((it): MenuItemPref[] => (typeof it === 'string' ? [it] : isObj(it) && typeof it.label === 'string' ? [{ label: it.label.slice(0, 80), items: sanitizeMenuItems(it.items, depth + 1) }] : []));
}
function sanitizeMenuLayouts(v: unknown): CustomMenuLayout[] {
  if (!Array.isArray(v)) return [];
  return v.filter((l) => isObj(l) && typeof l.key === 'string' && /^custom-[\w-]+$/.test(l.key) && typeof l.name === 'string' && Array.isArray(l.menus))
    .map((l) => ({ key: l.key, name: l.name.slice(0, 80), menus: l.menus.filter((m: unknown) => isObj(m) && typeof m.label === 'string').map((m: any) => ({ label: m.label.slice(0, 80), items: sanitizeMenuItems(m.items) })) })).slice(0, 20);
}
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Keeps only preferences of the expected shape (stored, or pasted into Import Settings). Unknown keys are dropped. */
export function sanitizePrefs(raw: unknown): Partial<Prefs> {
  if (!isObj(raw)) return {};
  const d = defaultPrefs() as Record<string, any>;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in d)) continue;
    const def = d[k];
    if (Array.isArray(def) ? Array.isArray(v) : isObj(def) ? isObj(v) : typeof v === typeof def && (typeof v !== 'number' || Number.isFinite(v))) out[k] = v;
  }
  for (const [k, ok] of Object.entries(ENUMS)) if (k in out && !ok!.includes(out[k]) && !(k === 'menuLayout' && /^custom-/.test(String(out[k])))) delete out[k];
  if (out.customMenus) out.customMenus = sanitizeMenuLayouts(out.customMenus);
  for (const k of ['qat', 'hiddenTabs', 'tabOrder', 'pinnedCommands']) if (k in out) out[k] = strings(out[k]);
  for (const k of ['keymap']) if (k in out) out[k] = Object.fromEntries(Object.entries(out[k]).filter(([, x]) => typeof x === 'string'));
  if (out.customTabs) {
    out.customTabs = out.customTabs.filter((t: any) => isObj(t) && typeof t.id === 'string' && Array.isArray(t.groups))
      .map((t: any) => ({ ...t, label: String(t.label ?? t.id), groups: t.groups.filter(isObj).map((g: any) => ({ ...g, id: String(g.id ?? ''), label: String(g.label ?? ''), items: strings(g.items) })) }));
  }
  for (const k of ['recent', 'recentFolders']) if (out[k]) out[k] = out[k].filter((r: any) => isObj(r) && typeof r.key === 'string' && typeof r.name === 'string');
  if (out.quickFolders) out.quickFolders = out.quickFolders.filter((r: any) => isObj(r) && typeof r.uri === 'string' && typeof r.name === 'string').slice(0, 9);
  if (out.slideshow && !isObj(out.slideshow)) delete out.slideshow;
  if (out.batchRecipes) out.batchRecipes = out.batchRecipes.filter((r: any) => isObj(r) && typeof r.name === 'string' && Array.isArray(r.actions)).slice(0, 60);
  if (out.adjustPresets) out.adjustPresets = out.adjustPresets.filter((r: any) => isObj(r) && typeof r.name === 'string' && Array.isArray(r.steps) && r.steps.every((x: any) => isObj(x) && typeof x.id === 'string' && isObj(x.values))).slice(0, 60);
  if (out.metaTemplates) out.metaTemplates = out.metaTemplates.filter((r: any) => isObj(r) && typeof r.name === 'string' && isObj(r.fields)).slice(0, 40);
  if (out.keywordHistory) out.keywordHistory = strings(out.keywordHistory).slice(0, 500);
  if (out.sidecarMode && !['embed', 'sidecar', 'both'].includes(out.sidecarMode)) delete out.sidecarMode;
  if (out.convolutions) out.convolutions = out.convolutions.filter((r: any) => isObj(r) && typeof r.name === 'string' && Array.isArray(r.kernel) && r.kernel.every((x: any) => typeof x === 'number')).slice(0, 40);
  if (out.pdf && (!isObj(out.pdf) || !(out.pdf.dpi >= 36 && out.pdf.dpi <= 600) || !(out.pdf.maxPages >= 1 && out.pdf.maxPages <= 2000))) delete out.pdf;
  if (out.faces && (!isObj(out.faces) || typeof out.faces.enabled !== 'boolean' || !(out.faces.threshold >= 0.3 && out.faces.threshold <= 0.8))) delete out.faces;
  if (out.mapTiles && (!isObj(out.mapTiles) || !['osm', 'offline', 'custom'].includes(out.mapTiles.basemap) || typeof out.mapTiles.template !== 'string')) delete out.mapTiles;
  if (out.externalTools) out.externalTools = out.externalTools.filter((t: any) => isObj(t) && typeof t.id === 'string' && typeof t.name === 'string' && (t.kind === 'program' || t.kind === 'web')).slice(0, 40);
  if (out.scriptPlugins) out.scriptPlugins = out.scriptPlugins.filter((t: any) => isObj(t) && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.code === 'string').slice(0, 60);
  if (out.externalEditors) out.externalEditors = out.externalEditors.filter((r: any) => isObj(r) && typeof r.path === 'string' && typeof r.name === 'string').slice(0, 9);
  if (out.ai) out.ai = sanitizeAi(out.ai);
  if (out.hiddenFiles) out.hiddenFiles = strings(out.hiddenFiles).slice(0, 5000);
  if (out.ocrLangs) { out.ocrLangs = strings(out.ocrLangs).filter((l: string) => /^[a-z_]{3,10}$/.test(l)).slice(0, 4); if (!out.ocrLangs.length) delete out.ocrLangs; }
  if (out.ocrLayout && !['auto', 'block', 'column', 'line', 'sparse'].includes(out.ocrLayout)) delete out.ocrLayout;
  if (out.people) out.people = out.people.filter((r: any) => isObj(r) && typeof r.name === 'string').map((r: any) => ({ name: r.name, born: String(r.born ?? ''), died: String(r.died ?? ''), externalId: String(r.externalId ?? '') })).slice(0, 2000);
  if (out.importedPlaces) out.importedPlaces = out.importedPlaces.filter((r: any) => isObj(r) && typeof r.city === 'string' && typeof r.lat === 'number' && typeof r.lon === 'number').map((r: any) => ({ city: r.city, state: typeof r.state === 'string' ? r.state : undefined, country: String(r.country ?? ''), countryCode: String(r.countryCode ?? ''), lat: r.lat, lon: r.lon })).slice(0, 200000);
  if (out.importRules) out.importRules = out.importRules.filter((r: any) => isObj(r) && typeof r.name === 'string').map((r: any) => ({ name: r.name, subfolder: String(r.subfolder ?? ''), rename: String(r.rename ?? '{name}'), skipDuplicates: r.skipDuplicates !== false, deleteAfter: !!r.deleteAfter })).slice(0, 40);
  if (out.print) out.print = { ...d.print, ...Object.fromEntries(Object.entries(out.print).filter(([k, v]) => k in d.print && typeof v === typeof (d.print as any)[k])) };
  if (out.macros) out.macros = out.macros.filter((m: any) => isObj(m) && typeof m.name === 'string' && Array.isArray(m.steps) && m.steps.every((s: any) => isObj(s) && typeof s.id === 'string'));
  if (typeof out.jpegQuality === 'number') out.jpegQuality = Math.max(1, Math.min(100, Math.round(out.jpegQuality)));
  if (typeof out.prefetch === 'number') out.prefetch = Math.max(0, Math.min(8, Math.round(out.prefetch)));
  return out as Partial<Prefs>;
}

function sanitizeAi(raw: any): AiPrefs {
  const d = defaultAiPrefs();
  const out: any = { ...d };
  if (Array.isArray(raw.services)) out.services = raw.services.filter((s: any) => isObj(s) && typeof s.id === 'string' && ['openai', 'anthropic', 'gemini', 'device'].includes(s.api))
    .map((s: any) => ({ id: s.id, name: String(s.name ?? s.id), api: s.api, baseUrl: String(s.baseUrl ?? ''), key: String(s.key ?? ''), textModel: String(s.textModel ?? ''), imageModel: String(s.imageModel ?? ''), preset: typeof s.preset === 'string' ? s.preset : undefined })).slice(0, 40);
  for (const k of ['textService', 'imageService', 'runtimeUrl']) if (typeof raw[k] === 'string') out[k] = raw[k];
  if (['device', 'service'].includes(raw.prefer)) out.prefer = raw.prefer;
  if (['new', 'replace'].includes(raw.result)) out.result = raw.result;
  if (['quantized', 'fp32'].includes(raw.modelDtype)) out.modelDtype = raw.modelDtype;
  if (typeof raw.credentials === 'boolean') out.credentials = raw.credentials;
  if (typeof raw.historyMax === 'number' && Number.isFinite(raw.historyMax)) out.historyMax = Math.max(0, Math.min(2000, Math.round(raw.historyMax)));
  if (isObj(raw.privacy)) out.privacy = { maxEdge: typeof raw.privacy.maxEdge === 'number' ? Math.max(256, Math.min(8192, Math.round(raw.privacy.maxEdge))) : d.privacy.maxEdge, confirmSend: typeof raw.privacy.confirmSend === 'boolean' ? raw.privacy.confirmSend : d.privacy.confirmSend, allowRemote: typeof raw.privacy.allowRemote === 'boolean' ? raw.privacy.allowRemote : d.privacy.allowRemote };
  if (isObj(raw.ensemble)) out.ensemble = { mode: ['single', 'master', 'quaker'].includes(raw.ensemble.mode) ? raw.ensemble.mode : 'single', members: strings(raw.ensemble.members), master: typeof raw.ensemble.master === 'string' ? raw.ensemble.master : '', showDeliberation: !!raw.ensemble.showDeliberation };
  if (Array.isArray(raw.prompts)) out.prompts = raw.prompts.filter((x: any) => isObj(x) && typeof x.name === 'string' && typeof x.prompt === 'string').map((x: any) => ({ name: x.name, prompt: x.prompt, negative: String(x.negative ?? ''), kind: x.kind === 'edit' ? 'edit' : 'generate' })).slice(0, 200);
  return out as AiPrefs;
}

/** The preferences without the AI service keys (those live in the keystore), for saving and exporting. */
export function prefsWithoutKeys(p: Prefs): Prefs { return { ...p, ai: { ...p.ai, services: p.ai.services.map((s) => ({ ...s, key: '' })) } }; }

/** Told when the settings could not be written (storage full or blocked), once until a save works again. */
export const prefsHooks = { saveFailed: null as null | ((why: string) => void) };
const PLACES_KEY = 'places.v1';
let placesStored: unknown = null, saveWarned = false;
/**
 * Saves the settings. Imported places (up to 200,000 rows) do not fit the settings record's storage quota, so they are
 * kept in the app's database and left out of the record; a failed save is reported instead of being swallowed.
 */
export function savePrefs(p: Prefs): void {
  try { localStorage.setItem(KEY, JSON.stringify({ ...prefsWithoutKeys(p), importedPlaces: [] })); saveWarned = false; }
  catch (e) { if (!saveWarned) { saveWarned = true; prefsHooks.saveFailed?.((e as Error)?.message || 'storage is full or unavailable'); } }
  if (p.importedPlaces !== placesStored) { placesStored = p.importedPlaces; void kvSet(PLACES_KEY, p.importedPlaces).catch(() => undefined); }
}
/** Brings the imported places back from the app's database at startup (records written before they moved there still carry them). */
export async function loadStoredPlaces(p: Prefs): Promise<void> {
  if (p.importedPlaces.length) return; // an older settings record still holds them: the next save moves them
  const v = await kvGet<Prefs['importedPlaces']>(PLACES_KEY).catch(() => undefined);
  if (Array.isArray(v) && v.length) p.importedPlaces = v.filter((r) => r && typeof r.city === 'string' && typeof r.lat === 'number' && typeof r.lon === 'number').slice(0, 200000);
  placesStored = p.importedPlaces;
}

/**
 * IrfanView-style key lists: lines of `Command=Key` (an IrfanView command name or an Anne's Lens id), or
 * `Key=Command`, optionally under an INI section such as [Keys] or [Hotkeys]. Keys use the plan's notation
 * (Ctrl+Shift+O, Space, F11). Unknown commands are reported, not applied.
 */
export const IRFANVIEW_COMMAND_NAMES: Record<string, string> = {
  'open': 'file.open', 'open folder': 'file.openFolder', 'reopen': 'file.openRecent', 'recent files': 'file.openRecent', 'open with external editor': 'file.openExternal',
  'thumbnails': 'browse.thumbnails', 'slideshow': 'show.settings', 'start slideshow': 'show.start', 'batch conversion': 'batch.convert', 'batch conversion/rename': 'batch.convert', 'search files': 'edit.findFiles',
  'rename file': 'file.rename', 'rename': 'file.rename', 'move file': 'file.moveTo', 'copy file': 'file.copyTo', 'delete file': 'file.delete', 'delete': 'file.delete',
  'save': 'file.save', 'save as': 'file.saveAs', 'save for web': 'file.saveForWeb', 'print': 'file.print', 'select scan source': 'file.selectSource', 'acquire': 'file.scan', 'scan': 'file.scan', 'batch scanning': 'file.batchScan',
  'copy': 'edit.copy', 'cut': 'edit.cut', 'paste': 'edit.paste', 'undo': 'edit.undo', 'redo': 'edit.redo', 'crop selection': 'edit.crop', 'custom crop selection': 'edit.customSelection', 'custom selection': 'edit.customSelection', 'select all': 'edit.selectAll', 'select none': 'edit.selectNone', 'insert text': 'edit.insertText', 'add text': 'edit.insertText', 'show paint dialog': 'edit.paint', 'paint': 'edit.paint', 'auto crop borders': 'edit.autoCrop',
  'image information': 'image.info', 'information': 'image.info', 'rotate left': 'image.rotateLeft', 'rotate right': 'image.rotateRight', 'custom rotation': 'image.rotateCustom', 'custom/fine rotation': 'image.rotateCustom', 'vertical flip': 'image.flipV', 'horizontal flip': 'image.flipH', 'resize': 'image.resize', 'resize/resample': 'image.resize', 'change canvas size': 'edit.canvasSize', 'add border/frame': 'edit.border', 'add border': 'edit.border',
  'convert to grayscale': 'image.grayscale', 'grayscale': 'image.grayscale', 'negative': 'image.negative', 'decrease color depth': 'image.decreaseDepth', 'increase color depth': 'image.increaseDepth', 'color corrections': 'adjust.colorCorrections', 'auto adjust colors': 'adjust.auto', 'sharpen': 'adjust.sharpen', 'red eye reduction': 'adjust.redEye', 'histogram': 'image.histogram', 'effects': 'fx.browser', 'jpg lossless rotation': 'image.losslessJpeg', 'jpg lossless': 'image.losslessJpeg', 'create panorama image': 'create.panoramaJoin', 'swap colors': 'image.swapChannels', 'palette': 'image.paletteEdit',
  'next file': 'view.next', 'previous file': 'view.previous', 'first file': 'view.first', 'last file': 'view.last', 'random file': 'view.random', 'next page': 'pages.next', 'previous page': 'pages.previous',
  'full screen': 'view.fullScreen', 'fullscreen': 'view.fullScreen', 'zoom in': 'view.zoomIn', 'zoom out': 'view.zoomOut', 'original size': 'view.actualSize', 'fit to window': 'view.fitWindow', 'fit images to window': 'view.fitWindow', 'fit only big images to window': 'view.fitLarge', 'fit window to image': 'view.fitWindowToImage', 'lock zoom': 'view.zoomLock', 'center image': 'view.center', 'always on top': 'view.alwaysOnTop', 'minimize': 'view.minimize', 'show menu bar': 'view.menuMode', 'show toolbar': 'view.toolbar', 'show status bar': 'view.statusBar',
  'properties': 'file.options', 'properties/settings': 'file.options', 'options': 'file.options', 'set as wallpaper': 'file.wallpaper', 'exit': 'file.exit', 'capture': 'file.capture', 'screenshot': 'file.capture', 'exif info': 'meta.exif', 'iptc info': 'meta.iptc', 'comment': 'meta.comment', 'change language': 'view.language', 'language': 'view.language', 'show hex view': 'file.openHex', 'extract all frames': 'create.extractFrames', 'extract all pages': 'create.extractFrames', 'create contact sheet': 'create.contactSheet', 'create multipage tif': 'create.multipage', 'send by email': 'file.email', 'email': 'file.email', 'edit multipage tif': 'pages.insert', 'help': 'help.contents', 'about': 'help.about',
};

export function parseKeyList(text: string, ids: Set<string>): { keymap: Record<string, string>; unknown: string[] } {
  const keymap: Record<string, string> = {};
  const unknown: string[] = [];
  const keyRe = /^(?:(?:ctrl|cmd|alt|shift|win)\+)*(?:[a-z0-9]|f\d{1,2}|space|backspace|enter|esc|escape|del|delete|home|end|pgup|pgdn|pageup|pagedown|left|right|up|down|tab|ins|insert|[+\-=.,/\\\[\]`;'])$/i;
  const toId = (cmd: string): string | null => {
    const c = cmd.trim();
    if (ids.has(c)) return c;
    const lower = c.toLowerCase().replace(/\s+/g, ' ').replace(/\.\.\.$|…$/, '').trim();
    return IRFANVIEW_COMMAND_NAMES[lower] || null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[;#[]/.test(line)) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const a = line.slice(0, eq).trim(), b = line.slice(eq + 1).trim();
    let key = '', cmd = '';
    if (keyRe.test(b) && !keyRe.test(a)) { cmd = a; key = b; } else if (keyRe.test(a)) { key = a; cmd = b; } else { cmd = a; key = b; }
    const id = toId(cmd);
    if (!id) { unknown.push(line); continue; }
    const canon = planKeyToCanonical(key);
    if (!canon) { unknown.push(line); continue; }
    keymap[canon] = id;
  }
  return { keymap, unknown };
}

/** "Ctrl+Shift+O" -> "Mod-Shift-o" (the same conversion scripts/gen-plan-ts.mjs applies to the plan). */
export function planKeyToCanonical(k: string): string | null {
  const s = String(k).trim();
  if (!s || /…|wheel/i.test(s)) return null;
  if (s === '+') return '=';
  const parts = s.split('+').map((p) => p.trim());
  const base = parts.pop()!;
  if (!base) return null;
  const names: Record<string, string> = { space: 'Space', backspace: 'Backspace', pgdn: 'PageDown', pagedown: 'PageDown', pgup: 'PageUp', pageup: 'PageUp', right: 'ArrowRight', left: 'ArrowLeft', up: 'ArrowUp', down: 'ArrowDown', home: 'Home', end: 'End', enter: 'Enter', esc: 'Escape', escape: 'Escape', del: 'Delete', delete: 'Delete', tab: 'Tab', ins: 'Insert', insert: 'Insert' };
  const key = names[base.toLowerCase()] || (base.length === 1 ? base.toLowerCase() : /^f\d{1,2}$/i.test(base) ? base.toUpperCase() : base);
  const mods = parts.map((p) => ({ ctrl: 'Mod', cmd: 'Mod', win: 'Mod', alt: 'Alt', shift: 'Shift' } as Record<string, string>)[p.toLowerCase()] || p);
  return [...['Mod', 'Alt', 'Shift'].filter((m) => mods.includes(m)), key].join('-');
}
