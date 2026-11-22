// Управление поисками (tasks.md T070, US4): пауза, включение, два поиска — одно сообщение, удаление, сайты, 422, 404.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, criteria, kufarAd, MEMBER, MEMBER2, PLACES } from './harness.mjs';

let h;
const ids = {};
const price = (max) => criteria({ priceUsd: { min: null, max } });

async function circle(ads) {
  h.kufarAds = [...ads, ...h.kufarAds];
  await h.pollNow('kufar');
  await h.ticks(2);
}

async function create(c) {
  const res = await h.api(MEMBER, 'POST', '/searches', c);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

before(async () => {
  h = await createHarness({ only: ['kufar'] });
  await h.addMember(MEMBER);
  await h.addMember(MEMBER2);
  h.kufarAds = [kufarAd({ priceUsd: 50_000 })];
  await h.ticks(3);
  ids.a = (await create(price(100_000))).id;
  ids.b = (await create(price(90_000))).id;
});
after(() => h?.close());

test('объявление под два активных поиска → одно сообщение с обоими (FR-013)', async () => {
  await circle([kufarAd({ priceUsd: 80_000 })]);
  const sent = h.sent(MEMBER.id);
  assert.equal(sent.length, 1);
  assert.match(sent[0].params.text, /Поиски: «Любое место · до 100 000 \$», «Любое место · до 90 000 \$»/);
  const n = await h.first('SELECT search_ids FROM notifications');
  assert.deepEqual(JSON.parse(n.search_ids).sort(), [ids.a, ids.b].sort());
});

let seenWhilePaused;
test('пауза → сообщения нет', async () => {
  for (const id of [ids.a, ids.b]) {
    const res = await h.api(MEMBER, 'POST', `/searches/${id}/pause`);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'paused');
  }
  seenWhilePaused = kufarAd({ priceUsd: 70_000 });
  await circle([seenWhilePaused]);
  assert.equal(h.sent(MEMBER.id).length, 1);
});

test('включение → только объявления после включения (searches.active_since)', async () => {
  const before = (await h.first('SELECT active_since FROM searches WHERE id = ?', ids.a)).active_since;
  const res = await h.api(MEMBER, 'POST', `/searches/${ids.a}/resume`);
  assert.equal(res.body.status, 'active');
  const since = (await h.first('SELECT active_since FROM searches WHERE id = ?', ids.a)).active_since;
  assert.ok(since > before);

  // Объявление, замеченное во время паузы, всё ещё в ленте — о нём не пишем; новое — пишем.
  const fresh = kufarAd({ priceUsd: 60_000 });
  await circle([fresh]);
  const sent = h.sent(MEMBER.id);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].params.reply_markup.inline_keyboard[0][0].url, `https://re.kufar.by/vi/${fresh.ad_id}`);
  assert.match(sent[1].params.text, /Поиск: «Любое место · до 100 000 \$»$/m);
});

test('выбранные сайты соблюдаются', async () => {
  ids.realtOnly = (await create(criteria({ sources: ['realt'] }))).id;
  await circle([kufarAd({ priceUsd: 65_000 })]);
  const sent = h.sent(MEMBER.id);
  assert.equal(sent.length, 3);
  assert.doesNotMatch(sent[2].params.text, /Поиски:/);
  const n = await h.first('SELECT search_ids FROM notifications ORDER BY id DESC LIMIT 1');
  assert.deepEqual(JSON.parse(n.search_ids), [ids.a]);
});

test('изменение условий: active_since не меняется, заголовок пересобирается; неверные условия → 422', async () => {
  const since = (await h.first('SELECT active_since FROM searches WHERE id = ?', ids.a)).active_since;
  const ok = await h.api(MEMBER, 'PUT', `/searches/${ids.a}`, price(95_000));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.title, 'Любое место · до 95 000 $');
  assert.equal((await h.first('SELECT active_since FROM searches WHERE id = ?', ids.a)).active_since, since);

  const bad = await h.api(MEMBER, 'PUT', `/searches/${ids.a}`, criteria({ maxKm: 30, priceUsd: { min: 90_000, max: 10_000 }, sources: [] }));
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, 'invalid');
  assert.deepEqual(Object.keys(bad.body.error.fields).sort(), ['priceUsd', 'settlementId', 'sources']);
  const missing = await h.api(MEMBER, 'PUT', `/searches/${ids.a}`, criteria({ settlementId: 999, maxKm: 10 }));
  assert.equal(missing.status, 422);
  assert.ok(missing.body.error.fields.settlementId);
  assert.equal((await h.first('SELECT price_max_usd FROM searches WHERE id = ?', ids.a)).price_max_usd, 95_000);
});

