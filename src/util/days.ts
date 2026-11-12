/**
 * Calendar days from <input type="date"> ("YYYY-MM-DD") in local time. `new Date("2024-05-06")` is UTC midnight,
 * which is the evening before west of Greenwich, while picture dates (EXIF, file times) are local (W24).
 */
const pad = (n: number) => String(n).padStart(2, '0');
/** Local midnight at the start of the day; null for an empty or malformed value. */
export function dayStart(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(d.getTime()) ? null : d;
}
/** The last millisecond of the day, local time. */
export function dayEnd(s: string): Date | null {
  const d = dayStart(s);
  return d ? new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999) : null;
}
/** A date as "YYYY-MM-DD" of its local day (the value a date field shows). */
export const dayString = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
