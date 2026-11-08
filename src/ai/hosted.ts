/**
 * Hosted AI services: request building and answer parsing for the three API dialects the app
 * speaks. Pure functions (buildChat / parseChat …) are unit-tested; chat() / generateImage() send
 * them through src/ai/transport.ts.
 *
 * - 'openai': /chat/completions and /images/{generations,edits} as OpenAI documents them; also
 *   OpenRouter, Groq, Mistral, Together, LM Studio, Ollama (/v1) and any compatible server.
 * - 'anthropic': /messages (vision in; text out).
 * - 'gemini': /models/{model}:generateContent (vision in; text or pictures out).
 */
import type { AiService, ChatRequest, ImageRequest, ServiceApi } from './types';
import { keysReady } from './keystore';
import { aiRequest, ensureOk, multipart, type AiHttpRequest, type AiHttpResponse } from './transport';
import { b64FromBuffer, bufferFromB64 } from '../platform/native';

export interface Preset { id: string; name: string; api: ServiceApi; baseUrl: string; group: 'computer' | 'free' | 'trial' | 'paid'; keyUrl?: string; priceUrl?: string; textModel: string; imageModel: string; note?: string }

/** Known services. Terms, free tiers and prices change: the wizard links to each service's pages instead of stating them. */
export const PRESETS: Preset[] = [
  { id: 'device', name: 'This device (Janus-Pro-1B, pictures only)', api: 'device', baseUrl: 'device://local', group: 'computer', textModel: '', imageModel: 'janus-pro-1b', note: 'Generate Picture runs entirely on this device through Transformers.js: a 2 GB model downloaded once, WebGPU recommended (the desktop app, Chrome or Edge); nothing leaves the device. Pictures are 384 × 384; edits, masks, sizes and seeds need a picture service. The model\'s weights are under the DeepSeek Model License, shown before the download.' },
  { id: 'ollama', name: 'Ollama (your computer)', api: 'openai', baseUrl: 'http://localhost:11434/v1', group: 'computer', textModel: 'llava', imageModel: '', note: 'Install from ollama.com, then "ollama pull llava" (or another vision model). In a browser, start it with OLLAMA_ORIGINS set.' },
  { id: 'lmstudio', name: 'LM Studio (your computer)', api: 'openai', baseUrl: 'http://localhost:1234/v1', group: 'computer', textModel: '', imageModel: '', note: 'Start the local server in LM Studio and load a vision model.' },
  { id: 'custom', name: 'Any OpenAI-compatible server', api: 'openai', baseUrl: 'http://localhost:8000/v1', group: 'computer', textModel: '', imageModel: '', note: 'ComfyUI, SD.Next, LocalAI and others through their OpenAI-compatible endpoints.' },
  { id: 'openrouter', name: 'OpenRouter', api: 'openai', baseUrl: 'https://openrouter.ai/api/v1', group: 'free', keyUrl: 'https://openrouter.ai/keys', priceUrl: 'https://openrouter.ai/models', textModel: 'google/gemini-2.0-flash-exp:free', imageModel: '', note: 'Many models, some free; vision models are marked on the model page.' },
  { id: 'gemini', name: 'Google Gemini', api: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', group: 'free', keyUrl: 'https://aistudio.google.com/apikey', priceUrl: 'https://ai.google.dev/pricing', textModel: 'gemini-2.5-flash', imageModel: 'gemini-2.5-flash-image', note: 'Text, vision and pictures (generation and conversational edits).' },
  { id: 'groq', name: 'Groq', api: 'openai', baseUrl: 'https://api.groq.com/openai/v1', group: 'free', keyUrl: 'https://console.groq.com/keys', priceUrl: 'https://groq.com/pricing', textModel: 'meta-llama/llama-4-scout-17b-16e-instruct', imageModel: '' },
  { id: 'mistral', name: 'Mistral', api: 'openai', baseUrl: 'https://api.mistral.ai/v1', group: 'trial', keyUrl: 'https://console.mistral.ai/api-keys', priceUrl: 'https://mistral.ai/pricing', textModel: 'pixtral-12b-latest', imageModel: '' },
  { id: 'openai', name: 'OpenAI', api: 'openai', baseUrl: 'https://api.openai.com/v1', group: 'paid', keyUrl: 'https://platform.openai.com/api-keys', priceUrl: 'https://openai.com/api/pricing', textModel: 'gpt-4.1-mini', imageModel: 'gpt-image-1', note: 'Text, vision and pictures (generation and edits with a mask).' },
  { id: 'anthropic', name: 'Anthropic', api: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', group: 'paid', keyUrl: 'https://console.anthropic.com/settings/keys', priceUrl: 'https://www.anthropic.com/pricing', textModel: 'claude-sonnet-5-5', imageModel: '', note: 'Text and vision.' },
  { id: 'together', name: 'Together', api: 'openai', baseUrl: 'https://api.together.xyz/v1', group: 'paid', keyUrl: 'https://api.together.xyz/settings/api-keys', priceUrl: 'https://www.together.ai/pricing', textModel: 'meta-llama/Llama-4-Scout-17B-16E-Instruct', imageModel: 'black-forest-labs/FLUX.1-schnell', note: 'Text, vision and pictures through its OpenAI-compatible images endpoint.' },
];

const base = (s: AiService) => s.baseUrl.replace(/\/+$/, '');
const blobBytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
const dataUrl = async (b: Blob, mime: string) => `data:${mime};base64,${b64FromBuffer(await b.arrayBuffer())}`;

// Chat -------------------------------------------------------------------------------------------

export async function buildChat(s: AiService, r: ChatRequest): Promise<AiHttpRequest> {
  const model = s.textModel;
  const maxTokens = r.maxTokens ?? 1024;
  if (s.api === 'anthropic') {
    const messages = [];
    for (const m of r.messages) {
      const content: any[] = [];
      for (const im of m.images || []) content.push({ type: 'image', source: { type: 'base64', media_type: im.mime, data: b64FromBuffer(await im.blob.arrayBuffer()) } });
      content.push({ type: 'text', text: m.text || ' ' });
      messages.push({ role: m.role, content });
    }
    const body: any = { model, max_tokens: maxTokens, messages };
    if (r.system) body.system = r.system + (r.json ? '\nAnswer with JSON only, no prose.' : '');
    if (r.temperature !== undefined) body.temperature = r.temperature;
    return { url: `${base(s)}/messages`, method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': s.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, body: JSON.stringify(body) };
  }
  if (s.api === 'gemini') {
    const contents = [];
    for (const m of r.messages) {
      const parts: any[] = [];
      for (const im of m.images || []) parts.push({ inline_data: { mime_type: im.mime, data: b64FromBuffer(await im.blob.arrayBuffer()) } });
      parts.push({ text: m.text || ' ' });
      contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
    }
    const body: any = { contents, generationConfig: { maxOutputTokens: maxTokens } };
    if (r.system) body.systemInstruction = { parts: [{ text: r.system }] };
    if (r.json) body.generationConfig.responseMimeType = 'application/json';
    if (r.temperature !== undefined) body.generationConfig.temperature = r.temperature;
    return { url: `${base(s)}/models/${encodeURIComponent(model)}:generateContent`, method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': s.key }, body: JSON.stringify(body) };
  }
  const messages: any[] = [];
  if (r.system) messages.push({ role: 'system', content: r.system });
  for (const m of r.messages) {
    if (!m.images?.length) { messages.push({ role: m.role, content: m.text }); continue; }
    const content: any[] = [];
    for (const im of m.images) content.push({ type: 'image_url', image_url: { url: await dataUrl(im.blob, im.mime) } });
    content.push({ type: 'text', text: m.text || ' ' });
    messages.push({ role: m.role, content });
  }
  const body: any = { model, messages, max_tokens: maxTokens };
  if (r.json) body.response_format = { type: 'json_object' };
  if (r.temperature !== undefined) body.temperature = r.temperature;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (s.key) headers.authorization = `Bearer ${s.key}`;
  if (/openrouter\.ai/.test(s.baseUrl)) { headers['http-referer'] = 'https://socrtwo.github.io/annes-lens/'; headers['x-title'] = "Anne's Lens"; }
  return { url: `${base(s)}/chat/completions`, method: 'POST', headers, body: JSON.stringify(body) };
}

export function parseChat(api: ServiceApi, j: any): string {
  if (api === 'anthropic') return (j?.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n').trim();
  if (api === 'gemini') {
    const cand = j?.candidates?.[0];
    if (!cand && j?.promptFeedback?.blockReason) throw new Error(`The service refused the request (${j.promptFeedback.blockReason})`);
    return (cand?.content?.parts || []).map((p: any) => p.text || '').join('').trim();
  }
  const m = j?.choices?.[0]?.message;
  const c = m?.content;
  if (Array.isArray(c)) return c.map((p: any) => p?.text || '').join('').trim();
  return String(c ?? '').trim();
}

export async function chat(s: AiService, r: ChatRequest, signal?: AbortSignal): Promise<string> {
  await keysReady();
  if (!s.textModel) throw new Error(`${s.name} has no text model set (AI ▸ Providers and Models).`);
  const req = await buildChat(s, r);
  const res = await aiRequest({ ...req, signal, timeoutMs: 300000 });
  ensureOk(res, s.name);
  const text = parseChat(s.api, res.json());
  if (!text) throw new Error(`${s.name} answered without text.`);
  return text;
}

/** Pulls a JSON object out of an answer that may wrap it in prose or a code fence. */
export function extractJson(text: string): any {
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* */ }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* */ } }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* */ } }
  const c = t.indexOf('['), d = t.lastIndexOf(']');
  if (c >= 0 && d > c) { try { return JSON.parse(t.slice(c, d + 1)); } catch { /* */ } }
  throw new Error(`The answer was not JSON: ${t.slice(0, 120)}`);
}

