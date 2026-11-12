/** Customize dialogs: Quick Access Bar, Tabs (ribbon), Menus (classic layouts), Keyboard. Every command in the registry is available. */
import type { App } from '../app';
import { allCommands, getCommand, type Command } from '../commands/registry';
import { DEFAULT_QAT, addAllQatChoices, type CustomTab } from '../prefs';
import { DEFAULT_TABS, idsInTabs, tabsFor } from './ribbonLayout';
import { h, icon, clear } from './dom';
import { openDialog, toast, promptDialog, confirmDialog } from './dialog';
import { prettyKey, canonicalKey, keyName } from '../util/keys';
import { CLASSIC_MENUS, CLASSIC_LAYOUT_NAMES, DEFAULT_LAYOUT, installCustomMenus } from './classicMenus';
import { keyCommands, removeKey, resetCommand, removedFrom } from '../util/keymap';

export function categories(app: App): { id: string; label: string; list: () => Command[] }[] {
  const all = () => allCommands().sort((a, b) => a.label.localeCompare(b.label));
  const tabNames = [...new Set(allCommands().map((c) => c.tab))];
  const contextual = ['Pages and Frames', 'RAW', 'Picture Tools'];
  const label = (t: string) => (contextual.includes(t) ? `${t} (contextual) Tab` : `${t} Tab`);
  const order = ['File', 'Home', 'Edit', 'Image', 'Adjust', 'Effects', 'Browse', 'Metadata', 'Batch', 'Create', 'View', 'Slideshow', 'Tools', 'AI', 'Developer', 'Help', ...contextual];
  const inTabs = idsInTabs();
  return [
    { id: 'popular', label: 'Popular Commands', list: () => all().filter((c) => c.popular) },
    { id: 'notInTabs', label: 'Commands Not in the Tabs', list: () => all().filter((c) => !inTabs.has(c.id)) },
    { id: 'all', label: `All Commands (${allCommands().length})`, list: all },
    ...tabNames.sort((a, b) => (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 99 : order.indexOf(b))).map((t) => ({ id: 'tab:' + t, label: label(t), list: () => all().filter((c) => c.tab === t) })),
    { id: 'macros', label: 'Macros', list: () => app.prefs.macros.map((m) => getCommand(`macro:${m.name}`)!).filter(Boolean) },
    ...app.prefs.customTabs.map((t) => ({ id: 'custom:' + t.id, label: `Custom tab: ${t.label}`, list: () => t.groups.flatMap((g) => g.items).map((id) => getCommand(id)!).filter(Boolean) })),
  ];
}

function commandList(cmds: (Command | '|')[], selected: number, onSelect: (i: number) => void, onDbl?: (i: number) => void): HTMLElement {
  const box = h('div', { class: 'ql-cmdlist', role: 'listbox', tabindex: '0' });
  cmds.forEach((c, i) => {
    const row = c === '|' ? h('div', { class: 'ql-cmdlist-row ql-sep-row' + (i === selected ? ' ql-sel' : ''), role: 'option' }, h('span', { class: 'ql-icon-space' }), '<Separator>')
      : h('div', { class: 'ql-cmdlist-row' + (i === selected ? ' ql-sel' : ''), role: 'option', title: `${c.label} — ${c.id}` }, icon(c.icon), h('span', null, c.label), c.kind === 'menu' || c.kind === 'split' ? h('span', { class: 'ql-help' }, ' ▸') : null);
    row.addEventListener('click', () => onSelect(i));
    if (onDbl) row.addEventListener('dblclick', () => onDbl(i));
    box.appendChild(row);
  });
  return box;
}

/** A button of the middle toolbar: icon plus a label that stays visible on phones (wrapping onto more rows). */
function midButton(label: string, ic: string, fn: () => void, tip = label): HTMLElement {
  return h('button', { class: 'ql-btn ql-cust-btn', type: 'button', onclick: fn, title: tip, 'aria-label': label }, icon(ic), h('span', { class: 'ql-cust-btn-label' }, label));
}

