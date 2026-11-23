// Понравившиеся: кнопки под уведомлением, API отметок, лимит, очистка (specs/003-listing-likes/quickstart.md §2,
// строки 1–6; tasks.md T007). Тесты идут по порядку и делят стенд.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHarness, criteria, kufarAd, MEMBER, MINUTE, nextAdId, OWNER, PLACES, pointNorth, STRANGER,
} from './harness.mjs';

const DAY = 24 * 60 * MINUTE;
let h;
const near = pointNorth(PLACES.minsk, 12);
const match = (o = {}) => kufarAd({ priceUsd: 75_000, houseM2: 100, plotSotki: 15, ...near, ...o });
const searches = [];
let likedId;

const lastCall = (method) => h.telegram.calls.filter((c) => c.method === method).at(-1);
const count = (method) => h.telegram.calls.filter((c) => c.method === method).length;
const marksOf = (user) => h.all('SELECT listing_id, kind FROM marks WHERE user_id = ? ORDER BY listing_id', user.id);

function insertListing(o = {}) {
  const ext = String(nextAdId());
  return h.db
    .prepare(
      `INSERT INTO listings (source, external_id, url, price_usd, price_byn, house_m2, plot_sotki, lat, lon, place_text,
         is_new, sort_at, first_seen_at, last_seen_at, match_state)
       VALUES ('kufar', ?, ?, 70000, 210000, 100, 15, ?, ?, 'д. Тестовая', 0, ?, ?, ?, 'done') RETURNING id`,
    )
    .bind(ext, `https://re.kufar.by/vi/${ext}`, o.lat ?? near.lat, o.lon ?? near.lon, h.now, h.now, o.lastSeenAt ?? h.now);
}

/** Объявление прямо в базе — для страниц и лимита, без кругов ленты. */
async function addListing(o = {}) {
  return (await insertListing(o).first()).id;
}

before(async () => {
  h = await createHarness({ only: ['kufar'] });
  await h.addMember(MEMBER);
});
after(() => h?.close());

test('уведомление с кнопками «♡ Нравится» и «Не интересно» → лайк кнопкой', async () => {
  for (const c of [criteria({ settlementId: PLACES.minsk.id, maxKm: 30 }), criteria({ settlementId: PLACES.minsk.id, maxKm: 40 })]) {
    const res = await h.api(OWNER, 'POST', '/searches', c);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    searches.push(res.body.id);
  }
  h.kufarAds = [match()];
  await h.ticks(3);
  const fresh = match();
  h.kufarAds = [fresh, ...h.kufarAds];
  await h.pollNow('kufar');
  await h.ticks(2);

  const sent = h.sent(OWNER.id);
  assert.equal(sent.length, 1);
  likedId = (await h.first('SELECT id FROM listings WHERE external_id = ?', String(fresh.ad_id))).id;
  assert.deepEqual(sent[0].params.reply_markup.inline_keyboard[1], [
    { text: '♡ Нравится', callback_data: `lk:${likedId}` }, { text: 'Не интересно', callback_data: `hd:${likedId}` },
  ]);

  const res = await h.callback(OWNER, `lk:${likedId}`, { messageId: 77 });
  assert.equal(res.status, 200);
  assert.equal(lastCall('answerCallbackQuery').params.text, 'Добавлено в понравившиеся');
  const edit = lastCall('editMessageReplyMarkup');
  assert.equal(String(edit.params.chat_id), String(OWNER.id));
  assert.equal(edit.params.message_id, 77);
  assert.equal(edit.params.reply_markup.inline_keyboard[0][0].url, `https://re.kufar.by/vi/${fresh.ad_id}`);
  assert.deepEqual(edit.params.reply_markup.inline_keyboard[1][0], { text: '♥ В понравившихся', callback_data: `ul:${likedId}` });

  const mine = await h.api(OWNER, 'GET', '/marks?kind=like');
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal(mine.body.total, 1);
  assert.equal(mine.body.items[0].id, likedId);
  assert.equal(mine.body.items[0].mark, 'like');
  assert.equal((await h.api(MEMBER, 'GET', '/marks?kind=like')).body.total, 0);
});

