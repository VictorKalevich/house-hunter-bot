// Расстояние по дороге (tasks.md T060, US3): от центра, от выезда, место внутри пункта, маршрут не построен, «считается».
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { exitDistanceKm } from '../../src/geo/exit-distance.js';
import { haversineKm } from '../../src/geo/haversine.js';
import { shapeFromRow } from '../../src/geo/polygon.js';
import { decodePolyline, encodePolyline } from '../../src/geo/polyline.js';
import { createHarness, criteria, kufarAd, MEMBER, PLACES, straightRoute } from './harness.mjs';

const C = PLACES.minsk;
const at = (kmNorth, kmEast = 0) => ({
  lat: C.lat + kmNorth / 111.195,
  lon: C.lon + kmEast / (111.195 * Math.cos((C.lat * Math.PI) / 180)),
});
const key = (p) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;

/** Прямой маршрут из 40 точек; km — длина, которую «вернёт» сервис. */
function denseRoute(from, to, km) {
  const points = [];
  for (let i = 0; i <= 40; i++) points.push([from.lat + ((to.lat - from.lat) * i) / 40, from.lon + ((to.lon - from.lon) * i) / 40]);
  return { km, points };
}

let h;
const roads = new Map();
const unroutable = new Set();
let searchId;

const p25 = at(25);
const p10 = at(10, 3);
const pInside = at(1);
const pExit = at(0, 22);
const pNoRoad = at(-15, 15);

