import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededApp } from '../scripts/fixtures.ts';
import { toMinutes } from '../src/domain/time.ts';

const TODAY = '2026-09-30';
const TOMORROW = '2026-10-01';

test('"Not for me" keeps the activity at its usual level; "Try it" is remembered; both can be undone', async () => {
  const app = await seededApp(TODAY);
  const plan = (await app.optimalDay(TOMORROW))!;
  const reduce = plan.suggestions.find((s) => s.key === 'reduce:scrolling')!;
  assert.ok(reduce && reduce.deltaMinutes < 0, 'expected a suggestion to cut scrolling');
  const reclaim = plan.suggestions.find((s) => s.kind === 'reclaim')!;

  await app.decideSuggestion(reclaim, 'accepted', `${TODAY}T21:00`);
  assert.equal((await app.optimalDay(TOMORROW))!.suggestions.find((s) => s.key === reclaim.key)?.decision, 'accepted');

  // Rejecting "cut scrolling" frees less time, so other suggestions may shrink or vanish; decisions stay stored.
  await app.decideSuggestion(reduce, 'rejected', `${TODAY}T21:05`);
  const after = (await app.optimalDay(TOMORROW))!;
  assert.equal(after.suggestions.find((s) => s.categoryId === 'scrolling'), undefined, 'rejected suggestion is not re-proposed');
  const minutes = (p: typeof plan, id: string) =>
    p.blocks.filter((b) => b.categoryId === id).reduce((m, b) => m + toMinutes(b.end) - toMinutes(b.start), 0);
  assert.ok(minutes(after, 'scrolling') > minutes(plan, 'scrolling'), 'scrolling back near its usual level');

  // Routines respect it too.
  const [weekdays] = (await app.generateRoutines(TODAY, `${TODAY}T21:00`))!;
  const routineScrolling = weekdays!.blocks.filter((b) => b.categoryId === 'scrolling').length;
  assert.ok(routineScrolling > 0);

  await app.clearSuggestionDecision(reduce.key);
  assert.ok((await app.optimalDay(TOMORROW))!.suggestions.some((s) => s.key === reduce.key));
  assert.deepEqual((await app.suggestionDecisions()).map((d) => d.key), [reclaim.key]);
});

test('applyPlan writes planned blocks around existing events, and re-applying replaces them', async () => {
  const app = await seededApp(TODAY);
  await app.addBlock({ start: `${TOMORROW}T09:00`, end: `${TOMORROW}T17:00`, categoryId: 'work', title: 'Office' });
  await app.addBlock({ start: `${TOMORROW}T19:30`, end: `${TOMORROW}T21:00`, categoryId: 'social', title: 'Dinner with Sam' });

  const { blocks: planned, displaced } = await app.applyPlan(TOMORROW);
  assert.ok(planned.length > 5);
  // The dinner sits on top of planned evening time; the app reports what it pushed out.
  const plannedEvening = (await app.optimalDay(TOMORROW))!.blocks
    .filter((b) => b.origin === 'planned' && b.end > `${TOMORROW}T19:30` && b.start < `${TOMORROW}T21:00`);
  assert.ok(plannedEvening.length > 0);
  assert.equal(displaced.reduce((m, d) => m + d.minutes, 0), 90, 'the 90-minute dinner displaces 90 planned minutes');
  assert.ok(planned.every((b) => b.status === 'planned' && b.source === 'plan'));
  const day = await app.day(TOMORROW);
  const spans = day.map((b) => [toMinutes(b.start), toMinutes(b.end)] as const).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i]![0] >= spans[i - 1]![1], 'plan overlaps an existing event');
  assert.ok(day.some((b) => b.title === 'Dinner with Sam'), 'user events untouched');

  const again = await app.applyPlan(TOMORROW);
  assert.equal((await app.day(TOMORROW)).filter((b) => b.status === 'planned').length, again.blocks.length, 'no duplicates');

  // Only the rest of the day.
  const rest = await app.applyPlan(TOMORROW, { from: `${TOMORROW}T18:00` });
  assert.ok(rest.blocks.every((b) => b.start >= `${TOMORROW}T18:00`));
  assert.equal(rest.displaced.reduce((m, d) => m + d.minutes, 0), 90, 'time before `from` is not "displaced"');
});

test('planned blocks do not count as having happened until the review confirms them', async () => {
  const app = await seededApp(TODAY);
  const before = await app.insights(TOMORROW);
  await app.addBlock({ start: `${TODAY}T00:00`, end: `${TODAY}T07:00`, categoryId: 'sleep' });
  const { blocks: planned } = await app.applyPlan(TODAY, { from: `${TODAY}T07:00` });

  // Not learned from, not counted toward goals.
  assert.equal((await app.insights(TOMORROW)).daysAnalyzed, before.daysAnalyzed, 'unconfirmed plan counted as logged');
  await app.setGoal({ label: 'Exercise', categoryId: 'exercise', comparison: 'atLeast', targetMinutes: 1, period: 'day' });
  assert.equal((await app.goalProgress(TODAY, TODAY))[0]!.progress[0]!.actualMinutes, 0);
  assert.deepEqual(await app.pendingReviews(TOMORROW), [TODAY]);

  // The review asks about planned blocks instead of treating their time as gaps.
  const review = await app.startReview(TODAY);
  const confirmQs = review.questions.filter((q) => q.plannedBlockId);
  assert.equal(confirmQs.length, planned.length);
  assert.match(confirmQs[0]!.prompt, /^Did you do .* as planned\?$/);
  assert.equal(review.questions.length, confirmQs.length, 'planned time was also asked about as a gap');

  // Confirm all but the first; the first actually went differently.
  const [first, ...rest] = confirmQs;
  const changes = await app.submitReview(TODAY, [
    { questionId: first!.id, parts: [{ start: first!.gap.start, end: first!.gap.end, categoryId: 'scrolling' }] },
    ...rest.map((q) => ({ questionId: q.id, confirmed: true })),
  ], `${TODAY}T23:00`);
  assert.equal(changes.remove.length, 1);
  assert.equal(changes.confirm.length, rest.length);

  const day = await app.day(TODAY);
  assert.ok(day.every((b) => b.status !== 'planned'), 'everything answered is now logged');
  assert.ok(day.some((b) => b.start === first!.gap.start && b.categoryId === 'scrolling'));
  assert.equal((await app.insights(TOMORROW)).daysAnalyzed, before.daysAnalyzed + 1, 'confirmed day now teaches the model');
  assert.deepEqual(await app.pendingReviews(TOMORROW), []);

  await assert.rejects(app.submitReview(TODAY, [{ questionId: first!.id, confirmed: true, parts: [] }], `${TODAY}T23:00`), /either/);
});
