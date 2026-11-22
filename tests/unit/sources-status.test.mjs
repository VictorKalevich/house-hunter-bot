// Состояние сайтов для пользователей (specs/002-search-ux-improvements/tasks.md T003, data-model.md sources).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isConfirmedFailure, userSourcesStatus } from '../../src/db/sources.js';
import { ADAPTERS, feedId } from '../../src/sources/index.js';

const T = Date.parse('2026-11-22T10:40:00Z');
const SINCE = Date.parse('2026-11-22T11:05:00Z');

const source = (id, over = {}) => ({
  id, state: 'ok', consecutive_failures: 0, error_kind: null, error_text: null, failing_since: null, last_ok_at: T, ...over,
});
const allFeeds = (lastOkAt = T) => ADAPTERS.flatMap((a) => a.feeds.map((f) => ({ id: feedId(a, f), source: a.id, last_ok_at: lastOkAt })));
const allSources = () => ADAPTERS.map((a) => source(a.id));
const stateOf = (items, id) => items.find((i) => i.id === id);

test('сбой подтверждён: защита и robots.txt — сразу, сбои — с третьего подряд', () => {
  assert.equal(isConfirmedFailure(source('realt', { state: 'blocked', consecutive_failures: 1 })), true);
  assert.equal(isConfirmedFailure(source('realt', { state: 'disallowed', consecutive_failures: 1 })), true);
  assert.equal(isConfirmedFailure(source('realt', { state: 'failing', consecutive_failures: 1 })), false);
  assert.equal(isConfirmedFailure(source('realt', { state: 'failing', consecutive_failures: 2 })), false);
  assert.equal(isConfirmedFailure(source('realt', { state: 'failing', consecutive_failures: 3 })), true);
  assert.equal(isConfirmedFailure(source('realt')), false);
  assert.equal(isConfirmedFailure(null), false);
});

test('до первого тика строк нет — все сайты «собираю», в порядке kufar, realt, domovita, moyareklama', () => {
  const items = userSourcesStatus([], [], ADAPTERS, feedId);
  assert.deepEqual(items.map((i) => i.id), ['kufar', 'realt', 'domovita', 'moyareklama']);
  assert.deepEqual(items[1], { id: 'realt', title: 'realt.by', state: 'collecting', since: null, checkedAt: null });
});

test('все ленты прочитаны — «работает» и время последней успешной проверки', () => {
  const items = userSourcesStatus(allSources(), allFeeds(), ADAPTERS, feedId);
  for (const item of items) {
    assert.equal(item.state, 'ok');
    assert.equal(item.checkedAt, '2026-11-22T10:40:00.000Z');
    assert.equal(item.since, null);
  }
});

test('лента без last_ok_at или без строки — сайт ещё «собираю»', () => {
  const realt = ADAPTERS.find((a) => a.id === 'realt');
  const unread = allFeeds().map((f) => (f.id === feedId(realt, realt.feeds[3]) ? { ...f, last_ok_at: null } : f));
  assert.equal(stateOf(userSourcesStatus(allSources(), unread, ADAPTERS, feedId), 'realt').state, 'collecting');
  assert.equal(stateOf(userSourcesStatus(allSources(), unread, ADAPTERS, feedId), 'kufar').state, 'ok');

  const missing = allFeeds().filter((f) => f.id !== feedId(realt, realt.feeds[0]));
  assert.equal(stateOf(userSourcesStatus(allSources(), missing, ADAPTERS, feedId), 'realt').state, 'collecting');
});

test('подтверждённый сбой — «не работает» с начала сбоя, даже если ленты ещё не прочитаны; подробностей нет', () => {
  const sources = allSources().map((s) => (s.id === 'realt'
    ? { ...s, state: 'failing', consecutive_failures: 3, error_kind: 'http', error_text: '503 Service Unavailable', failing_since: SINCE }
    : s));
  const items = userSourcesStatus(sources, allFeeds(null), ADAPTERS, feedId);
  assert.deepEqual(stateOf(items, 'realt'), { id: 'realt', title: 'realt.by', state: 'down', since: '2026-11-22T11:05:00.000Z', checkedAt: '2026-11-22T10:40:00.000Z' });
  assert.equal(stateOf(items, 'kufar').state, 'collecting');
  assert.ok(!JSON.stringify(items).includes('503'));

  const once = allSources().map((s) => (s.id === 'realt' ? { ...s, state: 'failing', consecutive_failures: 1, failing_since: SINCE } : s));
  assert.equal(stateOf(userSourcesStatus(once, allFeeds(), ADAPTERS, feedId), 'realt').state, 'ok');
});
