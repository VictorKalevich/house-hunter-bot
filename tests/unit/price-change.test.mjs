// Правило изменения цены (specs/003-listing-likes/research.md R9, quickstart.md §1 «Изменение цены»).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceChange } from '../../src/match/price-change.js';

const p = (price_amount, price_currency, price_usd = null, price_byn = null) => ({ price_amount, price_currency, price_usd, price_byn });

test('валюта продавца одна: граница 1 % — 0,99 % нет, 1 % да', () => {
  assert.equal(priceChange(p(52000, 'USD'), p(51486, 'USD')), null);
  assert.deepEqual(priceChange(p(52000, 'USD'), p(51480, 'USD')), { currency: 'USD', oldPrice: 52000, newPrice: 51480 });
  assert.deepEqual(priceChange(p(52000, 'USD'), p(48000, 'USD')), { currency: 'USD', oldPrice: 52000, newPrice: 48000 });
  assert.deepEqual(priceChange(p(100000, 'USD'), p(101000, 'USD')), { currency: 'USD', oldPrice: 100000, newPrice: 101000 });
  assert.equal(priceChange(p(52000, 'USD'), p(52000, 'USD')), null);
});

test('рубли и евро у продавца', () => {
  assert.deepEqual(priceChange(p(155000, 'BYN'), p(150000, 'BYN')), { currency: 'BYN', oldPrice: 155000, newPrice: 150000 });
  assert.deepEqual(priceChange(p(60000, 'EUR'), p(57000, 'EUR')), { currency: 'EUR', oldPrice: 60000, newPrice: 57000 });
});

test('курс: цена в $ та же, рубли −2 % — не изменение', () => {
  assert.equal(priceChange(p(52000, 'USD', 52000, 156000), p(52000, 'USD', 52000, 152880)), null);
  assert.equal(priceChange(p(156000, 'BYN', 52000, 156000), p(156000, 'BYN', 51000, 156000)), null);
});

test('валюта неизвестна: обе цены в одну сторону — да, в разные — нет', () => {
  assert.deepEqual(priceChange(p(null, null, 52000, 156000), p(null, null, 48000, 144000)),
    { currency: 'USD', oldPrice: 52000, newPrice: 48000 });
  assert.equal(priceChange(p(null, null, 52000, 156000), p(null, null, 51000, 158000)), null);
  assert.equal(priceChange(p(null, null, 52000, 156000), p(null, null, 51000, 156000)), null, 'рубли не сдвинулись');
});

test('одна цена — изменение по ней', () => {
  assert.deepEqual(priceChange(p(null, null, null, 7000), p(null, null, null, 6500)), { currency: 'BYN', oldPrice: 7000, newPrice: 6500 });
  assert.deepEqual(priceChange(p(null, null, 52000, null), p(null, null, 50000, null)), { currency: 'USD', oldPrice: 52000, newPrice: 50000 });
  assert.equal(priceChange(p(null, null, 52000, null), p(null, null, 51800, null)), null);
});

test('цена появилась или пропала — не изменение', () => {
  assert.equal(priceChange(p(52000, 'USD', 52000, 156000), p(null, null, null, null)), null);
  assert.equal(priceChange(p(null, null, null, null), p(52000, 'USD', 52000, 156000)), null);
  assert.equal(priceChange(p(null, null, 52000, null), p(null, null, null, 150000)), null);
});

test('продавец сменил валюту — сравнение по долларам и рублям', () => {
  assert.deepEqual(priceChange(p(52000, 'USD', 52000, 156000), p(150000, 'BYN', 50000, 150000)),
    { currency: 'USD', oldPrice: 52000, newPrice: 50000 });
  assert.equal(priceChange(p(52000, 'USD', 52000, 156000), p(156000, 'BYN', 52000, 156000)), null);
});

test('старая строка без цены продавца: сравнение по долларам и рублям', () => {
  assert.equal(priceChange(p(null, null, 52000, 156000), p(52000, 'USD', 52000, 156000)), null);
  assert.deepEqual(priceChange(p(null, null, 52000, 156000), p(48000, 'USD', 48000, 144000)),
    { currency: 'USD', oldPrice: 52000, newPrice: 48000 });
});