/** Empties the columns before a redraw and puts their list boxes back where they were scrolled. */
function clearKeepingScroll(...cols: HTMLElement[]): void {
  const tops = cols.map((c) => [...c.querySelectorAll<HTMLElement>('.ql-cmdlist')].map((l) => l.scrollTop));
  for (const c of cols) clear(c);
  queueMicrotask(() => cols.forEach((c, j) => c.querySelectorAll<HTMLElement>('.ql-cmdlist').forEach((l, i) => {
    if (tops[j][i]) l.scrollTop = tops[j][i];
    const row = l.querySelector<HTMLElement>('.ql-sel');
    if (!row) return;
    const lr = l.getBoundingClientRect(), rr = row.getBoundingClientRect();
    if (rr.top < lr.top) l.scrollTop -= lr.top - rr.top;
    else if (rr.bottom > lr.bottom) l.scrollTop += rr.bottom - lr.bottom;
  })));
}

export async function customizeQat(app: App): Promise<void> {
  const cats = categories(app);
  let cat = cats[0];
  let filter = '';
  let leftSel = 0, rightSel = -1;
  let qat = [...app.prefs.qat];
  const root = h('div', { class: 'ql-customize' });
  const left = h('div', { class: 'ql-cust-col' });
  const right = h('div', { class: 'ql-cust-col' });
  const mid = h('div', { class: 'ql-cust-mid' });
  const leftItems = () => cat.list().filter((c) => !filter || `${c.label} ${c.id} ${c.keywords || ''}`.toLowerCase().includes(filter));
  const qatItems = (): (Command | '|')[] => qat.map((id) => (id === '|' ? '|' : getCommand(id) || null)).filter(Boolean) as (Command | '|')[];
  const add = () => { const c = leftItems()[leftSel]; if (!c) return; const at = rightSel >= 0 ? rightSel + 1 : qat.length; qat.splice(at, 0, c.id); rightSel = at; draw(); };
  const remove = () => { if (rightSel < 0) return; qat.splice(rightSel, 1); rightSel = Math.min(rightSel, qat.length - 1); draw(); };
  const move = (d: number) => { const j = rightSel + d; if (rightSel < 0 || j < 0 || j >= qat.length) return; [qat[rightSel], qat[j]] = [qat[j], qat[rightSel]]; rightSel = j; draw(); };
  const catSel = h('select', { 'aria-label': 'Choose commands from' }, ...cats.map((c) => h('option', { value: c.id }, c.label))) as HTMLSelectElement;
  catSel.addEventListener('change', () => { cat = cats.find((c) => c.id === catSel.value) || cats[0]; leftSel = 0; draw(); });
  const search = h('input', { placeholder: 'Filter commands…', 'aria-label': 'Filter commands' }) as HTMLInputElement;
  search.addEventListener('input', () => { filter = search.value.toLowerCase(); leftSel = 0; draw(); });
  const count = h('div', { class: 'ql-help' });
  const draw = () => {
    clearKeepingScroll(left, right);
    const items = leftItems();
    count.textContent = `${items.length} command(s)`;
    left.append(h('label', { class: 'ql-label' }, 'Choose commands from:'), catSel, search, count, commandList(items, leftSel, (i) => { leftSel = i; draw(); }, (i) => { leftSel = i; add(); }));
    right.append(h('label', { class: 'ql-label' }, 'Quick Access Bar:'), commandList(qatItems(), rightSel, (i) => { rightSel = i; draw(); }, (i) => { rightSel = i; remove(); }));
  };
  mid.append(midButton('Add', 'arrow_forward', add), midButton('Remove', 'arrow_back', remove), midButton('Up', 'arrow_upward', () => move(-1)), midButton('Down', 'arrow_downward', () => move(1)),
    midButton('Separator', 'more_vert', () => { const at = rightSel >= 0 ? rightSel + 1 : qat.length; qat.splice(at, 0, '|'); rightSel = at; draw(); }),
    midButton('Add All A–Z', 'sort_by_alpha', () => { qat = addAllQatChoices(qat, (id) => getCommand(id)?.label); rightSel = -1; draw(); }, 'Add every Quick Access Bar choice: Save and Print first, then the rest A to Z'),
    midButton('Reset', 'restart_alt', () => { qat = [...DEFAULT_QAT]; rightSel = -1; draw(); }, 'Reset to the default Quick Access Bar'));
  root.append(left, mid, right);
  draw();
  const r = await openDialog({
    title: 'Customize the Quick Access Bar', full: true, content: root,
    fields: [
      { key: 'bottom', label: 'Show the Quick Access Bar at the bottom (near the keyboard)', type: 'checkbox', value: app.prefs.qatPosition === 'bottom' },
      { key: 'labels', label: 'Show command labels', type: 'checkbox', value: app.prefs.qatLabels },
    ],
    buttons: [
      { label: 'Export…', onClick: () => { navigator.clipboard?.writeText(JSON.stringify({ qat })); toast('Quick Access Bar layout copied to clipboard'); } },
      { label: 'Import…', onClick: async () => { const t = await promptDialog('Import', 'Paste a Quick Access Bar layout:', ''); if (!t) return; try { const j = JSON.parse(t); if (Array.isArray(j.qat)) { qat = j.qat.filter((x: unknown) => typeof x === 'string'); draw(); } } catch { toast('Invalid layout.'); } } },
    ],
  });
  if (!r) return;
  app.prefs.qat = qat;
  app.prefs.qatPosition = r.bottom ? 'bottom' : app.prefs.qatPosition === 'bottom' ? 'top' : app.prefs.qatPosition;
  app.prefs.qatLabels = r.labels;
  app.savePrefs();
  app.ui.applyPrefs();
  app.ui.rebuild();
}

