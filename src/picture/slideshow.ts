/**
 * The slideshow: timing, order (folder or random), looping, transitions (fade, wipe, slide, zoom,
 * pan and zoom), captions through the information overlay, kiosk mode, and a self-contained HTML
 * export. The show drives the folder of the active window; a snapshot of the outgoing picture is
 * animated over the viewer for transitions. `showHooks` lets Background Music (picture/music.ts) and
 * the Phone Remote (commands/slideshowMedia.ts) follow the show.
 */
import type { App } from '../app';
import { viewState } from '../ui/overlays';
import { h, jsonForScript } from '../ui/dom';

export type Transition = 'none' | 'fade' | 'wipe' | 'slide' | 'zoom' | 'panzoom' | 'random';
export interface SlideshowSettings { seconds: number; transition: Transition; loop: boolean; random: boolean; captions: boolean; captionTemplate: string; kiosk: boolean; transitionMs: number; musicOn: boolean; musicVolume: number; musicShuffle: boolean }
export const DEFAULT_SLIDESHOW: SlideshowSettings = { seconds: 4, transition: 'fade', loop: true, random: false, captions: false, captionTemplate: '{name}\n{exifdate}', kiosk: false, transitionMs: 700, musicOn: false, musicVolume: 0.8, musicShuffle: false };

export const show = { running: false, paused: false, kiosk: false, order: [] as number[], pos: 0, timer: 0 as any, app: null as App | null, savedOsd: false, savedTemplate: '', overlay: null as HTMLElement | null, onEnd: null as null | (() => void) };

/** A shuffled or straight index order starting at `start`. */
export function makeOrder(n: number, start: number, random: boolean, rnd: () => number = Math.random): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  if (!random) return [...idx.slice(start), ...idx.slice(0, start)];
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  const at = idx.indexOf(start); if (at > 0) [idx[0], idx[at]] = [idx[at], idx[0]];
  return idx;
}
export function pickTransition(t: Transition, rnd: () => number = Math.random): Exclude<Transition, 'random'> { if (t !== 'random') return t; const all: Exclude<Transition, 'random' | 'none'>[] = ['fade', 'wipe', 'slide', 'zoom', 'panzoom']; return all[Math.floor(rnd() * all.length)]; }

/** Background music and the phone remote follow the show through these. */
export const showHooks = { start: [] as ((app: App) => void)[], stop: [] as ((app: App) => void)[], pause: [] as ((app: App, paused: boolean) => void)[], slide: [] as ((app: App) => void)[] };
const fire = <K extends keyof typeof showHooks>(k: K, ...a: Parameters<(typeof showHooks)[K][number]>) => { for (const f of showHooks[k] as ((...x: unknown[]) => void)[]) { try { f(...a); } catch (e) { console.warn(e); } } };

function settings(app: App): SlideshowSettings { return { ...DEFAULT_SLIDESHOW, ...app.prefs.slideshow }; }

/** Animates a snapshot of the current view out while the new picture shows beneath. */
function transitionOut(app: App, kind: Exclude<Transition, 'random'>, ms: number): void {
  const v = app.viewer; const canvas = v.el.querySelector('canvas') as HTMLCanvasElement | null;
  if (!canvas || kind === 'none' || ms <= 0) return;
  let url = ''; try { url = canvas.toDataURL(); } catch { return; }
  show.overlay?.remove();
  const img = h('img', { src: url, class: 'qn-show-overlay', style: `transition: opacity ${ms}ms ease, transform ${ms}ms ease, clip-path ${ms}ms linear;` }) as HTMLImageElement;
  v.el.appendChild(img); show.overlay = img;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (kind === 'fade') img.style.opacity = '0';
    else if (kind === 'wipe') { img.style.clipPath = 'inset(0 0 0 100%)'; }
    else if (kind === 'slide') { img.style.transform = 'translateX(-100%)'; img.style.opacity = '0.2'; }
    else if (kind === 'zoom') { img.style.transform = 'scale(1.6)'; img.style.opacity = '0'; }
    else if (kind === 'panzoom') { img.style.transform = 'scale(1.25) translateX(6%)'; img.style.opacity = '0'; }
  }));
  setTimeout(() => { if (show.overlay === img) show.overlay = null; img.remove(); }, ms + 50);
}

