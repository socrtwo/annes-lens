/**
 * The AI service facade the ai.* commands use: which service is active, sending text and pictures
 * (with the privacy rules: downscaled, metadata-free copies; a confirmation the first time), the
 * ensemble for text commands, the on-device runtime with model downloads, AI History, Stop AI, and
 * opening a result as a new labeled picture (or replacing the current one as an undoable step).
 */
import type { App, PictureTab } from '../app';
import type { Picture } from '../picture/model';
import type { Raster } from '../codecs/raster';
import { encodeCanvas } from '../codecs/registry';
import { Folder, entryFromBytes } from '../picture/folder';
import { editRaster, frameRaster, rasterFrame } from '../picture/edit';
import { resample } from '../picture/ops';
import { maskBounds, type Rect } from '../picture/mask';
import { setXmp } from '../meta/metaEdit';
import { updateXmp, type XmpProps } from '../meta/xmp';
import { confirmDialog, openDialog, toast } from '../ui/dialog';
import { h, esc } from '../ui/dom';
import { chat, generateImage, hasImages } from './hosted';
import { runEnsemble } from './ensemble';
import { addHistory } from './history';
import * as device from './device';
import { deviceGenerator, genModelById, deviceGenDownloaded, gpuAvailable as genGpu, isPhone as genPhone, type GenModelSpec } from './deviceGenerate';
import { AiStopped, type AiService, type ChatImage, type ChatRequest, type ImageRequest } from './types';

// Services ---------------------------------------------------------------------------------------

export const serviceById = (app: App, id: string): AiService | null => app.prefs.ai.services.find((s) => s.id === id) || null;
export const textService = (app: App): AiService | null => serviceById(app, app.prefs.ai.textService);
export const imageService = (app: App): AiService | null => { const s = serviceById(app, app.prefs.ai.imageService); return hasImages(s) ? s : null; };
export const hasText = (app: App): boolean => !!textService(app)?.textModel;
export const hasImage = (app: App): boolean => !!imageService(app);
/**
 * Whether a service's address is on this computer or the local network (no confirmation to send there), judged from
 * the host name as a whole: localhost, or an IP address in the loopback, private or link-local ranges. A name that only
 * begins like one (localhost.example.com, 10.example.org) is a remote host.
 */
export function isLocalAddress(url: string): boolean {
  let host: string; try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  if (host === 'localhost' || host.endsWith('.localhost')) return true; // RFC 6761: always the loopback
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [+v4[1], +v4[2]]; if ([a, b, +v4[3], +v4[4]].some((n) => n > 255)) return false;
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 0 && b === 0 && +v4[3] === 0 && +v4[4] === 0);
  }
  if (host.startsWith('[') && host.endsWith(']')) {
    const h = host.slice(1, -1);
    if (h === '::1' || h === '::') return true;
    // An IPv4 address in IPv6 form (the URL parser writes ::ffff:192.168.0.2 as ::ffff:c0a8:2).
    const mapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/); if (mapped) { const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16); return isLocalAddress(`http://${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}/`); }
    return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h); // unique local fc00::/7, link-local fe80::/10
  }
  return false;
}
const remoteUrl = (s: AiService) => !isLocalAddress(s.baseUrl);

/** Why a command cannot run now (shown by the command), or null. */
export function needText(app: App): string | null { return hasText(app) ? null : 'Choose a text and vision service first (AI ▸ Set Up AI).'; }
export function needImage(app: App): string | null { return hasImage(app) ? null : 'Choose a picture service with a picture model first (AI ▸ Set Up AI).'; }

// Stop and status --------------------------------------------------------------------------------

let current: { label: string; ctl: AbortController; el: HTMLElement } | null = null;
export const aiBusy = (): boolean => !!current;
export function aiStop(): boolean { if (!current) return false; current.ctl.abort(); setStatus('Stopping…'); return true; }
function setStatus(text: string): void { if (current) (current.el.querySelector('.qn-ai-status-text') as HTMLElement).textContent = text; }
const checkStop = (): void => { if (current?.ctl.signal.aborted) throw new AiStopped(); };

