// Тик раз в минуту: plan.md «Как работает тик».
import { TICK } from '../config.js';
import { acquireLock, releaseLock } from '../db/locks.js';
import { trackDb } from '../db/tracked.js';
import { Budget } from './budget.js';
import { deliverStep } from './deliver.js';
import { pollFeedsStep } from './poll-feeds.js';
import { ingestStep } from './ingest.js';
import { matchStep } from './match.js';
import { routeStep } from './route.js';

export const STEPS = [
  ['deliver', deliverStep],
  ['poll', pollFeedsStep],
  ['ingest', ingestStep],
  ['match', matchStep],
  ['route', routeStep],
];

/**
 * @typedef {object} TickContext
 * @property {any} env
 * @property {ReturnType<typeof trackDb>} db
 * @property {number} now
 * @property {Budget} budget
 * @property {Array<object>} pages   результаты poll для ingest
 */

export async function runTick(env, { steps = STEPS, now = Date.now() } = {}) {
  const budget = new Budget();
  const db = trackDb(env.DB, budget);
  const holder = crypto.randomUUID();
  if (!(await acquireLock(db, 'tick', holder, now, TICK.lockTtlMs))) {
    console.log(JSON.stringify({ event: 'tick', skipped: 'locked' }));
    return null;
  }

  /** @type {TickContext} */
  const ctx = { env, db, now, budget, pages: [] };
  const report = {};
  try {
    for (const [name, step] of steps) {
      try {
        report[name] = (await step(ctx)) ?? null;
      } catch (err) {
        report[name] = { error: String(err?.message ?? err).slice(0, 200) };
      }
    }
  } finally {
    await releaseLock(db, 'tick', holder);
  }
  const line = {
    event: 'tick',
    rows_read: db.stats.rows_read,
    rows_written: db.stats.rows_written,
    subrequests: budget.subrequests,
    cpu_units: budget.cpuUsed,
    steps: report,
  };
  console.log(JSON.stringify(line));
  return line;
}
