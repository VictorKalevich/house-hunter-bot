// Суточная проверка страниц понравившихся объявлений realt.by (specs/003-listing-likes/quickstart.md §2, строки 10–15;
// tasks.md T023). Тесты идут по порядку и делят стенд.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, HOUR, MEMBER, MINUTE, OWNER } from './harness.mjs';

const DAY = 24 * HOUR;
let h;
let codeSeq = 9_100_000;
/** Ответы страниц объявлений по коду: число — статус, объект — поля pageProps.object. */
const cards = new Map();

const cardUrl = (code) => `https://realt.by/brest-region/sale-cottages/object/${code}/`;
const cardHits = (code) => h.siteRequests('realt.by').filter((r) => r.url === cardUrl(code));
const row = (id) => h.first('SELECT checked_at, check_ok_at, gone_at, last_seen_at, price_usd FROM listings WHERE id = ?', id);
const realtAlerts = () => h.sent(OWNER.id).filter((c) => c.params.text.startsWith('realt.by'));

function nextData(data) {
  const json = JSON.stringify(data).replaceAll('<', '\\u003c');
  return `<!DOCTYPE html><html><body><script id="__NEXT_DATA__" type="application/json">${json}</script></body></html>`;
}

const cardObject = (code, o = {}) => ({
  code, category: 11, objectType: 'дом', price: 52000, priceCurrency: 840, priceRates: { 840: 52000, 933: 156000 },
  areaTotal: 90, areaLand: 12, status: 0, archive: 0, ...o,
});

/** Объект выдачи realt (раздел «дома»), чтобы объявление снова появилось в выдаче. */
const feedObject = (code) => ({
  ...cardObject(code), objectType: 1, stateRegionName: 'Брестская область', townName: 'Тестовая', townType: 3,
  location: [23.7, 52.1], updatedAt: '2026-11-20T10:00:00+03:00', createdAt: '2026-10-01T10:00:00+03:00', images: [],
});

/** Понравившееся объявление realt, которого сутки нет в выдаче. */
async function likedListing(users = [MEMBER], o = {}) {
  const code = String(++codeSeq);
  const r = await h.db
    .prepare(
      `INSERT INTO listings (source, external_id, url, price_usd, price_byn, price_amount, price_currency, house_m2,
         plot_sotki, lat, lon, place_text, is_new, sort_at, first_seen_at, last_seen_at, match_state)
       VALUES ('realt', ?, ?, 52000, 156000, 52000, 'USD', 90, 12, 52.1, 23.7, 'д. Тестовая', 0, ?, ?, ?, 'done') RETURNING id`,
    )
    .bind(code, cardUrl(code), h.now - 3 * DAY, h.now - 3 * DAY, o.lastSeenAt ?? h.now - 2 * DAY)
    .first();
  for (const user of users) {
    const put = await h.api(user, 'PUT', `/listings/${r.id}/mark`, { mark: 'like' });
    assert.equal(put.status, 200, JSON.stringify(put.body));
  }
  // Как будто прошёл час простоя: поиск «кого проверять» отложен на CARD_IDLE_MS после пустого поиска.
  await h.db.prepare("UPDATE sources SET cards_next_at = NULL WHERE id = 'realt'").run();
  return { id: r.id, code };
}

async function tickUntil(done, max = 12) {
  for (let i = 0; i < max; i++) {
    await h.tick();
    if (await done()) return;
  }
  assert.fail('условие не наступило');
}

const unblock = () => h.db
  .prepare(`UPDATE sources SET state = 'ok', next_check_at = NULL, backoff_level = 0, consecutive_failures = 0,
    error_kind = NULL, error_text = NULL, failing_since = NULL, alerted_at = NULL WHERE id = 'realt'`)
  .run();

