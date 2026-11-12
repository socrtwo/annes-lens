/**
 * The window-filling viewers for special pictures: Stereo View, 360° View, Two-Page View and
 * Motion Photo. Each sits over the picture with its own toolbar; Esc closes it. Static views
 * (stereo, spreads) zoom with the wheel and pan with a drag; the 360° view looks around with a
 * drag and changes the field of view with the wheel.
 */
import type { App } from '../app';
import type { Raster } from '../codecs/raster';
import { h } from './dom';
import { toast } from './dialog';
import { fitIn, zoomAbout, panBy, type CompareState } from './compareView';
import { renderSphere } from '../picture/sphere';
import { encodeCanvas } from '../codecs/registry';
import { Folder, entryFromBytes } from '../picture/folder';
import { saveAs } from '../platform/native';
import { wheelZoomFactor } from './wheel';

export type SpecialKind = 'stereo' | 'sphere' | 'spread' | 'motion' | 'media';
export const rasterCanvas = (r: Raster): HTMLCanvasElement => { const c = document.createElement('canvas'); c.width = r.width; c.height = r.height; c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height), 0, 0); return c; };

export class SpecialView {
  el: HTMLElement; bar: HTMLElement; stage: HTMLElement; canvas: HTMLCanvasElement;
  /** Static views: the picture shown, and the shared zoom/pan. */
  image: HTMLCanvasElement | null = null; state: CompareState = { rel: 1, nx: 0.5, ny: 0.5 };
  /** 360° view. */
  pano: Raster | null = null; look = { yaw: 0, pitch: 0, fov: 90 };
  video: HTMLVideoElement | null = null; videoUrl = '';
  /** The Media Player's audio element (audio files; the cover art stays on the canvas). */
  audio: HTMLAudioElement | null = null;
  onKeyExtra: ((e: KeyboardEvent) => boolean) | null = null;
  private drag: { x: number; y: number; s: CompareState; look: { yaw: number; pitch: number; fov: number } } | null = null;
  private ro: ResizeObserver; private raf = 0; private out: Uint8ClampedArray | null = null;
  private onKey = (e: KeyboardEvent) => { if (document.querySelector('.ql-dialog')) return; if (this.onKeyExtra?.(e)) { e.preventDefault(); e.stopImmediatePropagation(); return; } if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); this.close(); } };
  constructor(public app: App, public kind: SpecialKind, title: string) {
    this.canvas = h('canvas', { class: 'qn-sv-canvas' }) as HTMLCanvasElement;
    this.bar = h('div', { class: 'qn-cmp-bar qn-sv-bar' }, h('b', null, title));
    this.stage = h('div', { class: 'qn-sv-stage' }, this.canvas);
    this.el = h('div', { class: 'qn-compare qn-special', role: 'dialog', 'aria-label': title }, this.bar, this.stage);
    this.ro = new ResizeObserver(() => this.draw());
    this.bind();
  }
  /** Adds controls to the toolbar (before Close). */
  controls(...kids: HTMLElement[]): void { this.bar.append(...kids); }
  mount(): void {
    this.bar.append(h('span', { class: 'ql-spacer' }), ...(this.kind !== 'motion' && this.kind !== 'media' ? [h('button', { class: 'ql-btn', type: 'button', onclick: () => this.saveView() }, 'Save view as picture')] : []), h('button', { class: 'ql-btn', type: 'button', onclick: () => this.close() }, 'Close'));
    this.app.viewer.el.appendChild(this.el);
    window.addEventListener('keydown', this.onKey, true);
    this.ro.observe(this.el);
    requestAnimationFrame(() => this.draw());
  }
  setImage(c: HTMLCanvasElement, keepView = false): void { this.image = c; if (!keepView) this.state = { rel: 1, nx: 0.5, ny: 0.5 }; this.draw(); }
  private size() { return { vw: this.canvas.clientWidth || 1, vh: this.canvas.clientHeight || 1 }; }
  private bind(): void {
    const c = this.canvas;
    c.addEventListener('wheel', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (this.kind === 'sphere') { this.look.fov = Math.max(20, Math.min(120, this.look.fov / wheelZoomFactor(e.deltaY, e.deltaMode))); this.draw(); return; }
      if (!this.image) return; const r = c.getBoundingClientRect(), { vw, vh } = this.size();
      this.state = zoomAbout(this.state, wheelZoomFactor(e.deltaY, e.deltaMode), e.clientX - r.left, e.clientY - r.top, vw, vh, this.image.width, this.image.height); this.draw();
    }, { passive: false });
    c.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.drag = { x: e.clientX, y: e.clientY, s: { ...this.state }, look: { ...this.look } }; try { c.setPointerCapture(e.pointerId); } catch { /* */ } });
    c.addEventListener('pointermove', (e) => {
      if (!this.drag) return; const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y, { vw, vh } = this.size();
      if (this.kind === 'sphere') { const k = this.drag.look.fov / vw; this.look.yaw = ((this.drag.look.yaw - dx * k + 540) % 360) - 180; this.look.pitch = Math.max(-89, Math.min(89, this.drag.look.pitch + dy * k)); this.draw(); return; }
      if (this.image) { this.state = panBy(this.drag.s, dx, dy, vw, vh, this.image.width, this.image.height); this.draw(); }
    });
    const end = () => { this.drag = null; }; c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
    c.addEventListener('dblclick', (e) => { e.stopPropagation(); if (this.kind === 'sphere') { this.look = { yaw: 0, pitch: 0, fov: 90 }; } else this.state = { rel: 1, nx: 0.5, ny: 0.5 }; this.draw(); });
    this.el.addEventListener('contextmenu', (e) => e.stopPropagation());
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
  }
  draw(): void {
    if (this.kind === 'motion') return;
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.paint());
  }
  /** Paints now (tests call it to avoid waiting a frame). */
  paint(): void {
    const c = this.canvas, dpr = window.devicePixelRatio || 1, { vw, vh } = this.size();
    if (this.kind === 'sphere' && this.pano) {
      // The 360° view renders at the canvas's CSS size (capped), then scales up.
      const k = Math.min(1, 960 / vw), w = Math.max(1, Math.round(vw * k)), hh = Math.max(1, Math.round(vh * k));
      if (c.width !== w || c.height !== hh) { c.width = w; c.height = hh; }
      this.out = renderSphere(this.pano, w, hh, this.look.yaw, this.look.pitch, this.look.fov, this.out || undefined);
      c.getContext('2d')!.putImageData(new ImageData(this.out as Uint8ClampedArray<ArrayBuffer>, w, hh), 0, 0);
      return;
    }
    if (c.width !== Math.round(vw * dpr) || c.height !== Math.round(vh * dpr)) { c.width = Math.round(vw * dpr); c.height = Math.round(vh * dpr); }
    const x = c.getContext('2d')!; x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, c.width, c.height); x.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!this.image) return;
    const z = this.state.rel * fitIn(this.image.width, this.image.height, vw, vh), ox = vw / 2 - this.state.nx * this.image.width * z, oy = vh / 2 - this.state.ny * this.image.height * z;
    x.imageSmoothingEnabled = z < 2; (x as any).imageSmoothingQuality = 'high';
    x.drawImage(this.image, ox, oy, this.image.width * z, this.image.height * z);
  }
  /** What "Save view as picture" saves: the composite for static views, the current window for 360°. */
  viewCanvas(): HTMLCanvasElement | null {
    if (this.kind === 'sphere' && this.pano) { const w = 1600, hh = 1000, d = renderSphere(this.pano, w, hh, this.look.yaw, this.look.pitch, this.look.fov); return rasterCanvas({ width: w, height: hh, data: d as Uint8ClampedArray<ArrayBuffer> }); }
    return this.image;
  }
  async saveView(): Promise<void> {
    const c = this.viewCanvas(); if (!c) return;
    const blob = await encodeCanvas(c, 'png'), name = `${(this.app.picture?.name || 'view').replace(/\.[^.]+$/, '')} (${this.kind === 'sphere' ? '360 view' : this.kind === 'spread' ? 'spread' : 'stereo'}).png`;
    await this.app.openFolder(new Folder([entryFromBytes(name, await blob.arrayBuffer())], 'Views'), 0, { newWindow: true });
    toast(`${name} opened (not saved yet).`);
  }
  /** Motion Photo: the clip in a looping, muted video with controls. */
  showVideo(blob: Blob): HTMLVideoElement {
    this.videoUrl = URL.createObjectURL(blob);
    const v = h('video', { class: 'qn-sv-video', controls: true, loop: true, playsinline: true }) as HTMLVideoElement;
    v.muted = true; v.autoplay = true; v.src = this.videoUrl; this.video = v;
    this.canvas.replaceWith(v);
    void v.play().catch(() => undefined);
    return v;
  }
  /** Media Player: a video with sound and controls, or an audio element under the cover art. Autoplay may be refused until the user acts; the controls stay. */
  showMedia(blob: Blob, kind: 'video' | 'audio'): HTMLMediaElement {
    this.videoUrl = URL.createObjectURL(blob);
    if (kind === 'video') {
      const v = h('video', { class: 'qn-sv-video', controls: true, playsinline: true }) as HTMLVideoElement;
      v.src = this.videoUrl; this.video = v; this.canvas.replaceWith(v);
      void v.play().catch(() => undefined);
      return v;
    }
    const a = h('audio', { class: 'qn-sv-audio', controls: true }) as HTMLAudioElement;
    a.src = this.videoUrl; this.audio = a; this.stage.appendChild(a);
    void a.play().catch(() => undefined);
    return a;
  }
  /** The element playing, when the view has one. */
  get player(): HTMLMediaElement | null { return this.video || this.audio; }
  /** The video's current frame (waits for a presented frame when none has been shown yet). */
  async videoFrame(): Promise<HTMLCanvasElement | null> {
    const v = this.video; if (!v || !v.videoWidth) return null;
    const grab = () => { const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; const x = c.getContext('2d', { willReadFrequently: true })!; x.drawImage(v, 0, 0); return x.getImageData(0, 0, 1, 1).data[3] ? c : null; };
    let c = grab();
    if (!c) { const wasPaused = v.paused; await v.play().catch(() => undefined); await new Promise<void>((r) => { (v as any).requestVideoFrameCallback ? (v as any).requestVideoFrameCallback(() => r()) : setTimeout(r, 200); setTimeout(r, 2000); }); c = grab(); if (wasPaused) v.pause(); }
    return c;
  }
  async saveClip(blob: Blob, name: string): Promise<void> { const r = await saveAs(blob, name); toast(r ? `Saved ${r.name}.` : 'Not saved.'); }
  close(): void {
    window.removeEventListener('keydown', this.onKey, true); this.ro.disconnect(); cancelAnimationFrame(this.raf);
    for (const m of [this.video, this.audio]) if (m) { m.pause(); m.removeAttribute('src'); m.load(); }
    if (this.videoUrl) URL.revokeObjectURL(this.videoUrl);
    this.el.remove(); if (current === this) current = null; this.app.refresh();
  }
}

let current: SpecialView | null = null;
export const specialOpen = (): SpecialView | null => current;
export function openSpecial(app: App, kind: SpecialKind, title: string): SpecialView { current?.close(); current = new SpecialView(app, kind, title); return current; }
