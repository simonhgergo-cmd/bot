import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededApp, seededRemoteWorker } from '../scripts/fixtures.ts';
import { toMinutes } from '../src/domain/time.ts';
import type { CoachProposal } from '../src/domain/types.ts';

const TODAY = '2026-09-30';
const NOW = `${TODAY}T21:00`;

type Span = { start: string; end: string; categoryId: string };
const len = (b: { start: string; end: string }) => toMinutes(b.end) - toMinutes(b.start);
const total = (blocks: Span[], id: string) => blocks.filter((b) => b.categoryId === id).reduce((m, b) => m + len(b), 0);
const middayMeals = (blocks: Span[]) =>
  blocks.filter((b) => b.categoryId === 'meals' && b.start.slice(11) >= '10:30' && b.start.slice(11) < '15:00');

test('coach notices heavy phone use and a lunch that drags on, and says so in one sentence', async () => {
  const app = await seededRemoteWorker(TODAY);
  const c = (await app.coach(TODAY, NOW))!;
  assert.ok(c, 'expected a proposal');

  const kinds = c.observations.map((o) => `${o.kind}:${o.categoryId}`);
  assert.ok(kinds.includes('timeSink:scrolling'), kinds.join(' '));
  assert.ok(kinds.includes('longSessions:meals'), kinds.join(' '));
  const lunch = c.observations.find((o) => o.kind === 'longSessions')!;
  assert.equal(lunch.message, 'Your midday meals take 1h30m on average, when 45m is enough.');
  const phone = c.observations.find((o) => o.kind === 'timeSink')!;
  assert.match(phone.message, /^You spend 3h\d+m a day on phone \/ scrolling, about \d+h\d*m? a week\.$/);
  assert.equal(c.headline, 'Looks like you spend a lot of time on phone / scrolling, and your midday meals run long. I think this routine would work better:');
});

test('the proposed routine fixes what was noticed; the usual day shows how it is now', async () => {
  const app = await seededRemoteWorker(TODAY);
  const c = (await app.coach(TODAY, NOW))!;
  assert.equal(new Date(`${c.date}T00:00:00Z`).getUTCDay() % 6 !== 0, true, 'compared on a weekday');

  // Usual: a real recent weekday, exactly as logged, with its 90-minute lunch.
  assert.ok(c.usualDate < TODAY && new Date(`${c.usualDate}T00:00:00Z`).getUTCDay() % 6 !== 0);
  assert.deepEqual(middayMeals(c.usual).map((b) => [b.start.slice(11), b.end.slice(11)]), [['12:00', '13:30']]);
  // Proposed: every lunch within 45 min, and no slivers anywhere.
  for (const b of c.proposed.filter((b) => b.categoryId !== 'sleep')) assert.ok(len(b) >= 30, `${b.categoryId} ${b.start}–${b.end}`);
  assert.ok(middayMeals(c.proposed).length > 0 && middayMeals(c.proposed).every((b) => len(b) <= 45));
  assert.ok(total(c.proposed, 'scrolling') < total(c.usual, 'scrolling'));
  assert.ok(total(c.proposed, 'meals') < total(c.usual, 'meals'));
  assert.ok(c.reclaimedMinutes > 0);
  assert.ok(c.suggestions.some((s) => s.key === 'reduce:meals' && s.message.includes('keeping each session within 45m')));

  // The proposal covers the whole day without overlaps.
  const spans = c.proposed.map((b) => [toMinutes(b.start), toMinutes(b.end)] as const).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i]![0] >= spans[i - 1]![1]);
  assert.equal(spans.reduce((s, [a, b]) => s + b - a, 0), 1440);
});

test('accepting saves exactly the proposed routines', async () => {
  const app = await seededRemoteWorker(TODAY);
  const c = (await app.coach(TODAY, NOW))!;
  assert.deepEqual(await app.routines(), [], 'nothing saved before accepting');
  await app.acceptCoachProposal(c);
  assert.deepEqual(await app.routines(), c.routines);
});

test('"Not for me" on an observation stops it coming back, and the plan keeps that activity as usual', async () => {
  const app = await seededRemoteWorker(TODAY);
  const c = (await app.coach(TODAY, NOW))!;
  const lunch = c.observations.find((o) => o.kind === 'longSessions')!;
  const suggestion = c.suggestions.find((s) => s.key === lunch.suggestionKey)!;
  await app.decideSuggestion(suggestion, 'rejected', NOW);

  const again = (await app.coach(TODAY, NOW))!;
  assert.ok(!again.observations.some((o) => o.kind === 'longSessions'));
  assert.ok(!again.suggestions.some((s) => s.key === 'reduce:meals'), 'meals kept as usual');
  assert.ok(middayMeals(again.proposed).some((b) => len(b) > 45), 'lunch no longer capped');
  assert.match(again.headline, /phone/);
});

test('no coach before there is enough history, or when nothing stands out', async () => {
  assert.equal(await (await seededRemoteWorker(TODAY, 3)).coach(TODAY, NOW), null);

  // A balanced day: nothing disliked in excess, meals within limits, no goals missed.
  const app = await seededApp(TODAY);
  for (const id of ['scrolling', 'commute', 'chores']) await app.updateActivity(id, { enjoyment: 'neutral' });
  await app.updateActivity('meals', { maxSessionMinutes: 60 });
  assert.equal(await app.coach(TODAY, NOW), null);
});
