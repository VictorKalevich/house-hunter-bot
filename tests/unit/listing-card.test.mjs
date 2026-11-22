import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listingCard } from '../../src/match/format.js';

const listing = (over = {}) => ({
  source: 'kufar', external_id: '1', url: 'https://re.kufar.by/vi/1',
  price_usd: 75000, price_byn: 245000, house_m2: 100, plot_sotki: 15,
  place_text: 'д. Боровляны, Минский р-н', photo_url: 'https://rms.kufar.by/v1/gallery/a.jpg',
  published_at: Date.parse('2026-11-22T09:41:00Z'), first_seen_at: Date.parse('2026-11-22T09:45:00Z'),
  ...over,
});

test('ListingCard: null-поля, расстояние, источник, дата', () => {
  const card = listingCard(listing({ house_m2: null, photo_url: null }), { km: 25.44, mode: 'straight', approx: true, fallback: false, pending: false });
  assert.deepEqual(card, {
    source: 'kufar', url: 'https://re.kufar.by/vi/1', photoUrl: null,
    priceUsd: 75000, priceByn: 245000, houseM2: null, plotSotki: 15,
    distance: { km: 25.4, mode: 'straight', approx: true, fallback: false, pending: false },
    place: 'д. Боровляны, Минский р-н', publishedAt: '2026-11-22T09:41:00.000Z',
  });
  assert.equal(listingCard(listing({ published_at: null }), null).publishedAt, '2026-11-22T09:45:00.000Z');
  assert.equal(listingCard(listing(), null).distance, null);
});

test('ListingCard: дорожное расстояние считается или не построено', () => {
  assert.deepEqual(listingCard(listing(), { km: 25, mode: 'road_exit', approx: false, fallback: false, pending: true }).distance,
    { km: 25, mode: 'road_exit', approx: false, fallback: false, pending: true });
  assert.equal(listingCard(listing(), { km: 25, mode: 'road_center', approx: false, fallback: true, pending: false }).distance.fallback, true);
});