export async function customizeRibbon(app: App): Promise<void> {
  const cats = categories(app);
  let cat = cats[0];
  let filter = '';
  let leftSel = 0;
  const customTabs: CustomTab[] = JSON.parse(JSON.stringify(app.prefs.customTabs));
  const hidden = new Set(app.prefs.hiddenTabs);
  let order = tabsFor(app).map((t) => t.id).concat(DEFAULT_TABS.filter((t) => hidden.has(t.id)).map((t) => t.id));
  for (const t of customTabs) if (!order.includes(t.id)) order.push(t.id);
  let selTab = customTabs[0]?.id || order[0];
  let selGroup = 0, selItem = -1;
  const root = h('div', { class: 'ql-customize' });
  const left = h('div', { class: 'ql-cust-col' }), mid = h('div', { class: 'ql-cust-mid' }), right = h('div', { class: 'ql-cust-col' });
  const leftItems = () => cat.list().filter((c) => !filter || `${c.label} ${c.id}`.toLowerCase().includes(filter));
  const labelOf = (id: string) => customTabs.find((t) => t.id === id)?.label || DEFAULT_TABS.find((t) => t.id === id)?.label || id;
  const isCustom = (id: string) => customTabs.some((t) => t.id === id);
  const curTab = () => customTabs.find((t) => t.id === selTab);
  const ensureCustom = () => {
    if (curTab()) return curTab()!;
    const base = DEFAULT_TABS.find((t) => t.id === selTab)!;
    const copy: CustomTab = { id: `custom-${base.id}-${Date.now().toString(36)}`, label: base.label + ' (Custom)', groups: base.groups.map((g) => ({ id: g.id, label: g.label, items: [...g.items] })) };
    customTabs.push(copy);
    hidden.add(base.id);
    order.splice(order.indexOf(base.id) + 1, 0, copy.id);
    selTab = copy.id;
    toast(`Created an editable copy of ${base.label}; the original is hidden.`);
    return copy;
  };
  const catSel = h('select', null, ...cats.map((c) => h('option', { value: c.id }, c.label))) as HTMLSelectElement;
  catSel.addEventListener('change', () => { cat = cats.find((c) => c.id === catSel.value) || cats[0]; leftSel = 0; draw(); });
  const search = h('input', { placeholder: 'Filter commands…' }) as HTMLInputElement;
  search.addEventListener('input', () => { filter = search.value.toLowerCase(); leftSel = 0; draw(); });
  const draw = () => {
    clearKeepingScroll(left, right);
    left.append(h('label', { class: 'ql-label' }, 'Choose commands from:'), catSel, search, commandList(leftItems(), leftSel, (i) => { leftSel = i; draw(); }, (i) => { leftSel = i; addCmd(); }));
    const tabList = h('div', { class: 'ql-cmdlist' });
    for (const id of order) {
      const row = h('div', { class: 'ql-cmdlist-row' + (id === selTab ? ' ql-sel' : '') },
        h('input', { type: 'checkbox', checked: !hidden.has(id) && !(customTabs.find((t) => t.id === id)?.hidden), title: 'Show tab', onclick: (e: Event) => { e.stopPropagation(); const ct = customTabs.find((t) => t.id === id); if (ct) ct.hidden = !(e.target as HTMLInputElement).checked; else if ((e.target as HTMLInputElement).checked) hidden.delete(id); else hidden.add(id); } }),
        h('span', null, labelOf(id)));
      row.addEventListener('click', () => { selTab = id; selGroup = 0; selItem = -1; draw(); });
      tabList.appendChild(row);
    }
    right.append(h('label', { class: 'ql-label' }, 'Tabs (check to show):'), tabList);
    const t = curTab() || DEFAULT_TABS.find((x) => x.id === selTab);
    if (t) {
      const groups = h('div', { class: 'ql-cmdlist ql-groups' });
      t.groups.forEach((g, gi) => {
        groups.appendChild(h('div', { class: 'ql-cmdlist-row ql-group-row' + (gi === selGroup && selItem < 0 ? ' ql-sel' : ''), onclick: () => { selGroup = gi; selItem = -1; draw(); } }, icon('folder'), h('b', null, g.label)));
        g.items.forEach((id, ii) => {
          const c = getCommand(id);
          groups.appendChild(h('div', { class: 'ql-cmdlist-row ql-item-row' + (gi === selGroup && ii === selItem ? ' ql-sel' : '') + (c ? '' : ' ql-dim'), onclick: () => { selGroup = gi; selItem = ii; draw(); } }, icon(c?.icon), c?.label || id, c ? null : h('span', { class: 'ql-help' }, ' (planned)')));
        });
      });
      right.append(h('label', { class: 'ql-label' }, `Groups in "${labelOf(selTab)}"${isCustom(selTab) ? '' : ' (built-in: editing makes a copy)'}:`), groups);
    }
  };
  const addCmd = () => { const c = leftItems()[leftSel]; if (!c) return; const t = ensureCustom(); if (!t.groups.length) t.groups.push({ id: 'g1', label: 'New Group', items: [] }); const g = t.groups[Math.min(selGroup, t.groups.length - 1)]; g.items.splice(selItem >= 0 ? selItem + 1 : g.items.length, 0, c.id); selItem = selItem >= 0 ? selItem + 1 : g.items.length - 1; draw(); };
  const removeSel = () => { const t = ensureCustom(); const g = t.groups[selGroup]; if (!g) return; if (selItem >= 0) { g.items.splice(selItem, 1); selItem = Math.min(selItem, g.items.length - 1); } else { t.groups.splice(selGroup, 1); selGroup = 0; } draw(); };
  const moveSel = (d: number) => {
    if (selItem < 0) { const oi = order.indexOf(selTab); const j = oi + d; if (j >= 0 && j < order.length) { [order[oi], order[j]] = [order[j], order[oi]]; draw(); } return; }
    const t = ensureCustom(); const g = t.groups[selGroup]; const j = selItem + d; if (j < 0 || j >= g.items.length) return; [g.items[selItem], g.items[j]] = [g.items[j], g.items[selItem]]; selItem = j; draw();
  };
  const b = midButton;
  mid.append(
    b('Add', 'arrow_forward', addCmd), b('Remove', 'arrow_back', removeSel), b('Up', 'arrow_upward', () => moveSel(-1)), b('Down', 'arrow_downward', () => moveSel(1)),
    b('New Tab', 'tab', async () => { const n = await promptDialog('New Tab', 'Tab name:', 'My Tab'); if (!n) return; const t: CustomTab = { id: `custom-${Date.now().toString(36)}`, label: n, groups: [{ id: 'g1', label: 'New Group', items: [] }] }; customTabs.push(t); order.push(t.id); selTab = t.id; selGroup = 0; selItem = -1; draw(); }),
    b('New Group', 'create_new_folder', async () => { const t = ensureCustom(); const n = await promptDialog('New Group', 'Group name:', 'New Group'); if (!n) return; t.groups.push({ id: `g${Date.now().toString(36)}`, label: n, items: [] }); selGroup = t.groups.length - 1; selItem = -1; draw(); }),
    b('Rename', 'edit', async () => { const t = ensureCustom(); if (selItem < 0 && t.groups[selGroup]) { const n = await promptDialog('Rename Group', 'Name:', t.groups[selGroup].label); if (n) t.groups[selGroup].label = n; } else { const n = await promptDialog('Rename Tab', 'Name:', t.label); if (n) t.label = n; } draw(); }),
    b('Delete Tab', 'delete', async () => { const t = curTab(); if (!t) { toast('Built-in tabs can be hidden (uncheck) but not deleted.'); return; } if (await confirmDialog('Delete Tab', `Delete "${t.label}"?`)) { customTabs.splice(customTabs.indexOf(t), 1); order = order.filter((x) => x !== t.id); selTab = order[0]; draw(); } }),
    b('Reset All', 'restart_alt', async () => { if (await confirmDialog('Reset', 'Remove all custom tabs and show all built-in tabs?')) { customTabs.splice(0); hidden.clear(); order = DEFAULT_TABS.map((t) => t.id); selTab = order[0]; draw(); } }),
  );
  root.append(left, mid, right);
  draw();
  const r = await openDialog({ title: 'Customize Tabs (Ribbon)', full: true, content: root, help: 'Add any command to your own tabs and groups. Reorder or hide built-in tabs. Contextual tabs (Pages and Frames, RAW) appear automatically. Commands marked "planned" are in the plan but not built yet.' });
  if (!r) return;
  app.prefs.customTabs = customTabs;
  app.prefs.hiddenTabs = [...hidden];
  app.prefs.tabOrder = order;
  app.savePrefs();
  app.ui.rebuild();
}

