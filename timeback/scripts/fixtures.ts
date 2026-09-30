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
