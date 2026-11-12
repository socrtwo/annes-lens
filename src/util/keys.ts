/** Keyboard shortcut names: Mod = Ctrl (Cmd on macOS), canonical order Mod-Ctrl-Alt-Shift-key. */
export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
}

export function keyName(e: KeyboardEvent): string | null {
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return null;
  let base = e.key;
  if (base === ' ') base = 'Space';
  if (base.length === 1) base = base.toLowerCase();
  // Use the physical key for Shift+digit/symbol combinations so bindings stay layout-stable.
  if (e.shiftKey && e.code && /^Digit\d$/.test(e.code)) base = e.code.slice(5);
  if (e.code === 'Period') base = '.';
  if (e.code === 'Comma') base = ',';
  if (e.code === 'Equal') base = '=';
  if (e.code === 'Minus') base = '-';
  // "+" is the character, however it is typed (Shift+= on US keyboards, its own key elsewhere, the numpad): the Shift
  // a layout needs to type it is not a modifier, or "+" would never zoom in. On the numpad Shift is a real modifier
  // (Shift with the numpad's + is Double Size).
  let shift = e.shiftKey;
  if (e.key === '+') { base = '+'; if (e.code !== 'NumpadAdd') shift = false; }
  const mac = isMac();
  // AltGr (reported as Ctrl+Alt on Windows) and macOS Option type characters such as \ ] } @ ≠:
  // when the key produced something other than its layout-stable base, it is text, not a shortcut.
  const ch = e.key;
  const altGr = !!e.getModifierState?.('AltGraph') || (!e.shiftKey && !e.metaKey && e.altKey && (mac ? !e.ctrlKey : e.ctrlKey));
  if (altGr && ch.length === 1 && ch !== ' ' && ch !== base) return null;
  const parts: string[] = [];
  // On macOS Cmd is Mod and Ctrl stays a separate modifier (Ctrl+A/E/K are native line-editing keys).
  if (e.metaKey && mac) parts.push('Mod');
  if (e.ctrlKey) parts.push(mac ? 'Ctrl' : 'Mod');
  if (e.altKey) parts.push('Alt');
  if (shift) parts.push('Shift');
  parts.push(base);
  // Canonical order used by bindings: Mod-Alt-Shift-key
  return parts.join('-');
}

/** A key name's modifiers and key; the key may itself be "-" ("-", "Shift--"). */
function splitKey(k: string): [string[], string] {
  if (k === '-') return [[], '-'];
  if (k.endsWith('--')) return [k.slice(0, -2).split('-').filter(Boolean), '-'];
  const parts = k.split('-'); const base = parts.pop()!; return [parts, base];
}

export function canonicalKey(k: string): string {
  const [parts, base] = splitKey(k);
  // Ctrl means Mod everywhere except macOS, where it is its own modifier.
  const mac = isMac();
  const mods = new Set(parts.map((p) => (p === 'Cmd' || p === 'Meta' || (p === 'Ctrl' && !mac) ? 'Mod' : p)));
  const out: string[] = [];
  for (const m of ['Mod', 'Ctrl', 'Alt', 'Shift']) if (mods.has(m)) out.push(m);
  out.push(base.length === 1 ? base.toLowerCase() : base);
  return out.join('-');
}

export function prettyKey(k: string): string {
  const mac = isMac();
  const [mods, base] = splitKey(k);
  return [...mods, base].map((p) => (p === 'Mod' ? (mac ? '⌘' : 'Ctrl') : p === 'Ctrl' && mac ? '⌃' : p === 'Alt' ? (mac ? '⌥' : 'Alt') : p === 'Shift' ? (mac ? '⇧' : 'Shift') : p.length === 1 ? p.toUpperCase() : p)).join(mac ? '' : '+');
}
