// «По дороге от выезда» (research.md R3, US3): часть маршрута за границей пункта.
import { haversineKm } from './haversine.js';
import { pointInShape } from './polygon.js';

const SPLIT = 10;

/**
 * Доля геодезической длины маршрута, лежащая за границей. Отрезок с концами по разные стороны границы делится
 * на части, каждая относится по своей середине. Повторный заезд в пункт учитывается: суммируются все внешние куски.
 * @param {Array<[number, number]>} route точки [lat, lon]
 */
export function outsideFraction(route, shape) {
  if (route.length < 2) return pointInShape(shape, ...(route[0] ?? [0, 0])) ? 0 : 1;
  let total = 0;
  let outside = 0;
  let prevIn = pointInShape(shape, route[0][0], route[0][1]);
  for (let i = 1; i < route.length; i++) {
    const [lat1, lon1] = route[i - 1];
    const [lat2, lon2] = route[i];
    const len = haversineKm(lat1, lon1, lat2, lon2);
    const curIn = pointInShape(shape, lat2, lon2);
    total += len;
    if (!prevIn && !curIn) outside += len;
    else if (prevIn !== curIn) {
      for (let k = 0; k < SPLIT; k++) {
        const t = (k + 0.5) / SPLIT;
        if (!pointInShape(shape, lat1 + (lat2 - lat1) * t, lon1 + (lon2 - lon1) * t)) outside += len / SPLIT;
      }
    }
    prevIn = curIn;
  }
  return total > 0 ? outside / total : 0;
}

/**
 * road_exit = длина маршрута сервиса × доля за границей; место объявления внутри границы — 0 (US3, сценарий 3).
 * @param {{lat: number, lon: number}} dest место объявления
 */
export function exitDistanceKm(routeKm, route, shape, dest) {
  if (dest && pointInShape(shape, dest.lat, dest.lon)) return 0;
  return routeKm * outsideFraction(route, shape);
}

/** Нижняя оценка «от выезда» для отбора: дорога не короче прямой, граница — не дальше radius_km от центра. */
export function exitLowerBound(straightKm, radiusKm) {
  return Math.max(0, straightKm - radiusKm);
}
