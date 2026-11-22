import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inRange, matchesSearch, passesFilters } from '../../src/match/criteria.js';

const search = (over = {}) => ({
  sources: 'kufar,realt,domovita,moyareklama',
  price_min_usd: null, price_max_usd: 80000,
  house_min_m2: 80, house_max_m2: null,
  plot_min_sotki: 10, plot_max_sotki: null,
  max_km: 30, distance_mode: 'straight', settlement_id: 1,
  active_since: 1000,
  ...over,
});
const listing = (over = {}) => ({
  source: 'kufar', price_usd: 75000, house_m2: 100, plot_sotki: 15,
  is_new: 1, first_seen_at: 2000, lat: 53.9, lon: 27.5,
  ...over,
});

test('границы диапазонов включительные', () => {
  assert.equal(inRange(80000, null, 80000), true);
  assert.equal(inRange(80000.01, null, 80000), false);
  assert.equal(inRange(80, 80, null), true);
  assert.equal(inRange(79.9, 80, null), false);
  assert.equal(matchesSearch(listing({ price_usd: 80000, house_m2: 80, plot_sotki: 10 }), search(), { distanceKm: 30 }), true);
});

test('неуказанное поле объявления не отсекает', () => {
  assert.equal(passesFilters(listing({ price_usd: null, house_m2: null, plot_sotki: null }), search()), true);
});

test('условия поиска отсекают', () => {
  assert.equal(passesFilters(listing({ price_usd: 90000 }), search()), false);
  assert.equal(passesFilters(listing({ house_m2: 60 }), search()), false);
  assert.equal(passesFilters(listing({ plot_sotki: 6 }), search()), false);
});

test('фильтр по сайтам поиска', () => {
  assert.equal(passesFilters(listing({ source: 'realt' }), search({ sources: 'kufar' })), false);
  assert.equal(passesFilters(listing({ source: 'kufar' }), search({ sources: 'kufar' })), true);
});

test('расстояние: лимит включительный (по 0,1 км), без места при max_km — не подходит', () => {
  assert.equal(matchesSearch(listing(), search(), { distanceKm: 30.04 }), true);
  assert.equal(matchesSearch(listing(), search(), { distanceKm: 30.06 }), false);
  assert.equal(matchesSearch(listing({ lat: null, lon: null }), search(), { distanceKm: null }), false);
  assert.equal(matchesSearch(listing({ lat: null, lon: null }), search({ max_km: null, settlement_id: null }), { distanceKm: null }), true);
});

test('для уведомлений — только новое на сайте и после создания поиска', () => {
  const opts = { distanceKm: 10, forNotification: true };
  assert.equal(matchesSearch(listing(), search(), opts), true);
  assert.equal(matchesSearch(listing({ is_new: 0 }), search(), opts), false);
  assert.equal(matchesSearch(listing({ first_seen_at: 999 }), search(), opts), false);
  assert.equal(matchesSearch(listing({ first_seen_at: 1000 }), search(), opts), true);
  assert.equal(matchesSearch(listing({ is_new: 0, first_seen_at: 1 }), search(), { distanceKm: 10 }), true, 'для списка не нужно');
});