export async function customizeKeyboard(app: App, initialId?: string): Promise<void> {
  const cats = categories(app);
  let cat = cats.find((c) => c.id === 'all')!;
  let filter = '';
  let sel = 0;
  let pending: string | null = null;
  const keymap = { ...app.prefs.keymap };
  const root = h('div', { class: 'ql-customize ql-cust-keys' });
  const left = h('div', { class: 'ql-cust-col' }), right = h('div', { class: 'ql-cust-col' });
  const catSel = h('select', null, ...cats.map((c) => h('option', { value: c.id, selected: c === cat }, c.label))) as HTMLSelectElement;
  catSel.addEventListener('change', () => { cat = cats.find((c) => c.id === catSel.value) || cats[0]; sel = 0; draw(); });
  const search = h('input', { placeholder: 'Filter commands…' }) as HTMLInputElement;
  search.addEventListener('input', () => { filter = search.value.toLowerCase(); sel = 0; draw(); });
  const items = () => cat.list().filter((c) => !filter || `${c.label} ${c.id}`.toLowerCase().includes(filter));
  if (initialId) { const i = items().findIndex((c) => c.id === initialId); if (i >= 0) sel = i; }
  const keysFor = (id: string) => {
    const c = getCommand(id);
    const base = (c?.keys || []).map(canonicalKey).filter((k) => keymap[k] === undefined || keymap[k] === id || (removedFrom(keymap[k]) && !removedFrom(keymap[k])!.has(id)));
    const custom = Object.entries(keymap).filter(([, v]) => v === id).map(([k]) => k);
    return [...new Set([...base, ...custom])].filter((k) => keymap[k] !== '');
  };
  const ownerOf = (k: string): string | null => {
    const defaults = allCommands().filter((x) => (x.keys || []).map(canonicalKey).includes(k)).map((x) => x.id);
    return keyCommands(k, defaults, keymap)[0] || null;
  };
  const capture = h('input', { class: 'ql-key-capture', placeholder: 'Press new shortcut key…', readonly: true, 'data-capture-keys': true, 'aria-label': 'Press new shortcut key' }) as HTMLInputElement;
  const owner = h('div', { class: 'ql-help', role: 'status' });
  capture.addEventListener('keydown', (e) => {
    const k = keyName(e);
    if (!k || k === 'Tab' || k === 'Shift-Tab' || k === 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    pending = canonicalKey(k);
    capture.value = prettyKey(pending);
    const o = ownerOf(pending);
    owner.textContent = o ? `Currently assigned to: ${getCommand(o)?.label || o}` : 'Currently unassigned';
  });
  const draw = () => {
    clearKeepingScroll(left, right);
    const list = items();
    left.append(h('label', { class: 'ql-label' }, 'Categories:'), catSel, search, commandList(list, sel, (i) => { sel = i; pending = null; capture.value = ''; owner.textContent = ''; draw(); }));
    const c = list[sel];
    if (!c) return;
    const current = keysFor(c.id);
    right.append(h('h3', null, c.label), h('p', { class: 'ql-help' }, c.id + (c.tip ? ` — ${c.tip}` : '')),
      h('label', { class: 'ql-label' }, 'Current keys:'),
      h('div', { class: 'ql-cmdlist' }, ...(current.length ? current.map((k) => h('div', { class: 'ql-cmdlist-row' }, h('kbd', null, prettyKey(k)), h('button', { class: 'ql-iconbtn ql-sm', title: 'Remove', onclick: () => { removeKey(keymap, k, c.id, (c.keys || []).map(canonicalKey).includes(k)); draw(); } }, icon('close')))) : [h('div', { class: 'ql-help' }, '(none)')])),
      h('label', { class: 'ql-label' }, 'Press new shortcut key:'), capture, owner,
      h('div', { class: 'ql-row' },
        h('button', { class: 'ql-btn ql-primary', type: 'button', onclick: () => { if (!pending) { toast('Tap the box and press a key combination.'); return; } keymap[pending] = c.id; pending = null; capture.value = ''; owner.textContent = ''; draw(); } }, 'Assign'),
        h('button', { class: 'ql-btn', type: 'button', onclick: () => { resetCommand(keymap, c.id, (c.keys || []).map(canonicalKey)); draw(); } }, 'Reset Command')));
  };
  root.append(left, right);
  draw();
  const r = await openDialog({ title: 'Customize Keyboard', full: true, content: root, help: 'Single letters follow IrfanView (O open, S save as, T thumbnails, I information, L and R rotate…). File ▸ Export / Import Settings reads an IrfanView-style key list.', buttons: [{ label: 'Reset All', onClick: () => { for (const k of Object.keys(keymap)) delete keymap[k]; draw(); } }] });
  if (!r) return;
  app.prefs.keymap = keymap;
  app.savePrefs();
  app.ui.rebuild();
}

/**
 * Customize Menus: edit any classic menu layout (a built-in one is copied first) or start one of your
 * own: menus, submenus, commands and separators, in any order. Saved layouts appear wherever classic
 * layouts are listed (View ▸ Classic Menu Layout, Options, Help ▸ Menu Map).
 */
export async function customizeMenus(app: App): Promise<void> {
  type Item = string | { label: string; items: Item[] };
  type Layout = { key: string; name: string; menus: { label: string; items: Item[] }[] };
  const customs: Layout[] = JSON.parse(JSON.stringify(app.prefs.customMenus));
  const builtIns = Object.keys(CLASSIC_MENUS).filter((k) => !k.startsWith('custom-'));
  let key = app.prefs.menuLayout in CLASSIC_MENUS ? app.prefs.menuLayout : DEFAULT_LAYOUT;
  let sel: number[] = [];
  const cats = categories(app);
  let cat = cats[0], filter = '', leftSel = 0;
  const layoutOf = (k: string): Layout => customs.find((l) => l.key === k) || { key: k, name: CLASSIC_LAYOUT_NAMES[k], menus: JSON.parse(JSON.stringify(CLASSIC_MENUS[k] || [])) };
  const editable = (): Layout => {
    const c = customs.find((l) => l.key === key); if (c) return c;
    const base = layoutOf(key), copy: Layout = { key: `custom-${Date.now().toString(36)}`, name: `${base.name} (mine)`, menus: base.menus };
    customs.push(copy); key = copy.key; toast(`Created "${copy.name}", an editable copy; the original stays as it was.`);
    return copy;
  };
  // A path is [menu, item, item, …]; [menu] alone is the menu itself.
  const listOf = (L: Layout, parent: number[]): Item[] => { let list = L.menus[parent[0]].items; for (const i of parent.slice(1)) list = (list[i] as { items: Item[] }).items; return list; };
  const nodeAt = (L: Layout, p: number[]): Item | { label: string; items: Item[] } | undefined => (p.length === 1 ? L.menus[p[0]] : listOf(L, p.slice(0, -1))[p[p.length - 1]]);
  const root = h('div', { class: 'ql-customize' });
  const left = h('div', { class: 'ql-cust-col' }), mid = h('div', { class: 'ql-cust-mid' }), right = h('div', { class: 'ql-cust-col' });
  const leftItems = () => cat.list().filter((c) => !filter || `${c.label} ${c.id}`.toLowerCase().includes(filter));
  const catSel = h('select', null, ...cats.map((c) => h('option', { value: c.id }, c.label))) as HTMLSelectElement;
  catSel.addEventListener('change', () => { cat = cats.find((c) => c.id === catSel.value) || cats[0]; leftSel = 0; draw(); });
  const search = h('input', { placeholder: 'Filter commands…' }) as HTMLInputElement;
  search.addEventListener('input', () => { filter = search.value.toLowerCase(); leftSel = 0; draw(); });
  const draw = () => {
    clearKeepingScroll(left, right);
    left.append(h('label', { class: 'ql-label' }, 'Choose commands from:'), catSel, search, commandList(leftItems(), leftSel, (i) => { leftSel = i; draw(); }, (i) => { leftSel = i; add(); }));
    const layoutSel = h('select', { class: 'qn-menu-layout' }, ...[...builtIns, ...customs.map((l) => l.key)].map((k) => h('option', { value: k, selected: k === key }, customs.find((l) => l.key === k)?.name || CLASSIC_LAYOUT_NAMES[k]))) as HTMLSelectElement;
    layoutSel.addEventListener('change', () => { key = layoutSel.value; sel = []; draw(); });
    const L = layoutOf(key), tree = h('div', { class: 'ql-cmdlist qn-menu-tree' });
    const row = (p: number[], depth: number, content: (HTMLElement | string | null)[], cls = '') => { const r = h('div', { class: `ql-cmdlist-row ${cls}` + (p.join() === sel.join() ? ' ql-sel' : ''), style: `padding-left:${6 + depth * 18}px`, onclick: () => { sel = p; draw(); } }, ...content); tree.appendChild(r); };
    const walk = (items: Item[], p: number[], depth: number) => items.forEach((it, i) => {
      const q = [...p, i];
      if (it === '|') row(q, depth, [h('span', { class: 'ql-icon-space' }), '──────────'], 'ql-sep-row');
      else if (typeof it === 'string') { const c = getCommand(it); row(q, depth, [icon(c?.icon), c?.label || it, c ? null : h('span', { class: 'ql-help' }, ' (planned)')], c ? '' : 'ql-dim'); }
      else { row(q, depth, [icon('subdirectory_arrow_right'), h('b', null, it.label)]); walk(it.items, q, depth + 1); }
    });
    L.menus.forEach((m, mi) => { row([mi], 0, [icon('menu'), h('b', null, m.label)], 'ql-group-row'); walk(m.items, [mi], 1); });
    right.append(h('label', { class: 'ql-label' }, 'Layout:'), layoutSel, h('label', { class: 'ql-label' }, `Menus${customs.some((l) => l.key === key) ? '' : ' (built-in: editing makes a copy)'}:`), tree);
  };
  /** Where a new item goes: inside a selected menu or submenu (at its end), else after the selected item. */
  const target = (L: Layout): { list: Item[]; at: number; path: number[] } => {
    if (!L.menus.length) L.menus.push({ label: 'Menu', items: [] });
    if (!sel.length) { const mi = L.menus.length - 1; return { list: L.menus[mi].items, at: L.menus[mi].items.length, path: [mi] }; }
    const n = nodeAt(L, sel);
    if (sel.length === 1 || (n && typeof n === 'object')) { const list = sel.length === 1 ? L.menus[sel[0]].items : (n as { items: Item[] }).items; return { list, at: list.length, path: sel }; }
    return { list: listOf(L, sel.slice(0, -1)), at: sel[sel.length - 1] + 1, path: sel.slice(0, -1) };
  };
  const insert = (it: Item) => { const L = editable(); const t = target(L); t.list.splice(t.at, 0, it); sel = [...t.path, t.at]; draw(); };
  const add = () => { const c = leftItems()[leftSel]; if (c) insert(c.id); };
  const remove = async () => {
    if (!sel.length) return; const L = editable();
    if (sel.length === 1) { if (!(await confirmDialog('Remove Menu', `Remove the menu "${L.menus[sel[0]].label}" and everything in it?`, 'Remove'))) return; L.menus.splice(sel[0], 1); sel = []; }
    else { const list = listOf(L, sel.slice(0, -1)); list.splice(sel[sel.length - 1], 1); sel = list.length ? [...sel.slice(0, -1), Math.min(sel[sel.length - 1], list.length - 1)] : sel.slice(0, -1); }
    draw();
  };
  const move = (d: number) => {
    if (!sel.length) return; const L = editable();
    const list: unknown[] = sel.length === 1 ? L.menus : listOf(L, sel.slice(0, -1)), i = sel[sel.length - 1], j = i + d;
    if (j < 0 || j >= list.length) return; [list[i], list[j]] = [list[j], list[i]]; sel = [...sel.slice(0, -1), j]; draw();
  };
  const rename = async () => {
    const L = editable(), n = sel.length ? nodeAt(L, sel) : null;
    if (n && typeof n === 'object') { const v = await promptDialog('Rename', 'Name:', n.label); if (v) n.label = v; }
    else { const v = await promptDialog('Rename Layout', 'Layout name:', L.name); if (v) L.name = v; }
    draw();
  };
  const b = midButton;
  mid.append(
    b('Add', 'arrow_forward', add), b('Remove', 'arrow_back', () => void remove()), b('Up', 'arrow_upward', () => move(-1)), b('Down', 'arrow_downward', () => move(1)),
    b('Separator', 'horizontal_rule', () => insert('|')),
    b('New Submenu', 'subdirectory_arrow_right', async () => { const n = await promptDialog('New Submenu', 'Submenu name:', 'More'); if (n) insert({ label: n, items: [] }); }),
    b('New Menu', 'menu', async () => { const n = await promptDialog('New Menu', 'Menu name:', 'My Menu'); if (!n) return; const L = editable(); const at = sel.length ? sel[0] + 1 : L.menus.length; L.menus.splice(at, 0, { label: n, items: [] }); sel = [at]; draw(); }),
    b('Rename', 'edit', () => void rename()),
    b('New Layout', 'add', async () => { const n = await promptDialog('New Layout', 'Layout name:', 'My Menus'); if (!n) return; const l: Layout = { key: `custom-${Date.now().toString(36)}`, name: n, menus: [{ label: 'File', items: ['file.open', 'file.save', '|', 'file.exit'] }] }; customs.push(l); key = l.key; sel = []; draw(); }),
    b('Delete Layout', 'delete', async () => { const i = customs.findIndex((l) => l.key === key); if (i < 0) { toast('Built-in layouts cannot be deleted; edit one to make your own copy.'); return; } if (await confirmDialog('Delete Layout', `Delete "${customs[i].name}"?`, 'Delete')) { customs.splice(i, 1); key = DEFAULT_LAYOUT; sel = []; draw(); } }),
  );
  root.append(left, mid, right);
  draw();
  const r = await openDialog({ title: 'Customize Menus', full: true, content: root, help: 'Pick a layout, then add commands, separators, submenus and menus, or move and rename them. Editing a built-in layout makes your own copy. Saving shows the layout you edited on the menu bar.' });
  if (!r) return;
  // Empty submenus and menus are dropped; the edited layout becomes the menu bar.
  const prune = (items: Item[]): Item[] => items.flatMap((it): Item[] => { if (typeof it === 'string') return [it]; const k = prune(it.items); return k.length ? [{ label: it.label, items: k }] : []; });
  for (const l of customs) l.menus = l.menus.map((m) => ({ label: m.label, items: prune(m.items) })).filter((m) => m.items.length);
  app.prefs.customMenus = customs.filter((l) => l.menus.length);
  installCustomMenus(app.prefs.customMenus);
  if (key in CLASSIC_MENUS) app.prefs.menuLayout = key;
  if (app.prefs.menuStyle === 'ribbon') app.prefs.menuStyle = 'both';
  app.savePrefs(); app.ui.applyPrefs();
}
