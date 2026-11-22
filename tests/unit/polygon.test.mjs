import { test } from 'node:test';
import assert from 'node:assert/strict';
import { circleRing, makeShape, pointInShape, shapeFromRow } from '../../src/geo/polygon.js';
import { encodePolyline } from '../../src/geo/polyline.js';
import { haversineKm } from '../../src/geo/haversine.js';

// Квадрат 53.90–53.92 × 27.50–27.53, вершины [lat, lon], контур не замкнут (как в seeds/settlements.sql).
const square = [[53.9, 27.5], [53.9, 27.53], [53.92, 27.53], [53.92, 27.5]];

test('окружность: 16 вершин на расстоянии радиуса от центра', () => {
  const ring = circleRing(53.9, 27.56, 2);
  assert.equal(ring.length, 16);
  for (const [lat, lon] of ring) assert.ok(Math.abs(haversineKm(53.9, 27.56, lat, lon) - 2) < 0.02, `${lat},${lon}`);
  assert.equal(circleRing(53.9, 27.56, 1, 8).length, 8);
});

test('точка в квадрате и вне его; отсев по bbox', () => {
  const shape = makeShape([square]);
  assert.deepEqual(shape.bbox, { minLat: 53.9, maxLat: 53.92, minLon: 27.5, maxLon: 27.53 });
  assert.equal(pointInShape(shape, 53.91, 27.515), true);
  assert.equal(pointInShape(shape, 53.93, 27.515), false);
  assert.equal(pointInShape(shape, 53.91, 27.6), false);
  assert.equal(pointInShape(shape, 52, 23), false);
});

test('замкнутый контур (первая вершина повторена) даёт тот же ответ', () => {
  const closed = makeShape([[...square, square[0]]]);
  assert.equal(pointInShape(closed, 53.91, 27.515), true);
  assert.equal(pointInShape(closed, 53.925, 27.515), false);
});

test('невыпуклый контур: точка в «вырезе» буквы Г — снаружи, хотя внутри bbox', () => {
  const ell = makeShape([[[53.9, 27.5], [53.9, 27.53], [53.91, 27.53], [53.91, 27.51], [53.92, 27.51], [53.92, 27.5]]]);
  assert.equal(pointInShape(ell, 53.905, 27.52), true);
  assert.equal(pointInShape(ell, 53.915, 27.505), true);
  assert.equal(pointInShape(ell, 53.915, 27.52), false);
});

test('полигон с дырой: точка в дыре — снаружи, между контурами — внутри', () => {
  const hole = [[53.905, 27.51], [53.905, 27.52], [53.915, 27.52], [53.915, 27.51]];
  const shape = makeShape([square, hole]);
  assert.equal(pointInShape(shape, 53.91, 27.515), false);
  assert.equal(pointInShape(shape, 53.902, 27.515), true);
  assert.equal(pointInShape(shape, 53.91, 27.525), true);
});

test('граница из settlement_shapes: source = osm — полигон из encoded polyline', () => {
  const row = { polygon: encodePolyline(square), radius_km: 1.6, source: 'osm' };
  const shape = shapeFromRow(row, 53.91, 27.515);
  assert.equal(shape.rings.length, 1);
  assert.deepEqual(shape.rings[0], square);
  assert.equal(pointInShape(shape, 53.919, 27.529), true);
  assert.equal(pointInShape(shape, 53.921, 27.515), false);
});

test('source = circle — граница 16-угольником (data-model.md settlement_shapes)', () => {
  const ring = circleRing(53.9, 27.56, 2);
  const row = { polygon: encodePolyline(ring), radius_km: 2, source: 'circle' };
  const shape = shapeFromRow(row, 53.9, 27.56);
  // 1,9 км на север — внутри, 2,1 км — снаружи (1° широты ≈ 111,2 км).
  assert.equal(pointInShape(shape, 53.9 + 1.9 / 111.2, 27.56), true);
  assert.equal(pointInShape(shape, 53.9 + 2.1 / 111.2, 27.56), false);
});

test('без строки или с полигоном короче трёх точек — окружность radius_km (по умолчанию 0,5 км)', () => {
  const none = shapeFromRow(null, 53.9, 27.56);
  assert.equal(none.rings[0].length, 16);
  assert.equal(pointInShape(none, 53.9 + 0.4 / 111.2, 27.56), true);
  assert.equal(pointInShape(none, 53.9 + 0.6 / 111.2, 27.56), false);

  const short = shapeFromRow({ polygon: encodePolyline([[53.9, 27.56], [53.91, 27.56]]), radius_km: 1 }, 53.9, 27.56);
  assert.equal(short.rings[0].length, 16);
  assert.equal(pointInShape(short, 53.9 + 0.9 / 111.2, 27.56), true);
});
