// Проверка условий поиска: data-model.md searches, «Правила». Чистые функции, расстояние передаётся снаружи.
import { KIND_GROUP_IDS, KIND_GROUPS } from '../config.js';
import { roundKm } from '../geo/haversine.js';

/** Граница включительная; неуказанное значение объявления условие не отсекает. */
export function inRange(value, min, max) {
  if (value === null || value === undefined) return true;
  if (min !== null && min !== undefined && value < min) return false;
  if (max !== null && max !== undefined && value > max) return false;
  return true;
}

export function searchSources(search) {
  return String(search.sources ?? '').split(',').filter(Boolean);
}

/** Группы типов поиска (specs/002-search-ux-improvements/data-model.md searches.kinds); нет поля — все. */
export function searchKinds(search) {
  if (search.kinds === null || search.kinds === undefined) return KIND_GROUP_IDS;
  return String(search.kinds).split(',').filter(Boolean);
}

/** Тип не известен (объявление записано до фичи 002) — не отсекается. */
export function kindAllowed(kind, search) {
  if (kind === null || kind === undefined) return true;
  return searchKinds(search).some((group) => KIND_GROUPS[group]?.includes(kind));
}

/** Условия без расстояния: сайт, тип, цена, площади. */
export function passesFilters(listing, search) {
  return (
    searchSources(search).includes(listing.source) &&
    kindAllowed(listing.kind, search) &&
    inRange(listing.price_usd, search.price_min_usd, search.price_max_usd) &&
    inRange(listing.house_m2, search.house_min_m2, search.house_max_m2) &&
    inRange(listing.plot_sotki, search.plot_min_sotki, search.plot_max_sotki)
  );
}

/** Для уведомлений: объявление новое на сайте и появилось у бота после создания (включения) поиска. */
export function isFreshFor(listing, search) {
  return listing.is_new === 1 && listing.first_seen_at >= search.active_since;
}

/**
 * @param {object} listing строка listings
 * @param {object} search строка searches
 * @param {{distanceKm?: number|null, forNotification?: boolean}} opts distanceKm — выбранным способом поиска
 */
export function matchesSearch(listing, search, { distanceKm = null, forNotification = false } = {}) {
  if (forNotification && !isFreshFor(listing, search)) return false;
  if (!passesFilters(listing, search)) return false;
  if (search.max_km !== null && search.max_km !== undefined) {
    if (distanceKm === null || distanceKm === undefined) return false;
    if (roundKm(distanceKm) > search.max_km) return false;
  }
  return true;
}
