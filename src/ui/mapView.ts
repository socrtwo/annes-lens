/**
 * A small slippy map for Browse ▸ Map: tiles from a tile server (OpenStreetMap by default) over an
 * offline outline of the world's countries (Natural Earth, drawn on a canvas, so the map works
 * without a network), with picture markers grouped when they are close. Drag or arrow keys pan;
 * the wheel, a pinch, double-click, + and − zoom.
 */
import { h } from './dom';
import { type View, type LatLon, type Cluster, tilesFor, tileUrl, toScreen, fromScreen, zoomAt, normalize, fitView, cluster, project, topoRings, type Topology } from '../geo/slippy';

export const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export type Basemap = 'osm' | 'offline' | 'custom';
export interface MapPoint extends LatLon { id: number; name: string }

/** A ring in unit Mercator coordinates (0…1 across the world) with its bounding box. */
interface Ring { xy: Float64Array; x0: number; y0: number; x1: number; y1: number }
let outline: Promise<Ring[]> | null = null;
/** Country outlines (Natural Earth 1:50m via world-atlas), loaded and projected once. */
export const loadOutline = (): Promise<Ring[]> => (outline ??= import('world-atlas/countries-50m.json').then((m) => {
  const out: Ring[] = [];
  for (const poly of topoRings((m.default || m) as unknown as Topology, 'countries')) for (const ring of poly) {
    const xy = new Float64Array(ring.length * 2); let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    ring.forEach((p, i) => { const q = project({ lon: p[0], lat: p[1] }, 0); const x = q.x / 256, y = q.y / 256; xy[i * 2] = x; xy[i * 2 + 1] = y; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); });
    out.push({ xy, x0, y0, x1, y1 });
  }
  return out;
}));

export class MapView {
  readonly el: HTMLDivElement;
  private base = h('canvas', { class: 'qn-map-base' }) as HTMLCanvasElement;
  private tiles = h('div', { class: 'qn-map-tiles' });
  private marks = h('div', { class: 'qn-map-marks' });
  private credit = h('div', { class: 'qn-map-credit' });
  private imgs = new Map<string, HTMLImageElement>();
  private rings: Ring[] | null = null;
  view: View = { z: 1, cx: 256, cy: 256 };
  points: MapPoint[] = [];
  clusters: Cluster<MapPoint>[] = [];
  basemap: Basemap = 'osm';
  template = OSM_TILES;
  active = -1;
  tileErrors = 0;
  maxZ = 19;
  onPick: (c: Cluster<MapPoint>) => void = () => undefined;
  onMove: () => void = () => undefined;
  private raf = 0;
  private ro: ResizeObserver;