async function listing(id) {
  const res = await h.api(MEMBER, 'GET', `/searches/${id}/listings?page=1`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}
const byPlace = (items, p) => items.find((i) => i.url.endsWith(`/${p.adId}`));

before(async () => {
  h = await createHarness({ only: ['kufar'] });
  await h.addMember(MEMBER);
  h.route = (from, to, kind) => {
    const k = key(to);
    if (unroutable.has(k)) {
      return kind === 'osrm' ? { status: 400, body: { code: 'NoRoute', message: 'Impossible route' } }
        : { status: 404, body: { error: { code: 2010, message: 'Could not find routable point' } } };
    }
    return roads.get(k)?.(from, to) ?? straightRoute(from, to);
  };
  roads.set(key(p25), (f, t) => denseRoute(f, t, 38));
  roads.set(key(p10), (f, t) => denseRoute(f, t, 13.5));
  roads.set(key(pExit), (f, t) => denseRoute(f, t, haversineKm(f.lat, f.lon, t.lat, t.lon)));
  roads.set(key(pInside), (f, t) => denseRoute(f, t, 1.4));
  unroutable.add(key(pNoRoad));

  // Первый круг ленты — объявления «старые», для списка этого достаточно.
  const ads = [p25, p10, pInside, pExit, pNoRoad].map((p) => {
    const ad = kufarAd({ ...p });
    p.adId = ad.ad_id;
    return ad;
  });
  h.kufarAds = ads;
  await h.ticks(3);
  assert.equal((await h.first('SELECT COUNT(*) AS n FROM listings')).n, 5);
});
after(() => h?.close());

test('по прямой 25 км при лимите 30 — в списке; переключение на «по дороге от центра»: пока считается — pending', async () => {
  const created = await h.api(MEMBER, 'POST', '/searches', criteria({ settlementId: C.id, maxKm: 30 }));
  searchId = created.body.id;
  const before = await listing(searchId);
  const item = byPlace(before.items, p25);
  assert.deepEqual(item.distance, { km: 25, mode: 'straight', approx: false, fallback: false, pending: false });

  const put = await h.api(MEMBER, 'PUT', `/searches/${searchId}`, criteria({ settlementId: C.id, maxKm: 30, distanceMode: 'road_center' }));
  assert.equal(put.status, 200);
  assert.equal(put.body.title, 'Минск · до 30 км по дороге');
  const pending = await listing(searchId);
  const p = byPlace(pending.items, p25);
  assert.equal(p.distance.mode, 'road_center');
  assert.equal(p.distance.pending, true);
  assert.equal(p.distance.km, 25);
  const queued = await h.first('SELECT COUNT(*) AS n FROM distances WHERE settlement_id = ? AND status = ?', C.id, 'pending');
  assert.ok(queued.n >= 4);
});

test('маршрут посчитан: 38 км по дороге > 30 — объявление уходит; 13,5 км остаётся с новой подписью', async () => {
  await h.tick();
  const after = await listing(searchId);
  assert.equal(byPlace(after.items, p25), undefined);
  const near = byPlace(after.items, p10);
  assert.equal(near.distance.mode, 'road_center');
  assert.equal(near.distance.km, 13.5);
  assert.equal(near.distance.pending, false);
  const row = await h.first('SELECT road_center_km, status FROM distances WHERE geo_key = ?', key(p25));
  assert.deepEqual({ ...row }, { road_center_km: 38, status: 'ok' });
});

test('маршрут не построен → по прямой с пометкой fallback', async () => {
  const item = byPlace((await listing(searchId)).items, pNoRoad);
  assert.equal(item.distance.fallback, true);
  assert.equal(item.distance.km, Math.round(haversineKm(C.lat, C.lon, pNoRoad.lat, pNoRoad.lon) * 10) / 10);
  assert.equal((await h.first('SELECT status FROM distances WHERE geo_key = ?', key(pNoRoad))).status, 'failed');
});

test('«от выезда» не включает путь по пункту; место внутри пункта → 0 км', async () => {
  const created = await h.api(MEMBER, 'POST', '/searches', criteria({ settlementId: C.id, maxKm: 30, distanceMode: 'road_exit' }));
  assert.equal(created.status, 201);
  await h.ticks(2);
  const items = (await listing(created.body.id)).items;

  const shape = shapeFromRow(await h.first('SELECT polygon, radius_km FROM settlement_shapes WHERE settlement_id = ?', C.id), C.lat, C.lon);
  const route = denseRoute(C, pExit, haversineKm(C.lat, C.lon, pExit.lat, pExit.lon));
  const expected = exitDistanceKm(route.km, decodePolyline(encodePolyline(route.points)), shape, pExit);
  const exit = byPlace(items, pExit);
  assert.equal(exit.distance.mode, 'road_exit');
  assert.ok(Math.abs(exit.distance.km - expected) <= 0.11, `${exit.distance.km} ≈ ${expected}`);
  assert.ok(exit.distance.km < route.km - 5, 'путь по Минску не входит');

  const inside = byPlace(items, pInside);
  assert.equal(inside.distance.km, 0);
  const row = await h.first('SELECT road_center_km, road_exit_km FROM distances WHERE geo_key = ?', key(pInside));
  assert.deepEqual({ ...row }, { road_center_km: 1.4, road_exit_km: 0 });
});

test('уведомление по дороге ждёт маршрут и подписывается «по дороге от центра»; без маршрута — «(маршрут не построен)»', async () => {
  const pNew = at(12, -4);
  const pNewNoRoad = at(-6, -20);
  roads.set(key(pNew), (f, t) => denseRoute(f, t, 17));
  unroutable.add(key(pNewNoRoad));
  const fresh = kufarAd({ ...pNew });
  const freshNoRoad = kufarAd({ ...pNewNoRoad });
  h.kufarAds = [fresh, freshNoRoad, ...h.kufarAds];
  await h.pollNow('kufar');
  const first = await h.tick();
  assert.ok(first.steps.match.waiting >= 2, JSON.stringify(first.steps.match));
  assert.equal(h.sent(MEMBER.id).length, 0);
  await h.ticks(2);
  const texts = h.sent(MEMBER.id).map((c) => c.params.text);
  assert.ok(texts.some((t) => t.includes('Минск: 17 км по дороге от центра')), texts.join('\n---\n'));
  assert.ok(texts.some((t) => /Минск: \d+ км по прямой \(маршрут не построен\)/.test(t)), texts.join('\n---\n'));
});
