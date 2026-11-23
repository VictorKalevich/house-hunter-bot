// Сбои источников и сообщения владельцу (tasks.md T075, US5). Тесты идут по порядку и делят стенд.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, criteria, fixture, HOUR, kufarAd, MEMBER, MINUTE, OWNER } from './harness.mjs';

let h;
const realtAlerts = () => h.sent(OWNER.id).filter((c) => c.params.text.startsWith('realt.by'));
const realtPages = () => h.siteRequests('realt.by').filter((r) => !r.url.endsWith('/robots.txt'));
const realtState = () => h.first('SELECT * FROM sources WHERE id = ?', 'realt');

before(async () => {
  h = await createHarness({ only: ['kufar', 'realt'] });
  await h.addMember(MEMBER);
  const res = await h.api(MEMBER, 'POST', '/searches', criteria({ priceUsd: { min: null, max: 100_000 } }));
  assert.equal(res.status, 201);
  h.kufarAds = [kufarAd({ priceUsd: 50_000 })];
  await h.ticks(4);
  assert.equal((await realtState()).state, 'ok');
});
after(() => h?.close());

test('3 × 503 → одно сообщение владельцу, дальнейшие сбои — без новых; kufar в это время присылает уведомления', async () => {
  h.sites.set('realt.by', (url) => (url.pathname === '/robots.txt' ? null : new Response('Service Unavailable', { status: 503 })));
  await h.pollNow('realt');
  await h.ticks(2);
  assert.equal(realtAlerts().length, 0, 'после двух сбоев ещё молчим');
  h.kufarAds = [kufarAd({ priceUsd: 60_000 }), ...h.kufarAds];
  await h.pollNow('kufar');
  await h.tick();
  const alerts = realtAlerts();
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].params.text, /^realt\.by не отвечает с .+: 503 Service Unavailable \(3 проверки подряд\)\. Остальные сайты работают\.$/);
  assert.deepEqual(alerts[0].params.reply_markup.inline_keyboard[0][0], { text: 'Проверить сейчас', callback_data: 'probe:realt' });
  assert.equal((await realtState()).state, 'failing');

  await h.ticks(6);
  assert.ok((await realtState()).consecutive_failures >= 5);
  assert.equal(realtAlerts().length, 1);
  assert.equal(h.sent(MEMBER.id).length, 1, 'уведомление с kufar пришло, несмотря на сбой realt');
});

test('затем 200 → «снова работает» после 3 успешных запросов подряд', async () => {
  h.sites.delete('realt.by');
  await h.pollNow('realt');
  await h.ticks(2);
  assert.equal(realtAlerts().length, 1, 'после двух успешных запросов сбой ещё не закрыт');
  assert.equal((await realtState()).state, 'ok');
  await h.tick();
  const alerts = realtAlerts();
  assert.equal(alerts.length, 2);
  assert.match(alerts[1].params.text, /^realt\.by снова работает\. Сбой длился \d+ мин\.$/);
  const src = await realtState();
  assert.equal(src.state, 'ok');
  assert.equal(src.alerted_at, null);
});

test('страница защиты → сообщение сразу и проверки через 1, 2, 4 ч', async () => {
  h.sites.set('realt.by', (url) => (url.pathname === '/robots.txt' ? null
    : new Response(fixture('realt/blocked.html'), { status: 403, headers: { 'content-type': 'text/html' } })));
  await h.pollNow('realt');
  await h.tick(2 * MINUTE);
  const start = realtPages().length;
  const t0 = h.now;
  const alerts = realtAlerts();
  assert.equal(alerts.length, 3);
  assert.match(alerts[2].params.text, /^realt\.by отказал боту с .+\. Обходить защиту бот не будет; следующая проверка через 1 ч, дальше реже\.$/);
  assert.equal((await realtState()).state, 'blocked');

  for (let i = 0; i < 8 * 12; i++) await h.tick(5 * MINUTE);
  const checks = realtPages().slice(start - 1).map((r) => (r.at - t0) / HOUR);
  assert.deepEqual(checks, [0, 1, 3, 7]);
  assert.equal(realtAlerts().length, 3, 'за весь сбой одно сообщение');
  assert.equal((await realtState()).backoff_level, 4);
});

test('кнопка «Проверить сейчас» → внеочередная проверка в ближайший тик', async () => {
  h.sites.delete('realt.by');
  const before = realtPages().length;
  const res = await h.callback(OWNER, 'probe:realt');
  assert.equal(res.status, 200);
  const answer = h.sent(undefined, 'answerCallbackQuery').at(-1);
  assert.equal(answer.params.text, 'Проверю в течение минуты.');
  await h.tick();
  assert.equal(realtPages().length, before + 1);
  assert.equal((await realtState()).state, 'ok');
  await h.ticks(2);
  assert.match(realtAlerts().at(-1).params.text, /^realt\.by снова работает\./);
});

