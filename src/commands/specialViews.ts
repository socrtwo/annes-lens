/**
 * View ▸ Stereo View, 360° View, Two-Page View, Right-to-Left Reading, Motion Photo, Play / Pause
 * and Save Current Frame.
 */
import { def } from './registry';
import type { App } from '../app';
import type { Raster } from '../codecs/raster';
import type { Picture } from '../picture/model';
import { decodePicture, encodeCanvas } from '../codecs/registry';
import { Folder, entryFromBytes } from '../picture/folder';
import { frameRaster } from '../picture/edit';
import { resample } from '../picture/ops';
import { h } from '../ui/dom';
import { toast } from '../ui/dialog';
import { openSpecial, specialOpen, rasterCanvas, type SpecialView } from '../ui/specialView';
import { mpoPair, splitSideBySide, renderStereo, type StereoMode } from '../picture/stereo';
import { looksEquirect } from '../picture/sphere';
import { findMotionClip, type Clip } from '../picture/motionPhoto';
import { extractMeta } from '../meta/metaWrite';

const has = (app: App) => !!app.picture;
const base = (n: string) => n.replace(/\.[^.]+$/, '');
export const reading = { rtl: false, cover: true };
const decodeBytes = async (u8: Uint8Array, name: string): Promise<Raster> => { const e = entryFromBytes(name, u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer); const p = await decodePicture(u8, e); const r = frameRaster(p.currentFrame); p.release(); return r; };
async function openAsPicture(app: App, c: HTMLCanvasElement, name: string): Promise<void> { const blob = await encodeCanvas(c, 'png'); await app.openFolder(new Folder([entryFromBytes(name, await blob.arrayBuffer())], 'Frames'), 0, { newWindow: true }); toast(`${name} opened (not saved yet).`); }

// Stereo -----------------------------------------------------------------------------------------

const STEREO_MODES: { id: StereoMode; label: string }[] = [
  { id: 'dubois', label: 'Anaglyph, color (red-cyan)' }, { id: 'half', label: 'Anaglyph, half color' }, { id: 'gray', label: 'Anaglyph, gray' },
  { id: 'crossEye', label: 'Cross-eye (right | left)' }, { id: 'parallel', label: 'Parallel (left | right)' }, { id: 'left', label: 'Left eye only' }, { id: 'right', label: 'Right eye only' },
];
async function stereoSource(app: App): Promise<{ L: Raster; R: Raster; how: string } | null> {
  const p = app.picture!, t = app.tab;
  const pair = p.format.id === 'jpeg' ? mpoPair(p.bytes) : null;
  if (pair) return { L: await decodeBytes(pair.left, 'left.jpg'), R: await decodeBytes(pair.right, 'right.jpg'), how: 'MPO pair' };
  const marked = t.folder.entries.filter((e) => t.marked.has(e));
  if (marked.length === 2) { const [a, b] = marked; return { L: await decodeBytes(new Uint8Array(await a.read()), a.name), R: await decodeBytes(new Uint8Array(await b.read()), b.name), how: `${a.name} and ${b.name}` }; }
  const r = frameRaster(p.currentFrame);
  if (r.width < r.height * 1.2) { toast('This is not a stereo pair: open an MPO file, a side-by-side picture, or mark two pictures (left, then right).', { ms: 7000 }); return null; }
  const s = splitSideBySide(r); return { L: s.left, R: s.right, how: 'side-by-side picture' };
}
async function openStereo(app: App, mode: StereoMode): Promise<void> {
  const src = await stereoSource(app); if (!src) return;
  const sv = openSpecial(app, 'stereo', `Stereo View · ${src.how}`) as SpecialView & { stereo?: any };
  const st = { L: src.L, R: src.R, mode, swap: false, composite: null as Raster | null };
  const render = (keep = true) => { st.composite = renderStereo(st.L, st.R, st.mode, st.swap); sv.setImage(rasterCanvas(st.composite), keep); };
  const sel = h('select', { 'aria-label': 'Stereo mode', onchange: (e: Event) => { st.mode = (e.target as HTMLSelectElement).value as StereoMode; render(false); } }, ...STEREO_MODES.map((m) => h('option', { value: m.id, selected: m.id === mode }, m.label)));
  sv.controls(sel, h('label', null, h('input', { type: 'checkbox', onchange: (e: Event) => { st.swap = (e.target as HTMLInputElement).checked; render(); } }), 'Swap eyes'));
  sv.stereo = st; render(false); sv.mount();
}

