/**
 * Network sharing: the desktop's share server (electron/netshare.cjs) and the relay (scripts/relay.mjs)
 * speak the protocol of docs/NETSHARE.md; the app-side address parsing and helpers.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseShareAddress, relayRoom, viewSignature, dataUrlBytes, randomToken, latestOnly, retryDelay } from '../../src/commands/netshare';

const require = createRequire(import.meta.url);
const { startShare, pushEvent, MAX_UPLOAD, MAX_ACTIVE_UPLOADS } = require('../../electron/netshare.cjs');
const { startRemote } = require('../../electron/remote.cjs');
const started: { stop?: () => void; close?: () => void }[] = [];
afterAll(() => { for (const s of started) (s.stop || s.close)?.(); });
const text = async (r: Response) => r.text();
const firstEvent = async (url: string) => { const ctl = new AbortController(); const res = await fetch(url, { signal: ctl.signal }); const chunk = new TextDecoder().decode((await res.body!.getReader().read()).value); ctl.abort(); return chunk; };

describe('share addresses', () => {
  it('parses room addresses with or without the trailing parts and rejects the rest', () => {
    expect(parseShareAddress('http://192.168.1.20:5123/s/0123456789abcdef0123456789abcdef/')).toEqual({ base: 'http://192.168.1.20:5123/s/0123456789abcdef0123456789abcdef/', kind: 's', token: '0123456789abcdef0123456789abcdef' });
    expect(parseShareAddress(' https://relay.example.org/a/ABCDEF0123456789/state ')?.base).toBe('https://relay.example.org/a/ABCDEF0123456789/');
    expect(parseShareAddress('https://relay.example.org/lens/a/abcdef0123456789abcdef0123456789')?.kind).toBe('a');
    expect(parseShareAddress('http://host/x/0123456789abcdef/')).toBeNull(); expect(parseShareAddress('http://host/s/short/')).toBeNull(); expect(parseShareAddress('not a url')).toBeNull();
    expect(relayRoom('https://relay.example.org/', 's', 'abc')).toBe('https://relay.example.org/s/abc/');
    expect(viewSignature({ key: 'k', rel: 1.23456, nx: 0.5, ny: 0.25 })).toBe('k|1.2346|0.5000|0.2500');
    expect(new Uint8Array(dataUrlBytes('data:image/jpeg;base64,AQID')!)).toEqual(Uint8Array.from([1, 2, 3])); expect(dataUrlBytes('http://x')).toBeNull();
    expect(randomToken()).toMatch(/^[0-9a-f]{32}$/); expect(randomToken(6)).toHaveLength(12);
  });
});

describe('the share server', () => {
  it('serves a shared view behind its token: page, script, state, events, conditional state', async () => {
    const s = await startShare(0); started.push(s);
    const room = s.view(); const base = `http://127.0.0.1:${s.port}/s/${room.token}/`;
    expect(room.urls[0]).toMatch(new RegExp(`^http://[0-9.]+:${s.port}/s/${room.token}/$`));
    expect(await text(await fetch(base))).toMatch(/Anne's Lens shared view/); expect(await text(await fetch(`${base}app.js`))).toMatch(/EventSource/);
    expect((await fetch(base.replace(room.token, '0'.repeat(32)))).status).toBe(404); expect((await fetch(`http://127.0.0.1:${s.port}/a/${room.token}/`)).status).toBe(404); // the kind must match too
    room.setState({ kind: 'view', name: 'a.png', rel: 1, nx: 0.5, ny: 0.5, key: 'k1', sig: 'sig1', picture: 'data:image/jpeg;base64,AQID' });
    const st = await (await fetch(`${base}state`)).json(); expect(st.name).toBe('a.png');
    expect((await fetch(`${base}state?since=sig1`)).status).toBe(304); expect((await fetch(`${base}state?since=old`)).status).toBe(200);
    expect(await firstEvent(`${base}events`)).toMatch(/^data: \{"kind":"view"/);
    const cors = await fetch(`${base}state`, { method: 'OPTIONS' }); expect(cors.status).toBe(204); expect(cors.headers.get('access-control-allow-origin')).toBe('*');
    room.stop(); expect((await fetch(`${base}state`)).status).toBe(404); expect(s.rooms()).toBe(0);
  });
  it('serves a shared album: listing, thumbnails, files, and additions into the chosen folder when allowed', async () => {
    const s = await startShare(0); started.push(s);
    const dir = mkdtempSync(join(tmpdir(), 'qn-share-')), file = join(dir, 'one.png'); writeFileSync(file, Buffer.from([137, 80, 78, 71, 1, 2, 3]));
    const added: { name: string; size: number }[] = [];
    const room = s.album({ name: 'Trip', items: [{ id: 'i1', name: 'one.png', size: 7, path: file, mime: 'image/png', thumb: 'data:image/jpeg;base64,/9j/AA==' }, { id: 'i2', name: 'gone.png', size: 3, path: null, thumb: null }], contribute: false });
    const base = `http://127.0.0.1:${s.port}/a/${room.token}/`;
    expect(await text(await fetch(base))).toMatch(/Anne's Lens shared album/);
    const st = await (await fetch(`${base}state`)).json(); expect(st).toMatchObject({ name: 'Trip', contribute: false, items: [{ id: 'i1', name: 'one.png', size: 7 }, { id: 'i2', name: 'gone.png' }] }); expect(st.items[0].thumb).toBeUndefined();
    const th = await fetch(`${base}thumb/i1`); expect(th.headers.get('content-type')).toBe('image/jpeg'); expect((await th.arrayBuffer()).byteLength).toBe(4);
    expect((await fetch(`${base}thumb/i2`)).status).toBe(404);
    const f = await fetch(`${base}file/i1`); expect(f.status).toBe(200); expect(f.headers.get('content-type')).toBe('image/png'); expect(new Uint8Array(await f.arrayBuffer())).toEqual(Uint8Array.from([137, 80, 78, 71, 1, 2, 3]));
    expect((await fetch(`${base}file/i2`)).status).toBe(404); expect((await fetch(`${base}file/i9`)).status).toBe(404);
    expect((await fetch(`${base}add?name=x.png`, { method: 'POST', body: 'abc' })).status).toBe(403); // not allowed yet
    room.update({ contribute: true, contribDir: dir, onAdded: (x: { name: string; size: number }) => added.push({ name: x.name, size: x.size }) });
    expect((await (await fetch(`${base}state`)).json()).contribute).toBe(true);
    const up = await fetch(`${base}add?name=../../evil.png`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: Buffer.from([1, 2, 3, 4]) });
    expect(up.status).toBe(200); expect((await up.json()).name).toBe('evil.png'); // only the base name is kept
    expect(existsSync(join(dir, 'evil.png'))).toBe(true); expect([...readFileSync(join(dir, 'evil.png'))]).toEqual([1, 2, 3, 4]);
    const again = await fetch(`${base}add?name=evil.png`, { method: 'POST', body: Buffer.from([9]) }); expect((await again.json()).name).toBe('evil (2).png'); // no overwriting
    expect((await fetch(`${base}add?name=empty.png`, { method: 'POST', body: '' })).status).toBe(413);
    expect(added).toEqual([{ name: 'evil.png', size: 4 }, { name: 'evil (2).png', size: 1 }]);
    room.stop();
  });
});

describe('the relay', () => {
  it('passes state from a keyed host to guests, serves the guest pages, and refuses other keys', async () => {
    // @ts-ignore the relay is a plain script without a declaration file
    const { startRelay } = await import('../../scripts/relay.mjs');
    const r = await startRelay(0); started.push(r);
    const token = randomToken(), base = `http://127.0.0.1:${r.port}/s/${token}/`;
    expect((await fetch(`${base}state`)).status).toBe(404);
    expect((await fetch(`${base}state`, { method: 'PUT', body: '{}' })).status).toBe(401); // no key
    expect((await fetch(`${base}state`, { method: 'POST', headers: { authorization: 'Bearer k1', 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'view', name: 'a.png', sig: 's1' }) })).status).toBe(204);
    expect((await fetch(`${base}state`, { method: 'PUT', headers: { authorization: 'Bearer k2' }, body: '{"kind":"view"}' })).status).toBe(403); // another key cannot take the room
    expect((await fetch(`${base}state`, { method: 'PUT', headers: { authorization: 'Bearer k1' }, body: 'not json' })).status).toBe(400);
    expect(await (await fetch(`${base}state`)).json()).toEqual({ kind: 'view', name: 'a.png', sig: 's1' });
    expect((await fetch(`${base}state?since=s1`)).status).toBe(304);
    expect(await firstEvent(`${base}events`)).toMatch(/^data: \{"kind":"view","name":"a.png"/);
    expect(await text(await fetch(base))).toMatch(/Anne's Lens shared view/); expect(await text(await fetch(`${base}app.js`))).toMatch(/EventSource/);
    expect((await fetch(`http://127.0.0.1:${r.port}/a/${token}/state`)).status).toBe(404); // the kind is part of the room
    expect(await text(await fetch(`http://127.0.0.1:${r.port}/`))).toMatch(/1 room/);
    expect(r.rooms()).toBe(1);
  });
});

/** A raw request whose body the test sends in pieces: resolves with the status, or 'closed' when the server ends the connection. */
function rawPost(port: number, path: string, headers: Record<string, string | number> = {}) {
  const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers });
  const done = new Promise<number | 'closed'>((resolve) => { req.on('response', (r) => { r.resume(); resolve(r.statusCode!); }); req.on('error', () => resolve('closed')); });
  return { req, done };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('requests that used to end the server', () => {
  it('answers an address that does not parse, and a malformed escape, and goes on serving', async () => {
    const s = await startShare(0); started.push(s);
    const room = s.album({ name: 'A', items: [{ id: 'i1', name: 'one.png', thumb: 'data:image/jpeg;base64,/9j/AA==', path: null }] });
    const root = `http://127.0.0.1:${s.port}`, base = `${root}/a/${room.token}/`;
    expect((await fetch(`${root}//`)).status).toBe(400);
    expect((await fetch(`${base}thumb/%E0%A4%A`)).status).toBe(404); expect((await fetch(`${base}file/%`)).status).toBe(404);
    expect((await fetch(`${base}thumb/i1`)).status).toBe(200);

    const remote = await startRemote(() => undefined, 0); started.push(remote);
    expect((await fetch(`http://127.0.0.1:${remote.port}//`)).status).toBe(400);
    expect((await fetch(remote.urls[0].replace(/^http:\/\/[^/:]+/, 'http://127.0.0.1') + 'state')).status).toBe(200);

    // @ts-ignore the relay is a plain script without a declaration file
    const { startRelay } = await import('../../scripts/relay.mjs');
    const r = await startRelay(0); started.push(r);
    expect((await fetch(`http://127.0.0.1:${r.port}//`)).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${r.port}/`)).status).toBe(200);
  });
});

describe('what guests may add to a shared album', () => {
  it('takes pictures only, a few at a time, never more than the limit, and nothing once sharing has stopped', async () => {
    const s = await startShare(0); started.push(s);
    const dir = mkdtempSync(join(tmpdir(), 'qn-share-up-')), added: string[] = [];
    const room = s.album({ name: 'Trip', items: [], contribute: true, contribDir: dir, onAdded: (x: { name: string }) => added.push(x.name) });
    const path = `/a/${room.token}/add`, base = `http://127.0.0.1:${s.port}${path}`;
    // Programs, pages and scriptable pictures are refused by name.
    for (const name of ['run.exe', 'page.html', 'drawing.svg', 'noext', 'photo.jpg.sh']) expect((await fetch(`${base}?name=${name}`, { method: 'POST', body: 'x' })).status).toBe(415);
    expect((await fetch(`${base}?name=ok.JPG`, { method: 'POST', body: 'x' })).status).toBe(200);
    // Too large by its own declaration: refused before a byte is stored.
    const big = rawPost(s.port, `${path}?name=big.png`, { 'content-length': MAX_UPLOAD + 1 }); big.req.flushHeaders();
    expect(await big.done).toBe(413); big.req.destroy();
    // Too large without saying so (chunked): cut off at the limit, and no part of it stays in the folder.
    const chunk = Buffer.alloc(1024 * 1024, 7), long = rawPost(s.port, `${path}?name=long.png`);
    long.req.on('error', () => undefined); long.req.setMaxListeners(0);
    let shut = false; long.req.once('close', () => { shut = true; });
    for (let i = 0; i < MAX_UPLOAD / chunk.length + 2 && !shut; i++) if (!long.req.write(chunk)) await Promise.race([new Promise((r) => long.req.once('drain', r)), wait(200)]);
    long.req.end(); expect([413, 'closed']).toContain(await long.done);
    // Only so many uploads at once.
    const open = Array.from({ length: MAX_ACTIVE_UPLOADS }, (_, i) => { const u = rawPost(s.port, `${path}?name=slow${i}.png`); u.req.write('abc'); return u; });
    await wait(150);
    expect((await fetch(`${base}?name=extra.png`, { method: 'POST', body: 'x' })).status).toBe(429);
    // Sharing stops while they are on their way: none of them is written.
    room.stop();
    for (const u of open) { u.req.end('def'); expect([410, 404, 'closed']).toContain(await u.done); }
    await wait(150);
    expect(readdirSync(dir).sort()).toEqual(['ok.JPG']);
    expect(added).toEqual(['ok.JPG']);
  });
});

describe('guests that do not read', () => {
  it('get the latest state when they catch up, not every state in between', () => {
    const written: string[] = []; let full = false; const drains: (() => void)[] = [];
    const c = { write: (line: string) => { written.push(line); return !full; }, once: (_e: string, cb: () => void) => { drains.push(cb); } };
    pushEvent(c, 'a'); full = true; pushEvent(c, 'b');          // b is accepted but fills the buffer
    for (const x of ['c', 'd', 'e']) pushEvent(c, x);             // nothing is written while the guest is stalled
    expect(written).toEqual(['a', 'b']);
    full = false; drains.shift()!();                              // the guest reads again: only the newest goes out
    expect(written).toEqual(['a', 'b', 'e']);
    pushEvent(c, 'f'); expect(written).toEqual(['a', 'b', 'e', 'f']); expect(drains).toHaveLength(0);
  });

  it('are limited in number per room', async () => {
    // @ts-ignore the relay is a plain script without a declaration file
    const { startRelay } = await import('../../scripts/relay.mjs');
    const r = await startRelay(0, { maxRooms: 2, roomsPerAddress: 2, maxGuests: 1 }); started.push(r);
    const put = (token: string, key: string, state: object) => fetch(`http://127.0.0.1:${r.port}/s/${token}/state`, { method: 'PUT', headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(state) });
    const [t1, t2, t3] = [randomToken(), randomToken(), randomToken()];
    expect((await put(t1, 'k', { kind: 'view' })).status).toBe(204); expect((await put(t2, 'k', { kind: 'view' })).status).toBe(204);
    expect((await put(t3, 'k', { kind: 'view' })).status).toBe(429);            // no place for a third room
    expect((await put(t1, 'k', { kind: 'view', n: 2 })).status).toBe(204);       // the rooms that exist go on working
    const ctl = new AbortController(), first = await fetch(`http://127.0.0.1:${r.port}/s/${t1}/events`, { signal: ctl.signal });
    expect(first.status).toBe(200); expect((await fetch(`http://127.0.0.1:${r.port}/s/${t1}/events`)).status).toBe(503);
    ctl.abort();
    expect(r.rooms()).toBe(2);
  });
});

describe('following a shared view', () => {
  it('never loses the newest state while an earlier one is being applied', async () => {
    const applied: number[] = []; let release: () => void = () => undefined;
    const on = latestOnly<number>(async (n) => { applied.push(n); if (n === 1) await new Promise<void>((r) => { release = r; }); });
    on(1); on(2); on(3); on(4);                  // 2 and 3 are superseded while 1 is applied
    expect(applied).toEqual([1]);
    release(); await wait(10);
    expect(applied).toEqual([1, 4]);
    on(5); await wait(10); expect(applied).toEqual([1, 4, 5]);
    // A failing state does not stop the ones after it; a follower that has stopped applies nothing.
    let alive = true; const seen: number[] = [];
    const on2 = latestOnly<number>(async (n) => { if (n === 1) throw new Error('x'); seen.push(n); }, () => alive);
    on2(1); await wait(5); on2(2); await wait(5); alive = false; on2(3); await wait(5);
    expect(seen).toEqual([2]);
  });
  it('asks again more slowly while the host cannot be reached', () => {
    expect([0, 1, 2, 3, 4, 9].map(retryDelay)).toEqual([400, 800, 1600, 3200, 5000, 5000]);
  });
});
