import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeIsNew, geoKey, normalizeListing, plotSotki } from '../../src/sources/normalize.js';

const HOUR = 3600_000;
const now = Date.parse('2026-11-22T12:00:00Z');
const numeric = { id: 'kufar', origin: 'https://re.kufar.by', allowHosts: ['re.kufar.by'], idKind: 'numeric' };
const created = { id: 'realt', origin: 'https://realt.by', idKind: 'created_at' };
const withDetail = { id: 'moyareklama', origin: 'https://moyareklama.by', idKind: 'numeric', detailRequest: () => ({}) };

const raw = (over = {}) => ({
  externalId: '1000',
  url: 'https://re.kufar.by/vi/1000',
  kind: 'house',
  paid: false,
  price: { amount: 75000, currency: 'USD' },
  priceUsd: 75000,
  priceByn: 245000,
  houseArea: { value: 100, unit: 'm2' },
  plotArea: { value: 15, unit: 'sotki' },
  coords: { lat: 53.91234, lon: 27.56789 },
  place: { text: 'д. Боровляны, Минский р-н', settlement: 'Боровляны', district: 'Минский р-н', region: 'Минская обл.' },
  publishedAt: '2026-11-22T10:00:00Z',
  siteCreatedAt: null,
  photoUrl: 'https://rms.kufar.by/v1/gallery/a.jpg',
  ...over,
});

test('BYN → $ по курсу, если сайт не дал $', () => {
  const row = normalizeListing(raw({ priceUsd: null, priceByn: null, price: { amount: 312000, currency: 'BYN' } }), numeric, { now, rate: 3.12 });
  assert.equal(row.price_usd, 100000);
  assert.equal(row.price_byn, 312000);
  const noRate = normalizeListing(raw({ priceUsd: null, priceByn: null, price: { amount: 312000, currency: 'BYN' } }), numeric, { now, rate: null });
  assert.equal(noRate.price_usd, null);
});

test('«договорная» и 0 → NULL', () => {
  const row = normalizeListing(raw({ price: null, priceUsd: 0, priceByn: null }), numeric, { now, rate: 3 });
  assert.equal(row.price_usd, null);
  assert.equal(row.price_byn, null);
});

test('га и м² → сотки', () => {
  assert.equal(plotSotki({ value: 0.15, unit: 'ha' }), 15);
  assert.equal(plotSotki({ value: 1500, unit: 'm2' }), 15);
  assert.equal(plotSotki({ value: 6.9, unit: 'sotki' }), 6.9);
  assert.equal(plotSotki({ value: 0, unit: 'sotki' }), null);
  assert.equal(plotSotki(null), null);
});

test('geo_key — 4 знака; место без координат — по справочнику, «≈»', () => {
  assert.equal(geoKey(53.91234, 27.56789), '53.9123,27.5679');
  const row = normalizeListing(raw(), numeric, { now, rate: 3 });
  assert.equal(row.geo_key, '53.9123,27.5679');
  assert.equal(row.geo_approx, 0);
  const approx = normalizeListing(raw({ coords: null }), numeric, { now, rate: 3, settlement: { id: 7, lat: 53.95, lon: 27.65 } });
  assert.deepEqual([approx.lat, approx.lon, approx.geo_approx, approx.settlement_id], [53.95, 27.65, 1, 7]);
  const none = normalizeListing(raw({ coords: null }), numeric, { now, rate: 3 });
  assert.deepEqual([none.lat, none.geo_key], [null, null]);
  const outside = normalizeListing(raw({ coords: { lat: 0, lon: 0 } }), numeric, { now, rate: 3 });
  assert.equal(outside.lat, null, 'координаты вне Беларуси не принимаются');
});

test('sort_at: дата публикации, а без неё — время первого обнаружения', () => {
  assert.equal(normalizeListing(raw(), numeric, { now, rate: 3 }).sort_at, Date.parse('2026-11-22T10:00:00Z'));
  assert.equal(normalizeListing(raw({ publishedAt: null }), numeric, { now, rate: 3 }).sort_at, now);
});

test('is_new по номеру: выше суточной отметки — новое', () => {
  assert.equal(computeIsNew(numeric, raw({ externalId: '1001' }), { now, idFloor: 1000, firstCycle: false }), 1);
  assert.equal(computeIsNew(numeric, raw({ externalId: '1000' }), { now, idFloor: 1000, firstCycle: false }), 0);
  assert.equal(computeIsNew(numeric, raw({ externalId: '1001' }), { now, idFloor: null, firstCycle: false }), 0);
});

test('is_new по дате создания: не старше 48 ч', () => {
  const at = (h) => new Date(now - h * HOUR).toISOString();
  assert.equal(computeIsNew(created, raw({ siteCreatedAt: at(47) }), { now, idFloor: null, firstCycle: false }), 1);
  assert.equal(computeIsNew(created, raw({ siteCreatedAt: at(49) }), { now, idFloor: null, firstCycle: false }), 0);
  assert.equal(computeIsNew(created, raw({ siteCreatedAt: null }), { now, idFloor: null, firstCycle: false }), 0);
});

test('первый круг опроса ленты — всё старое', () => {
  assert.equal(computeIsNew(numeric, raw({ externalId: '5000' }), { now, idFloor: 1000, firstCycle: true }), 0);
  assert.equal(computeIsNew(created, raw({ siteCreatedAt: new Date(now).toISOString() }), { now, idFloor: null, firstCycle: true }), 0);
});

test('ссылка не на домен источника или не https — объявление отброшено', () => {
  assert.equal(normalizeListing(raw({ url: 'https://evil.example/vi/1' }), numeric, { now, rate: 3 }), null);
  assert.equal(normalizeListing(raw({ url: 'http://re.kufar.by/vi/1' }), numeric, { now, rate: 3 }), null);
  assert.equal(normalizeListing(raw({ url: 'javascript:alert(1)' }), numeric, { now, rate: 3 }), null);
  assert.equal(normalizeListing(raw({ externalId: '' }), numeric, { now, rate: 3 }), null);
  assert.ok(normalizeListing(raw({ url: 'https://realt.by/sale-cottages/object/1/' }), created, { now, rate: 3 }));
});

test('нужна карточка, если адаптер умеет её читать, а координат нет', () => {
  const row = normalizeListing(raw({ url: 'https://moyareklama.by/single/ad/1', coords: null }), withDetail, { now, rate: 3 });
  assert.equal(row.needs_detail, 1);
  assert.equal(normalizeListing(raw({ url: 'https://moyareklama.by/single/ad/1' }), withDetail, { now, rate: 3 }).needs_detail, 0);
});
