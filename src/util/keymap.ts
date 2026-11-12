/**
 * The user's key map: canonical key → what it does now.
 *   "<command id>"          the key runs that command (added in Customize Keyboard);
 *   "-<id> -<id2>"          those commands no longer have this key among their defaults; any other command whose
 *                           default it is keeps it (Space: Next Picture, and Pause while a slideshow runs);
 *   ""                      the key does nothing (an older form of removal, which took the key from every command).
 */
export type KeyMap = Record<string, string>;

/** The commands a key-map value takes the key away from, or null when it is not a removal list. */
export const removedFrom = (v: string | undefined): Set<string> | null => (v && v.startsWith('-') ? new Set(v.split(/\s+/).filter((x) => x.startsWith('-')).map((x) => x.slice(1))) : null);

/** The commands a key runs, best first, from the commands whose default it is and the user's key map. */
export function keyCommands(key: string, defaults: string[], map: KeyMap): string[] {
  const v = map[key];
  if (v === undefined) return defaults;
  if (v === '') return [];
  const removed = removedFrom(v);
  if (removed) return defaults.filter((id) => !removed.has(id));
  return [v, ...defaults.filter((x) => x !== v)];
}

/** Takes `key` away from command `id` only. `isDefault`: the key is one of the command's defaults. */
export function removeKey(map: KeyMap, key: string, id: string, isDefault: boolean): void {
  if (map[key] === id) delete map[key];
  if (!isDefault) return;
  const removed = removedFrom(map[key]) || new Set<string>();
  if (map[key] !== undefined && !removedFrom(map[key])) return; // the key is assigned to another command, or to none
  removed.add(id);
  map[key] = [...removed].map((x) => `-${x}`).join(' ');
}

/** Gives command `id` its default keys back and drops the keys added to it. */
export function resetCommand(map: KeyMap, id: string, defaults: string[]): void {
  for (const k of Object.keys(map)) {
    const removed = removedFrom(map[k]);
    if (map[k] === id) delete map[k];
    else if (removed && removed.delete(id)) { if (removed.size) map[k] = [...removed].map((x) => `-${x}`).join(' '); else delete map[k]; }
    else if (map[k] === '' && defaults.includes(k)) delete map[k];
  }
}
