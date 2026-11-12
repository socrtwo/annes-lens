/** Stop AI on the desktop and Android: the request through the native layer stops at once and is cancelled there. */
import { it, expect, vi } from 'vitest';

it('a native request stops when its signal aborts, and the native side is told', async () => {
  let cancelled: unknown = null, sent: any = null;
  (window as any).quillDesktop = { platform: 'linux', request: (o: unknown) => { sent = o; return new Promise(() => { /* a service that never answers */ }); }, cancelRequest: vi.fn(async (o: unknown) => { cancelled = o; return { cancelled: true }; }) };
  vi.resetModules();
  const { aiRequest } = await import('../../src/ai/transport');
  const ctl = new AbortController();
  const p = aiRequest({ url: 'https://api.example.com/v1/images', method: 'POST', body: '{}', signal: ctl.signal, timeoutMs: 600000 });
  await new Promise((r) => setTimeout(r, 10));
  expect(sent.id).toMatch(/^r[0-9a-z]+$/);
  const t0 = Date.now(); ctl.abort();
  await expect(p).rejects.toThrow(/^Stopped$/);
  expect(Date.now() - t0).toBeLessThan(200);
  expect(cancelled).toEqual({ id: sent.id });
  // Without a signal nothing changes: no id is sent.
  void aiRequest({ url: 'https://api.example.com/v1/models' }); await new Promise((r) => setTimeout(r, 10));
  expect(sent.id).toBeUndefined();
  delete (window as any).quillDesktop;
});

it('files from the desktop bridge arrive as bytes, exactly their own range of the buffer (U13)', async () => {
  const { bufferFromB64 } = await import('../../src/platform/native');
  const whole = new Uint8Array([9, 9, 1, 2, 3, 9]);
  expect([...new Uint8Array(bufferFromB64(whole.subarray(2, 5)))]).toEqual([1, 2, 3]);
  const own = new Uint8Array([4, 5]);
  expect(bufferFromB64(own)).toBe(own.buffer);
  expect([...new Uint8Array(bufferFromB64('AQID'))]).toEqual([1, 2, 3]);
  const ab = new ArrayBuffer(2);
  expect(bufferFromB64(ab)).toBe(ab);
});
