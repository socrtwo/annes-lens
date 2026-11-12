/**
 * The picture surface of one window: a canvas the current frame is drawn on at the chosen zoom, with
 * fit modes, panning, wheel and pinch zoom, keyboard navigation, animation playback, pixel info under
 * the pointer, drag and drop, and a message when nothing is open. Pictures are drawn with drawImage
 * from the decoded bitmap; only the visible part is drawn, so panning a large picture stays smooth.
 */
import type { App, PictureTab } from '../app';
import { drawOverlays, displayFrame, viewState, navigatorRect, navigatorShown } from './overlays';
import { maskOverlay, maskBounds, ellipseMask, polygonMask } from '../picture/mask';
import { paintHooks } from '../paint/hooks';
import { split, viewHooks } from './viewHooks';
import { specialOpen } from './specialView';
import { h, clear, icon } from './dom';
import type { ZoomMode } from '../prefs';
import { WheelStepper, wheelPixels, wheelZoomFactor } from './wheel';

const MIN_ZOOM = 0.01, MAX_ZOOM = 64;

export class Viewer {
  el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private empty: HTMLElement;
  private note: HTMLElement;
  private _zoom = 1;
  /** The fit mode in force until the user zooms by hand (then null = free zoom). */
  mode: ZoomMode | null;
  /** Picture point shown at the center of the view (picture pixels). */
  private cx = 0;
  private cy = 0;
  private drawQueued = false;
  private animTimer: any = null;
  playing = true;
  private pointer: { x: number; y: number } | null = null;
  private dragging: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
  private selecting: { x0: number; y0: number; handle: number; start: { x: number; y: number; w: number; h: number } | null } | null = null;
  private pinch: { d: number; z: number } | null = null;
  private pixelCanvas: HTMLCanvasElement | null = null;
  private maskCanvas: { mask: Uint8Array; canvas: HTMLCanvasElement } | null = null;
  private lassoPts: [number, number][] = [];
  private navigating = false;
  private painting = false;
  private splitDragging = false;
  private pixelKey = '';
  private destroyed = false;
  private ro: ResizeObserver;
  onPointer: ((info: { x: number; y: number; rgba: [number, number, number, number] } | null) => void) | null = null;

