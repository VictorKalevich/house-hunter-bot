import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from '../../src/telegram/html.js';
import { parseTelegramResponse } from '../../src/telegram/api.js';

test('экранирование для parse_mode: HTML', () => {
  assert.equal(escapeHtml('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(5), '5');
});

test('разбор ответа Bot API: ok, ошибка, retry_after, не JSON', () => {
  assert.deepEqual(parseTelegramResponse(200, '{"ok":true,"result":{"message_id":1}}'),
    { ok: true, status: 200, result: { message_id: 1 }, errorCode: null, description: null, retryAfter: null });
  const r429 = parseTelegramResponse(429, '{"ok":false,"error_code":429,"description":"Too Many Requests: retry after 7","parameters":{"retry_after":7}}');
  assert.equal(r429.ok, false);
  assert.equal(r429.errorCode, 429);
  assert.equal(r429.retryAfter, 7);
  const r403 = parseTelegramResponse(403, '{"ok":false,"error_code":403,"description":"Forbidden: bot was blocked by the user"}');
  assert.equal(r403.errorCode, 403);
  const bad = parseTelegramResponse(502, '<html>Bad Gateway</html>');
  assert.deepEqual([bad.ok, bad.errorCode, bad.description], [false, 502, 'HTTP 502']);
});
