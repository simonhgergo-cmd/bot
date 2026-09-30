import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededApp } from '../scripts/fixtures.ts';
import { toMinutes } from '../src/domain/time.ts';
import { activityId } from '../src/activities/activities.ts';
import { blockMinutes } from '../src/routine/routine.ts';

const TODAY = '2026-09-30';
const TOMORROW = '2026-10-01';
const EVENING = { start: '19:00', end: '22:00' };

const minutesOf = (blocks: Array<{ start: string; end: string; categoryId: string }>, id: string) =>
  blocks.filter((b) => b.categoryId === id).reduce((m, b) => m + toMinutes(b.end) - toMinutes(b.start), 0);

test('adding an activity: readable unique ids, defaults, and user-facing validation', async () => {
  const app = await seededApp(TODAY);
  const guitar = await app.addActivity({ name: '  Guitar practice ', emoji: '🎸' });
  assert.deepEqual(guitar, { id: 'guitar-practice', name: 'Guitar practice', enjoyment: 'neutral', flexibility: 'flexible', emoji: '🎸' });

  await assert.rejects(app.addActivity({ name: 'guitar PRACTICE' }), /already have an activity called "Guitar practice"/);
  await assert.rejects(app.addActivity({ name: '   ' }), /name/);
  await assert.rejects(app.addActivity({ name: 'Yoga', sessionMinutes: 7 }), /5-minute steps/);
  await assert.rejects(app.addActivity({ name: 'Yoga', preferredTimes: [{ start: '18:00', end: '18:00' }] }), /different start and end/);

  assert.equal(activityId('Café ☕', new Set()), 'cafe');
  assert.equal(activityId('日本語', new Set(['activity'])), 'activity-2');
  assert.equal(activityId('Sleep', new Set(['sleep'])), 'sleep-2'); // never collides with built-ins

  const renamed = await app.updateActivity(guitar.id, { name: 'Guitar', enjoyment: 'loves' });
  assert.equal(renamed.id, 'guitar-practice', 'renaming keeps the id and so all history');
  assert.equal(renamed.enjoyment, 'loves');
});

test('a brand-new loved activity with no history gets planned, in its preferred time, in whole sessions', async () => {
  const app = await seededApp(TODAY);
  const guitar = await app.addActivity({ name: 'Guitar', emoji: '🎸', enjoyment: 'loves', preferredTimes: [EVENING], sessionMinutes: 45 });
  await app.addBlock({ start: `${TOMORROW}T09:00`, end: `${TOMORROW}T17:00`, categoryId: 'work' });

  const plan = (await app.optimalDay(TOMORROW))!;
  const blocks = plan.blocks.filter((b) => b.categoryId === guitar.id);
  assert.ok(blocks.length > 0, 'the new activity got time');
  for (const b of blocks) {
    const len = toMinutes(b.end) - toMinutes(b.start);
    assert.ok(len >= 45, `block ${b.start}–${b.end} is shorter than one session`);
    assert.ok(b.start >= `${TOMORROW}T19:00` && b.end <= `${TOMORROW}T22:00`, `block ${b.start}–${b.end} outside 19:00–22:00`);
  }
  assert.ok(plan.suggestions.some((s) => s.categoryId === guitar.id && s.kind === 'reclaim' && s.message.startsWith('Guitar')));

  // Routines pick it up too.
  const [weekdays] = (await app.generateRoutines(TODAY, `${TODAY}T20:00`))!;
  const inRoutine = weekdays!.blocks.filter((b) => b.categoryId === guitar.id);
  assert.ok(inRoutine.length > 0 && inRoutine.every((b) => blockMinutes(b) >= 45));
});

test('a new loved activity still gets a session when goals use up the freed time', async () => {
  const app = await seededApp(TODAY);
  // These goals consume nearly all time freed by cutting scrolling.
  await app.setGoal({ label: 'Sleep 8h', categoryId: 'sleep', comparison: 'atLeast', targetMinutes: 480, period: 'day' });
  await app.setGoal({ label: 'Max 1h scrolling', categoryId: 'scrolling', comparison: 'atMost', targetMinutes: 60, period: 'day' });
  await app.setGoal({ label: 'Exercise 150/wk', categoryId: 'exercise', comparison: 'atLeast', targetMinutes: 150, period: 'week' });
  const guitar = await app.addActivity({ name: 'Guitar', enjoyment: 'loves', preferredTimes: [EVENING], sessionMinutes: 45 });
  await app.addBlock({ start: `${TOMORROW}T09:00`, end: `${TOMORROW}T17:00`, categoryId: 'work' });

  const plan = (await app.optimalDay(TOMORROW))!;
  assert.ok(minutesOf(plan.blocks, guitar.id) >= 45, `guitar got ${minutesOf(plan.blocks, guitar.id)} min`);
  // Goals still hold.
  assert.ok(minutesOf(plan.blocks, 'sleep') >= 480);
  assert.ok(minutesOf(plan.blocks, 'scrolling') <= 60);
  // The time came from a neutral/disliked activity, and the plan says so.
  assert.ok(plan.suggestions.some((s) => s.kind === 'reduce' || s.kind === 'meetGoal'));
  // No sliver was left behind in the donor.
  for (const b of plan.blocks.filter((b) => b.origin === 'planned' && b.categoryId !== 'sleep')) {
    assert.ok(toMinutes(b.end) - toMinutes(b.start) >= 30, `${b.categoryId} ${b.start}–${b.end}`);
  }
});

