import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundsAround, haversineKm, roundKm } from '../../src/geo/haversine.js';

test('известные пары точек', () => {
  // Париж — Лондон: 343,5 км (гаверсинус, R = 6371 км)
  assert.ok(Math.abs(haversineKm(48.8566, 2.3522, 51.5074, -0.1278) - 343.5) < 0.5);
  // 1° по экватору = R·π/180
  assert.ok(Math.abs(haversineKm(0, 0, 0, 1) - (6371.0088 * Math.PI) / 180) < 1e-9);
  assert.equal(haversineKm(53.9, 27.5, 53.9, 27.5), 0);
  // 1° широты ≈ 111,2 км
  assert.ok(Math.abs(haversineKm(53, 27, 54, 27) - 111.2) < 0.2);
});

test('прямоугольник отбора содержит весь круг', () => {
  const lat = 53.9;
  const lon = 27.56;
  const km = 30;
  const b = boundsAround(lat, lon, km);
  for (let deg = 0; deg < 360; deg += 5) {
    // Точка на окружности радиуса km (по азимуту)
    const d = km / 6371.0088;
    const br = (deg * Math.PI) / 180;
    const la1 = (lat * Math.PI) / 180;
    const lo1 = (lon * Math.PI) / 180;
    const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br));
    const lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
    const p = [(la2 * 180) / Math.PI, (lo2 * 180) / Math.PI];
    assert.ok(p[0] >= b.minLat && p[0] <= b.maxLat && p[1] >= b.minLon && p[1] <= b.maxLon, `азимут ${deg}`);
  }
  assert.ok(b.maxLat - lat < 0.28, 'и не слишком велик');
});

test('округление до 0,1 км', () => {
  assert.equal(roundKm(30.04), 30);
  assert.equal(roundKm(30.06), 30.1);
});