before(async () => {
  h = await createHarness({ only: ['realt'] });
  await h.addMember(MEMBER);
  h.sites.set('realt.by', (url) => {
    const m = /\/object\/(\d+)\/$/.exec(url.pathname);
    if (!m) return h.realtFeed?.(url) ?? null;
    const answer = cards.get(m[1]) ?? { status: 404 };
    if (answer.status) return new Response('нет', { status: answer.status });
    return new Response(nextData({ props: { pageProps: { object: answer } }, page: '/[...slug]' }), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  });
  await h.ticks(2);
});
after(() => h?.close());

let present;
test('страница на месте: одна проверка, check_ok_at; к realt.by не больше запроса в минуту', async () => {
  present = await likedListing();
  cards.set(present.code, cardObject(present.code));
  await tickUntil(async () => cardHits(present.code).length > 0);
  const r = await row(present.id);
  assert.equal(r.checked_at, h.now);
  assert.equal(r.check_ok_at, h.now);
  assert.equal(r.gone_at, null);
  assert.ok(r.last_seen_at < h.now - DAY, 'проверка страницы не трогает «в выдаче»');
  const src = await h.first("SELECT cards_next_at FROM sources WHERE id = 'realt'");
  assert.equal(src.cards_next_at, h.now + 3 * MINUTE);

  await h.ticks(5);
  assert.equal(cardHits(present.code).length, 1, 'не чаще раза в сутки');
  const perMinute = new Map();
  for (const r2 of h.siteRequests('realt.by')) perMinute.set(r2.at, (perMinute.get(r2.at) ?? 0) + 1);
  assert.ok([...perMinute.values()].every((n) => n <= 1));
});

let removed;
test('404 → «снято»: siteStatus gone, дом остаётся в понравившихся', async () => {
  removed = await likedListing();
  await tickUntil(async () => cardHits(removed.code).length > 0);
  assert.equal((await row(removed.id)).gone_at, h.now);
  const marks = await h.api(MEMBER, 'GET', '/marks?kind=like');
  const card = marks.body.items.find((c) => c.id === removed.id);
  assert.deepEqual(card.siteStatus, { kind: 'gone', at: new Date(h.now).toISOString() });
});

test('объявление снова в выдаче → пометка «снято» снимается', async () => {
  h.realtFeed = (url) => (url.pathname.includes('/cottages/')
    ? new Response(nextData({ props: { pageProps: { objects: [feedObject(Number(removed.code))], objectsCategory: 11, pagination: { totalCount: 1 } } } }), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
    : null);
  await h.pollNow('realt');
  await tickUntil(async () => (await row(removed.id)).gone_at === null, 6);
  assert.ok((await row(removed.id)).last_seen_at >= h.now - 6 * MINUTE);
  h.realtFeed = null;
});

test('403 на странице → не «снято», источник blocked, одно сообщение владельцу', async () => {
  const blocked = await likedListing();
  cards.set(blocked.code, { status: 403 });
  const alertsBefore = realtAlerts().length;
  await tickUntil(async () => cardHits(blocked.code).length > 0);
  const r = await row(blocked.id);
  assert.equal(r.gone_at, null);
  assert.equal(r.checked_at, h.now);
  assert.equal(r.check_ok_at, null);
  assert.equal((await h.first("SELECT state FROM sources WHERE id = 'realt'")).state, 'blocked');
  assert.equal(realtAlerts().length, alertsBefore + 1);
  await h.ticks(3);
  assert.equal(cardHits(blocked.code).length, 1, 'заблокированный источник страниц не проверяет');
  await unblock();
});

test('kufar: страниц не запрашиваем; 8 суток без выдачи → «не удалось проверить»', async () => {
  const seen = h.now - 8 * DAY;
  const r = await h.db
    .prepare(
      `INSERT INTO listings (source, external_id, url, price_usd, place_text, is_new, sort_at, first_seen_at, last_seen_at, match_state)
       VALUES ('kufar', '777000111', 'https://re.kufar.by/vi/777000111', 50000, 'д. Тестовая', 0, ?, ?, ?, 'done') RETURNING id`,
    )
    .bind(seen, seen, seen)
    .first();
  await h.api(MEMBER, 'PUT', `/listings/${r.id}/mark`, { mark: 'like' });
  await h.ticks(4);
  assert.equal(h.siteRequests('re.kufar.by').filter((x) => !x.url.endsWith('/robots.txt')).length, 0);
  const card = (await h.api(MEMBER, 'GET', '/marks?kind=like')).body.items.find((c) => c.id === r.id);
  assert.deepEqual(card.siteStatus, { kind: 'unchecked', lastSeenAt: new Date(seen).toISOString() });
});

test('два лайка на одном доме — одна проверка; был в выдаче за сутки — не проверяем', async () => {
  const shared = await likedListing([MEMBER, OWNER]);
  cards.set(shared.code, cardObject(shared.code));
  const fresh = await likedListing([MEMBER], { lastSeenAt: h.now - HOUR });
  cards.set(fresh.code, cardObject(fresh.code));
  await tickUntil(async () => cardHits(shared.code).length > 0);
  await h.ticks(8);
  assert.equal(cardHits(shared.code).length, 1);
  assert.equal(cardHits(fresh.code).length, 0);
});

test('нечего проверять → следующий поиск страниц через час', async () => {
  await h.ticks(4);
  const { cards_next_at: next } = await h.first("SELECT cards_next_at FROM sources WHERE id = 'realt'");
  assert.ok(next > h.now + 50 * MINUTE && next <= h.now + HOUR, `${(next - h.now) / MINUTE} мин`);
});