async function goTo(app: App, pos: number): Promise<void> {
  const f = app.tab.folder; const s = settings(app);
  if (pos >= show.order.length) { if (!s.loop) { stop(app); return; } pos = 0; if (s.random) show.order = makeOrder(f.length, show.order[show.order.length - 1] ?? 0, true).slice(1).concat(show.order[show.order.length - 1] ?? 0); }
  if (pos < 0) pos = s.loop ? show.order.length - 1 : 0;
  show.pos = pos;
  const idx = show.order[pos];
  if (idx !== f.index) { transitionOut(app, pickTransition(s.transition), s.transitionMs); f.select(idx); await app.tab.show(); }
  app.viewer.draw();
  schedule(app);
  fire('slide', app);
}
function schedule(app: App): void {
  clearTimeout(show.timer);
  if (!show.running || show.paused) return;
  const s = settings(app);
  if (s.seconds > 0) show.timer = setTimeout(() => { void goTo(app, show.pos + 1); }, s.seconds * 1000);
}

const onKey = (e: KeyboardEvent) => {
  const app = show.app; if (!app || !show.running) return;
  const k = e.key;
  if (show.kiosk && k !== 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); return; }
  if (k === ' ') { e.preventDefault(); e.stopImmediatePropagation(); togglePause(app); }
  else if (k === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); stop(app); }
  else if (k === 'ArrowRight' || k === 'PageDown') { e.preventDefault(); e.stopImmediatePropagation(); void goTo(app, show.pos + 1); }
  else if (k === 'ArrowLeft' || k === 'PageUp' || k === 'Backspace') { e.preventDefault(); e.stopImmediatePropagation(); void goTo(app, show.pos - 1); }
};

export function start(app: App, fromCurrent: boolean, kiosk = false): void {
  const f = app.tab.folder; if (!f.length) return;
  if (show.running) stop(app);
  const s = settings(app);
  show.app = app; show.running = true; show.paused = false; show.kiosk = kiosk || s.kiosk;
  show.order = makeOrder(f.length, fromCurrent ? Math.max(0, f.index) : 0, s.random);
  show.savedOsd = viewState.osd;
  if (s.captions) { viewState.osd = true; viewState.osdTemplate = s.captionTemplate; }
  document.body.classList.add('qn-slideshow'); if (show.kiosk) document.body.classList.add('qn-kiosk');
  window.addEventListener('keydown', onKey, true);
  void import('../commands/view').then(({ fullScreen }) => fullScreen(app, true));
  void goTo(app, 0);
  fire('start', app);
  app.refresh();
}
export function stop(app: App): void {
  if (!show.running) return;
  clearTimeout(show.timer); show.running = false; show.paused = false; show.kiosk = false;
  window.removeEventListener('keydown', onKey, true);
  show.overlay?.remove(); show.overlay = null;
  viewState.osd = show.savedOsd; viewState.osdTemplate = null;
  document.body.classList.remove('qn-slideshow', 'qn-kiosk');
  void import('../commands/view').then(({ fullScreen }) => fullScreen(app, false));
  app.viewer.draw(); app.refresh(); show.onEnd?.();
  fire('stop', app);
}
export function togglePause(app: App): boolean { if (!show.running) return false; show.paused = !show.paused; if (show.paused) clearTimeout(show.timer); else schedule(app); fire('pause', app, show.paused); app.viewer.flash(show.paused ? 'Paused' : 'Resumed'); app.refresh(); return show.paused; }
export const next = (app: App) => goTo(app, show.pos + 1);
export const previous = (app: App) => goTo(app, show.pos - 1);

