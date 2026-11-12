/** Date fields are local calendar days (W24): a picture taken on the evening of the 5th is not in a filter "from the 6th". */
import { it, expect, afterAll } from 'vitest';
const tz = process.env.TZ;
afterAll(() => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; });

it('day fields parse and print in local time, west and east of Greenwich', async () => {
  const { dayStart, dayEnd, dayString } = await import('../../src/util/days');
  for (const zone of ['America/Los_Angeles', 'Asia/Tokyo', 'UTC']) {
    process.env.TZ = zone;
    const from = dayStart('2024-05-06')!, to = dayEnd('2024-05-06')!;
    expect([from.getFullYear(), from.getMonth(), from.getDate(), from.getHours()], zone).toEqual([2024, 4, 6, 0]);
    expect([to.getDate(), to.getHours(), to.getMinutes()], zone).toEqual([6, 23, 59]);
    const eveningBefore = new Date(2024, 4, 5, 21, 30), lateThatDay = new Date(2024, 4, 6, 22, 0);
    expect(eveningBefore < from && lateThatDay >= from && lateThatDay <= to, zone).toBe(true);
    expect(dayString(from), zone).toBe('2024-05-06');
    expect(dayString(new Date(2024, 0, 1, 0, 30)), zone).toBe('2024-01-01');
  }
  expect(dayStart('')).toBeNull(); expect(dayStart('2024-5-6')).toBeNull();
});
