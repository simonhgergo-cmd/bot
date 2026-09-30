export * from './domain/types.ts';
export * from './domain/time.ts';
export { DEFAULT_CATEGORIES } from './domain/defaults.ts';
export { findGaps, coverage, minutesByCategory } from './calendar/dayView.ts';
export { buildReview, answersToBlocks } from './review/endOfDayReview.ts';
export { evaluateGoal, currentStreak, isMet } from './goals/goals.ts';
export { analyze, wellLoggedDays } from './insights/insights.ts';
export { GreedyOptimizer, type Optimizer, type OptimizerInput } from './optimizer/optimizer.ts';
export type { Repository } from './storage/repository.ts';
export { MemoryRepository } from './storage/memoryRepository.ts';
// JsonFileRepository is Node-only (dev/demo); import it directly from './storage/jsonFileRepository.ts'.
export { TimebackApp, type DayComparison } from './app/timebackApp.ts';
