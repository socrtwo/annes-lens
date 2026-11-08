import { describe, expect, it } from 'vitest';
import { makeClipTokenizer } from '../../src/ai/clipTokenizer';
import { buildChat, parseChat, buildImage, parseImage, buildListModels, parseListModels, openaiSize, extractJson, PRESETS } from '../../src/ai/hosted';
import { multipart, ensureOk, setRequestOverride, aiRequest } from '../../src/ai/transport';
import { toTensor, fromTensor, resizeFloat, matte, depth, inpaint, upscale, clipImage, clipText, cosine, normalizeVec, MODELS, modelUrl, setModelUrlOverride, type Backend, type Feed } from '../../src/ai/device';
import { runEnsemble } from '../../src/ai/ensemble';
import { addHistory, readHistory, clearHistory } from '../../src/ai/history';
import { sanitizePrefs } from '../../src/prefs';
import { defaultAiPrefs, type AiService } from '../../src/ai/types';
import { refineAlpha, alphaMask, blurByDepth, relight, grayRaster, applyAlpha, compositeOver } from '../../src/commands/aiEdit';
import { seamless, tile2x2 } from '../../src/commands/aiGenerate';
import { featherMask, blendMasked } from '../../src/ai';
import type { Raster } from '../../src/codecs/raster';

const svc = (api: AiService['api'], extra: Partial<AiService> = {}): AiService => ({ id: 's1', name: 'Mock', api, baseUrl: 'https://api.example.test/v1', key: 'k', textModel: 'tm', imageModel: 'im', ...extra });
const raster = (w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]): Raster => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(fill(x, y), (y * w + x) * 4); return { width: w, height: h, data: d as Uint8ClampedArray<ArrayBuffer> }; };
const solid = (w: number, h: number, c: [number, number, number, number]) => raster(w, h, () => c);

describe('CLIP tokenizer', () => {
  const chars: string[] = []; for (let i = 33; i <= 126; i++) chars.push(String.fromCharCode(i));
  const vocab: Record<string, number> = {}; for (const c of chars) vocab[c] = Object.keys(vocab).length; for (const c of chars) vocab[c + '</w>'] = Object.keys(vocab).length;
  vocab['Ġ'] = 900; vocab['<|startoftext|>'] = 49406; vocab['<|endoftext|>'] = 49407; vocab['th'] = 40000; vocab['the</w>'] = 40001;
  const tok = makeClipTokenizer(vocab, '#version: 0.2\nt h\nth e</w>\n');
  it('lower-cases, applies merges, adds start/end and pads to 77 with the end token', () => {
    const { ids, mask } = tok.encode('The cat');
    expect(ids.length).toBe(77); expect(mask.length).toBe(77);
    expect(ids[0]).toBe(49406); expect(ids[1]).toBe(40001);
    expect(ids.slice(2, 5)).toEqual([vocab.c, vocab.a, vocab['t</w>']]);
    expect(ids[5]).toBe(49407); expect(mask.slice(0, 6)).toEqual([1, 1, 1, 1, 1, 1]); expect(mask[6]).toBe(0); expect(ids[76]).toBe(49407);
  });
  it('truncates long text and keeps the end token last', () => { const { ids } = tok.encode('x '.repeat(200)); expect(ids.length).toBe(77); expect(ids[76]).toBe(49407); });
});

