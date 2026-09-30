import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../src/routine/routine.ts';
import type { Goal, Routine, RoutineBlock } from '../src/domain/types.ts';
import { seededApp } from '../scripts/fixtures.ts';

let n = 0;
const id = () => `n${++n}`;
const blk = (start: string, end: string, categoryId: string, extra: Partial<RoutineBlock> = {}): RoutineBlock => ({ id: id(), start, end, categoryId, ...extra });
const span = (r: Routine) => r.blocks.map((b) => `${b.start}-${b.end} ${b.categoryId}`);

test('time validation', () => {
  assert.equal(R.parseTime('07:30'), 450);
  assert.throws(() => R.parseTime('24:00'));
  assert.throws(() => R.parseTime('07:32'), /multiples/);
  assert.equal(R.blockMinutes({ start: '23:00', end: '07:00' }), 480);
});

test('placing a block splits the one underneath', () => {
  const r: Routine = { id: 'r', name: 'x', weekdays: [1], blocks: [blk('23:00', '07:00', 'sleep'), blk('07:00', '23:00', 'hobby')] };
  const out = R.placeBlock(r, blk('12:00', '13:00', 'exercise'), id);
  assert.deepEqual(span(out), ['07:00-12:00 hobby', '12:00-13:00 exercise', '13:00-23:00 hobby', '23:00-07:00 sleep']);
  assert.equal(out.blocks.find((b) => b.categoryId === 'exercise')!.edited, true);
  assert.equal(R.unplannedMinutes(out), 0);
});

test('placing across midnight trims a wrapping block; moving a block leaves a hole', () => {
  const sleep = blk('23:00', '07:00', 'sleep');
  const r: Routine = { id: 'r', name: 'x', weekdays: [1], blocks: [sleep, blk('07:00', '23:00', 'hobby')] };
  const out = R.placeBlock(r, blk('22:30', '00:30', 'tv'), id);
  assert.deepEqual(span(out), ['00:30-07:00 sleep', '07:00-22:30 hobby', '22:30-00:30 tv']);

  // Move sleep 30 min later: the old 23:00–23:30 becomes unplanned.
  const moved = R.placeBlock(r, { ...sleep, start: '23:30', end: '07:30' }, id);
  assert.deepEqual(span(moved), ['07:30-23:00 hobby', '23:30-07:30 sleep']);
  assert.equal(R.unplannedMinutes(moved), 30);
});

test('normalize merges across midnight, but keeps edited and generated blocks apart', () => {
  assert.deepEqual(R.normalize([blk('00:00', '07:00', 'sleep'), blk('23:00', '00:00', 'sleep')]).map((b) => `${b.start}-${b.end}`), ['23:00-07:00']);
  assert.equal(R.normalize([blk('00:00', '07:00', 'sleep', { edited: true }), blk('23:00', '00:00', 'sleep')]).length, 2);
});

test('planForDate: each date uses its own routine as a clock face; calendar events cut in', () => {
  const weekend: Routine = { id: 'we', name: 'Weekend', weekdays: [0, 6], blocks: [blk('00:30', '09:00', 'sleep'), blk('09:00', '00:30', 'social')] };
  const weekdays: Routine = { id: 'wd', name: 'Weekdays', weekdays: [1, 2, 3, 4, 5], blocks: [blk('23:00', '07:00', 'sleep'), blk('07:00', '23:00', 'work')] };
  const show = (d: string, fixed: Parameters<typeof R.planForDate>[2] = []) =>
    R.planForDate([weekend, weekdays], d, fixed).map((b) => `${b.start.slice(11)}-${b.end.slice(11)} ${b.categoryId}`);

  // Monday: weekday clock face, with a dentist appointment cut into work.
  assert.deepEqual(show('2026-09-28', [{ id: 'dentist', start: '2026-09-28T15:00', end: '2026-09-28T16:00', categoryId: 'chores', source: 'user' }]), [
    '00:00-07:00 sleep',
    '07:00-15:00 work',
    '15:00-16:00 chores',
    '16:00-23:00 work',
    '23:00-00:00 sleep',
  ]);
  // Sunday: weekend clock face, the late social evening shows up at both ends.
  assert.deepEqual(show('2026-09-27'), ['00:00-00:30 social', '00:30-09:00 sleep', '09:00-00:00 social']);
});

