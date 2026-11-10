/**
 * Anne's Lens application core: picture windows (tabs), the current folder (file set), command
 * execution, undo/redo of picture edits and macro recording. Each tab shows one picture out of a
 * folder; next/previous move through the folder with pictures decoded ahead of time.
 */
import { viewHooks } from './ui/viewHooks';
import { getCommand, allCommands, type Command } from './commands/registry';
import { loadPrefs, loadStoredPlaces, prefsHooks, savePrefs, type Prefs } from './prefs';
import { toast, openDialog } from './ui/dialog';
import { canonicalKey } from './util/keys';
import type { Shell } from './ui/shell';
import type { Viewer } from './ui/viewer';
import type { ThumbPanel } from './ui/thumbs';
import { Folder, type Entry } from './picture/folder';
import { Picture } from './picture/model';
import { Loader } from './picture/loader';
import { Journal } from './picture/journal';
import { decodeOptions } from './codecs/registry';
import { keystoreHooks, loadKeys, storeKeys } from './ai/keystore';
import { pdfOptions } from './codecs/pdf';
import { djvuOptions } from './codecs/djvu';

let tabCounter = 0;

interface Snapshot { label: string; pages: Picture['pages']; page: number; frame: number; /** The state this snapshot holds (see PictureTab.rev). */ rev: number }

