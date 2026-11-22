// Шаг тика «маршруты»: до 10 пар из очереди distances (research.md R3, data-model.md distances).
import { ROUTING, TICK } from '../config.js';
import { attemptFailedStatement, pendingPairs, resultStatement } from '../db/distances.js';
import { loadQuotas, nextUtcMidnight, quotaAvailable, saveQuotaStatements } from '../db/quota.js';
import { exitDistanceKm } from '../geo/exit-distance.js';
import { shapeFromRow } from '../geo/polygon.js';
import { orsDirections, orsMatrix, osrmRoute } from '../geo/router.js';

const OSRM_GAP_MS = 1100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round3 = (n) => Math.round(n * 1000) / 1000;

function parseKey(geoKey) {
  const [lat, lon] = geoKey.split(',').map(Number);
  return { lat, lon };
}

export async function routeStep(ctx) {
  const { db, env, now, budget } = ctx;
  if (!budget.hasSubrequests(4)) return null;
  const limit = Math.min(TICK.routesPerTick, budget.subrequestLimit - budget.subrequests - 3);
  const pairs = await pendingPairs(db, Math.max(0, limit));
  if (pairs.length === 0) return null;
  const quotas = await loadQuotas(db, now);

  const writes = [];
  const stats = { directions: 0, matrix: 0, osrm: 0, ok: 0, failed: 0 };
  let lastOsrm = 0;

  const pause = (service, result) => {
    const q = quotas[service];
    q.pausedUntil = result.kind === 'quota' ? nextUtcMidnight(now) : result.retryAt;
    q.changed = true;
  };

  const directionsFor = async (pair) => {
    const from = { lat: pair.s_lat, lon: pair.s_lon };
    const to = parseKey(pair.geo_key);
    let result = null;
    if (quotaAvailable(quotas.ors_directions, now) && budget.hasSubrequests(2)) {
      result = await orsDirections(env, from, to, now);
      budget.use(1);
      quotas.ors_directions.spent += 1;
      stats.directions += 1;
      if (result.kind === 'quota' || result.kind === 'rate') pause('ors_directions', result);
    }
    // Запас: ORS не нашёл дорогу рядом с точкой или недоступен.
    if ((!result || result.kind !== 'ok') && quotaAvailable(quotas.osrm, now) && budget.hasSubrequests(2)) {
      const wait = lastOsrm + OSRM_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      const fallback = await osrmRoute(env, from, to);
      lastOsrm = Date.now();
      budget.use(1);
      quotas.osrm.spent += 1;
      stats.osrm += 1;
      if (fallback.kind === 'rate') pause('osrm', fallback);
      if (fallback.kind === 'ok' || !result) result = fallback;
      else if (fallback.kind === 'unroutable' && result.kind === 'unroutable') result = fallback;
    }
    if (!result) return; // квоты нет — пара ждёт
    if (result.kind === 'ok') {
      const shape = shapeFromRow(pair, pair.s_lat, pair.s_lon);
      writes.push(resultStatement(db, pair.settlement_id, pair.geo_key, {
        road_center_km: round3(result.km),
        road_exit_km: round3(exitDistanceKm(result.km, result.route, shape, to)),
        status: 'ok', attempts: pair.attempts + 1, computed_at: now,
      }));
      stats.ok += 1;
    } else if (result.kind === 'unroutable') {
      writes.push(attemptFailedStatement(db, pair, now, true));
      stats.failed += 1;
    } else if (result.kind === 'error') {
      writes.push(attemptFailedStatement(db, pair, now));
    }
  };

  // Пары только для «от центра» и для списка — пакетом через matrix, по одному пункту за раз.
  const matrixGroups = new Map();
  const directions = [];
  for (const pair of pairs) {
    const needDirections = pair.priority === 1 || pair.need_exit === 1 || pair.road_center_km !== null;
    if (needDirections) directions.push(pair);
    else {
      if (!matrixGroups.has(pair.settlement_id)) matrixGroups.set(pair.settlement_id, []);
      matrixGroups.get(pair.settlement_id).push(pair);
    }
  }

  for (const pair of directions) await directionsFor(pair);

  for (const group of matrixGroups.values()) {
    if (!quotaAvailable(quotas.ors_matrix, now) || !budget.hasSubrequests(2)) {
      for (const pair of group) await directionsFor(pair);
      continue;
    }
    const from = { lat: group[0].s_lat, lon: group[0].s_lon };
    const targets = group.slice(0, ROUTING.matrixMaxDestinations).map((p) => parseKey(p.geo_key));
    const result = await orsMatrix(env, from, targets, now);
    budget.use(1);
    quotas.ors_matrix.spent += 1;
    stats.matrix += 1;
    if (result.kind === 'ok') {
      group.forEach((pair, i) => {
        const km = result.km[i];
        if (km === null) writes.push(attemptFailedStatement(db, pair, now, true));
        else {
          writes.push(resultStatement(db, pair.settlement_id, pair.geo_key, {
            road_center_km: round3(km), status: 'ok', attempts: pair.attempts + 1, computed_at: now,
          }));
          stats.ok += 1;
        }
      });
    } else if (result.kind === 'quota' || result.kind === 'rate') {
      pause('ors_matrix', result);
    } else {
      // Одна неудобная точка (ORS 6010) роняет весь пакет — такие пары считаются поштучно.
      for (const pair of group) await directionsFor(pair);
    }
  }

  writes.push(...saveQuotaStatements(db, quotas, now));
  if (writes.length) await db.batch(writes);
  return stats;
}
