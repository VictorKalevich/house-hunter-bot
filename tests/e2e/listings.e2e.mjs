// Список объявлений поиска в мини-приложении (tasks.md T050, US2): ленты из сохранённых страниц kufar и realt.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm } from '../../src/geo/haversine.js';
import { inRange } from '../../src/match/criteria.js';
import { createHarness, criteria, kufarAd, MEMBER, PLACES } from './harness.mjs';

let h;

/** Все страницы списка поиска. */
async function allPages(id) {
  const first = await h.api(MEMBER, 'GET', `/searches/${id}/listings?page=1`);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const pages = [first.body];
  for (let p = 2; p <= Math.ceil(first.body.total / 5); p++) pages.push((await h.api(MEMBER, 'GET', `/searches/${id}/listings?page=${p}`)).body);
  return pages;
}

before(async () => {
  h = await createHarness({ only: ['kufar', 'realt'] });
  await h.addMember(MEMBER);
  // Первые круги всех лент kufar и realt — объявления у бота «старые» (is_new = 0).
  for (let i = 0; i < 80; i++) {
    await h.tick();
    const left = await h.first("SELECT COUNT(*) AS n FROM feeds WHERE source IN ('kufar', 'realt') AND prev_ids IS NULL");
    if (left.n === 0) break;
  }
  assert.equal((await h.first('SELECT COUNT(*) AS n FROM feeds WHERE prev_ids IS NULL AND source IN (?, ?)', 'kufar', 'realt')).n, 0);
});
after(() => h?.close());

test('без расстояния: только подходящие (в том числе старые), по 5, от новых к старым, total', async () => {
  const c = criteria({ priceUsd: { min: null, max: 60_000 }, houseM2: { min: 60, max: null } });
  const created = await h.api(MEMBER, 'POST', '/searches', c);
  assert.equal(created.status, 201);

  const rows = await h.all("SELECT url, price_usd, house_m2, plot_sotki, sort_at, is_new FROM listings WHERE source IN ('kufar', 'realt')");
  assert.ok(rows.length > 100, `объявлений из сохранённых страниц: ${rows.length}`);
  assert.ok(rows.every((r) => r.is_new === 0));
  const expected = rows.filter((r) => inRange(r.price_usd, null, 60_000) && inRange(r.house_m2, 60, null));
  assert.ok(expected.length > 10 && expected.length < rows.length);

  const pages = await allPages(created.body.id);
  assert.equal(pages[0].total, expected.length);
  assert.equal(pages[0].pageSize, 5);
  assert.equal(pages[0].totalApprox, false);
  assert.equal(pages[0].distancesPending, false);
  pages.forEach((p, i) => {
    assert.equal(p.page, i + 1);
    assert.equal(p.items.length, i < pages.length - 1 ? 5 : expected.length - 5 * (pages.length - 1));
  });
  const items = pages.flatMap((p) => p.items);
  assert.deepEqual(new Set(items.map((i) => i.url)), new Set(expected.map((r) => r.url)));
  const sortAt = new Map(rows.map((r) => [r.url, r.sort_at]));
  for (let i = 1; i < items.length; i++) assert.ok(sortAt.get(items[i - 1].url) >= sortAt.get(items[i].url), 'от новых к старым');

  const card = items[0];
  assert.deepEqual(Object.keys(card).sort(), ['createdAt', 'distance', 'houseM2', 'isNew', 'kind', 'photoUrl', 'place', 'plotSotki', 'priceByn', 'priceUsd', 'publishedAt', 'source', 'url'].sort());
  assert.ok(['house', 'cottage', 'dacha', 'part'].includes(card.kind), card.kind);
  assert.equal(card.distance, null);
  assert.ok(['kufar', 'realt'].includes(card.source));
  assert.ok(!Number.isNaN(Date.parse(card.publishedAt)));
});

test('с расстоянием по прямой: только в радиусе, расстояние в карточке', async () => {
  const created = await h.api(MEMBER, 'POST', '/searches', criteria({ settlementId: PLACES.minsk.id, maxKm: 40, sources: ['realt'] }));
  assert.equal(created.status, 201);
  const rows = await h.all("SELECT url, lat, lon FROM listings WHERE source = 'realt' AND lat IS NOT NULL");
  const inside = rows.filter((r) => haversineKm(PLACES.minsk.lat, PLACES.minsk.lon, r.lat, r.lon) <= 40.05);
  assert.ok(inside.length > 0);
  const items = (await allPages(created.body.id)).flatMap((p) => p.items);
  assert.deepEqual(new Set(items.map((i) => i.url)), new Set(inside.map((r) => r.url)));
  for (const item of items) {
    assert.equal(item.source, 'realt');
    assert.equal(item.distance.mode, 'straight');
    assert.ok(item.distance.km <= 40.05);
    assert.equal(item.distance.pending, false);
  }
});