test('423 Locked без признаков защиты в теле — тоже отказ защиты: сообщение сразу, проверка через час', async () => {
  h.sites.set('realt.by', (url) => (url.pathname === '/robots.txt' ? null : new Response('Locked', { status: 423 })));
  const alertsBefore = realtAlerts().length;
  await h.pollNow('realt');
  await h.tick(2 * MINUTE);
  const t0 = h.now;
  const start = realtPages().length;
  const src = await realtState();
  assert.equal(src.state, 'blocked');
  assert.equal(src.error_text, '423, страница защиты от ботов');
  assert.equal(src.next_check_at, t0 + HOUR);
  assert.equal(realtAlerts().length, alertsBefore + 1, 'сообщение с первого отказа');
  assert.match(realtAlerts().at(-1).params.text, /^realt\.by отказал боту с .+ \(423, страница защиты от ботов\)\. Обходить защиту бот не будет; следующая проверка через 1 ч, дальше реже\.$/);

  for (let i = 0; i < 11; i++) await h.tick(5 * MINUTE);
  assert.equal(realtPages().length, start, 'за час к сайту не обращались');
  await h.tick(HOUR - (h.now - t0));
  assert.equal(realtPages().length, start + 1);
  assert.equal(realtAlerts().length, alertsBefore + 1, 'за весь сбой одно сообщение');

  h.sites.delete('realt.by');
  await h.callback(OWNER, 'probe:realt');
  await h.ticks(3);
  assert.match(realtAlerts().at(-1).params.text, /^realt\.by снова работает\./);
  assert.equal((await realtState()).alerted_at, null);
});

test('сайт пропускает один запрос в час и снова отказывает — сбой не закрыт, новых сообщений нет', async () => {
  let pass = 0;
  h.sites.set('realt.by', (url) => (url.pathname === '/robots.txt' || pass-- > 0 ? null
    : new Response(fixture('realt/blocked.html'), { status: 403, headers: { 'content-type': 'text/html' } })));
  const alertsBefore = realtAlerts().length;
  await h.pollNow('realt');
  await h.tick(2 * MINUTE);
  const t0 = h.now;
  assert.equal((await realtState()).state, 'blocked');
  assert.equal(realtAlerts().length, alertsBefore + 1);

  for (let hour = 1; hour <= 3; hour++) {
    const pages = realtPages().length;
    pass = 1;
    const src = await realtState();
    await h.tick(src.next_check_at - h.now);
    assert.equal((await realtState()).state, 'ok', `час ${hour}: запрос прошёл`);
    await h.tick();
    const after = await realtState();
    assert.equal(after.state, 'blocked', `час ${hour}: снова отказ`);
    assert.equal(after.failing_since, t0, 'сбой тот же — начало не сдвинулось');
    assert.equal(after.next_check_at, h.now + HOUR, 'после пропуска проверки снова через час');
    assert.equal(realtPages().length, pages + 2);
  }
  assert.equal(realtAlerts().length, alertsBefore + 1, 'за весь сбой одно сообщение, без «снова работает»');

  h.sites.delete('realt.by');
  await h.callback(OWNER, 'probe:realt');
  await h.ticks(2);
  assert.equal(realtAlerts().length, alertsBefore + 1, 'два успешных запроса — сбой ещё не закрыт');
  await h.tick();
  assert.equal(realtAlerts().length, alertsBefore + 2);
  assert.match(realtAlerts().at(-1).params.text, /^realt\.by снова работает\. Сбой длился 3 ч( \d+ мин)?\.$/);
  const src = await realtState();
  assert.equal(src.alerted_at, null);
  assert.equal(src.failing_since, null);
});

test('robots.txt закрыл адрес → disallowed и сообщение; к лентам больше не обращаемся', async () => {
  h.sites.set('realt.by', (url) => (url.pathname === '/robots.txt' ? new Response('User-agent: *\nDisallow: /sale/\n', { status: 200 }) : null));
  const daily = await h.daily(MINUTE);
  assert.ok(daily.steps.robots.some((r) => r.source === 'realt' && r.result === 'disallowed'), JSON.stringify(daily.steps.robots));
  const src = await realtState();
  assert.equal(src.state, 'disallowed');
  assert.match(realtAlerts().at(-1).params.text, /^realt\.by: адреса лент закрыты в robots\.txt с .+ \(закрыт [^)]*\/sale\/[^)]*\)\. Бот перестал опрашивать сайт/);
  const pages = realtPages().length;
  await h.pollNow('realt');
  await h.ticks(5);
  assert.equal(realtPages().length, pages);
});

test('кнопка «Источники» — состояние сайтов и «Проверить сейчас» у неработающих', async () => {
  await h.callback(OWNER, 'src');
  const msg = h.sent(OWNER.id).at(-1).params;
  assert.match(msg.text, /kufar\.by — работает, проверен \d\d:\d\d/);
  assert.match(msg.text, /realt\.by — .+robots/);
  assert.deepEqual(msg.reply_markup.inline_keyboard, [[{ text: 'Проверить сейчас: realt.by', callback_data: 'probe:realt' }]]);
});
