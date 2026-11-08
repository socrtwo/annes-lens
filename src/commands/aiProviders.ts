/**
 * AI tab, Providers and Provenance groups: Set Up AI (wizard), Providers and Models, Active AI,
 * AI and Privacy, Several AIs, Choose AIs, Show AI Discussion, Stop AI, Delete Downloaded Models,
 * AI History, Content Credentials on AI Results, Prompt Library.
 */
import { def } from './registry';
import type { App } from '../app';
import { openDialog, confirmDialog, toast, type Field, type DialogControl } from '../ui/dialog';
import { h } from '../ui/dom';
import { aiBusy, aiStop, serviceById } from '../ai';
import { PRESETS, listModels, testService, hasImages } from '../ai/hosted';
import { MODELS, deleteModels, downloadedModels, runtimeStatus } from '../ai/device';
import { GEN_MODELS, deviceGenDownloaded, deleteDeviceGenCache, gpuAvailable } from '../ai/deviceGenerate';
import { readHistory, clearHistory } from '../ai/history';
import { keyBackend, setPassphrase, forgetStoredKeys } from '../ai/keystore';
import type { AiService } from '../ai/types';
import { info } from './aiShared';

const GROUPS: Record<string, string> = { computer: 'Free · your computer', free: 'Free tier', trial: 'Free trial', paid: 'Paid' };
const newId = () => 'svc-' + Math.random().toString(36).slice(2, 9);
const mb = (n: number) => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;

