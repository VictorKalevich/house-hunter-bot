// data-model.md distances.
import { ROUTING } from '../config.js';

/** Строки кеша для пар (settlement_id, geo_key) — по первичному ключу. */
export function lookupStatement(db, pairs) {
  return db
    .prepare(
      `SELECT * FROM distances WHERE (settlement_id, geo_key) IN (VALUES ${pairs.map(() => '(?, ?)').join(', ')})`,
    )
    .bind(...pairs.flatMap((p) => [p.settlementId, p.geoKey]));
}

export async function lookupPairs(db, pairs) {
  const map = new Map();
  for (let i = 0; i < pairs.length; i += 45) {
    const { results } = await lookupStatement(db, pairs.slice(i, i + 45)).all();
    for (const row of results) map.set(`${row.settlement_id}|${row.geo_key}`, row);
  }
  return map;
}

/**
 * Поставить пару в очередь. Готовую пару без «от выезда» вернуть в очередь, если «от выезда» нужно;
 * приоритет только повышается; посчитанные и `failed` не трогаются.
 */
export function enqueueStatement(db, { settlementId, geoKey, straightKm, priority, needExit, now }) {
  return db
    .prepare(
      `INSERT INTO distances (settlement_id, geo_key, straight_km, status, priority, requested_at)
       VALUES (?1, ?2, ?3, 'pending', ?4, ?5)
       ON CONFLICT (settlement_id, geo_key) DO UPDATE SET
         priority = CASE WHEN distances.status = 'pending' OR (?6 = 1 AND distances.status = 'ok' AND distances.road_exit_km IS NULL)
                         THEN MAX(distances.priority, excluded.priority) ELSE distances.priority END,
         status = CASE WHEN ?6 = 1 AND distances.status = 'ok' AND distances.road_exit_km IS NULL THEN 'pending' ELSE distances.status END,
         requested_at = CASE WHEN ?6 = 1 AND distances.status = 'ok' AND distances.road_exit_km IS NULL THEN excluded.requested_at
                             ELSE distances.requested_at END`,
    )
    .bind(settlementId, geoKey, Math.round(straightKm * 1000) / 1000, priority, now, needExit ? 1 : 0);
}

/** Очередь для шага route: сначала нужные для уведомлений. */
export async function pendingPairs(db, limit) {
  const { results } = await db
    .prepare(
      `SELECT d.settlement_id, d.geo_key, d.straight_km, d.road_center_km, d.priority, d.attempts,
              st.lat AS s_lat, st.lon AS s_lon, sh.polygon, sh.radius_km, sh.source AS shape_source,
              EXISTS (SELECT 1 FROM searches s WHERE s.settlement_id = d.settlement_id AND s.status = 'active'
                        AND s.distance_mode = 'road_exit') AS need_exit
       FROM distances d INDEXED BY distances_queue
       JOIN settlements st ON st.id = d.settlement_id
       LEFT JOIN settlement_shapes sh ON sh.settlement_id = d.settlement_id
       WHERE d.status = 'pending'
       ORDER BY d.priority DESC, d.requested_at
       LIMIT ?`,
    )
    .bind(limit)
    .all();
  return results;
}

export function resultStatement(db, settlementId, geoKey, fields) {
  const keys = Object.keys(fields);
  return db
    .prepare(`UPDATE distances SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE settlement_id = ? AND geo_key = ?`)
    .bind(...keys.map((k) => fields[k]), settlementId, geoKey);
}

/** Неудачная попытка: после ROUTING.maxAttempts — failed (дальше по прямой с пометкой). */
export function attemptFailedStatement(db, pair, now, permanent = false) {
  const attempts = pair.attempts + 1;
  const failed = permanent || attempts >= ROUTING.maxAttempts;
  return resultStatement(db, pair.settlement_id, pair.geo_key, {
    attempts,
    status: failed ? 'failed' : 'pending',
    computed_at: failed ? now : null,
    requested_at: now,
  });
}