test('снять лайк, два нажатия подряд — одна строка; перерисовка не удалась — не ошибка', async () => {
  await h.callback(OWNER, `ul:${likedId}`);
  assert.equal(lastCall('answerCallbackQuery').params.text, 'Убрано из понравившихся');
  assert.deepEqual(await marksOf(OWNER), []);

  await h.callback(OWNER, `lk:${likedId}`);
  await h.callback(OWNER, `lk:${likedId}`);
  assert.deepEqual(await marksOf(OWNER), [{ listing_id: likedId, kind: 'like' }]);

  const edits = count('editMessageReplyMarkup');
  await h.callback(OWNER, `lk:${likedId}`, { date: 0 });
  assert.equal(count('editMessageReplyMarkup'), edits, 'сообщение недоступно — разметку не правим');
  assert.equal(lastCall('answerCallbackQuery').params.text, 'Добавлено в понравившиеся');

  h.telegram.respond = (call) => (call.method === 'editMessageReplyMarkup'
    ? { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: message is not modified' } }
    : null);
  const res = await h.callback(OWNER, `lk:${likedId}`);
  h.telegram.respond = null;
  assert.equal(res.status, 200);
  assert.ok(!h.logs.some((l) => l.event === 'webhook_error'), 'ответ «message is not modified» — не ошибка');
});

test('удаление обоих поисков не трогает понравившиеся', async () => {
  for (const id of searches) assert.equal((await h.api(OWNER, 'DELETE', `/searches/${id}`)).status, 204);
  const mine = await h.api(OWNER, 'GET', '/marks?kind=like');
  assert.equal(mine.body.total, 1);
  assert.equal(mine.body.items[0].id, likedId);
  assert.equal(mine.body.items[0].distance, null, 'поисков с пунктом нет — расстояния нет');
});

test('7 лайков через API — по 5 на странице, последние сверху; расстояние от пункта поиска', async () => {
  const res = await h.api(MEMBER, 'POST', '/searches', criteria({ settlementId: PLACES.minsk.id, maxKm: 30 }));
  assert.equal(res.status, 201);
  const ids = [];
  for (let i = 0; i < 7; i++) {
    const id = await addListing();
    ids.push(id);
    const put = await h.api(MEMBER, 'PUT', `/listings/${id}/mark`, { mark: 'like' });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual(put.body, { id, mark: 'like' });
  }
  const p1 = await h.api(MEMBER, 'GET', '/marks?kind=like&page=1');
  assert.equal(p1.body.total, 7);
  assert.equal(p1.body.page, 1);
  assert.equal(p1.body.pageSize, 5);
  assert.deepEqual(p1.body.items.map((c) => c.id), ids.slice(2).reverse());
  const d = p1.body.items[0].distance;
  assert.equal(d.mode, 'straight');
  assert.equal(d.from, 'Минск');
  assert.ok(Math.abs(d.km - 12) < 0.2, String(d.km));
  const p2 = await h.api(MEMBER, 'GET', '/marks?kind=like&page=2');
  assert.deepEqual(p2.body.items.map((c) => c.id), ids.slice(0, 2).reverse());

  assert.equal((await h.api(MEMBER, 'GET', '/marks?kind=liked')).status, 422);
  assert.equal((await h.api(MEMBER, 'GET', '/marks?kind=like&page=0')).status, 422);
  assert.equal((await h.api(MEMBER, 'PUT', `/listings/${ids[0]}/mark`, { mark: 'love' })).status, 422);
  assert.equal((await h.api(null, 'GET', '/marks?kind=like')).status, 401);
});

test('суточная очистка через 40 суток: дом с лайком на месте, без лайка — удалён', async () => {
  const plain = await addListing();
  await h.daily(40 * DAY);
  assert.ok(await h.first('SELECT id FROM listings WHERE id = ?', likedId), 'понравившийся не удалён');
  assert.equal(await h.first('SELECT id FROM listings WHERE id = ?', plain), null);
  assert.equal((await h.api(OWNER, 'GET', '/marks?kind=like')).body.total, 1);
});

test('лимит 100: 101-й лайк — окно кнопкой и 409 через API', async () => {
  const inserted = await h.db.batch(Array.from({ length: 99 }, () => insertListing()));
  await h.db.batch(inserted.map((r) => h.db
    .prepare("INSERT INTO marks (user_id, listing_id, kind, created_at) VALUES (?, ?, 'like', ?)")
    .bind(OWNER.id, r.results[0].id, h.now)));
  const extra = await addListing();
  const edits = count('editMessageReplyMarkup');
  await h.callback(OWNER, `lk:${extra}`);
  const ans = lastCall('answerCallbackQuery').params;
  assert.equal(ans.text, 'В понравившихся уже 100 объявлений — уберите лишние');
  assert.equal(ans.show_alert, true);
  assert.equal(count('editMessageReplyMarkup'), edits);

  const put = await h.api(OWNER, 'PUT', `/listings/${extra}/mark`, { mark: 'like' });
  assert.equal(put.status, 409);
  assert.equal(put.body.error.code, 'like_limit');
  assert.equal((await h.api(OWNER, 'PUT', `/listings/${likedId}/mark`, { mark: 'like' })).status, 200, 'повтор своего лайка — не сверх лимита');
  assert.equal((await h.first("SELECT COUNT(*) AS n FROM marks WHERE user_id = ? AND kind = 'like'", OWNER.id)).n, 100);
});

test('объявление удалено из бота — окно, кнопки не меняются; API — 404', async () => {
  const edits = count('editMessageReplyMarkup');
  await h.callback(OWNER, 'lk:999999999');
  const ans = lastCall('answerCallbackQuery').params;
  assert.equal(ans.text, 'Объявление уже удалено из бота');
  assert.equal(ans.show_alert, true);
  assert.equal(count('editMessageReplyMarkup'), edits);
  const put = await h.api(OWNER, 'PUT', '/listings/999999999/mark', { mark: 'like' });
  assert.equal(put.status, 404);
  assert.equal(put.body.error.code, 'not_found');
});

test('главное меню: «Понравившиеся» после «Мои поиски» у участника', async () => {
  await h.message(MEMBER, '/start');
  const rows = h.sent(MEMBER.id).at(-1).params.reply_markup.inline_keyboard;
  const i = rows.findIndex((r) => r[0].text === 'Мои поиски');
  assert.equal(rows[i + 1][0].text, 'Понравившиеся');
  assert.match(rows[i + 1][0].web_app.url, /\/app#\/liked$/);
});

test('без доступа: кнопка лайка — отказ, отметки нет', async () => {
  await h.callback(STRANGER, `lk:${likedId}`);
  assert.match(lastCall('answerCallbackQuery').params.text, /по приглашению/);
  assert.deepEqual(await marksOf(STRANGER), []);
});
