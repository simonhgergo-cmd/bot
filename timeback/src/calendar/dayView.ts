import type { DateKey, Gap, TimeBlock } from '../domain/types.ts';
import { dayWindow, fromMinutes, overlap, toMinutes } from '../domain/time.ts';

/**
 * Pure functions over the main (actual) calendar. Blocks may cross midnight
 * (sleep usually does); everything here clips them to the requested day.
 */

/** Minutes per category within `date`, overlapping blocks counted once per block. */
export function minutesByCategory(blocks: TimeBlock[], date: DateKey): Record<string, number> {
  const [ds, de] = dayWindow(date);
  const out: Record<string, number> = {};
  for (const b of blocks) {
    const m = overlap(ds, de, toMinutes(b.start), toMinutes(b.end));
    if (m > 0) out[b.categoryId] = (out[b.categoryId] ?? 0) + m;
  }
  return out;
}

/** Unlogged stretches of `date` that are at least `minGapMinutes` long. */
export function findGaps(blocks: TimeBlock[], date: DateKey, minGapMinutes: number, until?: number): Gap[] {
  const [ds, dayEnd] = dayWindow(date);
  const de = Math.min(dayEnd, until ?? dayEnd);
  const intervals = mergeIntervals(
    blocks.map((b) => [Math.max(ds, toMinutes(b.start)), Math.min(de, toMinutes(b.end))] as [number, number]),
  );

  const gaps: Gap[] = [];
  let cursor = ds;
  for (const [s, e] of intervals) {
    if (s - cursor >= minGapMinutes) gaps.push({ start: fromMinutes(cursor), end: fromMinutes(s) });
    cursor = Math.max(cursor, e);
  }
  if (de - cursor >= minGapMinutes) gaps.push({ start: fromMinutes(cursor), end: fromMinutes(de) });
  return gaps;
}

/** Share of `date` covered by at least one block (0–1). */
export function coverage(blocks: TimeBlock[], date: DateKey): number {
  const [ds, de] = dayWindow(date);
  const covered = mergeIntervals(
    blocks.map((b) => [Math.max(ds, toMinutes(b.start)), Math.min(de, toMinutes(b.end))] as [number, number]),
  ).reduce((sum, [s, e]) => sum + (e - s), 0);
  return covered / (de - ds);
}

export function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [s, e] of sorted) {
    const last = out.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}
