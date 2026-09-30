export * from './domain/types.ts';
export * from './domain/time.ts';
export { DEFAULT_CATEGORIES } from './domain/defaults.ts';
export { findGaps, coverage, minutesByCategory } from './calendar/dayView.ts';
export { buildReview, reviewChanges, type ReviewChanges } from './review/endOfDayReview.ts';
export { evaluateGoal, currentStreak, isMet } from './goals/goals.ts';
export { analyze, wellLoggedDays, PREFERENCE_WEIGHT } from './insights/insights.ts';
export { TIME_PRESETS, validateActivity, activityId, type ActivityInput } from './activities/activities.ts';
export { observe, headline, type ObserveInput } from './coach/coach.ts';
export { GreedyOptimizer, typicalDay, type Optimizer, type OptimizerInput } from './optimizer/optimizer.ts';
export * as routine from './routine/routine.ts';
export type { Repository } from './storage/repository.ts';
export { MemoryRepository } from './storage/memoryRepository.ts';
// JsonFileRepository is Node-only (dev/demo); import it directly from './storage/jsonFileRepository.ts'.
export { TimebackApp, type ApplyPlanResult, type DayComparison } from './app/timebackApp.ts';
