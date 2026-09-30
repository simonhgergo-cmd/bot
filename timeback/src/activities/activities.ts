import type { Category, Enjoyment, Flexibility, TimeWindow } from '../domain/types.ts';
import { parseTime } from '../domain/time.ts';

/** What the user fills in when adding an activity. Everything but the name has a sensible default. */
export interface ActivityInput {
  name: string;
  emoji?: string;
  color?: string;
  enjoyment?: Enjoyment;
  flexibility?: Flexibility;
  preferredTimes?: TimeWindow[];
  sessionMinutes?: number;
}

/** Quick picks for "When would you like to do it?". Custom windows are allowed too. */
export const TIME_PRESETS: Record<'morning' | 'afternoon' | 'evening' | 'night', TimeWindow> = {
  morning: { start: '06:00', end: '12:00' },
  afternoon: { start: '12:00', end: '17:00' },
  evening: { start: '17:00', end: '22:00' },
  night: { start: '22:00', end: '02:00' },
};

const ENJOYMENT: Enjoyment[] = ['loves', 'neutral', 'dislikes'];
const FLEXIBILITY: Flexibility[] = ['fixed', 'essential', 'flexible'];

/**
 * Check an activity against the ones that exist. Throws with a message fit to
 * show the user. `selfId` is the activity being edited, if any.
 */
export function validateActivity(input: ActivityInput, existing: Category[], selfId?: string): void {
  const name = input.name.trim();
  if (!name) throw new Error('Give the activity a name');
  if (name.length > 40) throw new Error('Keep the name under 40 characters');
  const clash = existing.find((c) => c.id !== selfId && !c.archived && c.name.trim().toLowerCase() === name.toLowerCase());
  if (clash) throw new Error(`You already have an activity called "${clash.name}"`);
  if (input.enjoyment && !ENJOYMENT.includes(input.enjoyment)) throw new Error(`Unknown enjoyment: ${input.enjoyment}`);
  if (input.flexibility && !FLEXIBILITY.includes(input.flexibility)) throw new Error(`Unknown flexibility: ${input.flexibility}`);
  if (input.sessionMinutes !== undefined) {
    const m = input.sessionMinutes;
    if (!Number.isInteger(m) || m < 5 || m > 12 * 60 || m % 5) throw new Error('A session must be 5 minutes to 12 hours, in 5-minute steps');
  }
  for (const w of input.preferredTimes ?? []) {
    if (parseTime(w.start) === parseTime(w.end)) throw new Error('A time window needs different start and end times');
  }
}

/** Build the stored activity. Custom activities default to "neutral" and "flexible". */
export function toCategory(id: string, input: ActivityInput): Category {
  return {
    id,
    name: input.name.trim(),
    enjoyment: input.enjoyment ?? 'neutral',
    flexibility: input.flexibility ?? 'flexible',
    ...(input.emoji ? { emoji: input.emoji } : {}),
    ...(input.color ? { color: input.color } : {}),
    ...(input.preferredTimes?.length ? { preferredTimes: input.preferredTimes } : {}),
    ...(input.sessionMinutes ? { sessionMinutes: input.sessionMinutes } : {}),
  };
}

/** Readable, stable id from the name ("Guitar practice" → "guitar-practice"), unique among `taken`. */
export function activityId(name: string, taken: Set<string>): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '') // é → e
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'activity';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}
