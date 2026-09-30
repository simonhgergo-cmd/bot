import type {
  CoachProposal,
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
  Suggestion,
  SuggestionDecision,
  SuggestionRecord,
  TimeBlock,
} from '../domain/types.ts';
import { addDays, dateRange, dayWindow, fromMinutes, toMinutes } from '../domain/time.ts';
import { findGaps, minutesByCategory } from '../calendar/dayView.ts';
import { buildReview, reviewChanges, type ReviewChanges } from '../review/endOfDayReview.ts';
import { currentStreak, evaluateGoal, periodBounds } from '../goals/goals.ts';
import { analyze, wellLoggedDays } from '../insights/insights.ts';
import { GreedyOptimizer, typicalDay, type Optimizer, type OptimizerInput } from '../optimizer/optimizer.ts';
import { headline, observe } from '../coach/coach.ts';
import * as routineOps from '../routine/routine.ts';
import { activityId, toCategory, validateActivity, type ActivityInput } from '../activities/activities.ts';

/** Range that covers every stored block (for merges and usage checks). */
const ALL_TIME = ['0000-01-01T00:00', '9999-12-31T23:59'] as const;
import type { Repository } from '../storage/repository.ts';

export interface AppOptions {
  /** How many past days feed the insights. */
  historyDays?: number;
  optimizer?: Optimizer;
  newId?: () => string;
}

export interface ApplyPlanResult {
  /** Planned blocks written to the calendar. */
  blocks: TimeBlock[];
  /**
   * Planned time that the user's own events pushed out, per activity (e.g.
   * "Dinner with Sam" replaces 30 min of exercise), so the UI can say so.
   */
  displaced: Array<{ categoryId: string; minutes: number }>;
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

  /** All activities, including archived ones (their history still shows). */
  categories(): Promise<Category[]> {
    return this.repo.listCategories();
  }

  /** Activities that can be logged, planned and offered in the review. */
  async activeCategories(): Promise<Category[]> {
    return (await this.repo.listCategories()).filter((c) => !c.archived);
  }

  /** Low-level upsert, used for the built-in defaults during onboarding. Prefer addActivity. */
  async saveCategory(category: Category): Promise<void> {
    await this.repo.saveCategory(category);
  }

  // -- Custom activities --------------------------------------------------------

  /**
   * Add an activity of the user's own ("Guitar", "Language app"). With no
   * history yet, its preferred times and session length are what planning
   * and the review use; real logs take over as they come in.
   */
  async addActivity(input: ActivityInput): Promise<Category> {
    const existing = await this.repo.listCategories();
    validateActivity(input, existing);
    const category = toCategory(activityId(input.name, new Set(existing.map((c) => c.id))), input);
    await this.repo.saveCategory(category);
    return category;
  }

  /** Rename or change how the app treats an activity. The id (and so all history) stays. */
  async updateActivity(id: string, patch: Partial<ActivityInput>): Promise<Category> {
    const existing = await this.repo.listCategories();
    const current = existing.find((c) => c.id === id);
    if (!current) throw new Error(`Unknown activity ${id}`);
    const merged: ActivityInput = { ...current, ...patch };
    validateActivity(merged, existing, id);
    const updated: Category = { ...toCategory(id, merged), ...(current.archived ? { archived: true } : {}) };
    await this.repo.saveCategory(updated);
    return updated;
  }

  /**
   * Archive: stop planning it and offering it, but keep its history (past days
   * still show it). Its usual time becomes free time in future plans.
   */
  async setArchived(id: string, archived: boolean): Promise<Category> {
    const current = (await this.repo.listCategories()).find((c) => c.id === id);
    if (!current) throw new Error(`Unknown activity ${id}`);
    const { archived: _was, ...rest } = current;
    const updated: Category = archived ? { ...rest, archived: true } : rest;
    await this.repo.saveCategory(updated);
    return updated;
  }