describe('hosted adapters', () => {
  const img = { blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), mime: 'image/jpeg' };
  it('builds OpenAI, Anthropic and Gemini chat requests with pictures', async () => {
    const o = await buildChat(svc('openai'), { system: 'sys', messages: [{ role: 'user', text: 'hi', images: [img] }], json: true, maxTokens: 50 });
    expect(o.url).toBe('https://api.example.test/v1/chat/completions'); expect(o.headers!.authorization).toBe('Bearer k');
    const ob = JSON.parse(o.body as string); expect(ob.messages[0]).toEqual({ role: 'system', content: 'sys' }); expect(ob.messages[1].content[0].image_url.url.startsWith('data:image/jpeg;base64,AQID')).toBe(true); expect(ob.response_format.type).toBe('json_object'); expect(ob.max_tokens).toBe(50);
    const a = await buildChat(svc('anthropic'), { system: 'sys', messages: [{ role: 'user', text: 'hi', images: [img] }] });
    expect(a.url).toBe('https://api.example.test/v1/messages'); expect(a.headers!['x-api-key']).toBe('k'); expect(a.headers!['anthropic-dangerous-direct-browser-access']).toBe('true');
    const ab = JSON.parse(a.body as string); expect(ab.system).toBe('sys'); expect(ab.messages[0].content[0].source).toEqual({ type: 'base64', media_type: 'image/jpeg', data: 'AQID' });
    const g = await buildChat(svc('gemini'), { system: 'sys', messages: [{ role: 'user', text: 'hi', images: [img] }, { role: 'assistant', text: 'yo' }], json: true });
    expect(g.url).toBe('https://api.example.test/v1/models/tm:generateContent'); expect(g.headers!['x-goog-api-key']).toBe('k');
    const gb = JSON.parse(g.body as string); expect(gb.contents[0].parts[0].inline_data.mime_type).toBe('image/jpeg'); expect(gb.contents[1].role).toBe('model'); expect(gb.generationConfig.responseMimeType).toBe('application/json'); expect(gb.systemInstruction.parts[0].text).toBe('sys');
  });
  it('parses the three answer shapes', () => {
    expect(parseChat('openai', { choices: [{ message: { content: ' hello ' } }] })).toBe('hello');
    expect(parseChat('openai', { choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] })).toBe('ab');
    expect(parseChat('anthropic', { content: [{ type: 'text', text: 'x' }, { type: 'tool_use' }, { type: 'text', text: 'y' }] })).toBe('x\ny');
    expect(parseChat('gemini', { candidates: [{ content: { parts: [{ text: 'g' }, { text: '!' }] } }] })).toBe('g!');
    expect(() => parseChat('gemini', { promptFeedback: { blockReason: 'SAFETY' } })).toThrow(/SAFETY/);
  });
  it('lists models', () => {
    expect(buildListModels(svc('gemini')).url).toContain('/models?');
    expect(parseListModels('gemini', { models: [{ name: 'models/gemini-x' }] })).toEqual(['gemini-x']);
    expect(parseListModels('openai', { data: [{ id: 'b' }, { id: 'a' }] })).toEqual(['a', 'b']);
  });
  it('picks the nearest OpenAI size per model family', () => {
    expect(openaiSize('gpt-image-1', 1600, 900)).toBe('1536x1024'); expect(openaiSize('gpt-image-1', 500, 900)).toBe('1024x1536'); expect(openaiSize('dall-e-3', 1600, 900)).toBe('1792x1024'); expect(openaiSize('dall-e-2', 100, 100)).toBe('256x256');
  });
  it('builds generation and masked edit requests', async () => {
    const g = await buildImage(svc('openai', { imageModel: 'dall-e-3' }), { prompt: 'p', negative: 'n', width: 1024, height: 1024, n: 2 });
    const gb = JSON.parse(g.body as string); expect(g.url).toContain('/images/generations'); expect(gb.response_format).toBe('b64_json'); expect(gb.prompt).toBe('p\nAvoid: n'); expect(gb.n).toBe(2);
    const g2 = await buildImage(svc('openai'), { prompt: 'p', transparent: true, seed: 5 });
    const g2b = JSON.parse(g2.body as string); expect(g2b.response_format).toBeUndefined(); expect(g2b.background).toBe('transparent'); expect(g2b.seed).toBe(5);
    const e = await buildImage(svc('openai'), { prompt: 'p', images: [new Blob([new Uint8Array([9])])], mask: new Blob([new Uint8Array([8])]) });
    expect(e.url).toContain('/images/edits'); expect(e.headers!['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    const body = new TextDecoder().decode(e.body as Uint8Array); expect(body).toContain('name="image[]"; filename="image0.png"'); expect(body).toContain('name="mask"; filename="mask.png"'); expect(body).toContain('name="prompt"\r\n\r\np\r\n');
    const gm = await buildImage(svc('gemini'), { prompt: 'p', images: [new Blob([new Uint8Array([9])])], maskPicture: new Blob([new Uint8Array([8])]), width: 1600, height: 900 });
    const gmb = JSON.parse(gm.body as string); expect(gmb.generationConfig.responseModalities).toEqual(['IMAGE', 'TEXT']); expect(gmb.generationConfig.imageConfig.aspectRatio).toBe('16:9'); expect(gmb.contents[0].parts.length).toBe(3); expect(gmb.contents[0].parts[2].text).toMatch(/white in the last/);
  });
  it('parses picture answers', async () => {
    const res = (j: any) => ({ status: 200, headers: {}, bytes: new Uint8Array(), text: () => JSON.stringify(j), json: () => j });
    const o = await parseImage('openai', res({ data: [{ b64_json: 'AQID', revised_prompt: 'rp' }] })); expect(o.blobs.length).toBe(1); expect(o.text).toBe('rp'); expect(new Uint8Array(await o.blobs[0].arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    const g = await parseImage('gemini', res({ candidates: [{ content: { parts: [{ text: 'note' }, { inlineData: { mimeType: 'image/png', data: 'AQID' } }] } }] })); expect(g.blobs[0].type).toBe('image/png'); expect(g.text).toBe('note');
    await expect(parseImage('gemini', res({ candidates: [{ content: { parts: [{ text: 'only text' }] } }] }))).rejects.toThrow(/text only/);
  });
  it('extracts JSON from prose and fences', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 }); expect(extractJson('Sure: {"keywords": ["x"]} done')).toEqual({ keywords: ['x'] }); expect(extractJson('[1,2]')).toEqual([1, 2]); expect(() => extractJson('nothing')).toThrow();
  });
  it('has presets with addresses and key links', () => { expect(PRESETS.length).toBeGreaterThan(5); for (const p of PRESETS) { expect(p.baseUrl).toMatch(p.api === 'device' ? /^device:/ : /^https?:\/\//); if (p.group !== 'computer') expect(p.keyUrl).toMatch(/^https:/); } });
});

describe('transport', () => {
  it('builds multipart bodies', () => { const m = multipart([{ name: 'a', value: 'x' }, { name: 'f', value: { bytes: new Uint8Array([1]), filename: 'f.png', mime: 'image/png' } }]); const t = new TextDecoder().decode(m.body); expect(t.startsWith('--')).toBe(true); expect(t).toContain('Content-Type: image/png'); expect(t.trim().endsWith('--')).toBe(true); });
  it('explains failures with the service message and a hint', () => {
    const res = (status: number, j: any) => ({ status, headers: {}, bytes: new Uint8Array(), text: () => JSON.stringify(j), json: () => j });
    expect(() => ensureOk(res(401, { error: { message: 'bad key' } }), 'Mock')).toThrow(/401 — bad key.*Check the key/); expect(() => ensureOk(res(200, {}), 'Mock')).not.toThrow(); expect(() => ensureOk(res(429, {}), 'Mock')).toThrow(/rate-limited/);
  });
  it('routes through an override in tests', async () => { setRequestOverride(async (r) => ({ status: 200, headers: {}, bytes: new Uint8Array(), text: () => r.url, json: () => ({ u: r.url }) })); const r = await aiRequest({ url: 'https://x.test/y' }); expect(r.json()).toEqual({ u: 'https://x.test/y' }); setRequestOverride(null); });
});

/** A backend that computes what the fixture models compute, from the feeds alone. */
const fake: Backend = {
  async infer(key, _bytes, feeds: Feed[]) {
    const f = feeds[0], d = f.data as Float32Array, [, c, h, w] = f.dims;
    if (key === 'matte') { const out = new Float32Array(h * w); for (let i = 0; i < h * w; i++) out[i] = Math.min(1, Math.max(0, ((d[i] + d[h * w + i] + d[2 * h * w + i]) / 3 + 1) / 2)); return [{ name: 'output', data: out, dims: [1, 1, h, w] }]; }
    if (key === 'depth') { const out = new Float32Array(h * w); for (let i = 0; i < h * w; i++) out[i] = (d[i] + d[h * w + i] + d[2 * h * w + i]) / 3; return [{ name: 'predicted_depth', data: out, dims: [1, h, w] }]; }
    if (key === 'inpaint') { const m = feeds[1].data as Float32Array, out = new Float32Array(3 * h * w); for (let ch = 0; ch < 3; ch++) for (let i = 0; i < h * w; i++) out[ch * h * w + i] = (d[ch * h * w + i] * (1 - m[i]) + 0.5 * m[i]) * 255; return [{ name: 'output', data: out, dims: [1, 3, h, w] }]; }
    if (key.startsWith('upscale')) { const s = +key.slice(7), out = new Float32Array(3 * h * s * w * s); for (let ch = 0; ch < 3; ch++) for (let y = 0; y < h * s; y++) for (let x = 0; x < w * s; x++) out[ch * h * s * w * s + y * w * s + x] = d[ch * h * w + Math.floor(y / s) * w + Math.floor(x / s)]; return [{ name: 'reconstruction', data: out, dims: [1, 3, h * s, w * s] }]; }
    if (key === 'clip-vision') { const out = new Float32Array(3); for (let ch = 0; ch < 3; ch++) { let s = 0; for (let i = 0; i < h * w; i++) s += d[ch * h * w + i]; out[ch] = s / (h * w); } return [{ name: 'last_hidden_state', data: out.map((v) => v * 2), dims: [1, 3] }, { name: 'image_embeds', data: out, dims: [1, 3] }]; }
    if (key === 'clip-text') { const ids = feeds[0].data as BigInt64Array; return [{ name: 'text_embeds', data: Float32Array.from([Number(ids[0]), Number(ids[1]), Number(ids[2])]), dims: [1, 3] }]; }
    throw new Error('unknown ' + key); void c;
  },
};
const bytes = async () => new ArrayBuffer(0);

describe('on-device jobs', () => {
  it('packs and unpacks tensors', () => {
    const r = raster(2, 1, (x) => (x ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    const t = toTensor(r, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]); expect([...t]).toEqual([-1, 1, -1, -1, 1, -1]);
    const back = fromTensor(toTensor(r, [0, 0, 0], [1, 1, 1]), 2, 1); expect([...back.data]).toEqual([...r.data]);
    expect([...resizeFloat(Float32Array.from([0, 1]), 2, 1, 4, 1)].map((v) => +v.toFixed(2))).toEqual([0, 0.25, 0.75, 1]);
  });
  it('mattes a white subject on black', async () => {
    const r = raster(100, 80, (x, y) => (x >= 30 && x < 70 && y >= 20 && y < 60 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const a = await matte(fake, bytes, r); expect(a.length).toBe(8000); expect(a[40 * 100 + 50]).toBeGreaterThan(0.95); expect(a[5 * 100 + 5]).toBeLessThan(0.05);
    const m = alphaMask(refineAlpha(a, 100, 80, 2, 1)); expect(m[40 * 100 + 50]).toBe(255); expect(m[0]).toBe(0);
    const cut = applyAlpha(r, a); expect(cut.data[(40 * 100 + 50) * 4 + 3]).toBeGreaterThan(240); expect(cut.data[3]).toBeLessThan(15);
    const over = compositeOver(r, a, solid(100, 80, [0, 0, 255, 255])); expect(over.data[2]).toBe(255); expect(over.data[(40 * 100 + 50) * 4]).toBe(255);
  });
  it('estimates depth normalized 0..1 and resized to the picture', async () => {
    const r = raster(60, 40, (x) => [Math.round(x * 4), Math.round(x * 4), Math.round(x * 4), 255]);
    const d = await depth(fake, bytes, r); expect(d.length).toBe(2400); expect(d[0]).toBeLessThan(0.1); expect(d[59]).toBeGreaterThan(0.9); expect(d[30]).toBeGreaterThan(0.3); expect(d[30]).toBeLessThan(0.7);
    const g = grayRaster(d, 60, 40); expect(g.data[59 * 4]).toBeGreaterThan(230);
    const b = blurByDepth(r, d, 10, 1); expect(b.width).toBe(60);
    const l = relight(r, d, 0, 45, 0.5); expect(l.width).toBe(60); expect(l.data[3]).toBe(255);
  });
  it('fills the mask region by inpainting one tile', async () => {
    const r = solid(300, 200, [200, 40, 40, 255]);
    const mask = new Uint8Array(300 * 200); for (let y = 80; y < 120; y++) for (let x = 100; x < 160; x++) mask[y * 300 + x] = 255;
    const out = await inpaint(fake, bytes, r, mask, { x: 100, y: 80, w: 60, h: 40 });
    const inside = (100 * 300 + 130) * 4, outside = (10 * 300 + 10) * 4;
    expect(Math.abs(out.data[inside] - 128)).toBeLessThan(6); expect(Math.abs(out.data[inside + 2] - 128)).toBeLessThan(6);
    expect(out.data[outside]).toBe(200); expect(out.data[outside + 1]).toBe(40);
  });
  it('upscales in tiles and crops back to scale × original', async () => {
    const r = raster(300, 170, (x, y) => [x % 256, y % 256, (x + y) % 256, 255]);
    const tiles: number[] = [];
    const out = await upscale(fake, bytes, r, 2, (d, t) => tiles.push(t));
    expect([out.width, out.height]).toEqual([600, 340]); expect(tiles[0]).toBe(2);
    for (const [x, y] of [[0, 0], [299, 169], [150, 85], [287, 10], [10, 160]]) { const o = ((y * 2 + 1) * 600 + x * 2 + 1) * 4, s = (y * 300 + x) * 4; expect([out.data[o], out.data[o + 1], out.data[o + 2]]).toEqual([r.data[s], r.data[s + 1], r.data[s + 2]]); }
    const small = await upscale(fake, bytes, solid(20, 10, [1, 2, 3, 255]), 4); expect([small.width, small.height]).toEqual([80, 40]); expect(small.data[0]).toBe(1);
  });
  it('embeds pictures and text and compares them', async () => {
    const red = await clipImage(fake, bytes, solid(50, 50, [255, 0, 0, 255])), red2 = await clipImage(fake, bytes, solid(300, 120, [250, 5, 5, 255])), blue = await clipImage(fake, bytes, solid(50, 50, [0, 0, 255, 255]));
    expect(red.length).toBe(3); expect(cosine(red, red2)).toBeGreaterThan(cosine(red, blue));
    const tok = { encode: (t: string) => ({ ids: [t.length, 1, 2, ...new Array(74).fill(0)], mask: new Array(77).fill(1) }) };
    const e = await clipText(fake, bytes, tok, 'abcd'); expect([...e].map((v) => +v.toFixed(3))).toEqual([...normalizeVec(Float32Array.from([4, 1, 2]))].map((v) => +v.toFixed(3)));
  });
  it('has a registry with Hub addresses and permissive licenses', () => {
    expect(MODELS.map((m) => m.id)).toContain('modnet');
    for (const m of MODELS) { expect(['Apache-2.0', 'MIT']).toContain(m.license); expect(modelUrl(m, m.files.quantized[0])).toBe(`https://huggingface.co/${m.repo}/resolve/main/${m.files.quantized[0]}`); }
    setModelUrlOverride((s, p) => `/x/${s.id}/${p}`); expect(modelUrl(MODELS[0], 'a.onnx')).toBe('/x/modnet/a.onnx'); setModelUrlOverride(null);
  });
});

describe('masks, seams and blending', () => {
  it('feathers and blends inside a mask', () => {
    const w = 10, h = 10, mask = new Uint8Array(100); for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) mask[y * w + x] = 255;
    const f = featherMask(mask, w, h, 1); expect(f[55]).toBe(1); expect(f[0]).toBe(0); expect(f[2 * w + 1]).toBeGreaterThan(0); expect(f[2 * w + 1]).toBeLessThan(1);
    const out = blendMasked(solid(10, 10, [0, 0, 0, 255]), solid(5, 5, [255, 255, 255, 255]), mask, 0); expect(out.data[(5 * w + 5) * 4]).toBe(255); expect(out.data[0]).toBe(0);
  });
  it('makes a picture tileable and tiles it', () => {
    const r = raster(40, 40, (x, y) => [x * 6, y * 6, 0, 255]);
    const s = seamless(r); expect(s.width).toBe(40);
    const left = s.data[(20 * 40 + 0) * 4], right = s.data[(20 * 40 + 39) * 4]; expect(Math.abs(left - right)).toBeLessThan(Math.abs(r.data[(20 * 40) * 4] - r.data[(20 * 40 + 39) * 4]));
    const t = tile2x2(s); expect([t.width, t.height]).toEqual([80, 80]); expect(t.data[(50 * 80 + 50) * 4]).toBe(s.data[(10 * 40 + 10) * 4]);
  });
});

describe('ensemble', () => {
  const s = (id: string, answer: (prompt: string) => string): AiService & { answer: typeof answer } => ({ ...svc('openai', { id, name: id, textModel: 'm-' + id }), answer });
  const ask = async (sv: AiService, r: { messages: { text: string }[] }) => (sv as any).answer(r.messages[r.messages.length - 1].text);
  it('single: the first member answers', async () => { const r = await runEnsemble('single', [s('a', () => 'A')], s('a', () => 'A'), { messages: [{ role: 'user', text: 'q' }] }, ask); expect(r.text).toBe('A'); expect(r.deliberation).toBe(''); });
  it('master: members answer, the master combines', async () => {
    const seen: string[] = [];
    const r = await runEnsemble('master', [s('a', () => 'A'), s('b', () => 'B')], s('m', (p) => { seen.push(p); return 'AB'; }), { messages: [{ role: 'user', text: 'q' }] }, ask);
    expect(r.text).toBe('AB'); expect(seen[0]).toMatch(/--- a ---\nA[\s\S]*--- b ---\nB/); expect(r.deliberation).toMatch(/## a .*round 1\nA/); expect(r.service).toMatch(/master of 2/);
  });
  it('quaker: revises until the members agree', async () => {
    let round = 0;
    const a = s('a', () => 'yes'), b = s('b', (p) => (/revised answer/.test(p) && ++round >= 1 ? 'yes' : 'no'));
    const r = await runEnsemble('quaker', [a, b], a, { messages: [{ role: 'user', text: 'q' }] }, ask);
    expect(r.text).toBe('yes'); expect(r.deliberation).toMatch(/Consensus reached/); expect(r.deliberation).toMatch(/round 2/);
  });
});

describe('history and preferences', () => {
  it('keeps the newest entries first, capped', () => { clearHistory(); addHistory({ command: 'c1', service: 's', model: 'm', result: 'r', ms: 1 }, 2); addHistory({ command: 'c2', service: 's', model: 'm', result: 'r', ms: 1 }, 2); addHistory({ command: 'c3', service: 's', model: 'm', result: 'r', ms: 1 }, 2); const h = readHistory(); expect(h.map((e) => e.command)).toEqual(['c3', 'c2']); clearHistory(); expect(readHistory()).toEqual([]); });
  it('sanitizes ai preferences', () => {
    const p = sanitizePrefs({ ai: { services: [{ id: 'a', api: 'openai', baseUrl: 'http://x', key: 'k', textModel: 't' }, { id: 'bad', api: 'nope' }], textService: 'a', prefer: 'bogus', privacy: { maxEdge: 50, confirmSend: false }, ensemble: { mode: 'quaker', members: ['a', 3], master: 'a' }, prompts: [{ name: 'n', prompt: 'p' }, { bad: 1 }], historyMax: 99999 } }) as any;
    expect(p.ai.services.length).toBe(1); expect(p.ai.services[0].imageModel).toBe(''); expect(p.ai.prefer).toBe('device'); expect(p.ai.privacy).toEqual({ maxEdge: 256, confirmSend: false, allowRemote: true }); expect(p.ai.ensemble.members).toEqual(['a']); expect(p.ai.prompts).toEqual([{ name: 'n', prompt: 'p', negative: '', kind: 'generate' }]); expect(p.ai.historyMax).toBe(2000);
    expect((sanitizePrefs({ ai: {} }) as any).ai).toEqual(defaultAiPrefs());
  });
});
