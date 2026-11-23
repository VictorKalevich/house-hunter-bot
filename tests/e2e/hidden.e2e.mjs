// «Не интересно»: скрытые не входят в список поиска и не приходят сообщением; «Вернуть» (specs/003-listing-likes/
// quickstart.md §2, строки 7–9; tasks.md T015). Тесты идут по порядку и делят стенд.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, criteria, MEMBER, nextAdId, OWNER, PLACES, pointNorth } from './harness.mjs';

let h;
let searchId;
const ids = [];
const near = pointNorth(PLACES.minsk, 12);

const lastCall = (method) => h.telegram.calls.filter((c) => c.method === method).at(-1);
const marksOf = (user) => h.all('SELECT listing_id, kind FROM marks WHERE user_id = ? ORDER BY listing_id', user.id);
const list = async (user = MEMBER) => (await h.api(user, 'GET', `/searches/${searchId}/listings`)).body;

async function addListing() {
  const ext = String(nextAdId());
  const row = await h.db
    .prepare(
      `INSERT INTO listings (source, external_id, url, price_usd, price_byn, house_m2, plot_sotki, lat, lon, place_text,
         is_new, sort_at, first_seen_at, last_seen_at, match_state)
       VALUES ('kufar', ?, ?, 70000, 210000, 100, 15, ?, ?, 'д. Тестовая', 0, ?, ?, ?, 'done') RETURNING id`,
    )
    .bind(ext, `https://re.kufar.by/vi/${ext}`, near.lat, near.lon, h.now, h.now, h.now)
    .first();
  return row.id;
}

before(async () => {
  h = await createHarness({ only: ['kufar'] });
  await h.addMember(MEMBER);
  const res = await h.api(MEMBER, 'POST', '/searches', criteria({ settlementId: PLACES.minsk.id, maxKm: 30 }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  searchId = res.body.id;
  await h.tick();
  for (let i = 0; i < 3; i++) ids.push(await addListing());
});
after(() => h?.close());

test('скрыть через API → нет в списке и total меньше; есть в «Скрытых»; null возвращает', async () => {
  const before = await list();
  assert.equal(before.total, 3);
  assert.ok(before.items.every((c) => c.mark === null));

  const put = await h.api(MEMBER, 'PUT', `/listings/${ids[1]}/mark`, { mark: 'hide' });
  assert.deepEqual(put.body, { id: ids[1], mark: 'hide' });
  const hidden = await list();
  assert.equal(hidden.total, 2);
  assert.ok(!hidden.items.some((c) => c.id === ids[1]));

  const marks = await h.api(MEMBER, 'GET', '/marks?kind=hide');
  assert.equal(marks.body.total, 1);
  assert.equal(marks.body.items[0].id, ids[1]);
  assert.equal(marks.body.items[0].mark, 'hide');
  assert.equal((await h.api(MEMBER, 'GET', '/marks?kind=like')).body.total, 0);

  await h.api(MEMBER, 'PUT', `/listings/${ids[1]}/mark`, { mark: null });
  assert.equal((await list()).total, 3);
});

test('лайк виден на карточке списка поиска', async () => {
  await h.api(MEMBER, 'PUT', `/listings/${ids[0]}/mark`, { mark: 'like' });
  assert.equal((await list()).items.find((c) => c.id === ids[0]).mark, 'like');
});

test('кнопки hd и uh под сообщением: строки и клавиатуры', async () => {
  await h.callback(MEMBER, `hd:${ids[2]}`);
  assert.equal(lastCall('answerCallbackQuery').params.text, 'Скрыто — больше не покажу');
  const kb = lastCall('editMessageReplyMarkup').params.reply_markup.inline_keyboard;
  assert.equal(kb.length, 2);
  assert.deepEqual(kb[1], [{ text: 'Скрыто · вернуть', callback_data: `uh:${ids[2]}` }]);
  assert.equal((await list()).total, 2);

  await h.callback(MEMBER, `uh:${ids[2]}`);
  assert.equal(lastCall('answerCallbackQuery').params.text, 'Возвращено');
  assert.deepEqual(lastCall('editMessageReplyMarkup').params.reply_markup.inline_keyboard[1][0], { text: '♡ Нравится', callback_data: `lk:${ids[2]}` });
  assert.equal((await list()).total, 3);
});

test('«вернуть» не снимает лайк: отметка и клавиатура — по текущей', async () => {
  await h.callback(MEMBER, `uh:${ids[0]}`);
  assert.deepEqual((await marksOf(MEMBER)).find((m) => m.listing_id === ids[0]), { listing_id: ids[0], kind: 'like' });
  assert.equal(lastCall('editMessageReplyMarkup').params.reply_markup.inline_keyboard[1][0].text, '♥ В понравившихся');
});

test('взаимоисключение: лайк → скрыть → лайк — всегда одна отметка', async () => {
  const id = ids[2];
  const only = async () => (await marksOf(MEMBER)).filter((m) => m.listing_id === id);
  await h.callback(MEMBER, `lk:${id}`);
  assert.deepEqual(await only(), [{ listing_id: id, kind: 'like' }]);
  await h.callback(MEMBER, `hd:${id}`);
  assert.deepEqual(await only(), [{ listing_id: id, kind: 'hide' }]);
  assert.equal((await h.api(MEMBER, 'GET', '/marks?kind=like')).body.items.some((c) => c.id === id), false);
  await h.api(MEMBER, 'PUT', `/listings/${id}/mark`, { mark: 'like' });
  assert.deepEqual(await only(), [{ listing_id: id, kind: 'like' }]);
});

test('скрытие у владельца не меняет список участника', async () => {
  const total = (await list()).total;
  await h.api(OWNER, 'PUT', `/listings/${ids[1]}/mark`, { mark: 'hide' });
  assert.equal((await list()).total, total);
  assert.equal((await list()).items.find((c) => c.id === ids[1]).mark, null);
});

test('скрыто до отправки уведомления → sendMessage нет, failed «скрыто пользователем»', async () => {
  const id = await addListing();
  const ext = (await h.first('SELECT external_id FROM listings WHERE id = ?', id)).external_id;
  await h.db
    .prepare(
      `INSERT INTO notifications (user_id, source, external_id, listing_id, search_ids, status, next_attempt_at, created_at)
       VALUES (?, 'kufar', ?, ?, ?, 'pending', 0, ?)`,
    )
    .bind(MEMBER.id, ext, id, JSON.stringify([searchId]), h.now)
    .run();
  await h.api(MEMBER, 'PUT', `/listings/${id}/mark`, { mark: 'hide' });
  const sentBefore = h.sent(MEMBER.id).length;
  await h.tick();
  assert.equal(h.sent(MEMBER.id).length, sentBefore);
  const n = await h.first('SELECT status, last_error FROM notifications WHERE listing_id = ?', id);
  assert.deepEqual(n, { status: 'failed', last_error: 'скрыто пользователем' });
});