export class PictureTab {
  id = `t${Date.now().toString(36)}${tabCounter++}`;
  el!: HTMLElement;
  ui!: Viewer;
  thumbs!: ThumbPanel;
  /** The folder tree pane (Folder Tree, Browser), made when first shown. */
  tree: import('./ui/folderTree').FolderTree | null = null;
  /** Pictures marked in the thumbnail panel (for batch and file commands). */
  marked = new Set<Entry>();
  folder: Folder;
  /** The picture shown, or null while loading / when nothing is open. */
  picture: Picture | null = null;
  loading: Entry | null = null;
  error = '';
  dirty = false;
  /** The rectangle selection (picture pixels, integers), or null. */
  selection: { x: number; y: number; w: number; h: number } | null = null;
  /** A per-pixel mask (255 = selected) for ellipse, lasso, wand and color-range selections; null for a plain rectangle. */
  selectionMask: Uint8Array | null = null;
  /** The shape the selection tool draws. */
  selectShape: 'rect' | 'ellipse' | 'lasso' = 'rect';
  /** Left-drag draws a selection instead of panning (Edit ▸ Rectangle Selection). */
  selectTool = false;
  created = Date.now();
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  readonly loader: Loader;
  constructor(public app: App, folder?: Folder) {
    this.folder = folder || new Folder();
    this.loader = new Loader(this.folder);
  }
  get displayName(): string { return this.picture?.name || this.loading?.name || 'No picture'; }
  get entry(): Entry | null { return this.folder.current; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get undoLabel(): string { return this.undoStack[this.undoStack.length - 1]?.label || ''; }
  get redoLabel(): string { return this.redoStack[this.redoStack.length - 1]?.label || ''; }
  /** The undo history, oldest first: the state before each edit (for the History panel). */
  get history(): { label: string; image: CanvasImageSource; width: number; height: number }[] { return this.undoStack.map((s) => { const f = (s.pages[s.page] || s.pages[0]).frames[0]; return { label: s.label, image: f.image as CanvasImageSource, width: f.width, height: f.height }; }); }
  get redoHistory(): string[] { return [...this.redoStack].reverse().map((s) => s.label); }

  /** The state the picture is in (a number per distinct state) and the one last saved or opened: they differ exactly when there are unsaved changes, however far undo went. */
  private rev = 0;
  private savedRev = 0;
  private static revSeq = 0;
  private snapshot(label: string): Snapshot {
    const p = this.picture!;
    return { label, pages: p.pages, page: p.page, frame: p.frame, rev: this.rev };
  }
  private restore(s: Snapshot): void {
    const p = this.picture!;
    p.pages = s.pages; p.page = s.page; p.frame = s.frame; this.rev = s.rev;
    p.version++;
    if (this.selection && (this.selection.x + this.selection.w > p.width || this.selection.y + this.selection.h > p.height)) this.selection = null;
    if (this.selectionMask && this.selectionMask.length !== p.width * p.height) this.selectionMask = null;
  }
  setSelection(r: { x: number; y: number; w: number; h: number } | null, mask: Uint8Array | null = null): void {
    const p = this.picture;
    this.selectionMask = r && mask && p && mask.length === p.width * p.height ? mask : null;
    if (!r || !p) this.selection = null;
    else {
      const x = Math.max(0, Math.min(p.width, Math.round(r.x))), y = Math.max(0, Math.min(p.height, Math.round(r.y)));
      const x2 = Math.max(0, Math.min(p.width, Math.round(r.x + r.w))), y2 = Math.max(0, Math.min(p.height, Math.round(r.y + r.h)));
      this.selection = x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null;
    }
    this.ui.draw();
    this.app.refresh();
  }
  /** Runs an edit as one undoable step. `fn` returns the new pages (never mutating the old ones). */
  edit(label: string, fn: (p: Picture) => void): void {
    if (!this.picture) throw new Error('No picture is open.');
    if (this.stash) this.showOriginal(false);
    const before = this.snapshot(label);
    fn(this.picture);
    this.picture.version++;
    this.rev = ++PictureTab.revSeq;
    this.undoStack.push(before);
    this.redoStack = [];
    this.trimHistory();
    this.afterChange();
  }
  /** Keeps the undo history within 30 steps and a memory budget (full-size snapshots add up fast on large pictures); the oldest steps go first. */
  private trimHistory(): void {
    const bytes = (s: Snapshot) => { let n = 0; for (const pg of s.pages) for (const f of pg.frames) n += f.width * f.height * 4; return n; };
    const budget = ((navigator as { deviceMemory?: number }).deviceMemory ?? 8) >= 8 ? 1536 * 1048576 : 512 * 1048576;
    let total = this.undoStack.reduce((n, s) => n + bytes(s), 0);
    while (this.undoStack.length > 1 && (this.undoStack.length > 30 || total > budget)) total -= bytes(this.undoStack.shift()!);
  }
  undo(): boolean {
    if (this.stash) this.showOriginal(false); // Before / After is a view, not a state: back to the edited picture first
    const s = this.undoStack.pop();
    if (!s || !this.picture) return false;
    this.redoStack.push(this.snapshot(s.label));
    this.restore(s);
    this.afterChange();
    return true;
  }
  redo(): boolean {
    if (this.stash) this.showOriginal(false);
    const s = this.redoStack.pop();
    if (!s || !this.picture) return false;
    this.undoStack.push(this.snapshot(s.label));
    this.restore(s);
    this.afterChange();
    return true;
  }
  /** Forgets the history: the picture as it is now is the saved (or freshly opened) one. */
  clearHistory(): void { this.undoStack = []; this.redoStack = []; this.stash = null; this.savedRev = this.rev; this.dirty = false; }
  private stash: Snapshot | null = null;
  /** Before / After: shows the picture as it was before the first edit while `on`, without touching the history. */
  showOriginal(on: boolean): boolean {
    const p = this.picture;
    if (!p) return false;
    if (on) { if (this.stash || !this.undoStack.length) return false; this.stash = this.snapshot('current'); this.restore(this.undoStack[0]); }
    else { if (!this.stash) return false; this.restore(this.stash); this.stash = null; }
    this.ui.pictureChanged(); this.app.refresh();
    return true;
  }
  get showingOriginal(): boolean { return !!this.stash; }
  afterChange(): void {
    this.dirty = this.rev !== this.savedRev;
    this.ui.pictureChanged();
    this.app.ui.tabsChanged();
    this.app.refresh();
  }

  /** Shows the folder's current entry (decoding it, or taking it from the prefetch cache). */
  async show(): Promise<void> {
    const e = this.folder.current;
    if (!e) { this.picture = null; this.loading = null; this.error = ''; this.clearHistory(); this.ui.pictureChanged(); this.app.ui.tabsChanged(); this.app.refresh(); return; }
    if (this.dirty && this.picture && this.app.prefs.confirmClose) {
      const { choiceDialog } = await import('./ui/dialog');
      const c = await choiceDialog('Save Changes?', `Save changes to "${this.picture.name}" before moving on?`, ['Save', 'Don\'t Save']);
      if (c < 0) { this.folder.select(this.folder.entries.indexOf(this.picture.entry)); return; }
      if (c === 0) {
        const was = this.picture.entry;
        const { saveTab } = await import('./commands/file');
        if (!(await saveTab(this.app, this))) { this.folder.select(this.folder.entries.indexOf(this.picture?.entry || was)); return; }
        const ti = this.folder.entries.indexOf(e); if (ti >= 0) this.folder.select(ti); // saving may have added an entry; on to the picture that was asked for
      }
    }
    this.loading = e; this.error = '';
    this.app.ui.tabsChanged();
    const t0 = performance.now();
    try {
      const pic = await this.loader.get(e);
      if (this.folder.current !== e) return; // the user moved on
      this.picture = pic; this.loading = null; this.dirty = false; this.clearHistory(); this.selection = null; this.selectionMask = null;
      pic.loadMs = Math.round(performance.now() - t0);
      this.ui.pictureChanged(true);
      this.app.addRecent(e);
      if (pic.media && this === this.app.tab) { const { show } = await import('./picture/slideshow'); if (!show.running && this.picture === pic) void this.app.exec('view.media'); } // a video or audio file: its player opens over the poster
    } catch (err: any) {
      if (this.folder.current !== e) return;
      this.picture = null; this.loading = null; this.error = err?.message || String(err);
      this.ui.pictureChanged(true);
      const sample = err?.sample ? String(err.sample) : ''; // a recognized format with no reader yet: offer to send the file
      toast(`Could not open ${e.name}: ${this.error}`, { ms: sample ? 12000 : 8000, action: sample ? 'Send a sample…' : 'Repair…', onAction: () => void this.app.exec(sample ? 'help.sendSample' : 'file.openRepair', sample ? e : undefined) });
    }
    this.app.ui.tabsChanged();
    this.app.refresh();
    this.loader.prefetch(this.app.prefs.prefetch);
  }

  destroy(): void { this.loader.clear(); this.ui.destroy(); this.thumbs?.destroy(); }
}

export class App {
  prefs: Prefs = loadPrefs();
  tabs: PictureTab[] = [];
  active!: PictureTab;
  ui!: Shell;
  recording: { name: string; steps: { id: string; arg?: any }[] } | null = null;
  recordingPaused = false;
  private refreshQueued = false;
  private listeners = new Set<(app: App) => void>();
  lastCommand: { id: string; arg?: any } | null = null;
  /** Called after each command runs (Synchronize Windows follows navigation with it). */
  afterExec: ((id: string, arg?: any) => void)[] = [];
  keyIndex = new Map<string, string>();
  keyCandidates = new Map<string, string[]>();
  /** Copied picture (for Paste as New Picture when the system clipboard is not readable). */
  clip: Picture | null = null;
  /** Copied pixels (the selection) when the system clipboard is not readable. */
  clipRaster: import('./codecs/raster').Raster | null = null;
  /** Renames, moves, copies and deletes of this session, for Undo File Operation. */
  journal = new Journal();

