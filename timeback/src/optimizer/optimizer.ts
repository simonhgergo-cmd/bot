import type {
  Category,
  DateKey,
  Goal,
  Insights,
  OptimalDay,
  Settings,
  Suggestion,
  TimeBlock,
} from '../domain/types.ts';
import { MINUTES_PER_DAY, dayWindow, formatDuration, fromMinutes, toMinutes } from '../domain/time.ts';
import { minutesByCategory } from '../calendar/dayView.ts';
import { dailyTarget } from '../goals/goals.ts';

export interface OptimizerInput {
  date: DateKey;
  categories: Category[];
  goals: Goal[];
  insights: Insights;
  /** Blocks already on the calendar for `date` that must not move (locked, or in a `fixed` category). */
  fixedBlocks: TimeBlock[];
  settings: Settings;
  /**
   * Categories the user said "Not for me" to: planned at their usual level,
   * with no goal, reduce or reclaim changes (still at least any locked time).
   */
  keepAsUsual?: string[];
}

/**
 * Produces the second calendar: the day the app thinks would be optimal.
 * Kept behind an interface so the greedy heuristic below can later be swapped
 * for a constraint solver or an LLM-backed planner without touching callers.
 */
export interface Optimizer {
  plan(input: OptimizerInput): OptimalDay;
}

const SLOT = 15;
const SLOTS = MINUTES_PER_DAY / SLOT;
const DEFAULT_ANCHOR_MINUTE = 12 * 60;
/** Shortest block the optimizer creates on purpose (unless the whole budget is smaller). */
const MIN_CHUNK = 30;
const MIN_CHUNK_SLOTS = MIN_CHUNK / SLOT;

type Driver = 'goal' | 'reduce' | 'reclaim' | 'squeeze';

/**
 * Two phases:
 *  1. Budget — decide minutes per category: start from the user's typical day,
 *     enforce goals, trim disliked activities, give the freed time to loved ones.
 *  2. Place — lay budgets onto a 15-minute grid around fixed commitments, each
 *     category as close as possible to when the user usually does it.
 */
export class GreedyOptimizer implements Optimizer {
  plan(rawInput: OptimizerInput): OptimalDay {
    // Archived activities keep their history but are never planned; their usual time becomes free.
    const input = { ...rawInput, categories: rawInput.categories.filter((c) => !c.archived) };
    const { budgets, drivers, goalFor, baseline } = this.budget(input);
    const blocks = this.place(input, budgets);
    const suggestions = this.explain(input, baseline, budgets, drivers, goalFor);
    const reclaimedMinutes = Math.round(
      sum(
        input.categories
          .filter((c) => c.enjoyment === 'loves')
          .map((c) => Math.max(0, (budgets[c.id] ?? 0) - (baseline[c.id] ?? 0))),
      ),
    );
    return { date: input.date, blocks, suggestions, reclaimedMinutes };
  }

  // -- Phase 1: budgets -------------------------------------------------------

