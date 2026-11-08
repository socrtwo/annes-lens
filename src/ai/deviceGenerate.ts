/**
 * On-device picture generation: a text-to-image model run entirely on this device through Transformers.js (the
 * runtime loads on demand from the build's own copy or the pinned CDN; the model downloads once into the browser
 * cache). Meant for desktop builds with WebGPU, as AI-PLAN.md says; it is offered elsewhere with a warning, since
 * WebAssembly on a phone is slow and memory-hungry. The loader is pluggable so the tests run the plumbing against a
 * fake generator.
 */
import type { Raster } from '../codecs/raster';
import { runtimeBase } from '../platform/runtimes';

export const TRANSFORMERS_VERSION = '4.3.2';
export const TRANSFORMERS_CDN = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}/dist/`;
/** The cache Transformers.js keeps model files in (deleted with the other downloaded models). */
export const TRANSFORMERS_CACHE = 'transformers-cache';

export interface GenModelSpec {
  id: string; title: string; repo: string; params: string;
  /** The picture size the model makes. */
  size: number;
  /** The files loaded on a GPU (fp16/q4 mix) and on WebAssembly, and their rough sizes in bytes. */
  dtype: Record<string, string>; bytes: number;
  /** The license as it is, not as the hub tags it: code and weights named separately. */
  license: string; licenseUrl: string; licenseNote: string;
}
export const GEN_MODELS: GenModelSpec[] = [{
  id: 'janus-pro-1b', title: 'Janus-Pro-1B (DeepSeek)', repo: 'onnx-community/Janus-Pro-1B-ONNX', params: '1.3 billion parameters', size: 384,
  dtype: { prepare_inputs_embeds: 'q4', language_model: 'q4f16', lm_head: 'fp16', gen_head: 'fp16', gen_img_embeds: 'fp16', image_decode: 'fp32' }, bytes: 2.1e9,
  license: 'code MIT; weights under the DeepSeek Model License', licenseUrl: 'https://huggingface.co/deepseek-ai/Janus-Pro-1B/blob/main/LICENSE',
  licenseNote: 'The DeepSeek Model License allows commercial use but carries use restrictions (its Attachment A: no military use, no harm to minors, no generation of unlawful or harmful content, and more). It is not a permissive license like the ones the app\'s other on-device models have; you accept it when you download the model.',
}];
export const genModelById = (id: string): GenModelSpec => { const m = GEN_MODELS.find((x) => x.id === id); if (!m) throw new Error(`Unknown model ${id}`); return m; };

export interface GenRequest { prompt: string; n: number; signal?: AbortSignal }
export type GenProgress = (status: string) => void;
/** What a loaded generator does: pictures from a prompt, as rasters of the model's size. */
export interface DeviceGenerator { generate(req: GenRequest, progress?: GenProgress): Promise<Raster[]>; model: GenModelSpec; device: 'webgpu' | 'wasm'; release(): void }
/** The app sets the loader (tests set a fake one). */
export const deviceGenHooks: { loader: (spec: GenModelSpec, progress?: GenProgress, signal?: AbortSignal) => Promise<DeviceGenerator> } = { loader: loadTransformersGenerator };

let current: Promise<DeviceGenerator> | null = null, currentId = '';
export const deviceGenLoaded = (): boolean => !!current;
export function releaseDeviceGenerator(): void { if (current) { void current.then((g) => g.release()).catch(() => undefined); current = null; currentId = ''; } }
/** The generator for a model, loaded once (downloads on first use; the status callback gets the progress). */
export function deviceGenerator(spec: GenModelSpec, progress?: GenProgress, signal?: AbortSignal): Promise<DeviceGenerator> {
  if (!current || currentId !== spec.id) { releaseDeviceGenerator(); currentId = spec.id; current = deviceGenHooks.loader(spec, progress, signal); current.catch(() => { current = null; currentId = ''; }); }
  return current;
}
export const gpuAvailable = (): boolean => typeof navigator !== 'undefined' && !!(navigator as any).gpu;
export const isPhone = (): boolean => typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
/** Whether the model has been downloaded (its files are in the Transformers.js cache). */
export async function deviceGenDownloaded(spec: GenModelSpec): Promise<boolean> {
  try { if (typeof caches === 'undefined') return false; const c = await caches.open(TRANSFORMERS_CACHE); const keys = await c.keys(); return keys.some((k) => k.url.includes(spec.repo) && /language_model/.test(k.url)); } catch { return false; }
}
export async function deleteDeviceGenCache(): Promise<void> { releaseDeviceGenerator(); try { if (typeof caches !== 'undefined') await caches.delete(TRANSFORMERS_CACHE); } catch { /* */ } }

/** Transformers.js: the runtime from the build's copy or the CDN, the model into the browser cache, WebGPU when the browser has it. */
async function loadTransformersGenerator(spec: GenModelSpec, progress?: GenProgress, signal?: AbortSignal): Promise<DeviceGenerator> {
  const base = await runtimeBase('transformers', TRANSFORMERS_CDN);
  progress?.('loading the runtime…');
  const tf: any = await import(/* @vite-ignore */ base + 'transformers.min.js');
  tf.env.allowLocalModels = false; tf.env.useBrowserCache = true;
  tf.env.backends.onnx.wasm.wasmPaths = base; // the ONNX Runtime files beside the runtime (the build's copy, or the CDN's)
  const device: 'webgpu' | 'wasm' = gpuAvailable() ? 'webgpu' : 'wasm';
  let last = 0;
  const cb = (p: any) => { if (signal?.aborted) throw new Error('Stopped'); if (p?.status === 'progress' && p.file) { const now = Date.now(); if (now - last > 200) { last = now; progress?.(`downloading ${String(p.file).replace(/^onnx\//, '')} ${Math.round(p.progress || 0)}%`); } } else if (p?.status === 'initiate' && p.file) progress?.(`fetching ${String(p.file).replace(/^onnx\//, '')}…`); };
  const processor = await tf.AutoProcessor.from_pretrained(spec.repo, { progress_callback: cb });
  const model = await tf.MultiModalityCausalLM.from_pretrained(spec.repo, { dtype: spec.dtype, device, progress_callback: cb });
  progress?.(`model loaded (${device === 'webgpu' ? 'WebGPU' : 'WebAssembly'})`);
  return {
    model: spec, device,
    async generate(req, prog) {
      const out: Raster[] = [];
      for (let i = 0; i < Math.max(1, req.n); i++) {
        if (req.signal?.aborted) throw new Error('Stopped');
        prog?.(`generating picture ${i + 1} of ${Math.max(1, req.n)} on this device (${device === 'webgpu' ? 'WebGPU' : 'WebAssembly, slow'})…`);
        const inputs = await processor([{ role: '<|User|>', content: req.prompt }], { chat_template: 'text_to_image' });
        const n = processor.num_image_tokens;
        const images = await model.generate_images({ ...inputs, min_new_tokens: n, max_new_tokens: n, do_sample: true });
        const img = Array.isArray(images) ? images[0] : images;
        out.push(rawImageToRaster(img));
      }
      return out;
    },
    release() { try { model.dispose?.(); } catch { /* */ } },
  };
}
/** A Transformers.js RawImage (RGB or RGBA bytes) to the app's raster. */
export function rawImageToRaster(img: { data: Uint8Array | Uint8ClampedArray; width: number; height: number; channels: number }): Raster {
  const { width, height, channels } = img, src = img.data, data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, o = 0; i < width * height; i++, o += 4) {
    if (channels === 1) { data[o] = data[o + 1] = data[o + 2] = src[i]; data[o + 3] = 255; }
    else { data[o] = src[i * channels]; data[o + 1] = src[i * channels + 1]; data[o + 2] = src[i * channels + 2]; data[o + 3] = channels > 3 ? src[i * channels + 3] : 255; }
  }
  return { width, height, data };
}