/** The service editor used by Set Up AI and Providers and Models. Returns the saved service or null. */
export async function serviceDialog(app: App, existing?: AiService): Promise<AiService | null> {
  const backend = await keyBackend();
  const presetOptions = PRESETS.map((p) => ({ value: p.id, label: `${GROUPS[p.group]} — ${p.name}` }));
  const presetOf = (id: string) => PRESETS.find((p) => p.id === id);
  const start = existing ? presetOf(existing.preset || '') : PRESETS.find((p) => p.id === 'ollama') || PRESETS[0];
  const notDevice = (v: Record<string, any>) => v.api !== 'device';
  const noteHtml = (id: string) => { const p = presetOf(id); if (!p) return ''; return `<p>${p.note || ''} ${p.keyUrl ? `<a href="${p.keyUrl}" target="_blank" rel="noopener">Get a key</a>` : 'No key needed.'}${p.priceUrl ? ` · <a href="${p.priceUrl}" target="_blank" rel="noopener">Prices and free tier</a>` : ''}</p>`; };
  let models: string[] = [];
  const fields: Field[] = [
    ...(existing ? [] : [info('<p>An AI service runs <b>on this device</b> (models you download, no account), <b>on your computer</b> (Ollama, LM Studio, any OpenAI-compatible server) or <b>hosted</b> (free tiers, trials, paid). Terms and prices change; the links go to the service\'s current pages. Nothing is sent to a service until you run an AI command.</p>')]),
    { key: 'preset', label: 'Service', type: 'select', options: presetOptions, value: start?.id || 'custom' },
    { key: 'note', type: 'info', html: noteHtml(start?.id || 'custom') },
    { key: 'name', label: 'Name', type: 'text', value: existing?.name || start?.name || '', half: true },
    { key: 'api', label: 'API dialect', type: 'select', options: [{ value: 'openai', label: 'OpenAI-compatible' }, { value: 'anthropic', label: 'Anthropic' }, { value: 'gemini', label: 'Google Gemini' }, { value: 'device', label: 'On this device (Transformers.js, pictures only)' }], value: existing?.api || start?.api || 'openai', half: true },
    { visibleIf: notDevice, key: 'baseUrl', label: 'Address', type: 'text', value: existing?.baseUrl || start?.baseUrl || '', placeholder: 'https://…/v1' },
    { visibleIf: notDevice, key: 'key', label: 'API key', type: 'password', value: existing?.key || '', help: `Kept in ${backend.label}; never in settings exports, macros or AI History; sent only to this address.` },
    { visibleIf: notDevice, key: 'textModel', label: 'Text and vision model', type: 'combo', options: [], value: existing?.textModel || start?.textModel || '', half: true },
    { visibleIf: notDevice, key: 'fetch', label: 'Fetch model list', type: 'button', half: true, onClick: async (v, ctl) => {
      try { models = await listModels({ id: 'tmp', name: v.name, api: v.api, baseUrl: v.baseUrl, key: v.key, textModel: '', imageModel: '' }); ctl.rebuild(fields.map((f) => f.key === 'textModel' || f.key === 'imageModel' ? { ...f, options: models, value: v[f.key] } : f.key === 'models' ? { ...f, html: `<p>${models.length} models listed by the service.</p>` } : { ...f, value: v[f.key] ?? f.value })); toast(`${models.length} models listed.`); }
      catch (e) { toast(`Could not list models: ${(e as Error).message}`, { ms: 8000 }); }
    } },
    { key: 'models', type: 'info', html: '', visibleIf: notDevice },
    { key: 'deviceNote', type: 'info', visibleIf: (v) => v.api === 'device', html: `<p><b>${GEN_MODELS[0].title}</b>, ${GEN_MODELS[0].params}, about ${(GEN_MODELS[0].bytes / 1e9).toFixed(1)} GB downloaded once into the browser's cache; pictures of ${GEN_MODELS[0].size} × ${GEN_MODELS[0].size}. ${gpuAvailable() ? 'WebGPU is available here.' : 'No WebGPU in this browser: it would run on WebAssembly, slowly; the desktop app or Chrome/Edge is recommended.'}</p><p><b>License:</b> ${GEN_MODELS[0].license} (<a href="${GEN_MODELS[0].licenseUrl}" target="_blank" rel="noopener">read it</a>). ${GEN_MODELS[0].licenseNote}</p>` },
    { visibleIf: notDevice, key: 'imageModel', label: 'Picture model (optional)', type: 'combo', options: [], value: existing?.imageModel || start?.imageModel || '', help: 'Generation and edits: OpenAI-compatible images endpoints (gpt-image-1, dall-e-3, FLUX on Together…) or a Gemini image model.' },
    { visibleIf: notDevice, key: 'test', label: 'Test the key and text model', type: 'button', onClick: async (v) => {
      try { toast(await testService({ id: 'tmp', name: v.name || 'Service', api: v.api, baseUrl: v.baseUrl, key: v.key, textModel: v.textModel, imageModel: '' }), { ms: 6000 }); }
      catch (e) { toast(`Test failed: ${(e as Error).message}`, { ms: 9000 }); }
    } },
  ];
  const r = await openDialog({ title: existing ? 'Edit AI Service' : 'Set Up AI', ok: 'Save', wide: true, fields, onChange: (v, ctl, key) => {
    if (key !== 'preset') return;
    const p = presetOf(v.preset); if (!p) return;
    ctl.set('name', p.name); ctl.set('api', p.api); ctl.set('baseUrl', p.baseUrl); ctl.set('textModel', p.textModel); ctl.set('imageModel', p.imageModel);
    ctl.rebuild(fields.map((f) => f.key === 'note' ? { ...f, html: noteHtml(p.id) } : { ...f, value: f.key === 'preset' ? v.preset : f.key in { name: 1, api: 1, baseUrl: 1, textModel: 1, imageModel: 1 } ? (p as any)[f.key] : v[f.key] ?? f.value }));
  }, validate: (v) => (v.api === 'device' ? null : !/^https?:\/\//i.test(String(v.baseUrl || '')) ? 'The address must start with http:// or https://' : !String(v.textModel || '').trim() && !String(v.imageModel || '').trim() ? 'Enter a text model or a picture model' : null) });
  if (!r) return null;
  if (r.api === 'device') { r.baseUrl = 'device://local'; r.key = ''; r.textModel = ''; r.imageModel = r.imageModel || GEN_MODELS[0].id; r.name = r.name || presetOf('device')!.name; }
  const svc: AiService = { id: existing?.id || newId(), name: String(r.name || presetOf(r.preset)?.name || 'Service').trim(), api: r.api, baseUrl: String(r.baseUrl).trim().replace(/\/+$/, ''), key: String(r.key || '').trim(), textModel: String(r.textModel || '').trim(), imageModel: String(r.imageModel || '').trim(), preset: r.preset };
  const list = app.prefs.ai.services;
  const i = list.findIndex((s) => s.id === svc.id);
  if (i >= 0) list[i] = svc; else list.push(svc);
  if (svc.textModel && !serviceById(app, app.prefs.ai.textService)?.textModel) app.prefs.ai.textService = svc.id;
  if (hasImages(svc) && !hasImages(serviceById(app, app.prefs.ai.imageService))) app.prefs.ai.imageService = svc.id;
  app.savePrefs(); app.refresh();
  toast(`${svc.name} saved${app.prefs.ai.textService === svc.id ? ' and made the active text service' : ''}.`);
  return svc;
}

async function providersDialog(app: App): Promise<void> {
  const rows = () => app.prefs.ai.services.map((s) => h('div', { class: 'qn-ai-model' },
    h('span', null, h('b', null, s.name), ` · ${s.api} · ${s.baseUrl}`, h('br'), h('span', { class: 'qn-ai-label' }, `text: ${s.textModel || '—'} · pictures: ${s.imageModel || '—'}${app.prefs.ai.textService === s.id ? ' · active for text' : ''}${app.prefs.ai.imageService === s.id ? ' · active for pictures' : ''}`)),
    h('span', null,
      h('button', { class: 'ql-btn', type: 'button', onclick: async () => { ctl?.close(); await serviceDialog(app, s); providersDialog(app); } }, 'Edit'),
      ' ', h('button', { class: 'ql-btn', type: 'button', onclick: async () => { try { toast(await testService(s), { ms: 6000 }); } catch (e) { toast(`Test failed: ${(e as Error).message}`, { ms: 9000 }); } } }, 'Test'),
      ' ', h('button', { class: 'ql-btn', type: 'button', onclick: async () => { if (!(await confirmDialog('Remove service?', `${s.name} and its key will be removed from this device.`, 'Remove'))) return; app.prefs.ai.services = app.prefs.ai.services.filter((x) => x.id !== s.id); if (app.prefs.ai.textService === s.id) app.prefs.ai.textService = ''; if (app.prefs.ai.imageService === s.id) app.prefs.ai.imageService = ''; app.savePrefs(); ctl?.close(); providersDialog(app); } }, 'Remove'))));
  const models = await downloadedModels();
  const genDown = await deviceGenDownloaded(GEN_MODELS[0]);
  const content = h('div', null,
    h('h3', null, 'Services'),
    ...(app.prefs.ai.services.length ? rows() : [h('p', { class: 'ql-help' }, 'No service yet. Add one, or use the on-device models below without any service.')]),
    h('h3', null, 'On-device models'),
    ...GEN_MODELS.map((m) => h('div', { class: 'qn-ai-model' }, h('span', null, h('b', null, m.title), ` · ${m.license} · about ${(m.bytes / 1e9).toFixed(1)} GB · picture generation (Transformers.js)`, h('br'), h('span', { class: 'qn-ai-label' }, genDown ? 'downloaded' : 'not downloaded; Set Up AI ▸ This device, then Generate Picture')))),
    ...MODELS.map((m) => { const d = models.find((x) => x.spec.id === m.id); return h('div', { class: 'qn-ai-model' }, h('span', null, h('b', null, m.title), ` · ${m.license} · ${mb(m.sizes.quantized)}${m.sizes.fp32 !== m.sizes.quantized ? ` (full ${mb(m.sizes.fp32)})` : ''}`, h('br'), h('span', { class: 'qn-ai-label' }, m.note)), h('span', { class: 'qn-ai-label' }, d ? `downloaded (${d.dtypes.join(', ')})` : 'not downloaded')); }),
    h('p', { class: 'ql-help' }, `Runtime: ONNX Runtime Web${runtimeStatus.loaded ? ` loaded (${runtimeStatus.provider})` : ' (loads with the first on-device command)'}; ${(navigator as any).gpu ? 'WebGPU available' : 'WebAssembly only (no WebGPU in this browser)'}.`));
  let ctl: DialogControl | null = null;
  await openDialog({ title: 'Providers and Models', content, ok: 'Close', cancel: false, wide: true, onOpen: (c) => { ctl = c; }, buttons: [{ label: 'Add service…', onClick: async (_v, c) => { c.close(); await serviceDialog(app); providersDialog(app); } }] });
}

def([
  { id: 'ai.setup', icon: 'auto_awesome', noRecord: true, popular: true, tip: 'Wizard: on device, your computer, free tier or paid; text and vision service, picture service', run: (app) => serviceDialog(app) },
  { id: 'ai.providers', icon: 'dns', noRecord: true, tip: 'Services and keys, model names, on-device models and the runtime', run: (app) => providersDialog(app) },
  {
    id: 'ai.active', icon: 'toggle_on', noRecord: true, tip: 'Which service answers text commands and which makes pictures; on-device first or service first',
    run: async (app) => {
      const text = app.prefs.ai.services.filter((s) => s.textModel), img = app.prefs.ai.services.filter((s) => hasImages(s));
      const r = await openDialog({ title: 'Active AI', ok: 'OK', fields: [
        { key: 'text', label: 'Text and vision', type: 'select', options: [{ value: '', label: 'None' }, ...text.map((s) => ({ value: s.id, label: `${s.name} — ${s.textModel}` }))], value: app.prefs.ai.textService },
        { key: 'image', label: 'Pictures', type: 'select', options: [{ value: '', label: 'None' }, ...img.map((s) => ({ value: s.id, label: `${s.name} — ${s.imageModel}` }))], value: app.prefs.ai.imageService },
        { key: 'prefer', label: 'When both can do it', type: 'select', options: [{ value: 'device', label: 'Run on this device first' }, { value: 'service', label: 'Use the service first' }], value: app.prefs.ai.prefer, half: true },
        { key: 'result', label: 'Edited results', type: 'select', options: [{ value: 'new', label: 'Open as a new picture' }, { value: 'replace', label: 'Replace the picture (undoable)' }], value: app.prefs.ai.result, half: true },
        { key: 'dtype', label: 'On-device model precision', type: 'select', options: [{ value: 'quantized', label: 'Quantized (smaller, faster)' }, { value: 'fp32', label: 'Full precision (larger)' }], value: app.prefs.ai.modelDtype, half: true },
      ], help: text.length || img.length ? undefined : 'No service is set up yet (AI ▸ Set Up AI). On-device commands work without one.' });
      if (!r) return;
      Object.assign(app.prefs.ai, { textService: r.text, imageService: r.image, prefer: r.prefer, result: r.result, modelDtype: r.dtype }); app.savePrefs(); app.refresh();
    },
  },
  {
    id: 'ai.privacy', icon: 'privacy_tip', noRecord: true, tip: 'What is sent, to whom, the size limit, the confirmation, keys on this device',
    run: async (app) => {
      const p = app.prefs.ai.privacy, backend = await keyBackend();
      const r = await openDialog({ title: 'AI and Privacy', ok: 'Save', wide: true, fields: [
        info(`<p><b>Nothing is sent anywhere until you run an AI command.</b> Commands that use a service send a metadata-free copy of the picture (no EXIF, GPS or XMP), downscaled to the limit below, plus the prompt. On-device models never send anything. Keys are kept in ${backend.label} and sent only to their service's address; they are never part of settings exports, macros or AI History. AI History keeps what was sent where (on this device).</p>`),
        ...(backend.kind === 'web' ? [{ key: 'pass', type: 'button' as const, label: backend.encrypted ? 'Change the passphrase…' : 'Encrypt the keys with a passphrase…', half: true, onClick: async () => { const q = await openDialog({ title: backend.encrypted ? 'Change the Passphrase' : 'Encrypt Your AI Keys', ok: 'Save', fields: [{ key: 'pw', label: 'Passphrase', type: 'password', value: '' }, { key: 'pw2', label: 'Again', type: 'password', value: '' }] }); if (!q || !q.pw) return; if (q.pw !== q.pw2) { toast('The two passphrases differ.'); return; } await setPassphrase(app.prefs.ai.services, String(q.pw)); toast('The keys are encrypted with the new passphrase.'); } }] : []),
        { key: 'forget', type: 'button' as const, label: 'Forget every stored key', half: true, onClick: async () => { if (!(await confirmDialog('Forget keys?', 'Every AI service key is removed from this device; the services stay, without keys.', 'Forget'))) return; for (const s of app.prefs.ai.services) s.key = ''; await forgetStoredKeys(); app.savePrefs(); toast('The keys are gone.'); } },
        { key: 'allowRemote', label: 'Allow services on the internet (off: only localhost and private addresses)', type: 'checkbox', value: p.allowRemote },
        { key: 'confirmSend', label: 'Ask before the first send in each session', type: 'checkbox', value: p.confirmSend },
        { key: 'maxEdge', label: 'Longest side of pictures sent (px)', type: 'number', min: 256, max: 8192, value: p.maxEdge, half: true },
        { key: 'credentials', label: 'Content Credentials on AI results (IPTC digital source type and provenance fields; a signed C2PA manifest when saved as JPEG or PNG)', type: 'checkbox', value: app.prefs.ai.credentials },
        { key: 'historyMax', label: 'AI History entries kept', type: 'number', min: 0, max: 2000, value: app.prefs.ai.historyMax, half: true },
      ] });
      if (!r) return;
      app.prefs.ai.privacy = { allowRemote: !!r.allowRemote, confirmSend: !!r.confirmSend, maxEdge: Math.max(256, Math.min(8192, Math.round(+r.maxEdge || 1536))) };
      app.prefs.ai.credentials = !!r.credentials; app.prefs.ai.historyMax = Math.max(0, Math.round(+r.historyMax || 0)); app.savePrefs();
    },
  },
  {
    id: 'ai.ensembleMode', icon: 'groups', kind: 'menu', noRecord: true, isActive: (app) => app.prefs.ai.ensemble.mode !== 'single', tip: 'Single, Master Combines Answers, Quaker Consensus (text commands)',
    menu: (app) => [['single', 'Single'], ['master', 'Master Combines Answers'], ['quaker', 'Quaker Consensus']].map(([id, label]) => ({ id, arg: id, label, checked: app.prefs.ai.ensemble.mode === id })),
    run: async (app, arg?: string) => {
      const mode = (arg || (app.prefs.ai.ensemble.mode === 'single' ? 'master' : 'single')) as 'single' | 'master' | 'quaker';
      if (mode !== 'single' && app.prefs.ai.ensemble.members.length < 2) { toast('Choose at least two services first (AI ▸ Choose AIs…).'); await app.exec('ai.ensembleMembers'); if (app.prefs.ai.ensemble.members.length < 2) return; }
      app.prefs.ai.ensemble.mode = mode; app.savePrefs(); app.refresh();
      toast(mode === 'single' ? 'One service answers.' : mode === 'master' ? 'Every chosen service answers; the master combines.' : 'The chosen services seek consensus.');
    },
  },
  {
    id: 'ai.ensembleMembers', icon: 'group_add', noRecord: true, tip: 'The services that take part when Several AIs is on, and the master',
    run: async (app) => {
      const text = app.prefs.ai.services.filter((s) => s.textModel);
      if (text.length < 2) { toast('Several AIs needs at least two services with a text model (AI ▸ Set Up AI).'); return; }
      const e = app.prefs.ai.ensemble;
      const r = await openDialog({ title: 'Choose AIs', ok: 'OK', fields: [
        ...text.map((s) => ({ key: `m_${s.id}`, label: `${s.name} — ${s.textModel}`, type: 'checkbox' as const, value: e.members.includes(s.id) })),
        { key: 'master', label: 'Master (combines the answers)', type: 'select', options: text.map((s) => ({ value: s.id, label: s.name })), value: text.find((s) => s.id === e.master)?.id || app.prefs.ai.textService || text[0].id },
        { key: 'show', label: 'Show the AI discussion with every result', type: 'checkbox', value: e.showDeliberation },
      ] });
      if (!r) return;
      e.members = text.filter((s) => r[`m_${s.id}`]).map((s) => s.id); e.master = r.master; e.showDeliberation = !!r.show;
      if (e.members.length < 2 && e.mode !== 'single') { e.mode = 'single'; toast('Fewer than two services chosen: back to Single.'); }
      app.savePrefs(); app.refresh();
    },
  },
  { id: 'ai.showDeliberation', icon: 'forum', kind: 'toggle', noRecord: true, isActive: (app) => app.prefs.ai.ensemble.showDeliberation, tip: 'Shows every draft and revision when several AIs answer', run: (app) => { app.prefs.ai.ensemble.showDeliberation = !app.prefs.ai.ensemble.showDeliberation; app.savePrefs(); app.refresh(); toast(app.prefs.ai.ensemble.showDeliberation ? 'AI discussion shown with results.' : 'AI discussion hidden.'); } },
  { id: 'ai.stop', icon: 'stop_circle', noRecord: true, isEnabled: () => aiBusy(), tip: 'Stops the running AI command', run: () => { if (!aiStop()) toast('No AI command is running.'); } },
  {
    id: 'ai.deleteModels', icon: 'delete_sweep', noRecord: true, tip: 'Removes every downloaded on-device model from the browser cache',
    run: async (app) => {
      const d = await downloadedModels(), gen = await deviceGenDownloaded(GEN_MODELS[0]);
      if (!d.length && !gen) { toast('No models are downloaded.'); return; }
      const names = [...d.map((x) => `${x.spec.title} (${mb(x.bytes)})`), ...(gen ? [`${GEN_MODELS[0].title} (about ${(GEN_MODELS[0].bytes / 1e9).toFixed(1)} GB)`] : [])];
      if (!(await confirmDialog('Delete downloaded models?', `${names.join(', ')} — they download again when a command needs them.`, 'Delete'))) return;
      await deleteModels(); await deleteDeviceGenCache(); toast('Downloaded models deleted.'); app.refresh();
    },
  },
  {
    id: 'ai.history', icon: 'history', noRecord: true, tip: 'What was sent, to which service, the prompt and the result',
    run: async (app) => {
      const entries = readHistory();
      const content = h('div', { class: 'qn-ai-chat' }, ...(entries.length ? entries.map((e) => h('div', { class: 'qn-ai-msg assistant' }, h('div', { class: 'qn-ai-label' }, `${e.time.replace('T', ' ').slice(0, 19)} · ${e.command} · ${e.service}${e.model ? ` (${e.model})` : ''} · ${e.ms} ms${e.input ? ` · ${e.input}` : ''}`), e.prompt ? h('div', null, h('b', null, 'Prompt: '), e.prompt) : '', h('div', null, e.result))) : [h('p', { class: 'ql-help' }, 'Nothing yet. Every AI command records what it sent and received here (on this device).')]));
      await openDialog({ title: 'AI History', content, ok: 'Close', cancel: false, wide: true, buttons: entries.length ? [{ label: 'Clear', onClick: async (_v, ctl) => { if (await confirmDialog('Clear AI History?', 'Every entry is removed from this device.', 'Clear')) { clearHistory(); ctl.close(); } } }] : [] });
      void app;
    },
  },
  { id: 'ai.contentCredentials', icon: 'verified', kind: 'toggle', noRecord: true, isActive: (app) => app.prefs.ai.credentials, tip: 'On by default: IPTC digital source type and provenance fields (command, service, model, prompt, date) on generated and AI-edited pictures, and a C2PA manifest signed with this device\'s own certificate when they are saved as JPEG or PNG', run: (app) => { app.prefs.ai.credentials = !app.prefs.ai.credentials; app.savePrefs(); app.refresh(); toast(app.prefs.ai.credentials ? 'AI results carry provenance metadata.' : 'AI results carry no provenance metadata.'); } },
  {
    id: 'ai.promptLibrary', icon: 'collections_bookmark', noRecord: true, tip: 'Saved prompts for Generate and Edit by Instruction (shared format with the sister apps: name, prompt, negative, kind)',
    run: async (app) => {
      const lib = app.prefs.ai.prompts;
      const r = await openDialog({ title: 'Prompt Library', ok: 'Close', cancel: false, wide: true, fields: [
        { key: 'list', label: 'Saved prompts', type: 'select', options: [{ value: '', label: lib.length ? 'Choose a prompt' : 'No saved prompts yet' }, ...lib.map((p, i) => ({ value: String(i), label: `${p.kind === 'edit' ? '[edit] ' : ''}${p.name}` }))], value: '' },
        { key: 'name', label: 'Name', type: 'text', value: '', half: true },
        { key: 'kind', label: 'Kind', type: 'select', options: [{ value: 'generate', label: 'Generate' }, { value: 'edit', label: 'Edit by instruction' }], value: 'generate', half: true },
        { key: 'prompt', label: 'Prompt', type: 'textarea', rows: 3, value: '' },
        { key: 'negative', label: 'Avoid (negative prompt)', type: 'text', value: '' },
        { key: 'save', label: 'Save or update', type: 'button', half: true, onClick: (v, ctl) => { const name = String(v.name || '').trim(), prompt = String(v.prompt || '').trim(); if (!name || !prompt) { toast('Enter a name and a prompt.'); return; } const i = lib.findIndex((p) => p.name === name); const entry = { name, prompt, negative: String(v.negative || ''), kind: v.kind }; if (i >= 0) lib[i] = entry; else lib.push(entry); app.savePrefs(); toast(`"${name}" saved.`); ctl.close(); app.exec('ai.promptLibrary'); } },
        { key: 'del', label: 'Delete', type: 'button', half: true, onClick: (v, ctl) => { const i = +v.list; if (!(i >= 0)) { toast('Choose a prompt first.'); return; } lib.splice(i, 1); app.savePrefs(); ctl.close(); app.exec('ai.promptLibrary'); } },
        { key: 'use', label: 'Use in Generate Picture…', type: 'button', onClick: (v, ctl) => { const p = lib[+v.list]; if (!p) { toast('Choose a prompt first.'); return; } ctl.close(); app.exec(p.kind === 'edit' ? 'ai.editInstruction' : 'ai.generate', { prompt: p.prompt, negative: p.negative }); } },
      ], onChange: (v, ctl, key) => { if (key !== 'list') return; const p = lib[+v.list]; if (!p) return; ctl.set('name', p.name); ctl.set('kind', p.kind); ctl.set('prompt', p.prompt); ctl.set('negative', p.negative); } });
      void r;
    },
  },
]);