// 360° -------------------------------------------------------------------------------------------

function openSphere(app: App): void {
  const p = app.picture!; let r = frameRaster(p.currentFrame);
  const xmp = extractMeta(p.bytes).xmp; const xs = xmp ? new TextDecoder().decode(xmp) : '';
  if (!looksEquirect(r.width, r.height, xs)) toast('This picture is not 2:1, so it may not be a full 360° panorama; shown as one anyway.', { ms: 6000 });
  if (r.width > 4096) r = resample(r, 4096, Math.round(r.height * 4096 / r.width), 'lanczos3');
  const sv = openSpecial(app, 'sphere', '360° View'); sv.pano = r;
  const fov = h('input', { type: 'range', min: '20', max: '120', value: '90', 'aria-label': 'Field of view', oninput: (e: Event) => { sv.look.fov = +(e.target as HTMLInputElement).value; sv.draw(); } }) as HTMLInputElement;
  sv.controls(h('label', null, 'Field of view', fov), h('button', { class: 'ql-btn', type: 'button', onclick: () => { sv.look = { yaw: 0, pitch: 0, fov: 90 }; fov.value = '90'; sv.draw(); } }, 'Reset'), h('span', { class: 'ql-help' }, 'Drag to look around; wheel or slider for the field of view; arrows turn.'));
  sv.onKeyExtra = (e) => { const st = 10; if (e.key === 'ArrowLeft') sv.look.yaw -= st; else if (e.key === 'ArrowRight') sv.look.yaw += st; else if (e.key === 'ArrowUp') sv.look.pitch = Math.min(89, sv.look.pitch + st); else if (e.key === 'ArrowDown') sv.look.pitch = Math.max(-89, sv.look.pitch - st); else return false; sv.draw(); return true; };
  sv.mount();
}

// Two-page ---------------------------------------------------------------------------------------