/** Runs an AI job with a status bar (Stop button) and readable errors. */
export async function withJob<T>(app: App, label: string, fn: (status: (t: string) => void, signal: AbortSignal) => Promise<T>): Promise<T | null> {
  if (current) { toast('An AI command is still running. Stop it first (AI ▸ Stop AI).'); return null; }
  const ctl = new AbortController();
  const el = h('div', { class: 'qn-ai-status', role: 'status' }, h('span', { class: 'qn-ai-spinner' }), h('span', { class: 'qn-ai-status-text' }, label), h('button', { class: 'ql-btn', type: 'button', onclick: () => aiStop() }, 'Stop'));
  document.body.appendChild(el);
  current = { label, ctl, el };
  app.refresh();
  try {
    return await fn((t) => setStatus(`${label}: ${t}`), ctl.signal);
  } catch (e) {
    if (e instanceof AiStopped || ctl.signal.aborted || /^Stopped$/.test((e as Error)?.message || '')) toast(`${label} stopped.`);
    else toast(`${label}: ${(e as Error)?.message || e}`, { ms: 9000 });
    return null;
  } finally { el.remove(); current = null; app.refresh(); }
}

// Pictures in and out ----------------------------------------------------------------------------

/** The picture an AI edit was started on: its result goes back to this window and picture, not to whatever is active when the answer arrives. */
let origin: { tab: PictureTab; picture: Picture } | null = null;
export function currentRaster(app: App): Raster { const p = app.picture!; origin = { tab: app.tab, picture: p }; return frameRaster(p.currentFrame); }
/** The selection as a full-size mask (255 inside), or null when nothing is selected. */
export function selectionMask(app: App): { mask: Uint8Array; bounds: Rect } | null {
  const t = app.tab, p = t.picture; if (!p || !t.selection) return null;
  if (t.selectionMask && t.selectionMask.length === p.width * p.height) { const b = maskBounds(t.selectionMask, p.width, p.height); return b ? { mask: t.selectionMask, bounds: b } : null; }
  const m = new Uint8Array(p.width * p.height); const s = t.selection;
  for (let y = s.y; y < s.y + s.h; y++) m.fill(255, y * p.width + s.x, y * p.width + s.x + s.w);
  return { mask: m, bounds: { ...s } };
}
export function rasterCanvas(r: Raster): HTMLCanvasElement { return rasterFrame(r, 0).image as HTMLCanvasElement; }
/** A metadata-free PNG (or JPEG) of a raster, downscaled to the privacy limit. */
export async function pictureBlob(app: App, r: Raster, format: 'png' | 'jpeg' = 'png', maxEdge = app.prefs.ai.privacy.maxEdge): Promise<{ blob: Blob; scale: number; width: number; height: number }> {
  let scale = 1;
  if (Math.max(r.width, r.height) > maxEdge) { scale = maxEdge / Math.max(r.width, r.height); r = resample(r, Math.max(1, Math.round(r.width * scale)), Math.max(1, Math.round(r.height * scale)), 'lanczos3'); }
  const blob = await encodeCanvas(rasterCanvas(r), format, 0.92);
  return { blob, scale, width: r.width, height: r.height };
}
export async function blobRaster(blob: Blob): Promise<Raster> {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  const x = c.getContext('2d', { willReadFrequently: true })!; x.drawImage(bmp, 0, 0); bmp.close?.();
  const id = x.getImageData(0, 0, c.width, c.height);
  return { width: c.width, height: c.height, data: id.data as Uint8ClampedArray<ArrayBuffer> };
}
/** A mask PNG in the OpenAI convention: transparent where the picture may change. */
export async function openaiMask(mask: Uint8Array, w: number, h: number, scale: number): Promise<Blob> {
  const r: Raster = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) as Uint8ClampedArray<ArrayBuffer> };
  for (let i = 0; i < w * h; i++) { r.data[i * 4] = r.data[i * 4 + 1] = r.data[i * 4 + 2] = 0; r.data[i * 4 + 3] = mask[i] ? 0 : 255; }
  const out = scale === 1 ? r : resample(r, Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)), 'box');
  return encodeCanvas(rasterCanvas(out), 'png');
}
/** The same mask as a black-and-white picture (white = may change) for services without a mask parameter. */
export async function maskPicture(mask: Uint8Array, w: number, h: number, scale: number): Promise<Blob> {
  const r: Raster = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) as Uint8ClampedArray<ArrayBuffer> };
  for (let i = 0; i < w * h; i++) { const v = mask[i] ? 255 : 0; r.data[i * 4] = r.data[i * 4 + 1] = r.data[i * 4 + 2] = v; r.data[i * 4 + 3] = 255; }
  const out = scale === 1 ? r : resample(r, Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)), 'box');
  return encodeCanvas(rasterCanvas(out), 'png');
}
/** Blends `done` into `orig` inside the mask (feathered edge), after resizing `done` to the picture. */
export function blendMasked(orig: Raster, done: Raster, mask: Uint8Array, feather = 2): Raster {
  const w = orig.width, hh = orig.height;
  const d = done.width === w && done.height === hh ? done : resample(done, w, hh, 'lanczos3');
  const soft = featherMask(mask, w, hh, feather);
  const out = { width: w, height: hh, data: orig.data.slice() as Uint8ClampedArray<ArrayBuffer> };
  for (let i = 0; i < w * hh; i++) { const a = soft[i]; if (!a) continue; const o = i * 4; for (let c = 0; c < 4; c++) out.data[o + c] = orig.data[o + c] + (d.data[o + c] - orig.data[o + c]) * a; }
  return out;
}
export function featherMask(mask: Uint8Array, w: number, h: number, radius: number): Float32Array {
  const f = new Float32Array(w * h); for (let i = 0; i < f.length; i++) f[i] = mask[i] ? 1 : 0;
  if (radius <= 0) return f;
  for (let pass = 0; pass < radius; pass++) {
    const g = new Float32Array(f.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0, n = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h) { s += f[yy * w + xx]; n++; } } g[y * w + x] = s / n; }
    f.set(g);
  }
  return f;
}

