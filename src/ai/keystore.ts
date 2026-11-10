/**
 * Where AI service keys live: the platform's secure storage rather than the settings. The desktop app keeps them
 * encrypted with Electron's safeStorage (the OS credential store: Keychain, DPAPI, the Linux keyring; a plain-text
 * backend on a Linux desktop without a keyring is reported as such); the Android app in EncryptedSharedPreferences
 * backed by the Android Keystore; the web app (and the iOS app, which runs the web code) encrypts them with a
 * passphrase the user chooses (PBKDF2 with 600 000 rounds of SHA-256, then AES-GCM), asked for once per session, or
 * keeps them unencrypted in the browser's storage when the user prefers. Keys never go into settings exports, macros
 * or AI History; in memory they sit on the service records while the app runs.
 */
import type { AiService } from './types';
import { desktopBridge, isCapacitor, isNative, Native } from '../platform/native';

export interface KeyBackend { kind: 'desktop' | 'android' | 'web'; encrypted: boolean; label: string }
const WEB_KEY = 'annes-lens.ai.keys.v1', SECRET_NAME = 'ai.keys', ITERATIONS = 600000;
const enc = new TextEncoder(), dec = new TextDecoder();

/** The app sets this: asks for the passphrase (purpose 'set' when choosing one, 'unlock' when opening the store). Null: the user declined. */
export const keystoreHooks = { askPassphrase: null as null | ((purpose: 'set' | 'unlock', wrong: boolean) => Promise<string | null>), /** Tells the user something about the store (a toast). */ notify: null as null | ((message: string) => void) };

let ready: Promise<void> = Promise.resolve();
let passphrase: string | null = null, cryptoKey: { salt: Uint8Array; key: CryptoKey } | null = null;
let lastStored = '';
/** Other small secrets kept in the same store (the Content Credentials signing key), by name; the services last loaded, to store with. */
let extras: Record<string, string> = {}, known: AiService[] = [];
export const getExtra = (name: string): string | undefined => extras[name];
export async function setExtra(name: string, value: string | null): Promise<void> { if (value === null) delete extras[name]; else extras[name] = value; await storeKeys(known); }
/** Resolves when the keys have been loaded into the service records (immediately when nothing was asked to load). */
export const keysReady = (): Promise<void> => ready;
/** For tests: forgets the session's passphrase and cached state. */
export function resetKeystore(): void { passphrase = null; cryptoKey = null; lastStored = ''; extras = {}; known = []; ready = Promise.resolve(); unread = false; }

const subtle = (): SubtleCrypto => { const c = (globalThis.crypto || (globalThis as any).webcrypto) as Crypto; if (!c?.subtle) throw new Error('No WebCrypto'); return c.subtle; };
const b64 = (u8: Uint8Array): string => btoa(String.fromCharCode(...u8));
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function keyBackend(): Promise<KeyBackend> {
  const d = desktopBridge();
  if (d) {
    try { const i = await d.secretInfo(); return { kind: 'desktop', encrypted: !!i.available && i.backend !== 'basic_text', label: !i.available ? 'the desktop keeps keys in a file beside its settings (no encryption available on this system)' : i.backend === 'basic_text' ? "the desktop's settings folder (no keyring found on this system, so the file is only lightly protected)" : 'the operating system\'s credential store (encrypted)' }; }
    catch { return { kind: 'desktop', encrypted: false, label: 'the desktop\'s settings folder' }; }
  }
  if (isCapacitor() && isNative()) {
    try { const i = await Native.secretInfo(); if (i.available) return { kind: 'android', encrypted: true, label: 'the Android Keystore (encrypted)' }; } catch { /* no secret methods: an older native build */ }
  }
  let mode = 'none';
  try { mode = JSON.parse(localStorage.getItem(WEB_KEY) || '{}').mode || 'none'; } catch { /* unreadable */ }
  return { kind: 'web', encrypted: mode !== 'plain', label: mode === 'plain' ? 'this browser\'s storage, unencrypted (you chose no passphrase)' : 'this browser\'s storage, encrypted with your passphrase' };
}

const keyMap = (services: AiService[]): Record<string, string> => ({ ...Object.fromEntries(services.filter((s) => s.key).map((s) => [s.id, s.key])), ...Object.fromEntries(Object.entries(extras).map(([k, v]) => ['__' + k, v])) });
const applyMap = (services: AiService[], map: Record<string, string>): void => { for (const s of services) if (!s.key && typeof map[s.id] === 'string') s.key = map[s.id]; for (const [k, v] of Object.entries(map)) if (k.startsWith('__') && typeof v === 'string') extras[k.slice(2)] = v; };

async function deriveKey(pass: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', enc.encode(pass) as BufferSource, 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations: ITERATIONS, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function keyFor(pass: string, salt: Uint8Array): Promise<CryptoKey> {
  if (cryptoKey && passphrase === pass && cryptoKey.salt.length === salt.length && cryptoKey.salt.every((v, i) => v === salt[i])) return cryptoKey.key;
  const key = await deriveKey(pass, salt);
  cryptoKey = { salt, key }; passphrase = pass;
  return key;
}
/** Encrypts a key map with a passphrase (exported for tests). */
export async function encryptKeys(map: Record<string, string>, pass: string, salt?: Uint8Array): Promise<string> {
  const s = salt || crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFor(pass, s);
  const data = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, enc.encode(JSON.stringify(map)) as BufferSource));
  return JSON.stringify({ mode: 'encrypted', salt: b64(s), iv: b64(iv), iter: ITERATIONS, data: b64(data) });
}
/** Decrypts a stored record; throws on a wrong passphrase. */
export async function decryptKeys(record: string, pass: string): Promise<Record<string, string>> {
  const r = JSON.parse(record);
  if (r.mode !== 'encrypted') throw new Error('not encrypted');
  const key = await keyFor(pass, unb64(r.salt));
  const plain = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(r.iv) as BufferSource }, key, unb64(r.data) as BufferSource);
  return JSON.parse(dec.decode(plain));
}

