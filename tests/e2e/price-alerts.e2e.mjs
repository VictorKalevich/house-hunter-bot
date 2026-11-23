// Сообщения об изменении цены понравившегося (specs/003-listing-likes/quickstart.md §2, строки 16–20; tasks.md T036).
// Тесты идут по порядку и делят стенд.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, HOUR, kufarAd, MEMBER, OWNER, PLACES, pointNorth } from './harness.mjs';

const DAY = 24 * HOUR;
let h;
const near = pointNorth(PLACES.minsk, 12);
const AD = 1_300_000_001;
const OTHER = 1_300_000_002;
let listingId;

const priceMessages = (user) => h.sent(user.id).filter((c) => c.params.text.startsWith('Цена изменилась'));
const alertsOf = (id) => h.all('SELECT user_id, status, currency, old_price, new_price, last_error FROM price_alerts WHERE listing_id = ? ORDER BY id', id);

/** Новая выдача kufar → опрос и запись в ближайшем тике; следующий тик — отправка. */
async function circle(ads) {
  h.kufarAds = ads;
  await h.pollNow('kufar');
  await h.ticks(2);
}

const ad = (o = {}) => kufarAd({ id: AD, priceUsd: 52_000, currency: 'USD', ...near, ...o });

before(async () => {
  h = await createHarness({ only: ['kufar', 'realt'] });
  await h.addMember(MEMBER);
  h.kufarAds = [ad(), kufarAd({ id: OTHER, priceUsd: 60_000, currency: 'USD', ...near })];
  await h.ticks(4);
  listingId = (await h.first('SELECT id FROM listings WHERE external_id = ?', String(AD))).id;
  for (const user of [OWNER, MEMBER]) {
    assert.equal((await h.api(user, 'PUT', `/listings/${listingId}/mark`, { mark: 'like' })).status, 200);
  }
});
after(() => h?.close());

test('цена в выдаче 52 000 → 48 000 $ — по одному сообщению каждому, у кого лайк', async () => {
  const row = await h.first('SELECT price_amount, price_currency FROM listings WHERE id = ?', listingId);
  assert.deepEqual(row, { price_amount: 52000, price_currency: 'USD' });
  await circle([ad({ priceUsd: 48_000 }), kufarAd({ id: OTHER, priceUsd: 60_000, currency: 'USD', ...near })]);
  for (const user of [OWNER, MEMBER]) {
    const sent = priceMessages(user);
    assert.equal(sent.length, 1, String(user.id));
    assert.match(sent[0].params.text, /^Цена изменилась: было <b>52 000 \$<\/b>, стало <b>48 000 \$<\/b> \(−4 000 \$\)\n/);
    assert.match(sent[0].params.text, /kufar\.by · в понравившихся$/);
    assert.deepEqual(sent[0].params.reply_markup.inline_keyboard[1][0], { text: '♥ В понравившихся', callback_data: `ul:${listingId}` });
  }
  assert.deepEqual((await alertsOf(listingId)).map((a) => a.status), ['sent', 'sent']);

  await circle(h.kufarAds);
  assert.equal(priceMessages(OWNER).length, 1, 'та же выдача повторно — новых нет');
  assert.equal((await alertsOf(listingId)).length, 2);
});

test('курс: цена в $ та же, рубли −2 % — сообщений нет', async () => {
  await circle([ad({ priceUsd: 48_000, priceByn: 48_000 * 3 * 0.98 }), ...h.kufarAds.slice(1)]);
  assert.equal(priceMessages(OWNER).length, 1);
  assert.equal((await alertsOf(listingId)).length, 2);
});

test('без лайка изменение цены не создаёт сообщений', async () => {
  const other = (await h.first('SELECT id FROM listings WHERE external_id = ?', String(OTHER))).id;
  await circle([h.kufarAds[0], kufarAd({ id: OTHER, priceUsd: 50_000, currency: 'USD', ...near })]);
  assert.equal((await h.first('SELECT price_usd FROM listings WHERE id = ?', other)).price_usd, 50_000);
  assert.deepEqual(await alertsOf(other), []);
});

test('лайк снят до отправки → cancelled, sendMessage нет', async () => {
  await h.db
    .prepare(`INSERT INTO price_alerts (user_id, listing_id, currency, old_price, new_price, created_at)
              VALUES (?, ?, 'USD', 48000, 45000, ?)`)
    .bind(MEMBER.id, listingId, h.now)
    .run();
  await h.api(MEMBER, 'PUT', `/listings/${listingId}/mark`, { mark: null });
  const before = priceMessages(MEMBER).length;
  await h.tick();
  assert.equal(priceMessages(MEMBER).length, before);
  const last = (await alertsOf(listingId)).at(-1);
  assert.deepEqual([last.status, last.last_error], ['cancelled', 'лайк снят']);
});

test('цена стала «договорной» — сообщения нет', async () => {
  await circle([ad({ priceUsd: null }), ...h.kufarAds.slice(1)]);
  assert.equal((await h.first('SELECT price_usd FROM listings WHERE id = ?', listingId)).price_usd, null);
  assert.equal(priceMessages(OWNER).length, 1);
});

test('цена со страницы при суточной проверке realt — одно сообщение', async () => {
  const code = '9200001';
  const url = `https://realt.by/brest-region/sale-cottages/object/${code}/`;
  const { id } = await h.db
    .prepare(
      `INSERT INTO listings (source, external_id, url, price_usd, price_byn, price_amount, price_currency, house_m2,
         plot_sotki, lat, lon, place_text, is_new, sort_at, first_seen_at, last_seen_at, match_state)
       VALUES ('realt', ?, ?, 52000, 156000, 52000, 'USD', 90, 12, 52.1, 23.7, 'д. Тестовая', 0, ?, ?, ?, 'done') RETURNING id`,
    )
    .bind(code, url, h.now - 3 * DAY, h.now - 3 * DAY, h.now - 2 * DAY)
    .first();
  await h.api(OWNER, 'PUT', `/listings/${id}/mark`, { mark: 'like' });
  const object = { code: Number(code), price: 50000, priceCurrency: 840, priceRates: { 840: 50000, 933: 150000 }, areaTotal: 90, areaLand: 12, archive: 0 };
  h.sites.set('realt.by', (u) => (u.href === url
    ? new Response(`<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { object } } })}</script></body></html>`)
    : null));
  await h.db.prepare("UPDATE sources SET cards_next_at = NULL WHERE id = 'realt'").run();
  const before = priceMessages(OWNER).length;
  for (let i = 0; i < 10 && priceMessages(OWNER).length === before; i++) await h.tick();
  const sent = priceMessages(OWNER).slice(before);
  assert.equal(sent.length, 1);
  assert.match(sent[0].params.text, /^Цена изменилась: было <b>52 000 \$<\/b>, стало <b>50 000 \$<\/b> \(−2 000 \$\)\n/);
  assert.match(sent[0].params.text, /realt\.by · в понравившихся$/);
  const row = await h.first('SELECT price_amount, price_usd, check_ok_at FROM listings WHERE id = ?', id);
  assert.equal(row.price_amount, 50000);
  assert.equal(row.price_usd, 50000);
  assert.ok(row.check_ok_at);
});
