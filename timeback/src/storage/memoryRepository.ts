import type { Category, DateKey, DayReview, Goal, LocalDateTime, Routine, Settings, SuggestionRecord, TimeBlock } from '../domain/types.ts';
import { DEFAULT_SETTINGS } from '../domain/types.ts';
import type { Repository } from './repository.ts';

export interface Snapshot {
  categories: Category[];
  blocks: TimeBlock[];
  goals: Goal[];
  reviews: DayReview[];
  routines: Routine[];
  decisions: SuggestionRecord[];
  settings: Settings;
}

export function emptySnapshot(): Snapshot {
  return { categories: [], blocks: [], goals: [], reviews: [], routines: [], decisions: [], settings: { ...DEFAULT_SETTINGS } };
}

export class MemoryRepository implements Repository {
  protected data: Snapshot;

  constructor(initial: Snapshot = emptySnapshot()) {
    this.data = structuredClone(initial);
  }

  /** Called after every write; subclasses persist here. */
  protected async changed(): Promise<void> {}

  async listCategories() {
    return structuredClone(this.data.categories);
  }
  async saveCategory(category: Category) {
    upsert(this.data.categories, category, (c) => c.id);
    await this.changed();
  }

  async listBlocks(from: LocalDateTime, to: LocalDateTime) {
    // Fixed-width ISO strings compare correctly as strings.
    return structuredClone(this.data.blocks.filter((b) => b.start < to && b.end > from)).sort((a, b) =>
      a.start.localeCompare(b.start),
    );
  }
  async saveBlock(block: TimeBlock) {
    upsert(this.data.blocks, block, (b) => b.id);
    await this.changed();
  }
  async deleteBlock(id: string) {
    this.data.blocks = this.data.blocks.filter((b) => b.id !== id);
    await this.changed();
  }

  async listGoals() {
    return structuredClone(this.data.goals);
  }
  async saveGoal(goal: Goal) {
    upsert(this.data.goals, goal, (g) => g.id);
    await this.changed();
  }

  async getReview(date: DateKey) {
    const r = this.data.reviews.find((x) => x.date === date);
    return r && structuredClone(r);
  }
  async saveReview(review: DayReview) {
    upsert(this.data.reviews, review, (r) => r.date);
    await this.changed();
  }

  async listRoutines() {
    return structuredClone(this.data.routines);
  }
  async saveRoutine(routine: Routine) {
    upsert(this.data.routines, routine, (r) => r.id);
    await this.changed();
  }
  async deleteRoutine(id: string) {
    this.data.routines = this.data.routines.filter((r) => r.id !== id);
    await this.changed();
  }

  async listSuggestionDecisions() {
    return structuredClone(this.data.decisions);
  }
  async saveSuggestionDecision(record: SuggestionRecord) {
    upsert(this.data.decisions, record, (r) => r.key);
    await this.changed();
  }
  async deleteSuggestionDecision(key: string) {
    this.data.decisions = this.data.decisions.filter((r) => r.key !== key);
    await this.changed();
  }

  async getSettings() {
    return { ...this.data.settings };
  }
  async saveSettings(settings: Settings) {
    this.data.settings = { ...settings };
    await this.changed();
  }
}

function upsert<T>(list: T[], item: T, key: (x: T) => string): void {
  const i = list.findIndex((x) => key(x) === key(item));
  if (i === -1) list.push(structuredClone(item));
  else list[i] = structuredClone(item);
}
