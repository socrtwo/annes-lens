/**
 * AI tab, Generate group: Generate Picture, Variations, Sketch to Picture, Generate with
 * References, Generate Background, Seamless Pattern, Picture to Prompt, Compare Providers.
 * (Prompt Library lives with the provider commands.) Every result opens as a new, unsaved
 * picture with the prompt, service, model and date in its metadata and in AI History.
 */
import { def } from './registry';
import type { App } from '../app';
import type { Raster } from '../codecs/raster';
import { openDialog, toast, type Field } from '../ui/dialog';
import { askText, makePictures, withJob, currentRaster, deviceJob, device, hasImage, hasText, imageService, serviceById, type Provenance } from '../ai';
import { hasImages } from '../ai/hosted';
import { textResult, openResults, labeledGrid, has, canImage, canText, promptField, entryRaster, info } from './aiShared';
import { applyAlpha, refineAlpha, compositeOver } from './aiEdit';

const SIZES: { value: string; label: string }[] = [{ value: '1024x1024', label: 'Square 1024×1024' }, { value: '1536x1024', label: 'Landscape 1536×1024' }, { value: '1024x1536', label: 'Portrait 1024×1536' }];
const sizeOf = (v: string, app: App): { width: number; height: number } => { if (v === 'picture' && app.picture) return { width: app.picture.width, height: app.picture.height }; const [w, h] = v.split('x').map(Number); return { width: w || 1024, height: h || 1024 }; };
const gen = (command: string, service: string, model: string, prompt: string): Provenance => ({ command, service, model, prompt, kind: 'generated' });
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');

/** Blends the seams of a picture so it tiles: the half-offset copy underneath, the original fading in toward the center. */
export function seamless(r: Raster): Raster {
  const w = r.width, h = r.height, out = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) as Uint8ClampedArray<ArrayBuffer> };
  const ramp = (v: number, n: number) => Math.min(1, Math.min(v, n - 1 - v) / (n * 0.25));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = Math.min(ramp(x, w), ramp(y, h)), o = (y * w + x) * 4, s = (((y + (h >> 1)) % h) * w + ((x + (w >> 1)) % w)) * 4;
    for (let c = 0; c < 4; c++) out.data[o + c] = r.data[s + c] + (r.data[o + c] - r.data[s + c]) * k;
  }
  return out;
}
export function tile2x2(r: Raster): Raster {
  const w = r.width, h = r.height, out = { width: w * 2, height: h * 2, data: new Uint8ClampedArray(w * h * 16) as Uint8ClampedArray<ArrayBuffer> };
  for (let y = 0; y < h * 2; y++) for (let x = 0; x < w * 2; x++) out.data.set(r.data.subarray(((y % h) * w + (x % w)) * 4, ((y % h) * w + (x % w)) * 4 + 4), (y * w * 2 + x) * 4);
  return out;
}

const genFields = (app: App, arg: { prompt?: string; negative?: string } | undefined, withPictureSize: boolean): Field[] => [
  promptField('prompt', 'Prompt', arg?.prompt || '', 'a watercolor of a lighthouse at dusk'),
  { key: 'negative', label: 'Avoid (negative prompt, where supported)', type: 'text', value: arg?.negative || '' },
  { key: 'size', label: 'Size', type: 'select', options: [...SIZES, ...(withPictureSize && app.picture ? [{ value: 'picture', label: `Like the current picture (${app.picture.width}×${app.picture.height})` }] : [])], value: '1024x1024', half: true },
  { key: 'n', label: 'How many', type: 'number', min: 1, max: 4, value: 1, half: true },
  { key: 'seed', label: 'Seed (optional, where supported)', type: 'number', min: 0, max: 2147483647, value: '', half: true },
  { key: 'save', label: 'Save the prompt to the library', type: 'checkbox', value: false, half: true },
];
const savePrompt = (app: App, v: Record<string, any>, kind: 'generate' | 'edit') => { if (!v.save) return; const name = String(v.prompt).trim().slice(0, 40); if (!app.prefs.ai.prompts.some((p) => p.prompt === String(v.prompt).trim())) { app.prefs.ai.prompts.push({ name, prompt: String(v.prompt).trim(), negative: String(v.negative || ''), kind }); app.savePrefs(); } };

