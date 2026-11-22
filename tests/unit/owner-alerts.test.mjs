import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { failureAlertText, plural, recoveryText, sendOwnerAlert } from '../../src/telegram/owner-alerts.js';

// 22.11 14:05 по Минску (UTC+3).
const since = Date.parse('2026-11-22T11:05:00Z');
const source = (fields) => ({
  id: 'kufar', state: 'failing', error_kind: 'http', error_text: null, failing_since: since, consecutive_failures: 3, ...fields,
});

test('http: 3 сбоя подряд — текст как в contracts/telegram-bot.md', () => {
  const text = failureAlertText(source({ error_text: '503 Service Unavailable' }));
  assert.equal(text, 'kufar.by не отвечает с 22.11 14:05: 503 Service Unavailable (3 проверки подряд). Остальные сайты работают.');
});

test('http: число проверок склоняется', () => {
  assert.match(failureAlertText(source({ error_text: 'тайм-аут 15 с', consecutive_failures: 5 })), /\(5 проверок подряд\)/);
  assert.match(failureAlertText(source({ error_text: 'тайм-аут 15 с', consecutive_failures: 21 })), /\(21 проверка подряд\)/);
});

test('parse и empty: страница не распознаётся', () => {
  const why = 'на странице нет объявлений в ожидаемом виде';
  const expected = `realt.by перестал распознаваться с 22.11 14:05: ${why}. Нужна правка разбора.`;
  assert.equal(failureAlertText(source({ id: 'realt', error_kind: 'parse', error_text: why })), expected);
  assert.equal(failureAlertText(source({ id: 'realt', error_kind: 'empty', error_text: why })), expected);
});

test('blocked: защита от ботов, обходить не будет, следующая проверка', () => {
  const row = source({ id: 'domovita', state: 'blocked', error_kind: 'blocked', error_text: '403, страница защиты от ботов' });
  assert.equal(
    failureAlertText(row),
    'domovita.by отказал боту с 22.11 14:05 (403, страница защиты от ботов). Обходить защиту бот не будет; следующая проверка через 1 ч, дальше реже.',
  );
  assert.match(failureAlertText(row, { nextCheckHours: 4 }), /следующая проверка через 4 ч/);
});

test('disallowed: адреса лент закрыты в robots.txt', () => {
  const text = failureAlertText(source({ id: 'moyareklama', state: 'disallowed', error_kind: null, error_text: 'закрыт /Гомель/дома_продажа/' }));
  assert.match(text, /^moyareklama\.by: адреса лент закрыты в robots\.txt с 22\.11 14:05 \(закрыт \/Гомель\/дома_продажа\/\)\./);
  assert.match(text, /перестал опрашивать сайт/);
});

test('нет текста ошибки — «неизвестная ошибка»', () => {
  assert.match(failureAlertText(source({ error_text: null })), /: неизвестная ошибка \(/);
});

test('восстановление: «снова работает» и длительность сбоя', () => {
  assert.equal(recoveryText('kufar', since, since + (2 * 60 + 10) * 60_000), 'kufar.by снова работает. Сбой длился 2 ч 10 мин.');
  assert.equal(recoveryText('realt', null, since), 'realt.by снова работает.');
});

test('склонение plural', () => {
  const p = (n) => plural(n, 'проверка', 'проверки', 'проверок');
  assert.deepEqual([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 112].map(p), [
    'проверка', 'проверки', 'проверки', 'проверок', 'проверок', 'проверок', 'проверок', 'проверка', 'проверки', 'проверок',
    'проверка', 'проверок',
  ]);
});

const realFetch = globalThis.fetch;
let calls = [];
function stubTelegram(reply) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply), { status: reply.ok ? 200 : (reply.error_code ?? 400) });
  };
}
afterEach(() => {
  globalThis.fetch = realFetch;
});

const env = { BOT_TOKEN: '123:abc', OWNER_TELEGRAM_ID: '777' };

test('отправка владельцу: HTML экранируется, кнопка «Проверить сейчас» → probe:<id>', async () => {
  stubTelegram({ ok: true, result: { message_id: 1 } });
  assert.equal(await sendOwnerAlert(env, 'kufar.by не отвечает: <html> & "ошибка"', 'kufar'), true);
  const [call] = calls;
  assert.equal(call.url, 'https://api.telegram.org/bot123:abc/sendMessage');
  assert.equal(call.body.chat_id, '777');
  assert.equal(call.body.parse_mode, 'HTML');
  assert.equal(call.body.text, 'kufar.by не отвечает: &lt;html&gt; &amp; "ошибка"');
  assert.deepEqual(call.body.reply_markup, { inline_keyboard: [[{ text: 'Проверить сейчас', callback_data: 'probe:kufar' }]] });
});

test('восстановление — без кнопки', async () => {
  stubTelegram({ ok: true, result: { message_id: 2 } });
  assert.equal(await sendOwnerAlert(env, 'kufar.by снова работает.'), true);
  assert.equal(calls[0].body.reply_markup, undefined);
});

test('нет владельца, ошибка Telegram или сети — false без исключения', async () => {
  stubTelegram({ ok: true, result: {} });
  assert.equal(await sendOwnerAlert({ BOT_TOKEN: '123:abc' }, 'текст', 'kufar'), false);
  assert.equal(calls.length, 0);

  stubTelegram({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' });
  assert.equal(await sendOwnerAlert(env, 'текст', 'kufar'), false);

  stubTelegram(new TypeError('fetch failed'));
  assert.equal(await sendOwnerAlert(env, 'текст', 'kufar'), false);
});