/** A self-contained HTML slideshow page: pictures as data URLs, timing, transitions, captions, keyboard control. */
export function buildSlideshowHtml(items: { name: string; dataUrl: string; caption: string }[], s: SlideshowSettings, title: string): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const data = jsonForScript(items.map((i) => ({ src: i.dataUrl, caption: i.caption, name: i.name })));
  const cfg = jsonForScript({ seconds: s.seconds, transition: s.transition, loop: s.loop, random: s.random, captions: s.captions, ms: s.transitionMs });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>html,body{margin:0;height:100%;background:#000;color:#fff;font:14px/1.4 system-ui,sans-serif;overflow:hidden}#stage{position:fixed;inset:0}#stage img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;transition:opacity var(--ms) ease,transform var(--ms) ease,clip-path var(--ms) linear}#cap{position:fixed;left:0;right:0;bottom:0;padding:12px 18px;background:linear-gradient(transparent,rgba(0,0,0,.7));white-space:pre-line;text-shadow:0 1px 3px #000}#bar{position:fixed;top:0;left:0;height:3px;background:#fff8;width:0}#help{position:fixed;top:8px;right:12px;opacity:.6;font-size:12px}</style></head>
<body><div id="stage"></div><div id="cap"></div><div id="bar"></div><div id="help">Space pauses · arrows move · Esc stops the timer</div>
<script>
const items=${data};const cfg=${cfg};document.documentElement.style.setProperty('--ms',cfg.ms+'ms');
let order=items.map((_,i)=>i);if(cfg.random){for(let i=order.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[order[i],order[j]]=[order[j],order[i]];}}
let pos=0,paused=false,timer=0,cur=null;const stage=document.getElementById('stage'),cap=document.getElementById('cap'),bar=document.getElementById('bar');
function pick(){const t=cfg.transition;if(t!=='random')return t;return ['fade','wipe','slide','zoom','panzoom'][Math.floor(Math.random()*5)];}
function showAt(p){if(p>=order.length){if(!cfg.loop){clearTimeout(timer);return;}p=0;}if(p<0)p=order.length-1;pos=p;const it=items[order[pos]];const img=new Image();img.src=it.src;img.alt=it.name;const old=cur;stage.appendChild(img);cur=img;
if(old){const t=pick();old.style.zIndex='2';requestAnimationFrame(()=>requestAnimationFrame(()=>{if(t==='fade')old.style.opacity='0';else if(t==='wipe')old.style.clipPath='inset(0 0 0 100%)';else if(t==='slide'){old.style.transform='translateX(-100%)';old.style.opacity='.2'}else if(t==='zoom'){old.style.transform='scale(1.6)';old.style.opacity='0'}else if(t==='panzoom'){old.style.transform='scale(1.25) translateX(6%)';old.style.opacity='0'}else old.style.opacity='0';}));setTimeout(()=>old.remove(),cfg.ms+60);}
cap.textContent=cfg.captions?it.caption:'';schedule();}
function schedule(){clearTimeout(timer);bar.style.transition='none';bar.style.width='0';if(paused||cfg.seconds<=0)return;requestAnimationFrame(()=>{bar.style.transition='width '+cfg.seconds+'s linear';bar.style.width='100%';});timer=setTimeout(()=>showAt(pos+1),cfg.seconds*1000);}
document.addEventListener('keydown',(e)=>{if(e.key===' '){e.preventDefault();paused=!paused;schedule();}else if(e.key==='ArrowRight'||e.key==='PageDown')showAt(pos+1);else if(e.key==='ArrowLeft'||e.key==='PageUp')showAt(pos-1);else if(e.key==='Escape'){paused=true;schedule();}});
stage.addEventListener('click',()=>showAt(pos+1));showAt(0);
</script></body></html>`;
}
