import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { cborEncode, cborDecode, Tagged } from '../../src/meta/cbor';
import { selfSignedCertificate, readCertificate, ecdsaRawToDer, ecdsaDerToRaw, oid, oidString, read } from '../../src/meta/der';
import { makeSigner, loadSigner, embedManifest, readManifest, describeManifest, findManifestStore } from '../../src/meta/c2pa';

const jpg = () => new Uint8Array(readFileSync('tests/fixtures/jpeg/base-420.jpg'));
const png = () => new Uint8Array(readFileSync('tests/fixtures/png/gray1.png'));
const webp = () => new Uint8Array(readFileSync('tests/fixtures/meta/tagged.webp'));
const input = (title: string, format: 'image/jpeg' | 'image/png' | 'image/webp') => ({ title, format, generator: { name: "Anne's Lens", version: '0.2.0' }, action: { action: 'c2pa.created' as const, when: '2026-11-05T12:00:00Z', softwareAgent: "Anne's Lens/0.2.0", digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia', description: 'ai.generate with Mock', parameters: { prompt: 'a bicycle', model: 'mock-image', service: 'Mock' } } });

describe('CBOR', () => {
  it('round-trips the values manifests use', () => {
    const v = { a: 1, b: -5, c: 'text', d: new Uint8Array([1, 2, 3]), e: [true, false, null], f: 1.5, g: 70000, h: 2 ** 40 };
    const back: any = cborDecode(cborEncode(v));
    expect(back.a).toBe(1); expect(back.b).toBe(-5); expect(back.c).toBe('text'); expect(Array.from(back.d)).toEqual([1, 2, 3]); expect(back.e).toEqual([true, false, null]); expect(back.f).toBe(1.5); expect(back.g).toBe(70000); expect(back.h).toBe(2 ** 40);
    const m: any = cborDecode(cborEncode(new Map<number, unknown>([[1, -7], [33, [new Uint8Array(2)]]])));
    expect(m instanceof Map && m.get(1)).toBe(-7);
    const t: any = cborDecode(cborEncode(new Tagged(18, ['x'])));
    expect(t instanceof Tagged && t.tag).toBe(18);
    expect(Array.from(cborEncode(0))).toEqual([0]); expect(Array.from(cborEncode(24))).toEqual([0x18, 24]); expect(Array.from(cborEncode(-1))).toEqual([0x20]);
  });
});

describe('DER and the self-signed certificate', () => {
  it('encodes object identifiers both ways and ECDSA signatures both ways', () => {
    const o = oid('1.2.840.10045.4.3.2');
    expect(Array.from(o)).toEqual([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]);
    expect(oidString(o, read(o, 0))).toBe('1.2.840.10045.4.3.2');
    const raw = new Uint8Array(64); raw[0] = 0x80; raw[63] = 1;
    expect(Array.from(ecdsaDerToRaw(ecdsaRawToDer(raw)))).toEqual(Array.from(raw));
  });
  it('makes a certificate WebCrypto can verify, with the subject, validity and key readable back', async () => {
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const der = await selfSignedCertificate(keys, { commonName: 'Test signer', organization: 'Tests', notBefore: new Date('2026-01-01T00:00:00Z'), notAfter: new Date('2036-01-01T00:00:00Z') });
    const c = readCertificate(der);
    expect([c.subject, c.organization, c.issuer, c.selfSigned, c.notBefore, c.notAfter]).toEqual(['Test signer', 'Tests', 'Test signer', true, '2026-01-01T00:00:00Z', '2036-01-01T00:00:00Z']);
    const pub = await crypto.subtle.importKey('spki', c.spki as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, ecdsaDerToRaw(c.signature) as BufferSource, c.tbs as BufferSource)).toBe(true);
  });
});

describe('C2PA manifests', () => {
  it('signs a JPEG and a PNG that read back as valid, with the actions and the signer', async () => {
    const signer = await loadSigner(await makeSigner("Anne's Lens on this device", "Anne's Lens"));
    for (const [bytes, fmt] of [[jpg(), 'image/jpeg'], [png(), 'image/png']] as const) {
      const signed = await embedManifest(bytes, input('picture', fmt), signer);
      expect(signed.length).toBeGreaterThan(bytes.length + 800);
      expect(findManifestStore(bytes)).toBeNull();
      const m = (await readManifest(signed))!;
      expect(m.checks).toEqual({ hash: true, assertions: true, signature: true });
      expect(m.problems).toEqual([]);
      expect([m.title, m.format, m.generator, m.signer?.subject, m.signer?.selfSigned]).toEqual(['picture', fmt, "Anne's Lens 0.2.0", "Anne's Lens on this device", true]);
      expect(m.actions).toEqual([{ action: 'c2pa.created', when: '2026-11-05T12:00:00Z', softwareAgent: "Anne's Lens/0.2.0", digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia', description: 'ai.generate with Mock', parameters: { prompt: 'a bicycle', model: 'mock-image', service: 'Mock' } }]);
      expect(m.signer?.certificate).toBe(true);
      // With this device's certificate at hand the signer is known; without it (a locked keystore, another device) the name is only what the certificate says.
      expect(describeManifest(m, signer.cert)).toBe("unchanged since it was signed; signed on this device (“Anne's Lens on this device (Anne's Lens)”); created (trainedAlgorithmicMedia) by Anne's Lens/0.2.0 on 2026-11-05; made by Anne's Lens 0.2.0");
      expect(describeManifest(m)).toBe("unchanged since it was signed; signer not verified: the certificate names “Anne's Lens on this device (Anne's Lens)”, self-signed; a certificate can carry any name, and this one is not checked against a list of trusted issuers; created (trainedAlgorithmicMedia) by Anne's Lens/0.2.0 on 2026-11-05; made by Anne's Lens 0.2.0");
      expect(m.instanceID).toMatch(/^xmp:iid:[0-9a-f-]{36}$/);
      expect(m.label).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    }
  }, 30000);
  it('a JPEG keeps Exif first and its picture intact; the manifest sits in APP11 segments before the frame', async () => {
    const signer = await loadSigner(await makeSigner('S'));
    const signed = await embedManifest(jpg(), input('p', 'image/jpeg'), signer);
    const found = findManifestStore(signed)!;
    expect(found.exclusions.length).toBe(1);
    expect(signed[found.exclusions[0].start]).toBe(0xff); expect(signed[found.exclusions[0].start + 1]).toBe(0xeb);
    const without = new Uint8Array([...signed.subarray(0, found.exclusions[0].start), ...signed.subarray(found.exclusions[0].start + found.exclusions[0].length)]);
    expect(Array.from(without)).toEqual(Array.from(jpg()));
  });
  it('WebP: the C2PA chunk before the image data, the RIFF size kept right, valid when read back', async () => {
    const signer = await loadSigner(await makeSigner('S'));
    const signed = await embedManifest(webp(), input('p.webp', 'image/webp'), signer);
    const m = (await readManifest(signed))!;
    expect(m.checks).toEqual({ hash: true, assertions: true, signature: true });
    const riff = (signed[4] | (signed[5] << 8) | (signed[6] << 16) | (signed[7] << 24)) >>> 0;
    expect(riff).toBe(signed.length - 8);
    expect(new TextDecoder().decode(signed.subarray(12, 16))).toBe('VP8X');
    const found = findManifestStore(signed)!;
    expect(new TextDecoder().decode(signed.subarray(found.exclusions[0].start, found.exclusions[0].start + 4))).toBe('C2PA');
  }, 30000);
  it('never presents a name from a certificate as who signed, unless the certificate is this device\'s own', async () => {
    const own = await loadSigner(await makeSigner("Anne's Lens on this device", "Anne's Lens"));
    // Anyone can make a certificate that says Reuters, or one that carries this app's own name.
    for (const [cn, org] of [['Reuters', 'Thomson Reuters'], ["Anne's Lens on this device", "Anne's Lens"]]) {
      const forger = await loadSigner(await makeSigner(cn, org));
      const m = (await readManifest(await embedManifest(jpg(), input('news.jpg', 'image/jpeg'), forger)))!;
      expect(m.checks).toEqual({ hash: true, assertions: true, signature: true });   // the file is intact; that says nothing about who made it
      const text = describeManifest(m, own.cert);
      expect(text).toMatch(new RegExp(`^unchanged since it was signed; signer not verified: the certificate names “${cn} \\(${org}\\)”, self-signed; a certificate can carry any name`));
      expect(text).not.toMatch(/signed on this device|signed by|^valid/);
    }
    // A certificate whose own signature does not match (its name edited after it was made) is reported as damaged.
    const edited = await loadSigner(await makeSigner('Reuterz', 'News'));
    const at = edited.cert.findIndex((_, i) => edited.cert[i] === 0x52 && edited.cert[i + 6] === 0x7a); // "Reuterz" in the subject
    const cert = edited.cert.slice(); for (let i = 0; i < cert.length - 6; i++) if (cert[i] === 0x52 && cert[i + 1] === 0x65 && cert[i + 6] === 0x7a) cert[i + 6] = 0x73; // both names now read Reuters
    expect(at).toBeGreaterThan(0);
    const m = (await readManifest(await embedManifest(jpg(), input('news.jpg', 'image/jpeg'), { privateKey: edited.privateKey, cert })))!;
    expect([m.signer?.subject, m.signer?.certificate, m.checks.signature]).toEqual(['Reuters', false, true]);
    expect(describeManifest(m)).toMatch(/^changed or damaged: the certificate's own signature does not match; signer not verified/);
  }, 60000);
  it('an edit records its ingredient: title, thumbnail, and the original\'s own credentials copied and verified', async () => {
    const signer = await loadSigner(await makeSigner("Anne's Lens on this device", "Anne's Lens"));
    const original = await embedManifest(jpg(), input('original.jpg', 'image/jpeg'), signer);
    const thumb = jpg();
    const edited = await embedManifest(png(), { ...input('edited.png', 'image/png'), action: { ...input('x', 'image/png').action, action: 'c2pa.edited', digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia', description: 'ai.fill with Mock' }, ingredient: { title: 'original.jpg', format: 'image/jpeg', bytes: original, thumbnail: { bytes: thumb, mime: 'image/jpeg' } } }, signer);
    const m = (await readManifest(edited))!;
    expect(m.checks).toEqual({ hash: true, assertions: true, signature: true });
    expect(m.actions.map((a) => a.action)).toEqual(['c2pa.opened', 'c2pa.edited']);
    expect(m.ingredients.length).toBe(1);
    const i = m.ingredients[0];
    expect([i.title, i.format, i.relationship, i.thumbnail?.mime, i.thumbnail?.bytes.length, i.manifest?.found, i.manifest?.signature, i.manifest?.assertions, i.manifest?.signer]).toEqual(['original.jpg', 'image/jpeg', 'parentOf', 'image/jpeg', thumb.length, true, true, true, "Anne's Lens on this device"]);
    expect(describeManifest(m)).toContain("from original.jpg (its own credentials unchanged, certificate naming “Anne's Lens on this device”)");
    // without its own credentials, an ingredient is just named
    const plain = await embedManifest(png(), { ...input('e2.png', 'image/png'), ingredient: { title: 'photo.jpg', format: 'image/jpeg', bytes: jpg() } }, signer);
    const p = (await readManifest(plain))!;
    expect(p.ingredients).toEqual([{ title: 'photo.jpg', format: 'image/jpeg', relationship: 'parentOf' }]);
  }, 60000);
  it('detects a changed picture and a changed claim', async () => {
    const signer = await loadSigner(await makeSigner('S'));
    const signed = await embedManifest(png(), input('p', 'image/png'), signer);
    const tampered = signed.slice(); tampered[tampered.length - 20] ^= 1; // inside the image data
    const t = (await readManifest(tampered))!;
    expect([t.checks.hash, t.checks.signature, t.problems]).toEqual([false, true, ['the picture data changed since it was signed']]);
    const found = findManifestStore(signed)!;
    const claimAt = signed.indexOf(0x63, found.exclusions[0].start); // 'c' of a label; flip a byte of the title inside the claim
    const text = new TextDecoder().decode(signed), at = text.indexOf('xmp:iid:', found.exclusions[0].start);
    const edited = signed.slice(); edited[at + 8] = edited[at + 8] === 0x30 ? 0x31 : 0x30;
    const e = (await readManifest(edited))!;
    expect(e.checks.signature).toBe(false);
    expect(e.problems).toContain('the signature does not match the claim');
    void claimAt;
  }, 30000);
});
