/** Application shell: title bar, Quick Access Bar, classic menu bar, tabs + ribbon, window tabs, viewer, status bar. */
import { pixelToWorld, formatWorld, type Wcs } from '../codecs/wcs';
import type { App, PictureTab } from '../app';
import { getCommand, allCommands, searchCommands, plannedLabel, type Command, type MenuEntry } from '../commands/registry';
import { h, icon, clear, isPhone } from './dom';
import { showMenu, closeMenus, openDialog, toast, menuOpen, focusMenu } from './dialog';
import { DEFAULT_TABS, tabsFor, type RibbonTab } from './ribbonLayout';
import { prettyKey, canonicalKey, keyName } from '../util/keys';
import { customizeQat, customizeRibbon, customizeKeyboard } from './customize';
import { renderBackstage } from './backstage';
import { Viewer } from './viewer';
import { ThumbPanel } from './thumbs';
import { QAT_STANDARD, QAT_EXTRAS } from '../prefs';
import { CLASSIC_MENUS, DEFAULT_LAYOUT, type ClassicItem } from './classicMenus';
import { PLAN_COMMANDS } from '../plan.generated';
import { desktopBridge } from '../platform/native';
import { word } from '../i18n/strings';

export class Shell {
  root: HTMLElement;
  titlebar!: HTMLElement;
  qatEl!: HTMLElement;
  qatBelow!: HTMLElement;
  qatBottom!: HTMLElement;
  menuBarEl!: HTMLElement;
  tabsEl!: HTMLElement;
  ribbonEl!: HTMLElement;
  docTabsEl!: HTMLElement;
  workspace!: HTMLElement;
  statusEl!: HTMLElement;
  backstageEl!: HTMLElement;
  titleBtn!: HTMLElement;
  currentTab = 'home';
  ribbonOpen = true;
  statusMsg = '';
  private statusTimer: any;
  private lastContextual = '';
  private pixelText = '';

  constructor(public app: App) {
    this.root = app.host;
    this.build();
    this.applyPrefs();
    // Whether focus is being moved with the keyboard: Tab sets it, a pointer press clears it (see controlOwnsKey).
    document.addEventListener('keydown', (e) => { if (e.key === 'Tab') this.keyNav = true; }, true);
    for (const n of ['pointerdown', 'mousedown', 'touchstart']) document.addEventListener(n, () => { this.keyNav = false; }, true);
    document.addEventListener('keydown', (e) => this.globalKey(e), true);
  }

  // ----------------------------------------------------------------------------------------
  // Layout

  build(): void {
    clear(this.root);
    this.root.className = 'ql-app';
    this.titlebar = h('header', { class: 'ql-titlebar' });
    const fileBtn = h('button', { class: 'ql-iconbtn ql-filebtn', title: 'File', 'aria-label': 'File menu', onclick: () => this.showBackstage() }, icon('menu'));
    this.qatEl = h('div', { class: 'ql-qat', role: 'toolbar', 'aria-label': 'Quick Access Bar' });
    this.titleBtn = h('button', { class: 'ql-title', title: 'Picture information', onclick: () => this.app.exec('image.info') }, 'Anne\'s Lens');
    const search = h('button', { class: 'ql-iconbtn', title: 'Search commands (Alt+Q)', 'aria-label': 'Search commands', onclick: () => this.commandPalette() }, icon('search'));
    const full = h('button', { class: 'ql-btn ql-present', title: 'Full Screen (Enter)', onclick: () => this.app.exec('view.fullScreen') }, icon('fullscreen'), h('span', { class: 'ql-present-label' }, ' Full Screen'));
    const more = h('button', { class: 'ql-iconbtn', title: 'More', 'aria-label': 'More', onclick: (e: MouseEvent) => this.moreMenu(e.currentTarget as HTMLElement) }, icon('more_vert'));
    // Frameless Window (desktop): the title bar moves the window and carries its buttons.
    const winBtn = (name: string, label: string, action: 'minimize' | 'maximize' | 'close') => h('button', { class: `ql-iconbtn ql-win-${action}`, title: label, 'aria-label': label, onclick: () => void desktopBridge()?.windowControl({ action }) }, icon(name));
    const winCtl = h('span', { class: 'ql-winctl' }, winBtn('minimize', 'Minimize', 'minimize'), winBtn('crop_square', 'Maximize or Restore', 'maximize'), winBtn('close', 'Close', 'close'));
    this.titlebar.append(fileBtn, this.qatEl, this.titleBtn, h('span', { class: 'ql-spacer' }), search, full, more, winCtl);
    this.menuBarEl = h('nav', { class: 'ql-menubar', role: 'menubar', 'aria-label': 'Menu bar' });
    this.tabsEl = h('nav', { class: 'ql-tabs', role: 'tablist' });
    this.ribbonEl = h('div', { class: 'ql-ribbon', role: 'toolbar' });
    this.qatBelow = h('div', { class: 'ql-qat ql-qat-below', role: 'toolbar', 'aria-label': 'Quick Access Bar' });
    this.docTabsEl = h('div', { class: 'ql-doctabs' });
    this.workspace = h('div', { class: 'ql-workspace' });
    const main = h('main', { class: 'ql-main' }, this.workspace);
    this.qatBottom = h('div', { class: 'ql-qat ql-qat-bottom', role: 'toolbar', 'aria-label': 'Quick Access Bar' });
    this.statusEl = h('footer', { class: 'ql-status' });
    this.backstageEl = h('div', { class: 'ql-backstage', 'aria-hidden': 'true' });
    this.root.append(this.titlebar, this.menuBarEl, this.tabsEl, this.ribbonEl, this.qatBelow, this.docTabsEl, main, this.qatBottom, this.statusEl, this.backstageEl, h('div', { class: 'ql-toasts' }));
    this.renderQat();
    this.renderMenuBar();
    this.renderTabs();
    this.renderRibbon();
  }

