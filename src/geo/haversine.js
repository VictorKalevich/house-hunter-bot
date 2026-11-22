export const EARTH_RADIUS_KM = 6371.0088;
const RAD = Math.PI / 180;

/** Расстояние по прямой (по поверхности сферы), км. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Прямоугольник по широте и долготе, в который заведомо входит круг радиуса km (для отбора по индексу). */
export function boundsAround(lat, lon, km) {
  const dLat = (km / EARTH_RADIUS_KM) / RAD * 1.001;
  const maxAbsLat = Math.min(89, Math.abs(lat) + dLat);
  const dLon = dLat / Math.cos(maxAbsLat * RAD);
  return { minLat: lat - dLat, maxLat: lat + dLat, minLon: lon - dLon, maxLon: lon + dLon };
}

/** Расстояние, округлённое до 0,1 км: так оно показывается и так сравнивается с лимитом поиска. */
export function roundKm(km) {
  return Math.round(km * 10) / 10;
}
