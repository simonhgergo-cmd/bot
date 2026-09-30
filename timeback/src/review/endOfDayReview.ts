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
 * unlogged gap, with likely answers pre-ranked so most questions are one tap.
 */
export function buildReview(date: DateKey, gaps: Gap[], categories: Category[], insights?: Insights): DayReview {
  const questions: ReviewQuestion[] = gaps.map((gap, i) => ({
    id: `${date}#${i}`,
    gap,
    prompt: `What were you doing between ${hhmm(gap.start)} and ${hhmm(gap.end)}?`,
    suggestedCategoryIds: rankCategoriesForGap(gap, categories, insights),
  }));
  return { date, questions };
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

/** Validate answers against the review's questions and turn them into calendar blocks. */
export function answersToBlocks(
  review: DayReview,
  answers: ReviewAnswer[],
  knownCategoryIds: Set<string>,
  newId: () => string,
): TimeBlock[] {
  const byId = new Map(review.questions.map((q) => [q.id, q]));
  const blocks: TimeBlock[] = [];
  for (const answer of answers) {
    const q = byId.get(answer.questionId);
    if (!q) throw new Error(`Unknown question ${answer.questionId}`);
    const [gs, ge] = [toMinutes(q.gap.start), toMinutes(q.gap.end)];
    for (const part of answer.parts) {
      const [ps, pe] = [toMinutes(part.start), toMinutes(part.end)];
      if (ps < gs || pe > ge || pe <= ps) {
        throw new Error(`Answer ${part.start}–${part.end} is outside gap ${q.gap.start}–${q.gap.end}`);
      }
      if (!knownCategoryIds.has(part.categoryId)) throw new Error(`Unknown category ${part.categoryId}`);
      blocks.push({ id: newId(), ...part, source: 'review' });
    }
  }
  return blocks;
}