  constructor() {
    this.el = h('div', { class: 'qn-map', tabindex: '0', role: 'application', 'aria-label': 'Map of the pictures. Drag or use the arrow keys to move, + and − to zoom.' }, this.base, this.tiles, this.marks, this.credit,
      h('div', { class: 'qn-map-zoom' }, h('button', { class: 'ql-btn', type: 'button', 'aria-label': 'Zoom in', onclick: () => this.zoomBy(1) }, '+'), h('button', { class: 'ql-btn', type: 'button', 'aria-label': 'Zoom out', onclick: () => this.zoomBy(-1) }, '−'))) as HTMLDivElement;
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.el);
    this.wire();
    void loadOutline().then((r) => { this.rings = r; this.draw(); }).catch(() => undefined);
  }
  get w(): number { return this.el.clientWidth || 600; }
  get h(): number { return this.el.clientHeight || 400; }
  destroy(): void { this.ro.disconnect(); cancelAnimationFrame(this.raf); }

  setPoints(points: MapPoint[], fit = true): void { this.points = points; if (fit) this.fit(points); else this.draw(); }
  fit(points: LatLon[] = this.points): void { this.view = fitView(points, this.w, this.h, 16); this.draw(); }
  setBasemap(b: Basemap, template?: string): void { this.basemap = b; this.template = b === 'osm' ? OSM_TILES : template || this.template; this.tiles.replaceChildren(); this.imgs.clear(); this.tileErrors = 0; this.draw(); }
  zoomBy(dz: number, x = this.w / 2, y = this.h / 2): void { this.view = normalize(zoomAt(this.view, dz, x, y, this.w, this.h, this.maxZ), this.h, 0, this.maxZ); this.draw(); }
  center(): LatLon { return fromScreen(this.w / 2, this.h / 2, this.view, this.w, this.h); }
  /** The points inside the visible area. */
  visible(): MapPoint[] { return this.points.filter((p) => { const s = toScreen(p, this.view, this.w, this.h); return s.x >= 0 && s.y >= 0 && s.x <= this.w && s.y <= this.h; }); }

  draw(): void { cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(() => this.paint()); }
  /** Draws at once (tests and the first frame). */
  paint(): void {
    if (!this.el.isConnected || !this.el.clientWidth) return; // no tiles before the map has its size
    const w = this.w, hh = this.h, v = this.view = normalize(this.view, hh, 0, this.maxZ);
    // Offline outline: sea, land and borders.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.base.width !== Math.round(w * dpr) || this.base.height !== Math.round(hh * dpr)) { this.base.width = Math.round(w * dpr); this.base.height = Math.round(hh * dpr); }
    const g = this.base.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#aad3df'; g.fillRect(0, 0, w, hh);
    if (this.rings) {
      const s = 2 ** v.z * 256, ox = w / 2 - v.cx, oy = hh / 2 - v.cy;
      g.fillStyle = '#f2efe9'; g.strokeStyle = '#b9a8b9'; g.lineWidth = 0.7;
      for (let copy = -1; copy <= 1; copy++) {
        const dx = ox + copy * s; if (dx > w || dx + s < 0) continue;
        g.beginPath();
        for (const r of this.rings) {
          if (r.x1 * s + dx < 0 || r.x0 * s + dx > w || r.y1 * s + oy < 0 || r.y0 * s + oy > hh) continue;
          const xy = r.xy;
          for (let i = 0; i < xy.length; i += 2) { const x = xy[i] * s + dx, y = xy[i + 1] * s + oy; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
          g.closePath();
        }
        g.fill('evenodd'); g.stroke();
      }
    }
    // Tiles.
    const want = new Set<string>();
    if (this.basemap !== 'offline' && this.template) {
      for (const t of tilesFor(v, w, hh)) {
        const key = `${t.z}/${t.x}/${t.y}/${Math.round(t.left)}`; want.add(key);
        let img = this.imgs.get(key);
        if (!img) {
          img = new Image(); img.alt = ''; img.decoding = 'async'; img.draggable = false; img.referrerPolicy = 'strict-origin-when-cross-origin';
          img.className = 'qn-map-tile'; img.onerror = () => { this.tileErrors++; img!.style.visibility = 'hidden'; };
          img.src = tileUrl(this.template, t); this.imgs.set(key, img); this.tiles.appendChild(img);
        }
        img.style.left = `${t.left}px`; img.style.top = `${t.top}px`; img.style.width = img.style.height = `${t.size}px`;
      }
    }
    for (const [k, img] of this.imgs) if (!want.has(k)) { img.remove(); this.imgs.delete(k); }
    this.credit.innerHTML = this.basemap === 'osm' ? 'Map © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' : this.basemap === 'offline' ? 'Outline: Natural Earth' : 'Tiles: your tile server';
    // Markers.
    this.clusters = cluster(this.points, v, w, hh, 26);
    this.marks.replaceChildren(...this.clusters.map((c) => {
      const n = c.items.length, act = c.items.some((p) => p.id === this.active);
      const names = c.items.slice(0, 6).map((p) => p.name).join(', ') + (n > 6 ? `, and ${n - 6} more` : '');
      return h('button', { class: `qn-map-pin${n > 1 ? ' qn-many' : ''}${act ? ' qn-active' : ''}`, type: 'button', style: `left:${c.x}px;top:${c.y}px`, title: names, 'aria-label': n > 1 ? `${n} pictures: ${names}` : names, onclick: (ev: Event) => { ev.stopPropagation(); this.onPick(c); } }, n > 1 ? String(n) : '');
    }));
    this.onMove();
  }

  private wire(): void {
    const ptrs = new Map<number, { x: number; y: number }>();
    let last: { x: number; y: number; d: number } | null = null, moved = 0;
    const mid = () => { const a = [...ptrs.values()]; const x = a.reduce((s, p) => s + p.x, 0) / a.length, y = a.reduce((s, p) => s + p.y, 0) / a.length; const d = a.length > 1 ? Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) : 0; return { x, y, d }; };
    const local = (e: PointerEvent | WheelEvent | MouseEvent) => { const r = this.el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    this.el.addEventListener('pointerdown', (e) => { if ((e.target as HTMLElement).closest('button,a')) return; this.el.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, local(e)); last = mid(); moved = 0; });
    this.el.addEventListener('pointermove', (e) => {
      if (!ptrs.has(e.pointerId) || !last) return;
      ptrs.set(e.pointerId, local(e)); const m = mid();
      this.view = { ...this.view, cx: this.view.cx - (m.x - last.x), cy: this.view.cy - (m.y - last.y) }; moved += Math.abs(m.x - last.x) + Math.abs(m.y - last.y);
      if (m.d && last.d) this.view = zoomAt(this.view, Math.log2(m.d / last.d), m.x, m.y, this.w, this.h, this.maxZ);
      last = m; this.draw();
    });
    const up = (e: PointerEvent) => { ptrs.delete(e.pointerId); last = ptrs.size ? mid() : null; if (!ptrs.size && moved > 2) { const z = Math.round(this.view.z); if (z !== this.view.z) this.zoomBy(z - this.view.z); } };
    this.el.addEventListener('pointerup', up); this.el.addEventListener('pointercancel', up);
    this.el.addEventListener('wheel', (e) => { e.preventDefault(); const p = local(e); this.zoomBy(e.deltaY < 0 ? 1 : -1, p.x, p.y); }, { passive: false });
    this.el.addEventListener('dblclick', (e) => { if ((e.target as HTMLElement).closest('button')) return; const p = local(e); this.zoomBy(e.shiftKey ? -1 : 1, p.x, p.y); });
    (this.el as any).__ownsKey = (e: KeyboardEvent) => !e.ctrlKey && !e.metaKey && !e.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', '_'].includes(e.key);
    this.el.addEventListener('keydown', (e) => {
      const step = 80, k = e.key;
      if (k === 'ArrowLeft') this.view.cx -= step; else if (k === 'ArrowRight') this.view.cx += step; else if (k === 'ArrowUp') this.view.cy -= step; else if (k === 'ArrowDown') this.view.cy += step;
      else if (k === '+' || k === '=') { this.zoomBy(1); e.preventDefault(); return; } else if (k === '-' || k === '_') { this.zoomBy(-1); e.preventDefault(); return; } else return;
      e.preventDefault(); this.draw();
    });
  }
}
