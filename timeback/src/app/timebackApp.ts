import type {
  Category,
  DateKey,
  DayReview,
  Goal,
  GoalProgress,
  Insights,
  LocalDateTime,
  OptimalDay,
  ReviewAnswer,
  TimeBlock,
} from '../domain/types.ts';
import { addDays, dateRange, dayWindow, fromMinutes, toMinutes } from '../domain/time.ts';
import { findGaps, minutesByCategory } from '../calendar/dayView.ts';
import { answersToBlocks, buildReview } from '../review/endOfDayReview.ts';
import { currentStreak, evaluateGoal, periodBounds } from '../goals/goals.ts';
import { analyze, wellLoggedDays } from '../insights/insights.ts';
import { GreedyOptimizer, type Optimizer } from '../optimizer/optimizer.ts';
import type { Repository } from '../storage/repository.ts';

export interface AppOptions {
  /** How many past days feed the insights. */
  historyDays?: number;
  optimizer?: Optimizer;
  newId?: () => string;
}

export interface DayComparison {
  date: DateKey;
  actualMinutes: Record<string, number>;
  optimalMinutes: Record<string, number>;
}

/**
 * Application facade — the single entry point a UI (web, mobile, CLI) talks to.
 * Holds no state of its own; everything lives in the Repository.
 */
export class TimebackApp {
  private readonly repo: Repository;
  private readonly historyDays: number;
  private readonly optimizer: Optimizer;
  private readonly newId: () => string;

  constructor(repo: Repository, opts: AppOptions = {}) {
    this.repo = repo;
    this.historyDays = opts.historyDays ?? 28;
    this.optimizer = opts.optimizer ?? new GreedyOptimizer();
    // Web Crypto: global in Node, browsers and Hermes (React Native) with a polyfill.
    this.newId = opts.newId ?? (() => globalThis.crypto.randomUUID());
  }

  // -- Setup ------------------------------------------------------------------

  categories(): Promise<Category[]> {
    return this.repo.listCategories();
  }

  async saveCategory(category: Category): Promise<void> {
    await this.repo.saveCategory(category);
  }

  // -- 1. Main calendar (used like a normal calendar) -------------------------

  async addBlock(block: Omit<TimeBlock, 'id' | 'source'> & Partial<Pick<TimeBlock, 'id' | 'source'>>): Promise<TimeBlock> {
    if (toMinutes(block.end) <= toMinutes(block.start)) throw new Error('Block must end after it starts');
    await this.requireCategory(block.categoryId);
    const saved: TimeBlock = { id: this.newId(), source: 'user', ...block };
    await this.repo.saveBlock(saved);
    return saved;
  }

  async removeBlock(id: string): Promise<void> {
    await this.repo.deleteBlock(id);
  }

  async day(date: DateKey): Promise<TimeBlock[]> {
    const [s, e] = dayWindow(date);
    return this.repo.listBlocks(fromMinutes(s), fromMinutes(e));
  }

  // -- End-of-day question form -----------------------------------------------

  /**
   * Build (or rebuild) the question form for `date` from its current gaps.
   * `now` limits questions to time that has already passed.
   */
  async startReview(date: DateKey, now?: LocalDateTime): Promise<DayReview> {
    const [settings, blocks, categories, insights] = await Promise.all([
      this.repo.getSettings(),
      this.day(date),
      this.repo.listCategories(),
      this.insights(date),
    ]);
    const gaps = findGaps(blocks, date, settings.minGapMinutes, now ? toMinutes(now) : undefined);
    const review = buildReview(date, gaps, categories, insights);
    await this.repo.saveReview(review);
    return review;
  }

  async submitReview(date: DateKey, answers: ReviewAnswer[], completedAt: LocalDateTime): Promise<TimeBlock[]> {
    const review = await this.repo.getReview(date);
    if (!review) throw new Error(`No review started for ${date}`);
    const known = new Set((await this.repo.listCategories()).map((c) => c.id));
    const blocks = answersToBlocks(review, answers, known, this.newId);
    for (const b of blocks) await this.repo.saveBlock(b);
    await this.repo.saveReview({ ...review, completedAt });
    return blocks;
  }

