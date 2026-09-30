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

type Driver = 'goal' | 'reduce' | 'reclaim' | 'squeeze';

/**
 * Two phases:
 *  1. Budget — decide minutes per category: start from the user's typical day,
 *     enforce goals, trim disliked activities, give the freed time to loved ones.
 *  2. Place — lay budgets onto a 15-minute grid around fixed commitments, each
 *     category as close as possible to when the user usually does it.
 */
export class GreedyOptimizer implements Optimizer {
  plan(input: OptimizerInput): OptimalDay {
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

    for (const c of categories) {
      const base = baseline[c.id] ?? 0;
      const locked = lockedMinutes[c.id] ?? 0;

      if (c.flexibility === 'fixed') {
        budgets[c.id] = base;
        floor[c.id] = base;
        continue;
      }

      let target = base;
      let min = locked;
      const catGoals = goals.filter((g) => g.active && g.categoryId === c.id);
      for (const g of catGoals) {
        // Round toward the goal so grid rounding can't break it (150 min/week → 30, not 15, a day).
        const t = g.comparison === 'atLeast' ? Math.ceil(dailyTarget(g) / SLOT) * SLOT : Math.floor(dailyTarget(g) / SLOT) * SLOT;
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
      // Freed time goes to what the user loves, weighted by how much they already do it.
      const loved = categories.filter((c) => c.enjoyment === 'loves' && c.flexibility !== 'fixed');
      const weights = loved.map((c) => Math.max(baseline[c.id] ?? 0, SLOT));
      const total = sum(weights);
      loved.forEach((c, i) => {
        budgets[c.id]! += (leftover * weights[i]!) / total;
        drivers[c.id] ??= 'reclaim';
      });
      if (loved.length) leftover = 0;
    } else if (leftover < 0) {
      // Over-committed (e.g. ambitious goals): shrink the least valuable time first.
      const tiers: Array<(c: Category) => boolean> = [
        (c) => c.flexibility === 'flexible' && c.enjoyment === 'dislikes',
        (c) => c.flexibility === 'flexible' && c.enjoyment === 'neutral',
        (c) => c.flexibility === 'flexible' && c.enjoyment === 'loves',
        (c) => c.flexibility === 'essential',
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

    // Placement order = priority for the best time slots.
    const rank = (c: Category) =>
      c.flexibility === 'fixed' ? 0 : c.flexibility === 'essential' ? 1 : c.enjoyment === 'loves' ? 3 : 2;
    const ordered = [...categories].sort((a, b) => rank(a) - rank(b));

    for (const c of ordered) {
      const stats = insights.byCategory[c.id];
      const profile = stats?.slotProfile ?? [];
      const anchor = Math.round((stats?.typicalStartMinute ?? DEFAULT_ANCHOR_MINUTE) / SLOT) % SLOTS;
      let need = (budgets[c.id] ?? 0) / SLOT - grid.filter((g) => g === c.id).length;
      while (need-- > 0) {
        // Prefer slots the user usually spends on this; then grow existing chunks; then near the usual start.
        let best = -1;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (let i = 0; i < SLOTS; i++) {
          if (grid[i] !== null) continue;
          const adjacent = grid[(i + SLOTS - 1) % SLOTS] === c.id || grid[(i + 1) % SLOTS] === c.id;
          const score = (profile[i] ?? 0) * 100 + (adjacent ? 10 : 0) - circularDistance(i, anchor) / SLOTS;
          if (score > bestScore) [best, bestScore] = [i, score];
        }
        if (best === -1) break;
        grid[best] = c.id;
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
        out.push({ kind: 'meetGoal', categoryId: c.id, deltaMinutes: delta, message: `${c.name}: ${change} to meet "${goalFor[c.id]!.label}".` });
      } else if (driver === 'reclaim' && delta > 0) {
        out.push({ kind: 'reclaim', categoryId: c.id, deltaMinutes: delta, message: `${c.name}: ${change}. This is the time you win back.` });
      } else if (delta < 0) {
        out.push({ kind: 'reduce', categoryId: c.id, deltaMinutes: delta, message: `${c.name}: ${change}.` });
      }
    }
    return out.sort((a, b) => Math.abs(b.deltaMinutes) - Math.abs(a.deltaMinutes));
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
