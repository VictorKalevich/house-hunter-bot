// Проверка условий поиска (specs/002-search-ux-improvements/contracts/miniapp-api.md «Правила проверки»).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCriteria } from '../../src/match/validate.js';

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
