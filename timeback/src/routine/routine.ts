import type {
  DateKey,
  Goal,
  OptimalDay,
  Routine,
  RoutineBlock,
  RoutineGoalCheck,
  TimeBlock,
  TimeOfDay,
} from '../domain/types.ts';
import { MINUTES_PER_DAY, dayWindow, formatTime, fromMinutes, overlap, parseTime, toMinutes } from '../domain/time.ts';
import { isMet } from '../goals/goals.ts';

export { formatTime, parseTime };

/**
 * Pure functions for the routine calendar. A routine lives on a 24h circle:
 * each block is an arc (start minute, length) that may wrap past midnight.
 */

interface Arc {
  s: number; // 0..1439
  len: number; // 1..1440
}

function arcOf(b: Pick<RoutineBlock, 'start' | 'end'>): Arc {
  const s = parseTime(b.start);
  const e = parseTime(b.end);
  if (s === e) throw new Error('A routine block must be shorter than 24 hours and longer than 0');
  return { s, len: (e - s + MINUTES_PER_DAY) % MINUTES_PER_DAY };
}

export function blockMinutes(b: Pick<RoutineBlock, 'start' | 'end'>): number {
  return arcOf(b).len;
}

/** Parts of `a` not covered by `cut`, as arcs. */
function subtract(a: Arc, cut: Arc): Arc[] {
  // Unroll: a is [a.s, a.s+len) on a line; cut repeats every 1440 minutes.
  let pieces: Array<[number, number]> = [[a.s, a.s + a.len]];
  for (const k of [-1, 0, 1, 2]) {
    const cs = cut.s + k * MINUTES_PER_DAY;
    const ce = cs + cut.len;
    pieces = pieces.flatMap(([ps, pe]): Array<[number, number]> => {
      if (ce <= ps || cs >= pe) return [[ps, pe]];
      const out: Array<[number, number]> = [];
      if (cs > ps) out.push([ps, cs]);
      if (ce < pe) out.push([ce, pe]);
      return out;
    });
  }
  return pieces.map(([ps, pe]) => ({ s: ps % MINUTES_PER_DAY, len: pe - ps }));
}

/** Sort by start and merge touching blocks of the same activity (including across midnight). */
export function normalize(blocks: RoutineBlock[], keepId?: string): RoutineBlock[] {
  const sorted = [...blocks].sort((a, b) => parseTime(a.start) - parseTime(b.start));
  // Edited and generated blocks stay separate so regeneration can't absorb generated time into "edited".
  const same = (a: RoutineBlock, b: RoutineBlock) =>
    a.categoryId === b.categoryId && (a.title ?? '') === (b.title ?? '') && !!a.edited === !!b.edited && a.end === b.start;
  const merge = (a: RoutineBlock, b: RoutineBlock): RoutineBlock => ({
    ...a,
    id: b.id === keepId ? b.id : a.id,
    end: b.end,
  });
  const out: RoutineBlock[] = [];
  for (const b of sorted) {
    const last = out.at(-1);
    if (last && same(last, b)) out[out.length - 1] = merge(last, b);
    else out.push(b);
  }
  // Wrap-around: last block ends where the first begins (e.g. 23:00–00:00 + 00:00–07:00).
  // Skip if merging would make one block span the full 24h (not representable).
  if (out.length > 1 && same(out.at(-1)!, out[0]!) && out.at(-1)!.start !== out[0]!.end) {
    out.push(merge(out.pop()!, out.shift()!));
  }
  return out.sort((a, b) => parseTime(a.start) - parseTime(b.start));
}

/**
 * Put `block` into the routine. It wins wherever it overlaps other blocks;
 * those are trimmed or split around it. This is the one editing primitive:
 * add, move, resize and change-activity are all "place this block".
 */
export function placeBlock(routine: Routine, block: RoutineBlock, newId: () => string): Routine {
  const cut = arcOf(block);
  const others: RoutineBlock[] = [];
  for (const b of routine.blocks) {
    if (b.id === block.id) continue;
    subtract(arcOf(b), cut).forEach((p, i) => {
      others.push({ ...b, id: i === 0 ? b.id : newId(), start: formatTime(p.s), end: formatTime(p.s + p.len) });
    });
  }
  return { ...routine, blocks: normalize([...others, { ...block, edited: true }], block.id) };
}

export function removeBlock(routine: Routine, blockId: string): Routine {
  return { ...routine, blocks: routine.blocks.filter((b) => b.id !== blockId) };
}