  /**
   * Fold one activity into another ("Jogging" into "Exercise"): its logged
   * time, goals and routine blocks move over, then it is removed.
   */
  async mergeActivities(fromId: string, intoId: string): Promise<{ blocks: number; goals: number; routines: number }> {
    if (fromId === intoId) throw new Error('Pick two different activities');
    const all = await this.repo.listCategories();
    if (!all.some((c) => c.id === fromId)) throw new Error(`Unknown activity ${fromId}`);
    await this.requireCategory(intoId);

    const blocks = (await this.repo.listBlocks(ALL_TIME[0], ALL_TIME[1])).filter((b) => b.categoryId === fromId);
    for (const b of blocks) await this.repo.saveBlock({ ...b, categoryId: intoId });
    const goals = (await this.repo.listGoals()).filter((g) => g.categoryId === fromId);
    for (const g of goals) await this.repo.saveGoal({ ...g, categoryId: intoId });
    let routines = 0;
    for (const r of await this.repo.listRoutines()) {
      if (!r.blocks.some((b) => b.categoryId === fromId)) continue;
      const blocksMoved = r.blocks.map((b) => (b.categoryId === fromId ? { ...b, categoryId: intoId } : b));
      await this.repo.saveRoutine({ ...r, blocks: routineOps.normalize(blocksMoved) });
      routines++;
    }
    // Decisions were about the old activity's suggestions; they don't carry over.
    for (const d of await this.repo.listSuggestionDecisions()) {
      if (d.categoryId === fromId) await this.repo.deleteSuggestionDecision(d.key);
    }
    await this.repo.deleteCategory(fromId);
    return { blocks: blocks.length, goals: goals.length, routines };
  }

