// Шаг тика «запись»: нормализация и upsert объявлений одним batch (data-model.md listings, принцип II).
import { LAST_SEEN_UPDATE_MS } from '../config.js';
import { latestRateStatement } from '../db/rates.js';
import { existingStatement, insertListingStatement, updateListingStatement } from '../db/listings.js';
import { insertForLikesStatement } from '../db/price-alerts.js';
import { updateSourceStatement } from '../db/sources.js';
import { matchPlacesQuery } from '../geo/gazetteer.js';
import { priceChange } from '../match/price-change.js';
import { computeIsNew, normalizeListing, validCoords } from '../sources/normalize.js';

const IN_CHUNK = 90;

const chunks = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

export async function ingestStep(ctx) {
  const { db, now, pages } = ctx;
  if (pages.length === 0) return null;

  // Все чтения — одним batch: курс, уже известные объявления, пункты для мест без координат.
  const reads = [latestRateStatement(db)];
  const lookups = [];
  for (const page of pages) {
    const ids = [...new Set(page.items.map((i) => i.externalId).filter((id) => typeof id === 'string'))];
    for (const part of chunks(ids, IN_CHUNK)) {
      lookups.push(reads.length);
      reads.push(existingStatement(db, page.adapter.id, part));
    }
  }
  const noCoords = pages.flatMap((p) => p.items.filter((i) => !validCoords(i.coords)).map((i) => i.place ?? {}));
  const places = matchPlacesQuery(db, noCoords);
  if (places) reads.push(places.statement);
  const results = await db.batch(reads);

  const rate = results[0].results[0]?.usd_byn ?? null;
  const existing = new Map();
  for (const index of lookups) for (const row of results[index].results) existing.set(`${row.source}:${row.external_id}`, row);
  const matched = places ? places.resolve(results.at(-1).results) : [];

  const writes = [];
  const seen = new Set();
  const stats = { inserted: 0, fresh: 0, updated: 0, dropped: 0 };
  let placeIndex = 0;
  for (const { adapter, src, items, firstCycle } of pages) {
    let maxId = null;
    for (const raw of items) {
      const settlement = validCoords(raw.coords) ? null : matched[placeIndex++] ?? null;
      const row = normalizeListing(raw, adapter, { now, rate, settlement });
      if (!row) {
        stats.dropped += 1;
        continue;
      }
      if (adapter.idKind === 'numeric') {
        const n = Number(row.external_id);
        if (Number.isSafeInteger(n) && (maxId === null || n > maxId)) maxId = n;
      }
      const key = `${row.source}:${row.external_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const old = existing.get(key);
      if (!old) {
        const isNew = computeIsNew(adapter, raw, { now, idFloor: src.new_id_floor ?? src.id_snapshot, firstCycle });
        writes.push(insertListingStatement(db, {
          ...row,
          is_new: isNew,
          first_seen_at: now,
          last_seen_at: now,
          match_state: isNew ? 'pending' : 'done',
          needs_detail: isNew ? row.needs_detail : 0,
        }));
        stats.inserted += 1;
        stats.fresh += isNew;
        continue;
      }
      const fields = changedFields(old, row, raw);
      if (Object.keys(fields).length || old.last_seen_at < now - LAST_SEEN_UPDATE_MS) {
        writes.push(updateListingStatement(db, old.id, { ...fields, last_seen_at: now }));
        stats.updated += 1;
      }
      // Сообщения о цене — в том же batch, что новая цена (specs/003-listing-likes/research.md R10).
      const change = priceChange(old, { ...old, ...fields });
      if (change) {
        writes.push(insertForLikesStatement(db, old.id, change, now));
        stats.priceChanges = (stats.priceChanges ?? 0) + 1;
      }
    }
    if (maxId !== null) {
      writes.push(db
        .prepare(
          `UPDATE sources SET max_id_seen = MAX(COALESCE(max_id_seen, 0), ?1),
             id_snapshot = CASE WHEN ?2 = 1 THEN MAX(COALESCE(id_snapshot, 0), ?1) ELSE id_snapshot END
           WHERE id = ?3`,
        )
        .bind(maxId, firstCycle ? 1 : 0, adapter.id));
    }
  }
  if (writes.length) await db.batch(writes);
  return stats;
}

/**
 * Что поменялось у уже известного объявления: тип, цена, площади; место — если раньше его не было. Объявление снова
 * на сайте — пометка «снято» снимается (specs/003-listing-likes/data-model.md listings.gone_at).
 */
export function changedFields(old, row, raw) {
  const fields = {};
  if (row.kind !== null && row.kind !== old.kind) fields.kind = row.kind;
  const siteUsd = Boolean(raw.priceUsd) || raw.price?.currency === 'USD';
  if (siteUsd && row.price_usd !== old.price_usd) fields.price_usd = row.price_usd;
  if (!siteUsd && row.price_byn !== old.price_byn) {
    fields.price_byn = row.price_byn;
    fields.price_usd = row.price_usd;
  } else if (row.price_byn !== old.price_byn) fields.price_byn = row.price_byn;
  if (row.price_amount !== old.price_amount || row.price_currency !== old.price_currency) {
    fields.price_amount = row.price_amount;
    fields.price_currency = row.price_currency;
  }
  if (row.house_m2 !== old.house_m2) fields.house_m2 = row.house_m2;
  if (row.plot_sotki !== old.plot_sotki) fields.plot_sotki = row.plot_sotki;
  if (old.lat === null && row.lat !== null) {
    Object.assign(fields, { lat: row.lat, lon: row.lon, geo_key: row.geo_key, geo_approx: row.geo_approx, settlement_id: row.settlement_id });
  }
  if (old.gone_at != null) fields.gone_at = null;
  return fields;
}