/** Convert an optimizer result into routine blocks (dates dropped, midnight seam merged). */
export function blocksFromOptimalDay(plan: OptimalDay, newId: () => string): RoutineBlock[] {
  const [ds] = dayWindow(plan.date);
  return normalize(
    plan.blocks.map((b) => ({
      id: newId(),
      start: formatTime(toMinutes(b.start) - ds),
      end: formatTime(toMinutes(b.end) - ds),
      categoryId: b.categoryId,
      ...(b.title ? { title: b.title } : {}),
    })),
  );
}

/**
 * Routine blocks as calendar blocks on `date`. A routine is the clock face of
 * its weekday, so a wrapping block (sleep 23:00–07:00) becomes that date's
 * 00:00–07:00 and 23:00–24:00. Every date uses only its own routine: no gaps
 * or double-booking where a weekday routine meets a weekend routine.
 */
export function instantiate(blocks: RoutineBlock[], date: DateKey): TimeBlock[] {
  const [ds] = dayWindow(date);
  return blocks.flatMap((b) => {
    const { s, len } = arcOf(b);
    const parts: Array<[number, number]> =
      s + len <= MINUTES_PER_DAY ? [[s, s + len]] : [[0, s + len - MINUTES_PER_DAY], [s, MINUTES_PER_DAY]];
    return parts.map(([ps, pe], i) => ({
      id: `routine:${b.id}:${date}#${i}`,
      start: fromMinutes(ds + ps),
      end: fromMinutes(ds + pe),
      categoryId: b.categoryId,
      ...(b.title ? { title: b.title } : {}),
      source: 'user' as const,
    }));
  });
}

export function routineForWeekday(routines: Routine[], weekday: number): Routine | undefined {
  return routines.find((r) => r.weekdays.includes(weekday));
}

/** The plan for one date: its weekday's routine with the calendar's fixed events cut in on top. */
export function planForDate(routines: Routine[], date: DateKey, calendarFixed: TimeBlock[]): TimeBlock[] {
  const r = routineForWeekday(routines, new Date(`${date}T00:00:00Z`).getUTCDay());
  const fixed = calendarFixed.map((b) => [toMinutes(b.start), toMinutes(b.end)] as const);
  const out: TimeBlock[] = [];
  for (const b of r ? instantiate(r.blocks, date) : []) {
    let pieces: Array<[number, number]> = [[toMinutes(b.start), toMinutes(b.end)]];
    for (const [fs, fe] of fixed) {
      pieces = pieces.flatMap(([ps, pe]): Array<[number, number]> =>
        fe <= ps || fs >= pe
          ? [[ps, pe]]
          : [...(fs > ps ? [[ps, fs] as [number, number]] : []), ...(fe < pe ? [[fe, pe] as [number, number]] : [])],
      );
    }
    pieces.forEach(([ps, pe], i) => out.push({ ...b, id: `${b.id}.${i}`, start: fromMinutes(ps), end: fromMinutes(pe) }));
  }
  return [...out, ...calendarFixed].sort((a, b) => a.start.localeCompare(b.start));
}

export function minutesByCategory(routine: Routine): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of routine.blocks) out[b.categoryId] = (out[b.categoryId] ?? 0) + blockMinutes(b);
  return out;
}

export function unplannedMinutes(routine: Routine): number {
  return MINUTES_PER_DAY - routine.blocks.reduce((sum, b) => sum + blockMinutes(b), 0);
}

/**
 * Would following the routines meet the goals? Daily goals are checked per
 * routine; weekly goals add up every routine × the weekdays it covers.
 */
export function checkGoals(routine: Routine, allRoutines: Routine[], goals: Goal[]): RoutineGoalCheck[] {
  return goals.map((g) => {
    const planned =
      g.period === 'day'
        ? (minutesByCategory(routine)[g.categoryId] ?? 0)
        : allRoutines.reduce((sum, r) => sum + (minutesByCategory(r)[g.categoryId] ?? 0) * r.weekdays.length, 0);
    return { goalId: g.id, label: g.label, plannedMinutes: planned, targetMinutes: g.targetMinutes, met: isMet(g, planned) };
  });
}

/** Share of the logged minutes of `date` that matched the plan (0–1), or null if nothing overlaps. */
export function adherence(actual: TimeBlock[], plan: TimeBlock[], date: DateKey): number | null {
  const [ds, de] = dayWindow(date);
  let matched = 0;
  let compared = 0;
  for (const a of actual) {
    for (const p of plan) {
      const m = overlap(Math.max(ds, toMinutes(a.start)), Math.min(de, toMinutes(a.end)), toMinutes(p.start), toMinutes(p.end));
      compared += m;
      if (a.categoryId === p.categoryId) matched += m;
    }
  }
  return compared ? matched / compared : null;
}