def([
  {
    id: 'ai.generate', icon: 'auto_awesome', noRecord: true, popular: true, isEnabled: hasImage, tip: 'Prompt, size, count, seed and negative prompt where the service supports them',
    run: async (app, arg?: { prompt?: string; negative?: string }) => {
      const s = imageService(app)!;
      const v = await openDialog({ title: 'Generate Picture', ok: 'Generate', wide: true, help: s.api === 'device' ? 'Runs on this device (Janus-Pro-1B through Transformers.js): 384 × 384 pictures from the prompt; size, seed and negative prompt do not apply.' : `${s.name} (${s.imageModel}). Sizes are rounded to what the service offers.`, fields: genFields(app, arg, false) });
      if (!v || !String(v.prompt).trim()) return;
      savePrompt(app, v, 'generate');
      const r = await withJob(app, 'ai.generate', (status, signal) => makePictures(app, { command: 'ai.generate', prompt: String(v.prompt).trim(), negative: String(v.negative || '').trim() || undefined, ...sizeOf(v.size, app), n: +v.n || 1, seed: v.seed === '' ? undefined : +v.seed }, status, signal));
      if (!r) return;
      await openResults(app, r.rasters, gen('ai.generate', r.service, r.model, String(v.prompt).trim()), `Generated ${stamp()}`);
      if (r.text) toast(`The service's note: ${r.text.slice(0, 200)}`, { ms: 8000 });
    },
  },
  {
    id: 'ai.variations', icon: 'dynamic_feed', noRecord: true, isEnabled: canImage, tip: 'New pictures like the current one',
    run: async (app) => {
      const v = await openDialog({ title: 'Variations', ok: 'Generate', fields: [{ key: 'n', label: 'How many', type: 'number', min: 1, max: 4, value: 2, half: true }, { key: 'extra', label: 'Keep or change (optional)', type: 'text', value: '', placeholder: 'same colors; different angle' }] });
      if (!v) return;
      const prompt = `Create a variation of this picture: the same subject, composition and style, with natural differences in detail${String(v.extra).trim() ? ` (${String(v.extra).trim()})` : ''}.`;
      const r = await withJob(app, 'ai.variations', (status, signal) => makePictures(app, { command: 'ai.variations', prompt, images: [currentRaster(app)], n: +v.n || 1 }, status, signal));
      if (r) await openResults(app, r.rasters, gen('ai.variations', r.service, r.model, prompt), `${app.picture!.name.replace(/\.[^.]+$/, '')} (variation)`);
    },
  },
  {
    id: 'ai.sketchToImage', icon: 'draw', noRecord: true, isEnabled: canImage, tip: 'A finished picture from a drawing or a scanned sketch (the current picture)',
    run: async (app) => {
      const v = await openDialog({ title: 'Sketch to Picture', ok: 'Generate', fields: [promptField('prompt', 'What the sketch shows and the look you want', '', 'a cottage by a lake, photorealistic, golden hour'), { key: 'n', label: 'How many', type: 'number', min: 1, max: 4, value: 1, half: true }] });
      if (!v || !String(v.prompt).trim()) return;
      const prompt = `Turn this sketch into a finished picture, following its lines and composition closely: ${String(v.prompt).trim()}.`;
      const r = await withJob(app, 'ai.sketchToImage', (status, signal) => makePictures(app, { command: 'ai.sketchToImage', prompt, images: [currentRaster(app)], n: +v.n || 1 }, status, signal));
      if (r) await openResults(app, r.rasters, gen('ai.sketchToImage', r.service, r.model, prompt), `${app.picture!.name.replace(/\.[^.]+$/, '')} (from sketch)`);
    },
  },
  {
    id: 'ai.generateWithRefs', icon: 'collections', noRecord: true, isEnabled: (app) => hasImage(app) && (!!app.picture || app.tab.marked.size > 0), tip: 'Style and subject references from the marked pictures (or the current one)',
    run: async (app) => {
      const refs = app.tab.marked.size ? [...app.tab.marked].slice(0, 6) : [app.picture!.entry];
      const v = await openDialog({ title: 'Generate with References', ok: 'Generate', help: `${refs.length} reference picture${refs.length === 1 ? '' : 's'}: ${refs.map((e) => e.name).join(', ')}`, fields: [promptField('prompt', 'Prompt', '', 'the same person in a snowy forest, in the style of the second picture'), { key: 'use', label: 'Use the references for', type: 'select', options: [{ value: 'both', label: 'Subject and style' }, { value: 'style', label: 'Style only' }, { value: 'subject', label: 'Subject only' }], value: 'both', half: true }, { key: 'n', label: 'How many', type: 'number', min: 1, max: 4, value: 1, half: true }] });
      if (!v || !String(v.prompt).trim()) return;
      const images: Raster[] = []; for (const e of refs) images.push(await entryRaster(app, e));
      const prompt = `Using the attached pictures as ${v.use === 'style' ? 'style references (colors, medium, mood; not their subjects)' : v.use === 'subject' ? 'subject references (the same people, objects or places; not their style)' : 'references for subject and style'}: ${String(v.prompt).trim()}`;
      const r = await withJob(app, 'ai.generateWithRefs', (status, signal) => makePictures(app, { command: 'ai.generateWithRefs', prompt, images, n: +v.n || 1 }, status, signal));
      if (r) await openResults(app, r.rasters, gen('ai.generateWithRefs', r.service, r.model, prompt), `Generated ${stamp()}`);
    },
  },
  {
    id: 'ai.generateBackground', icon: 'landscape', noRecord: true, isEnabled: canImage, tip: 'A new scene behind the cut-out subject (matting on the device, the scene from the picture service)',
    run: async (app) => {
      const v = await openDialog({ title: 'Generate Background', ok: 'Generate', fields: [promptField('prompt', 'The scene', '', 'a quiet beach at sunset'), { key: 'soft', label: 'Edge softness', type: 'range', min: 0, max: 4, value: 1, half: true }] });
      if (!v || !String(v.prompt).trim()) return;
      const r = currentRaster(app);
      const a = await deviceJob(app, 'modnet', undefined, undefined, (b, bytes) => device.matte(b, bytes, r)); if (!a) return;
      const prompt = `${String(v.prompt).trim()}. A background scene with no people, photographic, lit to match a portrait in front of it.`;
      const g = await withJob(app, 'ai.generateBackground', (status, signal) => makePictures(app, { command: 'ai.generateBackground', prompt, width: r.width, height: r.height }, status, signal)); if (!g) return;
      const alpha = refineAlpha(a, r.width, r.height, 1.5, +v.soft);
      await openResults(app, [compositeOver(r, alpha, g.rasters[0])], { command: 'ai.generateBackground', service: `this device + ${g.service}`, model: `MODNet + ${g.model}`, prompt, kind: 'edited' }, `${app.picture!.name.replace(/\.[^.]+$/, '')} (new background)`, 'AI edits');
      void applyAlpha;
    },
  },
  {
    id: 'ai.generateTile', icon: 'grid_on', noRecord: true, isEnabled: hasImage, tip: 'Tileable textures and backgrounds: generated, then the seams blended on the device; with a 2×2 preview',
    run: async (app) => {
      const v = await openDialog({ title: 'Seamless Pattern', ok: 'Generate', fields: [promptField('prompt', 'Texture or pattern', '', 'weathered oak planks'), { key: 'size', label: 'Tile size', type: 'select', options: SIZES, value: '1024x1024', half: true }, { key: 'preview', label: 'Also open a 2×2 tiled preview', type: 'checkbox', value: true, half: true }] });
      if (!v || !String(v.prompt).trim()) return;
      const prompt = `${String(v.prompt).trim()}, a seamless tileable texture: flat, evenly lit, repeating pattern that continues across its edges, no border, no vignette, no single centered object.`;
      const r = await withJob(app, 'ai.generateTile', (status, signal) => makePictures(app, { command: 'ai.generateTile', prompt, ...sizeOf(v.size, app) }, status, signal)); if (!r) return;
      const tile = seamless(r.rasters[0]);
      await openResults(app, v.preview ? [tile, tile2x2(tile)] : [tile], gen('ai.generateTile', r.service, r.model, prompt), `Pattern ${stamp()}`);
    },
  },
  {
    id: 'ai.imageToPrompt', icon: 'notes', noRecord: true, isEnabled: canText, tip: 'Describes the picture as a reusable prompt (subject, composition, lighting, medium, style)',
    run: async (app) => {
      const r = await withJob(app, 'ai.imageToPrompt', (status, signal) => askText(app, { command: 'ai.imageToPrompt', system: 'You write prompts for picture generation.', prompt: 'Write a prompt that would generate a picture like this one: subject, composition, lighting, color palette, medium or camera style, mood, in one paragraph of comma-separated phrases. Then a short negative prompt on a line starting with "Avoid:". Answer with those two parts only.', images: [currentRaster(app)] }, status, signal));
      if (!r) return;
      await textResult(app, 'Prompt from Picture', r.text, { note: `${r.service}, ${r.ms} ms.`, extra: [{ label: 'Save to the prompt library', onClick: (t) => { const [p, neg] = t.split(/\n+Avoid:\s*/i); app.prefs.ai.prompts.push({ name: `${app.picture!.name} prompt`, prompt: p.trim(), negative: (neg || '').trim(), kind: 'generate' }); app.savePrefs(); toast('Saved to the prompt library.'); } }, { label: 'Generate with it…', onClick: (t, ctl) => { ctl.close(); const [p, neg] = t.split(/\n+Avoid:\s*/i); app.exec('ai.generate', { prompt: p.trim(), negative: (neg || '').trim() }); } }] });
    },
  },
  {
    id: 'ai.generateCompare', icon: 'compare', noRecord: true, isEnabled: (app) => app.prefs.ai.services.filter((s) => hasImages(s)).length >= 2, tip: 'One prompt to several picture services; the results on a labeled sheet, each also opened on its own',
    run: async (app) => {
      const svcs = app.prefs.ai.services.filter((s) => hasImages(s));
      const v = await openDialog({ title: 'Compare Providers', ok: 'Generate', wide: true, fields: [promptField('prompt', 'Prompt', '', 'a red bicycle leaning on a stone wall'), ...svcs.map((s) => ({ key: `s_${s.id}`, label: `${s.name} — ${s.imageModel}`, type: 'checkbox' as const, value: true, half: true })), { key: 'size', label: 'Size', type: 'select', options: SIZES, value: '1024x1024', half: true }, info('<p>Each chosen service receives the same prompt once; the time and any text it returns are written under its result.</p>')] });
      if (!v || !String(v.prompt).trim()) return;
      const chosen = svcs.filter((s) => v[`s_${s.id}`]).slice(0, 6);
      if (chosen.length < 2) { toast('Choose at least two services.'); return; }
      const prompt = String(v.prompt).trim();
      const results = await withJob(app, 'ai.generateCompare', async (status, signal) => {
        let done = 0; status(`0 of ${chosen.length} answered`);
        return Promise.all(chosen.map(async (s) => { try { const r = await makePictures(app, { command: 'ai.generateCompare', prompt, ...sizeOf(v.size, app), service: s }, undefined, signal); status(`${++done} of ${chosen.length} answered`); return r ? { s, r } : null; } catch (e) { status(`${++done} of ${chosen.length} answered`); toast(`${s.name}: ${(e as Error).message}`, { ms: 7000 }); return null; } }));
      });
      if (!results) return;
      const ok = results.filter((x): x is { s: typeof chosen[0]; r: NonNullable<Awaited<ReturnType<typeof makePictures>>> } => !!x);
      if (!ok.length) { toast('No service returned a picture.'); return; }
      const sheet = labeledGrid(ok.map((x) => ({ raster: x.r.rasters[0], label: `${x.s.name} · ${x.s.imageModel} · ${(x.r.ms / 1000).toFixed(1)} s` })));
      await openResults(app, [sheet, ...ok.map((x) => x.r.rasters[0])], gen('ai.generateCompare', ok.map((x) => x.s.name).join(', '), ok.map((x) => x.s.imageModel).join(', '), prompt), `Compare ${stamp()}`);
    },
  },
]);
void has; void hasText; void serviceById;
