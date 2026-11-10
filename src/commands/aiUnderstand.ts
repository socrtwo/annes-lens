/**
 * AI tab, Understand group: Describe, Alt Text, Ask About This Picture, Suggest Keywords, Write
 * Caption, Transcribe Handwriting, Identify, Estimate Date, Culling Assistant, Search by Content,
 * Find Similar by Content, Run on Selection. Text commands go to the text and vision service
 * (through Several AIs when it is on); Search and Find Similar use CLIP on the device.
 */
import { def } from './registry';
import type { App } from '../app';
import type { Raster } from '../codecs/raster';
import { openDialog, toast } from '../ui/dialog';
import { h, esc } from '../ui/dom';
import type { Entry } from '../picture/folder';
import { patchXmp, forTargets, propsOf, readMeta } from '../picture/metadata';
import { writeClipboardText } from '../platform/native';
import { askText, withJob, currentRaster, deviceBackend, ensureModel, needText, hasText, device } from '../ai';
import { extractJson } from '../ai/hosted';
import { entryInfo, stackIds } from '../picture/folderInfo';
import { grayOf, quality } from '../picture/similar';
import { textResult, canText, has, entryRaster, AI_NOTE, info } from './aiShared';
import { inputsOf } from './batch';
import { resample } from '../picture/ops';
import { rasterCanvas } from '../ai';

const SYS = 'You are a careful assistant describing pictures for a personal archive. Be accurate and specific; say when you are unsure. Do not invent names of people. Answer in plain text without markdown unless JSON is requested.';
const lines = (s: string) => s.split(/\r?\n|,|;/).map((x) => x.trim()).filter(Boolean);

async function ask(app: App, command: string, prompt: string, opts: { json?: boolean; images?: Raster[]; maxTokens?: number; system?: string } = {}) {
  return withJob(app, command, (status, signal) => askText(app, { command, system: opts.system || SYS, prompt, images: opts.images || [currentRaster(app)], json: opts.json, maxTokens: opts.maxTokens }, status, signal));
}
const delib = (app: App, r: { deliberation?: string } | null) => (app.prefs.ai.ensemble.showDeliberation ? r?.deliberation : undefined);

