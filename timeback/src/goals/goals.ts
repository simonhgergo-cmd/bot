import type { DateKey, Goal, GoalProgress, TimeBlock } from '../domain/types.ts';
import { addDays, dateRange, weekStart } from '../domain/time.ts';
import { minutesByCategory } from '../calendar/dayView.ts';

export function isMet(goal: Goal, actualMinutes: number): boolean {
  return goal.comparison === 'atLeast' ? actualMinutes >= goal.targetMinutes : actualMinutes <= goal.targetMinutes;
}

/** First/last day of the goal period that contains `date`. */
export function periodBounds(goal: Goal, date: DateKey): [DateKey, DateKey] {
  if (goal.period === 'day') return [date, date];
  const start = weekStart(date);
  return [start, addDays(start, 6)];
}

/** Progress for every goal period that overlaps [from, to]. `blocks` must cover those periods. */
export function evaluateGoal(goal: Goal, blocks: TimeBlock[], from: DateKey, to: DateKey): GoalProgress[] {
  const seen = new Set<DateKey>();
  const out: GoalProgress[] = [];
  for (const d of dateRange(from, to)) {
    const [ps, pe] = periodBounds(goal, d);
    if (seen.has(ps)) continue;
    seen.add(ps);
    const actual = dateRange(ps, pe).reduce(
      (sum, day) => sum + (minutesByCategory(blocks, day)[goal.categoryId] ?? 0),
      0,
    );
    out.push({ goalId: goal.id, periodStart: ps, actualMinutes: actual, targetMinutes: goal.targetMinutes, met: isMet(goal, actual) });
  }
  return out;
}

/** Consecutive met periods, counting back from the most recent one. */
export function currentStreak(progress: GoalProgress[]): number {
  let streak = 0;
  for (let i = progress.length - 1; i >= 0 && progress[i]!.met; i--) streak++;
  return streak;
}

/** Daily target implied by a goal (weekly goals are spread over 7 days). */
export function dailyTarget(goal: Goal): number {
  return goal.period === 'day' ? goal.targetMinutes : goal.targetMinutes / 7;
}
