import type { DateKey, LocalDateTime } from './types.ts';

export const MINUTES_PER_DAY = 24 * 60;
/** Resolution of learned time-of-day profiles and of the optimal-day grid. */
export const SLOT_MINUTES = 15;
export const SLOTS_PER_DAY = MINUTES_PER_DAY / SLOT_MINUTES;

/** Minutes since 1970-01-01T00:00 on the wall clock (no timezone involved). */
export function toMinutes(t: LocalDateTime): number {
  const ms = Date.parse(`${t}:00Z`);
  if (Number.isNaN(ms)) throw new Error(`Invalid local datetime: ${t}`);
  return ms / 60_000;
}

export function fromMinutes(m: number): LocalDateTime {
  return new Date(m * 60_000).toISOString().slice(0, 16);
}

export function startOfDay(date: DateKey): LocalDateTime {
  return `${date}T00:00`;
}

export function addDays(date: DateKey, n: number): DateKey {
  return fromMinutes(toMinutes(startOfDay(date)) + n * MINUTES_PER_DAY).slice(0, 10);
}

/** [start, end) of a calendar day in epoch minutes. */
export function dayWindow(date: DateKey): [number, number] {
  const s = toMinutes(startOfDay(date));
  return [s, s + MINUTES_PER_DAY];
}

/** Monday of the week containing `date`. */
export function weekStart(date: DateKey): DateKey {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

export function dateRange(from: DateKey, to: DateKey): DateKey[] {
  const out: DateKey[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function hhmm(t: LocalDateTime): string {
  return t.slice(11, 16);
}

export function formatDuration(minutes: number): string {
  const sign = minutes < 0 ? '-' : '';
  const abs = Math.abs(Math.round(minutes));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${h ? `${h}h` : ''}${m || !h ? `${m}m` : ''}`;
}

/** Overlap in minutes between [aStart, aEnd) and [bStart, bEnd). */
export function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}