/**
 * True while a stored record exists that this session has not read (the passphrase was declined or wrong, or the
 * platform store failed). "Not read" is not "empty": nothing is written or deleted over such a record.
 */
let unread = false;
export const keysLocked = (): boolean => unread;
/** Fills the services' keys from the store (keys already on a record are kept: those are new or legacy ones). */
export function loadKeys(services: AiService[]): Promise<void> {
  known = services;
  ready = (async () => {
    const d = desktopBridge();
    unread = true; // until a branch below has read the record, or found there is none
    try {
      if (d) { const r = await d.secretGet({ name: SECRET_NAME }); if (r.value) applyMap(services, JSON.parse(r.value)); unread = false; return; }
      if (isCapacitor() && isNative()) { try { const r = await Native.secretGet({ name: SECRET_NAME }); if (r.value) applyMap(services, JSON.parse(r.value)); unread = false; return; } catch { /* older native build: fall through to the web store */ } }
      const raw = localStorage.getItem(WEB_KEY);
      if (!raw) { unread = false; return; }
      const rec = JSON.parse(raw);
      if (rec.mode === 'plain') { applyMap(services, rec.keys || {}); unread = false; return; }
      if (rec.mode !== 'encrypted') return; // a record this version does not understand: left alone
      let wrong = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const pass = passphrase ?? (keystoreHooks.askPassphrase ? await keystoreHooks.askPassphrase('unlock', wrong) : null);
        if (pass === null) return; // locked for this session
        try { applyMap(services, await decryptKeys(raw, pass)); unread = false; return; } catch { wrong = true; passphrase = null; cryptoKey = null; }
      }
    } catch { /* the store is unreadable: the services keep whatever keys they have */ }
  })();
  return ready;
}

/** Writes the services' keys to the store (nothing is written when they have not changed). */
export async function storeKeys(services: AiService[]): Promise<void> {
  known = services;
  let map = keyMap(services), json = JSON.stringify(map);
  if (json === lastStored) return;
  if (unread) {
    // The stored record was never read this session. With nothing new to keep, it stays exactly as it is; with new keys,
    // it is read first (asking for the passphrase once more) so they are added to it, never written over it.
    if (!Object.keys(map).length) { lastStored = json; return; }
    await loadKeys(services);
    if (unread) { lastStored = json; keystoreHooks.notify?.('The stored AI keys are locked, so the new key is kept for this session only. Unlock them (AI ▸ Set Up AI) to store it.'); return; }
    map = keyMap(services); json = JSON.stringify(map);
  }
  const d = desktopBridge();
  if (d) { if (Object.keys(map).length) await d.secretSet({ name: SECRET_NAME, value: json }); else await d.secretDelete({ name: SECRET_NAME }); lastStored = json; return; }
  if (isCapacitor() && isNative()) {
    try { if (Object.keys(map).length) await Native.secretSet({ name: SECRET_NAME, value: json }); else await Native.secretDelete({ name: SECRET_NAME }); lastStored = json; return; }
    catch { /* older native build: the web store */ }
  }
  if (!Object.keys(map).length) { localStorage.removeItem(WEB_KEY); lastStored = json; return; }
  let mode = 'none';
  try { mode = JSON.parse(localStorage.getItem(WEB_KEY) || '{}').mode || 'none'; } catch { /* unreadable */ }
  if (mode !== 'plain' && passphrase === null && keystoreHooks.askPassphrase) passphrase = await keystoreHooks.askPassphrase('set', false);
  if (passphrase === null || mode === 'plain' && passphrase === null) { localStorage.setItem(WEB_KEY, JSON.stringify({ mode: 'plain', keys: map })); lastStored = json; return; }
  localStorage.setItem(WEB_KEY, await encryptKeys(map, passphrase, cryptoKey?.salt));
  lastStored = json;
}

/** Changes the web store's passphrase (or sets one where the keys were unencrypted). */
export async function setPassphrase(services: AiService[], pass: string): Promise<void> {
  if (unread) { await loadKeys(services); if (unread) throw new Error('Unlock the stored keys with the current passphrase first.'); }
  passphrase = pass; cryptoKey = null; lastStored = '';
  const map = keyMap(services);
  localStorage.setItem(WEB_KEY, await encryptKeys(map, pass));
  lastStored = JSON.stringify(map);
}
/** Forgets every stored key (the service records keep theirs until the app restarts). */
export async function forgetStoredKeys(): Promise<void> {
  const d = desktopBridge();
  if (d) { await d.secretDelete({ name: SECRET_NAME }); }
  else if (isCapacitor() && isNative()) { try { await Native.secretDelete({ name: SECRET_NAME }); } catch { /* older native build */ } }
  localStorage.removeItem(WEB_KEY); unread = false;
  lastStored = ''; passphrase = null; cryptoKey = null;
}