// Models -----------------------------------------------------------------------------------------

export function buildListModels(s: AiService): AiHttpRequest {
  if (s.api === 'gemini') return { url: `${base(s)}/models?pageSize=200`, headers: { 'x-goog-api-key': s.key } };
  if (s.api === 'anthropic') return { url: `${base(s)}/models?limit=100`, headers: { 'x-api-key': s.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' } };
  return { url: `${base(s)}/models`, headers: s.key ? { authorization: `Bearer ${s.key}` } : {} };
}
export function parseListModels(api: ServiceApi, j: any): string[] {
  if (api === 'gemini') return (j?.models || []).map((m: any) => String(m.name || '').replace(/^models\//, '')).filter(Boolean);
  return (j?.data || []).map((m: any) => String(m.id || '')).filter(Boolean).sort();
}
export async function listModels(s: AiService): Promise<string[]> {
  await keysReady();
  const res = await aiRequest({ ...buildListModels(s), timeoutMs: 30000 });
  ensureOk(res, s.name);
  return parseListModels(s.api, res.json());
}

/** A tiny request that proves the key and the model work (never a picture generation). */
export async function testService(s: AiService): Promise<string> {
  const t0 = performance.now();
  const text = await chat(s, { messages: [{ role: 'user', text: 'Reply with the single word OK.' }], maxTokens: 16, temperature: 0 });
  return `${s.name} answered "${text.slice(0, 40)}" in ${Math.round(performance.now() - t0)} ms.`;
}

// Pictures ---------------------------------------------------------------------------------------

/** OpenAI image sizes: the nearest the model family supports. */
export function openaiSize(model: string, w = 1024, h = 1024): string {
  const sizes = /dall-e-2/i.test(model) ? ['256x256', '512x512', '1024x1024'] : /dall-e-3/i.test(model) ? ['1024x1024', '1792x1024', '1024x1792'] : ['1024x1024', '1536x1024', '1024x1536'];
  const ratio = w / h;
  let best = sizes[0], bestD = Infinity;
  for (const sz of sizes) { const [a, b] = sz.split('x').map(Number); const d = Math.abs(Math.log(a / b) - Math.log(ratio)); if (d < bestD) { bestD = d; best = sz; } }
  return best;
}

export const hasImages = (s: AiService | undefined | null): boolean => !!s && !!s.imageModel && (s.api === 'openai' || s.api === 'gemini' || s.api === 'device');
export const isDevice = (s: AiService | undefined | null): boolean => !!s && s.api === 'device';
export const canMask = (s: AiService): boolean => s.api === 'openai';

export async function buildImage(s: AiService, r: ImageRequest): Promise<AiHttpRequest> {
  const model = s.imageModel;
  const n = Math.max(1, Math.min(4, r.n ?? 1));
  if (s.api === 'gemini') {
    const parts: any[] = [];
    for (const im of r.images || []) parts.push({ inline_data: { mime_type: 'image/png', data: b64FromBuffer(await im.arrayBuffer()) } });
    if (r.maskPicture) parts.push({ inline_data: { mime_type: 'image/png', data: b64FromBuffer(await r.maskPicture.arrayBuffer()) } });
    let text = r.prompt;
    if (r.maskPicture) text = `${text}\n\nChange only the area that is white in the last (black-and-white) picture; keep everything else exactly as it is.`;
    if (r.negative) text += `\n\nAvoid: ${r.negative}`;
    parts.push({ text });
    const body: any = { contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'], candidateCount: 1 } };
    if (r.width && r.height) { const ratio = r.width / r.height; const ar = ratio > 1.6 ? '16:9' : ratio > 1.2 ? '4:3' : ratio > 0.85 ? '1:1' : ratio > 0.65 ? '3:4' : '9:16'; body.generationConfig.imageConfig = { aspectRatio: ar }; }
    return { url: `${base(s)}/models/${encodeURIComponent(model)}:generateContent`, method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': s.key }, body: JSON.stringify(body) };
  }
  const headers: Record<string, string> = {};
  if (s.key) headers.authorization = `Bearer ${s.key}`;
  const size = openaiSize(model, r.width, r.height);
  const dalle = /dall-e/i.test(model);
  if (r.images?.length) {
    const parts: Parameters<typeof multipart>[0] = [{ name: 'model', value: model }, { name: 'prompt', value: r.prompt + (r.negative ? `\nAvoid: ${r.negative}` : '') }, { name: 'n', value: String(n) }, { name: 'size', value: size }];
    if (dalle) parts.push({ name: 'response_format', value: 'b64_json' });
    const many = !dalle;
    for (let i = 0; i < r.images.length; i++) parts.push({ name: many ? 'image[]' : 'image', value: { bytes: await blobBytes(r.images[i]), filename: `image${i}.png`, mime: 'image/png' } });
    if (r.mask) parts.push({ name: 'mask', value: { bytes: await blobBytes(r.mask), filename: 'mask.png', mime: 'image/png' } });
    if (r.transparent && !dalle) parts.push({ name: 'background', value: 'transparent' });
    const m = multipart(parts);
    return { url: `${base(s)}/images/edits`, method: 'POST', headers: { ...headers, 'content-type': m.contentType }, body: m.body };
  }
  const body: any = { model, prompt: r.prompt + (r.negative ? `\nAvoid: ${r.negative}` : ''), n, size };
  if (dalle) body.response_format = 'b64_json';
  if (r.transparent && !dalle) body.background = 'transparent';
  if (r.seed !== undefined && !/openai\.com/.test(s.baseUrl)) body.seed = r.seed;
  return { url: `${base(s)}/images/generations`, method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

export async function parseImage(api: ServiceApi, res: AiHttpResponse): Promise<{ blobs: Blob[]; text?: string }> {
  const j = res.json();
  if (api === 'gemini') {
    const parts = j?.candidates?.[0]?.content?.parts || [];
    const blobs = parts.filter((p: any) => p.inlineData || p.inline_data).map((p: any) => { const d = p.inlineData || p.inline_data; return new Blob([bufferFromB64(d.data)], { type: d.mimeType || d.mime_type || 'image/png' }); });
    const text = parts.filter((p: any) => p.text).map((p: any) => p.text).join('\n').trim();
    if (!blobs.length) throw new Error(text ? `The service answered with text only: ${text.slice(0, 200)}` : `The service returned no picture${j?.promptFeedback?.blockReason ? ` (${j.promptFeedback.blockReason})` : ''}.`);
    return { blobs, text: text || undefined };
  }
  const data = j?.data || [];
  const blobs: Blob[] = [];
  for (const d of data) {
    if (d.b64_json) blobs.push(new Blob([bufferFromB64(d.b64_json)], { type: 'image/png' }));
    else if (d.url) { const r = await aiRequest({ url: d.url, timeoutMs: 120000 }); ensureOk(r, 'Picture download'); blobs.push(new Blob([r.bytes as BlobPart], { type: r.headers['content-type'] || 'image/png' })); }
  }
  if (!blobs.length) throw new Error('The service returned no picture.');
  return { blobs, text: data[0]?.revised_prompt };
}

export async function generateImage(s: AiService, r: ImageRequest, signal?: AbortSignal): Promise<{ blobs: Blob[]; text?: string }> {
  if (s.api === 'device') throw new Error('On-device generation runs through makePictures, not a service request');
  await keysReady();
  if (!hasImages(s)) throw new Error(`${s.name} has no picture model set (AI ▸ Providers and Models).`);
  const req = await buildImage(s, r);
  const res = await aiRequest({ ...req, signal, timeoutMs: 600000 });
  ensureOk(res, s.name);
  return parseImage(s.api, res);
}
