// Граница пункта: settlement_shapes.polygon (encoded polyline) или окружность radius_km (data-model.md).
import { decodePolyline } from './polyline.js';
import { EARTH_RADIUS_KM } from './haversine.js';

const RAD = Math.PI / 180;

/** Окружность как 16-угольник вокруг центра — так же её пишет scripts/build-settlements.mjs. */
export function circleRing(lat, lon, radiusKm, sides = 16) {
  const dLat = (radiusKm / EARTH_RADIUS_KM) / RAD;
  const dLon = dLat / Math.cos(lat * RAD);
  const ring = [];
  for (let i = 0; i < sides; i++) {
    const a = (2 * Math.PI * i) / sides;
    ring.push([lat + dLat * Math.sin(a), lon + dLon * Math.cos(a)]);
  }
  return ring;
}

function bboxOf(rings) {
  const b = { minLat: Infinity, maxLat: -Infinity, minLon: Infinity, maxLon: -Infinity };
  for (const ring of rings) {
    for (const [lat, lon] of ring) {
      if (lat < b.minLat) b.minLat = lat;
      if (lat > b.maxLat) b.maxLat = lat;
      if (lon < b.minLon) b.minLon = lon;
      if (lon > b.maxLon) b.maxLon = lon;
    }
  }
  return b;
}

/**
 * @param {Array<Array<[number, number]>>} rings внешний контур и дыры, точки [lat, lon]
 * @returns {{rings: Array<Array<[number, number]>>, bbox: object}}
 */
export function makeShape(rings) {
  return { rings, bbox: bboxOf(rings) };
}

/** Граница из строки settlement_shapes; нет строки — окружность 0,5 км вокруг центра. */
export function shapeFromRow(row, centerLat, centerLon) {
  if (row?.polygon) {
    const ring = decodePolyline(row.polygon);
    if (ring.length >= 3) return makeShape([ring]);
  }
  return makeShape([circleRing(centerLat, centerLon, row?.radius_km ?? 0.5)]);
}

/** Точка внутри (правило чёт-нечет: точка в дыре — снаружи). Сначала отсев по bbox, затем луч. */
export function pointInShape(shape, lat, lon) {
  const b = shape.bbox;
  if (lat < b.minLat || lat > b.maxLat || lon < b.minLon || lon > b.maxLon) return false;
  let inside = false;
  for (const ring of shape.rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [yi, xi] = ring[i];
      const [yj, xj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
