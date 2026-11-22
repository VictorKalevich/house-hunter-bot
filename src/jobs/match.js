// Шаг тика «отбор»: новые объявления × активные поиски → notifications (data-model.md, research.md R9).
import { MATCH_WAIT_MS, TICK } from '../config.js';
import { enqueueStatement, lookupPairs } from '../db/distances.js';
import { activeSearchesForMatch } from '../db/searches.js';
import { haversineKm } from '../geo/haversine.js';
import { isFreshFor, matchesSearch, passesFilters } from '../match/criteria.js';
import { roadDistance } from '../match/distance.js';
import { distanceLabel } from '../match/format.js';

export async function matchStep(ctx) {
  const { db, now, budget } = ctx;
  if (!budget.hasSubrequests(5)) return null;
  const { results: listings } = await db
    .prepare(`SELECT * FROM listings INDEXED BY listings_pending WHERE match_state = 'pending' ORDER BY first_seen_at LIMIT ?`)
    .bind(TICK.matchPerTick)
    .all();
  if (listings.length === 0) return null;
  const searches = await activeSearchesForMatch(db);

  // Пары для дорожных способов: смотрим кеш одним-двумя запросами.
  const pairs = new Map();
  for (const l of listings) {
    if (l.lat === null) continue;
    for (const s of searches) {
      if (s.distance_mode !== 'straight' && s.max_km !== null && s.settlement_id !== null && isFreshFor(l, s) && passesFilters(l, s)) {
        pairs.set(`${s.settlement_id}|${l.geo_key}`, { settlementId: s.settlement_id, geoKey: l.geo_key });
      }
    }
  }
  const cache = pairs.size ? await lookupPairs(db, [...pairs.values()]) : new Map();

  const writes = [];
  const enqueue = new Map();
  const stats = { listings: listings.length, notified: 0, waiting: 0 };
  for (const l of listings) {
    const waitedTooLong = l.match_waiting_since !== null && now - l.match_waiting_since >= MATCH_WAIT_MS;
    const sinceSeen = now - l.first_seen_at;
    // moyareklama: ждём карточку с координатами, но не дольше 20 минут.
    if (l.needs_detail === 1 && sinceSeen < MATCH_WAIT_MS) {
      stats.waiting += 1;
      if (l.match_waiting_since === null) {
        writes.push(db.prepare('UPDATE listings SET match_waiting_since = ? WHERE id = ?').bind(now, l.id));
      }
      continue;
    }

    let wait = false;
    const byUser = new Map();
    for (const s of searches) {
      if (!isFreshFor(l, s) || !passesFilters(l, s)) continue;
      let distanceKm = null;
      let label = null;
      if (s.max_km !== null) {
        if (l.lat === null || s.settlement_id === null) continue;
        const straight = haversineKm(s.settlement_lat, s.settlement_lon, l.lat, l.lon);
        const base = { approx: l.geo_approx === 1, settlementName: s.settlement_name };
        if (s.distance_mode === 'straight') {
          distanceKm = straight;
          label = distanceLabel({ km: straight, mode: 'straight', ...base });
        } else {
          const key = `${s.settlement_id}|${l.geo_key}`;
          const d = roadDistance(s.distance_mode, cache.get(key) ?? null, straight, s.settlement_radius_km ?? 0);
          if (d.lowerBound > s.max_km + 0.05) continue;
          if (d.known) {
            distanceKm = d.km;
            label = distanceLabel({ km: d.km, mode: s.distance_mode, fallback: d.fallback, ...base });
          } else if (waitedTooLong) {
            distanceKm = straight;
            label = distanceLabel({ km: straight, mode: s.distance_mode, fallback: true, ...base });
          } else {
            wait = true;
            const prev = enqueue.get(key);
            enqueue.set(key, {
              settlementId: s.settlement_id, geoKey: l.geo_key, straightKm: straight, priority: 1,
              needExit: Boolean(prev?.needExit) || s.distance_mode === 'road_exit', now,
            });
            continue;
          }
        }
      }
      if (!matchesSearch(l, s, { distanceKm, forNotification: true })) continue;
      if (!byUser.has(s.user_id)) byUser.set(s.user_id, { searchIds: [], label: null });
      const entry = byUser.get(s.user_id);
      entry.searchIds.push(s.id);
      if (entry.label === null && label !== null) entry.label = label;
    }

    if (wait) {
      stats.waiting += 1;
      if (l.match_waiting_since === null) {
        writes.push(db.prepare('UPDATE listings SET match_waiting_since = ? WHERE id = ?').bind(now, l.id));
      }
      continue;
    }
    for (const [userId, entry] of byUser) {
      writes.push(db
        .prepare(
          `INSERT OR IGNORE INTO notifications (user_id, source, external_id, listing_id, search_ids, distance_label, status,
             attempts, next_attempt_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
        )
        .bind(userId, l.source, l.external_id, l.id, JSON.stringify(entry.searchIds), entry.label, now, now));
      stats.notified += 1;
    }
    writes.push(db.prepare("UPDATE listings SET match_state = 'done', match_waiting_since = NULL WHERE id = ?").bind(l.id));
  }
  for (const pair of enqueue.values()) writes.push(enqueueStatement(db, pair));
  if (writes.length) await db.batch(writes);
  return stats;
}