  rebuild(): void { this.renderQat(); this.renderMenuBar(); this.renderTabs(); this.renderRibbon(); this.refresh(); }

  mountTab(tab: PictureTab): void {
    const v = new Viewer(this.app, tab);
    tab.ui = v;
    tab.thumbs = new ThumbPanel(this.app, tab);
    tab.el = h('div', { class: 'qn-window' }, v.el, tab.thumbs.el);
    this.workspace.appendChild(tab.el);
    if (this.app.prefs.browserLayout || this.app.prefs.folderTree) void import('../commands/browseWindow').then((m) => m.applyBrowseLayout(this.app, tab));
    v.onPointer = (info) => { this.pixelText = info ? `${info.x}, ${info.y}  RGB ${info.rgba[0]}, ${info.rgba[1]}, ${info.rgba[2]}${info.rgba[3] < 255 ? ` α ${info.rgba[3]}` : ''}  #${hex(info.rgba)}${worldText(v.picture?.current.world, info.x, info.y)}` : ''; this.updatePixel(); };
    requestAnimationFrame(() => v.layout());
  }

  // ----------------------------------------------------------------------------------------
  // Quick Access Bar

  renderQat(): void {
    const pos = this.app.prefs.qatPosition;
    const target = pos === 'bottom' ? this.qatBottom : pos === 'below' ? this.qatBelow : this.qatEl;
    clear(this.qatEl); clear(this.qatBottom); clear(this.qatBelow);
    for (const id of this.app.prefs.qat) {
      if (id === '|') { target.appendChild(h('span', { class: 'ql-qat-sep' })); continue; }
      const c = getCommand(id);
      if (!c) continue;
      target.appendChild(this.commandButton(c, 'qat'));
    }
    target.appendChild(h('button', { class: 'ql-iconbtn ql-qat-customize', title: 'Customize Quick Access Bar', 'aria-label': 'Customize Quick Access Bar', onclick: (e: MouseEvent) => this.qatMenu(e.currentTarget as HTMLElement) }, icon('arrow_drop_down')));
  }

  qatMenu(anchor: HTMLElement): void {
    const q = this.app.prefs.qat;
    const item = (id: string) => ({ id, label: getCommand(id)?.label || id, checked: q.includes(id), arg: '__toggle' });
    const present = (id: string) => !!getCommand(id);
    const pos = this.app.prefs.qatPosition;
    showMenu([
      { heading: 'Customize Quick Access Bar' },
      ...QAT_STANDARD.filter(present).map(item),
      { separator: true },
      ...QAT_EXTRAS.filter(present).map(item),
      { separator: true },
      { id: '__addAll', label: 'Add All Choices (Save, Print, then A–Z)', icon: 'sort_by_alpha' },
      { id: '__more', label: 'More Commands…', icon: 'library_add' },
      ...(pos !== 'top' ? [{ id: '__pos', arg: 'top', label: 'Show Above the Ribbon', icon: 'vertical_align_top' }] : []),
      ...(pos !== 'below' ? [{ id: '__pos', arg: 'below', label: 'Show Below the Ribbon', icon: 'vertical_align_center' }] : []),
      ...(pos !== 'bottom' ? [{ id: '__pos', arg: 'bottom', label: 'Show at the Bottom (near keyboard)', icon: 'vertical_align_bottom' }] : []),
      { id: '__labels', label: this.app.prefs.qatLabels ? 'Hide Command Labels' : 'Show Command Labels', icon: 'label' },
      { id: '__hide', label: 'Hide Quick Access Bar', icon: 'visibility_off' },
      { id: '__ribbon', label: this.app.prefs.ribbon === 'full' ? 'Collapse the Ribbon' : 'Show the Ribbon', icon: 'expand_less' },
    ], {
      anchor, onPick: (e) => {
        const p = this.app.prefs;
        if (e.arg === '__toggle' && e.id) { p.qat = q.includes(e.id) ? q.filter((x) => x !== e.id) : [...q, e.id]; }
        else if (e.id === '__addAll') { this.app.exec('view.qatAddAll'); return; }
        else if (e.id === '__more') { this.customizeQat(); return; }
        else if (e.id === '__pos') { this.app.exec('view.qatPosition', e.arg); return; }
        else if (e.id === '__labels') p.qatLabels = !p.qatLabels;
        else if (e.id === '__hide') { p.qatHidden = true; toast('Quick Access Bar hidden. Show it again from View ▸ Show Quick Access Bar or by long-pressing any ribbon command.', { ms: 5000 }); }
        else if (e.id === '__ribbon') p.ribbon = p.ribbon === 'full' ? 'tabs' : 'full';
        this.app.savePrefs();
        this.applyPrefs();
        this.renderQat();
        this.refresh();
      },
    });
  }

  // ----------------------------------------------------------------------------------------
  // Classic menu bar

