/**
 * The thumbnail panel of a window: a grid that replaces the picture (Thumbnails, T) or a filmstrip under
 * it. Thumbnails are decoded lazily (the platform's downscaling decoder where it can, the app's readers
 * otherwise) and cached per entry. Click shows a picture, double-click or Enter opens it full size,
 * Ctrl/Shift-click mark several for batch and file commands, arrows move, Delete deletes.
 */
import type { App, PictureTab } from '../app';
import { isPictureName, type Entry } from '../picture/folder';
import { h, clear, icon } from './dom';
import { decodePicture, sniff } from '../codecs/registry';

const PLATFORM = new Set(['jpeg', 'png', 'apng', 'webp', 'gif', 'bmp', 'avif', 'heic', 'jxl', 'svg']);

export type ThumbMode = 'grid' | 'strip';

const LIST_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

export class ThumbPanel {
  el: HTMLElement;
  private list: HTMLElement;
  private bar: HTMLElement;
  private items = new Map<Entry, HTMLElement>();
  private cache = new Map<Entry, Promise<HTMLCanvasElement | ImageBitmap | null>>();
  private order: Entry[] = [];
  private io: IntersectionObserver;
  private queue: (() => Promise<void>)[] = [];
  private running = 0;
  private lastFolder: unknown = null;
  private lastLen = -1;
  private anchor: Entry | null = null;
  open = false;
  mode: ThumbMode;
  /** Filter Bar predicate and Group By key function (set by the Browse commands). */
  filter: ((e: Entry) => boolean) | null = null;
  groupBy: ((e: Entry) => string) | null = null;
  filterLabel = '';