  constructor(public host: HTMLElement) {
    keystoreHooks.notify = (message) => toast(message, { ms: 9000 });
    prefsHooks.saveFailed = (why) => toast(`Settings could not be saved (${why}). Changes made now are lost when the app closes; free some of this site's storage.`, { ms: 12000 });
    void loadStoredPlaces(this.prefs);
    keystoreHooks.askPassphrase = async (purpose, wrong) => {
      const r = await openDialog(purpose === 'set'
        ? { title: 'Protect Your AI Keys', ok: 'Encrypt', cancel: 'Keep unencrypted', help: 'This browser keeps your AI service keys in its storage. Choose a passphrase to encrypt them; the app asks for it once per session. Without one the keys are stored unencrypted on this device.', fields: [{ key: 'pw', label: 'Passphrase', type: 'password', value: '' }, { key: 'pw2', label: 'Again', type: 'password', value: '' }] }
        : { title: 'Unlock Your AI Keys', ok: 'Unlock', cancel: 'Not now', help: wrong ? 'That passphrase does not open the keys. Try again.' : 'Enter the passphrase that protects your AI service keys on this device (AI commands need them; the rest of the app does not).', fields: [{ key: 'pw', label: 'Passphrase', type: 'password', value: '' }] });
      if (!r || !String(r.pw || '')) return null;
      if (purpose === 'set' && r.pw !== r.pw2) { toast('The two passphrases differ; the keys are kept unencrypted for now (AI ▸ AI and Privacy sets one).'); return null; }
      return String(r.pw);
    };
    const legacyKeys = this.prefs.ai.services.some((s) => !!s.key); // keys saved in the settings by earlier versions
    void loadKeys(this.prefs.ai.services).then(async () => { if (legacyKeys) { await storeKeys(this.prefs.ai.services); this.savePrefs(); } });
    decodeOptions.siblings = (e) => { try { const f = this.folder; return f && f.entries.includes(e) ? f.entries : []; } catch { return []; } };
    decodeOptions.askPassword = async (name, wrong) => {
      const r = await openDialog({ title: 'Password', ok: 'Open', help: wrong ? `That password does not open ${name}. Try again.` : `${name} is protected by a password.`, fields: [{ key: 'pw', label: 'Password', type: 'password', value: '' }] });
      return r ? String(r.pw) : null;
    };
    this.rebuildKeyIndex(); decodeOptions.autoRotate = this.prefs.autoRotateExif; decodeOptions.rawPreferPreview = this.prefs.rawPreferPreview; decodeOptions.dicomOverlays = this.prefs.dicomOverlays !== false; pdfOptions.dpi = this.prefs.pdf.dpi; pdfOptions.maxPages = this.prefs.pdf.maxPages; djvuOptions.maxPages = this.prefs.pdf.maxPages; }

