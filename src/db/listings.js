// data-model.md listings; список объявлений поиска — contracts/miniapp-api.md «Список объявлений».
import { KIND_GROUP_IDS, KIND_GROUPS, LIST_MAX_ROWS, LIST_PAGE_SIZE, LISTING_TTL_MS } from '../config.js';
import { boundsAround, haversineKm } from '../geo/haversine.js';
import { passesFilters, searchKinds } from '../match/criteria.js';
import { roadDistance } from '../match/distance.js';

const LISTING_COLUMNS = [
  'source', 'external_id', 'url', 'kind', 'price_usd', 'price_byn', 'house_m2', 'plot_sotki', 'lat', 'lon',
  'geo_approx', 'geo_key', 'settlement_id', 'place_text', 'photo_url', 'published_at', 'site_created_at', 'is_new',
  'sort_at', 'first_seen_at', 'last_seen_at', 'match_state', 'needs_detail',
];

export function existingStatement(db, source, externalIds) {
  return db
    .prepare(
      `SELECT id, source, external_id, kind, price_usd, price_byn, house_m2, plot_sotki, lat, last_seen_at
       FROM listings WHERE source = ? AND external_id IN (${externalIds.map(() => '?').join(',')})`,
    )
    .bind(source, ...externalIds);
}

export function insertListingStatement(db, row) {
  return db
    .prepare(
      `INSERT INTO listings (${LISTING_COLUMNS.join(', ')}) VALUES (${LISTING_COLUMNS.map(() => '?').join(', ')})
       ON CONFLICT (source, external_id) DO NOTHING`,
    )
    .bind(...LISTING_COLUMNS.map((c) => row[c] ?? null));
}

export function updateListingStatement(db, id, fields) {
  const keys = Object.keys(fields);
  return db
    .prepare(`UPDATE listings SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .bind(...keys.map((k) => fields[k]), id);
}

/** Самое раннее новое объявление, которому нужна карточка (координаты). */
export function pendingDetail(db, source) {
  return db
    .prepare('SELECT id, external_id FROM listings WHERE needs_detail = 1 AND source = ? ORDER BY first_seen_at LIMIT 1')
    .bind(source)
    .first();
}

export function detailResultStatement(db, id, coords) {
  if (!coords) return db.prepare('UPDATE listings SET needs_detail = 0 WHERE id = ?').bind(id);
  const geoKey = `${coords.lat.toFixed(4)},${coords.lon.toFixed(4)}`;
  return db
    .prepare('UPDATE listings SET lat = ?, lon = ?, geo_key = ?, geo_approx = 0, needs_detail = 0 WHERE id = ?')
    .bind(coords.lat, coords.lon, geoKey, id);
}

/**
 * Подходящие сейчас объявления поиска (без условия «после создания поиска»), от новых к старым.
 * Отбор: последние 30 дней, сайты и диапазоны — в SQL; при расстоянии — прямоугольник по индексу широты,
 * точное расстояние — здесь. Читается не больше LIST_MAX_ROWS строк.
 * @param {object} search строка searches
 * @param {{settlement: object|null, radiusKm: number, page: number, now: number}} ctx
 * @returns {Promise<{rows: Array<{row: object, distance: object|null}>, total: number, totalApprox: boolean,
 *   distancesPending: boolean, missing: Array<{geo_key: string, straight_km: number}>}>} totalApprox — прочитан
 *   предел строк, total — нижняя граница; distancesPending — у части подходящих дорожное расстояние ещё считается
 */
export async function searchListings(db, search, { settlement, radiusKm = 0, page = 1, now }) {
  const sources = String(search.sources).split(',').filter(Boolean);
  const where = ['l.last_seen_at >= ?', `l.source IN (${sources.map(() => '?').join(',')})`];
  const params = [now - LISTING_TTL_MS, ...sources];
  const groups = searchKinds(search);
  if (groups.length < KIND_GROUP_IDS.length) {
    const kinds = groups.flatMap((g) => KIND_GROUPS[g] ?? []);
    where.push(`(l.kind IS NULL OR l.kind IN (${kinds.map(() => '?').join(',')}))`);
    params.push(...kinds);
  }
  for (const [column, min, max] of [
    ['price_usd', search.price_min_usd, search.price_max_usd],
    ['house_m2', search.house_min_m2, search.house_max_m2],
    ['plot_sotki', search.plot_min_sotki, search.plot_max_sotki],
  ]) {
    if (min !== null) {
      where.push(`(l.${column} IS NULL OR l.${column} >= ?)`);
      params.push(min);
    }
    if (max !== null) {
      where.push(`(l.${column} IS NULL OR l.${column} <= ?)`);
      params.push(max);
    }
  }

  const withDistance = search.max_km !== null && settlement;
  const road = withDistance && search.distance_mode !== 'straight';
  let from = 'listings l';
  let select = 'l.*';
  const joinParams = [];
  if (withDistance) {
    const slack = search.distance_mode === 'road_exit' ? radiusKm : 0;
    const b = boundsAround(settlement.lat, settlement.lon, search.max_km + slack);
    from = 'listings l INDEXED BY listings_lat';
    where.push('l.lat BETWEEN ? AND ? AND l.lon BETWEEN ? AND ?');
    params.push(b.minLat, b.maxLat, b.minLon, b.maxLon);
    if (road) {
      from += ' LEFT JOIN distances d ON d.settlement_id = ? AND d.geo_key = l.geo_key';
      joinParams.push(settlement.id);
      select += ', d.road_center_km AS d_center, d.road_exit_km AS d_exit, d.status AS d_status';
    }
  }
  const { results } = await db
    .prepare(`SELECT ${select} FROM ${from} WHERE ${where.join(' AND ')} ORDER BY l.sort_at DESC LIMIT ${LIST_MAX_ROWS}`)
    .bind(...joinParams, ...params)
    .all();

  const matched = [];
  const missing = new Map();
  for (const row of results) {
    if (!passesFilters(row, search)) continue;
    if (!withDistance) {
      matched.push({ row, distance: null });
      continue;
    }
    const straight = haversineKm(settlement.lat, settlement.lon, row.lat, row.lon);
    if (!road) {
      if (straight > search.max_km + 0.05) continue;
      matched.push({ row, distance: { km: straight, mode: 'straight', approx: row.geo_approx === 1, fallback: false, pending: false } });
      continue;
    }
    const pair = row.d_status
      ? { status: row.d_status, road_center_km: row.d_center, road_exit_km: row.d_exit, straight_km: straight }
      : null;
    const d = roadDistance(search.distance_mode, pair, straight, radiusKm);
    if (d.km !== null && d.lowerBound > search.max_km + 0.05) continue;
    if (d.needsRoute && !missing.has(row.geo_key)) missing.set(row.geo_key, { geo_key: row.geo_key, straight_km: straight });
    matched.push({ row, distance: { km: d.km, mode: search.distance_mode, approx: row.geo_approx === 1, fallback: d.fallback, pending: d.pending } });
  }
  const offset = (page - 1) * LIST_PAGE_SIZE;
  return {
    rows: matched.slice(offset, offset + LIST_PAGE_SIZE),
    total: matched.length,
    totalApprox: results.length >= LIST_MAX_ROWS,
    distancesPending: matched.some((m) => m.distance?.pending),
    missing: [...missing.values()],
  };
}
