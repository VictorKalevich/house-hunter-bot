// data-model.md rates, research.md R6.
import { NBRB_RATE_URL } from '../config.js';
import { utcDay } from '../time.js';

export function latestRateStatement(db) {
  return db.prepare('SELECT date, usd_byn FROM rates ORDER BY date DESC LIMIT 1');
}

export async function latestRate(db) {
  const row = await latestRateStatement(db).first();
  return row ? row.usd_byn : null;
}

/** Курс НБ РБ на дату: Cur_OfficialRate / Cur_Scale. */
export function parseNbrbRate(json) {
  const rate = Number(json?.Cur_OfficialRate) / Number(json?.Cur_Scale ?? 1);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** Суточный шаг: курс на сегодня; нет курса — остаётся последний известный. */
export async function refreshRate(ctx) {
  const { db, now } = ctx;
  const day = utcDay(now);
  const res = await fetch(`${NBRB_RATE_URL}?parammode=2&ondate=${day}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) return { date: day, error: `НБ РБ: ${res.status}` };
  const rate = parseNbrbRate(await res.json());
  if (rate === null) return { date: day, error: 'НБ РБ: нет курса в ответе' };
  await db
    .prepare('INSERT INTO rates (date, usd_byn, fetched_at) VALUES (?, ?, ?) ON CONFLICT (date) DO UPDATE SET usd_byn = excluded.usd_byn, fetched_at = excluded.fetched_at')
    .bind(day, rate, now)
    .run();
  return { date: day, usd_byn: rate };
}