def([
  {
    id: 'ai.describe', icon: 'description', noRecord: true, popular: true, isEnabled: canText, tip: 'A description of the picture from the text and vision service',
    run: async (app) => {
      const r = await ask(app, 'ai.describe', 'Describe this picture in two or three sentences: the subject, the setting, notable details, and anything that helps find it later (text visible in it, era, style).');
      if (r) await textResult(app, 'Description', r.text, { note: `${r.service} (${r.model}), ${r.ms} ms.`, deliberation: delib(app, r), saveAs: { label: 'Save as caption', patch: (t) => ({ description: t }) } });
    },
  },
  {
    id: 'ai.altText', icon: 'accessibility_new', noRecord: true, popular: true, isEnabled: canText, tip: "Alt text and an extended description, written to XMP (Iptc4xmpCore:AltTextAccessibility) and used by Anne's Pen, Stage, Loom and Press",
    run: async (app) => {
      const r = await ask(app, 'ai.altText', 'Write alt text for this picture for screen-reader users: one sentence, at most 125 characters, no "image of". Then an extended description of two to four sentences for readers who cannot see it. Answer as JSON: {"alt": "...", "extended": "..."}', { json: true });
      if (!r) return;
      let j: any; try { j = extractJson(r.text); } catch { j = { alt: r.text.split('\n')[0], extended: r.text }; }
      const v = await openDialog({ title: 'Alt Text', ok: 'Save to the picture', wide: true, help: `${r.service}, ${r.ms} ms. ${AI_NOTE}`, fields: [
        { key: 'alt', label: 'Alt text', type: 'text', value: String(j.alt || '').trim() },
        { key: 'ext', label: 'Extended description', type: 'textarea', rows: 5, value: String(j.extended || '').trim() },
        ...(delib(app, r) ? [{ key: 'd', label: 'AI discussion', type: 'textarea' as const, rows: 8, value: r.deliberation }] : []),
      ] });
      if (!v) return;
      await forTargets(app, 'Alt text saved', (e) => patchXmp(app, e, { altText: String(v.alt).trim(), extDescription: String(v.ext).trim() }));
    },
  },
  {
    id: 'ai.ask', icon: 'chat', noRecord: true, popular: true, isEnabled: canText, tip: 'A chat with the picture as context',
    run: async (app) => {
      const history: { role: 'user' | 'assistant'; text: string }[] = [];
      const log = h('div', { class: 'qn-ai-chat' }, h('p', { class: 'ql-help' }, `Ask anything about ${app.picture!.name}. The picture goes with the first question only. ${AI_NOTE}`));
      const picture = currentRaster(app);
      const add = (role: 'user' | 'assistant', text: string) => { log.appendChild(h('div', { class: `qn-ai-msg ${role}` }, text)); log.scrollTop = log.scrollHeight; };
      let sending = false;
      await openDialog({ title: 'Ask About This Picture', content: log, wide: true, ok: 'Close', cancel: false, fields: [{ key: 'q', label: 'Question', type: 'text', value: '', autofocus: true, placeholder: 'Press Enter or Send' }], buttons: [{ label: 'Send', primary: true, onClick: async (v, ctl) => {
        const q = String(v.q || '').trim(); if (!q || sending) return;
        sending = true; ctl.set('q', ''); add('user', q);
        const r = await withJob(app, 'ai.ask', (status, signal) => askText(app, { command: 'ai.ask', system: SYS, prompt: q, images: history.length ? [] : [picture], history, maxTokens: 1500 }, status, signal));
        sending = false;
        if (!r) return;
        history.push({ role: 'user', text: q }, { role: 'assistant', text: r.text });
        add('assistant', r.text);
        if (delib(app, r)) add('assistant', `— AI discussion —\n${r.deliberation}`);
      } }] });
    },
  },
  {
    id: 'ai.autoTag', icon: 'sell', noRecord: true, popular: true, isEnabled: canText, tip: 'Suggested keywords; tick the ones to keep before saving',
    run: async (app) => {
      const existing = propsOf(app.picture!.entry)?.keywords || [];
      const r = await ask(app, 'ai.autoTag', `Suggest 8 to 15 keywords for cataloging this picture: subjects, objects, place type, activity, season, colors, mood, style. One or two words each, lower-case, no duplicates${existing.length ? `, not these existing keywords: ${existing.join(', ')}` : ''}. Answer as JSON: {"keywords": ["...", "..."]}`, { json: true });
      if (!r) return;
      let kws: string[] = [];
      try { const j = extractJson(r.text); kws = (Array.isArray(j) ? j : j.keywords || []).map((k: any) => String(k).trim()).filter(Boolean); } catch { kws = lines(r.text).map((k) => k.replace(/^[-*\d.\s]+/, '')); }
      kws = [...new Set(kws)].slice(0, 30);
      if (!kws.length) { toast('No keywords in the answer.'); return; }
      const v = await openDialog({ title: 'Suggested Keywords', ok: 'Save ticked keywords', help: `${r.service}, ${r.ms} ms. ${AI_NOTE}`, fields: [
        ...kws.map((k, i) => ({ key: `k${i}`, label: k, type: 'checkbox' as const, value: true, half: true })),
        { key: 'mode', label: 'Saving', type: 'select', options: [{ value: 'add', label: 'Add to the existing keywords' }, { value: 'replace', label: 'Replace the existing keywords' }], value: 'add' },
      ] });
      if (!v) return;
      const chosen = kws.filter((_k, i) => v[`k${i}`]);
      await forTargets(app, `${chosen.length} keywords saved`, async (e) => { const cur = v.mode === 'replace' ? [] : (await readMeta(app, e))?.props?.keywords || []; return patchXmp(app, e, { keywords: [...new Set([...cur, ...chosen])] }); });
      app.prefs.keywordHistory = [...new Set([...chosen, ...app.prefs.keywordHistory])].slice(0, 500); app.savePrefs();
    },
  },
  {
    id: 'ai.caption', icon: 'subtitles', noRecord: true, isEnabled: canText, tip: 'A caption in archive, social or plain style, saved to the picture',
    run: async (app) => {
      const s = await openDialog({ title: 'Write Caption', ok: 'Write', fields: [
        { key: 'style', label: 'Style', type: 'select', options: [{ value: 'archive', label: 'Archive (factual, who/what/where/when)' }, { value: 'social', label: 'Social (short, warm, one or two sentences)' }, { value: 'plain', label: 'Plain (one neutral sentence)' }], value: 'archive' },
        { key: 'hint', label: 'Facts to include (names, place, date)', type: 'text', value: '' },
      ] });
      if (!s) return;
      const style = s.style === 'archive' ? 'a factual archive caption of one to three sentences (what, where, when as far as visible; no guesses about names)' : s.style === 'social' ? 'a warm caption of one or two sentences for sharing with family' : 'one plain neutral sentence';
      const r = await ask(app, 'ai.caption', `Write ${style} for this picture.${s.hint ? ` Known facts: ${s.hint}.` : ''} Answer with the caption only.`);
      if (r) await textResult(app, 'Caption', r.text, { note: `${r.service}, ${r.ms} ms.`, deliberation: delib(app, r), saveAs: { label: 'Save as caption', patch: (t) => ({ description: t }) } });
    },
  },
  {
    id: 'ai.transcribe', icon: 'edit_note', noRecord: true, isEnabled: canText, tip: "Letters, records and postcards transcribed verbatim; to the caption, the clipboard or Anne's Pen",
    run: async (app) => {
      const r = await ask(app, 'ai.transcribe', 'Transcribe all handwritten and printed text in this picture verbatim, keeping line breaks and original spelling. Mark unreadable words as [illegible] and uncertain readings as [word?]. Answer with the transcription only.', { maxTokens: 4000 });
      if (r) await textResult(app, 'Transcription', r.text, { note: `${r.service}, ${r.ms} ms. [illegible] and [word?] mark uncertain readings.`, deliberation: delib(app, r), saveAs: { label: 'Save as caption', patch: (t) => ({ description: t }) }, extra: [{ label: 'Save as text file', onClick: (t) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([t], { type: 'text/plain' })); a.download = app.picture!.name.replace(/\.[^.]+$/, '') + '.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); } }] });
    },
  },
  {
    id: 'ai.identify', icon: 'search', noRecord: true, isEnabled: canText, tip: 'Plants, animals, landmarks, objects, artworks, with the confidence stated',
    run: async (app) => {
      const r = await ask(app, 'ai.identify', 'Identify what is in this picture as precisely as you can: species of plants or animals, landmarks and places, makes and models of objects, artworks and artists, typefaces or printed matter. For each, give the identification, the visual evidence, and how confident you are (high, medium, low). Say plainly when you cannot tell.');
      if (r) await textResult(app, 'Identification', r.text, { note: `${r.service}, ${r.ms} ms.`, deliberation: delib(app, r), saveAs: { label: 'Save as caption', patch: (t) => ({ description: t }) } });
    },
  },
  {
    id: 'ai.estimateDate', icon: 'event', noRecord: true, isEnabled: canText, tip: 'The era of an old photograph from clothing, process and print; clearly an estimate',
    run: async (app) => {
      const r = await ask(app, 'ai.estimateDate', 'Estimate when this photograph was taken. Consider the photographic process and print type (tintype, cabinet card, snapshot, color process), clothing and hair, vehicles, signage, technology, and anything else visible. Give a date range, the evidence for it, and what would narrow it down. Start with "Estimate:".');
      if (r) await textResult(app, 'Estimated Date (an estimate, not a fact)', r.text, { note: `${r.service}, ${r.ms} ms.`, deliberation: delib(app, r), saveAs: { label: 'Save as caption', patch: (t) => ({ description: t }) } });
    },
  },
  {
    id: 'ai.cullAssist', icon: 'checklist', noRecord: true, isEnabled: (app) => app.folder.length > 1, tip: 'Picks the sharpest frame in each burst on the device (a vision service checks for closed eyes when one is active); you confirm the flags',
    run: async (app) => {
      const { entries, marked } = inputsOf(app);
      if (entries.length < 2) { toast('Mark at least two pictures, or open a folder.'); return; }
      const result = await withJob(app, 'ai.cullAssist', async (status, signal) => {
        const infos = []; for (const e of entries) { infos.push(await entryInfo(app, e)); if (signal.aborted) return null; }
        const stacks = stackIds(infos, 3);
        const groups = new Map<string, Entry[]>();
        entries.forEach((e, i) => { const id = stacks.get(e.name) || `single-${i}`; const g = groups.get(id) || []; g.push(e); groups.set(id, g); });
        const bursts = [...groups.values()].filter((g) => g.length > 1);
        if (!bursts.length) return { bursts: [], picks: [] as { pick: Entry; burst: Entry[]; why: string }[] };
        const picks: { pick: Entry; burst: Entry[]; why: string }[] = [];
        let n = 0;
        for (const burst of bursts) {
          const scored: { e: Entry; sharp: number }[] = [];
          for (const e of burst) {
            status(`sharpness ${++n} of ${bursts.reduce((s, b) => s + b.length, 0)}`);
            try { const r = await entryRaster(app, e); const c = rasterCanvas(resample(r, Math.min(256, r.width), Math.min(256, Math.round(r.height * Math.min(256, r.width) / r.width)), 'lanczos3')); const q = quality(grayOf(c, c.width, c.height), c.width, c.height, null); scored.push({ e, sharp: q.sharpness }); } catch { /* skipped */ }
            if (signal.aborted) return null;
          }
          scored.sort((a, b) => b.sharp - a.sharp);
          let pick = scored[0], why = `sharpest of ${burst.length} (score ${Math.round(scored[0]?.sharp || 0)})`;
          if (hasText(app) && scored.length > 1) {
            status('checking eyes with the vision service…');
            const top = scored.slice(0, Math.min(3, scored.length));
            const rasters: Raster[] = []; for (const t of top) rasters.push(await entryRaster(app, t.e));
            const r = await askText(app, { command: 'ai.cullAssist', system: SYS, prompt: `These ${top.length} pictures are frames from one burst, in order. For each, say whether every visible person has open eyes and a natural expression, and which frame is best overall. Answer as JSON: {"frames": [{"index": 1, "eyesOpen": true, "note": "..."}], "best": 1}`, images: rasters, json: true, input: `${top.length} frames` }, status, signal);
            if (r) { try { const j = extractJson(r.text); const b = Math.max(1, Math.min(top.length, +j.best || 1)) - 1; pick = top[b]; why = `${j.frames?.[b]?.note || 'best by the vision service'}; sharpness rank ${b + 1}`; } catch { /* keep sharpness */ } }
          }
          if (pick) picks.push({ pick: pick.e, burst, why });
        }
        return { bursts, picks };
      });
      if (!result) return;
      if (!result.bursts.length) { toast(`No bursts found among ${entries.length} pictures (frames within 3 s of each other, by EXIF time).`); return; }
      const v = await openDialog({ title: 'Culling Assistant', ok: 'Flag the picks', wide: true, help: `${result.bursts.length} burst${result.bursts.length === 1 ? '' : 's'} among ${marked ? 'the marked pictures' : 'the folder'}. ${AI_NOTE}`, fields: [
        ...result.picks.map((p, i) => ({ key: `p${i}`, label: `${p.pick.name} — ${p.why} (burst of ${p.burst.length}: ${p.burst.map((e) => e.name).join(', ')})`, type: 'checkbox' as const, value: true })),
        { key: 'rest', label: 'Also flag the other frames of each burst as rejected', type: 'checkbox', value: false },
      ] });
      if (!v) return;
      let n = 0;
      for (let i = 0; i < result.picks.length; i++) {
        const p = result.picks[i]; if (!v[`p${i}`]) continue;
        await patchXmp(app, p.pick, { flag: 'pick' }); n++;
        if (v.rest) for (const e of p.burst) if (e !== p.pick) await patchXmp(app, e, { flag: 'reject' });
      }
      toast(`${n} pick${n === 1 ? '' : 's'} flagged.`); app.refresh(); app.tab.thumbs?.refilter();
    },
  },
  {
    id: 'ai.searchContent', icon: 'image_search', noRecord: true, popular: true, isEnabled: (app) => app.folder.length > 0, tip: 'On-device index (CLIP): "beach at sunset", "a kitchen with a wooden table"; results filter the thumbnails',
    run: async (app) => {
      const v = await openDialog({ title: 'Search by Content', ok: 'Search', help: 'Pictures and your words are compared in CLIP\'s shared space on this device; nothing is sent anywhere. The first search indexes the folder (a few seconds per hundred pictures).', fields: [
        { key: 'q', label: 'Describe what you are looking for', type: 'text', value: '', autofocus: true, placeholder: 'e.g. a dog on a beach' },
        { key: 'n', label: 'Show the best', type: 'number', min: 1, max: 500, value: 20, half: true },
        { key: 'min', label: 'Minimum match (0–100)', type: 'number', min: 0, max: 100, value: 20, half: true },
      ] });
      if (!v || !String(v.q).trim()) return;
      const hits = await semanticSearch(app, { text: String(v.q).trim() });
      if (!hits) return;
      showHits(app, hits.filter((x) => x.score * 100 >= +v.min).slice(0, +v.n), `Search: ${String(v.q).trim()}`);
    },
  },
  {
    id: 'ai.findSimilarSemantic', icon: 'image_search', noRecord: true, isEnabled: (app) => !!app.picture && app.folder.length > 1, tip: 'Pictures in the folder whose content resembles this one (CLIP on the device)',
    run: async (app) => {
      const hits = await semanticSearch(app, { raster: currentRaster(app) });
      if (!hits) return;
      showHits(app, hits.filter((x) => x.entry !== app.picture!.entry).slice(0, 30), `Similar to ${app.picture!.name}`);
    },
  },
  {
    id: 'ai.batch', icon: 'playlist_play', noRecord: true, isEnabled: (app) => app.folder.length > 0, tip: 'An AI command over the marked pictures (or the folder), with the count and the service\'s price page first',
    run: async (app) => {
      const { entries, marked } = inputsOf(app);
      const cmds = [['ai.altText', 'Alt Text (saved to each picture)'], ['ai.autoTag', 'Suggest Keywords (saved without review)'], ['ai.caption', 'Write Caption (archive style, saved)'], ['ai.describe', 'Describe (saved as caption)']];
      const svc = hasText(app) ? app.prefs.ai.services.find((s) => s.id === app.prefs.ai.textService) : null;
      if (!svc) { toast(needText(app)!); return; }
      const v = await openDialog({ title: 'Run on Selection', ok: 'Run', wide: true, fields: [
        { key: 'cmd', label: 'Command', type: 'select', options: cmds.map(([value, label]) => ({ value, label })), value: 'ai.altText' },
        info(`<p><b>${entries.length} picture${entries.length === 1 ? '' : 's'}</b> (${marked ? 'marked' : 'the whole folder'}) → <b>${esc(svc.name)}</b> (${esc(svc.textModel)}): ${entries.length} request${entries.length === 1 ? '' : 's'}, each with one downscaled picture (about ${Math.round(app.prefs.ai.privacy.maxEdge / 1024 * 800)} tokens of image input on most services) and a short prompt. The service's price page states the cost per token or request; this app cannot know it.</p>`),
        { key: 'cap', label: 'Stop after this many pictures (0 = no cap)', type: 'number', min: 0, max: 10000, value: 0, half: true },
        { key: 'skip', label: 'Skip pictures that already have the field', type: 'checkbox', value: true, half: true },
      ] });
      if (!v) return;
      const cap = +v.cap > 0 ? Math.min(entries.length, +v.cap) : entries.length;
      let done = 0, skipped = 0, failed = 0;
      await withJob(app, v.cmd, async (status, signal) => {
        for (let i = 0; i < cap; i++) {
          const e = entries[i]; if (signal.aborted) break;
          status(`${i + 1} of ${cap}: ${e.name}`);
          try {
            const meta = await readMeta(app, e); const x = meta?.props || {};
            if (v.skip && ((v.cmd === 'ai.altText' && x.altText) || (v.cmd === 'ai.autoTag' && x.keywords?.length) || ((v.cmd === 'ai.caption' || v.cmd === 'ai.describe') && x.description))) { skipped++; continue; }
            const r = await entryRaster(app, e);
            const prompt = v.cmd === 'ai.altText' ? 'Write alt text for this picture for screen-reader users (one sentence, at most 125 characters) and an extended description of two to four sentences. Answer as JSON: {"alt": "...", "extended": "..."}'
              : v.cmd === 'ai.autoTag' ? 'Suggest 8 to 15 cataloging keywords for this picture, lower-case, one or two words each. Answer as JSON: {"keywords": ["..."]}'
              : v.cmd === 'ai.caption' ? 'Write a factual archive caption of one to three sentences for this picture. Answer with the caption only.'
              : 'Describe this picture in two or three sentences. Answer with the description only.';
            const a = await askText(app, { command: v.cmd, system: SYS, prompt, images: [r], json: v.cmd === 'ai.altText' || v.cmd === 'ai.autoTag', input: e.name }, status, signal);
            if (!a) break;
            if (v.cmd === 'ai.altText') { const j = extractJson(a.text); await patchXmp(app, e, { altText: String(j.alt || '').trim(), extDescription: String(j.extended || '').trim() }); }
            else if (v.cmd === 'ai.autoTag') { const j = extractJson(a.text); const kws = (Array.isArray(j) ? j : j.keywords || []).map((k: any) => String(k).trim()).filter(Boolean); await patchXmp(app, e, { keywords: [...new Set([...(x.keywords || []), ...kws])] }); }
            else await patchXmp(app, e, { description: a.text.trim() });
            done++;
          } catch (err) { failed++; if (/Stopped/.test(String((err as Error).message))) break; }
        }
      });
      toast(`Run on Selection: ${done} done, ${skipped} skipped, ${failed} failed.`, { ms: 6000 });
      app.refresh();
    },
  },
]);

// Search by content -------------------------------------------------------------------------------

const embedCache = new Map<string, Float32Array>();
const keyOf = (e: Entry) => `${e.name}|${e.size || 0}|${e.mtime || 0}`;
let tokenizer: import('../ai/clipTokenizer').ClipTokenizer | null = null;

async function semanticSearch(app: App, q: { text?: string; raster?: Raster }): Promise<{ entry: Entry; score: number }[] | null> {
  return withJob(app, 'Search by Content', async (status, signal) => {
    const files = await ensureModel(app, 'clip-vit-b32', status, signal); if (!files) return null;
    const b = deviceBackend(app);
    const vision = async () => files[0], text = async () => files[1];
    let query: Float32Array;
    if (q.text) { tokenizer ??= await device.clipTokenizerFrom(files[2], files[3]); query = await device.clipText(b, text, tokenizer, q.text); }
    else query = await device.clipImage(b, vision, q.raster!);
    const entries = app.folder.entries; const out: { entry: Entry; score: number }[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]; if (signal.aborted) throw new Error('Stopped');
      let v = embedCache.get(keyOf(e));
      if (!v) { status(`indexing ${i + 1} of ${entries.length}`); try { v = await device.clipImage(b, vision, await entryRaster(app, e)); embedCache.set(keyOf(e), v); } catch { continue; } }
      out.push({ entry: e, score: device.cosine(query, v) });
    }
    out.sort((a, c) => c.score - a.score);
    return out;
  });
}
function showHits(app: App, hits: { entry: Entry; score: number }[], label: string): void {
  if (!hits.length) { toast('No matching pictures.'); return; }
  const set = new Set(hits.map((x) => x.entry));
  const t = app.tab.thumbs; if (t) { t.filter = (e) => set.has(e); t.filterLabel = label; t.refilter(); }
  const list = h('div', { class: 'qn-ai-chat' }, ...hits.map((x) => h('button', { class: 'qn-ai-card', type: 'button', onclick: () => { const i = app.folder.entries.indexOf(x.entry); if (i >= 0) app.folder.select(i); } }, `${x.entry.name} — ${Math.round(x.score * 100)}`)));
  openDialog({ title: label, content: list, ok: 'Close', cancel: false, help: `${hits.length} pictures; the thumbnail panel is filtered to them (Browse ▸ Filter clears it). Scores are CLIP similarities × 100.`, buttons: [{ label: 'Copy names', onClick: () => writeClipboardText(hits.map((x) => x.entry.name).join('\n')).then(() => toast('Copied.')) }] });
}
void has;
