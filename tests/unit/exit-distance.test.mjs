import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exitDistanceKm, exitLowerBound, outsideFraction } from '../../src/geo/exit-distance.js';
import { circleRing, makeShape, shapeFromRow } from '../../src/geo/polygon.js';

// Граница — квадрат 53.90–53.92 × 27.50–27.53. Маршруты идут по меридиану 27.515: длина куска
// пропорциональна разнице широт, поэтому ожидаемая доля считается точно.
const shape = makeShape([[[53.9, 27.5], [53.9, 27.53], [53.92, 27.53], [53.92, 27.5]]]);
const LON = 27.515;
const path = (...lats) => lats.map((lat) => [lat, LON]);
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('маршрут пересекает границу: доля за границей', () => {
  // 0,005 внутри; отрезок 53.915→53.925 пересекает границу посередине; 0,025 снаружи.
  close(outsideFraction(path(53.91, 53.915, 53.925, 53.95), shape), 0.03 / 0.04);
});

test('повторный заезд в пункт: суммируются все внешние куски', () => {
  // Выезд, возврат внутрь, снова выезд: снаружи 0,06 из 0,09.
  const route = path(53.91, 53.915, 53.925, 53.935, 53.925, 53.915, 53.91, 53.93, 53.95);
  close(outsideFraction(route, shape), 0.06 / 0.09);
});

test('маршрут целиком внутри — 0, целиком снаружи — 1', () => {
  assert.equal(outsideFraction(path(53.905, 53.91, 53.915), shape), 0);
  assert.equal(outsideFraction(path(53.93, 53.95, 53.97), shape), 1);
});

test('вырожденный маршрут из одной точки', () => {
  assert.equal(outsideFraction(path(53.91), shape), 0);
  assert.equal(outsideFraction(path(53.95), shape), 1);
});

test('road_exit = длина маршрута сервиса × доля за границей', () => {
  const route = path(53.91, 53.915, 53.925, 53.95);
  close(exitDistanceKm(40, route, shape, { lat: 53.95, lon: LON }), 40 * 0.75);
});

test('место объявления внутри границы — 0 (US3, сценарий 3), даже если маршрут выезжал', () => {
  const route = path(53.91, 53.93, 53.915);
  assert.equal(exitDistanceKm(12, route, shape, { lat: 53.915, lon: LON }), 0);
});

test('граница-окружность: маршрут от центра наружу', () => {
  const circle = shapeFromRow(null, 53.9, 27.56); // 0,5 км
  const route = [[53.9, 27.56], [53.9 + 2 / 111.2, 27.56]];
  const km = exitDistanceKm(2.4, route, circle, { lat: route[1][0], lon: 27.56 });
  // Снаружи ~1,5 из 2 км прямой; доля переносится на длину по дороге (2,4 км). Точность — шаг деления отрезка.
  assert.ok(km > 2.4 * 0.7 && km < 2.4 * 0.8, String(km));
  assert.equal(makeShape([circleRing(53.9, 27.56, 0.5)]).rings[0].length, 16);
});

test('нижняя оценка «от выезда» для отбора: прямая минус радиус, не меньше 0', () => {
  assert.equal(exitLowerBound(25, 2), 23);
  assert.equal(exitLowerBound(1, 2), 0);
  assert.equal(exitLowerBound(3.5, 0), 3.5);
});