  private budget(input: OptimizerInput) {
    const { date, categories, goals, insights, fixedBlocks, settings } = input;
    const lockedMinutes = minutesByCategory(fixedBlocks, date);
    const baseline = typicalDay(input);
    const budgets: Record<string, number> = {};
    const drivers: Record<string, Driver> = {};
    const goalFor: Record<string, Goal> = {};
    const floor: Record<string, number> = {}; // never squeeze below this

    const keep = new Set(input.keepAsUsual ?? []);
    for (const c of categories) {
      const base = baseline[c.id] ?? 0;
      const locked = lockedMinutes[c.id] ?? 0;

      if (c.flexibility === 'fixed' || keep.has(c.id)) {
        budgets[c.id] = Math.max(base, locked);
        floor[c.id] = budgets[c.id]!;
        continue;
      }

      let target = base;
      let min = locked;
      const catGoals = goals.filter((g) => g.active && g.categoryId === c.id);
      for (const g of catGoals) {
        // Round toward the goal so grid rounding can't break it (150 min/week → 30, not 15, a day),
        // and "at least" goals up to whole sessions (a 45-min guitar session, not 30 min of one).
        const unit = g.comparison === 'atLeast' ? chunkMinutes(c) : SLOT;
        const t = g.comparison === 'atLeast' ? Math.ceil(dailyTarget(g) / unit) * unit : Math.floor(dailyTarget(g) / SLOT) * SLOT;
        if (g.comparison === 'atLeast' && t > target) {
          target = t;
          drivers[c.id] = 'goal';
          goalFor[c.id] = g;
        }
        if (g.comparison === 'atLeast') min = Math.max(min, t);
        if (g.comparison === 'atMost' && t < target) {
          target = t;
          drivers[c.id] = 'goal';
          goalFor[c.id] = g;
        }
      }
      const hasCap = catGoals.some((g) => g.comparison === 'atMost');
      if (!hasCap && c.enjoyment === 'dislikes' && c.flexibility === 'flexible' && base > 0) {
        target = base * (1 - settings.maxReductionShare);
        drivers[c.id] ??= 'reduce';
      }
      budgets[c.id] = Math.max(target, locked);
      floor[c.id] = min;
    }

    let leftover = MINUTES_PER_DAY - sum(Object.values(budgets));

    if (leftover > 0) {
      // Freed time goes to what the user loves, weighted by how much they already
      // do it, handed out in whole chunks so nobody gets a useless 15-minute crumb.
      const loved = categories.filter((c) => c.enjoyment === 'loves' && c.flexibility !== 'fixed' && !keep.has(c.id));
      // A new activity has no history; its stated session length stands in for it.
      const weight = (c: Category) => Math.max(baseline[c.id] ?? 0, c.sessionMinutes ?? 0, SLOT);
      const extra: Record<string, number> = {};
      let remaining = Math.floor(leftover / SLOT) * SLOT;
      while (loved.length && remaining > 0) {
        // D'Hondt: next chunk (one session) to whoever has the most weight per minute already received.
        const fitting = loved.filter((c) => chunkMinutes(c) <= remaining);
        if (fitting.length === 0) {
          // A remainder smaller than any session tops up whoever already got the most.
          const top = [...loved].sort((a, b) => (extra[b.id] ?? 0) - (extra[a.id] ?? 0))[0]!;
          extra[top.id] = (extra[top.id] ?? 0) + remaining;
          break;
        }
        const quota = (c: Category) => weight(c) / ((extra[c.id] ?? 0) + chunkMinutes(c));
        const next = fitting.sort((a, b) => quota(b) - quota(a))[0]!;
        extra[next.id] = (extra[next.id] ?? 0) + chunkMinutes(next);
        remaining -= chunkMinutes(next);
      }
      for (const c of loved) {
        if (!extra[c.id]) continue;
        budgets[c.id]! += extra[c.id]!;
        drivers[c.id] ??= 'reclaim';
      }
      if (loved.length) leftover = 0;
    } else if (leftover < 0) {
      // Over-committed (e.g. ambitious goals): shrink the least valuable time first.
      // Activities the user asked to keep as usual are only touched as a last resort.
      const tiers: Array<(c: Category) => boolean> = [
        (c) => !keep.has(c.id) && c.flexibility === 'flexible' && c.enjoyment === 'dislikes',
        (c) => !keep.has(c.id) && c.flexibility === 'flexible' && c.enjoyment === 'neutral',
        (c) => !keep.has(c.id) && c.flexibility === 'flexible' && c.enjoyment === 'loves',
        (c) => !keep.has(c.id) && c.flexibility === 'essential',
      ];
      for (const inTier of tiers) {
        if (leftover >= 0) break;
        const tier = categories.filter(inTier);
        const slack = tier.map((c) => Math.max(0, budgets[c.id]! - floor[c.id]!));
        const totalSlack = sum(slack);
        if (totalSlack === 0) continue;
        const cut = Math.min(-leftover, totalSlack);
        tier.forEach((c, i) => {
          budgets[c.id]! -= (cut * slack[i]!) / totalSlack;
          drivers[c.id] ??= 'squeeze';
        });
        leftover += cut;
      }
    }

    for (const id of Object.keys(budgets)) budgets[id] = Math.round(budgets[id]! / SLOT) * SLOT;

    // A loved activity the user said when they'd like to do (typically one they
    // just added) should get at least one session, even when goals used up the
    // freed time. Take it whole from one neutral or disliked free-time activity
    // that can spare it without going below its floor or leaving a sliver.
    for (const c of categories) {
      if (c.enjoyment !== 'loves' || !c.preferredTimes?.length || keep.has(c.id) || c.flexibility === 'fixed') continue;
      const need = chunkMinutes(c) - (budgets[c.id] ?? 0);
      if (need <= 0) continue;
      const donor = categories
        .filter((d) => d.flexibility === 'flexible' && d.enjoyment !== 'loves' && !keep.has(d.id))
        .filter((d) => {
          const left = (budgets[d.id] ?? 0) - need;
          return left >= (floor[d.id] ?? 0) && (left === 0 || left >= MIN_CHUNK);
        })
        // Disliked first, then whoever has the most time to spare.
        .sort((a, b) => Number(b.enjoyment === 'dislikes') - Number(a.enjoyment === 'dislikes') || budgets[b.id]! - budgets[a.id]!)[0];
      if (!donor) continue;
      budgets[donor.id]! -= need;
      budgets[c.id] = (budgets[c.id] ?? 0) + need;
      drivers[c.id] ??= 'reclaim';
      drivers[donor.id] ??= 'reduce';
    }
    return { budgets, drivers, goalFor, baseline };
  }

