/**
 * Compare Pictures (Ctrl+Shift+Y): two to four pictures side by side over the window, with one
 * zoom and one center shared by every pane (as a fraction of each picture, so different sizes of
 * the same scene line up). Wheel zooms about the pointer, a drag pans, double-click toggles fit
 * and 100%, Esc closes. Each pane can be opened or flagged as the pick.
 */
import { displayFrame } from './overlays';
import type { App } from '../app';
import type { Entry } from '../picture/folder';
import { decodePicture } from '../codecs/registry';
import { h } from './dom';
import { patchXmp } from '../picture/metadata';
import { toast } from './dialog';
import { wheelZoomFactor } from './wheel';

export interface CompareState { rel: number; nx: number; ny: number }
/** Zoom so the whole picture fits the pane. */
export const fitIn = (pw: number, ph: number, vw: number, vh: number): number => Math.min(vw / pw, vh / ph);
/** After zooming by `factor` about a pane point (CSS px from the pane's top-left), the new shared state. */
export function zoomAbout(s: CompareState, factor: number, px: number, py: number, vw: number, vh: number, pw: number, ph: number): CompareState {
  const z0 = s.rel * fitIn(pw, ph, vw, vh), rel = Math.max(0.05, Math.min(64, s.rel * factor)), z1 = rel * fitIn(pw, ph, vw, vh);
  const qx = s.nx * pw + (px - vw / 2) / z0, qy = s.ny * ph + (py - vh / 2) / z0; // the picture point under the pointer
  return { rel, nx: (qx - (px - vw / 2) / z1) / pw, ny: (qy - (py - vh / 2) / z1) / ph };
}
/** After dragging by (dx, dy) CSS px in a pane. */
export function panBy(s: CompareState, dx: number, dy: number, vw: number, vh: number, pw: number, ph: number): CompareState {
  const z = s.rel * fitIn(pw, ph, vw, vh);
  return { ...s, nx: s.nx - dx / (z * pw), ny: s.ny - dy / (z * ph) };
}
/** Grid columns for n panes. */
export const columnsFor = (n: number): number => (n <= 3 ? n : 2);

interface Pane { entry: Entry; img: CanvasImageSource & { width: number; height: number }; w: number; h: number; canvas: HTMLCanvasElement; label: HTMLElement }