test('goal check: daily per routine, weekly across routines', () => {
  const weekdays: Routine = { id: 'wd', name: 'W', weekdays: [1, 2, 3, 4, 5], blocks: [blk('23:30', '07:00', 'sleep'), blk('18:00', '18:30', 'exercise')] };
  const weekend: Routine = { id: 'we', name: 'E', weekdays: [0, 6], blocks: [blk('00:00', '09:00', 'sleep'), blk('10:00', '11:00', 'exercise')] };
  const goals: Goal[] = [
    { id: 's', label: 'Sleep 8h', categoryId: 'sleep', comparison: 'atLeast', targetMinutes: 480, period: 'day', active: true },
    { id: 'e', label: 'Exercise 150/wk', categoryId: 'exercise', comparison: 'atLeast', targetMinutes: 150, period: 'week', active: true },
  ];
  const [sleep, exercise] = R.checkGoals(weekdays, [weekdays, weekend], goals);
  assert.deepEqual([sleep!.plannedMinutes, sleep!.met], [450, false]);
  assert.deepEqual([exercise!.plannedMinutes, exercise!.met], [5 * 30 + 2 * 60, true]);
});

test('app: generate routines, edit one, regenerate keeps the edit', async () => {
  const today = '2026-09-30';
  const app = await seededApp(today);
  assert.equal(await app.planForDate(today), null);
  await app.setGoal({ label: 'Sleep 8h', categoryId: 'sleep', comparison: 'atLeast', targetMinutes: 480, period: 'day' });

  const [weekdays, weekend] = (await app.generateRoutines(today, `${today}T20:00`))!;
  assert.deepEqual([weekdays!.name, weekend!.name], ['Weekdays', 'Weekend']);
  for (const r of [weekdays!, weekend!]) assert.equal(R.unplannedMinutes(r), 0);
  assert.ok((await app.checkRoutine(weekdays!.id, today)).goals[0]!.met);

  // User: "I read 21:00–22:00 on weekdays."
  const edited = await app.placeRoutineBlock(weekdays!.id, { start: '21:00', end: '22:00', categoryId: 'hobby', title: 'Reading' });
  assert.ok(edited.blocks.some((b) => b.title === 'Reading' && b.edited));
  assert.equal(R.unplannedMinutes(edited), 0);

  const [again] = (await app.generateRoutines(today, `${today}T21:00`))!;
  const reading = again!.blocks.filter((b) => b.title === 'Reading');
  assert.deepEqual(reading.map((b) => [b.start, b.end, b.edited]), [['21:00', '22:00', true]]);
  assert.equal(R.unplannedMinutes(again!), 0);

  // Tomorrow (Thursday) follows the weekday routine, with a calendar event on top.
  await app.addBlock({ start: '2026-10-01T09:00', end: '2026-10-01T17:00', categoryId: 'work', title: 'Office' });
  const plan = (await app.planForDate('2026-10-01'))!;
  assert.ok(plan.some((b) => b.title === 'Office' && b.start === '2026-10-01T09:00'));
  assert.ok(plan.some((b) => b.title === 'Reading' && b.start === '2026-10-01T21:00'));
  assert.equal(await app.adherence('2026-10-01'), 1); // only the office block is logged, and it matches

  await assert.rejects(app.saveRoutine({ ...weekend!, weekdays: [0, 6, 1] }), /already belongs/);
});

test('app: an edit that breaks a weekly goal is repaired by re-planning around it', async () => {
  const today = '2026-09-30';
  const app = await seededApp(today);
  // goals[0] below is the exercise goal.
  await app.setGoal({ label: 'Exercise 150/wk', categoryId: 'exercise', comparison: 'atLeast', targetMinutes: 150, period: 'week' });
  await app.setGoal({ label: 'Sleep 8h', categoryId: 'sleep', comparison: 'atLeast', targetMinutes: 480, period: 'day' });
  await app.setGoal({ label: 'Max 1h scrolling', categoryId: 'scrolling', comparison: 'atMost', targetMinutes: 60, period: 'day' });
  const [weekdays] = (await app.generateRoutines(today, `${today}T20:00`))!;

  // Reading 21:00–22:00 on weekdays eats into the evening exercise slot.
  const edited = await app.placeRoutineBlock(weekdays!.id, { start: '21:00', end: '22:00', categoryId: 'hobby', title: 'Reading' });
  assert.equal((await app.checkRoutine(edited.id, today)).goals[0]!.met, false);

  // Re-planning keeps the edit and must win the goal back (a weekly goal rounded
  // down to 15 min/day used to leave it at 135 of 150 min).
  const [replanned] = (await app.generateRoutines(today, `${today}T21:00`))!;
  const check = await app.checkRoutine(replanned!.id, today);
  assert.equal(check.goals[0]!.met, true, `planned ${check.goals[0]!.plannedMinutes} min/week`);
  assert.ok(replanned!.blocks.some((b) => b.title === 'Reading' && b.start === '21:00' && b.edited));
});