test('goals on a custom activity are met in whole sessions', async () => {
  const app = await seededApp(TODAY);
  const reading = await app.addActivity({ name: 'Reading', preferredTimes: [{ start: '21:00', end: '23:00' }], sessionMinutes: 40 });
  await app.setGoal({ label: 'Read 30 min a day', categoryId: reading.id, comparison: 'atLeast', targetMinutes: 30, period: 'day' });
  const plan = (await app.optimalDay(TOMORROW))!;
  // 30 min rounded up to one 40-min session, then to the 15-min grid: 45.
  assert.equal(minutesOf(plan.blocks, reading.id), 45);
  assert.ok(plan.suggestions.some((s) => s.kind === 'meetGoal' && s.categoryId === reading.id));
});

test('the review offers a new activity during its preferred time, before it has any history', async () => {
  const app = await seededApp(TODAY);
  const guitar = await app.addActivity({ name: 'Guitar', preferredTimes: [EVENING] });
  await app.addBlock({ start: `${TODAY}T00:00`, end: `${TODAY}T19:00`, categoryId: 'work' });
  await app.addBlock({ start: `${TODAY}T21:00`, end: `${TODAY}T23:59`, categoryId: 'sleep' });
  const review = await app.startReview(TODAY);
  const q = review.questions.find((x) => x.gap.start === `${TODAY}T19:00`)!;
  assert.ok(q.suggestedCategoryIds.slice(0, 3).includes(guitar.id), `got ${q.suggestedCategoryIds.slice(0, 3)}`);

  // Logging it works like any other activity.
  await app.submitReview(TODAY, [{ questionId: q.id, parts: [{ start: q.gap.start, end: q.gap.end, categoryId: guitar.id }] }], `${TODAY}T22:00`);
  assert.equal(minutesOf(await app.day(TODAY), guitar.id), 120);
});

test('archive: history stays, but it is no longer planned, offered or loggable; unarchive restores', async () => {
  const app = await seededApp(TODAY);
  await app.setArchived('tv', true);
  assert.ok((await app.categories()).some((c) => c.id === 'tv'), 'still listed for history');
  assert.ok(!(await app.activeCategories()).some((c) => c.id === 'tv'));
  assert.ok((await app.insights(TOMORROW)).byCategory.tv!.avgMinutesPerDay > 0, 'history still analyzed');

  const plan = (await app.optimalDay(TOMORROW))!;
  assert.equal(minutesOf(plan.blocks, 'tv'), 0);
  const review = await app.startReview(TODAY);
  assert.ok(review.questions.every((q) => !q.suggestedCategoryIds.includes('tv')));
  await assert.rejects(app.addBlock({ start: `${TODAY}T20:00`, end: `${TODAY}T21:00`, categoryId: 'tv' }), /archived/);

  await app.setArchived('tv', false);
  assert.ok(minutesOf((await app.optimalDay(TOMORROW))!.blocks, 'tv') > 0);
});

test('merge moves history, goals and routine blocks; delete is only for unused activities', async () => {
  const app = await seededApp(TODAY);
  const jogging = await app.addActivity({ name: 'Jogging' });
  await app.addBlock({ start: `${TODAY}T07:00`, end: `${TODAY}T07:30`, categoryId: jogging.id });
  // Routines first, so jogging is only in the one block placed by hand below.
  const [weekdays] = (await app.generateRoutines(TODAY, `${TODAY}T20:00`))!;
  await app.placeRoutineBlock(weekdays!.id, { start: '06:30', end: '07:00', categoryId: jogging.id });
  await app.setGoal({ label: 'Jog', categoryId: jogging.id, comparison: 'atLeast', targetMinutes: 60, period: 'week' });

  await assert.rejects(app.deleteActivity(jogging.id), /has history/);
  const moved = await app.mergeActivities(jogging.id, 'exercise');
  assert.deepEqual(moved, { blocks: 1, goals: 1, routines: 1 });
  assert.ok(!(await app.categories()).some((c) => c.id === jogging.id));
  assert.equal(minutesOf(await app.day(TODAY), 'exercise'), 30);
  assert.equal((await app.goals())[0]!.categoryId, 'exercise');
  assert.ok((await app.routines())[0]!.blocks.some((b) => b.start === '06:30' && b.categoryId === 'exercise'));

  const unused = await app.addActivity({ name: 'Pottery' });
  await app.deleteActivity(unused.id);
  assert.ok(!(await app.categories()).some((c) => c.id === unused.id));
});