export class CompareView {
  el: HTMLElement;
  panes: Pane[] = [];
  state: CompareState = { rel: 1, nx: 0.5, ny: 0.5 };
  private drag: { x: number; y: number; s: CompareState; pane: Pane } | null = null;
  private onKey = (e: KeyboardEvent) => { if (document.querySelector('.ql-dialog')) return; if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); this.close(); } else if (e.key === '0') { this.state = { rel: 1, nx: 0.5, ny: 0.5 }; this.draw(); } else if (e.key === '+' || e.key === '=') this.zoomCenter(1.25); else if (e.key === '-') this.zoomCenter(0.8); };
  private ro: ResizeObserver;
  constructor(private app: App) {
    this.el = h('div', { class: 'qn-compare', role: 'dialog', 'aria-label': 'Compare pictures' });
    this.ro = new ResizeObserver(() => this.draw());
  }
  async open(entries: Entry[]): Promise<void> {
    const list = entries.slice(0, 4);
    for (const e of list) {
      const cur = this.app.picture;
      let img: CanvasImageSource & { width: number; height: number };
      // Color-managed like the main view (displayFrame returns the frame itself when nothing applies).
      const pic = cur && cur.entry === e ? cur : await decodePicture(new Uint8Array(await e.read()), e);
      const shown = displayFrame(pic.currentFrame, pic.current);
      img = shown instanceof HTMLCanvasElement ? shown : pic.frameCanvas();
      const canvas = h('canvas', { class: 'qn-cmp-canvas' }) as HTMLCanvasElement;
      const label = h('div', { class: 'qn-cmp-label' });
      this.panes.push({ entry: e, img, w: img.width, h: img.height, canvas, label });
    }
    const bar = h('div', { class: 'qn-cmp-bar' },
      h('b', null, `Compare ${this.panes.length} pictures`),
      h('span', { class: 'ql-spacer' }),
      h('button', { class: 'ql-btn', type: 'button', onclick: () => { this.state = { rel: 1, nx: 0.5, ny: 0.5 }; this.draw(); } }, 'Fit'),
      h('button', { class: 'ql-btn', type: 'button', onclick: () => this.actual() }, '100%'),
      h('button', { class: 'ql-btn', type: 'button', onclick: () => this.close() }, 'Close'));
    const grid = h('div', { class: 'qn-cmp-grid', style: `grid-template-columns: repeat(${columnsFor(this.panes.length)}, 1fr)` },
      ...this.panes.map((p) => {
        const cell = h('div', { class: 'qn-cmp-pane' }, p.canvas, p.label,
          h('div', { class: 'qn-cmp-actions' },
            h('button', { class: 'ql-btn', type: 'button', title: 'Flag as the pick', onclick: async () => { const r = await patchXmp(this.app, p.entry, { flag: 'pick' }); toast(r === 'failed' || r === 'canceled' ? 'Not flagged.' : `${p.entry.name} flagged as the pick.`); } }, 'Pick'),
            h('button', { class: 'ql-btn', type: 'button', title: 'Show this picture and close', onclick: () => { const i = this.app.folder.entries.indexOf(p.entry); this.close(); if (i >= 0 && this.app.folder.select(i)) void this.app.tab.show(); } }, 'Open')));
        this.bind(cell, p);
        return cell;
      }));
    this.el.replaceChildren(bar, grid);
    this.app.viewer.el.appendChild(this.el);
    for (const ev of ['contextmenu']) this.el.addEventListener(ev, (e) => e.stopPropagation());
    window.addEventListener('keydown', this.onKey, true);
    this.ro.observe(this.el);
    requestAnimationFrame(() => this.draw());
  }
  private size(p: Pane): { vw: number; vh: number } { return { vw: p.canvas.clientWidth || 1, vh: p.canvas.clientHeight || 1 }; }
  private bind(cell: HTMLElement, p: Pane): void {
    const c = p.canvas;
    c.addEventListener('wheel', (e) => { e.preventDefault(); e.stopPropagation(); const r = c.getBoundingClientRect(), { vw, vh } = this.size(p); this.state = zoomAbout(this.state, wheelZoomFactor(e.deltaY, e.deltaMode), e.clientX - r.left, e.clientY - r.top, vw, vh, p.w, p.h); this.draw(); }, { passive: false });
    c.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.drag = { x: e.clientX, y: e.clientY, s: { ...this.state }, pane: p }; try { c.setPointerCapture(e.pointerId); } catch { /* */ } });
    c.addEventListener('pointermove', (e) => { if (!this.drag || this.drag.pane !== p) return; const { vw, vh } = this.size(p); this.state = panBy(this.drag.s, e.clientX - this.drag.x, e.clientY - this.drag.y, vw, vh, p.w, p.h); this.draw(); });
    const end = () => { this.drag = null; };
    c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
    c.addEventListener('dblclick', (e) => { e.stopPropagation(); if (Math.abs(this.state.rel - 1) < 0.01) this.actual(); else { this.state = { rel: 1, nx: 0.5, ny: 0.5 }; this.draw(); } });
    cell.addEventListener('pointerdown', (e) => e.stopPropagation());
  }
  private zoomCenter(f: number): void { const p = this.panes[0]; if (!p) return; const { vw, vh } = this.size(p); this.state = zoomAbout(this.state, f, vw / 2, vh / 2, vw, vh, p.w, p.h); this.draw(); }
  /** 100% for the first picture (the others at the same relative zoom). */
  private actual(): void { const p = this.panes[0]; if (!p) return; const { vw, vh } = this.size(p); this.state = { ...this.state, rel: 1 / fitIn(p.w, p.h, vw, vh) }; this.draw(); }
  draw(): void {
    for (const p of this.panes) {
      const c = p.canvas, dpr = window.devicePixelRatio || 1, { vw, vh } = this.size(p);
      if (c.width !== Math.round(vw * dpr) || c.height !== Math.round(vh * dpr)) { c.width = Math.round(vw * dpr); c.height = Math.round(vh * dpr); }
      const x = c.getContext('2d')!; x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, c.width, c.height); x.setTransform(dpr, 0, 0, dpr, 0, 0);
      const z = this.state.rel * fitIn(p.w, p.h, vw, vh), ox = vw / 2 - this.state.nx * p.w * z, oy = vh / 2 - this.state.ny * p.h * z;
      x.imageSmoothingEnabled = z < 2; (x as any).imageSmoothingQuality = 'high';
      x.drawImage(p.img, ox, oy, p.w * z, p.h * z);
      p.label.textContent = `${p.entry.name} · ${p.w} × ${p.h} · ${Math.round(z * 100)}%`;
    }
  }
  close(): void { window.removeEventListener('keydown', this.onKey, true); this.ro.disconnect(); this.el.remove(); current = null; this.app.refresh(); }
}

let current: CompareView | null = null;
export const compareOpen = (): CompareView | null => current;
export async function openCompare(app: App, entries: Entry[]): Promise<CompareView> { current?.close(); current = new CompareView(app); await current.open(entries); app.refresh(); return current; }
