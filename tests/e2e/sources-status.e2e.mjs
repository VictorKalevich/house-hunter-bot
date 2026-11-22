// Состояние сайтов для всех пользователей (specs/002-search-ux-improvements/tasks.md T004, US6).
// Тесты идут по порядку и делят стенд.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, fixture, MEMBER, MINUTE, OWNER } from './harness.mjs';

let h;
const statusOf = async (user = MEMBER) => {
  const res = await h.api(user, 'GET', '/sources');
  assert.equal(res.status, 200);
  return Object.fromEntries(res.body.items.map((i) => [i.id, i]));
};
const realtAlerts = () => h.sent(OWNER.id).filter((c) => c.params.text.startsWith('realt.by'));
const failRealt = (response) => h.sites.set('realt.by', (url) => (url.pathname === '/robots.txt' ? null : response()));

before(async () => {
  h = await createHarness({ only: ['kufar', 'realt'] });
  await h.addMember(MEMBER);
});
after(() => h?.close());

test('до первого тика — все сайты «собираю»; без подписи — 401', async () => {
  const res = await h.api(MEMBER, 'GET', '/sources');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items.map((i) => [i.id, i.state]),
    [['kufar', 'collecting'], ['realt', 'collecting'], ['domovita', 'collecting'], ['moyareklama', 'collecting']]);
  assert.equal((await h.api(null, 'GET', '/sources')).status, 401);
});

test('первый круг всех лент закончен — «работает» и время проверки', async () => {
  for (let i = 0; i < 60 && (await statusOf()).realt.state === 'collecting'; i++) await h.tick();
  const s = await statusOf();
  assert.equal(s.kufar.state, 'ok');
  assert.equal(s.realt.state, 'ok');
  assert.equal(s.realt.since, null);
  assert.ok(Date.parse(s.realt.checkedAt) <= h.now);
  assert.equal(s.domovita.state, 'collecting', 'источник «спит» — его ленты не читались');
});

test('один сбой — «работает»; третий подряд — «не работает» в тот же тик, что сообщение владельцу', async () => {
  failRealt(() => new Response('Service Unavailable', { status: 503 }));
  await h.pollNow('realt');
  await h.tick();
  const src = await h.first('SELECT * FROM sources WHERE id = ?', 'realt');
  assert.equal(src.consecutive_failures, 1);
  assert.equal((await statusOf()).realt.state, 'ok');

  let down = null;
  for (let i = 0; i < 5 && !down; i++) {
    await h.tick();
    const s = await statusOf();
    if (s.realt.state === 'down') down = s.realt;
    else assert.equal(realtAlerts().length, 0, 'владелец не узнаёт о сбое раньше пользователей');
  }
  assert.ok(down, 'сбой стал виден пользователям');
  assert.equal(realtAlerts().length, 1, 'сообщение владельцу ушло в тот же тик');
  assert.equal(down.since, new Date(src.failing_since).toISOString());

  const raw = await h.api(MEMBER, 'GET', '/sources');
  assert.ok(!JSON.stringify(raw.body).includes('Service Unavailable'), 'подробностей сбоя пользователям нет');
  assert.deepEqual(Object.keys(raw.body.items[1]).sort(), ['checkedAt', 'id', 'since', 'state', 'title']);
  assert.deepEqual(await statusOf(OWNER), await statusOf(MEMBER));
});

test('сайт снова отвечает — «работает»', async () => {
  h.sites.delete('realt.by');
  await h.pollNow('realt');
  await h.tick();
  const s = await statusOf();
  assert.equal(s.realt.state, 'ok');
  assert.equal(s.realt.since, null);
});

test('страница защиты — «не работает» сразу', async () => {
  failRealt(() => new Response(fixture('realt/blocked.html'), { status: 403, headers: { 'content-type': 'text/html' } }));
  await h.pollNow('realt');
  await h.tick(2 * MINUTE);
  const s = await statusOf();
  assert.equal(s.realt.state, 'down');
  assert.ok(s.realt.since);
  assert.equal(s.kufar.state, 'ok');
});
