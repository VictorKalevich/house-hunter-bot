import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ROUTING } from '../../src/config.js';
import { decodePolyline } from '../../src/geo/polyline.js';
import { classifyOrsError, orsDirections, orsMatrix, osrmRoute } from '../../src/geo/router.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/routing/${name}`, import.meta.url), 'utf8');
const env = { ORS_API_KEY: 'test-key', BOT_USERNAME: 'test_bot' };
const now = Date.parse('2026-11-22T12:00:00Z');
const from = { lat: 53.9, lon: 27.5 };
const to = { lat: 54.05, lon: 27.7 };

const realFetch = globalThis.fetch;
let calls = [];

/** Подмена fetch: очередной ответ из списка, запросы — в calls. */
function stubFetch(...responses) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return new Response(r.body ?? '', { status: r.status ?? 200, headers: r.headers ?? {} });
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('ORS directions: самый быстрый маршрут, длина в км и геометрия [lat, lon]', async () => {
  stubFetch({ body: fixture('ors-directions.json') });
  const r = await orsDirections(env, from, to, now);
  assert.equal(r.kind, 'ok');
  assert.ok(Math.abs(r.km - 21.3456) < 1e-9, String(r.km));
  const geometry = JSON.parse(fixture('ors-directions.json')).routes[0].geometry;
  assert.deepEqual(r.route, decodePolyline(geometry));
  assert.deepEqual(r.route[0], [53.9, 27.5]);

  const [call] = calls;
  assert.equal(call.url, `${ROUTING.orsBase}/directions/driving-car/json`);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'test-key');
  assert.match(call.init.headers['User-Agent'], /^house-hunter-bot\/\S+ \(\+https:\/\/t\.me\/test_bot\)$/);
  const body = JSON.parse(call.init.body);
  assert.deepEqual(body.coordinates, [[27.5, 53.9], [27.7, 54.05]], 'координаты — [lon, lat]');
  assert.equal(body.preference, 'fastest');
  assert.equal(body.instructions, false);
});

test('ORS directions: 200 без маршрута — ошибка, а не падение', async () => {
  stubFetch({ body: '{"routes":[]}' });
  assert.equal((await orsDirections(env, from, to, now)).kind, 'error');
  stubFetch({ body: 'не JSON' });
  assert.equal((await orsDirections(env, from, to, now)).kind, 'error');
});

test('ORS 2010 «нет дороги рядом с точкой» и 2009 «маршрут не найден» — unroutable', async () => {
  stubFetch({ status: 404, body: fixture('ors-error-2010.json') });
  assert.deepEqual(await orsDirections(env, from, to, now), { kind: 'unroutable', error: 'ORS: 2010' });
  stubFetch({ status: 404, body: fixture('ors-error-2009.json') });
  assert.equal((await orsDirections(env, from, to, now)).kind, 'unroutable');
});

test('ORS 403 — суточная квота исчерпана', async () => {
  stubFetch({ status: 403, body: fixture('ors-quota-403.json') });
  assert.equal((await orsDirections(env, from, to, now)).kind, 'quota');
});

test('ORS 429: пауза до x-ratelimit-reset, иначе Retry-After, иначе минута', async () => {
  const reset = Math.floor(now / 1000) + 42;
  stubFetch({ status: 429, body: fixture('ors-rate-429.json'), headers: { 'x-ratelimit-reset': String(reset) } });
  assert.deepEqual(await orsDirections(env, from, to, now), { kind: 'rate', retryAt: reset * 1000, error: 'ORS: 429' });

  stubFetch({ status: 429, body: fixture('ors-rate-429.json'), headers: { 'retry-after': '30' } });
  assert.equal((await orsDirections(env, from, to, now)).retryAt, now + 30_000);

  stubFetch({ status: 429, body: fixture('ors-rate-429.json') });
  assert.equal((await orsDirections(env, from, to, now)).retryAt, now + 60_000);
});

test('ORS 5xx и сетевая ошибка — временная ошибка (пара останется в очереди)', async () => {
  stubFetch({ status: 502, body: '<html>Bad Gateway</html>' });
  assert.deepEqual(await orsDirections(env, from, to, now), { kind: 'error', error: 'ORS: 502' });
  stubFetch(new TypeError('fetch failed'));
  const r = await orsDirections(env, from, to, now);
  assert.equal(r.kind, 'error');
  assert.match(r.error, /fetch failed/);
});

test('classifyOrsError без тела и заголовков', () => {
  assert.equal(classifyOrsError({ status: 500, json: null }, now).kind, 'error');
  assert.equal(classifyOrsError({ status: 400, json: { error: { code: 2003 } } }, now).error, 'ORS: 400 (2003)');
});

test('ORS matrix: 1 источник × цели, длины в км, недостижимая цель — null', async () => {
  stubFetch({ body: fixture('ors-matrix.json') });
  const targets = [{ lat: 53.98, lon: 27.61 }, { lat: 54.4, lon: 27.9 }, { lat: 54.06, lon: 27.71 }];
  const r = await orsMatrix(env, from, targets, now);
  assert.deepEqual(r, { kind: 'ok', km: [18.42, null, 33.07] });

  const [call] = calls;
  assert.equal(call.url, `${ROUTING.orsBase}/matrix/driving-car`);
  assert.equal(call.init.headers.Authorization, 'test-key');
  const body = JSON.parse(call.init.body);
  assert.deepEqual(body.locations, [[27.5, 53.9], [27.61, 53.98], [27.9, 54.4], [27.71, 54.06]]);
  assert.deepEqual(body.sources, [0]);
  assert.deepEqual(body.destinations, [1, 2, 3]);
  assert.deepEqual(body.metrics, ['distance']);
  assert.equal(body.units, 'km');
});

test('ORS matrix: число длин не совпадает с числом целей — ошибка; 403 — квота', async () => {
  stubFetch({ body: fixture('ors-matrix.json') });
  assert.equal((await orsMatrix(env, from, [{ lat: 53.98, lon: 27.61 }], now)).kind, 'error');
  stubFetch({ status: 403, body: fixture('ors-quota-403.json') });
  assert.equal((await orsMatrix(env, from, [{ lat: 53.98, lon: 27.61 }], now)).kind, 'quota');
});

test('OSRM: запасной маршрут, длина в км и геометрия polyline точности 5', async () => {
  stubFetch({ body: fixture('osrm-route.json') });
  const r = await osrmRoute(env, from, to);
  assert.equal(r.kind, 'ok');
  assert.ok(Math.abs(r.km - 21.9801) < 1e-9, String(r.km));
  assert.deepEqual(r.route, decodePolyline(JSON.parse(fixture('osrm-route.json')).routes[0].geometry));

  const [call] = calls;
  assert.equal(call.url, `${ROUTING.osrmBase}/route/v1/driving/27.5,53.9;27.7,54.05?overview=full&geometries=polyline`);
  assert.equal(call.init.method, undefined, 'GET');
  assert.match(call.init.headers['User-Agent'], /house-hunter-bot/);
});

test('OSRM: NoRoute — unroutable, 429 — пауза, 5xx — ошибка', async () => {
  stubFetch({ status: 400, body: fixture('osrm-noroute.json') });
  assert.deepEqual(await osrmRoute(env, from, to), { kind: 'unroutable', error: 'OSRM: NoRoute' });
  stubFetch({ status: 429, body: '' });
  assert.equal((await osrmRoute(env, from, to)).kind, 'rate');
  stubFetch({ status: 503, body: '' });
  assert.deepEqual(await osrmRoute(env, from, to), { kind: 'error', error: 'OSRM: 503' });
});