  renderMenuBar(): void {
    clear(this.menuBarEl);
    const menus = CLASSIC_MENUS[this.app.prefs.menuLayout] || CLASSIC_MENUS[DEFAULT_LAYOUT];
    for (const m of menus) {
      if (!this.classicEntries(m.items).length) continue;
      const b = h('button', { class: 'ql-menubar-item', role: 'menuitem', 'aria-haspopup': 'true' }, m.label);
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => this.openClassicMenu(m.items, b));
      b.addEventListener('mouseenter', () => { if (document.querySelector('.ql-menu[data-classic]')) this.openClassicMenu(m.items, b); });
      this.menuBarEl.appendChild(b);
    }
    if (isPhone()) {
      // Phones: one ☰ menu holding the whole tree.
      clear(this.menuBarEl);
      const b = h('button', { class: 'ql-menubar-item', role: 'menuitem', 'aria-haspopup': 'true' }, icon('menu'), ' Menu');
      b.addEventListener('click', () => this.openClassicMenu(menus.map((m) => ({ label: m.label, items: m.items })), b));
      this.menuBarEl.appendChild(b);
    }
  }

  private classicEntries(items: ClassicItem[]): MenuEntry[] {
    const out: MenuEntry[] = [];
    for (const it of items) {
      if (it === '|') { if (out.length && !out[out.length - 1].separator) out.push({ separator: true }); continue; }
      if (typeof it === 'string') {
        const c = getCommand(it);
        if (!c) continue;
        let checked: boolean | undefined;
        try { checked = c.kind === 'toggle' ? !!c.isActive?.(this.app) : undefined; } catch { /* */ }
        if (c.kind === 'menu' && c.menu) { const sub = c.menu(this.app); if (sub.length) out.push({ label: c.label, icon: c.icon, submenu: sub }); continue; }
        const key = this.keyOf(c);
        out.push({ id: it, label: c.label + (key ? `\t${key}` : ''), icon: c.icon, checked });
        continue;
      }
      const sub = this.classicEntries(it.items);
      if (sub.length) out.push({ label: it.label, submenu: sub });
    }
    while (out.length && out[out.length - 1].separator) out.pop();
    return out;
  }

  /** The command's first key, as the user has it (custom binding first). */
  keyOf(c: Command): string {
    const custom = Object.entries(this.app.prefs.keymap).find(([, id]) => id === c.id)?.[0];
    const k = custom || (c.keys || []).find((x) => this.app.prefs.keymap[canonicalKey(x)] === undefined);
    return k ? prettyKey(k) : '';
  }

  private openClassicMenu(items: ClassicItem[], anchor: HTMLElement): void {
    closeMenus();
    const m = showMenu(this.classicEntries(items), { anchor, className: 'ql-classic-menu', onPick: (e) => { if (e.id) { const c = getCommand(e.id); if (c?.kind === 'menu' && e.id === c.id && e.arg === undefined) this.openCommandMenu(c, this.anchorFor(c.id)); else this.app.exec(e.id, e.arg); setTimeout(() => this.app.focus(), 0); } } });
    m.dataset.classic = '1';
  }

  // ----------------------------------------------------------------------------------------
  // Tabs and ribbon

  renderTabs(): void {
    clear(this.tabsEl);
    this.tabsEl.appendChild(h('button', { class: 'ql-tab ql-tab-file', role: 'tab', onclick: () => this.showBackstage() }, word('tabs', 'File')));
    for (const t of tabsFor(this.app)) {
      if (!t.custom && !t.groups.some((g) => g.items.some((id) => getCommand(id)))) continue; // a plan tab with nothing built yet
      const b = h('button', { class: 'ql-tab' + (t.contextual ? ' ql-contextual' : '') + (t.id === this.currentTab ? ' ql-active' : ''), role: 'tab', 'data-tab': t.id, style: t.accent ? `--tab-accent:${t.accent}` : '' }, t.label);
      b.addEventListener('click', () => {
        if (this.currentTab === t.id && this.app.prefs.ribbon !== 'hidden') { this.ribbonOpen = !this.ribbonOpen; this.root.classList.toggle('ql-ribbon-closed', !this.ribbonOpen); return; }
        this.currentTab = t.id; this.ribbonOpen = true; this.root.classList.remove('ql-ribbon-closed');
        this.renderTabs(); this.renderRibbon(); this.refresh();
        b.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      });
      b.addEventListener('dblclick', () => { this.app.exec('view.collapseRibbon'); });
      this.tabsEl.appendChild(b);
    }
  }

  ribbonTab(): RibbonTab { return tabsFor(this.app).find((t) => t.id === this.currentTab) || DEFAULT_TABS[0]; }

  renderRibbon(): void {
    clear(this.ribbonEl);
    const tab = this.ribbonTab();
    for (const g of tab.groups) {
      const items = h('div', { class: 'ql-group-items' });
      for (const id of g.items) {
        const c = getCommand(id);
        if (!c) continue;
        items.appendChild(this.ribbonItem(c));
      }
      if (!items.children.length) continue;
      const label = h('div', { class: 'ql-group-label' }, g.label, g.launcher ? h('button', { class: 'ql-launcher', title: `${g.label} settings`, 'aria-label': `${g.label} settings`, onclick: () => this.app.exec(g.launcher!) }, icon('open_in_new')) : null);
      this.ribbonEl.appendChild(h('section', { class: 'ql-group', 'data-group': g.id }, items, label));
    }
    this.ribbonEl.scrollLeft = 0;
  }

  ribbonItem(c: Command): HTMLElement {
    switch (c.kind) {
      case 'combo': return this.comboBox(c);
      default: return this.commandButton(c, 'ribbon');
    }
  }

  commandButton(c: Command, where: 'ribbon' | 'qat' | 'mini'): HTMLElement {
    const showLabel = where === 'ribbon' || (where === 'qat' && this.app.prefs.qatLabels);
    const key = this.keyOf(c);
    const main = h('button', { class: 'ql-cmd', 'data-cmd': c.id, title: (c.tip ? `${c.label}: ${c.tip}` : c.label) + (key ? ` (${key})` : ''), 'aria-label': c.label, type: 'button' }, icon(c.icon), showLabel ? h('span', { class: 'ql-cmd-label' }, c.label.replace(/…$/, '')) : null);
    let longPress: any;
    main.addEventListener('pointerdown', () => { longPress = setTimeout(() => { longPress = 'fired'; this.longPress(c, main); }, 550); });
    main.addEventListener('pointerup', () => { if (longPress !== 'fired') clearTimeout(longPress); });
    main.addEventListener('pointerleave', () => { if (longPress !== 'fired') clearTimeout(longPress); });
    main.addEventListener('contextmenu', (e) => { e.preventDefault(); this.longPress(c, main); });
    main.addEventListener('click', () => {
      if (longPress === 'fired') { longPress = null; return; }
      if (c.kind === 'menu') { this.openCommandMenu(c, main); return; }
      this.app.exec(c.id);
      if (where !== 'qat' && !['menu', 'split'].includes(c.kind || '')) setTimeout(() => this.app.focus(), 0);
    });
    main.addEventListener('mousedown', (e) => e.preventDefault());
    if (c.kind === 'menu') main.appendChild(icon('arrow_drop_down', 'ql-caret'));
    if (c.kind === 'split') {
      const arrow = h('button', { class: 'ql-split-arrow', type: 'button', title: `${c.label} options`, 'aria-label': `${c.label} options` }, icon('arrow_drop_down'));
      arrow.addEventListener('mousedown', (e) => e.preventDefault());
      arrow.addEventListener('click', () => this.openCommandMenu(c, wrap));
      const wrap = h('span', { class: 'ql-split', 'data-cmd-wrap': c.id }, main, arrow);
      return wrap;
    }
    return main;
  }

  longPress(c: Command, el: HTMLElement): void {
    const inQat = this.app.prefs.qat.includes(c.id);
    showMenu([
      { id: '__qat', label: inQat ? 'Remove from Quick Access Bar' : 'Add to Quick Access Bar', icon: inQat ? 'remove_circle' : 'add_circle' },
      { id: '__customizeQat', label: 'Customize Quick Access Bar…', icon: 'tune' },
      ...(this.app.prefs.qatHidden ? [{ id: '__showQat', label: 'Show Quick Access Bar', icon: 'bolt' }] : []),
      { id: '__key', label: 'Assign Shortcut…', icon: 'keyboard' },
      { id: '__where', label: 'Where Is This Command?', icon: 'map' },
      { id: '__ribbon', label: this.app.prefs.ribbon === 'full' ? 'Collapse the Ribbon' : 'Show the Ribbon', icon: 'expand_less' },
      { id: '__info', label: `About: ${c.label}`, icon: 'info' },
    ], {
      anchor: el, onPick: (e) => {
        if (e.id === '__qat') { this.app.prefs.qat = inQat ? this.app.prefs.qat.filter((x) => x !== c.id) : [...this.app.prefs.qat, c.id]; this.app.savePrefs(); this.renderQat(); this.refresh(); toast(inQat ? 'Removed from Quick Access Bar' : 'Added to Quick Access Bar'); }
        if (e.id === '__customizeQat') this.customizeQat();
        if (e.id === '__showQat') this.app.exec('view.qatShow');
        if (e.id === '__key') this.customizeKeyboard(c.id);
        if (e.id === '__where') this.app.exec('help.menuMap', c.id);
        if (e.id === '__ribbon') this.app.exec('view.collapseRibbon');
        if (e.id === '__info') toast(`${c.label} — ${c.tab}${c.group ? ' ▸ ' + c.group : ''}${c.keys?.length ? ' — ' + c.keys.map(prettyKey).join(', ') : ''}${c.origin ? ' — from ' + c.origin : ''}`, { ms: 5000 });
      },
    });
  }

  openCommandMenu(c: Command, anchor: HTMLElement): void {
    const entries = c.menu ? c.menu(this.app) : [];
    showMenu(entries, { anchor, onPick: (e) => this.pickEntry(c, e) });
  }

  pickEntry(c: Command, e: MenuEntry): void {
    if (!e.id) return;
    if (e.id === c.id) this.app.exec(c.id, e.arg);
    else this.app.exec(e.id, e.arg);
    setTimeout(() => this.app.focus(), 0);
  }

  comboBox(c: Command): HTMLElement {
    const b = h('button', { class: 'ql-combo ql-wide-combo', 'data-cmd': c.id, 'data-combo': c.id, title: c.label, type: 'button' }, h('span', { class: 'ql-combo-text' }, c.label), icon('arrow_drop_down'));
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => this.openCommandMenu(c, b));
    return b;
  }

  // ----------------------------------------------------------------------------------------
  // Refresh (state → UI)

  refresh(): void {
    const app = this.app;
    if (!app.active) return;
    const sig = DEFAULT_TABS.filter((t) => t.contextual).map((t) => { try { return t.contextual!(app) ? 1 : 0; } catch { return 0; } }).join('');
    if (sig !== this.lastContextual) { this.lastContextual = sig; this.renderTabs(); }
    for (const t of DEFAULT_TABS.filter((x) => x.contextual)) {
      const el = this.tabsEl.querySelector<HTMLElement>(`[data-tab="${t.id}"]`);
      let show = false;
      try { show = t.contextual!(app); } catch { /* */ }
      if (el) el.style.display = show ? '' : 'none';
      if (!show && this.currentTab === t.id) { this.currentTab = 'home'; this.renderTabs(); this.renderRibbon(); }
    }
    for (const b of this.root.querySelectorAll<HTMLElement>('[data-cmd]')) {
      const c = getCommand(b.dataset.cmd!);
      if (!c) continue;
      let active = false, enabled = true;
      try { active = !!c.isActive?.(app); enabled = c.isEnabled ? c.isEnabled(app) : !(c.edits && !app.picture); } catch { /* */ }
      b.classList.toggle('ql-on', active);
      b.setAttribute('aria-pressed', String(active));
      b.classList.toggle('ql-disabled', !enabled);
    }
    this.root.querySelectorAll<HTMLElement>('button[data-combo]').forEach((b) => {
      const c = getCommand(b.dataset.combo!);
      const v = c?.value?.(app);
      const t = b.querySelector('.ql-combo-text');
      if (t && v != null) t.textContent = String(v);
    });
    this.renderStatus();
    this.titleBtn.textContent = app.tab.displayName + (app.tab.dirty ? ' •' : '');
    document.title = `${app.tab.displayName}${app.tab.dirty ? ' •' : ''} – Anne's Lens`;
  }

  // ----------------------------------------------------------------------------------------
  // Status bar

  private pixelEl: HTMLElement | null = null;
  private updatePixel(): void { if (this.pixelEl) this.pixelEl.textContent = this.pixelText; }

  renderStatus(): void {
    const app = this.app;
    const tab = app.tab;
    clear(this.statusEl);
    const item = (text: string, onclick?: () => void, title?: string, cls = '') => h('button', { class: 'ql-status-item ' + cls, onclick, title: title || text, type: 'button' }, text);
    const f = tab.folder;
    const pic = tab.picture;
    if (f.length) this.statusEl.appendChild(item(`${f.index + 1} / ${f.length}`, () => app.exec('view.gotoIndex'), 'Go to picture number…'));
    if (pic) {
      const pg = pic.current;
      this.statusEl.appendChild(item(`${pg.width} × ${pg.height} × ${pg.bitDepth} bpp`, () => app.exec('image.info'), 'Picture information'));
      this.statusEl.appendChild(item(`${pic.format.label}${pic.pages.length > 1 ? ` · page ${pic.page + 1}/${pic.pages.length}` : ''}${pg.frames.length > 1 ? ` · frame ${pic.frame + 1}/${pg.frames.length}` : ''}`, () => app.exec('image.info'), 'Format'));
      this.statusEl.appendChild(item(fmtSize(pic.bytes.length), () => app.exec('image.info'), 'File size'));
      if (pic.loadMs) this.statusEl.appendChild(h('span', { class: 'ql-status-item ql-help' }, `${pic.loadMs} ms`));
      if (pic.warnings.length) this.statusEl.appendChild(item(`⚠ ${pic.warnings.length}`, () => app.exec('image.info'), pic.warnings.join('\n'), 'ql-status-track'));
      if (tab.selection) this.statusEl.appendChild(item(`▭ ${tab.selection.w} × ${tab.selection.h} at ${tab.selection.x}, ${tab.selection.y}`, () => app.exec('edit.customSelection'), 'Selection (click to edit; Ctrl+Y crops)'));
      else if (tab.selectTool) this.statusEl.appendChild(item('▭ drag to select', () => app.exec('edit.selectRect'), 'Rectangle Selection tool is on (click to turn off)'));
    } else if (tab.loading) this.statusEl.appendChild(h('span', { class: 'ql-status-msg' }, `Loading ${tab.loading.name}…`));
    if (app.recording) this.statusEl.appendChild(item(app.recordingPaused ? '⏸ Paused' : '● REC', () => app.exec('dev.stopRecording'), 'Stop recording macro', 'ql-status-rec'));
    if (this.statusMsg) this.statusEl.appendChild(h('span', { class: 'ql-status-msg' }, this.statusMsg));
    this.pixelEl = h('span', { class: 'ql-status-item qn-pixel' }, this.pixelText);
    this.statusEl.appendChild(this.pixelEl);
    this.statusEl.appendChild(h('span', { class: 'ql-spacer' }));
    const z = tab.ui?.zoom || 1;
    const modeIcon = tab.ui?.mode === 'actual' || (tab.ui && !tab.ui.mode && Math.abs(z - 1) < 1e-6) ? 'crop_original' : 'fit_screen';
    this.statusEl.append(
      h('button', { class: 'ql-iconbtn', title: 'Zoom out (-)', 'aria-label': 'Zoom out', onclick: () => app.exec('view.zoomOut') }, icon('remove')),
      h('button', { class: 'ql-status-item ql-zoom', title: 'Zoom…', onclick: (e: MouseEvent) => this.zoomMenu(e.currentTarget as HTMLElement) }, `${z >= 1 ? Math.round(z * 100) : Math.round(z * 1000) / 10}%`),
      h('button', { class: 'ql-iconbtn', title: 'Zoom in (+)', 'aria-label': 'Zoom in', onclick: () => app.exec('view.zoomIn') }, icon('add')),
      h('button', { class: 'ql-iconbtn' + (tab.ui?.mode === 'fit' || tab.ui?.mode === 'fit-large' ? ' ql-on' : ''), title: 'Fit to Window (Shift+F)', 'aria-label': 'Fit to window', onclick: () => app.exec('view.fitWindow') }, icon('fit_screen')),
      h('button', { class: 'ql-iconbtn' + (modeIcon === 'crop_original' ? ' ql-on' : ''), title: 'Original Size (Ctrl+H)', 'aria-label': 'Original size', onclick: () => app.exec('view.actualSize') }, icon('crop_original')));
  }

  zoomMenu(anchor: HTMLElement): void {
    const app = this.app;
    const z = app.viewer.zoom;
    showMenu([
      { id: 'view.fitWindow', label: 'Fit to Window', icon: 'fit_screen' }, { id: 'view.fitLarge', label: 'Fit Only Large Pictures' }, { id: 'view.fitWidth', label: 'Fit Width' }, { id: 'view.fitHeight', label: 'Fit Height' }, { id: 'view.fill', label: 'Fill Window' },
      { separator: true },
      ...[10, 25, 50, 100, 200, 400, 800].map((pct) => ({ id: 'view.zoomTo', arg: pct / 100, label: `${pct}%`, checked: Math.abs(z - pct / 100) < 1e-6 })),
      { separator: true },
      { id: 'view.zoomLock', label: 'Lock Zoom', checked: app.prefs.zoomLock },
    ], { anchor, onPick: (e) => { if (e.id === 'view.zoomTo') app.viewer.setZoom(e.arg); else if (e.id) app.exec(e.id, e.arg); } });
  }

  status(msg: string): void {
    this.statusMsg = msg;
    clearTimeout(this.statusTimer);
    if (msg && !msg.startsWith('●')) this.statusTimer = setTimeout(() => { this.statusMsg = ''; this.renderStatus(); }, 3000);
    this.renderStatus();
  }

  // ----------------------------------------------------------------------------------------
  // Window tabs and title

  tabsChanged(): void {
    const app = this.app;
    clear(this.docTabsEl);
    this.root.classList.toggle('ql-multi-doc', app.tabs.length > 1);
    for (const d of app.tabs) {
      const t = h('div', { class: 'ql-doctab' + (d === app.active ? ' ql-active' : ''), role: 'tab' },
        h('button', { class: 'ql-doctab-name', onclick: () => app.activate(d) }, d.displayName + (d.dirty ? ' •' : '')),
        h('button', { class: 'ql-doctab-close', 'aria-label': `Close ${d.displayName}`, onclick: () => { app.activate(d); app.exec('file.close', d.id); } }, icon('close')));
      this.docTabsEl.appendChild(t);
    }
    this.docTabsEl.appendChild(h('button', { class: 'ql-iconbtn', title: 'Open in a new window', 'aria-label': 'Open in a new window', onclick: () => app.exec('file.newWindow') }, icon('add')));
    if (app.active) { this.titleBtn.textContent = app.active.displayName + (app.active.dirty ? ' •' : ''); document.title = `${app.active.displayName}${app.active.dirty ? ' •' : ''} – Anne's Lens`; }
  }

  moreMenu(anchor: HTMLElement): void {
    const app = this.app;
    showMenu([
      { id: 'file.open', label: 'Open…', icon: 'folder_open' }, { id: 'file.openFolder', label: 'Open Folder…', icon: 'folder' }, { id: 'file.saveAs', label: 'Save As…', icon: 'save_as' }, { id: 'file.share', label: 'Share…', icon: 'share' }, { id: 'file.print', label: 'Print…', icon: 'print' },
      { separator: true },
      { id: 'image.info', label: 'Picture Information', icon: 'info' }, { id: 'view.fullScreen', label: 'Full Screen', icon: 'fullscreen' }, { id: 'view.menuMode', label: 'Menus: Ribbon / Classic / Both…', icon: 'menu_open' },
      { separator: true },
      { id: 'file.customizeQat', label: 'Customize Quick Access Bar…', icon: 'tune' }, { id: 'file.customizeRibbon', label: 'Customize Tabs…', icon: 'view_quilt' },
      { id: 'file.customizeKeyboard', label: 'Customize Keyboard…', icon: 'keyboard' }, { id: 'file.options', label: 'Options…', icon: 'settings' },
      { id: 'help.about', label: 'About', icon: 'info' },
    ], { anchor, onPick: (e) => e.id && app.exec(e.id, e.arg) });
  }

  // ----------------------------------------------------------------------------------------
  // Backstage

  showBackstage(page = 'home'): void {
    closeMenus();
    this.backstageEl.setAttribute('aria-hidden', 'false');
    this.root.classList.add('ql-backstage-open');
    renderBackstage(this.app, this.backstageEl, page);
  }
  hideBackstage(): void {
    this.backstageEl.setAttribute('aria-hidden', 'true');
    this.root.classList.remove('ql-backstage-open');
    clear(this.backstageEl);
  }

  customizeQat(): void { customizeQat(this.app); }
  customizeRibbon(): void { customizeRibbon(this.app); }
  customizeKeyboard(id?: string): void { customizeKeyboard(this.app, id); }

  // ----------------------------------------------------------------------------------------
  // Command palette

  commandPalette(): void {
    const app = this.app;
    const overlay = h('div', { class: 'ql-overlay ql-palette-overlay' });
    const input = h('input', { class: 'ql-palette-input', placeholder: `Search ${allCommands().length} commands… (e.g. "rotate", "fit", "exif")`, 'aria-label': 'Search commands' }) as HTMLInputElement;
    const list = h('div', { class: 'ql-palette-list', role: 'listbox' });
    const box = h('div', { class: 'ql-palette', role: 'dialog' }, input, list);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    let results: Command[] = [];
    let sel = 0;
    const close = () => { overlay.remove(); app.focus(); };
    const run = (c: Command) => { close(); if (c.kind === 'menu' && c.menu) this.openCommandMenu(c, this.anchorFor(c.id)); else app.exec(c.id); };
    const draw = () => {
      clear(list);
      const q = input.value.trim();
      results = q ? searchCommands(q, 80) : [...app.prefs.pinnedCommands.map((id) => getCommand(id)!).filter(Boolean), ...allCommands().filter((c) => c.popular).slice(0, 40)];
      results.forEach((c, i) => {
        const pinned = app.prefs.qat.includes(c.id);
        const key = this.keyOf(c);
        const row = h('div', { class: 'ql-palette-row' + (i === sel ? ' ql-sel' : ''), role: 'option' },
          icon(c.icon), h('span', { class: 'ql-palette-label' }, c.label), h('span', { class: 'ql-palette-tab' }, `${c.tab}${c.group ? ' ▸ ' + c.group : ''}`),
          key ? h('kbd', null, key) : null,
          h('button', { class: 'ql-iconbtn ql-palette-pin', title: pinned ? 'Remove from Quick Access Bar' : 'Add to Quick Access Bar', onclick: (e: Event) => { e.stopPropagation(); app.prefs.qat = pinned ? app.prefs.qat.filter((x) => x !== c.id) : [...app.prefs.qat, c.id]; app.savePrefs(); this.renderQat(); draw(); } }, icon(pinned ? 'push_pin' : 'keep')));
        row.addEventListener('click', () => run(c));
        list.appendChild(row);
      });
      if (!results.length) {
        const planned = q ? Object.entries(PLAN_COMMANDS).filter(([id, p]) => `${p.label} ${id}`.toLowerCase().includes(q.toLowerCase()) && !getCommand(id)).slice(0, 8) : [];
        list.appendChild(h('div', { class: 'ql-help' }, planned.length ? `No built command matches. Planned for a later milestone: ${planned.map(([, p]) => p.label).join(', ')}.` : 'No matching commands.'));
      }
    };
    input.addEventListener('input', () => { sel = 0; draw(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { sel = Math.min(results.length - 1, sel + 1); draw(); list.children[sel]?.scrollIntoView({ block: 'nearest' }); e.preventDefault(); }
      if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); list.children[sel]?.scrollIntoView({ block: 'nearest' }); e.preventDefault(); }
      if (e.key === 'Enter' && results[sel]) { e.preventDefault(); run(results[sel]); }
      if (e.key === 'Escape') close();
    });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    draw();
    setTimeout(() => input.focus(), 20);
  }

  // ----------------------------------------------------------------------------------------
  // Context menu

  pictureContextMenu(x: number, y: number): void {
    const app = this.app;
    const ids = app.picture
      ? ['view.next', 'view.previous', '|', 'view.fitWindow', 'view.actualSize', 'view.fullScreen', '|', ...(app.tab.selection ? ['edit.crop', 'edit.cut', 'edit.copy', 'edit.selectNone', '|'] : ['edit.selectAll', 'edit.copy', '|']), 'image.rotateLeft', 'image.rotateRight', 'image.flipH', 'image.flipV', 'image.resize', '|', 'file.saveAs', 'file.share', 'file.revealInFolder', 'file.openWith', '|', 'image.info', 'meta.exif']
      : ['file.open', 'file.openFolder', 'edit.pasteAsNew'];
    const entries: MenuEntry[] = [];
    for (const id of ids) {
      if (id === '|') { entries.push({ separator: true }); continue; }
      const c = getCommand(id);
      if (c) entries.push({ id, label: c.label, icon: c.icon });
    }
    showMenu(entries, { x, y, onPick: (e) => { if (e.id) app.exec(e.id, e.arg); } });
  }

  // ----------------------------------------------------------------------------------------

  anchorFor(id: string): HTMLElement {
    const els = [...this.root.querySelectorAll<HTMLElement>(`[data-cmd-wrap="${id}"], [data-cmd="${id}"]`)].filter((e) => e.offsetParent);
    return els[0] || this.ribbonEl;
  }

  applyPrefs(): void {
    const p = this.app.prefs;
    const dark = p.theme === 'dark' || p.theme === 'black' || (p.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.classList.toggle('ql-black', p.theme === 'black');
    this.root.classList.toggle('ql-ribbon-collapsed', p.ribbon !== 'full');
    this.root.classList.toggle('ql-qat-at-bottom', p.qatPosition === 'bottom');
    this.root.classList.toggle('ql-qat-below-ribbon', p.qatPosition === 'below');
    this.root.classList.toggle('ql-qat-hidden', p.qatHidden);
    this.root.classList.toggle('ql-touch', p.touchMode);
    this.root.classList.toggle('ql-high-contrast', p.highContrastUI);
    this.root.classList.toggle('ql-no-ribbon', p.menuStyle === 'classic');
    this.root.classList.toggle('ql-no-menubar', p.menuStyle === 'ribbon');
    this.root.classList.toggle('ql-no-status', !p.statusBar);
    this.root.style.setProperty('--ql-ui-scale', String(p.uiScale || 1));
    this.root.style.setProperty('--qn-canvas', p.background || 'var(--canvas)');
    this.root.style.setProperty('--qn-fullscreen', p.fullScreenBackground || '#000');
    if (!this.app.tabs.length) return;
    this.renderQat();
    this.renderMenuBar();
    for (const d of this.app.tabs) { d.ui.layout(); }
    this.refresh();
  }

  /** Whether focus was last moved with Tab; a pointer press clears it. */
  keyNav = false;

  /**
   * Whether the widget the key was pressed in handles it itself, so that the shortcuts stand aside. This listener runs in
   * the capture phase, ahead of every widget, so without this check Enter on a focused button ran Full Screen as well,
   * and the arrows in the thumbnail list moved two pictures.
   */
  private widgetOwnsKey(e: KeyboardEvent, t: HTMLElement | null): boolean {
    if (!t || !t.closest) return false;
    // A control reached with Tab is pressed by Enter and Space. After a click the keys go back to the picture (Space is Next), as they always did.
    if (this.keyNav && (e.key === 'Enter' || e.key === ' ') && t.closest('button, a[href], summary, [role="button"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="switch"]')) return true;
    // Lists, the map and other widgets that move with the keyboard say which keys are theirs.
    for (let n: any = t; n && n !== document.body; n = n.parentElement) if (typeof n.__ownsKey === 'function' && n.__ownsKey(e)) return true;
    return false;
  }

  globalKey(e: KeyboardEvent): void {
    const k = keyName(e);
    if (!k) return;
    if (e.key === 'Escape') {
      if (document.querySelector('.ql-menu')) { closeMenus(); return; }
      if (this.root.classList.contains('ql-backstage-open')) { this.hideBackstage(); return; }
      if (this.app.tab.selection && !document.querySelector('.ql-overlay')) { this.app.tab.setSelection(null); return; }
    }
    if (document.querySelector('.ql-overlay')) return;
    const t = e.target as HTMLElement;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    // An open menu owns the plain keys: arrows, Home and End move in it, Enter and Space pick, and nothing runs behind it.
    if (plain && !/^F\d+$/.test(e.key) && menuOpen()) {
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && focusMenu(e.key === 'ArrowUp')) e.preventDefault();
      return;
    }
    if (plain && this.widgetOwnsKey(e, t)) return;
    // A picture larger than the window is moved by the arrow keys (they are Next and Previous only when it fits).
    if (plain && !e.shiftKey && this.app.tabs.length && (!t || t === document.body || this.app.viewer.el.contains(t)) && this.app.viewer.panKey(e)) return;
    const inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    const id = this.app.commandForKey(canonicalKey(k));
    if (!id) {
      // The plan's Alt+1…Alt+9 (Quick Move) and Alt+Shift+1…9 (Quick Copy): one command, nine slots.
      const q = canonicalKey(k).match(/^Alt-(Shift-)?([1-9])$/);
      if (q && !inField && this.app.picture) { e.preventDefault(); this.app.exec(q[1] ? 'file.quickCopy' : 'file.quickMove', +q[2]); }
      // The plan's Ctrl+0…Ctrl+5 (Rating) and Ctrl+6…Ctrl+9 (Color Label: red, yellow, green, blue).
      const r = canonicalKey(k).match(/^Mod-([0-9])$/);
      if (r && !inField && this.app.picture) { e.preventDefault(); const n = +r[1]; if (n <= 5) this.app.exec('browse.rate', n); else this.app.exec('browse.colorLabel', ['red', 'yellow', 'green', 'blue'][n - 6]); }
      return;
    }
    if (inField) { if (!/^(file\.|view\.cmdSearch)/.test(id) || !(e.ctrlKey || e.metaKey || /^F\d+$/.test(e.key))) return; }
    const c = getCommand(id);
    if (c?.isEnabled && !c.isEnabled(this.app)) return;
    e.preventDefault();
    // Esc leaves full screen; it closes the app only where that option is on (File ▸ Options). Exit from a menu, and Alt+F4, always exit.
    if (id === 'file.exit' && e.key === 'Escape') { this.app.exec('file.exit', 'esc'); return; }
    this.app.exec(id);
  }

  async showShortcuts(): Promise<void> {
    const rows = allCommands().filter((c) => (c.keys && c.keys.length) || Object.values(this.app.prefs.keymap).includes(c.id));
    const custom = Object.entries(this.app.prefs.keymap);
    const nav: [string, string][] = [['Ctrl+wheel, pinch', 'Zoom'], ['Wheel', 'Next / previous picture (or scroll a large picture)'], ['Arrows', 'Pan a picture larger than the window'], ['Double-click', 'Original size / fit to window'], ['Drag', 'Pan'], ['Right-click', 'Picture menu'], ['Esc', 'Leave full screen; close menus']];
    const table = h('table', { class: 'ql-stats ql-shortcuts' },
      ...nav.map(([a, b]) => h('tr', null, h('td', null, b), h('td', null, a), h('td', { class: 'ql-help' }, 'Viewing'))),
      ...rows.sort((a, b) => a.tab.localeCompare(b.tab) || a.label.localeCompare(b.label)).map((c) => {
        const keys = [...(c.keys || []), ...custom.filter(([, id]) => id === c.id).map(([k2]) => k2)];
        return h('tr', null, h('td', null, c.label), h('td', null, keys.map(prettyKey).join(', ')), h('td', { class: 'ql-help' }, c.tab));
      }));
    await openDialog({ title: 'Keyboard Shortcuts', wide: true, content: table, cancel: false, help: 'Single letters follow IrfanView. Every key can be changed in File ▸ Customize Keyboard.' });
  }

  async tour(): Promise<void> {
    const steps = [
      ['Everything is a command', 'Every feature of Anne\'s Lens is a command you can find with the search button (or Alt+Q), place on the Quick Access Bar, put on your own tab or in any classic menu, assign a key, or record in a macro.'],
      ['Ribbon or classic menus', 'Use the ribbon tabs, or the classic menu bar laid out like IrfanView, XnView, FastStone and the others (View ▸ Menus). Both reach the same commands; you can show either or both.'],
      ['Viewing', 'Space and Backspace (or PgDn/PgUp, the arrows, the wheel) move through the folder; the next pictures are decoded ahead of time. Enter is full screen, + and - zoom, Shift+F fits, Ctrl+H is original size, L and R rotate, H and V flip, I shows information.'],
      ['Files', 'Open one picture (its folder follows on the desktop), several, or a folder; drop files on the window, paste one, or use "Open with" from another app. Save As writes PNG, JPEG, WebP or BMP.'],
    ];
    for (let i = 0; i < steps.length; i++) {
      const r = await openDialog({ title: `${steps[i][0]} (${i + 1}/${steps.length})`, content: h('p', { class: 'ql-msg' }, steps[i][1]), ok: i === steps.length - 1 ? 'Start' : 'Next', cancel: 'Skip tour' });
      if (!r) break;
    }
    this.app.prefs.firstRun = false;
    this.app.savePrefs();
  }
}

function hex(rgba: [number, number, number, number]): string { return rgba.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join(''); }
export function fmtSize(n: number): string { return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`; }
export const phone = isPhone;
export { plannedLabel };

/** The sky position of a pixel's center for the status bar, when the picture has a world coordinate system. */
function worldText(w: Wcs | undefined, x: number, y: number): string {
  if (!w) return '';
  const pos = pixelToWorld(w, x + 0.5, y + 0.5);
  return pos ? `  ${formatWorld(w, pos)}` : '';
}
