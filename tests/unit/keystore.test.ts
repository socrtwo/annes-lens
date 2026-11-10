import { describe, it, expect, beforeEach } from 'vitest';
import { encryptKeys, decryptKeys, loadKeys, storeKeys, keyBackend, keystoreHooks, resetKeystore, keysReady, setPassphrase, forgetStoredKeys, keysLocked } from '../../src/ai/keystore';
import { prefsWithoutKeys, savePrefs, defaultPrefs } from '../../src/prefs';
import type { AiService } from '../../src/ai/types';

const svc = (id: string, key: string): AiService => ({ id, name: id, api: 'openai', baseUrl: 'http://localhost:1', key, textModel: 'm', imageModel: '' });

describe('AI keys in the keystore (the web store: passphrase encryption)', () => {
  beforeEach(() => { localStorage.clear(); resetKeystore(); keystoreHooks.askPassphrase = null; });
  it('encrypts and decrypts a key map; a wrong passphrase fails', async () => {
    const rec = await encryptKeys({ a: 'sk-1', b: 'sk-2' }, 'correct horse');
    const parsed = JSON.parse(rec);
    expect(parsed.mode).toBe('encrypted');
    expect(rec).not.toContain('sk-1');
    expect(await decryptKeys(rec, 'correct horse')).toEqual({ a: 'sk-1', b: 'sk-2' });
    resetKeystore();
    await expect(decryptKeys(rec, 'wrong')).rejects.toThrow();
  }, 30000);
  it('stores with the passphrase the hook gives, and loads them back once unlocked', async () => {
    const asked: string[] = [];
    keystoreHooks.askPassphrase = async (purpose) => { asked.push(purpose); return 'pass phrase'; };
    const services = [svc('one', 'key-one'), svc('two', '')];
    await storeKeys(services);
    expect(asked).toEqual(['set']);
    expect(localStorage.getItem('annes-lens.ai.keys.v1')).not.toContain('key-one');
    expect((await keyBackend()).encrypted).toBe(true);
    resetKeystore(); // a new session: the passphrase is asked for again
    const fresh = [svc('one', ''), svc('two', '')];
    await loadKeys(fresh);
    await keysReady();
    expect(asked).toEqual(['set', 'unlock']);
    expect(fresh.map((s) => s.key)).toEqual(['key-one', '']);
    // a wrong passphrase is retried, then the keys stay locked
    resetKeystore();
    let n = 0; keystoreHooks.askPassphrase = async (_p, wrong) => { n++; return n === 1 ? 'nope' : wrong && n === 2 ? 'pass phrase' : null; };
    const again = [svc('one', '')];
    await loadKeys(again);
    expect(again[0].key).toBe('key-one');
    expect(n).toBe(2);
  }, 60000);
  it('keeps the keys unencrypted when the user declines a passphrase, and says so', async () => {
    keystoreHooks.askPassphrase = async () => null;
    const services = [svc('one', 'plain-key')];
    await storeKeys(services);
    expect(JSON.parse(localStorage.getItem('annes-lens.ai.keys.v1')!)).toEqual({ mode: 'plain', keys: { one: 'plain-key' } });
    const b = await keyBackend();
    expect([b.kind, b.encrypted]).toEqual(['web', false]);
    resetKeystore();
    const fresh = [svc('one', '')];
    await loadKeys(fresh);
    expect(fresh[0].key).toBe('plain-key');
    await setPassphrase(fresh, 'later');
    expect((await keyBackend()).encrypted).toBe(true);
    await forgetStoredKeys();
    expect(localStorage.getItem('annes-lens.ai.keys.v1')).toBeNull();
  }, 30000);
  it('a stored record that was not unlocked is never deleted or written over; new keys are added to it once it is unlocked', async () => {
    keystoreHooks.askPassphrase = async () => 'pass phrase';
    await storeKeys([svc('one', 'key-one')]);
    const record = localStorage.getItem('annes-lens.ai.keys.v1')!;
    // A new session; the user answers "Not now" to the unlock prompt. Saving the settings must leave the record alone.
    resetKeystore();
    const told: string[] = []; keystoreHooks.notify = (m) => told.push(m);
    keystoreHooks.askPassphrase = async () => null;
    const locked = [svc('one', '')];
    await loadKeys(locked);
    expect(keysLocked()).toBe(true);
    await storeKeys(locked);
    expect(localStorage.getItem('annes-lens.ai.keys.v1')).toBe(record);
    // A key typed while locked: still nothing is written over the record, and the user is told.
    const withNew = [svc('one', ''), svc('two', 'key-two')];
    await storeKeys(withNew);
    expect(localStorage.getItem('annes-lens.ai.keys.v1')).toBe(record);
    expect(told.length).toBe(1); expect(told[0]).toMatch(/locked/);
    // Unlocked on the next change: the stored key comes back and the new one joins it.
    keystoreHooks.askPassphrase = async () => 'pass phrase';
    const more = [svc('one', ''), svc('two', 'key-two'), svc('three', 'key-three')];
    await storeKeys(more);
    expect(keysLocked()).toBe(false);
    expect(more[0].key).toBe('key-one');
    expect(await decryptKeys(localStorage.getItem('annes-lens.ai.keys.v1')!, 'pass phrase')).toEqual({ one: 'key-one', two: 'key-two', three: 'key-three' });
    keystoreHooks.notify = null;
  }, 60000);
  it('the settings never carry keys: saving and exporting scrub them', () => {
    const p = defaultPrefs();
    p.ai.services = [svc('one', 'secret-1')];
    expect(prefsWithoutKeys(p).ai.services[0].key).toBe('');
    expect(p.ai.services[0].key).toBe('secret-1'); // the live copy keeps it
    savePrefs(p);
    expect(localStorage.getItem('quilllens.prefs.v1')).not.toContain('secret-1');
  });
});
