import type { Category, DayPart, Goal, GoalProgress, Insights, Observation } from '../domain/types.ts';
import { formatDuration } from '../domain/time.ts';

/** A disliked activity at or above this many minutes a day is worth pointing out. */
const TIME_SINK_MINUTES = 60;
/** A session this much over the user's limit, on average, counts as dragging on. */
const LONG_SESSION_TOLERANCE = 1.25;
/** Only habits (at least every other day) are pointed out, not one-offs. */
const HABIT_PER_DAY = 0.5;

export interface ObserveInput {
  categories: Category[];
  insights: Insights;
  goals: Goal[];
  /** Recent progress per goal (e.g. the last 14 days). */
  progress: Array<{ goal: Goal; progress: GoalProgress[] }>;
}

/**
 * What stands out in the user's history, most impactful first. Pure and
 * deterministic, so the same history always gets the same advice.
 */
export function observe({ categories, insights, goals, progress }: ObserveInput): Observation[] {
  const out: Observation[] = [];
  const capGoal = (id: string) => goals.find((g) => g.active && g.categoryId === id && g.comparison === 'atMost');

  for (const c of categories) {
    const stats = insights.byCategory[c.id];
    if (!stats || c.archived) continue;
    const what = c.name.toLowerCase();

    // Lots of time on something the user dislikes and could cut (not chores that must happen anyway).
    if (c.enjoyment === 'dislikes' && c.flexibility === 'flexible' && stats.avgMinutesPerDay >= TIME_SINK_MINUTES) {
      const avg = stats.avgMinutesPerDay;
      const cap = capGoal(c.id);
      out.push({
        kind: 'timeSink',
        categoryId: c.id,
        message:
          `You spend ${formatDuration(avg)} a day on ${what}, about ${formatDuration(avg * 7)} a week` +
          (cap ? `, well over your "${cap.label}" goal.` : '.'),
        phrase: `you spend a lot of time on ${what}`,
        impactMinutes: cap ? avg - cap.targetMinutes : avg / 2,
        suggestionKey: cap ? `meetGoal:${c.id}` : `reduce:${c.id}`,
      });
    }

    // Sessions that regularly run past the user's own limit.
    if (c.maxSessionMinutes) {
      const limit = c.maxSessionMinutes;
      for (const [part, s] of Object.entries(stats.sessionsByPart) as Array<[DayPart, { avgMinutes: number; perDay: number }]>) {
        if (s.perDay < HABIT_PER_DAY || s.avgMinutes <= limit * LONG_SESSION_TOLERANCE) continue;
        out.push({
          kind: 'longSessions',
          categoryId: c.id,
          message: `Your ${part} ${what} take ${formatDuration(s.avgMinutes)} on average, when ${formatDuration(limit)} is enough.`,
          phrase: `your ${part} ${what} run long`,
          impactMinutes: (s.avgMinutes - limit) * s.perDay,
          suggestionKey: `reduce:${c.id}`,
        });
      }
    }
  }

  // Goals missed most of the time (skipped where a time-sink note already covers it).
  for (const { goal, progress: periods } of progress) {
    if (!goal.active || periods.length < (goal.period === 'day' ? 5 : 2)) continue;
    if (out.some((o) => o.kind === 'timeSink' && o.categoryId === goal.categoryId)) continue;
    const met = periods.filter((p) => p.met).length;
    if (met / periods.length >= 0.5) continue;
    const unit = goal.period === 'day' ? 'days' : 'weeks';
    const avgGap = periods.reduce((s, p) => s + Math.abs(p.actualMinutes - p.targetMinutes), 0) / periods.length;
    out.push({
      kind: 'goalGap',
      categoryId: goal.categoryId,
      message: `You met "${goal.label}" on ${met} of the last ${periods.length} ${unit}.`,
      phrase: goal.comparison === 'atLeast' ? `you're often short of "${goal.label}"` : `you often go over "${goal.label}"`,
      impactMinutes: goal.period === 'day' ? avgGap : avgGap / 7,
      suggestionKey: `meetGoal:${goal.categoryId}`,
    });
  }

  return out.sort((a, b) => b.impactMinutes - a.impactMinutes);
}

/** "Looks like you spend a lot of time on your phone, and your midday meals run long." */
export function headline(observations: Observation[]): string {
  const phrases = observations.slice(0, 2).map((o) => o.phrase);
  if (phrases.length === 0) return '';
  return `Looks like ${phrases.join(', and ')}. I think this routine would work better:`;
}
