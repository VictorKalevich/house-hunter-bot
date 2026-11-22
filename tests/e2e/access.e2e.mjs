// Доступ: webhook, незнакомец, владелец, страница и API мини-приложения (tasks.md T018).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, OWNER, STRANGER } from './harness.mjs';

let h;
before(async () => {
  h = await createHarness();
});
after(() => h?.close());

test('webhook без секрета или с чужим секретом → 401, без записей в D1', async () => {
  const update = { update_id: 1, message: { message_id: 1, from: STRANGER, chat: { id: STRANGER.id, type: 'private' }, text: '/start' } };
  assert.equal((await h.webhook(update, { secret: null })).status, 401);
  assert.equal((await h.webhook(update, { secret: 'wrong-secret' })).status, 401);
  assert.equal((await h.first('SELECT COUNT(*) AS n FROM access_denials')).n, 0);
  assert.equal(h.sent().length, 0);
});

test('незнакомец → отказ; в D1 только access_denials', async () => {
  const res = await h.message(STRANGER, '/start');
  assert.equal(res.status, 200);
  const [msg] = h.sent(STRANGER.id);
  assert.match(msg.params.text, /только по приглашению/);
  assert.equal(msg.params.reply_markup, undefined);
  assert.equal(await h.first('SELECT * FROM users WHERE telegram_id = ?', STRANGER.id), null);
  const denial = await h.first('SELECT attempts FROM access_denials WHERE telegram_id = ?', STRANGER.id);
  assert.equal(denial.attempts, 1);
  await h.message(STRANGER, 'привет');
  assert.equal((await h.first('SELECT attempts FROM access_denials WHERE telegram_id = ?', STRANGER.id)).attempts, 2);
});

test('владелец → главное меню с кнопками владельца и атрибуцией', async () => {
  await h.message(OWNER, '/start');
  const [msg] = h.sent(OWNER.id);
  assert.equal(msg.params.parse_mode, 'HTML');
  assert.match(msg.params.text, /OpenStreetMap/);
  const buttons = msg.params.reply_markup.inline_keyboard.flat();
  assert.deepEqual(buttons.map((b) => b.text), ['Новый поиск', 'Мои поиски', 'Пригласить', 'Пользователи', 'Источники']);
  assert.equal(buttons[0].web_app.url, 'https://bot.e2e.test/app#/search/new');
  const owner = await h.first('SELECT role, access FROM users WHERE telegram_id = ?', OWNER.id);
  assert.deepEqual({ ...owner }, { role: 'owner', access: 'active' });
});

test('GET /app — HTML со встроенной дизайн-системой; GET /app/app.js — скрипт', async () => {
  const page = await h.fetch('/app');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal(page.headers.get('cache-control'), 'no-cache');
  const body = await page.text();
  assert.ok(!body.includes('/*@design-system*/'), 'метка дизайн-системы заменена');
  assert.match(body, /--ds-/);
  assert.match(body, /\.ds-btn/);
  assert.match(body, /telegram-web-app\.js/);
  const script = await h.fetch('/app/app.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  assert.match(await script.text(), /Authorization/);
});

test('/api/me: без подписи → 401, незнакомец с подписью → 403, владелец → 200', async () => {
  const anon = await h.api(null, 'GET', '/me');
  assert.equal(anon.status, 401);
  assert.equal(anon.body.error.code, 'unauthorized');
  const stranger = await h.api(STRANGER, 'GET', '/me');
  assert.equal(stranger.status, 403);
  assert.equal(stranger.body.error.code, 'no_access');
  const owner = await h.api(OWNER, 'GET', '/me');
  assert.equal(owner.status, 200);
  assert.deepEqual(owner.body, { firstName: OWNER.first_name, isOwner: true });
});

test('неизвестный адрес → 404', async () => {
  assert.equal((await h.fetch('/nope')).status, 404);
  assert.equal((await h.api(OWNER, 'GET', '/nope')).status, 404);
});
