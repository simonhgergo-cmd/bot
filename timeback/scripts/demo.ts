/**
 * End-to-end walkthrough of the three core features against seeded data.
 * Run: npm run demo
 */
import { formatDuration, hhmm } from '../src/domain/time.ts';
import { seededApp } from './fixtures.ts';

const today = '2026-09-30';
const app = await seededApp(today);
const names = Object.fromEntries((await app.categories()).map((c) => [c.id, c.name]));

// 1. Main calendar: the user logs part of today like a normal calendar...
await app.addBlock({ start: `${today}T00:00`, end: `${today}T07:00`, categoryId: 'sleep' });
await app.addBlock({ start: `${today}T09:00`, end: `${today}T17:00`, categoryId: 'work', title: 'Office' });
await app.addBlock({ start: `${today}T19:00`, end: `${today}T21:00`, categoryId: 'tv' });

// ...and at the end of the day gets a short form for what's missing.
const review = await app.startReview(today, `${today}T22:00`);
console.log(`\n== End-of-day review for ${today} ==`);
for (const q of review.questions) {
  console.log(`  ${q.prompt}  [likely: ${q.suggestedCategoryIds.slice(0, 3).map((id) => names[id]).join(', ')}]`);
}
await app.submitReview(
  today,
  review.questions.map((q) => ({
    questionId: q.id,
    parts: [{ start: q.gap.start, end: q.gap.end, categoryId: q.suggestedCategoryIds[0]! }],
  })),
  `${today}T22:05`,
);

// 3. Goals.
await app.setGoal({ label: 'Sleep 8 hours', categoryId: 'sleep', comparison: 'atLeast', targetMinutes: 480, period: 'day' });
await app.setGoal({ label: 'Max 1h scrolling', categoryId: 'scrolling', comparison: 'atMost', targetMinutes: 60, period: 'day' });
await app.setGoal({ label: 'Exercise 150 min/week', categoryId: 'exercise', comparison: 'atLeast', targetMinutes: 150, period: 'week' });

console.log('\n== Goals (last 7 days) ==');
for (const { goal, progress, streak } of await app.goalProgress('2026-09-24', today)) {
  const met = progress.filter((p) => p.met).length;
  console.log(`  ${goal.label.padEnd(24)} met ${met}/${progress.length} periods, streak ${streak}`);
}

// 2. The optimal-day calendar for tomorrow (a Thursday).
const tomorrow = '2026-10-01';
await app.addBlock({ start: `${tomorrow}T09:00`, end: `${tomorrow}T17:00`, categoryId: 'work', title: 'Office' });
const plan = await app.optimalDay(tomorrow);
if (!plan) {
  console.log('\nNot enough history yet:', await app.readiness(tomorrow));
} else {
  console.log(`\n== Optimal day for ${tomorrow} ==`);
  for (const b of plan.blocks) {
    console.log(`  ${hhmm(b.start)}–${b.end.endsWith('00:00') && b.end > b.start ? '24:00' : hhmm(b.end)}  ${names[b.categoryId]}${b.origin === 'fixed' ? ' (fixed)' : ''}`);
  }
  console.log('\n== Suggestions ==');
  for (const s of plan.suggestions) console.log(`  [${s.kind}] ${s.message}`);
  console.log(`\n  Time won back for things you love: ${formatDuration(plan.reclaimedMinutes)} a day`);
}
