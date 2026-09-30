/**
 * Core domain model. Everything else in the app is built on these types.
 *
 * Times are "naive local" ISO strings (`2026-09-30T14:30`) — the user's wall
 * clock. Timezone handling belongs at the UI/device boundary, not in the core.
 */

/** `YYYY-MM-DD` */
export type DateKey = string;
/** `YYYY-MM-DDTHH:mm` (local wall-clock time) */
export type LocalDateTime = string;

/** How the user feels about an activity. Drives what the optimizer grows or shrinks. */
export type Enjoyment = 'loves' | 'neutral' | 'dislikes';

/**
 * Whether time spent in a category can be moved/resized by the optimizer.
 * - `fixed`: externally scheduled (work shift, class). Never moved.
 * - `essential`: must happen, but timing/length is negotiable (meals, chores).
 * - `flexible`: discretionary (TV, gaming, hobbies).
 */
export type Flexibility = 'fixed' | 'essential' | 'flexible';

export interface Category {
  id: string;
  name: string;
  enjoyment: Enjoyment;
  flexibility: Flexibility;
  color?: string;
}

/** Where a block came from. */
export type BlockSource =
  | 'user' // entered in the main calendar like any normal calendar event
  | 'review' // filled in via the end-of-day question form
  | 'import'; // external calendar sync (future)

/** One entry in the user's real ("actual") calendar. */
export interface TimeBlock {
  id: string;
  start: LocalDateTime;
  end: LocalDateTime;
  categoryId: string;
  title?: string;
  source: BlockSource;
  /** User says this can't be moved (overrides category flexibility for this block). */
  locked?: boolean;
}

// ---------------------------------------------------------------------------
// End-of-day review
// ---------------------------------------------------------------------------

/** An unaccounted-for stretch of the day. */
export interface Gap {
  start: LocalDateTime;
  end: LocalDateTime;
}

/** One question in the end-of-day form: "What were you doing 14:00–15:30?" */
export interface ReviewQuestion {
  id: string;
  gap: Gap;
  prompt: string;
  /** Category ids ranked by how likely they are, based on history at this time of day. */
  suggestedCategoryIds: string[];
}

export interface ReviewAnswerPart {
  start: LocalDateTime;
  end: LocalDateTime;
  categoryId: string;
  title?: string;
}

/** A gap can be answered with one or more parts ("gym, then lunch"). */
export interface ReviewAnswer {
  questionId: string;
  parts: ReviewAnswerPart[];
}

export interface DayReview {
  date: DateKey;
  questions: ReviewQuestion[];
  completedAt?: LocalDateTime;
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

export type GoalPeriod = 'day' | 'week';
export type GoalComparison = 'atLeast' | 'atMost';

/** e.g. { categoryId: 'sleep', comparison: 'atLeast', targetMinutes: 480, period: 'day' } */
export interface Goal {
  id: string;
  label: string;
  categoryId: string;
  comparison: GoalComparison;
  targetMinutes: number;
  period: GoalPeriod;
  active: boolean;
}

export interface GoalProgress {
  goalId: string;
  periodStart: DateKey;
  actualMinutes: number;
  targetMinutes: number;
  met: boolean;
}

// ---------------------------------------------------------------------------
// Insights & optimal day
// ---------------------------------------------------------------------------

export interface CategoryStats {
  categoryId: string;
  avgMinutesPerDay: number;
  /** Index 0 = Sunday. Lets fixed commitments (work Mon–Fri) be predicted for days not yet planned. */
  avgMinutesByWeekday: number[];
  /**
   * For flexible categories: average share of the day's *free* time (time not
   * taken by fixed or essential categories). Scales sensibly between workdays
   * and days off, unlike a plain daily average.
   */
  shareOfFreeTime: number;
  /** Same, per weekday (index 0 = Sunday). Weekends are spent differently from workdays. */
  shareOfFreeTimeByWeekday: number[];
  /** Per 15-minute slot of the day (96 entries): how often this category occupied it (0–1). */
  slotProfile: number[];
  /** Typical start of the day's first block in this category, minutes after midnight. */
  typicalStartMinute: number | null;
}

export interface Insights {
  daysAnalyzed: number;
  /** How many analyzed days fell on each weekday (index 0 = Sunday). */
  daysByWeekday: number[];
  /** Share of analyzed time that was logged (0–1). Low coverage → weak suggestions. */
  coverage: number;
  byCategory: Record<string, CategoryStats>;
}

export type SuggestionKind =
  | 'meetGoal' // bring a goal into range (e.g. sleep 6h → 8h)
  | 'reduce' // cut back a disliked/time-sink activity
  | 'reclaim'; // hand freed-up time to something the user loves

export interface Suggestion {
  kind: SuggestionKind;
  categoryId: string;
  /** Positive = more time, negative = less time, versus the user's typical day. */
  deltaMinutes: number;
  message: string;
}

/** The "other" calendar: what the app thinks the day could look like. */
export interface OptimalDay {
  date: DateKey;
  blocks: Array<Omit<TimeBlock, 'source' | 'id'> & { origin: 'fixed' | 'planned' }>;
  suggestions: Suggestion[];
  /** Extra minutes the plan gives to loved activities versus the user's typical day. */
  reclaimedMinutes: number;
}

export interface Settings {
  /** Gaps shorter than this are not asked about. */
  minGapMinutes: number;
  /** Days of well-logged history required before the optimizer runs. */
  minDaysForSuggestions: number;
  /** Minimum logged coverage (0–1) for a day to count toward the threshold above. */
  minDayCoverage: number;
  /** How much of a disliked flexible activity the optimizer may cut per day (0–1). */
  maxReductionShare: number;
}

export const DEFAULT_SETTINGS: Settings = {
  minGapMinutes: 15,
  minDaysForSuggestions: 7,
  minDayCoverage: 0.8,
  maxReductionShare: 0.5,
};

// ---------------------------------------------------------------------------
// Routine: the editable optimal daily routine (third calendar)
// ---------------------------------------------------------------------------

/** `HH:mm`, a time of day with no date. */
export type TimeOfDay = string;

/**
 * One block of a routine. `end <= start` means it wraps past midnight
 * (sleep 23:00–07:00). Minutes must be multiples of 5.
 */
export interface RoutineBlock {
  id: string;
  start: TimeOfDay;
  end: TimeOfDay;
  categoryId: string;
  title?: string;
  /** Set when the user changes the block. Edited blocks survive regeneration. */
  edited?: boolean;
}

/**
 * A reusable ideal day, e.g. "Weekdays" (Mon–Fri) or "Weekend". It starts as
 * the optimizer's suggestion and becomes the user's own as they edit it.
 * The plan for any date is its routine, with calendar events laid on top.
 */
export interface Routine {
  id: string;
  name: string;
  /** 0 = Sunday … 6 = Saturday. A weekday belongs to at most one routine. */
  weekdays: number[];
  blocks: RoutineBlock[];
  generatedAt?: LocalDateTime;
}

export interface RoutineGoalCheck {
  goalId: string;
  label: string;
  /** Per day for daily goals; per week (across all routines) for weekly goals. */
  plannedMinutes: number;
  targetMinutes: number;
  met: boolean;
}

/** Live feedback while editing: what the routine adds up to versus the user's typical day. */
export interface RoutineCheck {
  routineId: string;
  plannedMinutes: Record<string, number>;
  typicalMinutes: Record<string, number>;
  unplannedMinutes: number;
  /** Extra minutes per day for loved activities versus the typical day. */
  reclaimedMinutes: number;
  goals: RoutineGoalCheck[];
}
