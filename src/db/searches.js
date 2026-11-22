// data-model.md searches.

const SEARCH_COLUMNS = `s.*, st.name AS settlement_name, st.kind AS settlement_kind, st.district AS settlement_district,
  st.region AS settlement_region, st.lat AS settlement_lat, st.lon AS settlement_lon, sh.radius_km AS settlement_radius_km`;
const SEARCH_FROM = `searches s LEFT JOIN settlements st ON st.id = s.settlement_id
  LEFT JOIN settlement_shapes sh ON sh.settlement_id = s.settlement_id`;

/** Активные поиски пользователей с доступом (не заблокировавших бота) — для отбора уведомлений. */
export async function activeSearchesForMatch(db) {
  const { results } = await db
    .prepare(
      `SELECT ${SEARCH_COLUMNS} FROM ${SEARCH_FROM} JOIN users u ON u.telegram_id = s.user_id
       WHERE s.status = 'active' AND u.access = 'active' AND u.blocked_at IS NULL
       ORDER BY s.id`,
    )
    .all();
  return results;
}

export function getOwnSearch(db, userId, id) {
  return db.prepare(`SELECT ${SEARCH_COLUMNS} FROM ${SEARCH_FROM} WHERE s.id = ? AND s.user_id = ?`).bind(id, userId).first();
}

export async function listOwnSearches(db, userId) {
  const { results } = await db
    .prepare(`SELECT ${SEARCH_COLUMNS} FROM ${SEARCH_FROM} WHERE s.user_id = ? ORDER BY s.created_at DESC, s.id DESC`)
    .bind(userId)
    .all();
  return results;
}

const criteriaColumns = (c) => [
  c.settlementId, c.distanceMode, c.maxKm, c.priceUsd.min, c.priceUsd.max, c.houseM2.min, c.houseM2.max,
  c.plotSotki.min, c.plotSotki.max, c.kinds.join(','), c.sources.join(','),
];

export async function createSearch(db, userId, criteria, title, now) {
  const r = await db
    .prepare(
      `INSERT INTO searches (user_id, title, settlement_id, distance_mode, max_km, price_min_usd, price_max_usd,
         house_min_m2, house_max_m2, plot_min_sotki, plot_max_sotki, kinds, sources, status, active_since, created_at,
         updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    )
    .bind(userId, title, ...criteriaColumns(criteria), now, now, now)
    .run();
  return r.meta.last_row_id;
}

/** Смена условий: active_since не меняется (FR-017). */
export async function updateSearch(db, userId, id, criteria, title, now) {
  const r = await db
    .prepare(
      `UPDATE searches SET title = ?, settlement_id = ?, distance_mode = ?, max_km = ?, price_min_usd = ?, price_max_usd = ?,
         house_min_m2 = ?, house_max_m2 = ?, plot_min_sotki = ?, plot_max_sotki = ?, kinds = ?, sources = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .bind(title, ...criteriaColumns(criteria), now, id, userId)
    .run();
  return r.meta.changes === 1;
}

export async function pauseSearch(db, userId, id, now) {
  const r = await db
    .prepare("UPDATE searches SET status = 'paused', updated_at = ? WHERE id = ? AND user_id = ?")
    .bind(now, id, userId)
    .run();
  return r.meta.changes === 1;
}

/** Включение: уведомления — только об объявлениях после включения (active_since = сейчас). */
export async function resumeSearch(db, userId, id, now) {
  const r = await db
    .prepare(
      `UPDATE searches SET status = 'active', active_since = CASE WHEN status = 'paused' THEN ?1 ELSE active_since END,
         updated_at = ?1 WHERE id = ?2 AND user_id = ?3`,
    )
    .bind(now, id, userId)
    .run();
  return r.meta.changes === 1;
}

export async function deleteSearch(db, userId, id) {
  const r = await db.prepare('DELETE FROM searches WHERE id = ? AND user_id = ?').bind(id, userId).run();
  return r.meta.changes === 1;
}

export function settlementOf(row) {
  if (row.settlement_id === null) return null;
  return {
    id: row.settlement_id, name: row.settlement_name, kind: row.settlement_kind, district: row.settlement_district,
    region: row.settlement_region, lat: row.settlement_lat, lon: row.settlement_lon,
  };
}

/** Строка поиска → Search (contracts/miniapp-api.md «Объекты»). */
export function searchToApi(row) {
  const s = settlementOf(row);
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    criteria: {
      settlementId: row.settlement_id,
      distanceMode: row.distance_mode,
      maxKm: row.max_km,
      priceUsd: { min: row.price_min_usd, max: row.price_max_usd },
      houseM2: { min: row.house_min_m2, max: row.house_max_m2 },
      plotSotki: { min: row.plot_min_sotki, max: row.plot_max_sotki },
      kinds: String(row.kinds).split(',').filter(Boolean),
      sources: String(row.sources).split(',').filter(Boolean),
    },
    settlement: s ? { id: s.id, name: s.name, kind: s.kind, district: s.district, region: s.region } : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
