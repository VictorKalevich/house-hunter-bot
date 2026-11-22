// data-model.md service_quota: суточные квоты ORS и FOSSGIS OSRM.
import { ROUTING } from '../config.js';
import { utcDay } from '../time.js';

export async function loadQuotas(db, now) {
  const { results } = await db.prepare('SELECT * FROM service_quota').all();
  const day = utcDay(now);
  const quotas = {};
  for (const service of Object.keys(ROUTING.limits)) {
    const row = results.find((r) => r.service === service);
    quotas[service] = {
      service,
      used: row && row.day === day ? row.used : 0,
      pausedUntil: row?.paused_until ?? null,
      spent: 0,
    };
  }
  return quotas;
}

export function quotaAvailable(q, now) {
  return q.used + q.spent < ROUTING.limits[q.service] && (q.pausedUntil === null || q.pausedUntil <= now);
}

export function saveQuotaStatements(db, quotas, now) {
  const day = utcDay(now);
  return Object.values(quotas)
    .filter((q) => q.spent > 0 || q.changed)
    .map((q) => db
      .prepare(
        `INSERT INTO service_quota (service, day, used, paused_until) VALUES (?, ?, ?, ?)
         ON CONFLICT (service) DO UPDATE SET day = excluded.day, used = excluded.used, paused_until = excluded.paused_until`,
      )
      .bind(q.service, day, q.used + q.spent, q.pausedUntil));
}

/** Начало следующих суток UTC — когда сбрасывается суточная квота ORS. */
export function nextUtcMidnight(now) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}