  // -- Phase 2: placement -----------------------------------------------------

  private place({ date, categories, insights, fixedBlocks }: OptimizerInput, budgets: Record<string, number>) {
    const [ds, de] = dayWindow(date);
    const grid: Array<string | null> = new Array(SLOTS).fill(null);
    const locked: boolean[] = new Array(SLOTS).fill(false);

    for (const b of fixedBlocks) {
      const s = Math.max(ds, toMinutes(b.start));
      const e = Math.min(de, toMinutes(b.end));
      for (let i = Math.floor((s - ds) / SLOT); i < Math.ceil((e - ds) / SLOT); i++) {
        grid[i] = b.categoryId;
        locked[i] = true;
      }
    }

    // Placement order = priority for the best time slots. Free-time activities
    // with a stated preferred time (explicit intent) go before ones placed by habit alone.
    const rank = (c: Category) =>
      c.flexibility === 'fixed' ? 0
      : c.flexibility === 'essential' ? 1
      : c.preferredTimes?.length ? 1.5
      : c.enjoyment === 'loves' ? 3
      : 2;
    const ordered = [...categories].sort((a, b) => rank(a) - rank(b));

    const needs: Record<string, number> = {};
    for (const c of ordered) needs[c.id] = (budgets[c.id] ?? 0) / SLOT - grid.filter((g) => g === c.id).length;
    let holesFilled = false;

    for (const c of ordered) {
      if (!holesFilled && rank(c) >= 2) {
        // Commitments are placed; hand each small leftover hole to one free-time
        // activity whole, instead of letting the last activity inherit the scraps.
        fillSmallHoles(grid, ordered.filter((x) => rank(x) >= 2), needs, insights);
        holesFilled = true;
      }
      const stats = insights.byCategory[c.id];
      const profile = stats?.slotProfile ?? [];
      const anchor = Math.round((stats?.typicalStartMinute ?? DEFAULT_ANCHOR_MINUTE) / SLOT) % SLOTS;
      if ((needs[c.id] ?? 0) <= 0) continue;
      // One chunk per time of day the user usually does this (meals: breakfast + dinner).
      const queue = splitIntoChunks(needs[c.id]!, episodes(profile), anchor, chunkMinutes(c) / SLOT);
      while (queue.length) {
        const { size, center } = queue.shift()!;
        const placed = placeChunk(grid, c.id, size, center, profile);
        needs[c.id]! -= placed;
        if (placed === 0) break; // day is full
        if (placed < size) queue.unshift({ size: size - placed, center });
      }
    }

    // Rounding can leave stray empty slots; let the neighbouring planned activity absorb them.
    for (let pass = 0; pass < SLOTS && grid.includes(null); pass++) {
      for (let i = 0; i < SLOTS; i++) {
        if (grid[i] !== null) continue;
        const prev = (i + SLOTS - 1) % SLOTS;
        const next = (i + 1) % SLOTS;
        const donor = !locked[prev] && grid[prev] ? prev : !locked[next] && grid[next] ? next : -1;
        if (donor !== -1) grid[i] = grid[donor]!;
      }
    }

    // Reorder neighbouring free-time blocks when that joins pieces of the same
    // activity ([friends][phone][friends] → [phone][friends friends]). Minutes are unchanged.
    const movable = new Set(ordered.filter((c) => rank(c) >= 2).map((c) => c.id));
    joinPieces(grid, locked, movable);

    const out: OptimalDay['blocks'] = fixedBlocks.map((b) => ({
      start: fromMinutes(Math.max(ds, toMinutes(b.start))),
      end: fromMinutes(Math.min(de, toMinutes(b.end))),
      categoryId: b.categoryId,
      ...(b.title ? { title: b.title } : {}),
      origin: 'fixed' as const,
    }));
    for (let i = 0; i < SLOTS; ) {
      const id = grid[i];
      let j = i + 1;
      while (j < SLOTS && grid[j] === id && !locked[j] && !locked[i]) j++;
      if (id !== null && id !== undefined && !locked[i]) {
        out.push({ start: fromMinutes(ds + i * SLOT), end: fromMinutes(ds + j * SLOT), categoryId: id, origin: 'planned' });
      }
      i = j;
    }
    return out.sort((a, b) => a.start.localeCompare(b.start));
  }