  get tab(): PictureTab { return this.active; }
  /** The picture in the active window, or null. */
  get picture(): Picture | null { return this.active?.picture || null; }
  get viewer(): Viewer { return this.active.ui; }
  get folder(): Folder { return this.active.folder; }

  onRefresh(fn: (app: App) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  savePrefs(): void { savePrefs(this.prefs); void storeKeys(this.prefs.ai.services).catch((e) => toast(`The AI keys could not be stored: ${e?.message || e}`)); this.rebuildKeyIndex(); decodeOptions.autoRotate = this.prefs.autoRotateExif; decodeOptions.rawPreferPreview = this.prefs.rawPreferPreview; decodeOptions.dicomOverlays = this.prefs.dicomOverlays !== false; pdfOptions.dpi = this.prefs.pdf.dpi; pdfOptions.maxPages = this.prefs.pdf.maxPages; djvuOptions.maxPages = this.prefs.pdf.maxPages; }

  rebuildKeyIndex(): void {
    this.keyIndex.clear(); this.keyCandidates.clear();
    // The first registered command keeps a shared key; the others stay as candidates used when it is disabled (Space: Next Picture, or Pause while a slideshow runs).
    for (const c of allCommands()) for (const k of c.keys || []) { const ck = canonicalKey(k); if (!this.keyIndex.has(ck)) this.keyIndex.set(ck, c.id); const l = this.keyCandidates.get(ck) || []; l.push(c.id); this.keyCandidates.set(ck, l); }
    for (const [k, id] of Object.entries(this.prefs.keymap)) { const ck = canonicalKey(k); if (id) { this.keyIndex.set(ck, id); this.keyCandidates.set(ck, [id, ...(this.keyCandidates.get(ck) || []).filter((x) => x !== id)]); } else { this.keyIndex.delete(ck); this.keyCandidates.delete(ck); } }
  }
  /** The command a key should run now: the first candidate that is enabled. */
  commandForKey(ck: string): string | undefined {
    const list = this.keyCandidates.get(ck) || (this.keyIndex.has(ck) ? [this.keyIndex.get(ck)!] : []);
    for (const id of list) { const c = getCommand(id); if (c && (!c.isEnabled || c.isEnabled(this))) return id; }
    return list[0];
  }

  // ------------------------------------------------------------------------------------------
  // Windows (tabs)

  createTab(folder?: Folder): PictureTab {
    const tab = new PictureTab(this, folder);
    this.ui.mountTab(tab);
    this.tabs.push(tab);
    this.activate(tab);
    return tab;
  }

  activate(tab: PictureTab): void {
    this.active = tab;
    const tiled = viewHooks.tiled();
    for (const d of this.tabs) { d.el.classList.toggle('ql-hidden-tab', d !== tab && !tiled); d.el.classList.toggle('qn-window-active', tiled && d === tab); }
    this.ui.tabsChanged();
    tab.ui.layout();
    this.refresh();
    document.title = `${tab.displayName}${tab.dirty ? ' •' : ''} – Anne's Lens`;
  }

  closeTab(tab: PictureTab): void {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    tab.destroy();
    tab.el.remove();
    this.tabs.splice(i, 1);
    if (!this.tabs.length) this.createTab();
    else this.activate(this.tabs[Math.max(0, i - 1)]);
  }

  /** Opens a folder (a set of entries) in the active window, or a new one, and shows `index`. */
  async openFolder(folder: Folder, index = 0, opts: { newWindow?: boolean } = {}): Promise<PictureTab> {
    let tab = this.active;
    if (this.prefs.hiddenFiles.length) { const hidden = new Set(this.prefs.hiddenFiles); const key = folder.uri || folder.name; const kept = folder.entries.filter((e) => !hidden.has(`${key}|${e.name}`)); if (kept.length !== folder.entries.length) { folder.entries = kept; index = Math.min(index, Math.max(0, kept.length - 1)); } }
    if (opts.newWindow || (tab.picture && tab.dirty)) tab = this.createTab(folder);
    else { tab.folder = folder; tab.loader.setFolder(folder); }
    folder.select(index);
    this.activate(tab);
    await tab.show();
    for (const f of this.folderHooks) { try { f(tab); } catch (e) { console.warn(e); } }
    return tab;
  }
  /** Run after a window shows a new folder (the folder tree follows it). */
  folderHooks: ((tab: PictureTab) => void)[] = [];

  addRecent(e: Entry): void {
    if (!e.uri) return;
    const key = e.uri;
    const list = this.prefs.recent.filter((r) => r.key !== key);
    const old = this.prefs.recent.find((r) => r.key === key);
    list.unshift({ key, name: e.name, when: Date.now(), uri: e.uri, pinned: old?.pinned });
    this.prefs.recent = [...list.filter((r) => r.pinned), ...list.filter((r) => !r.pinned)].slice(0, 40);
    savePrefs(this.prefs);
  }

  /** Called after an edit, undo or redo, and after a picture changes. */
  refresh(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    requestAnimationFrame(() => {
      this.refreshQueued = false;
      if (!this.active) return;
      this.ui.refresh();
      this.active.thumbs?.sync();
      for (const l of this.listeners) l(this);
    });
  }

  // ------------------------------------------------------------------------------------------
  // Commands

  handleKey(key: string): boolean {
    const id = this.keyIndex.get(canonicalKey(key));
    if (!id) return false;
    const c = getCommand(id);
    if (!c) return false;
    if (c.isEnabled && !c.isEnabled(this)) return false;
    this.exec(id);
    return true;
  }

  exec(id: string, arg?: any): unknown {
    const c = getCommand(id);
    if (!c) { toast(`Unknown command: ${id}`); return false; }
    if (c.edits && !this.picture) { toast('Open a picture first.'); return false; }
    if (c.isEnabled && !c.isEnabled(this)) { toast(`${c.label} is not available here.`); return false; }
    if (this.recording && !c.noRecord && id !== 'dev.recordMacro' && id !== 'dev.stopRecording') this.recordStep(id, arg);
    if (!c.noRecord) this.lastCommand = { id, arg };
    try {
      const r = c.run(this, arg);
      if (r instanceof Promise) r.catch((e) => this.reportError(c, e)).finally(() => this.refresh());
      for (const h of this.afterExec) { try { h(id, arg); } catch (e) { console.warn(e); } }
      this.refresh();
      return r;
    } catch (e) {
      this.reportError(c, e);
      return false;
    }
  }

  private reportError(c: Command, e: unknown): void {
    console.error(e);
    toast(`${c.label}: ${(e as any)?.message || e}`, { ms: 6000 });
  }

  recordStep(id: string, arg?: any): void {
    if (!this.recording || this.recordingPaused) return;
    this.recording.steps.push(arg === undefined ? { id } : { id, arg: JSON.parse(JSON.stringify(arg)) });
  }

  /** One undoable edit of the active picture. */
  edit(label: string, fn: (p: Picture) => void): void {
    if (!this.picture) { toast('Open a picture first.'); return; }
    this.active.edit(label, fn);
  }

  followLink(href: string): void {
    if (!/^(https?|mailto):/i.test(href.trim())) { toast(`Blocked a link with an unsupported address: ${href.slice(0, 60)}`); return; }
    import('./platform/native').then(({ openExternal }) => openExternal(href));
  }

  focus(): void { this.active?.ui.focus(); }
}
