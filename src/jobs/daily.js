// Суточные задачи (cron 30 0 * * *): ошибка одного шага не мешает остальным.
import { LISTING_TTL_MS, NOTIFICATION_TTL_MS } from '../config.js';
import { refreshRate } from '../db/rates.js';
import { trackDb } from '../db/tracked.js';
import { Budget } from './budget.js';
import { robotsDailyStep } from './poll-feeds.js';

/** Курс НБ РБ на сегодня (research.md R6); не удалось — цены считаются по последнему известному. */
async function rateStep(ctx) {
  ctx.budget.use(1);
  return refreshRate(ctx);
}

/** Объявления, не виденные 30 дней, и уведомления старше года (data-model.md listings, notifications). */
async function cleanupStep(ctx) {
  const { db, now } = ctx;
  const [listings, notifications] = await db.batch([
    db.prepare('DELETE FROM listings WHERE last_seen_at < ?').bind(now - LISTING_TTL_MS),
    db.prepare('DELETE FROM notifications WHERE created_at < ?').bind(now - NOTIFICATION_TTL_MS),
  ]);
  return { listings: listings.meta.changes, notifications: notifications.meta.changes };
}

/** Смена отметки «новое по номеру»: new_id_floor ← id_snapshot ← max_id_seen (data-model.md sources). */
async function idFloorStep(ctx) {
  const r = await ctx.db
    .prepare('UPDATE sources SET new_id_floor = id_snapshot, id_snapshot = max_id_seen WHERE max_id_seen IS NOT NULL')
    .run();
  return { sources: r.meta.changes };
}

export const DAILY_STEPS = [
  ['rate', rateStep],
  ['cleanup', cleanupStep],
  ['id_floor', idFloorStep],
  ['robots', robotsDailyStep],
];

export async function runDaily(env, { steps = DAILY_STEPS, now = Date.now() } = {}) {
  const budget = new Budget();
  const db = trackDb(env.DB, budget);
  const ctx = { env, db, now, budget };
  const report = {};
  for (const [name, step] of steps) {
    try {
      report[name] = (await step(ctx)) ?? null;
    } catch (err) {
      report[name] = { error: String(err?.message ?? err).slice(0, 200) };
    }
  }
  const line = { event: 'daily', rows_read: db.stats.rows_read, rows_written: db.stats.rows_written, steps: report };
  console.log(JSON.stringify(line));
  return line;
}