  // -- Explanations -----------------------------------------------------------

  private explain(
    { categories }: OptimizerInput,
    baseline: Record<string, number>,
    budgets: Record<string, number>,
    drivers: Record<string, Driver>,
    goalFor: Record<string, Goal>,
  ): Suggestion[] {
    const out: Suggestion[] = [];
    for (const c of categories) {
      const driver = drivers[c.id];
      if (!driver || c.flexibility === 'fixed') continue;
      const base = baseline[c.id] ?? 0;
      const delta = Math.round(budgets[c.id]! - base);
      if (Math.abs(delta) < SLOT) continue;
      const change = `${formatDuration(base)} → ${formatDuration(budgets[c.id]!)} a day`;
      if (driver === 'goal') {
        out.push({ key: `meetGoal:${c.id}`, kind: 'meetGoal', categoryId: c.id, deltaMinutes: delta, message: `${c.name}: ${change} to meet "${goalFor[c.id]!.label}".` });
      } else if (driver === 'reclaim' && delta > 0) {
        out.push({ key: `reclaim:${c.id}`, kind: 'reclaim', categoryId: c.id, deltaMinutes: delta, message: `${c.name}: ${change}. This is the time you win back.` });
      } else if (delta < 0) {
        out.push({ key: `reduce:${c.id}`, kind: 'reduce', categoryId: c.id, deltaMinutes: delta, message: `${c.name}: ${change}.` });
      }
    }
    return out.sort((a, b) => Math.abs(b.deltaMinutes) - Math.abs(a.deltaMinutes));
  }
}

interface Episode {
  start: number;
  len: number;
  weight: number;
}

/**
 * The separate times of day the user usually does something: circular runs
 * of slots where the learned profile is clearly above noise.
 */
function episodes(profile: number[]): Episode[] {
  const max = Math.max(0, ...profile);
  if (max === 0) return [];
  const on = profile.map((p) => p >= Math.max(0.15, max * 0.25));
  if (on.every(Boolean)) return [{ start: 0, len: SLOTS, weight: sum(profile) }];
  const firstOff = on.indexOf(false);
  const out: Episode[] = [];
  for (let k = 1; k <= SLOTS; k++) {
    const i = (firstOff + k) % SLOTS;
    if (!on[i]) continue;
    const prev = (i + SLOTS - 1) % SLOTS;
    if (!on[prev] || out.length === 0) out.push({ start: i, len: 0, weight: 0 });
    const ep = out.at(-1)!;
    ep.len++;
    ep.weight += profile[i]!;
  }
  return out;
}

