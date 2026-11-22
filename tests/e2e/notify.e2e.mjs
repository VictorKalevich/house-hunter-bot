// Уведомления о новых объявлениях по quickstart.md §4 (tasks.md T028, US1). Тесты идут по порядку и делят стенд.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHarness, criteria, fixture, HOUR, kufarAd, MEMBER, MINUTE, nextAdId, OWNER, PLACES, pointNorth,
} from './harness.mjs';

let h;
let searchId;
const near = pointNorth(PLACES.minsk, 12);
const match = (o = {}) => kufarAd({ priceUsd: 75_000, houseM2: 100, plotSotki: 15, ...near, ...o });

/** Новая лента kufar → опрос в ближайшем тике; следующий тик доставляет уведомления. */
async function circle(ads, extraTicks = 1) {
  h.kufarAds = ads;
  await h.pollNow('kufar');
  const reports = [await h.tick()];
  for (let i = 0; i < extraTicks; i++) reports.push(await h.tick());
  return reports;
}

before(async () => {
  h = await createHarness({ only: ['kufar'] });
  await h.addMember(MEMBER);
});
after(() => h?.close());

test('поиск «до 30 км по прямой, до 80 000 $, дом от 80 м², участок от 10 сот.»', async () => {
  const res = await h.api(MEMBER, 'POST', '/searches', criteria({
    settlementId: PLACES.minsk.id, maxKm: 30, priceUsd: { min: null, max: 80_000 }, houseM2: { min: 80, max: null },
    plotSotki: { min: 10, max: null },
  }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.title, 'Минск · до 30 км по прямой');
  assert.equal(res.body.status, 'active');
  searchId = res.body.id;
});

test('первый круг ленты только запоминает объявления: уведомлений нет', async () => {
  h.kufarAds = [match(), match(), kufarAd({ priceUsd: 60_000, ...near })];
  const robots = await h.tick();
  assert.equal(robots.steps.poll[0].kind, 'robots');
  const first = await h.tick();
  assert.equal(first.steps.poll[0].result, 'ok');
  await h.tick();
  const rows = await h.all('SELECT is_new FROM listings');
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.is_new === 0));
  assert.equal(h.sent(MEMBER.id).length, 0);
});

let fresh;
test('одно подходящее новое и одно неподходящее → ровно одно sendMessage', async () => {
  fresh = match();
  const expensive = match({ priceUsd: 120_000 });
  await circle([fresh, expensive, ...h.kufarAds]);
  const sent = h.sent(MEMBER.id);
  assert.equal(sent.length, 1);
  const msg = sent[0].params;
  assert.equal(msg.parse_mode, 'HTML');
  assert.match(msg.text, /<b>75 000 \$<\/b> · дом 100 м² · участок 15 сот\./);
  assert.match(msg.text, /Минск: 12 км по прямой/);
  assert.match(msg.text, /kufar\.by · Поиск: «Минск · до 30 км по прямой»/);
  assert.equal(msg.reply_markup.inline_keyboard[0][0].url, `https://re.kufar.by/vi/${fresh.ad_id}`);
  const n = await h.first('SELECT status, distance_label FROM notifications');
  assert.equal(n.status, 'sent');
  assert.equal(n.distance_label, 'Минск: 12 км по прямой');
});

test('повтор тика и поднятие того же объявления → второго сообщения нет', async () => {
  await h.ticks(2);
  const bumped = { ...fresh, list_time: new Date(h.now).toISOString() };
  await circle([bumped, ...h.kufarAds.filter((a) => a.ad_id !== fresh.ad_id)], 2);
  assert.equal(h.sent(MEMBER.id).length, 1);
  assert.equal((await h.first('SELECT COUNT(*) AS n FROM notifications')).n, 1);
});

test('50 старых объявлений (не новых на сайте) → уведомлений нет', async () => {
  const old = Array.from({ length: 50 }, (_, i) => match({ id: 1_100_000_000 + i }));
  await circle(old, 2);
  assert.equal(h.sent(MEMBER.id).length, 1);
  const stored = await h.first('SELECT COUNT(*) AS n, SUM(is_new) AS fresh FROM listings WHERE external_id LIKE ?', '11000000%');
  assert.equal(stored.n, 50);
  assert.equal(stored.fresh, 0);
});

test('Telegram 500, затем 200 → одно сообщение в следующем тике', async () => {
  let failures = 1;
  h.telegram.respond = (call) => {
    if (call.method === 'sendMessage' && String(call.chatId) === String(MEMBER.id) && failures > 0) {
      failures -= 1;
      return { status: 500, body: { ok: false, error_code: 500, description: 'Internal Server Error' } };
    }
    return null;
  };
  const ad = match();
  await circle([ad, ...h.kufarAds], 1);
  let n = await h.first('SELECT status, attempts FROM notifications WHERE listing_id = (SELECT id FROM listings WHERE external_id = ?)', String(ad.ad_id));
  assert.deepEqual({ ...n }, { status: 'pending', attempts: 1 });
  await h.tick();
  n = await h.first('SELECT status, attempts FROM notifications WHERE listing_id = (SELECT id FROM listings WHERE external_id = ?)', String(ad.ad_id));
  assert.deepEqual({ ...n }, { status: 'sent', attempts: 2 });
  const sent = h.sent(MEMBER.id);
  assert.equal(sent.length, 3);
  assert.equal(sent[1].params.text, sent[2].params.text);
  h.telegram.respond = null;
});

test('Telegram 403 → undeliverable и users.blocked_at', async () => {
  h.telegram.respond = (call) => (call.method === 'sendMessage' && String(call.chatId) === String(MEMBER.id)
    ? { status: 403, body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } }
    : null);
  const ad = match();
  await circle([ad, ...h.kufarAds], 1);
  const n = await h.first('SELECT status FROM notifications WHERE listing_id = (SELECT id FROM listings WHERE external_id = ?)', String(ad.ad_id));
  assert.equal(n.status, 'undeliverable');
  assert.ok((await h.first('SELECT blocked_at FROM users WHERE telegram_id = ?', MEMBER.id)).blocked_at > 0);
  h.telegram.respond = null;
});

test('страница защиты сайта → источник blocked, следующий запрос не раньше чем через час', async () => {
  h.sites.set('api.kufar.by', () => new Response(fixture('kufar/blocked.html'), { status: 403, headers: { 'content-type': 'text/html' } }));
  await h.pollNow('kufar');
  await h.tick();
  const src = await h.first('SELECT state, next_check_at, alerted_at FROM sources WHERE id = ?', 'kufar');
  assert.equal(src.state, 'blocked');
  assert.equal(src.next_check_at, h.now + HOUR);
  assert.ok(src.alerted_at > 0);
  assert.match(h.sent(OWNER.id).at(-1).params.text, /kufar\.by/);

  const blockedAt = h.now;
  const before = h.siteRequests('api.kufar.by').length;
  for (let i = 0; i < 6; i++) await h.tick(9 * MINUTE);
  assert.equal(h.siteRequests('api.kufar.by').length, before, 'за час к сайту не обращались');
  await h.tick(HOUR - (h.now - blockedAt));
  const after = h.siteRequests('api.kufar.by');
  assert.equal(after.length, before + 1);
  assert.ok(after.at(-1).at - blockedAt >= HOUR);
  h.sites.delete('api.kufar.by');
  assert.ok(nextAdId() > 0);
});
