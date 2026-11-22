// Дорожное расстояние пары «пункт поиска → место объявления» из кеша distances (data-model.md, research.md R3).

/**
 * @param {'road_center'|'road_exit'} mode
 * @param {{status: string, road_center_km: number|null, road_exit_km: number|null}|null} pair строка distances
 * @param {number} straight расстояние по прямой от центра, км
 * @param {number} radiusKm settlement_shapes.radius_km
 * @returns {{km: number, lowerBound: number, known: boolean, pending: boolean, fallback: boolean, needsRoute: boolean}}
 *   km — что показывать (пока не посчитано — по прямой); lowerBound — дорога не короче этого (для отбора);
 *   needsRoute — пару надо поставить в очередь (её нет или не хватает «от выезда»)
 */
export function roadDistance(mode, pair, straight, radiusKm = 0) {
  if (pair?.status === 'failed') {
    return { km: straight, lowerBound: straight, known: true, pending: false, fallback: true, needsRoute: false };
  }
  const value = mode === 'road_exit' ? pair?.road_exit_km : pair?.road_center_km;
  if (pair?.status === 'ok' && value !== null && value !== undefined) {
    return { km: value, lowerBound: value, known: true, pending: false, fallback: false, needsRoute: false };
  }
  const lowerBound = mode === 'road_exit' ? Math.max(0, straight - radiusKm) : straight;
  return { km: straight, lowerBound, known: false, pending: true, fallback: false, needsRoute: !pair || pair.status === 'ok' };
}