/** Minutes of one planned block for this activity: its session length, and never below MIN_CHUNK. */
function chunkMinutes(c: Category): number {
  return Math.max(MIN_CHUNK, Math.round((c.sessionMinutes ?? 0) / SLOT) * SLOT);
}

/** Split `need` slots across episodes by weight, dropping any share below `minSize` slots (one session). */
function splitIntoChunks(need: number, eps: Episode[], anchor: number, minSize = MIN_CHUNK_SLOTS): Array<{ size: number; center: number }> {
  const center = (e: Episode) => (e.start + Math.floor(e.len / 2)) % SLOTS;
  let chosen = [...eps].sort((a, b) => b.weight - a.weight);
  if (chosen.length === 0 || need < 2 * minSize) {
    return [{ size: need, center: chosen[0] ? center(chosen[0]) : anchor }];
  }
  for (;;) {
    const total = sum(chosen.map((e) => e.weight));
    const sizes = chosen.map((e) => Math.round((need * e.weight) / total));
    const smallest = sizes.indexOf(Math.min(...sizes));
    if (sizes[smallest]! >= minSize || chosen.length === 1) {
      sizes[0]! += need - sum(sizes); // rounding remainder goes to the main episode
      return chosen.map((e, i) => ({ size: sizes[i]!, center: center(e) })).filter((x) => x.size > 0);
    }
    chosen = chosen.filter((_, i) => i !== smallest);
  }
}

/**
 * Place up to `size` contiguous slots for `id`: the free window that best
 * matches the user's usual timing, stays near `center`, and ideally joins an
 * existing block of the same activity. If no window is big enough, fill the
 * best-fitting free run and return how much was placed.
 */
function placeChunk(grid: Array<string | null>, id: string, size: number, center: number, profile: number[]): number {
  const runs = freeRuns(grid);
  if (runs.length === 0) return 0;

  const fits = runs.filter((r) => r.len >= size);
  const pool = fits.length ? fits : runs;
  let best = { start: -1, len: 0, score: Number.NEGATIVE_INFINITY };
  for (const r of pool) {
    const len = Math.min(size, r.len);
    for (let off = 0; off + len <= r.len; off++) {
      const s0 = (r.start + off) % SLOTS;
      let fit = 0;
      for (let k = 0; k < len; k++) fit += profile[(s0 + k) % SLOTS] ?? 0;
      const before = grid[(s0 + SLOTS - 1) % SLOTS];
      const after = grid[(s0 + len) % SLOTS];
      const joins = before === id || after === id;
      // Packing: sitting flush against other blocks leaves fewer, larger holes.
      const flush = (before != null ? 0.5 : 0) + (after != null ? 0.5 : 0);
      // Without a fitting window, prefer the biggest run so the activity splits into as few pieces as possible.
      const score = fit + (joins ? 1 : 0) + flush - circularDistance((s0 + Math.floor(len / 2)) % SLOTS, center) * 0.05 + (fits.length ? 0 : len);
      if (score > best.score) best = { start: s0, len, score };
    }
  }
  for (let k = 0; k < best.len; k++) grid[(best.start + k) % SLOTS] = id;
  return best.len;
}