test('page=2 — следующая пятёрка; неверная страница → 422; страница за концом — пусто', async () => {
  const { body: list } = await h.api(MEMBER, 'GET', '/searches');
  const id = list.items.at(-1).id;
  const p1 = await h.api(MEMBER, 'GET', `/searches/${id}/listings?page=1`);
  const p2 = await h.api(MEMBER, 'GET', `/searches/${id}/listings?page=2`);
  assert.equal(p2.body.page, 2);
  assert.equal(p2.body.total, p1.body.total);
  assert.ok(p2.body.items.every((i) => !p1.body.items.some((j) => j.url === i.url)));
  assert.equal((await h.api(MEMBER, 'GET', `/searches/${id}/listings?page=0`)).status, 422);
  assert.equal((await h.api(MEMBER, 'GET', `/searches/${id}/listings?page=abc`)).status, 422);
  const beyond = await h.api(MEMBER, 'GET', `/searches/${id}/listings?page=999`);
  assert.equal(beyond.status, 200);
  assert.deepEqual(beyond.body.items, []);
});

test('ничего не подходит → total: 0', async () => {
  // Неуказанная цена условие не отсекает, поэтому пусто — по сайту, с которого объявлений нет.
  const created = await h.api(MEMBER, 'POST', '/searches', criteria({ sources: ['moyareklama'] }));
  const res = await h.api(MEMBER, 'GET', `/searches/${created.body.id}/listings?page=1`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { items: [], page: 1, pageSize: 5, total: 0, totalApprox: false, distancesPending: false });
});

test('мои поиски — новые сверху; чужой список → 404', async () => {
  const { body } = await h.api(MEMBER, 'GET', '/searches');
  assert.equal(body.items.length, 3);
  assert.ok(body.items[0].id > body.items[2].id);
  const { OWNER } = await import('./harness.mjs');
  assert.equal((await h.api(OWNER, 'GET', `/searches/${body.items[0].id}/listings?page=1`)).status, 404);
});

test('подходящих больше, чем читается за раз → totalApprox и нижняя граница (фича 002, FR-007)', async () => {
  const { LIST_MAX_ROWS } = await import('../../src/config.js');
  await h.db
    .prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
       INSERT INTO listings (source, external_id, url, kind, place_text, is_new, sort_at, first_seen_at, last_seen_at, match_state)
       SELECT 'domovita', 'bulk-' || i, 'https://domovita.by/bulk/' || i, 'house', 'д. Тестовая', 0, ?2 - i, ?2, ?2, 'done' FROM n`,
    )
    .bind(LIST_MAX_ROWS + 5, h.now)
    .run();
  const created = await h.api(MEMBER, 'POST', '/searches', criteria({ sources: ['domovita'] }));
  const res = await h.api(MEMBER, 'GET', `/searches/${created.body.id}/listings?page=1`);
  assert.equal(res.status, 200);
  assert.equal(res.body.totalApprox, true);
  assert.equal(res.body.total, LIST_MAX_ROWS);
  assert.equal(res.body.items.length, 5);
  assert.equal(res.body.distancesPending, false);
});

test('метки списка: новое на сайте и дата размещения (фича 002, US4)', async () => {
  const fresh = kufarAd({ priceUsd: 40_000 });
  h.kufarAds = [fresh];
  await h.pollNow('kufar');
  await h.ticks(2);
  const created = await h.api(MEMBER, 'POST', '/searches', criteria({ sources: ['kufar', 'realt'] }));
  const items = (await allPages(created.body.id)).flatMap((p) => p.items);

  const card = items.find((i) => i.url === fresh.ad_link);
  assert.equal(card.isNew, true, 'появилось после первого круга — новое');
  assert.equal(card.createdAt, null, 'kufar не даёт дату размещения');
  const old = items.filter((i) => i.source === 'kufar' && i.url !== fresh.ad_link);
  assert.ok(old.length > 0 && old.every((i) => i.isNew === false), 'объявления первого круга — не новые');

  const realt = items.filter((i) => i.source === 'realt');
  assert.ok(realt.some((i) => i.createdAt !== null), 'realt даёт дату размещения');
  for (const i of realt.filter((r) => r.createdAt)) assert.ok(!Number.isNaN(Date.parse(i.createdAt)));
  assert.ok(realt.every((i) => i.isNew === false));
});