  constructor(public app: App, public tab: PictureTab) {
    this.mode = app.prefs.thumbMode;
    this.bar = h('div', { class: 'qn-thumbbar' });
    this.list = h('div', { class: 'qn-thumblist', role: 'listbox', tabindex: '0', 'aria-label': 'Thumbnails' });
    this.el = h('div', { class: 'qn-thumbs', style: 'display:none' }, this.bar, this.list);
    this.io = new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) this.load((e.target as any).__entry); }, { root: this.list, rootMargin: '200px' });
    this.list.addEventListener('keydown', (e) => this.key(e));
    // The keys this list handles itself (see Shell.widgetOwnsKey): the shortcuts stand aside for them while it has focus.
    (this.list as any).__ownsKey = (e: KeyboardEvent) => !!this.tab.folder.length && !e.ctrlKey && !e.metaKey && !e.altKey && (LIST_KEYS.has(e.key) || ((e.key === 'Escape' || e.key === 'Enter') && this.mode === 'grid'));
    this.list.addEventListener('contextmenu', (e) => { e.preventDefault(); const item = (e.target as HTMLElement).closest('.qn-thumb') as any; if (item?.__entry) { this.select(item.__entry, e); } this.app.ui.pictureContextMenu(e.clientX, e.clientY); });
    this.list.addEventListener('scroll', () => { /* lazy loading by the observer */ });
  }

  get size(): number { return this.app.prefs.thumbSize; }

  show(mode?: ThumbMode): void {
    if (mode) this.mode = mode;
    this.open = true;
    this.el.style.display = '';
    this.el.classList.toggle('qn-thumbs-grid', this.mode === 'grid');
    this.el.classList.toggle('qn-thumbs-strip', this.mode === 'strip');
    this.tab.el.classList.toggle('qn-window-grid', this.mode === 'grid');
    this.tab.el.classList.toggle('qn-window-strip', this.mode === 'strip');
    this.render(true);
    if (this.mode === 'grid') this.list.focus({ preventScroll: true });
    this.app.ui.refresh?.();
  }
  hide(): void {
    this.open = false;
    this.el.style.display = 'none';
    this.tab.el.classList.remove('qn-window-grid', 'qn-window-strip');
    this.tab.ui.layout();
    this.tab.ui.focus();
  }
  toggle(mode?: ThumbMode): void { if (this.open && (!mode || mode === this.mode)) this.hide(); else this.show(mode); }

  /** Re-renders with the current filter and grouping. */
  refilter(): void { this.lastLen = -1; this.sync(); this.renderBar(); }
  setSize(px: number): void { this.app.prefs.thumbSize = Math.max(48, Math.min(512, Math.round(px))); this.app.savePrefs(); this.cache.clear(); this.render(true); }

  /** Called on every app refresh: follows folder changes and the current picture cheaply. */
  sync(): void {
    if (!this.open) return;
    const f = this.tab.folder;
    if (f !== this.lastFolder || f.length !== this.lastLen || f.entries.some((e, i) => this.order[i] !== e)) this.render(true);
    else this.highlight();
  }

  private render(full: boolean): void {
    const f = this.tab.folder;
    this.lastFolder = f; this.lastLen = f.length; this.order = [...f.entries];
    if (full) {
      clear(this.list); this.items.clear(); this.io.disconnect();
      const s = this.size;
      this.list.style.setProperty('--thumb', `${s}px`);
      let shown = this.filter ? f.entries.filter((e) => this.filter!(e)) : [...f.entries];
      if (this.groupBy) { const g = this.groupBy; const keyed = shown.map((e, i) => ({ e, i, k: g(e) })); keyed.sort((a, b) => a.k.localeCompare(b.k, undefined, { numeric: true }) || a.i - b.i); shown = keyed.map((x) => x.e); }
      let lastGroup: string | null = null;
      for (const e of shown) {
        if (this.groupBy) { const k = this.groupBy(e); if (k !== lastGroup) { lastGroup = k; this.list.appendChild(h('div', { class: 'qn-thumb-group' }, k)); } }
        const item = h('div', { class: 'qn-thumb', role: 'option', title: e.name, style: `width:${s}px` }, h('div', { class: 'qn-thumb-pic', style: `height:${s}px` }), h('div', { class: 'qn-thumb-name' }, e.name));
        (item as any).__entry = e;
        item.addEventListener('click', (ev) => this.select(e, ev));
        item.addEventListener('dblclick', () => { this.select(e); if (this.mode === 'grid') this.hide(); });
        this.items.set(e, item);
        this.list.appendChild(item);
        this.io.observe(item);
      }
      this.renderBar();
    }
    this.highlight();
  }

  private renderBar(): void {
    clear(this.bar);
    const f = this.tab.folder;
    const marked = this.tab.marked.size;
    const btn = (ic: string, title: string, onclick: () => void, active = false) => h('button', { class: 'ql-iconbtn' + (active ? ' ql-active' : ''), title, 'aria-label': title, onclick }, icon(ic));
    this.bar.append(
      h('span', { class: 'qn-thumb-title' }, f.name || 'Folder', h('span', { class: 'ql-help' }, ` · ${this.filter ? `${this.items.size} of ` : ''}${f.length} picture${f.length === 1 ? '' : 's'}${marked ? ` · ${marked} marked` : ''}${this.filterLabel ? ` · ${this.filterLabel}` : ''}`)),
      btn('filter_alt', this.filter ? 'Filter (active)…' : 'Filter…', () => this.app.exec('browse.filter'), !!this.filter),
      h('span', { class: 'ql-spacer' }),
      btn('grid_view', 'Grid (replaces the picture)', () => this.show('grid'), this.mode === 'grid'),
      btn('view_carousel', 'Filmstrip under the picture', () => this.show('strip'), this.mode === 'strip'),
      btn('photo_size_select_small', 'Smaller thumbnails', () => this.setSize(this.size / 1.25)),
      btn('photo_size_select_large', 'Larger thumbnails', () => this.setSize(this.size * 1.25)),
      btn('sort', 'Sort…', () => this.app.exec('browse.sort')),
      btn('select_all', marked ? 'Clear marks' : 'Mark all', () => { if (marked) this.tab.marked.clear(); else for (const e of f.entries) this.tab.marked.add(e); this.render(false); this.renderBar(); }),
      btn('close', 'Close thumbnails (T)', () => this.hide()),
    );
  }

  private highlight(): void {
    const cur = this.tab.folder.current;
    for (const [e, item] of this.items) { item.classList.toggle('qn-current', e === cur); item.classList.toggle('qn-marked', this.tab.marked.has(e)); item.setAttribute('aria-selected', e === cur ? 'true' : 'false'); }
    const item = cur && this.items.get(cur);
    if (item && this.open) item.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  select(e: Entry, ev?: MouseEvent): void {
    const f = this.tab.folder;
    if (ev && (ev.ctrlKey || ev.metaKey)) { if (this.tab.marked.has(e)) this.tab.marked.delete(e); else this.tab.marked.add(e); this.anchor = e; this.render(false); this.renderBar(); return; }
    if (ev && ev.shiftKey && this.anchor) {
      const a = f.entries.indexOf(this.anchor), b = f.entries.indexOf(e);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) this.tab.marked.add(f.entries[i]);
      this.render(false); this.renderBar(); return;
    }
    this.anchor = e;
    const i = f.entries.indexOf(e);
    if (i >= 0 && i !== f.index) { f.select(i); void this.tab.show(); }
    this.highlight();
  }

  private key(e: KeyboardEvent): void {
    const f = this.tab.folder;
    if (!f.length) return;
    const cols = Math.max(1, Math.floor(this.list.clientWidth / (this.size + 14)));
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: this.mode === 'grid' ? -cols : -1, ArrowDown: this.mode === 'grid' ? cols : 1, PageUp: -cols * 4, PageDown: cols * 4, Home: -Infinity, End: Infinity };
    if (e.key in moves) {
      e.preventDefault(); e.stopPropagation();
      const d = moves[e.key];
      const to = d === -Infinity ? 0 : d === Infinity ? f.length - 1 : Math.max(0, Math.min(f.length - 1, f.index + d));
      const entry = f.entries[to];
      if (e.shiftKey && this.anchor) { const a = f.entries.indexOf(this.anchor); for (let i = Math.min(a, to); i <= Math.max(a, to); i++) this.tab.marked.add(f.entries[i]); }
      if (to !== f.index) { f.select(to); void this.tab.show(); }
      this.highlight(); this.renderBar();
      return;
    }
    if (e.key === 'Enter') { if (this.mode === 'grid') { e.preventDefault(); e.stopPropagation(); this.hide(); } return; }
    if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); const cur = f.current; if (cur) { if (this.tab.marked.has(cur)) this.tab.marked.delete(cur); else this.tab.marked.add(cur); this.anchor = cur; this.render(false); this.renderBar(); } return; }
    if (e.key === 'Escape' && this.mode === 'grid') { e.preventDefault(); e.stopPropagation(); this.hide(); }
  }

  /** Decodes (or takes from the cache) a thumbnail and puts it into the item. */
  private load(e: Entry): void {
    const item = this.items.get(e);
    if (!item) return;
    const pic = item.querySelector('.qn-thumb-pic') as HTMLElement;
    if (pic.childElementCount) return;
    // Show All Files: other files get an icon with their extension instead of a decode attempt.
    if (!isPictureName(e.name)) { pic.append(icon('description', 'qn-thumb-file'), h('span', { class: 'qn-thumb-ext' }, (e.name.match(/\.([^.]+)$/)?.[1] || 'file').toUpperCase())); return; }
    let p = this.cache.get(e);
    if (!p) {
      p = new Promise((resolve) => { this.queue.push(async () => resolve(await this.make(e))); this.pump(); });
      this.cache.set(e, p);
      if (this.cache.size > 800) { const first = this.cache.keys().next().value; if (first) this.cache.delete(first); }
    }
    void p.then((img) => {
      if (!this.items.has(e) || pic.childElementCount) return;
      if (!img) { pic.appendChild(icon('broken_image', 'qn-thumb-broken')); return; }
      const c = img instanceof HTMLCanvasElement ? img : (() => { const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height; cv.getContext('2d')!.drawImage(img, 0, 0); return cv; })();
      pic.appendChild(c);
    });
  }

  private pump(): void {
    while (this.running < 3 && this.queue.length) {
      const job = this.queue.shift()!;
      this.running++;
      void job().finally(() => { this.running--; this.pump(); });
    }
  }

  private async make(e: Entry): Promise<HTMLCanvasElement | ImageBitmap | null> {
    const s = this.size * Math.min(2, window.devicePixelRatio || 1);
    try {
      const cur = this.tab.picture;
      if (cur && cur.entry === e) return scaled(cur.frameCanvas(), s);
      // A cataloged picture: its stored thumbnail, without reading the file.
      const ck = (e as { catalogKey?: string }).catalogKey;
      if (ck) { const { catThumb } = await import('../picture/catalog'); const url = await catThumb(ck); if (url) { const img = new Image(); img.src = url; await img.decode(); const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d')!.drawImage(img, 0, 0); return scaled(c, s); } }
      const buf = await e.read();
      const u8 = new Uint8Array(buf);
      const fmt = sniff(u8, e.name);
      if (fmt && PLATFORM.has(fmt.id)) {
        try {
          const probe = await createImageBitmap(new Blob([u8 as BlobPart], { type: fmt.mime }), { imageOrientation: 'from-image' as any });
          const k = Math.min(1, s / Math.max(probe.width, probe.height));
          const bmp = k < 1 ? await createImageBitmap(probe, { resizeWidth: Math.max(1, Math.round(probe.width * k)), resizeHeight: Math.max(1, Math.round(probe.height * k)), resizeQuality: 'medium' } as any) : probe;
          if (bmp !== probe) probe.close();
          return bmp;
        } catch { /* fall through to the app's decoders */ }
      }
      const pic = await decodePicture(u8, e);
      const c = scaled(pic.frameCanvas(), s);
      pic.release();
      return c;
    } catch { return null; }
  }

  destroy(): void { this.io.disconnect(); this.cache.clear(); }
}

function scaled(src: HTMLCanvasElement, max: number): HTMLCanvasElement {
  const k = Math.min(1, max / Math.max(src.width, src.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(src.width * k)); c.height = Math.max(1, Math.round(src.height * k));
  const x = c.getContext('2d')!; x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