/** Swap adjacent movable runs while that reduces the number of pieces. */
function joinPieces(grid: Array<string | null>, locked: boolean[], movable: Set<string>) {
  for (let guard = 0; guard < SLOTS; guard++) {
    const runs: Array<{ id: string | null; start: number; len: number; locked: boolean }> = [];
    grid.forEach((id, i) => {
      const last = runs.at(-1);
      if (last && last.id === id && last.locked === locked[i]) last.len++;
      else runs.push({ id, start: i, len: 1, locked: locked[i]! });
    });
    const canMove = (r?: { id: string | null; locked: boolean }) => !!r && !r.locked && r.id !== null && movable.has(r.id);
    let swapped = false;
    for (let i = 0; i + 1 < runs.length && !swapped; i++) {
      const [a, b] = [runs[i]!, runs[i + 1]!];
      if (!canMove(a) || !canMove(b)) continue;
      const gain = Number(runs[i - 1]?.id === b.id) + Number(runs[i + 2]?.id === a.id);
      if (gain === 0) continue;
      for (let k = 0; k < b.len; k++) grid[a.start + k] = b.id;
      for (let k = 0; k < a.len; k++) grid[a.start + b.len + k] = a.id;
      swapped = true;
    }
    if (!swapped) return;
  }
}

/** Maximal runs of empty slots on the circular grid. */
function freeRuns(grid: Array<string | null>): Array<{ start: number; len: number }> {
  if (grid.every((g) => g === null)) return [{ start: 0, len: SLOTS }];
  const runs: Array<{ start: number; len: number }> = [];
  const firstTaken = grid.findIndex((g) => g !== null);
  for (let k = 1; k <= SLOTS; k++) {
    const i = (firstTaken + k) % SLOTS;
    if (grid[i] !== null) continue;
    if (grid[(i + SLOTS - 1) % SLOTS] !== null) runs.push({ start: i, len: 0 });
    runs.at(-1)!.len++;
  }
  return runs;
}

/** Give each hole of 30–60 min wholly to the free-time activity that fits it best and still needs that much. */
function fillSmallHoles(grid: Array<string | null>, candidates: Category[], needs: Record<string, number>, insights: Insights) {
  for (const run of freeRuns(grid)) {
    if (run.len < MIN_CHUNK_SLOTS || run.len > 2 * MIN_CHUNK_SLOTS) continue;
    const fit = (c: Category) => {
      let f = 0;
      for (let k = 0; k < run.len; k++) f += insights.byCategory[c.id]?.slotProfile[(run.start + k) % SLOTS] ?? 0;
      return f;
    };
    const pick = candidates
      // Must still need this much, and a hole must not cut one of its sessions short.
      .filter((c) => (needs[c.id] ?? 0) >= run.len && chunkMinutes(c) / SLOT <= run.len)
      .sort((a, b) => fit(b) - fit(a) || needs[b.id]! - needs[a.id]!)[0];
    if (!pick) continue;
    for (let k = 0; k < run.len; k++) grid[(run.start + k) % SLOTS] = pick.id;
    needs[pick.id]! -= run.len;
  }
}

function circularDistance(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, SLOTS - d);
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

/**
 * The user's *typical* version of this particular day, before any changes:
 *  - fixed: what's on the calendar, else this weekday's history (work Mon–Fri)
 *  - essential: usual daily average (sleep doesn't shrink on workdays)
 *  - flexible: usual share of whatever free time is left on this weekday, so a
 *    workday isn't compared against an average that includes weekend socializing.
 */
export function typicalDay({ date, categories, insights, fixedBlocks }: OptimizerInput): Record<string, number> {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  const planned = minutesByCategory(fixedBlocks, date);
  const out: Record<string, number> = {};
  let committed = 0;
  for (const c of categories) {
    const stats = insights.byCategory[c.id];
    if (c.flexibility === 'fixed') out[c.id] = planned[c.id] || (stats?.avgMinutesByWeekday[weekday] ?? 0);
    else if (c.flexibility === 'essential') out[c.id] = stats?.avgMinutesPerDay ?? 0;
    else continue;
    committed += out[c.id]!;
  }
  const free = Math.max(0, MINUTES_PER_DAY - committed);
  for (const c of categories.filter((c) => c.flexibility === 'flexible')) {
    const stats = insights.byCategory[c.id];
    // Prefer this weekday's own pattern; fall back to all days if it has no history.
    const share = insights.daysByWeekday[weekday] ? stats?.shareOfFreeTimeByWeekday[weekday] : stats?.shareOfFreeTime;
    out[c.id] = (share ?? 0) * free;
  }
  return out;
}
