import type { Category, CategoryStats, DateKey, Insights, Settings, TimeBlock } from '../domain/types.ts';
import { MINUTES_PER_DAY, SLOTS_PER_DAY, SLOT_MINUTES, dayWindow, overlap, toMinutes } from '../domain/time.ts';
import { coverage, minutesByCategory } from '../calendar/dayView.ts';

/**
 * Learns the user's typical day from logged history. This is the "after a
 * while" part: callers should pass only well-logged days (see wellLoggedDays).
 */
export function analyze(blocks: TimeBlock[], dates: DateKey[], categories: Category[]): Insights {
  const byCategory: Record<string, CategoryStats> = {};
  for (const c of categories) {
    byCategory[c.id] = {
      categoryId: c.id,
      avgMinutesPerDay: 0,
      avgMinutesByWeekday: [0, 0, 0, 0, 0, 0, 0],
      shareOfFreeTime: 0,
      slotProfile: new Array(SLOTS_PER_DAY).fill(0),
      typicalStartMinute: null,
    };
  }
  if (dates.length === 0) return { daysAnalyzed: 0, coverage: 0, byCategory };

  const committed = new Set(categories.filter((c) => c.flexibility !== 'flexible').map((c) => c.id));
  const starts: Record<string, number[]> = {};
  const weekdayCount = [0, 0, 0, 0, 0, 0, 0];
  let coverageSum = 0;

  for (const date of dates) {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    weekdayCount[weekday]!++;
    coverageSum += coverage(blocks, date);

    const minutes = minutesByCategory(blocks, date);
    const committedMinutes = Object.entries(minutes).reduce((s, [id, m]) => s + (committed.has(id) ? m : 0), 0);
    const freeMinutes = Math.max(1, MINUTES_PER_DAY - committedMinutes);
    for (const [categoryId, m] of Object.entries(minutes)) {
      const s = byCategory[categoryId];
      if (!s) continue;
      s.avgMinutesPerDay += m / dates.length;
      s.avgMinutesByWeekday[weekday]! += m; // divided below
      if (!committed.has(categoryId)) s.shareOfFreeTime += m / freeMinutes / dates.length;
    }

    const [ds, de] = dayWindow(date);
    const firstStart: Record<string, number> = {};
    for (const b of blocks) {
      const s = byCategory[b.categoryId];
      if (!s) continue;
      const [bs, be] = [toMinutes(b.start), toMinutes(b.end)];
      if (be <= ds || bs >= de) continue;
      for (let i = Math.floor((Math.max(bs, ds) - ds) / SLOT_MINUTES); i * SLOT_MINUTES + ds < Math.min(be, de); i++) {
        const slotStart = ds + i * SLOT_MINUTES;
        s.slotProfile[i]! += overlap(slotStart, slotStart + SLOT_MINUTES, bs, be) / SLOT_MINUTES / dates.length;
      }
      if (bs >= ds) firstStart[b.categoryId] = Math.min(firstStart[b.categoryId] ?? bs - ds, bs - ds);
    }
    for (const [categoryId, m] of Object.entries(firstStart)) (starts[categoryId] ??= []).push(m);
  }

  for (const s of Object.values(byCategory)) {
    s.avgMinutesByWeekday = s.avgMinutesByWeekday.map((m, wd) => (weekdayCount[wd] ? m / weekdayCount[wd]! : 0));
    const st = starts[s.categoryId];
    s.typicalStartMinute = st?.length ? circularMeanMinute(st) : null;
  }

  return { daysAnalyzed: dates.length, coverage: coverageSum / dates.length, byCategory };
}

/**
 * Days logged thoroughly enough to learn from. Partially logged days are
 * excluded so missing data isn't mistaken for "spent 0 minutes on it".
 */
export function wellLoggedDays(blocks: TimeBlock[], dates: DateKey[], settings: Settings): DateKey[] {
  return dates.filter((d) => coverage(blocks, d) >= settings.minDayCoverage);
}

/** Mean time-of-day that handles wrap-around (23:30 and 00:30 average to 00:00, not 12:00). */
export function circularMeanMinute(minutes: number[]): number {
  let x = 0;
  let y = 0;
  for (const m of minutes) {
    const a = (m / MINUTES_PER_DAY) * 2 * Math.PI;
    x += Math.cos(a);
    y += Math.sin(a);
  }
  const m = (Math.atan2(y, x) / (2 * Math.PI)) * MINUTES_PER_DAY;
  return Math.round((m + MINUTES_PER_DAY) % MINUTES_PER_DAY);
}
