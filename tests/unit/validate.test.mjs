// Проверка условий поиска (specs/002-search-ux-improvements/contracts/miniapp-api.md «Правила проверки»).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTitle, validateCriteria } from '../../src/match/validate.js';

const body = (over = {}) => ({
  settlementId: null, distanceMode: 'straight', maxKm: null,
  priceUsd: { min: null, max: 80000 }, houseM2: { min: null, max: null }, plotSotki: { min: null, max: null },
  sources: ['kufar', 'realt', 'domovita', 'moyareklama'],
  ...over,
});

test('типы: нет поля — все три группы; порядок постоянный', () => {
  assert.deepEqual(validateCriteria(body()).criteria.kinds, ['house', 'dacha', 'part']);
  assert.deepEqual(validateCriteria(body({ kinds: null })).criteria.kinds, ['house', 'dacha', 'part']);
  assert.deepEqual(validateCriteria(body({ kinds: ['part', 'house'] })).criteria.kinds, ['house', 'part']);
  assert.deepEqual(validateCriteria(body({ kinds: ['dacha'] })).criteria.kinds, ['dacha']);
});

test('типы: пусто, не список или неизвестная группа — ошибка у типов', () => {
  for (const kinds of [[], 'house', ['house', 'flat'], ['cottage']]) {
    const r = validateCriteria(body({ kinds }));
    assert.equal(r.criteria, null, JSON.stringify(kinds));
    assert.equal(r.fields.kinds, 'Выберите хотя бы один тип');
  }
});

test('населённый пункт без расстояния — ошибка у расстояния; неверный пункт — ошибка у пункта (FR-008)', () => {
  const r = validateCriteria(body({ settlementId: 104649860 }));
  assert.equal(r.criteria, null);
  assert.equal(r.fields.maxKm, 'Укажите расстояние или очистите населённый пункт');
  assert.equal(validateCriteria(body({ settlementId: 104649860, maxKm: 30 })).criteria.maxKm, 30);
  assert.ok(validateCriteria(body()).criteria, 'без пункта и без расстояния — можно');
  const wrong = validateCriteria(body({ settlementId: 'Минск' }));
  assert.ok(wrong.fields.settlementId);
  assert.equal(wrong.fields.maxKm, undefined);
  assert.ok(validateCriteria(body({ maxKm: 30 })).fields.settlementId, 'расстояние без пункта — по-прежнему ошибка');
});

test('название: способ подписан так же, как в форме и уведомлениях (FR-010)', () => {
  const minsk = { name: 'Минск' };
  const c = (over) => validateCriteria(body({ settlementId: 1, maxKm: 30, ...over })).criteria;
  assert.equal(buildTitle(c({ distanceMode: 'road_center' }), minsk), 'Минск · до 30 км по дороге от центра');
  assert.equal(buildTitle(c({ distanceMode: 'road_exit' }), minsk), 'Минск · до 30 км по дороге от выезда');
  assert.equal(buildTitle(c({ distanceMode: 'straight' }), minsk), 'Минск · до 30 км по прямой');
  assert.equal(buildTitle(validateCriteria(body()).criteria, null), 'Любое место · до 80 000 $');
});
