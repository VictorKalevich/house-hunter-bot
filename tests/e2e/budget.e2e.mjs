// Сутки тиков на стенде (tasks.md T087; Конституция, принципы I и IV): подзапросы, CPU-единицы, записи D1, паузы к сайтам.
// Первый час — разогрев (первые круги всех лент читают все страницы), меряются следующие 24 часа.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, criteria, kufarAd, kufarPage, MEMBER, MINUTE, PLACES } from './harness.mjs';

const WARMUP_TICKS = 60;
const DAY_TICKS = 24 * 60;
// data-model.md «Лимиты D1»: ~5 000 + ~3 000 + ~9 000 записей и ~2 500 страниц в сутки; оценка приблизительная — допуск 10 %.
const WRITES_PER_DAY = 17_000 * 1.1;
const PAGES_PER_DAY = 2_500;
const D1_WRITES_LIMIT = 100_000;
const SOURCE_HOSTS = ['api.kufar.by', 're.kufar.by', 'realt.by', 'domovita.by', 'www.moyareklama.by'];

let h;
const ticks = [];
let daily = null;
let measuredFrom = 0;

const sum = (list, key) => list.reduce((s, t) => s + t[key], 0);

before(async () => {
  h = await createHarness();
  await h.addMember(MEMBER);
  for (const c of [
    criteria({ settlementId: PLACES.minsk.id, maxKm: 50, priceUsd: { min: null, max: 60_000 } }),
    criteria({ settlementId: PLACES.minsk.id, maxKm: 40, distanceMode: 'road_center', priceUsd: { min: null, max: 60_000 } }),
  ]) assert.equal((await h.api(MEMBER, 'POST', '/searches', c)).status, 201);

  // kufar: каждый круг — 10 новых объявлений вокруг Минска (~800 в сутки), одно из них подходит под поиски.
  let feed = [];
  let circle = 0;
  h.sites.set('api.kufar.by', (url) => {
    if (url.pathname === '/robots.txt') return null;
    if (url.searchParams.has('cursor')) return Response.json(kufarPage([]));
    circle += 1;
    const fresh = Array.from({ length: 10 }, (_, i) => kufarAd({
      priceUsd: i === 0 ? 45_000 : 90_000 + i * 1_000,
      lat: PLACES.minsk.lat + (((circle * 7 + i * 13) % 80) - 40) / 111,
      lon: PLACES.minsk.lon + (((circle * 11 + i * 5) % 80) - 40) / 70,
    }));
    feed = [...fresh, ...feed].slice(0, 30);
    return Response.json(kufarPage(feed));
  });

  for (let i = 0; i < WARMUP_TICKS + DAY_TICKS; i++) {
    if (i === WARMUP_TICKS) measuredFrom = h.now + MINUTE;
    ticks.push(await h.tick());
    const d = new Date(h.now);
    if (d.getUTCHours() === 0 && d.getUTCMinutes() === 30) daily = await h.daily();
  }
});
after(() => h?.close());

test('подзапросов на тик ≤ 45, CPU-единиц ≤ 6, ни один шаг не упал', () => {
  const worst = Math.max(...ticks.map((t) => t.subrequests));
  assert.ok(worst <= 45, `подзапросов в худшем тике: ${worst}`);
  assert.ok(Math.max(...ticks.map((t) => t.cpu_units)) <= 6);
  const errors = ticks.flatMap((t) => Object.entries(t.steps).filter(([, r]) => r?.error).map(([name, r]) => `${name}: ${r.error}`));
  assert.deepEqual(errors, []);
  assert.ok(daily, 'суточная задача прошла');
  assert.deepEqual(Object.entries(daily.steps).filter(([, r]) => r?.error), []);
});

test('к одному сайту — не чаще одного запроса в минуту; каждая лента — не чаще раза в 15 минут', () => {
  for (const host of SOURCE_HOSTS) {
    const times = h.siteRequests(host).map((r) => r.at);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= MINUTE, `${host}: два запроса за ${times[i] - times[i - 1]} мс`);
  }
  // Начало круга ленты — запрос её первой страницы (без курсора и номера страницы).
  const starts = new Map();
  for (const r of h.requests.filter((x) => SOURCE_HOSTS.includes(x.host))) {
    const u = new URL(r.url);
    if (u.pathname === '/robots.txt' || u.searchParams.has('cursor') || u.searchParams.has('page')) continue;
    const key = `${u.host}${u.pathname}`;
    if (!starts.has(key)) starts.set(key, []);
    starts.get(key).push(r.at);
  }
  for (const [key, times] of starts) {
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 15 * MINUTE, `${key}: круги через ${(times[i] - times[i - 1]) / MINUTE} мин`);
  }
  const pages = h.requests.filter((r) => SOURCE_HOSTS.includes(r.host) && r.at >= measuredFrom).length;
  assert.ok(pages <= PAGES_PER_DAY, `страниц за сутки: ${pages}`);
});

test('записей D1 за сутки — в пределах оценки data-model.md, чтений — далеко от лимита', () => {
  const day = ticks.slice(WARMUP_TICKS);
  const written = sum(day, 'rows_written') + (daily?.rows_written ?? 0);
  const read = sum(day, 'rows_read') + (daily?.rows_read ?? 0);
  const withWarmup = sum(ticks, 'rows_written') + (daily?.rows_written ?? 0);
  assert.ok(written <= WRITES_PER_DAY, `записей за сутки: ${written}`);
  assert.ok(withWarmup <= D1_WRITES_LIMIT / 4, `записей вместе с разогревом: ${withWarmup}`);
  assert.ok(read <= 2_000_000, `чтений за сутки: ${read}`);
  console.log(`# сутки: записей ${written} (с разогревом ${withWarmup}), чтений ${read}, худший тик — ${Math.max(...ticks.map((t) => t.subrequests))} подзапросов`);
});

test('уведомления доходят: по одному подходящему объявлению за круг kufar', async () => {
  const sent = h.sent(MEMBER.id).length;
  assert.ok(sent >= 40, `сообщений: ${sent}`);
  const stuck = await h.first("SELECT COUNT(*) AS n FROM notifications WHERE status IN ('sending', 'uncertain', 'failed')");
  assert.equal(stuck.n, 0);
});
