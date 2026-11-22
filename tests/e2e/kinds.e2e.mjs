// Тип объекта: фильтр, первое слово уведомления, дозаполнение (specs/002-search-ux-improvements/tasks.md T011, US1).
// Тесты идут по порядку и делят стенд.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, criteria, kufarAd, MEMBER } from './harness.mjs';

let h;
let searchId;
let ads;

/** Новая лента kufar → опрос в ближайшем тике; следующие тики отбирают и доставляют. */
async function circle(list, extraTicks = 2) {
  h.kufarAds = list;
  await h.pollNow('kufar');
  await h.tick();
  for (let i = 0; i < extraTicks; i++) await h.tick();
}

const listed = async (id) => {
  const res = await h.api(MEMBER, 'GET', `/searches/${id}/listings?page=1`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};

before(async () => {
  h = await createHarness({ only: ['kufar'] });
  await h.addMember(MEMBER);
});
after(() => h?.close());

test('поиск без типов — все три; пустой список типов → 422; порядок групп постоянный', async () => {
  const all = await h.api(MEMBER, 'POST', '/searches', criteria({ priceUsd: { min: null, max: 100_000 } }));
  assert.equal(all.status, 201, JSON.stringify(all.body));
  assert.deepEqual(all.body.criteria.kinds, ['house', 'dacha', 'part']);
  assert.equal((await h.api(MEMBER, 'DELETE', `/searches/${all.body.id}`)).status, 204);

  const none = await h.api(MEMBER, 'POST', '/searches', criteria({ kinds: [] }));
  assert.equal(none.status, 422);
  assert.equal(none.body.error.fields.kinds, 'Выберите хотя бы один тип');

  const res = await h.api(MEMBER, 'POST', '/searches', criteria({ priceUsd: { min: null, max: 100_000 }, kinds: ['part', 'house'] }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual(res.body.criteria.kinds, ['house', 'part']);
  searchId = res.body.id;
});

test('первый круг ленты — уведомлений нет', async () => {
  h.kufarAds = [kufarAd({ priceUsd: 50_000 })];
  await h.ticks(3);
  assert.equal(h.sent(MEMBER.id).length, 0);
});

test('новые дом, дача и полдома → два сообщения, «Дом · » и «Часть дома · »; дачи нет и в списке', async () => {
  ads = {
    house: kufarAd({ priceUsd: 60_000, kind: '1' }),
    dacha: kufarAd({ priceUsd: 45_000, kind: '10' }),
    part: kufarAd({ priceUsd: 40_000, kind: '15' }),
  };
  await circle([ads.house, ads.dacha, ads.part, ...h.kufarAds]);
  const texts = h.sent(MEMBER.id).map((c) => c.params.text);
  assert.equal(texts.length, 2, texts.join('\n---\n'));
  assert.ok(texts.some((t) => t.startsWith('Дом · <b>60 000 $</b> · дом 100 м² · участок 15 сот.')), texts.join('\n---\n'));
  assert.ok(texts.some((t) => t.startsWith('Часть дома · <b>40 000 $</b>')), texts.join('\n---\n'));
  assert.deepEqual((await h.all('SELECT DISTINCT kind FROM listings ORDER BY kind')).map((r) => r.kind), ['dacha', 'house', 'part']);

  const list = await listed(searchId);
  const urls = list.items.map((i) => i.url);
  assert.ok(!urls.includes(ads.dacha.ad_link), 'дачи нет в списке');
  assert.ok(urls.includes(ads.house.ad_link));
  assert.equal(list.items.find((i) => i.url === ads.part.ad_link).kind, 'part');
});

test('объявление без типа (записано до фичи) — в списке без типа; после следующего круга тип записан и фильтр работает', async () => {
  await h.db.prepare('UPDATE listings SET kind = NULL WHERE external_id = ?').bind(String(ads.dacha.ad_id)).run();
  const before = await listed(searchId);
  const unknown = before.items.find((i) => i.url === ads.dacha.ad_link);
  assert.ok(unknown, 'объявление с неизвестным типом не отсекается');
  assert.equal(unknown.kind, null);

  await circle(h.kufarAds, 1);
  assert.equal((await h.first('SELECT kind FROM listings WHERE external_id = ?', String(ads.dacha.ad_id))).kind, 'dacha');
  const after = await listed(searchId);
  assert.ok(!after.items.some((i) => i.url === ads.dacha.ad_link));
  assert.equal(h.sent(MEMBER.id).length, 2, 'повторных сообщений нет');
});
