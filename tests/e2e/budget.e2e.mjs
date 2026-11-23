// Сутки тиков на стенде (tasks.md T087; Конституция, принципы I и IV): подзапросы, CPU-единицы, записи D1, паузы к сайтам.
// Первый час — разогрев (первые круги всех лент читают все страницы), меряются следующие 24 часа.
// Фича 003 (tasks.md T046, SC-007): у пользователя 30 понравившихся realt и moyareklama, которых нет в выдаче, —
// их страницы проверяются раз в сутки в тех же лимитах.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, criteria, fixture, HOUR, kufarAd, kufarPage, MEMBER, MINUTE, PLACES } from './harness.mjs';

const WARMUP_TICKS = 60;
const DAY_TICKS = 24 * 60;
// data-model.md «Лимиты D1»: ~5 000 + ~3 000 + ~9 000 записей и ~2 500 страниц в сутки; оценка приблизительная — допуск 10 %.
const WRITES_PER_DAY = 17_000 * 1.1;
const PAGES_PER_DAY = 2_500;
const D1_WRITES_LIMIT = 100_000;
const SOURCE_HOSTS = ['api.kufar.by', 're.kufar.by', 'realt.by', 'domovita.by', 'www.moyareklama.by'];
const DAY = 24 * HOUR;
const LIKED_PER_SITE = 15;
/** Адрес страницы понравившегося → сайт. */
const liked = new Map();

let h;
const ticks = [];
let daily = null;
let measuredFrom = 0;

const sum = (list, key) => list.reduce((s, t) => s + t[key], 0);

/** Понравившиеся без выдачи: цена и площади — как на сохранённых страницах, чтобы не было сообщений о цене. */
async function addLiked() {
  const sites = [
    { source: 'realt', ext: (i) => String(9_300_000 + i), url: (ext) => `https://realt.by/brest-region/sale-cottages/object/${ext}/`,
      price: [73_000, 218_781, 73_000, 'USD'], areas: [99.2, 13.5] },
    { source: 'moyareklama', ext: (i) => String(990_000_000 + i), url: (ext) => `https://www.moyareklama.by/single/ad/${ext}`,
      price: [7_000 / 3, 7_000, 7_000, 'BYN'], areas: [36.1, 25] },
  ];
  for (let i = 0; i < LIKED_PER_SITE; i++) {
    for (const site of sites) {
      const ext = site.ext(i);
      const url = site.url(ext);
      const { id } = await h.db
        .prepare(
          `INSERT INTO listings (source, external_id, url, price_usd, price_byn, price_amount, price_currency, house_m2,
             plot_sotki, lat, lon, place_text, is_new, sort_at, first_seen_at, last_seen_at, match_state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 52.1, 23.7, 'д. Тестовая', 0, ?, ?, ?, 'done') RETURNING id`,
        )
        .bind(site.source, ext, url, ...site.price, ...site.areas, h.now - 3 * DAY, h.now - 3 * DAY, h.now - 2 * DAY)
        .first();
      assert.equal((await h.api(MEMBER, 'PUT', `/listings/${id}/mark`, { mark: 'like' })).status, 200);
      liked.set(url, site.source);
    }
  }
}

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

  h.sites.set('realt.by', (url) => (/\/object\/\d+\/$/.test(url.pathname)
    ? new Response(fixture('realt/card.html'), { headers: { 'content-type': 'text/html; charset=utf-8' } })
    : null));

  for (let i = 0; i < WARMUP_TICKS + DAY_TICKS; i++) {
    if (i === 1) await addLiked();
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

test('страницы понравившихся: все проверены, каждая — не чаще раза в сутки, к сайту — не чаще раза в 3 минуты', async () => {
  const byHost = new Map();
  for (const r of h.requests.filter((x) => liked.has(x.url))) {
    if (!byHost.has(r.host)) byHost.set(r.host, []);
    byHost.get(r.host).push(r);
  }
  assert.deepEqual([...byHost.keys()].sort(), ['realt.by', 'www.moyareklama.by']);
  for (const [host, list] of byHost) {
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i].at - list[i - 1].at >= 3 * MINUTE, `${host}: страницы через ${(list[i].at - list[i - 1].at) / MINUTE} мин`);
    }
  }
  const visits = new Map();
  for (const list of byHost.values()) for (const r of list) visits.set(r.url, [...(visits.get(r.url) ?? []), r.at]);
  assert.equal(visits.size, liked.size, 'проверены все понравившиеся');
  for (const [url, times] of visits) {
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= DAY, `${url}: повтор через ${(times[i] - times[i - 1]) / HOUR} ч`);
  }
  const unchecked = await h.first(`SELECT COUNT(*) AS n FROM listings WHERE source IN ('realt', 'moyareklama')
    AND external_id IN (${[...liked.keys()].map(() => '?').join(', ')}) AND check_ok_at IS NULL`,
  ...[...liked.keys()].map((u) => /(\d+)\/?$/.exec(u)[1]));
  assert.equal(unchecked.n, 0, 'страницы разобраны: check_ok_at у всех');
  const alerts = await h.first('SELECT COUNT(*) AS n FROM price_alerts');
  assert.equal(alerts.n, 0, 'цена та же — сообщений о цене нет');
});

test('круги лент realt и moyareklama проходят и при проверке страниц', () => {
  const starts = new Map();
  for (const r of h.requests.filter((x) => ['realt.by', 'www.moyareklama.by'].includes(x.host) && x.at >= measuredFrom && !liked.has(x.url))) {
    const u = new URL(r.url);
    if (u.pathname === '/robots.txt' || u.pathname.startsWith('/single/ad/') || u.searchParams.has('page')) continue;
    const key = `${u.host}${decodeURIComponent(u.pathname)}`;
    starts.set(key, (starts.get(key) ?? 0) + 1);
  }
  console.log(`# круги лент за сутки: ${Math.min(...starts.values())}–${Math.max(...starts.values())} на ленту, лент ${starts.size}`);
  for (const host of ['realt.by', 'www.moyareklama.by']) assert.ok([...starts.keys()].some((k) => k.startsWith(host)), host);
  for (const [key, n] of starts) assert.ok(n >= 48, `${key}: кругов за сутки ${n}`);
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