  /** Past days (within history) that still have unanswered gaps — drives the reminder notification. */
  async pendingReviews(today: DateKey): Promise<DateKey[]> {
    const settings = await this.repo.getSettings();
    const out: DateKey[] = [];
    for (const d of dateRange(addDays(today, -7), addDays(today, -1))) {
      const review = await this.repo.getReview(d);
      if (review?.completedAt) continue;
      if (findGaps(await this.day(d), d, settings.minGapMinutes).length) out.push(d);
    }
    return out;
  }

  // -- 3. Goals ---------------------------------------------------------------

  async setGoal(goal: Omit<Goal, 'id' | 'active'> & Partial<Pick<Goal, 'id' | 'active'>>): Promise<Goal> {
    await this.requireCategory(goal.categoryId);
    if (goal.targetMinutes < 0) throw new Error('targetMinutes must be >= 0');
    const saved: Goal = { id: this.newId(), active: true, ...goal };
    await this.repo.saveGoal(saved);
    return saved;
  }

  goals(): Promise<Goal[]> {
    return this.repo.listGoals();
  }

  async goalProgress(from: DateKey, to: DateKey): Promise<Array<{ goal: Goal; progress: GoalProgress[]; streak: number }>> {
    const goals = (await this.repo.listGoals()).filter((g) => g.active);
    // Weekly goals may need blocks outside [from, to]; widen to whole weeks.
    const start = goals.reduce((d, g) => (periodBounds(g, from)[0] < d ? periodBounds(g, from)[0] : d), from);
    const end = goals.reduce((d, g) => (periodBounds(g, to)[1] > d ? periodBounds(g, to)[1] : d), to);
    const blocks = await this.repo.listBlocks(`${start}T00:00`, `${addDays(end, 1)}T00:00`);
    return goals.map((goal) => {
      const progress = evaluateGoal(goal, blocks, from, to);
      return { goal, progress, streak: currentStreak(progress) };
    });
  }

  // -- 2. The optimal-day calendar --------------------------------------------

  /** What the app has learned from the `historyDays` before `date`. */
  async insights(date: DateKey): Promise<Insights> {
    const { blocks, dates } = await this.history(date);
    return analyze(blocks, dates, await this.repo.listCategories());
  }

  async readiness(date: DateKey): Promise<{ ready: boolean; goodDays: number; needed: number }> {
    const settings = await this.repo.getSettings();
    const { dates } = await this.history(date);
    return { ready: dates.length >= settings.minDaysForSuggestions, goodDays: dates.length, needed: settings.minDaysForSuggestions };
  }

  /** The "other" calendar. Returns null until there is enough history to say anything useful. */
  async optimalDay(date: DateKey): Promise<OptimalDay | null> {
    if (!(await this.readiness(date)).ready) return null;
    const [categories, goals, settings, insights, dayBlocks] = await Promise.all([
      this.repo.listCategories(),
      this.repo.listGoals(),
      this.repo.getSettings(),
      this.insights(date),
      this.day(date),
    ]);
    const fixedCats = new Set(categories.filter((c) => c.flexibility === 'fixed').map((c) => c.id));
    const fixedBlocks = dayBlocks.filter((b) => b.locked || fixedCats.has(b.categoryId));
    return this.optimizer.plan({ date, categories, goals: goals.filter((g) => g.active), insights, fixedBlocks, settings });
  }

  /** Side-by-side minutes per category: what happened vs. what the optimal day proposed. */
  async compare(date: DateKey): Promise<DayComparison | null> {
    const optimal = await this.optimalDay(date);
    if (!optimal) return null;
    const optimalBlocks: TimeBlock[] = optimal.blocks.map((b, i) => ({ ...b, id: `opt${i}`, source: 'user' }));
    return {
      date,
      actualMinutes: minutesByCategory(await this.day(date), date),
      optimalMinutes: minutesByCategory(optimalBlocks, date),
    };
  }

  // -- internals --------------------------------------------------------------

  /** Well-logged days in the `historyDays` before `date`, plus their blocks. */
  private async history(date: DateKey) {
    const from = addDays(date, -this.historyDays);
    // Include the evening before `from` so sleep that started then is counted.
    const blocks = await this.repo.listBlocks(`${addDays(from, -1)}T00:00`, `${date}T00:00`);
    const dates = wellLoggedDays(blocks, dateRange(from, addDays(date, -1)), await this.repo.getSettings());
    return { blocks, dates };
  }

  private async requireCategory(id: string): Promise<void> {
    if (!(await this.repo.listCategories()).some((c) => c.id === id)) throw new Error(`Unknown category ${id}`);
  }
}