  constructor(public app: App, public tab: PictureTab) {
    this.mode = app.prefs.zoomMode;
    this.canvas = h('canvas', { class: 'qn-canvas' }) as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d', { alpha: true })!;
    this.empty = h('div', { class: 'qn-empty' },
      icon('image', 'qn-empty-icon'),
      h('p', null, 'Open a picture, drop files here, or paste one.'),
      h('div', { class: 'ql-row' },
        h('button', { class: 'ql-btn ql-primary', onclick: () => app.exec('file.open') }, icon('folder_open'), ' Open…'),
        h('button', { class: 'ql-btn', onclick: () => app.exec('file.openFolder') }, icon('folder'), ' Open Folder…'),
        h('button', { class: 'ql-btn', onclick: () => app.exec('edit.pasteAsNew') }, icon('content_paste'), ' Paste')),
      h('p', { class: 'ql-help' }, 'O opens, Space and Backspace move through the folder, Enter is full screen, Alt+Q finds any command.'));
    this.note = h('div', { class: 'qn-note', 'aria-live': 'polite' });
    this.el = h('div', { class: 'qn-viewer', tabindex: '0', role: 'img' }, this.canvas, this.empty, this.note);
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.el);
    this.bind();
  }

  get zoom(): number { return this._zoom; }
  /** The pointer position in viewer CSS pixels (null when outside). */
  get pointerPos(): { x: number; y: number } | null { return this.pointer; }
  get picture() { return this.tab.picture; }

  // ----------------------------------------------------------------------------------------
  // Layout and drawing

  layout(): void {
    const r = this.el.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.max(1, Math.round(r.width * dpr)), hgt = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== hgt) { this.canvas.width = w; this.canvas.height = hgt; }
    this.canvas.style.width = `${r.width}px`; this.canvas.style.height = `${r.height}px`;
    if (this.mode) this.applyMode();
    this.draw();
  }

  /** Called by the tab when the picture, page or frame changed. `fresh`: a different file. */
  pictureChanged(fresh = false): void {
    const p = this.picture;
    // A different picture: the Before/After slider's "before" no longer matches it (edits keep it on).
    if (fresh && split.tab === this.tab && split.on) { split.on = false; split.before = null; split.tab = null; }
    // A stereo, 360° or motion view belongs to the picture it was opened on (the two-page view turns its own pages).
    const sv = specialOpen(); if (fresh && sv && sv.kind !== 'spread' && this.tab === this.app.tab) sv.close();
    this.stopAnimation();
    this.pixelCanvas = null; this.pixelKey = '';
    this.empty.style.display = p ? 'none' : '';
    this.el.classList.toggle('qn-has-picture', !!p);
    if (this.tab.error) { clear(this.empty); this.empty.append(icon('broken_image', 'qn-empty-icon'), h('p', null, this.tab.error), h('button', { class: 'ql-btn', onclick: () => this.app.exec('file.open') }, 'Open another…')); this.empty.style.display = ''; }
    if (p) {
      if (fresh) {
        const prefs = this.app.prefs;
        if (!prefs.zoomLock) this.mode = prefs.zoomMode;
        if (!prefs.keepPosition || !prefs.zoomLock) { this.cx = p.width / 2; this.cy = p.height / 2; }
      } else { this.cx = Math.min(this.cx, p.width); this.cy = Math.min(this.cy, p.height); }
      if (this.mode) this.applyMode();
      if (p.animated && this.playing) this.startAnimation();
    }
    this.draw();
  }

  private fitZoom(mode: ZoomMode, pw: number, ph: number): number {
    const vw = this.el.clientWidth || 1, vh = this.el.clientHeight || 1;
    switch (mode) {
      case 'fit': return Math.min(vw / pw, vh / ph);
      case 'fit-large': return Math.min(1, vw / pw, vh / ph);
      case 'fit-width': return vw / pw;
      case 'fit-height': return vh / ph;
      case 'fill': return Math.max(vw / pw, vh / ph);
      default: return 1;
    }
  }

  private applyMode(): void {
    const p = this.picture;
    if (!p || !this.mode) return;
    this._zoom = this.clamp(this.fitZoom(this.mode, p.width, p.height));
    if (this.mode !== 'fit-width' && this.mode !== 'fit-height' && this.mode !== 'fill') { this.cx = p.width / 2; this.cy = p.height / 2; }
    else this.clampCenter();
  }

  private clamp(z: number): number { return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)); }

  /** Keeps the picture from being panned out of view (a small picture stays centered). */
  private clampCenter(): void {
    const p = this.picture;
    if (!p) return;
    const vw = this.el.clientWidth / this._zoom, vh = this.el.clientHeight / this._zoom;
    this.cx = p.width <= vw ? p.width / 2 : Math.min(p.width - vw / 2, Math.max(vw / 2, this.cx));
    this.cy = p.height <= vh ? p.height / 2 : Math.min(p.height - vh / 2, Math.max(vh / 2, this.cy));
  }

  setZoom(z: number | ZoomMode, anchor?: { x: number; y: number }): void {
    const p = this.picture;
    if (!p) return;
    if (typeof z === 'string') { this.mode = z; this.applyMode(); }
    else {
      const nz = this.clamp(z);
      if (anchor) {
        // Keep the picture point under the anchor (view coordinates) where it is.
        const before = this.toPicture(anchor.x, anchor.y);
        this._zoom = nz;
        const after = this.toPicture(anchor.x, anchor.y);
        this.cx += before.x - after.x; this.cy += before.y - after.y;
      } else this._zoom = nz;
      this.mode = null;
      this.clampCenter();
    }
    this.draw();
    this.app.refresh();
  }

  center(): void { const p = this.picture; if (!p) return; this.cx = p.width / 2; this.cy = p.height / 2; this.draw(); }
  /** The picture point at the center of the view. */
  get viewCenter(): { x: number; y: number } { return { x: this.cx, y: this.cy }; }
  /** Centers the view on a picture point (clamped like a drag). */
  panTo(x: number, y: number): void { this.cx = x; this.cy = y; this.clampCenter(); this.draw(); }
  /** Zoom relative to fitting the whole picture, and the view's center as fractions of the picture. */
  viewRel(): { rel: number; nx: number; ny: number } | null {
    const p = this.picture; if (!p) return null;
    return { rel: this._zoom / this.fitZoom('fit', p.width, p.height), nx: this.cx / p.width, ny: this.cy / p.height };
  }
  /** Shows the same relative zoom and center (Synchronize Windows). */
  applyRel(v: { rel: number; nx: number; ny: number }): void {
    const p = this.picture; if (!p) return;
    this.mode = null; this._zoom = this.clamp(v.rel * this.fitZoom('fit', p.width, p.height)); this.cx = v.nx * p.width; this.cy = v.ny * p.height;
    this.clampCenter(); this.draw();
  }
  /** The slider's divider position in CSS px, when the Before/After slider shows here. */
  splitX(): number | null { const r = this.pictureRect(); return split.on && split.tab === this.tab && split.before && r ? r.x + split.x * r.w : null; }
  /** The navigator's rectangle when it is showing (CSS px), else null. */
  navigatorBox(): { x: number; y: number; w: number; h: number; k: number } | null {
    const p = this.picture, r = this.pictureRect(); if (!p || !r) return null;
    const vw = this.el.clientWidth, vh = this.el.clientHeight;
    return navigatorShown(vw, vh, r) ? navigatorRect(vw, vh, p.width, p.height) : null;
  }
  private navigateTo(vx: number, vy: number): void { const n = this.navigatorBox(); if (!n) return; this.panTo((vx - n.x) / n.k, (vy - n.y) / n.k); }

  /** View coordinates (CSS px inside the element) → picture pixels. */
  toPicture(x: number, y: number): { x: number; y: number } {
    const vw = this.el.clientWidth, vh = this.el.clientHeight;
    return { x: this.cx + (x - vw / 2) / this._zoom, y: this.cy + (y - vh / 2) / this._zoom };
  }

  /** The picture's rectangle inside the element (CSS px). */
  pictureRect(): { x: number; y: number; w: number; h: number } | null {
    const p = this.picture;
    if (!p) return null;
    const vw = this.el.clientWidth, vh = this.el.clientHeight;
    return { x: vw / 2 - this.cx * this._zoom, y: vh / 2 - this.cy * this._zoom, w: p.width * this._zoom, h: p.height * this._zoom };
  }

  draw(): void {
    if (this.drawQueued || this.destroyed) return;
    this.drawQueued = true;
    requestAnimationFrame(() => { this.drawQueued = false; this.paint(); });
  }

  private paint(): void {
    const ctx = this.ctx;
    const dpr = this.canvas.width / Math.max(1, this.el.clientWidth);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const p = this.picture;
    if (!p) return;
    const r = this.pictureRect()!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const prefs = this.app.prefs;
    // Transparent pixels show the chosen backdrop.
    if (p.current.hasAlpha && prefs.alphaDisplay !== 'checkerboard') {
      ctx.fillStyle = prefs.alphaDisplay === 'white' ? '#fff' : prefs.alphaDisplay === 'black' ? '#000' : prefs.alphaColor;
      ctx.fillRect(r.x, r.y, r.w, r.h);
    } else if (p.current.hasAlpha) {
      this.checkerboard(ctx, r);
    }
    const frame = p.currentFrame;
    // Only the visible part of the picture is drawn (source rectangle), which keeps very large pictures fast.
    const vw = this.el.clientWidth, vh = this.el.clientHeight;
    const sx = Math.max(0, Math.floor((0 - r.x) / this._zoom)), sy = Math.max(0, Math.floor((0 - r.y) / this._zoom));
    const ex = Math.min(frame.width, Math.ceil((vw - r.x) / this._zoom)), ey = Math.min(frame.height, Math.ceil((vh - r.y) / this._zoom));
    if (ex <= sx || ey <= sy) return;
    ctx.imageSmoothingEnabled = this._zoom < 1 || prefs.smoothZoom;
    ctx.imageSmoothingQuality = 'high';
    try {
      ctx.drawImage(paintHooks.override(this.tab) || displayFrame(frame, p.current), sx, sy, ex - sx, ey - sy, r.x + sx * this._zoom, r.y + sy * this._zoom, (ex - sx) * this._zoom, (ey - sy) * this._zoom);
    } catch (e) { /* a closed bitmap after a quick navigation */ }
    const sxp = this.splitX();
    if (sxp !== null) {
      const b = split.before!;
      ctx.save(); ctx.beginPath(); ctx.rect(Math.max(0, r.x), 0, Math.max(0, sxp - Math.max(0, r.x)), this.el.clientHeight); ctx.clip();
      try { ctx.drawImage(b, 0, 0, split.beforeW, split.beforeH, r.x, r.y, r.w, r.h); } catch { /* */ }
      ctx.restore();
      ctx.save(); ctx.fillStyle = '#fff'; ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 4;
      const top = Math.max(0, r.y), bot = Math.min(this.el.clientHeight, r.y + r.h);
      ctx.fillRect(Math.round(sxp) - 1, top, 2, bot - top);
      const my = (top + bot) / 2; ctx.beginPath(); ctx.arc(sxp, my, 14, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
      ctx.fillStyle = '#333'; ctx.beginPath(); ctx.moveTo(sxp - 4, my - 6); ctx.lineTo(sxp - 10, my); ctx.lineTo(sxp - 4, my + 6); ctx.moveTo(sxp + 4, my - 6); ctx.lineTo(sxp + 10, my); ctx.lineTo(sxp + 4, my + 6); ctx.fill();
      ctx.font = '12px sans-serif'; ctx.textBaseline = 'top';
      const chip = (t: string, x: number, alignRight: boolean) => { const w = ctx.measureText(t).width + 12; const xx = alignRight ? x - w - 8 : x + 8; ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.fillRect(xx, top + 8, w, 20); ctx.fillStyle = '#fff'; ctx.fillText(t, xx + 6, top + 12); };
      chip(split.labelA, sxp, true); chip(split.labelB, sxp, false);
      ctx.restore();
    }
    if (this._zoom >= 8 && (this.app as any).pixelGrid) this.grid(ctx, r, sx, sy, ex, ey);
    const sel = this.tab.selection;
    if (sel) this.drawSelection(ctx, r, sel);
    const vs = viewState;
    if (vs.grid !== 'off' || vs.rulers || vs.clipping || vs.peaking || vs.histogram || vs.osd || vs.loupe || vs.navigator || (vs.measure.on && vs.measure.pts.length) || (vs.ocr.show && vs.ocr.words.length) || vs.codes.length) {
      const f = this.tab.folder;
      drawOverlays(ctx, this, r, frame, { name: p.name, index: f.index, total: f.length, exif: p.exif, size: p.bytes.length, page: p.page, pages: p.pages.length, dpi: p.current.dpi, template: viewState.osdTemplate ?? this.app.prefs.osdTemplate, pointer: this.pointer });
    }
    paintHooks.overlay(ctx, this, r, this.pointer);
    viewHooks.changed(this);
  }

  private drawSelection(ctx: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }, sel: { x: number; y: number; w: number; h: number }): void {
    const z = this._zoom;
    const x = r.x + sel.x * z, y = r.y + sel.y * z, w = sel.w * z, hh = sel.h * z;
    const vw = this.el.clientWidth, vh = this.el.clientHeight;
    ctx.save();
    // Dim everything outside the selection.
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.beginPath(); ctx.rect(0, 0, vw, vh); ctx.rect(x, y, w, hh); ctx.fill('evenodd');
    const mask = this.tab.selectionMask;
    if (mask) { const p = this.picture!; if (this.maskCanvas?.mask !== mask) { const c = document.createElement('canvas'); c.width = p.width; c.height = p.height; c.getContext('2d')!.putImageData(new ImageData(maskOverlay(mask, p.width, p.height) as Uint8ClampedArray<ArrayBuffer>, p.width, p.height), 0, 0); this.maskCanvas = { mask, canvas: c }; } ctx.imageSmoothingEnabled = false; ctx.drawImage(this.maskCanvas.canvas, sel.x, sel.y, sel.w, sel.h, x, y, w, hh); }
    if (this.lassoPts.length > 1) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); this.lassoPts.forEach(([px, py], i) => { const vx = r.x + px * z, vy = r.y + py * z; if (i) ctx.lineTo(vx, vy); else ctx.moveTo(vx, vy); }); ctx.stroke(); }
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#fff'; ctx.setLineDash([]); ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(hh));
    ctx.strokeStyle = '#000'; ctx.setLineDash([5, 5]); ctx.lineDashOffset = (Date.now() / 60) % 10; ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(hh));
    const label = `${sel.w} × ${sel.h}  @ ${sel.x}, ${sel.y}`;
    ctx.setLineDash([]); ctx.font = '12px system-ui, sans-serif';
    const tw = ctx.measureText(label).width + 10;
    const lx = Math.min(vw - tw - 2, Math.max(2, x)), ly = y > 22 ? y - 20 : y + hh + 4;
    ctx.fillStyle = 'rgba(0,0,0,.7)'; ctx.fillRect(lx, ly, tw, 18);
    ctx.fillStyle = '#fff'; ctx.fillText(label, lx + 5, ly + 13);
    // Handles at the corners and edge midpoints.
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000';
    if (!mask) for (const [hx, hy] of this.handlePoints(x, y, w, hh)) { ctx.fillRect(hx - 4, hy - 4, 8, 8); ctx.strokeRect(hx - 3.5, hy - 3.5, 7, 7); }
    ctx.restore();
  }

  private handlePoints(x: number, y: number, w: number, hh: number): [number, number][] {
    return [[x, y], [x + w / 2, y], [x + w, y], [x, y + hh / 2], [x + w, y + hh / 2], [x, y + hh], [x + w / 2, y + hh], [x + w, y + hh]];
  }

  /** Which selection handle (0–7), the inside (8), or nothing (−1) is under a view point. */
  private hitSelection(vx: number, vy: number): number {
    const sel = this.tab.selection, r = this.pictureRect();
    if (!sel || !r || this.tab.selectionMask) return -1;
    const z = this._zoom, x = r.x + sel.x * z, y = r.y + sel.y * z, w = sel.w * z, hh = sel.h * z;
    const pts = this.handlePoints(x, y, w, hh);
    for (let i = 0; i < pts.length; i++) if (Math.abs(pts[i][0] - vx) <= 6 && Math.abs(pts[i][1] - vy) <= 6) return i;
    return vx >= x && vx <= x + w && vy >= y && vy <= y + hh ? 8 : -1;
  }

  private checkerboard(ctx: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }): void {
    const size = 12;
    const vw = this.el.clientWidth, vh = this.el.clientHeight;
    const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y), x1 = Math.min(vw, r.x + r.w), y1 = Math.min(vh, r.y + r.h);
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip();
    ctx.fillStyle = '#d0d0d0'; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.fillStyle = '#f4f4f4';
    for (let y = Math.floor(y0 / size) * size; y < y1; y += size) for (let x = Math.floor(x0 / size) * size + ((Math.floor(y / size) & 1) ? size : 0); x < x1; x += size * 2) ctx.fillRect(x, y, size, size);
    ctx.restore();
  }

  private grid(ctx: CanvasRenderingContext2D, r: { x: number; y: number }, sx: number, sy: number, ex: number, ey: number): void {
    ctx.strokeStyle = 'rgba(128,128,128,.45)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = sx; x <= ex; x++) { const px = Math.round(r.x + x * this._zoom) + 0.5; ctx.moveTo(px, r.y + sy * this._zoom); ctx.lineTo(px, r.y + ey * this._zoom); }
    for (let y = sy; y <= ey; y++) { const py = Math.round(r.y + y * this._zoom) + 0.5; ctx.moveTo(r.x + sx * this._zoom, py); ctx.lineTo(r.x + ex * this._zoom, py); }
    ctx.stroke();
  }

  // ----------------------------------------------------------------------------------------
  // Animation

  startAnimation(): void {
    this.stopAnimation();
    if (this.destroyed) return; // a closed window's viewer does not start again (its timer would refresh the app for ever)
    const p = this.picture;
    if (!p || !p.animated) return;
    let loops = 0;
    const tick = () => {
      const pic = this.picture;
      if (this.destroyed || !pic || !pic.animated || !this.playing) { this.animTimer = null; return; }
      const page = pic.current;
      let next = pic.frame + 1;
      if (next >= page.frames.length) { loops++; if (page.loops && loops >= page.loops) { this.animTimer = null; return; } next = 0; }
      pic.frame = next;
      this.draw();
      this.app.refresh();
      this.animTimer = setTimeout(tick, page.frames[next].delay || 100);
    };
    this.animTimer = setTimeout(tick, p.currentFrame.delay || 100);
  }
  stopAnimation(): void { if (this.animTimer) { clearTimeout(this.animTimer); this.animTimer = null; } }
  togglePlay(): void { this.playing = !this.playing; if (this.playing) this.startAnimation(); else this.stopAnimation(); this.app.refresh(); }

  // ----------------------------------------------------------------------------------------
  // Pixel info

  pixelAt(x: number, y: number): [number, number, number, number] | null {
    const p = this.picture;
    if (!p || x < 0 || y < 0 || x >= p.width || y >= p.height) return null;
    const key = `${p.version}:${p.page}:${p.frame}`;
    if (!this.pixelCanvas || this.pixelKey !== key) { this.pixelCanvas = p.frameCanvas(); this.pixelKey = key; }
    const d = this.pixelCanvas.getContext('2d', { willReadFrequently: true })!.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  }

  private reportPointer(): void {
    if (!this.onPointer) return;
    if (!this.pointer || !this.picture || !this.app.prefs.pixelInfo) { this.onPointer(null); return; }
    const q = this.toPicture(this.pointer.x, this.pointer.y);
    const x = Math.floor(q.x), y = Math.floor(q.y);
    const rgba = this.pixelAt(x, y);
    this.onPointer(rgba ? { x, y, rgba } : null);
  }

  // ----------------------------------------------------------------------------------------
  // Input

  private wheelSteps = new WheelStepper();

  private bind(): void {
    const el = this.el;
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const anchor = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (e.ctrlKey || e.metaKey || this.app.prefs.wheel === 'zoom') { this.setZoom(this._zoom * wheelZoomFactor(e.deltaY, e.deltaMode), anchor); return; }
      const pr = this.pictureRect();
      const overflow = pr && (pr.h > el.clientHeight + 1 || pr.w > el.clientWidth + 1);
      if (this.app.prefs.wheel === 'scroll' || (overflow && !e.shiftKey)) {
        if (!pr) return;
        const dy = wheelPixels(e.deltaY, e.deltaMode), dx = wheelPixels(e.deltaX, e.deltaMode);
        this.cx += (e.shiftKey ? dy : dx) / this._zoom; this.cy += (e.shiftKey ? 0 : dy) / this._zoom;
        this.clampCenter(); this.draw(); this.reportPointer();
        return;
      }
      const step = this.wheelSteps.step(e.deltaY, e.deltaMode, performance.now());
      if (step) this.app.exec(step > 0 ? 'view.next' : 'view.previous');
    }, { passive: false });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      el.focus();
      const rr = el.getBoundingClientRect();
      const vx = e.clientX - rr.left, vy = e.clientY - rr.top;
      if (this.app.tab !== this.tab && viewHooks.tiled()) this.app.activate(this.tab);
      const sxp = this.splitX();
      if (sxp !== null && Math.abs(vx - sxp) <= 16) { this.splitDragging = true; try { el.setPointerCapture(e.pointerId); } catch { /* synthetic */ } return; }
      const nav = this.navigatorBox();
      if (nav && vx >= nav.x && vy >= nav.y && vx <= nav.x + nav.w && vy <= nav.y + nav.h) {
        this.navigating = true; this.navigateTo(vx, vy);
        try { el.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
        return;
      }
      if (this.picture && paintHooks.active(this.tab)) {
        const q = this.toPicture(vx, vy); this.painting = true;
        try { el.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
        paintHooks.down(this.tab, q.x, q.y, e);
        return;
      }
      if (viewState.measure.on && this.picture) {
        const m = viewState.measure, q = this.toPicture(vx, vy), p = this.picture;
        const pt: [number, number] = [Math.max(0, Math.min(p.width, q.x)), Math.max(0, Math.min(p.height, q.y))];
        if (m.closed) { m.pts = []; m.closed = false; }
        const last = m.pts[m.pts.length - 1];
        if (!last || Math.hypot(pt[0] - last[0], pt[1] - last[1]) * this._zoom > 3) m.pts.push(pt);
        this.draw(); this.app.refresh();
        return;
      }
      const hit = this.hitSelection(vx, vy);
      // Shift+drag or the selection tool draws a selection; a drag on an existing selection moves or resizes it.
      if (this.picture && (hit >= 0 || e.shiftKey || this.tab.selectTool) && e.pointerType !== 'touch' || (this.picture && this.tab.selectTool && e.pointerType === 'touch')) {
        const q = this.toPicture(vx, vy);
        this.selecting = { x0: q.x, y0: q.y, handle: hit >= 0 && !e.shiftKey ? hit : -1, start: this.tab.selection ? { ...this.tab.selection } : null };
        if (this.selecting.handle < 0) { this.tab.selection = null; this.tab.selectionMask = null; }
        if (this.tab.selectShape === 'lasso' && this.selecting.handle < 0) this.lassoPts = [[q.x, q.y]];
        el.setPointerCapture(e.pointerId);
        return;
      }
      this.dragging = { x: e.clientX, y: e.clientY, cx: this.cx, cy: this.cy, moved: false };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      this.pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (viewState.loupe) this.draw();
      if (this.splitDragging) { const r = this.pictureRect(); if (r) { split.x = Math.max(0, Math.min(1, (this.pointer.x - r.x) / r.w)); this.draw(); } return; }
      if (this.navigating) { this.navigateTo(this.pointer.x, this.pointer.y); return; }
      if (this.painting && this.picture) { const q = this.toPicture(this.pointer.x, this.pointer.y); paintHooks.move(this.tab, q.x, q.y, e); this.reportPointer(); return; }
      if (this.picture && paintHooks.active(this.tab)) { el.style.cursor = paintHooks.cursor(this.tab); this.draw(); this.reportPointer(); return; }
      if (this.selecting && this.picture && this.lassoPts.length) { const q = this.toPicture(this.pointer.x, this.pointer.y); const last = this.lassoPts[this.lassoPts.length - 1]; if (Math.abs(q.x - last[0]) + Math.abs(q.y - last[1]) >= 1) this.lassoPts.push([q.x, q.y]); this.draw(); return; }
      if (this.selecting && this.picture) {
        const q = this.toPicture(this.pointer.x, this.pointer.y);
        const p = this.picture, s = this.selecting, st = s.start;
        const dx = q.x - s.x0, dy = q.y - s.y0;
        let sel: { x: number; y: number; w: number; h: number };
        if (s.handle === 8 && st) sel = { x: st.x + dx, y: st.y + dy, w: st.w, h: st.h };
        else if (s.handle >= 0 && st) {
          let x1 = st.x, y1 = st.y, x2 = st.x + st.w, y2 = st.y + st.h;
          if ([0, 3, 5].includes(s.handle)) x1 += dx; if ([2, 4, 7].includes(s.handle)) x2 += dx;
          if ([0, 1, 2].includes(s.handle)) y1 += dy; if ([5, 6, 7].includes(s.handle)) y2 += dy;
          sel = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
        } else {
          let w = q.x - s.x0, hh = q.y - s.y0;
          if (e.ctrlKey || e.metaKey) { const m = Math.max(Math.abs(w), Math.abs(hh)); w = Math.sign(w || 1) * m; hh = Math.sign(hh || 1) * m; } // square
          sel = { x: Math.min(s.x0, s.x0 + w), y: Math.min(s.y0, s.y0 + hh), w: Math.abs(w), h: Math.abs(hh) };
        }
        if (s.handle === 8) { sel.x = Math.max(0, Math.min(p.width - sel.w, sel.x)); sel.y = Math.max(0, Math.min(p.height - sel.h, sel.y)); }
        const x = Math.max(0, Math.min(p.width, Math.round(sel.x))), y = Math.max(0, Math.min(p.height, Math.round(sel.y)));
        const x2 = Math.max(0, Math.min(p.width, Math.round(sel.x + sel.w))), y2 = Math.max(0, Math.min(p.height, Math.round(sel.y + sel.h)));
        this.tab.selection = x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null;
        this.draw();
        this.reportPointer();
        return;
      }
      const hit = this.picture && !this.dragging ? this.hitSelection(this.pointer.x, this.pointer.y) : -1;
      const sxq = this.splitX();
      el.style.cursor = sxq !== null && Math.abs(this.pointer.x - sxq) <= 16 ? 'ew-resize' : viewState.measure.on ? 'crosshair' : this.navigatorBox() && this.pointer && (() => { const n = this.navigatorBox()!; return this.pointer!.x >= n.x && this.pointer!.y >= n.y && this.pointer!.x <= n.x + n.w && this.pointer!.y <= n.y + n.h; })() ? 'pointer' : hit < 0 ? '' : hit === 8 ? 'move' : ['nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize', 'ew-resize', 'nesw-resize', 'ns-resize', 'nwse-resize'][hit];
      if (this.dragging && !this.pinch) {
        const dx = e.clientX - this.dragging.x, dy = e.clientY - this.dragging.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) this.dragging.moved = true;
        if (this.dragging.moved) { this.cx = this.dragging.cx - dx / this._zoom; this.cy = this.dragging.cy - dy / this._zoom; this.clampCenter(); this.draw(); }
      }
      this.reportPointer();
    });
    const up = (e: PointerEvent) => {
      if (this.splitDragging) { this.splitDragging = false; return; }
      if (this.navigating) { this.navigating = false; return; }
      if (this.painting) { this.painting = false; paintHooks.up(this.tab, e); return; }
      if (this.selecting) {
        const p = this.picture; const shape = this.tab.selectShape;
        if (p && this.lassoPts.length > 2) { const m = polygonMask(p.width, p.height, this.lassoPts); const b = maskBounds(m, p.width, p.height); this.lassoPts = []; this.tab.setSelection(b, b ? m : null); }
        else if (p && shape === 'ellipse' && this.tab.selection && this.selecting.handle < 0) { const sel = this.tab.selection; this.tab.setSelection(sel, ellipseMask(p.width, p.height, sel)); }
        this.lassoPts = []; this.selecting = null; this.app.refresh(); this.draw(); return;
      }
      if (!this.dragging) return;
      const d = this.dragging; this.dragging = null;
      if (!d.moved && e.pointerType === 'touch' && this.picture) {
        // Tap on the left or right third moves through the folder when the picture fits the view.
        const pr = this.pictureRect();
        if (pr && pr.w <= el.clientWidth + 1 && pr.h <= el.clientHeight + 1) { const x = e.clientX - el.getBoundingClientRect().left; if (x < el.clientWidth / 4) this.app.exec('view.previous'); else if (x > el.clientWidth * 3 / 4) this.app.exec('view.next'); }
      }
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', (e) => { this.dragging = null; this.selecting = null; this.navigating = false; this.splitDragging = false; if (this.painting) { this.painting = false; paintHooks.up(this.tab, e); } });
    el.addEventListener('pointerleave', () => { this.pointer = null; this.reportPointer(); });
    el.addEventListener('dblclick', (e) => {
      if (!this.picture) return;
      if (paintHooks.active(this.tab)) return;
      if (viewState.measure.on) { const m = viewState.measure; if (m.pts.length >= 3) m.closed = true; this.draw(); this.app.refresh(); return; }
      if (this.navigatorBox()) { const rr = el.getBoundingClientRect(), n = this.navigatorBox()!, x = e.clientX - rr.left, y = e.clientY - rr.top; if (x >= n.x && y >= n.y && x <= n.x + n.w && y <= n.y + n.h) return; }
      const r = el.getBoundingClientRect();
      const anchor = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (this.mode === 'fit' || this.mode === 'fit-large' || this.mode === null && this._zoom < 1) this.setZoom(1, anchor); else this.setZoom('fit');
    });
    el.addEventListener('touchstart', (e) => { if (e.touches.length === 2) { this.pinch = { d: dist(e), z: this._zoom }; } }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && this.pinch) {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        const mid = { x: (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left, y: (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top };
        this.setZoom(this.pinch.z * (dist(e) / this.pinch.d), mid);
      }
    }, { passive: false });
    el.addEventListener('touchend', (e) => { if (e.touches.length < 2) this.pinch = null; });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); this.app.ui.pictureContextMenu(e.clientX, e.clientY); });
    el.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); el.classList.add('qn-dropping'); } });
    el.addEventListener('dragleave', () => el.classList.remove('qn-dropping'));
    el.addEventListener('drop', () => el.classList.remove('qn-dropping'));
  }

  /**
   * Moves a picture larger than the window with an arrow key, along the axis where it does not fit. False when the key
   * is not a move here (the picture fits that way, or it is another key), so that the arrows stay Next and Previous.
   * Called by the shell's key handler, which sees every key first.
   */
  panKey(e: KeyboardEvent): boolean {
    if (!this.picture || e.ctrlKey || e.metaKey || e.altKey) return false;
    const map: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const d = map[e.key]; const pr = this.pictureRect();
    if (!d || !pr) return false;
    if (d[0] ? pr.w <= this.el.clientWidth + 1 : pr.h <= this.el.clientHeight + 1) return false;
    const step = 40 / this._zoom;
    e.preventDefault(); this.cx += d[0] * step; this.cy += d[1] * step; this.clampCenter(); this.draw();
    return true;
  }

  /** A short message over the picture (file name on navigation in full screen, warnings). */
  flash(text: string, ms = 1500): void {
    this.note.textContent = text;
    this.note.classList.add('qn-show');
    clearTimeout((this as any).noteTimer);
    (this as any).noteTimer = setTimeout(() => this.note.classList.remove('qn-show'), ms);
  }

  focus(): void { this.el.focus({ preventScroll: true }); }
  destroy(): void { this.destroyed = true; this.stopAnimation(); this.ro.disconnect(); }
}

function dist(e: TouchEvent): number { return Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); }
