/** Every entry a command's own menu offers runs a command that exists (a menu entry is a command id and its argument). */
import { describe, it, expect } from 'vitest';
import '../../src/commands/index';
import { allCommands, getCommand, type MenuEntry } from '../../src/commands/registry';
import { defaultPrefs } from '../../src/prefs';
import { ownEntries } from '../../src/ui/shell';

describe('command menus', () => {
  it('offer only entries that run a registered command', () => {
    const prefs = defaultPrefs();
    prefs.importRules = [{ name: 'Camera card', folder: '{yyyy}', rename: '{name}', duplicates: 'skip', deleteAfter: false } as any];
    prefs.hiddenFiles = ['f|a.png'];
    const app: any = { prefs, picture: { name: 'a.png', pages: [{ frames: [{}] }], page: 0, width: 4, height: 4 }, folder: { uri: null, name: 'f', entries: [], length: 0, index: 0 }, tabs: [], tab: {} };
    const bad: string[] = []; let menus = 0;
    const walk = (owner: string, entries: MenuEntry[]) => { for (const e of entries) { if (e.submenu) walk(owner, e.submenu); else if (e.id && !getCommand(e.id)) bad.push(`${owner} → ${e.id}`); } };
    for (const c of allCommands()) {
      if (!c.menu) continue;
      let entries: MenuEntry[]; try { entries = c.menu(app); } catch { continue; } // menus that need a fuller app are covered by the e2e suite
      menus++; walk(c.id, ownEntries(c, entries)); // as the shell offers them
    }
    expect(menus).toBeGreaterThan(20);
    expect(bad).toEqual([]);
    // The three menus the review named now name their own command themselves.
    for (const id of ['file.hide', 'file.importRules', 'view.stereo']) for (const e of getCommand(id)!.menu!(app)) expect(e.id, id).toBe(id);
  });
});
