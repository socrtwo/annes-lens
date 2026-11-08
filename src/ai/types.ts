/**
 * AI tab: shared types. Two kinds of provider serve the ai.* commands:
 * - hosted services (an HTTP API with a key: OpenAI-compatible chat and images, Anthropic, Google
 *   Gemini; also servers on your own computer such as Ollama and LM Studio through their
 *   OpenAI-compatible endpoints), configured in Set Up AI and stored in the preferences;
 * - on-device models (ONNX Runtime Web in the page, WebGPU when available, WebAssembly otherwise),
 *   downloaded once from the Hugging Face Hub into the browser cache (src/ai/device.ts).
 * Every result is labeled as AI in its metadata when Content Credentials is on (the default).
 */

/** The HTTP dialect a hosted service speaks. */
/** 'device': the on-device picture generator (Transformers.js), no server at all. */
export type ServiceApi = 'openai' | 'anthropic' | 'gemini' | 'device';

export interface AiService {
  id: string;
  name: string;
  api: ServiceApi;
  /** Base URL without a trailing slash: https://api.openai.com/v1, http://localhost:11434/v1, … */
  baseUrl: string;
  key: string;
  /** Text and vision model (chat). */
  textModel: string;
  /** Picture model (generation and edits); empty when the service has none. */
  imageModel: string;
  /** Where the preset came from (shown in Providers and Models). */
  preset?: string;
}

export interface AiPrefs {
  services: AiService[];
  /** Service ids for text-and-vision and for pictures; '' = none chosen. */
  textService: string;
  imageService: string;
  /** For commands with both an on-device model and a service: which to use first. */
  prefer: 'device' | 'service';
  /** Results open as a new picture beside the original (default) or replace it as an undoable step. */
  result: 'new' | 'replace';
  privacy: { maxEdge: number; confirmSend: boolean; allowRemote: boolean };
  /** Content Credentials: IPTC digital source type and provenance fields on AI results. */
  credentials: boolean;
  ensemble: { mode: 'single' | 'master' | 'quaker'; members: string[]; master: string; showDeliberation: boolean };
  /** Where ONNX Runtime Web's files are loaded from ('' = the bundled copy or the CDN). */
  runtimeUrl: string;
  /** On-device model precision: quantized (smaller, faster) or full. */
  modelDtype: 'quantized' | 'fp32';
  prompts: { name: string; prompt: string; negative: string; kind: 'generate' | 'edit' }[];
  historyMax: number;
}

export function defaultAiPrefs(): AiPrefs {
  return {
    services: [], textService: '', imageService: '', prefer: 'device', result: 'new',
    privacy: { maxEdge: 1536, confirmSend: true, allowRemote: true }, credentials: true,
    ensemble: { mode: 'single', members: [], master: '', showDeliberation: false },
    runtimeUrl: '', modelDtype: 'quantized', prompts: [], historyMax: 200,
  };
}

export interface ChatImage { blob: Blob; mime: string }
export interface ChatMessage { role: 'user' | 'assistant'; text: string; images?: ChatImage[] }
export interface ChatRequest { system?: string; messages: ChatMessage[]; json?: boolean; maxTokens?: number; temperature?: number }

export interface ImageRequest {
  prompt: string;
  negative?: string;
  /** Requested output size; services round to what they support. */
  width?: number; height?: number;
  n?: number;
  seed?: number;
  /** Source pictures (edits, variations, references). PNG bytes. */
  images?: Blob[];
  /** Edit mask: PNG with alpha 0 where the picture may change (OpenAI convention). */
  mask?: Blob;
  /** Where the picture may change, as a second black-and-white picture (services without a mask parameter). */
  maskPicture?: Blob;
  transparent?: boolean;
}

export interface AiTextResult { text: string; service: string; model: string; ms: number; deliberation?: string }
export interface AiImageResult { blobs: Blob[]; service: string; model: string; ms: number; text?: string }

export class AiStopped extends Error { constructor() { super('Stopped'); this.name = 'AiStopped'; } }
