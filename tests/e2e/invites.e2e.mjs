// Приглашения и закрытие доступа (tasks.md T080, US6). Тесты идут по порядку и делят стенд.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, criteria, kufarAd, MEMBER, MEMBER2, OWNER } from './harness.mjs';

let h;
let link;
const lastText = (chatId) => h.sent(chatId).at(-1)?.params.text;
const lastAnswer = () => h.sent(undefined, 'answerCallbackQuery').at(-1).params.text;

before(async () => {
  h = await createHarness({ only: ['kufar'] });
  await h.message(OWNER, '/start');
  h.kufarAds = [kufarAd({ priceUsd: 50_000 })];
  await h.ticks(3);
});
after(() => h?.close());

test('без приглашения → отказ', async () => {
  await h.message(MEMBER, '/start');
  assert.match(lastText(MEMBER.id), /только по приглашению/);
  assert.equal((await h.api(MEMBER, 'GET', '/me')).status, 403);
});

test('приглашение → доступ и поиск', async () => {
  await h.callback(OWNER, 'inv:new');
  const text = lastText(OWNER.id);
  link = /https:\/\/t\.me\/house_hunter_e2e_bot\?start=(inv_[A-Za-z0-9_-]{22})/.exec(text)?.[1];
  assert.ok(link, text);
  assert.ok(link.length <= 64);

  await h.message(MEMBER, `/start ${link}`);
  const welcome = h.sent(MEMBER.id).at(-1).params;
  assert.match(welcome.text, /^Добро пожаловать! Владелец пригласил вас в бота\./);
  assert.deepEqual(welcome.reply_markup.inline_keyboard.flat().map((b) => b.text), ['Новый поиск', 'Мои поиски']);
  const user = await h.first('SELECT role, access, invited_by FROM users WHERE telegram_id = ?', MEMBER.id);
  assert.deepEqual({ ...user }, { role: 'member', access: 'active', invited_by: OWNER.id });
  assert.equal((await h.first('SELECT used_by FROM invites')).used_by, MEMBER.id);

  assert.deepEqual((await h.api(MEMBER, 'GET', '/me')).body, { firstName: MEMBER.first_name, isOwner: false });
  const created = await h.api(MEMBER, 'POST', '/searches', criteria({ priceUsd: { min: null, max: 100_000 } }));
  assert.equal(created.status, 201);
});

test('«Пригласить» от участника (не владельца) → «Нет доступа»', async () => {
  await h.callback(MEMBER, 'inv:new');
  assert.equal(lastAnswer(), 'Нет доступа');
  await h.callback(MEMBER, 'users:0');
  assert.equal(lastAnswer(), 'Нет доступа');
  assert.equal((await h.first('SELECT COUNT(*) AS n FROM invites')).n, 1);
});

test('та же ссылка с другого аккаунта → отказ', async () => {
  await h.message(MEMBER2, `/start ${link}`);
  assert.match(lastText(MEMBER2.id), /уже использовано или недействительно/);
  assert.equal(await h.first('SELECT * FROM users WHERE telegram_id = ?', MEMBER2.id), null);
  assert.equal((await h.api(MEMBER2, 'GET', '/me')).status, 403);
});

test('«Пользователи»: список с кнопкой «Закрыть доступ»; себе закрыть доступ нельзя', async () => {
  await h.callback(OWNER, 'users:0');
  const msg = h.sent(OWNER.id).at(-1).params;
  assert.match(msg.text, /Владелец \(@owner_e2e\) — с \d\d\.\d\d\.\d{4} — владелец/);
  assert.match(msg.text, /Гость \(@member_e2e\) — с \d\d\.\d\d\.\d{4}/);
  assert.deepEqual(msg.reply_markup.inline_keyboard, [[{ text: 'Закрыть доступ: Гость', callback_data: `rv:${MEMBER.id}` }]]);

  await h.callback(OWNER, `rv:${OWNER.id}`);
  assert.equal(lastAnswer(), 'Себе закрыть доступ нельзя.');
  await h.callback(OWNER, `rv!:${OWNER.id}`);
  assert.equal(lastAnswer(), 'Себе закрыть доступ нельзя.');
  assert.equal((await h.first('SELECT access FROM users WHERE telegram_id = ?', OWNER.id)).access, 'active');
});

test('закрыть доступ → ожидающие уведомления undeliverable, новых нет, на сообщения — «Доступ к боту закрыт владельцем.»', async () => {
  h.kufarAds = [kufarAd({ priceUsd: 70_000 }), ...h.kufarAds];
  await h.pollNow('kufar');
  await h.tick();
  assert.equal((await h.first('SELECT status FROM notifications')).status, 'pending');

  await h.callback(OWNER, `rv:${MEMBER.id}`);
  const confirm = h.sent(OWNER.id).at(-1).params;
  assert.equal(confirm.text, 'Закрыть доступ: Гость? Поиски этого человека остановятся.');
  assert.equal(confirm.reply_markup.inline_keyboard[0][0].callback_data, `rv!:${MEMBER.id}`);
  await h.callback(OWNER, `rv!:${MEMBER.id}`);
  assert.equal(lastText(OWNER.id), 'Доступ закрыт.');
  assert.equal((await h.first('SELECT status FROM notifications')).status, 'undeliverable');

  h.kufarAds = [kufarAd({ priceUsd: 80_000 }), ...h.kufarAds];
  await h.pollNow('kufar');
  await h.ticks(2);
  assert.equal(h.sent(MEMBER.id).filter((c) => c.params.reply_markup?.inline_keyboard?.[0]?.[0]?.url).length, 0);
  assert.equal((await h.first('SELECT COUNT(*) AS n FROM notifications')).n, 1);

  await h.message(MEMBER, '/start');
  assert.equal(lastText(MEMBER.id), 'Доступ к боту закрыт владельцем.');
  assert.equal((await h.api(MEMBER, 'GET', '/me')).status, 403);
  assert.equal((await h.first('SELECT access FROM users WHERE telegram_id = ?', MEMBER.id)).access, 'revoked');
});