/** Spreads for `n` pages: with a cover, page 1 alone, then pairs. */
export function spreadsFor(n: number, cover: boolean): number[][] {
  const out: number[][] = []; let i = 0;
  if (cover && n) { out.push([0]); i = 1; }
  for (; i < n; i += 2) out.push(i + 1 < n ? [i, i + 1] : [i]);
  return out;
}
function compose(pages: HTMLCanvasElement[], rtl: boolean): HTMLCanvasElement {
  const H = Math.max(...pages.map((p) => p.height)), ws = pages.map((p) => Math.round(p.width * H / p.height));
  const c = document.createElement('canvas'); c.width = ws.reduce((s, w) => s + w, 0); c.height = H;
  const x = c.getContext('2d')!; x.imageSmoothingQuality = 'high';
  const order = rtl ? [...pages.keys()].reverse() : [...pages.keys()];
  let at = 0; for (const k of order) { x.drawImage(pages[k], at, 0, ws[k], H); at += ws[k]; }
  return c;
}
function openSpread(app: App): void {
  const p = app.picture!, f = app.folder, multipage = p.pages.length > 1;
  const count = multipage ? p.pages.length : f.length, start = multipage ? p.page : f.index;
  const cache = new Map<number, Promise<HTMLCanvasElement>>();
  const get = (i: number): Promise<HTMLCanvasElement> => {
    let c = cache.get(i); if (c) return c;
    c = multipage ? Promise.resolve(rasterCanvas(frameRaster(p.pages[i].frames[0]))) : (async () => { const e = f.entries[i]; if (e === p.entry) return p.frameCanvas(); const q = await decodePicture(new Uint8Array(await e.read()), e); const cv = q.frameCanvas(); return cv; })();
    cache.set(i, c); if (cache.size > 10) cache.delete(cache.keys().next().value!);
    return c;
  };
  const sv = openSpecial(app, 'spread', 'Two-Page View') as SpecialView & { spread?: any };
  const st = { spreads: spreadsFor(count, reading.cover), index: 0 };
  st.index = Math.max(0, st.spreads.findIndex((s) => s.includes(start)));
  const info = h('span', { class: 'ql-help' });
  const show = async () => { const s = st.spreads[st.index]; const cs = await Promise.all(s.map(get)); sv.setImage(compose(cs, reading.rtl)); info.textContent = `${s.map((i) => i + 1).join('–')} of ${count}${reading.rtl ? ' · right to left' : ''}`; for (const s2 of st.spreads[st.index + 1] || []) void get(s2); };
  const go = (d: number) => { const n = Math.max(0, Math.min(st.spreads.length - 1, st.index + d)); if (n === st.index) { toast(d > 0 ? 'Last pages' : 'First pages'); return; } st.index = n; void show(); };
  const coverBox = h('input', { type: 'checkbox', checked: reading.cover, onchange: (e: Event) => { const first = st.spreads[st.index][0]; reading.cover = (e.target as HTMLInputElement).checked; st.spreads = spreadsFor(count, reading.cover); st.index = Math.max(0, st.spreads.findIndex((s) => s.includes(first))); void show(); } });
  sv.controls(info, h('label', null, coverBox, 'First page alone'), h('button', { class: 'ql-btn', type: 'button', onclick: () => go(reading.rtl ? 1 : -1) }, '◀'), h('button', { class: 'ql-btn', type: 'button', onclick: () => go(reading.rtl ? -1 : 1) }, '▶'));
  sv.onKeyExtra = (e) => {
    const fwd = reading.rtl ? 'ArrowLeft' : 'ArrowRight', back = reading.rtl ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === fwd || e.key === 'PageDown' || e.key === ' ') go(1); else if (e.key === back || e.key === 'PageUp' || e.key === 'Backspace') go(-1); else if (e.key === 'Home') { st.index = 0; void show(); } else if (e.key === 'End') { st.index = st.spreads.length - 1; void show(); } else return false;
    return true;
  };
  sv.spread = { st, show, go, refresh: () => show() };
  const close = sv.close.bind(sv);
  sv.close = () => { const first = st.spreads[st.index]?.[0]; close(); if (first === undefined) return; if (multipage) { if (p.page !== first) { p.page = first; p.frame = 0; app.viewer.pictureChanged(); app.refresh(); } } else if (f.index !== first && f.select(first)) void app.tab.show(); };
  void show(); sv.mount();
}

// Motion photos ----------------------------------------------------------------------------------

const clips = new WeakMap<Picture, Clip | null>();
export function clipOf(p: Picture | null): Clip | null { if (!p || p.format.id !== 'jpeg') return null; if (!clips.has(p)) clips.set(p, findMotionClip(p.bytes)); return clips.get(p) || null; }
function openMotion(app: App): void {
  const p = app.picture!, clip = clipOf(p); if (!clip) { toast('No video clip in this picture.'); return; }
  const blob = new Blob([p.bytes.subarray(clip.offset, clip.offset + clip.length) as BlobPart], { type: clip.mime });
  const sv = openSpecial(app, 'motion', `Motion Photo · ${clip.how}`);
  const ext = clip.mime === 'video/quicktime' ? 'mov' : 'mp4';
  sv.controls(h('span', { class: 'ql-help' }, `${(clip.length / 1024).toFixed(0)} KB clip`), h('button', { class: 'ql-btn', type: 'button', onclick: () => sv.saveClip(blob, `${base(p.name)}.${ext}`) }, 'Save clip…'), h('button', { class: 'ql-btn', type: 'button', onclick: () => app.exec('view.mediaFrame') }, 'Save current frame'));
  sv.mount(); sv.showVideo(blob);
}

/** The Media Player for a video or audio file: the file's bytes in a media element over the poster or cover art. */
function openMedia(app: App): void {
  const p = app.picture!, m = p.media; if (!m) { toast('This is not a video or audio file.'); return; }
  const blob = new Blob([p.bytes as BlobPart], { type: m.mime });
  const sv = openSpecial(app, 'media', `${m.kind === 'video' ? 'Video' : 'Audio'} · ${m.title || p.name}`);
  const dur = p.info.duration ? h('span', { class: 'ql-help' }, p.info.duration) : null;
  sv.controls(...(dur ? [dur] : []), ...(m.kind === 'video' ? [h('button', { class: 'ql-btn', type: 'button', onclick: () => app.exec('view.mediaFrame') }, 'Save current frame')] : []));
  sv.mount();
  if (m.kind === 'audio') sv.setImage(p.frameCanvas());
  sv.showMedia(blob, m.kind);
}

