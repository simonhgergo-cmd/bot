import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findGaps, coverage, minutesByCategory } from '../src/calendar/dayView.ts';
import { answersToBlocks, buildReview } from '../src/review/endOfDayReview.ts';
import { currentStreak, evaluateGoal } from '../src/goals/goals.ts';
import { circularMeanMinute } from '../src/insights/insights.ts';
import { addDays, weekStart } from '../src/domain/time.ts';
import type { Goal, TimeBlock } from '../src/domain/types.ts';

const block = (start: string, end: string, categoryId: string): TimeBlock => ({ id: start, start, end, categoryId, source: 'user' });

test('date helpers', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(weekStart('2026-10-04'), '2026-09-28'); // Sunday → Monday
});

test('sleep across midnight is split between days', () => {
  const blocks = [block('2026-09-29T23:00', '2026-09-30T07:00', 'sleep')];
  assert.deepEqual(minutesByCategory(blocks, '2026-09-29'), { sleep: 60 });
  assert.deepEqual(minutesByCategory(blocks, '2026-09-30'), { sleep: 420 });
});

test('findGaps skips short gaps and respects `until`', () => {
  const blocks = [
    block('2026-09-30T00:00', '2026-09-30T07:00', 'sleep'),
    block('2026-09-30T07:10', '2026-09-30T12:00', 'work'),
    block('2026-09-30T11:00', '2026-09-30T13:00', 'meals'), // overlaps previous
  ];
  assert.deepEqual(findGaps(blocks, '2026-09-30', 15), [{ start: '2026-09-30T13:00', end: '2026-10-01T00:00' }]);
  const until = Date.parse('2026-09-30T18:00:00Z') / 60_000;
  assert.deepEqual(findGaps(blocks, '2026-09-30', 15, until), [{ start: '2026-09-30T13:00', end: '2026-09-30T18:00' }]);
  assert.equal(coverage(blocks, '2026-09-30'), 13 * 60 / 1440 - 10 / 1440);
});

test('review answers must stay inside their gap and use known categories', () => {
  const review = buildReview('2026-09-30', [{ start: '2026-09-30T13:00', end: '2026-09-30T15:00' }], []);
  const q = review.questions[0]!;
  assert.match(q.prompt, /13:00 and 15:00/);
  let n = 0;
  const ids = () => `b${++n}`;
  const known = new Set(['gym', 'meals']);

  const blocks = answersToBlocks(review, [{ questionId: q.id, parts: [
    { start: '2026-09-30T13:00', end: '2026-09-30T14:00', categoryId: 'gym' },
    { start: '2026-09-30T14:00', end: '2026-09-30T15:00', categoryId: 'meals' },
  ] }], known, ids);
  assert.equal(blocks.length, 2);
  assert.ok(blocks.every((b) => b.source === 'review'));

  assert.throws(() => answersToBlocks(review, [{ questionId: q.id, parts: [
    { start: '2026-09-30T12:00', end: '2026-09-30T14:00', categoryId: 'gym' },
  ] }], known, ids), /outside gap/);
  assert.throws(() => answersToBlocks(review, [{ questionId: q.id, parts: [
    { start: '2026-09-30T13:00', end: '2026-09-30T14:00', categoryId: 'nope' },
  ] }], known, ids), /Unknown category/);
});

test('daily and weekly goals', () => {
  const sleep: Goal = { id: 'g1', label: 'Sleep 8h', categoryId: 'sleep', comparison: 'atLeast', targetMinutes: 480, period: 'day', active: true };
  const blocks = [
    block('2026-09-28T00:00', '2026-09-28T08:00', 'sleep'),
    block('2026-09-29T00:00', '2026-09-29T06:00', 'sleep'),
    block('2026-09-30T00:00', '2026-09-30T08:30', 'sleep'),
  ];
  const p = evaluateGoal(sleep, blocks, '2026-09-28', '2026-09-30');
  assert.deepEqual(p.map((x) => x.met), [true, false, true]);
  assert.equal(currentStreak(p), 1);

  const weekly: Goal = { ...sleep, id: 'g2', comparison: 'atMost', targetMinutes: 20 * 60, period: 'week' };
  const w = evaluateGoal(weekly, blocks, '2026-09-28', '2026-09-30');
  assert.equal(w.length, 1);
  assert.equal(w[0]!.actualMinutes, 22.5 * 60);
  assert.equal(w[0]!.met, false);
});

test('circular mean handles midnight', () => {
  assert.equal(circularMeanMinute([23 * 60 + 30, 30]), 0);
  assert.equal(circularMeanMinute([22 * 60, 23 * 60]), 22 * 60 + 30);
});
