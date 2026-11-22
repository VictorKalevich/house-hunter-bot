// Маршруты: openrouteservice (самый быстрый) и запасной FOSSGIS OSRM (research.md R3).
import { FETCH_TIMEOUT_MS, ROUTING, userAgent } from '../config.js';
import { decodePolyline } from './polyline.js';

/**
 * @typedef {object} RouteResult
 * @property {'ok'|'unroutable'|'quota'|'rate'|'error'} kind
 * @property {number} [km]                    длина маршрута
 * @property {Array<[number, number]>} [route] точки [lat, lon]
 * @property {number} [retryAt]               для quota/rate: когда снова можно
 * @property {string} [error]
 */

async function request(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, headers: res.headers, json };
  } catch (err) {
    return { status: 0, error: controller.signal.aborted ? 'тайм-аут' : String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Разбор ошибки ORS: 403 — суточная квота, 429 — лимит в минуту, 2009/2010 — дорогу не найти. */
export function classifyOrsError(res, now) {
  if (res.status === 403) return { kind: 'quota', error: 'ORS: квота исчерпана' };
  if (res.status === 429) {
    const reset = Number(res.headers?.get('x-ratelimit-reset'));
    const retryAfter = Number(res.headers?.get('retry-after'));
    const retryAt = reset > 1e9 ? reset * 1000 : retryAfter > 0 ? now + retryAfter * 1000 : now + 60_000;
    return { kind: 'rate', retryAt, error: 'ORS: 429' };
  }
  const code = res.json?.error?.code;
  if (code === 2009 || code === 2010) return { kind: 'unroutable', error: `ORS: ${code}` };
  return { kind: 'error', error: res.error ?? `ORS: ${res.status}${code ? ` (${code})` : ''}` };
}

/** Маршрут ORS: длина (км) и геометрия. */
export async function orsDirections(env, from, to, now = Date.now()) {
  const res = await request(`${ROUTING.orsBase}/directions/driving-car/json`, {
    method: 'POST',
    headers: {
      Authorization: env.ORS_API_KEY ?? '',
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': userAgent(env),
    },
    body: JSON.stringify({ coordinates: [[from.lon, from.lat], [to.lon, to.lat]], preference: 'fastest', instructions: false }),
  });
  if (res.status !== 200) return classifyOrsError(res, now);
  const route = res.json?.routes?.[0];
  if (!route || typeof route.summary?.distance !== 'number' || typeof route.geometry !== 'string') {
    return { kind: 'error', error: 'ORS: неожиданный ответ' };
  }
  return { kind: 'ok', km: route.summary.distance / 1000, route: decodePolyline(route.geometry) };
}

/**
 * Пакет «по дороге от центра»: один источник × много целей, только длины.
 * @returns {Promise<{kind: string, km?: Array<number|null>, retryAt?: number, error?: string}>}
 */
export async function orsMatrix(env, from, targets, now = Date.now()) {
  const res = await request(`${ROUTING.orsBase}/matrix/driving-car`, {
    method: 'POST',
    headers: {
      Authorization: env.ORS_API_KEY ?? '',
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': userAgent(env),
    },
    body: JSON.stringify({
      locations: [[from.lon, from.lat], ...targets.map((t) => [t.lon, t.lat])],
      sources: [0],
      destinations: targets.map((_, i) => i + 1),
      metrics: ['distance'],
      units: 'km',
    }),
  });
  if (res.status !== 200) return classifyOrsError(res, now);
  const row = res.json?.distances?.[0];
  if (!Array.isArray(row) || row.length !== targets.length) return { kind: 'error', error: 'ORS matrix: неожиданный ответ' };
  return { kind: 'ok', km: row.map((v) => (typeof v === 'number' ? v : null)) };
}

/** Запасной маршрут FOSSGIS OSRM (не чаще раза в секунду — следит вызывающий). */
export async function osrmRoute(env, from, to) {
  const url = `${ROUTING.osrmBase}/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=polyline`;
  const res = await request(url, { headers: { Accept: 'application/json', 'User-Agent': userAgent(env) } });
  if (res.status === 429) return { kind: 'rate', retryAt: Date.now() + 60_000, error: 'OSRM: 429' };
  if (res.json?.code === 'NoRoute' || res.json?.code === 'NoSegment') return { kind: 'unroutable', error: `OSRM: ${res.json.code}` };
  const route = res.json?.routes?.[0];
  if (res.status !== 200 || !route || typeof route.geometry !== 'string') {
    return { kind: 'error', error: res.error ?? `OSRM: ${res.status}` };
  }
  return { kind: 'ok', km: route.distance / 1000, route: decodePolyline(route.geometry) };
}