def([
  {
    id: 'view.stereo', icon: 'view_in_ar', kind: 'menu', noRecord: true, isEnabled: has, isActive: () => specialOpen()?.kind === 'stereo', tip: 'MPO files, side-by-side pairs or two marked pictures: red-cyan anaglyph, cross-eye or parallel',
    menu: () => STEREO_MODES.map((m) => ({ id: 'view.stereo', arg: m.id, label: m.label })),
    run: (app, mode?: StereoMode) => openStereo(app, mode || 'dubois'),
  },
  { id: 'view.sphere', icon: '360', noRecord: true, isEnabled: has, isActive: () => specialOpen()?.kind === 'sphere', tip: 'Look around an equirectangular panorama or photo sphere', run: (app) => { if (specialOpen()?.kind === 'sphere') specialOpen()!.close(); else openSphere(app); } },
  { id: 'view.twoPage', icon: 'menu_book', kind: 'toggle', noRecord: true, isEnabled: (app) => !!app.picture && (app.picture.pages.length > 1 || app.folder.length > 1), isActive: () => specialOpen()?.kind === 'spread', tip: 'Facing pages: the folder\'s pictures (comics, a scanned book) or a multipage file\'s pages; arrows turn two at a time', run: (app) => { if (specialOpen()?.kind === 'spread') specialOpen()!.close(); else openSpread(app); } },
  { id: 'view.rtl', icon: 'format_textdirection_r_to_l', kind: 'toggle', noRecord: true, isActive: () => reading.rtl, tip: 'Pages read right to left (manga): the first page on the right, the left arrow goes forward', run: () => { reading.rtl = !reading.rtl; const sv = specialOpen() as any; if (sv?.kind === 'spread') sv.spread.refresh(); toast(reading.rtl ? 'Right-to-left reading.' : 'Left-to-right reading.'); } },
  { id: 'view.motionPhoto', icon: 'motion_photos_on', noRecord: true, isEnabled: (app) => !!clipOf(app.picture), isActive: () => specialOpen()?.kind === 'motion', tip: 'Plays the clip inside a Google or Samsung motion photo; save the clip or a frame', run: (app) => { if (specialOpen()?.kind === 'motion') specialOpen()!.close(); else openMotion(app); } },
  { id: 'view.media', icon: 'smart_display', kind: 'toggle', noRecord: true, isEnabled: (app) => !!app.picture?.media, isActive: () => specialOpen()?.kind === 'media', tip: 'Plays a video or audio file met while browsing (opens by itself when one is shown); Esc closes it', run: (app) => { if (specialOpen()?.kind === 'media') specialOpen()!.close(); else openMedia(app); } },
  {
    id: 'view.mediaPlay', icon: 'play_pause', noRecord: true, isEnabled: (app) => !!specialOpen()?.player || !!app.picture?.animated || !!app.picture?.media, tip: 'Plays or pauses a video or audio file, a motion photo\'s clip or an animated picture',
    run: (app) => { const v = specialOpen()?.player; if (v) { if (v.paused) void v.play(); else v.pause(); return; } if (app.picture?.media) { openMedia(app); return; } if (app.picture?.animated) app.viewer.togglePlay(); },
  },
  {
    id: 'view.mediaFrame', icon: 'add_photo_alternate', noRecord: true, isEnabled: (app) => !!specialOpen()?.video || !!app.picture?.animated, tip: 'The clip\'s or the animation\'s current frame as a new picture',
    run: async (app) => {
      const sv = specialOpen(), p = app.picture;
      if (sv?.video) { const c = await sv.videoFrame(); if (!c) { toast('No frame to save yet.'); return; } const t = sv.video.currentTime; await openAsPicture(app, c, `${base(p?.name || 'clip')} (frame ${t.toFixed(2)} s).png`); return; }
      if (p?.animated) { const c = rasterCanvas(frameRaster(p.currentFrame)); await openAsPicture(app, c, `${base(p.name)} (frame ${p.frame + 1}).png`); }
    },
  },
]);