test('пункт без расстояния → 422 у расстояния, поиск не изменился (фича 002, FR-008)', async () => {
  const post = await h.api(MEMBER, 'POST', '/searches', criteria({ settlementId: PLACES.minsk.id }));
  assert.equal(post.status, 422);
  assert.equal(post.body.error.fields.maxKm, 'Укажите расстояние или очистите населённый пункт');
  const put = await h.api(MEMBER, 'PUT', `/searches/${ids.a}`, criteria({ settlementId: PLACES.minsk.id, priceUsd: { min: null, max: 1 } }));
  assert.equal(put.status, 422);
  assert.ok(put.body.error.fields.maxKm);
  const row = await h.first('SELECT settlement_id, price_max_usd FROM searches WHERE id = ?', ids.a);
  assert.deepEqual({ ...row }, { settlement_id: null, price_max_usd: 95_000 });
});

test('копия поиска: условия из GET → POST, копия включена, исходный не изменился (фича 002, FR-016)', async () => {
  const original = (await h.api(MEMBER, 'GET', `/searches/${ids.b}`)).body;
  assert.equal(original.status, 'paused');
  const before = { ...(await h.first('SELECT * FROM searches WHERE id = ?', ids.b)) };

  const changed = { ...original.criteria, kinds: ['house'], sources: ['moyareklama'] };
  const copy = await h.api(MEMBER, 'POST', '/searches', changed);
  assert.equal(copy.status, 201, JSON.stringify(copy.body));
  ids.copy = copy.body.id;
  assert.notEqual(ids.copy, ids.b);
  assert.equal(copy.body.status, 'active', 'копия паузы — включена');
  assert.deepEqual(copy.body.criteria, changed);
  const row = await h.first('SELECT active_since, created_at FROM searches WHERE id = ?', ids.copy);
  assert.equal(row.active_since, row.created_at);
  assert.deepEqual({ ...(await h.first('SELECT * FROM searches WHERE id = ?', ids.b)) }, before);

  ids.withPlace = (await create(criteria({ settlementId: PLACES.minsk.id, maxKm: 30, kinds: ['dacha', 'part'] }))).id;
  const withPlace = (await h.api(MEMBER, 'GET', `/searches/${ids.withPlace}`)).body;
  const same = await h.api(MEMBER, 'POST', '/searches', withPlace.criteria);
  assert.equal(same.status, 201, 'условия из ответа принимаются без изменений');
  ids.copySame = same.body.id;
  assert.deepEqual(same.body.criteria, withPlace.criteria);
  assert.equal(same.body.title, withPlace.title);
  assert.deepEqual(same.body.settlement, withPlace.settlement);

  const list = (await h.api(MEMBER, 'GET', '/searches')).body.items.map((s) => s.id);
  for (const id of [ids.b, ids.copy, ids.withPlace, ids.copySame]) assert.ok(list.includes(id), String(id));
});

test('чужой поиск → 404 на все действия', async () => {
  for (const [method, path, body] of [
    ['GET', `/searches/${ids.a}`],
    ['PUT', `/searches/${ids.a}`, price(1)],
    ['POST', `/searches/${ids.a}/pause`],
    ['POST', `/searches/${ids.a}/resume`],
    ['GET', `/searches/${ids.a}/listings?page=1`],
    ['DELETE', `/searches/${ids.a}`],
  ]) {
    const res = await h.api(MEMBER2, method, path, body);
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.equal(res.body.error.code, 'not_found');
  }
  assert.equal((await h.api(MEMBER2, 'GET', '/searches')).body.items.length, 0);
  assert.equal((await h.first('SELECT status FROM searches WHERE id = ?', ids.a)).status, 'active');
});

test('удаление → 204, сообщений нет', async () => {
  for (const id of Object.values(ids)) {
    const res = await h.api(MEMBER, 'DELETE', `/searches/${id}`);
    assert.equal(res.status, 204);
  }
  assert.equal((await h.api(MEMBER, 'DELETE', `/searches/${ids.a}`)).status, 404);
  await circle([kufarAd({ priceUsd: 40_000 })]);
  assert.equal(h.sent(MEMBER.id).length, 3);
  assert.equal((await h.api(MEMBER, 'GET', '/searches')).body.items.length, 0);
});
