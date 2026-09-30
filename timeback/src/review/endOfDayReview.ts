import type {
  Category,
  DateKey,
  DayReview,
  Gap,
  Insights,
  ReviewAnswer,
  ReviewQuestion,
  TimeBlock,
} from '../domain/types.ts';
import { MINUTES_PER_DAY, SLOT_MINUTES, hhmm, toMinutes } from '../domain/time.ts';

/**
 * The short question form shown at the end of the day: one question per
 * unlogged gap, with likely answers pre-ranked so most questions are one tap,
 * plus a "did you do this as planned?" question per planned block.
 */
export function buildReview(
  date: DateKey,
  gaps: Gap[],
  categories: Category[],
  insights?: Insights,
  planned: TimeBlock[] = [],
): DayReview {
  const name = Object.fromEntries(categories.map((c) => [c.id, c.name]));
  const drafts: Array<Omit<ReviewQuestion, 'id'>> = [
    ...planned.map((b) => ({
      gap: { start: b.start, end: b.end },
      prompt: `Did you do ${b.title ?? name[b.categoryId] ?? b.categoryId} ${hhmm(b.start)}–${hhmm(b.end)} as planned?`,
      // If not, the likeliest alternatives: the planned activity first, then by history.
      suggestedCategoryIds: [b.categoryId, ...rankCategoriesForGap(b, categories, insights).filter((id) => id !== b.categoryId)],
      plannedBlockId: b.id,
    })),
    ...gaps.map((gap) => ({
      gap,
      prompt: `What were you doing between ${hhmm(gap.start)} and ${hhmm(gap.end)}?`,
      suggestedCategoryIds: rankCategoriesForGap(gap, categories, insights),
    })),
  ];
  drafts.sort((a, b) => a.gap.start.localeCompare(b.gap.start));
  return { date, questions: drafts.map((q, i) => ({ id: `${date}#${i}`, ...q })) };
}

/**
 * Rank categories by how often the user historically did them during this
 * time window. Categories with no history keep their configured order.
 */
export function rankCategoriesForGap(gap: Gap, categories: Category[], insights?: Insights): string[] {
  const gs = toMinutes(gap.start);
  const ge = toMinutes(gap.end);
  const score = (c: Category): number => {
    const profile = insights?.byCategory[c.id]?.slotProfile;
    if (!profile) return 0;
    let total = 0;
    for (let m = gs; m < ge; m += SLOT_MINUTES) total += profile[Math.floor((m % MINUTES_PER_DAY) / SLOT_MINUTES)] ?? 0;
    return total;
  };
  return [...categories].sort((a, b) => score(b) - score(a)).map((c) => c.id);
}

export interface ReviewChanges {
  /** New blocks to save (answers to gaps, or replacements for planned blocks). */
  save: TimeBlock[];
  /** Planned blocks confirmed as having happened. */
  confirm: string[];
  /** Planned blocks replaced by what actually happened. */
  remove: string[];
}

/** Validate answers against the review's questions and turn them into calendar changes. */
export function reviewChanges(
  review: DayReview,
  answers: ReviewAnswer[],
  knownCategoryIds: Set<string>,
  newId: () => string,
): ReviewChanges {
  const byId = new Map(review.questions.map((q) => [q.id, q]));
  const out: ReviewChanges = { save: [], confirm: [], remove: [] };
  for (const answer of answers) {
    const q = byId.get(answer.questionId);
    if (!q) throw new Error(`Unknown question ${answer.questionId}`);
    if (!!answer.confirmed === !!answer.parts) throw new Error(`Answer ${q.id} needs either confirmed or parts`);
    if (answer.confirmed) {
      if (!q.plannedBlockId) throw new Error(`Question ${q.id} is about a gap; answer it with parts`);
      out.confirm.push(q.plannedBlockId);
      continue;
    }
    const [gs, ge] = [toMinutes(q.gap.start), toMinutes(q.gap.end)];
    for (const part of answer.parts!) {
      const [ps, pe] = [toMinutes(part.start), toMinutes(part.end)];
      if (ps < gs || pe > ge || pe <= ps) {
        throw new Error(`Answer ${part.start}–${part.end} is outside gap ${q.gap.start}–${q.gap.end}`);
      }
      if (!knownCategoryIds.has(part.categoryId)) throw new Error(`Unknown category ${part.categoryId}`);
      out.save.push({ id: newId(), ...part, source: 'review' });
    }
    if (q.plannedBlockId) out.remove.push(q.plannedBlockId);
  }
  return out;
}
