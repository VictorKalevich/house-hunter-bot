import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDistrict, normalizeName, normalizeRegion, pickSettlement } from '../../src/geo/gazetteer.js';

test('нормализация названия как settlements.name_norm', () => {
  assert.equal(normalizeName('Ёлки'), 'елки');
  assert.equal(normalizeName('д. Боровляны'), 'боровляны');
  assert.equal(normalizeName('аг. Поколюбичи'), 'поколюбичи');
  assert.equal(normalizeName('г.п. Ружаны'), 'ружаны');
  assert.equal(normalizeName('п. Колодищи'), 'колодищи');
  assert.equal(normalizeName('х. Заречье'), 'заречье');
  assert.equal(normalizeName('г. Гомель'), 'гомель');
  assert.equal(normalizeName('агрогородок  «Ченки» '), 'ченки');
  assert.equal(normalizeName('Городок'), 'городок');
  assert.equal(normalizeName('Пуховичи'), 'пуховичи');
});

test('район и область: сокращения → полные слова', () => {
  assert.equal(normalizeDistrict('Минский р-н'), 'минский район');
  assert.equal(normalizeDistrict('Минский район'), 'минский район');
  assert.equal(normalizeDistrict(null), '');
  assert.equal(normalizeRegion('Гомельская обл.'), 'гомельская область');
  assert.equal(normalizeRegion('Гомельская область'), 'гомельская область');
  assert.equal(normalizeRegion('г. Минск'), 'минск');
});

const chenki = [
  { id: 1, name: 'Ченки', kind: 'village', district: 'Гомельский район', region: 'Гомельская область' },
  { id: 2, name: 'Ченки', kind: 'village', district: 'Буда-Кошелёвский район', region: 'Гомельская область' },
];

test('сопоставление по названию + району + области', () => {
  assert.equal(pickSettlement(chenki, { district: 'Гомельский р-н', region: 'Гомельская обл.' }).id, 1);
  assert.equal(pickSettlement(chenki, { district: 'Буда-Кошелевский р-н' }).id, 2);
});

test('неоднозначно или не найдено → null', () => {
  assert.equal(pickSettlement(chenki, { region: 'Гомельская область' }), null);
  assert.equal(pickSettlement(chenki, {}), null);
  assert.equal(pickSettlement(chenki, { district: 'Минский р-н', region: 'Минская обл.' }), null);
  assert.equal(pickSettlement([], { district: 'Гомельский р-н' }), null);
});

test('город областного подчинения: района у пункта нет', () => {
  const gomel = [
    { id: 10, name: 'Гомель', kind: 'city', district: null, region: 'Гомельская область' },
    { id: 11, name: 'Гомель', kind: 'hamlet', district: 'Мозырский район', region: 'Гомельская область' },
  ];
  assert.equal(pickSettlement(gomel, { district: 'Гомельский р-н', region: 'Гомельская обл.' }).id, 10);
  assert.equal(pickSettlement(gomel, {}).id, 10, 'без района — крупный город, если он один');
});
