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
  Routine,
  RoutineBlock,
  RoutineCheck,
  TimeBlock,
} from '../domain/types.ts';
import { addDays, dateRange, dayWindow, fromMinutes, toMinutes } from '../domain/time.ts';
import { findGaps, minutesByCategory } from '../calendar/dayView.ts';
import { answersToBlocks, buildReview } from '../review/endOfDayReview.ts';
import { currentStreak, evaluateGoal, periodBounds } from '../goals/goals.ts';
import { analyze, wellLoggedDays } from '../insights/insights.ts';
import { GreedyOptimizer, typicalDay, type Optimizer } from '../optimizer/optimizer.ts';
import * as routineOps from '../routine/routine.ts';
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

  // -- 4. Routine: the editable optimal routine -------------------------------

  routines(): Promise<Routine[]> {
    return this.repo.listRoutines();
  }

  /**
   * Build the routines from the optimizer: "Weekdays" and "Weekend" on first
   * run, or refresh existing ones. Blocks the user edited are kept as-is and
   * the rest is re-planned around them. Null until there is enough history.
   */
  async generateRoutines(today: DateKey, now: LocalDateTime): Promise<Routine[] | null> {
    if (!(await this.readiness(today)).ready) return null;
    let routines = await this.repo.listRoutines();
    if (routines.length === 0) {
      routines = [
        { id: this.newId(), name: 'Weekdays', weekdays: [1, 2, 3, 4, 5], blocks: [] },
        { id: this.newId(), name: 'Weekend', weekdays: [0, 6], blocks: [] },
      ];
    }
    const [categories, goals, settings, insights] = await Promise.all([
      this.repo.listCategories(),
      this.repo.listGoals(),
      this.repo.getSettings(),
      this.insights(today),
    ]);
    const out: Routine[] = [];
    for (const r of routines) {
      const date = nextDateOn(today, r.weekdays);
      const kept = r.blocks.filter((b) => b.edited);
      const fixedBlocks = routineOps.planForDate([{ ...r, blocks: kept, weekdays: [0, 1, 2, 3, 4, 5, 6] }], date, []);
      const plan = this.optimizer.plan({ date, categories, goals: goals.filter((g) => g.active), insights, fixedBlocks, settings });
      const fresh = routineOps.blocksFromOptimalDay({ ...plan, blocks: plan.blocks.filter((b) => b.origin === 'planned') }, this.newId);
      const updated: Routine = { ...r, blocks: routineOps.normalize([...kept, ...fresh]), generatedAt: now };
      await this.repo.saveRoutine(updated);
      out.push(updated);
    }
    return out;
  }

  /** Rename a routine or change its weekdays. A weekday can belong to only one routine. */
  async saveRoutine(routine: Routine): Promise<Routine> {
    const others = (await this.repo.listRoutines()).filter((r) => r.id !== routine.id);
    const clash = routine.weekdays.find((d) => others.some((r) => r.weekdays.includes(d)));
    if (clash !== undefined) throw new Error(`Weekday ${clash} already belongs to another routine`);
    routine.blocks.forEach((b) => routineOps.blockMinutes(b)); // validates times
    const saved = { ...routine, blocks: routineOps.normalize(routine.blocks) };
    await this.repo.saveRoutine(saved);
    return saved;
  }

  /**
   * Add, move, resize or re-categorize a block. The block wins where it
   * overlaps others (they are trimmed or split) and is marked as edited.
   */
  async placeRoutineBlock(routineId: string, block: Omit<RoutineBlock, 'id'> & { id?: string }): Promise<Routine> {
    await this.requireCategory(block.categoryId);
    const routine = await this.requireRoutine(routineId);
    const updated = routineOps.placeBlock(routine, { ...block, id: block.id ?? this.newId() }, this.newId);
    await this.repo.saveRoutine(updated);
    return updated;
  }

  async removeRoutineBlock(routineId: string, blockId: string): Promise<Routine> {
    const updated = routineOps.removeBlock(await this.requireRoutine(routineId), blockId);
    await this.repo.saveRoutine(updated);
    return updated;
  }

  /** Live feedback for the routine editor: totals, goal checks, and time won back vs. the typical day. */
  async checkRoutine(routineId: string, today: DateKey): Promise<RoutineCheck> {
    const routine = await this.requireRoutine(routineId);
    const [all, categories, goals, settings, insights] = await Promise.all([
      this.repo.listRoutines(),
      this.repo.listCategories(),
      this.repo.listGoals(),
      this.repo.getSettings(),
      this.insights(today),
    ]);
    const date = nextDateOn(today, routine.weekdays);
    const fixedCats = new Set(categories.filter((c) => c.flexibility === 'fixed').map((c) => c.id));
    const fixedBlocks = routineOps.planForDate(
      [{ ...routine, blocks: routine.blocks.filter((b) => fixedCats.has(b.categoryId)), weekdays: [0, 1, 2, 3, 4, 5, 6] }],
      date,
      [],
    );
    const active = goals.filter((g) => g.active);
    const typical = typicalDay({ date, categories, goals: active, insights, fixedBlocks, settings });
    const planned = routineOps.minutesByCategory(routine);
    const reclaimed = categories
      .filter((c) => c.enjoyment === 'loves')
      .reduce((sum, c) => sum + Math.max(0, (planned[c.id] ?? 0) - (typical[c.id] ?? 0)), 0);
    return {
      routineId,
      plannedMinutes: planned,
      typicalMinutes: Object.fromEntries(Object.entries(typical).map(([k, v]) => [k, Math.round(v)])),
      unplannedMinutes: routineOps.unplannedMinutes(routine),
      reclaimedMinutes: Math.round(reclaimed),
      goals: routineOps.checkGoals(routine, all, active),
    };
  }

  /** The plan for a date: its routine with the calendar's fixed events on top. Null if no routine covers it. */
  async planForDate(date: DateKey): Promise<TimeBlock[] | null> {
    const [routines, categories, dayBlocks] = await Promise.all([this.repo.listRoutines(), this.repo.listCategories(), this.day(date)]);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (!routineOps.routineForWeekday(routines, weekday)) return null;
    const fixedCats = new Set(categories.filter((c) => c.flexibility === 'fixed').map((c) => c.id));
    return routineOps.planForDate(routines, date, dayBlocks.filter((b) => b.locked || fixedCats.has(b.categoryId)));
  }

  /** How closely a logged day followed its routine (0–1), or null if there's nothing to compare. */
  async adherence(date: DateKey): Promise<number | null> {
    const plan = await this.planForDate(date);
    return plan ? routineOps.adherence(await this.day(date), plan, date) : null;
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

  private async requireRoutine(id: string): Promise<Routine> {
    const r = (await this.repo.listRoutines()).find((x) => x.id === id);
    if (!r) throw new Error(`Unknown routine ${id}`);
    return r;
  }

  private async requireCategory(id: string): Promise<void> {
    if (!(await this.repo.listCategories()).some((c) => c.id === id)) throw new Error(`Unknown category ${id}`);
  }
}

/** First date on or after `from` whose weekday is in `weekdays`. */
function nextDateOn(from: DateKey, weekdays: number[]): DateKey {
  for (let i = 0; i < 7; i++) {
    const d = addDays(from, i);
    if (weekdays.includes(new Date(`${d}T00:00:00Z`).getUTCDay())) return d;
  }
  throw new Error('Routine has no weekdays');
}