export interface Provenance { command: string; service: string; model: string; prompt?: string; kind: 'generated' | 'edited' }
export function provenanceProps(app: App, p: Provenance): Partial<XmpProps> {
  if (!app.prefs.ai.credentials) return {};
  return { digitalSourceType: p.kind === 'generated' ? 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia' : 'http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia', aiCommand: p.command, aiProvider: p.service, aiModel: p.model, aiPrompt: p.prompt?.slice(0, 2000), aiDate: new Date().toISOString() };
}
const base = (n: string) => n.replace(/\.[^.]+$/, '');
let edits = 0;
/** Opens a result as a new picture (PNG with provenance), or replaces the current picture as an undoable step. */
export async function openResult(app: App, r: Raster, p: Provenance, opts: { name?: string; replace?: boolean; label?: string } = {}): Promise<void> {
  // An edit belongs to the picture it was made from. If that window has moved on to another picture (or is closed) while
  // the job ran, the result opens as a new picture instead of replacing whatever is shown now.
  const from = p.kind === 'edited' ? origin : null; origin = null;
  const fromTab = from && app.tabs.includes(from.tab) ? from.tab : null;
  const stillThere = !from || (!!fromTab && fromTab.picture === from.picture);
  const wantReplace = opts.replace ?? (app.prefs.ai.result === 'replace' && p.kind === 'edited' && !!app.picture);
  const replace = wantReplace && stillThere;
  if (replace) { editRaster(app, opts.label || p.command, () => r, { tab: fromTab || undefined }); toast(`${opts.label || p.command} applied${fromTab && fromTab !== app.tab ? ` to ${from!.picture.name}` : ''} (AI; undo with Ctrl+Z).`); return; }
  const srcPic = from?.picture || app.picture;
  const source = p.kind === 'edited' && srcPic ? { name: srcPic.name, bytes: srcPic.bytes, mime: srcPic.format.mime } : null;
  const blob = await encodeCanvas(rasterCanvas(r), 'png');
  let u8 = new Uint8Array(await blob.arrayBuffer());
  const props = provenanceProps(app, p);
  if (Object.keys(props).length) u8 = setXmp(u8, 'png', new TextEncoder().encode(updateXmp(null, props))) as Uint8Array<ArrayBuffer>;
  const cur = srcPic?.name;
  const name = opts.name || (p.kind === 'generated' || !cur ? `AI ${p.command.replace(/^ai\./, '')} ${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.png` : `${base(cur)} (AI edit ${++edits}).png`);
  const entry = entryFromBytes(name, u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer);
  if (source) entry.ingredient = source;
  await app.openFolder(new Folder([entry], p.kind === 'generated' ? 'Generated' : 'AI edits'), 0, { newWindow: true });
  toast(wantReplace && !stillThere ? `${name} opened as a new picture: the window had moved on from ${from!.picture.name} (AI result; not saved yet).` : `${name} opened (AI result; not saved yet).`, wantReplace && !stillThere ? { ms: 8000 } : undefined);
}

// Sending ----------------------------------------------------------------------------------------

/** Services (by address) the user agreed to send to in this session: agreeing for one does not cover another. */
const confirmedThisSession = new Set<string>();
const serviceKey = (s: AiService) => { try { return new URL(s.baseUrl).origin + new URL(s.baseUrl).pathname; } catch { return s.baseUrl; } };
async function confirmSend(app: App, s: AiService, what: string): Promise<boolean> {
  if (!remoteUrl(s)) return true;
  if (!app.prefs.ai.privacy.allowRemote) { toast('Sending pictures to services on the internet is off (AI ▸ AI and Privacy).'); return false; }
  if (!app.prefs.ai.privacy.confirmSend || confirmedThisSession.has(serviceKey(s))) return true;
  const r = await openDialog({ title: 'Send to an AI service?', ok: 'Send', fields: [
    { key: 'i', type: 'info', html: `<p>${esc(what)} will be sent to <b>${esc(s.name)}</b> (${esc(s.baseUrl)}). Pictures go as metadata-free copies no larger than ${app.prefs.ai.privacy.maxEdge} px on their long side.</p><p>Nothing is sent before you choose Send.</p>` },
    { key: 'again', label: 'Do not ask again', type: 'checkbox', value: false },
  ] });
  if (!r) return false;
  if (r.again) { app.prefs.ai.privacy.confirmSend = false; app.savePrefs(); }
  confirmedThisSession.add(serviceKey(s));
  return true;
}
const sizeOf = (b: Blob[]) => `${Math.round(b.reduce((n, x) => n + x.size, 0) / 1024)} KB`;

export interface TextJob { command: string; system?: string; prompt: string; images?: Raster[]; json?: boolean; maxTokens?: number; temperature?: number; history?: { role: 'user' | 'assistant'; text: string }[]; input?: string }
/** Asks the text and vision service (through the ensemble when it is on). Returns null when stopped or refused. */
export async function askText(app: App, job: TextJob, status?: (t: string) => void, signal?: AbortSignal): Promise<{ text: string; service: string; model: string; ms: number; deliberation?: string } | null> {
  const s = textService(app); if (!s) throw new Error(needText(app)!);
  const ens = app.prefs.ai.ensemble;
  const members = ens.mode === 'single' ? [s] : ens.members.map((id) => serviceById(app, id)).filter((x): x is AiService => !!x && !!x.textModel);
  const master = serviceById(app, ens.master) || s;
  const images: ChatImage[] = [];
  for (const r of job.images || []) { const { blob } = await pictureBlob(app, r, 'jpeg'); images.push({ blob, mime: 'image/jpeg' }); }
  const targets = [...new Set([...members, ...(ens.mode === 'master' ? [master] : [])])];
  for (const t of targets) if (!(await confirmSend(app, t, images.length ? `${images.length === 1 ? 'A copy of the picture' : `${images.length} picture copies`} (${sizeOf(images.map((i) => i.blob))}) and the request` : 'The request'))) return null;
  const req: ChatRequest = { system: job.system, json: job.json, maxTokens: job.maxTokens, temperature: job.temperature, messages: [...(job.history || []).map((m) => ({ role: m.role, text: m.text })), { role: 'user', text: job.prompt, images }] };
  status?.(members.length > 1 ? `asking ${members.length} services…` : `asking ${s.name}…`);
  const t0 = performance.now();
  const r = await runEnsemble(ens.mode, members.length ? members : [s], master, req, (svc, rq) => { checkStop(); return chat(svc, rq, signal); });
  const ms = Math.round(performance.now() - t0);
  addHistory({ command: job.command, service: r.service, model: r.model, prompt: job.prompt.slice(0, 500), input: job.input ?? app.picture?.name, result: r.text.slice(0, 2000), ms }, app.prefs.ai.historyMax);
  return { ...r, ms, deliberation: r.deliberation || undefined };
}

export interface ImageJob { command: string; prompt: string; negative?: string; width?: number; height?: number; n?: number; seed?: number; images?: Raster[]; mask?: Uint8Array; maskW?: number; maskH?: number; transparent?: boolean; service?: AiService }
/** Generates or edits pictures with the picture service. Returns rasters (null when stopped or refused). */
export async function makePictures(app: App, job: ImageJob, status?: (t: string) => void, signal?: AbortSignal): Promise<{ rasters: Raster[]; service: string; model: string; ms: number; text?: string; scale: number } | null> {
  const s = job.service || imageService(app); if (!s) throw new Error(needImage(app)!);
  if (s.api === 'device') return deviceMakePictures(app, job, s, status, signal);
  const req: ImageRequest = { prompt: job.prompt, negative: job.negative, width: job.width, height: job.height, n: job.n, seed: job.seed, transparent: job.transparent };
  let scale = 1;
  if (job.images?.length) { req.images = []; for (const r of job.images) { const b = await pictureBlob(app, r, 'png'); scale = b.scale; req.images.push(b.blob); } }
  if (job.mask && job.maskW && job.maskH) { if (s.api === 'openai') req.mask = await openaiMask(job.mask, job.maskW, job.maskH, scale); else req.maskPicture = await maskPicture(job.mask, job.maskW, job.maskH, scale); }
  if (!(await confirmSend(app, s, req.images?.length ? `${req.images.length === 1 ? 'A copy of the picture' : `${req.images.length} picture copies`} (${sizeOf(req.images)}) and the prompt` : 'The prompt'))) return null;
  status?.(`${s.name} is working…`);
  const t0 = performance.now();
  const out = await generateImage(s, req, signal);
  checkStop();
  const rasters: Raster[] = []; for (const b of out.blobs) rasters.push(await blobRaster(b));
  const ms = Math.round(performance.now() - t0);
  addHistory({ command: job.command, service: s.name, model: s.imageModel, prompt: job.prompt.slice(0, 500), input: job.images?.length ? app.picture?.name : undefined, result: `${rasters.length} picture${rasters.length === 1 ? '' : 's'} ${rasters[0].width}×${rasters[0].height}`, ms }, app.prefs.ai.historyMax);
  return { rasters, service: s.name, model: s.imageModel, ms, text: out.text, scale };
}

// On-device models -------------------------------------------------------------------------------

/** Generate Picture on this device (Transformers.js): a prompt in, pictures out; nothing is sent anywhere. */
async function deviceMakePictures(app: App, job: ImageJob, s: AiService, status?: (t: string) => void, signal?: AbortSignal): Promise<{ rasters: Raster[]; service: string; model: string; ms: number; text?: string; scale: number } | null> {
  if (job.images?.length || job.mask) throw new Error('On-device generation makes pictures from a prompt only; edits, variations and references need a picture service (AI ▸ Set Up AI).');
  const spec: GenModelSpec = genModelById(s.imageModel || 'janus-pro-1b');
  if (!(await deviceGenDownloaded(spec))) {
    const gb = (spec.bytes / 1e9).toFixed(1);
    const r = await openDialog({ title: 'Download the picture model?', ok: 'Download and accept the license', wide: true, fields: [
      { key: 'i', type: 'info', html: `<p><b>${spec.title}</b> (${spec.params}, about ${gb} GB, from huggingface.co/${spec.repo}) runs on this device; nothing leaves it. The download is kept in the browser's cache (AI ▸ Delete Downloaded Models removes it).</p><p><b>License:</b> ${spec.license} (<a href="${spec.licenseUrl}" target="_blank" rel="noopener">read it</a>). ${spec.licenseNote}</p><p>${genGpu() ? 'WebGPU is available here.' : `No WebGPU in this ${genPhone() ? 'device' : 'browser'}: the model would run on WebAssembly, slowly and with more than 4 GB of memory; a desktop browser with WebGPU, or a picture service, is the better choice.`}</p>` },
    ] });
    if (!r) return null;
  }
  const gen = await deviceGenerator(spec, status, signal);
  checkStop();
  const t0 = performance.now();
  const rasters = await gen.generate({ prompt: job.prompt + (job.negative ? '' : ''), n: Math.max(1, Math.min(4, job.n || 1)), signal }, status);
  checkStop();
  const ms = Math.round(performance.now() - t0);
  addHistory({ command: job.command, service: 'this device', model: spec.title, prompt: job.prompt.slice(0, 500), result: `${rasters.length} picture${rasters.length === 1 ? '' : 's'}, ${spec.size} × ${spec.size}`, ms });
  return { rasters, service: 'this device', model: spec.title, ms, text: job.negative ? 'The on-device model has no negative prompt; it was left out.' : undefined, scale: 1 };
}

let backend: device.Backend | null = null; let backendBase = '';
/** An explicit runtime address (a setting, or a test), or '' to use the build's local copy or the CDN. */
declare const __QN_TEST_HOOKS__: boolean;
/** The on-device runtime's address: the user's setting, else (in a test build only) the one the tests set. */
export function runtimeBase(app: App): string { return app.prefs.ai.runtimeUrl || (typeof __QN_TEST_HOOKS__ !== 'undefined' && __QN_TEST_HOOKS__ ? (window as any).__qnOrtBase : '') || ''; }
export function deviceBackend(app: App): device.Backend {
  const b = runtimeBase(app);
  if (!backend || backendBase !== b) { backend?.release?.(); backend = device.ortBackend(b); backendBase = b; }
  return backend;
}
export const dtypeOf = (app: App): 'quantized' | 'fp32' => app.prefs.ai.modelDtype;
const mb = (n: number) => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;

/** Makes sure a model is on the device (asks once, with license and size, then downloads with progress). Returns its files. */
export async function ensureModel(app: App, id: string, status?: (t: string) => void, signal?: AbortSignal): Promise<ArrayBuffer[] | null> {
  const spec = device.modelById(id), dtype = dtypeOf(app);
  if (!(await device.isDownloaded(spec, dtype))) {
    const ok = await confirmDialog('Download a model?', `${spec.title} (${mb(spec.sizes[dtype])}, ${spec.license} license, from huggingface.co/${spec.repo}) runs on this device; nothing leaves it. The download is kept in the browser cache (AI ▸ Delete Downloaded Models removes it). ${spec.note}`, 'Download');
    if (!ok) return null;
  }
  let last = 0;
  const files = await device.ensureModel(spec, dtype, (done, total, file) => { const now = Date.now(); if (now - last > 150) { last = now; status?.(`downloading ${file} ${mb(done)} of ${mb(total)}`); } }, signal);
  status?.('running on the device…');
  return files;
}
export const deviceAvailable = (): boolean => typeof WebAssembly !== 'undefined';
export const modelsOf = (task: device.Task): device.ModelSpec[] => device.MODELS.filter((m) => m.task === task);

/** Runs a job on a single-file model: matte, depth, inpaint, upscale. */
export async function deviceJob<T>(app: App, id: string, status: ((t: string) => void) | undefined, signal: AbortSignal | undefined, fn: (b: device.Backend, bytes: () => Promise<ArrayBuffer>) => Promise<T>, command?: string): Promise<T | null> {
  const files = await ensureModel(app, id, status, signal); if (!files) return null;
  const t0 = performance.now();
  const out = await fn(deviceBackend(app), async () => files[0]);
  const spec = device.modelById(id);
  addHistory({ command: command || app.lastCommand?.id || id, service: 'this device', model: `${spec.title} (${dtypeOf(app)}, ${device.runtimeStatus.provider || 'wasm'})`, input: app.picture?.name, result: 'done', ms: Math.round(performance.now() - t0) }, app.prefs.ai.historyMax);
  return out;
}
export { device };
