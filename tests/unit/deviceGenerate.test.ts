import { describe, it, expect, beforeEach } from 'vitest';
import { GEN_MODELS, genModelById, deviceGenHooks, deviceGenerator, releaseDeviceGenerator, deviceGenLoaded, rawImageToRaster, TRANSFORMERS_CDN, type DeviceGenerator } from '../../src/ai/deviceGenerate';
import { hasImages, isDevice, PRESETS } from '../../src/ai/hosted';
import { sanitizePrefs, defaultPrefs } from '../../src/prefs';

const fake = (spec: any, calls: string[]): DeviceGenerator => ({ model: spec, device: 'wasm', release: () => calls.push('release'), generate: async (req, prog) => { prog?.('working'); calls.push(`gen:${req.prompt}:${req.n}`); return Array.from({ length: req.n }, () => ({ width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(200) })); } });

describe('on-device picture generation (the plumbing; the model runs in the browser)', () => {
  beforeEach(() => releaseDeviceGenerator());
  it('names the model and its license truthfully: MIT code, DeepSeek Model License weights, not "MIT"', () => {
    const m = genModelById('janus-pro-1b');
    expect(m.repo).toBe('onnx-community/Janus-Pro-1B-ONNX');
    expect(m.license).toMatch(/DeepSeek Model License/);
    expect(m.license).not.toMatch(/^MIT$/);
    expect(m.licenseNote).toMatch(/not a permissive license/);
    expect(m.size).toBe(384);
    expect(Object.keys(m.dtype).sort()).toEqual(['gen_head', 'gen_img_embeds', 'image_decode', 'language_model', 'lm_head', 'prepare_inputs_embeds']);
    expect(() => genModelById('nope')).toThrow(/Unknown model/);
    expect(TRANSFORMERS_CDN).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/npm\/@huggingface\/transformers@\d+\.\d+\.\d+\/dist\/$/);
  });
  it('loads a generator once per model through the pluggable loader, and releases it', async () => {
    const calls: string[] = [], loads: string[] = [];
    deviceGenHooks.loader = async (spec, progress) => { loads.push(spec.id); progress?.('loading'); return fake(spec, calls); };
    const status: string[] = [];
    const g1 = await deviceGenerator(GEN_MODELS[0], (t) => status.push(t));
    const g2 = await deviceGenerator(GEN_MODELS[0]);
    expect(g1).toBe(g2); expect(loads).toEqual(['janus-pro-1b']); expect(status).toEqual(['loading']); expect(deviceGenLoaded()).toBe(true);
    const out = await g1.generate({ prompt: 'a bicycle', n: 2 }, (t) => status.push(t));
    expect(out.length).toBe(2); expect(out[0].width).toBe(8); expect(calls).toEqual(['gen:a bicycle:2']); expect(status).toContain('working');
    releaseDeviceGenerator(); await new Promise((r) => setTimeout(r, 0));
    expect(calls).toContain('release'); expect(deviceGenLoaded()).toBe(false);
  });
  it('a failed load is not kept, so the next attempt loads again', async () => {
    let n = 0;
    deviceGenHooks.loader = async (spec) => { n++; if (n === 1) throw new Error('no network'); return fake(spec, []); };
    await expect(deviceGenerator(GEN_MODELS[0])).rejects.toThrow(/no network/);
    await new Promise((r) => setTimeout(r, 0));
    await expect(deviceGenerator(GEN_MODELS[0])).resolves.toBeTruthy(); expect(n).toBe(2);
  });
  it('turns RawImage bytes into rasters (RGB, RGBA and gray)', () => {
    const rgb = rawImageToRaster({ data: new Uint8Array([1, 2, 3, 4, 5, 6]), width: 2, height: 1, channels: 3 });
    expect(Array.from(rgb.data)).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
    expect(Array.from(rawImageToRaster({ data: new Uint8Array([1, 2, 3, 9]), width: 1, height: 1, channels: 4 }).data)).toEqual([1, 2, 3, 9]);
    expect(Array.from(rawImageToRaster({ data: new Uint8Array([7]), width: 1, height: 1, channels: 1 }).data)).toEqual([7, 7, 7, 255]);
  });
  it('is a picture service of its own kind: the preset, hasImages, and settings that survive loading', () => {
    const p = PRESETS.find((x) => x.id === 'device')!;
    expect([p.api, p.group, p.imageModel, p.textModel]).toEqual(['device', 'computer', 'janus-pro-1b', '']);
    const svc = { id: 'device', name: p.name, api: 'device' as const, baseUrl: 'device://local', key: '', textModel: '', imageModel: 'janus-pro-1b' };
    expect(hasImages(svc)).toBe(true); expect(isDevice(svc)).toBe(true);
    expect(hasImages({ ...svc, imageModel: '' })).toBe(false);
    const prefs = sanitizePrefs({ ...defaultPrefs(), ai: { ...defaultPrefs().ai, services: [svc], imageService: 'device' } } as any);
    expect(prefs.ai.services.map((s) => s.api)).toEqual(['device']); expect(prefs.ai.imageService).toBe('device');
  });
});
