import { DEFAULT_CATEGORIES } from '../src/domain/defaults.ts';
import { addDays } from '../src/domain/time.ts';
import type { DateKey } from '../src/domain/types.ts';
import { MemoryRepository } from '../src/storage/memoryRepository.ts';
import { TimebackApp } from '../src/app/timebackApp.ts';

/** A typical over-scrolling, under-sleeping office worker, fully logged for `days` days before `today`. */
export async function seededApp(today: DateKey, days = 14): Promise<TimebackApp> {
  let n = 0;
  const app = new TimebackApp(new MemoryRepository(), { newId: () => `id${++n}` });
  for (const c of DEFAULT_CATEGORIES) await app.saveCategory(c);

  for (let i = days; i >= 1; i--) {
    const d = addDays(today, -i);
    const next = addDays(d, 1);
    const weekday = new Date(`${d}T00:00:00Z`).getUTCDay();
    const isWorkday = weekday >= 1 && weekday <= 5;
    const add = (start: string, end: string, categoryId: string, endDate = d) =>
      app.addBlock({ start: `${d}T${start}`, end: `${endDate}T${end}`, categoryId });

    await add('00:00', '06:45', 'sleep');
    await add('06:45', '07:30', 'scrolling');
    await add('07:30', '08:00', 'meals');
    if (isWorkday) {
      await add('08:00', '09:00', 'commute');
      await add('09:00', '17:00', 'work');
      await add('17:00', '18:00', 'commute');
    } else {
      await add('08:00', '11:00', 'chores');
      await add('11:00', '18:00', 'social');
    }
    await add('18:00', '19:00', 'meals');
    await add('19:00', '21:00', 'tv');
    await add('21:00', '23:30', 'scrolling');
    await add('23:30', '00:00', 'sleep', next);
  }
  return app;
}

/**
 * Works from home, lunch drags on (90 min), and lots of phone time (~3h45m a
 * day). The case the coach is for: "looks like you're on your phone a lot,
 * and lunch runs long".
 */
export async function seededRemoteWorker(today: DateKey, days = 14): Promise<TimebackApp> {
  let n = 0;
  const app = new TimebackApp(new MemoryRepository(), { newId: () => `rw${++n}` });
  for (const c of DEFAULT_CATEGORIES) await app.saveCategory(c);

  for (let i = days; i >= 1; i--) {
    const d = addDays(today, -i);
    const next = addDays(d, 1);
    const weekday = new Date(`${d}T00:00:00Z`).getUTCDay();
    const add = (start: string, end: string, categoryId: string, endDate = d) =>
      app.addBlock({ start: `${d}T${start}`, end: `${endDate}T${end}`, categoryId });

    if (weekday >= 1 && weekday <= 5) {
      await add('00:00', '07:00', 'sleep');
      await add('07:00', '07:45', 'scrolling');
      await add('07:45', '08:15', 'meals');
      await add('08:30', '12:00', 'work');
      await add('12:00', '13:30', 'meals'); // lunch drags on
      await add('13:30', '17:30', 'work');
      await add('17:30', '18:15', 'chores');
      await add('18:15', '19:00', 'meals');
      await add('19:00', '20:30', 'tv');
      await add('20:30', '23:30', 'scrolling');
    } else {
      await add('00:00', '08:30', 'sleep');
      await add('08:30', '09:30', 'scrolling');
      await add('09:30', '10:00', 'meals');
      await add('10:00', '12:00', 'chores');
      await add('12:00', '13:30', 'meals');
      await add('13:30', '18:00', 'social');
      await add('18:00', '19:00', 'meals');
      await add('19:00', '21:00', 'tv');
      await add('21:00', '23:30', 'scrolling');
    }
    await add('23:30', '00:00', 'sleep', next);
  }
  return app;
}
