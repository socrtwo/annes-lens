/**
 * Where the on-device runtimes load from. Builds that copy them into the app (the desktop build,
 * QN_ORT_LOCAL=1) write runtimes.json next to index.html, e.g. {"ort": "ort/", "ocr": "ocr/",
 * "zxing": "zxing/", "ocrLangs": ["eng"]}; otherwise each runtime comes from its pinned CDN
 * address. The desktop app's Content Security Policy only allows scripts from the app itself, so
 * the local copies are what make the on-device AI, OCR and barcode reading work there.
 */
export interface RuntimeManifest { ort?: string; ocr?: string; zxing?: string; pdf?: string; jxl?: string; avif?: string; openjph?: string; openjpeg?: string; djvu?: string; transformers?: string; ocrLangs?: string[] }

let manifest: Promise<RuntimeManifest> | null = null;
export function localRuntimes(): Promise<RuntimeManifest> {
  return (manifest ??= (async () => {
    try {
      const r = await fetch('./runtimes.json', { cache: 'no-store' });
      if (!r.ok) return {};
      const t = (await r.text()).trim();
      if (!t.startsWith('{')) return {}; // an SPA fallback page, not the manifest
      const j = JSON.parse(t);
      return j && typeof j === 'object' ? (j as RuntimeManifest) : {};
    } catch { return {}; }
  })());
}
/** Tests reset the cached manifest. */
export const resetRuntimes = (): void => { manifest = null; };
const abs = (u: string) => new URL(u, typeof document !== 'undefined' ? document.baseURI : 'http://localhost/').href;
/** The base URL (with a trailing slash) for a runtime: the local copy when the build has one, else the CDN. */
export async function runtimeBase(key: 'ort' | 'ocr' | 'zxing' | 'pdf' | 'jxl' | 'avif' | 'openjph' | 'openjpeg' | 'djvu' | 'transformers', cdn: string): Promise<string> {
  const m = await localRuntimes();
  const local = m[key];
  return abs(typeof local === 'string' && local ? local.replace(/\/?$/, '/') : cdn);
}
