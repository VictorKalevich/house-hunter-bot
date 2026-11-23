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
    id: null, mark: null, siteStatus: null,
    source: 'kufar', url: 'https://re.kufar.by/vi/1', photoUrl: null, kind: null,
    priceUsd: 75000, priceByn: 245000, houseM2: null, plotSotki: 15,
    distance: { km: 25.4, mode: 'straight', approx: true, fallback: false, pending: false },
    place: 'д. Боровляны, Минский р-н', publishedAt: '2026-11-22T09:41:00.000Z', isNew: false, createdAt: null,
  });
  assert.equal(listingCard(listing({ published_at: null }), null).publishedAt, '2026-11-22T09:45:00.000Z');
  assert.equal(listingCard(listing(), null).distance, null);
});

test('ListingCard: id и отметка пользователя (фича 003)', () => {
  const card = listingCard(listing({ id: 48213 }), null, { mark: 'like' });
  assert.equal(card.id, 48213);
  assert.equal(card.mark, 'like');
  assert.equal(listingCard(listing({ id: 1 }), null).mark, null);
});

test('ListingCard: тип объекта (фича 002)', () => {
  assert.equal(listingCard(listing({ kind: 'dacha' }), null).kind, 'dacha');
  assert.equal(listingCard(listing({ kind: null }), null).kind, null);
});

test('ListingCard: новое на сайте и дата размещения (фича 002)', () => {
  assert.equal(listingCard(listing({ is_new: 1 }), null).isNew, true);
  assert.equal(listingCard(listing({ is_new: 0 }), null).isNew, false);
  assert.equal(listingCard(listing({ site_created_at: Date.parse('2026-10-03T08:00:00Z') }), null).createdAt, '2026-10-03T08:00:00.000Z');
  assert.equal(listingCard(listing({ site_created_at: null }), null).createdAt, null);
});

test('ListingCard: дорожное расстояние считается или не построено', () => {
  assert.deepEqual(listingCard(listing(), { km: 25, mode: 'road_exit', approx: false, fallback: false, pending: true }).distance,
    { km: 25, mode: 'road_exit', approx: false, fallback: false, pending: true });
  assert.equal(listingCard(listing(), { km: 25, mode: 'road_center', approx: false, fallback: true, pending: false }).distance.fallback, true);
});

test('ListingCard.siteStatus: снято, не удалось проверить, без пометки (фича 003)', () => {
  const DAY = 24 * 3600_000;
  const now = Date.parse('2026-12-01T12:00:00Z');
  const goneAt = Date.parse('2026-11-24T00:41:00Z');
  assert.deepEqual(listingCard(listing({ id: 1, gone_at: goneAt, last_seen_at: now }), null, { mark: null, now }).siteStatus,
    { kind: 'gone', at: '2026-11-24T00:41:00.000Z' });
  const seen = now - 8 * DAY;
  assert.deepEqual(listingCard(listing({ id: 1, gone_at: null, last_seen_at: seen, check_ok_at: null }), null, { mark: 'like', now }).siteStatus,
    { kind: 'unchecked', lastSeenAt: new Date(seen).toISOString() });
  assert.equal(listingCard(listing({ id: 1, last_seen_at: seen }), null, { mark: null, now }).siteStatus, null, 'без лайка — нет');
  assert.equal(listingCard(listing({ id: 1, last_seen_at: seen }), null, { mark: 'hide', now }).siteStatus, null);
  assert.equal(listingCard(listing({ id: 1, last_seen_at: seen, check_ok_at: now - DAY }), null, { mark: 'like', now }).siteStatus, null,
    'свежая проверка страницы');
  assert.equal(listingCard(listing({ id: 1, last_seen_at: now - 6 * DAY }), null, { mark: 'like', now }).siteStatus, null, '6 суток — ещё нет');
});
