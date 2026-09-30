import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seededApp } from '../scripts/fixtures.ts';
import { toMinutes } from '../src/domain/time.ts';
import { JsonFileRepository } from '../src/storage/jsonFileRepository.ts';
import { TimebackApp } from '../src/app/timebackApp.ts';

const TODAY = '2026-09-30';

test('no optimal day until enough well-logged history exists', async () => {
  const app = await seededApp(TODAY, 3);
  assert.equal(await app.optimalDay(TODAY), null);
  assert.deepEqual(await app.readiness(TODAY), { ready: false, goodDays: 3, needed: 7 });
});

test('optimal day: full coverage, no overlaps, fixed blocks untouched, goals honoured', async () => {
  const app = await seededApp(TODAY);
  await app.setGoal({ label: 'Sleep 8h', categoryId: 'sleep', comparison: 'atLeast', targetMinutes: 480, period: 'day' });
  await app.setGoal({ label: 'Scrolling ≤ 1h', categoryId: 'scrolling', comparison: 'atMost', targetMinutes: 60, period: 'day' });
  await app.addBlock({ start: `${TODAY}T10:00`, end: `${TODAY}T16:00`, categoryId: 'work' });

  const plan = (await app.optimalDay(TODAY))!;
  assert.ok(plan);

  const spans = plan.blocks.map((b) => [toMinutes(b.start), toMinutes(b.end)] as const).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i]![0] >= spans[i - 1]![1], 'blocks overlap');
  assert.equal(spans.reduce((s, [a, b]) => s + (b - a), 0), 1440, 'day not fully planned');

  assert.ok(plan.blocks.some((b) => b.origin === 'fixed' && b.start === `${TODAY}T10:00` && b.end === `${TODAY}T16:00`));

  const cmp = (await app.compare(TODAY))!;
  assert.ok(cmp.optimalMinutes.sleep! >= 480);
  assert.ok(cmp.optimalMinutes.scrolling! <= 60);
  assert.ok(plan.reclaimedMinutes > 0);
  assert.ok(plan.suggestions.some((s) => s.kind === 'meetGoal' && s.categoryId === 'sleep'));
});

test('end-of-day review fills gaps and suggests likely categories', async () => {
  const app = await seededApp(TODAY);
  await app.addBlock({ start: `${TODAY}T09:00`, end: `${TODAY}T17:00`, categoryId: 'work' });
  const review = await app.startReview(TODAY, `${TODAY}T20:00`);
  assert.deepEqual(review.questions.map((q) => [q.gap.start, q.gap.end]), [
    [`${TODAY}T00:00`, `${TODAY}T09:00`],
    [`${TODAY}T17:00`, `${TODAY}T20:00`],
  ]);
  assert.equal(review.questions[0]!.suggestedCategoryIds[0], 'sleep');
  assert.deepEqual(await app.pendingReviews('2026-10-01'), [TODAY]);

  await app.submitReview(TODAY, review.questions.map((q) => ({
    questionId: q.id,
    parts: [{ start: q.gap.start, end: q.gap.end, categoryId: q.suggestedCategoryIds[0]! }],
  })), `${TODAY}T20:05`);
  assert.equal((await app.startReview(TODAY, `${TODAY}T20:00`)).questions.length, 0);
});

test('JSON file repository persists across instances', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'timeback-'));
  try {
    const path = join(dir, 'db.json');
    const a = new TimebackApp(await JsonFileRepository.open(path));
    await a.saveCategory({ id: 'sleep', name: 'Sleep', enjoyment: 'neutral', flexibility: 'essential' });
    await a.addBlock({ start: `${TODAY}T00:00`, end: `${TODAY}T07:00`, categoryId: 'sleep' });
    const b = new TimebackApp(await JsonFileRepository.open(path));
    assert.equal((await b.day(TODAY)).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('plans are not fragmented: no block under 30 min, and no activity scattered', async () => {
  const { blockMinutes } = await import('../src/routine/routine.ts');
  const app = await seededApp(TODAY);
  await app.setGoal({ label: 'Sleep 8h', categoryId: 'sleep', comparison: 'atLeast', targetMinutes: 480, period: 'day' });
  await app.setGoal({ label: 'Scrolling ≤ 1h', categoryId: 'scrolling', comparison: 'atMost', targetMinutes: 60, period: 'day' });
  await app.setGoal({ label: 'Exercise 150/wk', categoryId: 'exercise', comparison: 'atLeast', targetMinutes: 150, period: 'week' });
  await app.addBlock({ start: '2026-10-01T09:00', end: '2026-10-01T17:00', categoryId: 'work' });

  const check = (label: string, blocks: Array<{ categoryId: string; minutes: number }>) => {
    const short = blocks.filter((b) => b.minutes < 30);
    assert.deepEqual(short, [], `${label}: blocks under 30 min`);
    const pieces: Record<string, number> = {};
    for (const b of blocks) pieces[b.categoryId] = (pieces[b.categoryId] ?? 0) + 1;
    // Two pieces is legitimate (breakfast + dinner, commute there + back); more is scattering.
    for (const [id, n] of Object.entries(pieces)) assert.ok(n <= 2, `${label}: ${id} split into ${n} pieces`);
  };
  const plan = (await app.optimalDay('2026-10-01'))!;
  check('tomorrow', plan.blocks.filter((b) => b.origin === 'planned' && b.categoryId !== 'sleep') // sleep is split by midnight in a day view
    .map((b) => ({ categoryId: b.categoryId, minutes: toMinutes(b.end) - toMinutes(b.start) })));
  for (const r of (await app.generateRoutines(TODAY, `${TODAY}T20:00`))!) {
    check(r.name, r.blocks.map((b) => ({ categoryId: b.categoryId, minutes: blockMinutes(b) })));
  }
});
