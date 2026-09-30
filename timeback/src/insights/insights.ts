import type { Category, CategoryStats, DateKey, DayPart, Insights, Settings, TimeBlock } from '../domain/types.ts';
import { MINUTES_PER_DAY, SLOTS_PER_DAY, SLOT_MINUTES, dayPart, dayWindow, overlap, parseTime, toMinutes, windowSlots } from '../domain/time.ts';

/** Blocks of the same activity this close together count as one session. */
const SESSION_JOIN_GAP = 5;
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
      shareOfFreeTimeByWeekday: [0, 0, 0, 0, 0, 0, 0],
      slotProfile: new Array(SLOTS_PER_DAY).fill(0),
      typicalStartMinute: null,
      sessionsPerDay: 0,
      sessionsByPart: {},
    };
  }
  if (dates.length === 0) {
    applyPreferences(byCategory, categories);
    return { daysAnalyzed: 0, daysByWeekday: [0, 0, 0, 0, 0, 0, 0], coverage: 0, byCategory };
  }

  const committed = new Set(categories.filter((c) => c.flexibility !== 'flexible').map((c) => c.id));
  const starts: Record<string, number[]> = {};
  const sessionAcc: Record<string, { count: number; parts: Partial<Record<DayPart, { minutes: number; count: number }>> }> = {};
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
      if (!committed.has(categoryId)) {
        s.shareOfFreeTime += m / freeMinutes / dates.length;
        s.shareOfFreeTimeByWeekday[weekday]! += m / freeMinutes; // divided below
      }
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

    // Sessions: each category's blocks on this day, clipped to it, with touching ones joined.
    const spans: Record<string, Array<[number, number]>> = {};
    for (const b of blocks) {
      if (!byCategory[b.categoryId]) continue;
      const s = Math.max(ds, toMinutes(b.start));
      const e = Math.min(de, toMinutes(b.end));
      if (e > s) (spans[b.categoryId] ??= []).push([s, e]);
    }
    for (const [categoryId, list] of Object.entries(spans)) {
      list.sort((a, b) => a[0] - b[0]);
      const joined: Array<[number, number]> = [];
      for (const [s, e] of list) {
        const last = joined.at(-1);
        if (last && s - last[1] <= SESSION_JOIN_GAP) last[1] = Math.max(last[1], e);
        else joined.push([s, e]);
      }
      const acc = (sessionAcc[categoryId] ??= { count: 0, parts: {} });
      for (const [s, e] of joined) {
        const part = (acc.parts[dayPart(s - ds)] ??= { minutes: 0, count: 0 });
        part.minutes += e - s;
        part.count++;
        acc.count++;
      }
    }
  }

  for (const [categoryId, acc] of Object.entries(sessionAcc)) {
    const s = byCategory[categoryId]!;
    s.sessionsPerDay = acc.count / dates.length;
    for (const [part, p] of Object.entries(acc.parts) as Array<[DayPart, { minutes: number; count: number }]>) {
      s.sessionsByPart[part] = { avgMinutes: p.minutes / p.count, perDay: p.count / dates.length };
    }
  }

  for (const s of Object.values(byCategory)) {
    s.avgMinutesByWeekday = s.avgMinutesByWeekday.map((m, wd) => (weekdayCount[wd] ? m / weekdayCount[wd]! : 0));
    s.shareOfFreeTimeByWeekday = s.shareOfFreeTimeByWeekday.map((x, wd) => (weekdayCount[wd] ? x / weekdayCount[wd]! : 0));
    const st = starts[s.categoryId];
    s.typicalStartMinute = st?.length ? circularMeanMinute(st) : null;
  }

  applyPreferences(byCategory, categories);
  return { daysAnalyzed: dates.length, daysByWeekday: weekdayCount, coverage: coverageSum / dates.length, byCategory };
}

/** How strongly a stated preferred time counts, relative to "did it here every day" (1.0). */
export const PREFERENCE_WEIGHT = 0.5;

/**
 * Blend what the user said into what was learned. A new activity has no
 * history, so its preferred times are the only signal for when it happens;
 * once it's logged, real habits add to (never erase) the stated preference.
 */
function applyPreferences(byCategory: Record<string, CategoryStats>, categories: Category[]) {
  for (const c of categories) {
    const s = byCategory[c.id];
    if (!s || !c.preferredTimes?.length) continue;
    for (const w of c.preferredTimes) {
      for (const i of windowSlots(w)) s.slotProfile[i] = Math.max(s.slotProfile[i]!, PREFERENCE_WEIGHT);
    }
    s.typicalStartMinute ??= parseTime(c.preferredTimes[0]!.start);
  }
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