  /** Delete an activity that was never used. Anything with history should be archived or merged instead. */
  async deleteActivity(id: string): Promise<void> {
    const used =
      (await this.repo.listBlocks(ALL_TIME[0], ALL_TIME[1])).some((b) => b.categoryId === id) ||
      (await this.repo.listGoals()).some((g) => g.categoryId === id) ||
      (await this.repo.listRoutines()).some((r) => r.blocks.some((b) => b.categoryId === id));
    if (used) throw new Error('This activity has history. Archive it, or merge it into another one.');
    await this.repo.deleteCategory(id);
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

  /** Everything on the calendar for `date`, including planned blocks not yet confirmed. */
  async day(date: DateKey): Promise<TimeBlock[]> {
    const [s, e] = dayWindow(date);
    return this.repo.listBlocks(fromMinutes(s), fromMinutes(e));
  }

  /** Only what actually happened (or the user put there themselves); excludes unconfirmed plan blocks. */
  async loggedDay(date: DateKey): Promise<TimeBlock[]> {
    return (await this.day(date)).filter(isLogged);
  }

  // -- End-of-day question form -----------------------------------------------

  /**
   * Build (or rebuild) the question form for `date`: one question per unlogged
   * gap, and "did you do this as planned?" for each planned block that has ended.
   * `now` limits questions to time that has already passed.
   */
  async startReview(date: DateKey, now?: LocalDateTime): Promise<DayReview> {
    const [settings, blocks, categories, insights] = await Promise.all([
      this.repo.getSettings(),
      this.day(date),
      this.activeCategories(), // archived activities aren't offered as answers
      this.insights(date),
    ]);
    const until = now ? toMinutes(now) : undefined;
    // Planned time isn't a gap: it gets its own confirm question instead.
    const gaps = findGaps(blocks, date, settings.minGapMinutes, until);
    const ended = blocks.filter((b) => !isLogged(b) && (until === undefined || toMinutes(b.end) <= until));
    const review = buildReview(date, gaps, categories, insights, ended);
    await this.repo.saveReview(review);
    return review;
  }

  async submitReview(date: DateKey, answers: ReviewAnswer[], completedAt: LocalDateTime): Promise<ReviewChanges> {
    const review = await this.repo.getReview(date);
    if (!review) throw new Error(`No review started for ${date}`);
    const known = new Set((await this.activeCategories()).map((c) => c.id));
    const changes = reviewChanges(review, answers, known, this.newId);
    const current = new Map((await this.day(date)).map((b) => [b.id, b]));
    for (const id of changes.remove) await this.repo.deleteBlock(id);
    for (const id of changes.confirm) {
      const b = current.get(id);
      if (!b) throw new Error(`Planned block ${id} no longer exists`);
      const { status: _planned, ...happened } = b;
      await this.repo.saveBlock(happened);
    }
    for (const b of changes.save) await this.repo.saveBlock(b);
    await this.repo.saveReview({ ...review, completedAt });
    return changes;
  }

  /** Past days (within a week) with unanswered gaps or unconfirmed plans — drives the reminder notification. */
  async pendingReviews(today: DateKey): Promise<DateKey[]> {
    const settings = await this.repo.getSettings();
    const out: DateKey[] = [];
    for (const d of dateRange(addDays(today, -7), addDays(today, -1))) {
      const review = await this.repo.getReview(d);
      if (review?.completedAt) continue;
      const blocks = await this.day(d);
      if (blocks.some((b) => !isLogged(b)) || findGaps(blocks, d, settings.minGapMinutes).length) out.push(d);
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
    const blocks = (await this.repo.listBlocks(`${start}T00:00`, `${addDays(end, 1)}T00:00`)).filter(isLogged);
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

  /**
   * The "other" calendar. Returns null until there is enough history to say
   * anything useful. Suggestions carry the user's earlier decision, and
   * activities they rejected are kept at their usual level.
   */
  async optimalDay(date: DateKey): Promise<OptimalDay | null> {
    if (!(await this.readiness(date)).ready) return null;
    const [categories, goals, settings, insights, dayBlocks, decisions] = await Promise.all([
      this.repo.listCategories(),
      this.repo.listGoals(),
      this.repo.getSettings(),
      this.insights(date),
      this.loggedDay(date),
      this.repo.listSuggestionDecisions(),
    ]);
    const fixedCats = new Set(categories.filter((c) => c.flexibility === 'fixed').map((c) => c.id));
    const fixedBlocks = dayBlocks.filter((b) => b.locked || fixedCats.has(b.categoryId));
    const plan = this.optimizer.plan({
      date, categories, goals: goals.filter((g) => g.active), insights, fixedBlocks, settings,
      keepAsUsual: rejectedCategories(decisions),
    });
    const byKey = new Map(decisions.map((d) => [d.key, d.decision]));
    return { ...plan, suggestions: plan.suggestions.map((s) => (byKey.has(s.key) ? { ...s, decision: byKey.get(s.key)! } : s)) };
  }

  // -- Suggestion decisions ("Try it" / "Not for me") --------------------------

  /**
   * Remember the user's answer to a suggestion. "Not for me" keeps that
   * activity at its usual level in future optimal days and routine
   * regeneration; call `generateRoutines` to apply it to existing routines.
   */
  async decideSuggestion(suggestion: Suggestion, decision: SuggestionDecision, now: LocalDateTime): Promise<SuggestionRecord> {
    const record: SuggestionRecord = {
      key: suggestion.key,
      categoryId: suggestion.categoryId,
      kind: suggestion.kind,
      decision,
      deltaMinutes: suggestion.deltaMinutes,
      decidedAt: now,
    };
    await this.repo.saveSuggestionDecision(record);
    return record;
  }

  /** Undo a decision: the suggestion can be proposed again. */
  async clearSuggestionDecision(key: string): Promise<void> {
    await this.repo.deleteSuggestionDecision(key);
  }

  suggestionDecisions(): Promise<SuggestionRecord[]> {
    return this.repo.listSuggestionDecisions();
  }

  // -- "Put this plan on my calendar" -----------------------------------------

  /**
   * Write the plan for `date` into the main calendar as planned blocks: the
   * routine's plan if one covers the date, else the optimal day. Planned blocks
   * never overwrite anything already on the calendar, and re-applying replaces
   * the previous ones. With `from`, only the rest of the day is planned.
   * The evening review later asks whether each one happened.
   */
  async applyPlan(date: DateKey, opts: { from?: LocalDateTime } = {}): Promise<ApplyPlanResult> {
    const existing = await this.day(date);
    const existingIds = new Set(existing.map((b) => b.id));
    const fromRoutine = await this.planForDate(date);
    let proposed: Array<Pick<TimeBlock, 'start' | 'end' | 'categoryId' | 'title'>>;
    if (fromRoutine) proposed = fromRoutine.filter((b) => !existingIds.has(b.id));
    else {
      const optimal = await this.optimalDay(date);
      if (!optimal) throw new Error(`Not enough history to plan ${date} yet`);
      proposed = optimal.blocks.filter((b) => b.origin === 'planned');
    }

    // Replace earlier applied plans for this date.
    const previous = existing.filter((b) => b.source === 'plan' && !isLogged(b));
    for (const b of previous) await this.repo.deleteBlock(b.id);
    const keep = existing.filter((b) => !previous.includes(b));

    const events = keep.map((b) => [toMinutes(b.start), toMinutes(b.end)] as [number, number]);
    const past: Array<[number, number]> = opts.from ? [[dayWindow(date)[0], toMinutes(opts.from)]] : [];
    const saved: TimeBlock[] = [];
    const displaced: Record<string, number> = {};
    for (const p of proposed) {
      const span: [number, number] = [toMinutes(p.start), toMinutes(p.end)];
      const future = cutAround(span, past);
      const fits = future.flatMap((piece) => cutAround(piece, events));
      const lost = sumSpans(future) - sumSpans(fits);
      if (lost > 0) displaced[p.categoryId] = (displaced[p.categoryId] ?? 0) + lost;
      for (const [s, e] of fits) {
        if (e - s < 15) continue; // don't create slivers around existing events
        const block: TimeBlock = {
          id: this.newId(),
          start: fromMinutes(s),
          end: fromMinutes(e),
          categoryId: p.categoryId,
          ...(p.title ? { title: p.title } : {}),
          source: 'plan',
          status: 'planned',
        };
        await this.repo.saveBlock(block);
        saved.push(block);
      }
    }
    return {
      blocks: saved,
      displaced: Object.entries(displaced)
        .map(([categoryId, minutes]) => ({ categoryId, minutes }))
        .sort((a, b) => b.minutes - a.minutes),
    };
  }

  /** Side-by-side minutes per category: what happened vs. what the optimal day proposed. */
  async compare(date: DateKey): Promise<DayComparison | null> {
    const optimal = await this.optimalDay(date);
    if (!optimal) return null;
    const optimalBlocks: TimeBlock[] = optimal.blocks.map((b, i) => ({ ...b, id: `opt${i}`, source: 'user' }));
    return {
      date,
      actualMinutes: minutesByCategory(await this.loggedDay(date), date),
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
    const built = await this.buildRoutines(today, now);
    if (!built) return null;
    for (const r of built.routines) await this.repo.saveRoutine(r);
    return built.routines;
  }

  /** Routine generation without saving: the routines plus the optimizer run behind each. */
  private async buildRoutines(today: DateKey, now: LocalDateTime) {
    if (!(await this.readiness(today)).ready) return null;
    let routines = await this.repo.listRoutines();
    if (routines.length === 0) {
      routines = [
        { id: this.newId(), name: 'Weekdays', weekdays: [1, 2, 3, 4, 5], blocks: [] },
        { id: this.newId(), name: 'Weekend', weekdays: [0, 6], blocks: [] },
      ];
    }
    const [categories, goals, settings, insights, decisions] = await Promise.all([
      this.repo.listCategories(),
      this.repo.listGoals(),
      this.repo.getSettings(),
      this.insights(today),
      this.repo.listSuggestionDecisions(),
    ]);
    const keepAsUsual = rejectedCategories(decisions);
    const out: Array<{ routine: Routine; plan: OptimalDay; input: OptimizerInput }> = [];
    for (const r of routines) {
      const date = nextDateOn(today, r.weekdays);
      const kept = r.blocks.filter((b) => b.edited);
      const fixedBlocks = routineOps.planForDate([{ ...r, blocks: kept, weekdays: [0, 1, 2, 3, 4, 5, 6] }], date, []);
      const input: OptimizerInput = { date, categories, goals: goals.filter((g) => g.active), insights, fixedBlocks, settings, keepAsUsual };
      const plan = this.optimizer.plan(input);
      const fresh = routineOps.blocksFromOptimalDay({ ...plan, blocks: plan.blocks.filter((b) => b.origin === 'planned') }, this.newId);
      out.push({ routine: { ...r, blocks: routineOps.normalize([...kept, ...fresh]), generatedAt: now }, plan, input });
    }
    return { routines: out.map((x) => x.routine), runs: out };
  }

  // -- Coach: "looks like…, I think this routine would work better" -------------

  /**
   * What stands out in the user's recent history, and a routine that addresses
   * it, shown next to their usual day for the next weekday. Null until there
   * is enough history, or when nothing stands out. Observations the user
   * already turned down ("Not for me" on the matching suggestion) are left out.
   */
  async coach(today: DateKey, now: LocalDateTime): Promise<CoachProposal | null> {
    const built = await this.buildRoutines(today, now);
    if (!built) return null;
    const [categories, decisions, progress] = await Promise.all([
      this.activeCategories(),
      this.repo.listSuggestionDecisions(),
      this.goalProgress(addDays(today, -14), addDays(today, -1)),
    ]);
    const rejected = new Set(decisions.filter((d) => d.decision === 'rejected').map((d) => d.key));
    const run = built.runs.find((x) => x.routine.weekdays.some((d) => d >= 1 && d <= 5)) ?? built.runs[0]!;
    const observations = observe({
      categories,
      insights: run.input.insights,
      goals: run.input.goals,
      progress,
    }).filter((o) => !o.suggestionKey || !rejected.has(o.suggestionKey));
    if (observations.length === 0) return null;

    // "How it is now": the most recent well-logged day of the same kind, exactly as logged.
    const { dates } = await this.history(today);
    const usualDate = [...dates].reverse().find((d) => run.routine.weekdays.includes(new Date(`${d}T00:00:00Z`).getUTCDay()));
    if (!usualDate) return null;
    const [ds, de] = dayWindow(usualDate);
    const usual = (await this.loggedDay(usualDate)).map((b) => ({
      ...b,
      start: fromMinutes(Math.max(ds, toMinutes(b.start))),
      end: fromMinutes(Math.min(de, toMinutes(b.end))),
    }));
    const byKey = new Map(decisions.map((d) => [d.key, d.decision]));
    return {
      headline: headline(observations),
      observations,
      date: run.input.date,
      usual,
      usualDate,
      proposed: run.plan.blocks,
      suggestions: run.plan.suggestions.map((s) => (byKey.has(s.key) ? { ...s, decision: byKey.get(s.key)! } : s)),
      reclaimedMinutes: run.plan.reclaimedMinutes,
      routines: built.routines,
    };
  }

  /** "Use this routine": saves exactly the routines the proposal showed. */
  async acceptCoachProposal(proposal: CoachProposal): Promise<Routine[]> {
    for (const r of proposal.routines) await this.repo.saveRoutine(r);
    return proposal.routines;
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
      this.activeCategories(),
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
    const [routines, categories, dayBlocks] = await Promise.all([this.repo.listRoutines(), this.repo.listCategories(), this.loggedDay(date)]);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (!routineOps.routineForWeekday(routines, weekday)) return null;
    const fixedCats = new Set(categories.filter((c) => c.flexibility === 'fixed').map((c) => c.id));
    return routineOps.planForDate(routines, date, dayBlocks.filter((b) => b.locked || fixedCats.has(b.categoryId)));
  }

  /** How closely a logged day followed its routine (0–1), or null if there's nothing to compare. */
  async adherence(date: DateKey): Promise<number | null> {
    const plan = await this.planForDate(date);
    return plan ? routineOps.adherence(await this.loggedDay(date), plan, date) : null;
  }

  // -- internals --------------------------------------------------------------

  /** Well-logged days in the `historyDays` before `date`, plus their blocks. */
  private async history(date: DateKey) {
    const from = addDays(date, -this.historyDays);
    // Include the evening before `from` so sleep that started then is counted.
    const blocks = (await this.repo.listBlocks(`${addDays(from, -1)}T00:00`, `${date}T00:00`)).filter(isLogged);
    const dates = wellLoggedDays(blocks, dateRange(from, addDays(date, -1)), await this.repo.getSettings());
    return { blocks, dates };
  }

  private async requireRoutine(id: string): Promise<Routine> {
    const r = (await this.repo.listRoutines()).find((x) => x.id === id);
    if (!r) throw new Error(`Unknown routine ${id}`);
    return r;
  }

  /** The activity must exist and not be archived (new entries can't use archived activities). */
  private async requireCategory(id: string): Promise<void> {
    const c = (await this.repo.listCategories()).find((x) => x.id === id);
    if (!c) throw new Error(`Unknown category ${id}`);
    if (c.archived) throw new Error(`"${c.name}" is archived; unarchive it to use it again`);
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

/** False for plan blocks the user hasn't confirmed yet; those must not count as things that happened. */
function isLogged(b: TimeBlock): boolean {
  return b.status !== 'planned';
}

/** Categories with a rejected suggestion: the optimizer keeps them at their usual level. */
function rejectedCategories(decisions: SuggestionRecord[]): string[] {
  return [...new Set(decisions.filter((d) => d.decision === 'rejected').map((d) => d.categoryId))];
}

function sumSpans(spans: Array<[number, number]>): number {
  return spans.reduce((sum, [s, e]) => sum + (e - s), 0);
}

/** Parts of [s, e) not covered by any of `taken`. */
function cutAround([s, e]: [number, number], taken: Array<[number, number]>): Array<[number, number]> {
  let pieces: Array<[number, number]> = [[s, e]];
  for (const [ts, te] of taken) {
    pieces = pieces.flatMap(([ps, pe]): Array<[number, number]> =>
      te <= ps || ts >= pe ? [[ps, pe]] : [...(ts > ps ? [[ps, ts] as [number, number]] : []), ...(te < pe ? [[te, pe] as [number, number]] : [])],
    );
  }
  return pieces;
}
