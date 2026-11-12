/**
 * HTTP for AI services. In the desktop and Android apps the request goes through the native layer
 * (no cross-origin restrictions, so services without CORS headers work); in a browser it is a
 * plain fetch(), which works with services that allow browser calls (OpenAI, OpenRouter, Groq,
 * Gemini, Anthropic with its browser header, Ollama with OLLAMA_ORIGINS set).
 */
import { nativeRequest } from '../platform/native';

export interface AiHttpRequest { url: string; method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string | Uint8Array; timeoutMs?: number; signal?: AbortSignal }
export interface AiHttpResponse { status: number; headers: Record<string, string>; bytes: Uint8Array; text(): string; json(): any }

/** Set by tests to answer requests without a network. */
export let requestOverride: ((r: AiHttpRequest) => Promise<AiHttpResponse>) | null = null;
export function setRequestOverride(fn: typeof requestOverride): void { requestOverride = fn; }

const dec = new TextDecoder();
function wrap(status: number, headers: Record<string, string>, bytes: Uint8Array): AiHttpResponse {
  let text: string | undefined;
  return { status, headers, bytes, text: () => (text ??= dec.decode(bytes)), json: () => { const t = text ??= dec.decode(bytes); try { return JSON.parse(t); } catch { throw new Error(`The service did not answer with JSON: ${t.slice(0, 160)}`); } } };
}

export async function aiRequest(r: AiHttpRequest): Promise<AiHttpResponse> {
  if (requestOverride) return requestOverride(r);
  if (!/^https?:\/\//i.test(r.url)) throw new Error('The service address must start with http:// or https://');
  const native = await nativeRequest({ url: r.url, method: r.method || 'GET', headers: r.headers || {}, body: r.body, timeoutMs: r.timeoutMs, signal: r.signal });
  if (native) return wrap(native.status, native.headers, native.bytes);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), r.timeoutMs ?? 180000);
  r.signal?.addEventListener('abort', () => ctl.abort());
  try {
    const res = await fetch(r.url, { method: r.method || 'GET', headers: r.headers, body: r.body as BodyInit | undefined, signal: ctl.signal, redirect: 'follow' });
    const headers: Record<string, string> = {}; res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    return wrap(res.status, headers, new Uint8Array(await res.arrayBuffer()));
  } catch (e) {
    if (ctl.signal.aborted && r.signal?.aborted) throw new Error('Stopped');
    if (ctl.signal.aborted) throw new Error('The service did not answer in time');
    throw new Error(`Could not reach the service: ${(e as Error).message}. In a browser the service must allow cross-origin calls; the desktop and Android apps do not have that limit.`);
  } finally { clearTimeout(timer); }
}

/** Throws a readable error for a non-2xx answer (the service's own message when it gives one). */
export function ensureOk(res: AiHttpResponse, what: string): void {
  if (res.status >= 200 && res.status < 300) return;
  let msg = '';
  try { const j = res.json(); msg = j?.error?.message || j?.message || j?.error?.type || (typeof j?.error === 'string' ? j.error : ''); } catch { msg = res.text().slice(0, 200); }
  const hint = res.status === 401 || res.status === 403 ? ' Check the key in AI ▸ Providers and Models.' : res.status === 404 ? ' Check the address and the model name.' : res.status === 429 ? ' The service is rate-limited or out of credit.' : '';
  throw new Error(`${what}: the service answered ${res.status}${msg ? ` — ${msg}` : ''}.${hint}`);
}

/** Builds a multipart/form-data body (file parts are Blobs already read into bytes). */
export function multipart(parts: { name: string; value: string | { bytes: Uint8Array; filename: string; mime: string } }[]): { body: Uint8Array; contentType: string } {
  const boundary = '----AnnesLens' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const p of parts) {
    if (typeof p.value === 'string') chunks.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}\r\n`));
    else { chunks.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"; filename="${p.value.filename}"\r\nContent-Type: ${p.value.mime}\r\n\r\n`)); chunks.push(p.value.bytes); chunks.push(enc.encode('\r\n')); }
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0; for (const c of chunks) { body.set(c, o); o += c.length; }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
