/**
 * Network sharing: the desktop's share server (electron/netshare.cjs) and the relay (scripts/relay.mjs)
 * speak the protocol of docs/NETSHARE.md; the app-side address parsing and helpers.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseShareAddress, relayRoom, viewSignature, dataUrlBytes, randomToken } from '../../src/commands/netshare';

const require = createRequire(import.meta.url);
const { startShare } = require('../../electron/netshare.cjs');
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
