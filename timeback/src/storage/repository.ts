import type { Category, DateKey, DayReview, Goal, LocalDateTime, Routine, Settings, SuggestionRecord, TimeBlock } from '../domain/types.ts';

/**
 * Persistence boundary. The core only talks to this interface, so the backing
 * store can be swapped (in-memory for tests, JSON file for a local prototype,
 * SQLite / a server API for the real app) without touching domain logic.
 */
export interface Repository {
  listCategories(): Promise<Category[]>;
  saveCategory(category: Category): Promise<void>;
  deleteCategory(id: string): Promise<void>;

  /** Blocks that overlap [from, to). */
  listBlocks(from: LocalDateTime, to: LocalDateTime): Promise<TimeBlock[]>;
  saveBlock(block: TimeBlock): Promise<void>;
  deleteBlock(id: string): Promise<void>;

  listGoals(): Promise<Goal[]>;
  saveGoal(goal: Goal): Promise<void>;

  getReview(date: DateKey): Promise<DayReview | undefined>;
  saveReview(review: DayReview): Promise<void>;

  listRoutines(): Promise<Routine[]>;
  saveRoutine(routine: Routine): Promise<void>;
  deleteRoutine(id: string): Promise<void>;

  listSuggestionDecisions(): Promise<SuggestionRecord[]>;
  saveSuggestionDecision(record: SuggestionRecord): Promise<void>;
  deleteSuggestionDecision(key: string): Promise<void>;

  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
}
