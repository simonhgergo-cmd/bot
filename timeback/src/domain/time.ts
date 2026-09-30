import type { DateKey, DayPart, LocalDateTime, TimeOfDay, TimeWindow } from './types.ts';

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

const TIME_STEP = 5;

/** `HH:mm` → minutes after midnight. Times must be multiples of 5 minutes. */
export function parseTime(t: TimeOfDay): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t);
  if (!m) throw new Error(`Invalid time of day: ${t}`);
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  if (minutes % TIME_STEP) throw new Error(`Times must be multiples of ${TIME_STEP} minutes: ${t}`);
  return minutes;
}

export function formatTime(minute: number): TimeOfDay {
  const m = ((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Slot indexes (0..SLOTS_PER_DAY-1) covered by a time window; wraps past midnight when end <= start. */
export function windowSlots(w: TimeWindow): number[] {
  const s = parseTime(w.start);
  const len = (parseTime(w.end) - s + MINUTES_PER_DAY) % MINUTES_PER_DAY || MINUTES_PER_DAY;
  const out: number[] = [];
  for (let m = s; m < s + len; m += SLOT_MINUTES) out.push(Math.floor((m % MINUTES_PER_DAY) / SLOT_MINUTES));
  return out;
}

/** Part of the day a minute-of-day falls in (for talking about habits). */
export function dayPart(minuteOfDay: number): DayPart {
  const m = ((minuteOfDay % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  if (m < 5 * 60 || m >= 22 * 60) return 'night';
  if (m < 10 * 60 + 30) return 'morning';
  if (m < 15 * 60) return 'midday';
  if (m < 18 * 60) return 'afternoon';
  return 'evening';
}

/** Overlap in minutes between [aStart, aEnd) and [bStart, bEnd). */
export function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}
