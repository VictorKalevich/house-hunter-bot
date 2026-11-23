// Сквозной стенд (Miniflare): Worker из исходников, локальная D1, подмена внешних сервисов (tasks.md T017).
// Время тиков задаёт стенд (scheduledTime); webhook и API живут по настоящим часам, поэтому часы стенда
// начинаются с «сейчас» и идут только вперёд.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { signInitData } from '../../src/http/miniapp-auth.js';
import { encodePolyline } from '../../src/geo/polyline.js';
import { haversineKm } from '../../src/geo/haversine.js';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
const FAR = 9e15;

export const ENV = {
  BOT_TOKEN: '123456:TEST-TOKEN',
  WEBHOOK_SECRET: 'e2e-secret',
  OWNER_TELEGRAM_ID: '1001',
  ORS_API_KEY: 'ors-e2e',
  BOT_USERNAME: 'house_hunter_e2e_bot',
  PUBLIC_URL: 'https://bot.e2e.test',
};

export const OWNER = { id: 1001, first_name: 'Владелец', username: 'owner_e2e' };
export const MEMBER = { id: 2002, first_name: 'Гость', username: 'member_e2e' };
export const MEMBER2 = { id: 2003, first_name: 'Второй' };
export const STRANGER = { id: 3003, first_name: 'Незнакомец' };

/** Пункты маленького сида (tests/fixtures/settlements-small.sql). */
export const PLACES = {
  minsk: { id: 104649860, name: 'Минск', lat: 53.9024716, lon: 27.5618225 },
  gomel: { id: 104605204, name: 'Гомель', lat: 52.4238936, lon: 31.0131698 },
};

export const fixture = (path) => readFileSync(join(ROOT, 'tests/fixtures', path), 'utf8');

/** Разбить SQL-файл на операторы: комментарии `--` вне строк, `;` в конце оператора. */
export function splitSql(sql) {
  const out = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (!inStr && c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      cur += '\n';
      continue;
    }
    if (c === "'") inStr = !inStr;
    if (!inStr && c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// ---------- объявления kufar для тестов ----------

let adSeq = 1_200_000_000;
export const nextAdId = () => ++adSeq;

/**
 * Объявление в формате выдачи api.kufar.by. Цена — в $, площади — м² и сотки, место — координаты.
 * @param {{id?: number, priceUsd?: number|null, houseM2?: number|null, plotSotki?: number|null,
 *   lat?: number, lon?: number, kind?: string, paid?: boolean, listTime?: string, address?: string}} o
 */
export function kufarAd(o = {}) {
  const id = o.id ?? nextAdId();
  const params = [
    { pl: 'Вид объекта', vl: 'Дом', p: 'house_type_for_sell', v: o.kind ?? '1' },
    { pl: 'Регион', vl: 'Минская область', p: 'region', v: 5 },
    { pl: 'Город / Район', vl: 'Минский район', p: 'area', v: '141' },
  ];
  if (o.houseM2 !== null) params.push({ pl: 'Общая площадь, м²', vl: '', p: 'size', v: o.houseM2 ?? 100 });
  if (o.plotSotki !== null) params.push({ pl: 'Площадь участка, соток', vl: '', p: 'size_area', v: o.plotSotki ?? 15 });
  if (o.lat !== undefined) params.push({ pl: 'Координаты', vl: '', p: 'coordinates', v: [o.lon, o.lat] });
  return {
    ad_id: id,
    ad_link: `https://re.kufar.by/vi/${id}`,
    ad_parameters: params,
    account_parameters: [{ pl: 'Адрес', vl: '', p: 'address', v: o.address ?? 'Центральная ул, деревня Тестовая, Минский район, Минская область' }],
    price_usd: o.priceUsd === null ? '0' : String(Math.round((o.priceUsd ?? 70_000) * 100)),
    price_byn: o.priceUsd === null ? '0' : String(Math.round(o.priceByn !== undefined ? o.priceByn * 100 : (o.priceUsd ?? 70_000) * 300)),
    currency: o.currency,
    paid_services: { polepos: Boolean(o.paid) },
    list_time: o.listTime ?? new Date().toISOString(),
    images: [],
  };
}

export function kufarPage(ads, { nextCursor = null } = {}) {
  const pages = [{ label: 'self', num: 1, token: null }];
  if (nextCursor) pages.push({ label: 'next', num: 2, token: nextCursor });
  return { ads, pagination: { pages }, total: ads.length, page_type: 'search' };
}

/** Точка на заданном расстоянии к северу от пункта (по прямой). */
export function pointNorth(place, km) {
  return { lat: place.lat + km / 111.195, lon: place.lon };
}

// ---------- ответы сайтов по умолчанию ----------

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const html = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const text = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain' } });

function defaultSite(h, url) {
  const host = url.hostname;
  const path = decodeURIComponent(url.pathname);
  if (path === '/robots.txt') {
    const file = { 're.kufar.by': 'kufar', 'realt.by': 'realt', 'domovita.by': 'domovita', 'www.moyareklama.by': 'moyareklama' }[host];
    return file ? text(fixture(`robots/${file}.txt`)) : text('Not found', 404);
  }
  if (host === 'api.kufar.by') {
    if (h.kufarAds) return json(kufarPage(h.kufarAds));
    return json(JSON.parse(fixture(url.searchParams.has('cursor') ? 'kufar/last-page.json' : 'kufar/page1.json')));
  }
  if (host === 'realt.by') {
    const dachi = path.includes('/dachi/');
    const page2 = url.searchParams.get('page') === '2';
    if (dachi) return html(fixture('realt/dachi.html'));
    if (path === '/sale/cottages/') return html(fixture('realt/minsk-oblast.html'));
    return html(fixture(page2 ? 'realt/region-brest-p2.html' : 'realt/region-brest.html'));
  }
  if (host === 'domovita.by') {
    if (path.startsWith('/_next/data/')) {
      const page2 = url.searchParams.has('page');
      if (page2) return json(JSON.parse(fixture('domovita/houses-gomel-p2.json')));
      return json(JSON.parse(fixture(path.includes('/minskaya-oblast/') ? 'domovita/houses-minskaya-oblast-p1.json' : 'domovita/houses-brest-p1.json')));
    }
    return html(fixture('domovita/section.html'));
  }
  if (host === 'www.moyareklama.by') {
    if (path.startsWith('/single/ad/')) return html(fixture('moyareklama/card.html'));
    // Раздел из сохранённой страницы, но с путём запрошенной ленты (парсер сверяет раздел).
    const page = fixture('moyareklama/section.html');
    const at = page.indexOf('var listParams = ');
    const want = path.replace(/^\/+|\/+$/g, '');
    const tail = page.slice(at).replace(/"path":"[^"]*"/, `"path":${JSON.stringify(`${want}/все`)}`);
    return html(page.slice(0, at) + tail);
  }
  return null;
}

// ---------- маршруты, курс, Telegram ----------

/** Маршрут по умолчанию: прямая × 1,3, геометрия — прямой отрезок. */
export function straightRoute(from, to, factor = 1.3) {
  return { km: haversineKm(from.lat, from.lon, to.lat, to.lon) * factor, points: [[from.lat, from.lon], [to.lat, to.lon]] };
}

async function routingService(h, request, url) {
  const host = url.hostname;
  if (host === 'api.heigit.org' && url.pathname.endsWith('/directions/driving-car/json')) {
    const body = await request.json();
    const [[fLon, fLat], [tLon, tLat]] = body.coordinates;
    const r = h.route({ lat: fLat, lon: fLon }, { lat: tLat, lon: tLon }, 'ors');
    if (r.status) return json(r.body ?? {}, r.status, r.headers);
    return json({ routes: [{ summary: { distance: r.km * 1000, duration: r.km * 60 }, geometry: encodePolyline(r.points) }] });
  }
  if (host === 'api.heigit.org' && url.pathname.endsWith('/matrix/driving-car')) {
    const body = await request.json();
    const [fLon, fLat] = body.locations[0];
    const row = body.locations.slice(1).map(([lon, lat]) => {
      const r = h.route({ lat: fLat, lon: fLon }, { lat, lon }, 'matrix');
      return r.status ? null : Math.round(r.km * 100) / 100;
    });
    return json({ distances: [row] });
  }
  if (host === 'routing.openstreetmap.de') {
    const coords = url.pathname.split('/driving/')[1].split(';').map((p) => p.split(',').map(Number));
    const r = h.route({ lat: coords[0][1], lon: coords[0][0] }, { lat: coords[1][1], lon: coords[1][0] }, 'osrm');
    if (r.status) return json(r.body ?? { code: 'NoRoute' }, r.status);
    return json({ code: 'Ok', routes: [{ distance: r.km * 1000, geometry: encodePolyline(r.points) }] });
  }
  return null;
}

async function telegramService(h, request, url) {
  const m = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
  if (!m) return json({ ok: false, error_code: 404, description: 'Not Found' }, 404);
  const params = await request.json().catch(() => ({}));
  const call = { method: m[2], params, chatId: params.chat_id ?? null, at: h.now };
  h.telegram.calls.push(call);
  const custom = h.telegram.respond?.(call);
  if (custom) return json(custom.body, custom.status ?? 200);
  if (call.method === 'sendMessage') {
    return json({ ok: true, result: { message_id: h.telegram.calls.length, chat: { id: params.chat_id }, date: Math.floor(h.now / 1000), text: params.text } });
  }
  return json({ ok: true, result: true });
}

// ---------- стенд ----------

/**
 * @param {{only?: string[]}} opts only — источники, которые опрашиваются; остальные «спят» (next_check_at в далёком будущем)
 */
export async function createHarness({ only = null } = {}) {
  const h = {
    now: Math.ceil(Date.now() / MINUTE) * MINUTE,
    logs: [],
    stdout: [],
    requests: [],
    sites: new Map(),
    kufarAds: null,
    telegram: { calls: [], respond: null },
    route: (from, to) => straightRoute(from, to),
    nbrbRate: 3.0,
    updateId: 1,
  };

  const outbound = async (request) => {
    const url = new URL(request.url);
    h.requests.push({ host: url.hostname, url: request.url, method: request.method, at: h.now });
    if (url.hostname === 'api.telegram.org') return telegramService(h, request, url);
    if (url.hostname === 'api.nbrb.by') return json({ Cur_ID: 431, Cur_Abbreviation: 'USD', Cur_Scale: 1, Cur_OfficialRate: h.nbrbRate });
    const routed = await routingService(h, request, url);
    if (routed) return routed;
    const custom = h.sites.get(url.hostname);
    if (custom) {
      const res = await custom(url, request);
      if (res) return res;
    }
    return defaultSite(h, url) ?? text(`no route for ${url.hostname}`, 599);
  };

  const mf = new Miniflare({
    modules: true,
    scriptPath: join(ROOT, 'src/index.js'),
    modulesRoot: ROOT,
    modulesRules: [
      { type: 'ESModule', include: ['**/*.js', '**/*.mjs'] },
      { type: 'Text', include: ['**/*.html', '**/*.css', '**/*.txt'] },
    ],
    compatibilityDate: '2026-07-30',
    d1Databases: { DB: 'house-hunter-e2e' },
    bindings: ENV,
    outboundService: outbound,
    handleRuntimeStdio(stdout, stderr) {
      createInterface({ input: stdout }).on('line', (line) => {
        h.stdout.push(line);
        if (process.env.E2E_VERBOSE) console.log(line);
        const start = line.indexOf('{"event"');
        if (start < 0) return;
        try {
          h.logs.push(JSON.parse(line.slice(start)));
        } catch {
          // не JSON
        }
      });
      createInterface({ input: stderr }).on('line', (line) => {
        h.stdout.push(line);
        if (process.env.E2E_VERBOSE) console.error(line);
      });
    },
  });
  await mf.ready;
  h.mf = mf;
  h.db = await mf.getD1Database('DB');
  h.worker = await mf.getWorker();

  for (const file of readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    await h.db.batch(splitSql(readFileSync(join(ROOT, 'migrations', file), 'utf8')).map((s) => h.db.prepare(s)));
  }
  await h.db.batch(splitSql(fixture('settlements-small.sql')).map((s) => h.db.prepare(s)));
  await h.db.prepare('INSERT INTO rates (date, usd_byn, fetched_at) VALUES (?, ?, ?)').bind(new Date(h.now).toISOString().slice(0, 10), 3.0, h.now).run();
  if (only) {
    for (const id of ['kufar', 'realt', 'domovita', 'moyareklama'].filter((s) => !only.includes(s))) {
      await h.db.prepare("INSERT INTO sources (id, state, next_check_at) VALUES (?, 'ok', ?)").bind(id, FAR).run();
    }
  }

  const waitLog = async (event, count, timeoutMs = 5000) => {
    const end = Date.now() + timeoutMs;
    while (h.logs.filter((l) => l.event === event).length <= count) {
      if (Date.now() > end) throw new Error(`нет строки лога ${event}; вывод:\n${h.stdout.slice(-20).join('\n')}`);
      await new Promise((r) => setTimeout(r, 5));
    }
    return h.logs.filter((l) => l.event === event)[count];
  };

  /** Тик через advanceMs после предыдущего; возвращает строку лога тика. */
  h.tick = async (advanceMs = MINUTE) => {
    h.now += advanceMs;
    const before = h.logs.filter((l) => l.event === 'tick').length;
    const r = await h.worker.scheduled({ cron: '* * * * *', scheduledTime: new Date(h.now) });
    if (r.outcome !== 'ok') throw new Error(`тик: ${r.outcome}\n${h.stdout.slice(-20).join('\n')}`);
    return waitLog('tick', before);
  };

  h.ticks = async (n, advanceMs = MINUTE) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(await h.tick(advanceMs));
    return out;
  };

  h.daily = async (advanceMs = 0) => {
    h.now += advanceMs;
    const before = h.logs.filter((l) => l.event === 'daily').length;
    const r = await h.worker.scheduled({ cron: '30 0 * * *', scheduledTime: new Date(h.now) });
    if (r.outcome !== 'ok') throw new Error(`суточная задача: ${r.outcome}`);
    return waitLog('daily', before);
  };

  /** Ленты источника — к опросу в ближайший тик (как «Проверить сейчас», без ожидания 15 минут). */
  h.pollNow = async (source) => {
    await h.db.prepare('UPDATE feeds SET next_poll_at = 0 WHERE source = ?').bind(source).run();
  };

  h.fetch = (path, init) => mf.dispatchFetch(`${ENV.PUBLIC_URL}${path}`, init);

  h.webhook = (update, { secret = ENV.WEBHOOK_SECRET } = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (secret !== null) headers['X-Telegram-Bot-Api-Secret-Token'] = secret;
    return h.fetch('/telegram/webhook', { method: 'POST', headers, body: JSON.stringify(update) });
  };

  h.message = (user, text) => h.webhook({
    update_id: h.updateId++,
    message: { message_id: h.updateId, from: user, chat: { id: user.id, type: 'private' }, date: Math.floor(Date.now() / 1000), text },
  });

  /** Нажатие кнопки под сообщением messageId; date = 0 — сообщение недоступно (InaccessibleMessage). */
  h.callback = (user, data, { messageId = 1, date = Math.floor(Date.now() / 1000) } = {}) => h.webhook({
    update_id: h.updateId++,
    callback_query: {
      id: String(h.updateId), from: user, data, chat_instance: '1',
      message: { message_id: messageId, chat: { id: user.id, type: 'private' }, date, text: 'меню' },
    },
  });

  /** Запрос к API мини-приложения от имени user (null — без подписи). */
  h.api = async (user, method, path, body) => {
    const headers = {};
    if (user) {
      const initData = await signInitData({ query_id: 'AAE2E', user, auth_date: String(Math.floor(Date.now() / 1000)) }, ENV.BOT_TOKEN);
      headers.Authorization = `tma ${initData}`;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await h.fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await res.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = raw;
    }
    return { status: res.status, body: data };
  };

  /** Участник с доступом (как после входа по приглашению). */
  h.addMember = async (user) => {
    await h.db.batch([
      h.db.prepare("INSERT OR IGNORE INTO users (telegram_id, first_name, role, access, created_at) VALUES (?, ?, 'owner', 'active', ?)")
        .bind(OWNER.id, OWNER.first_name, h.now),
      h.db.prepare("INSERT INTO users (telegram_id, first_name, username, role, access, invited_by, created_at) VALUES (?, ?, ?, 'member', 'active', ?, ?)")
        .bind(user.id, user.first_name, user.username ?? null, OWNER.id, h.now),
    ]);
  };

  /** Сообщения бота в чат chatId (по умолчанию — только sendMessage). */
  h.sent = (chatId, method = 'sendMessage') => h.telegram.calls.filter((c) => c.method === method && (chatId === undefined || String(c.chatId) === String(chatId)));

  h.siteRequests = (host) => h.requests.filter((r) => r.host === host);

  h.all = async (sql, ...params) => (await h.db.prepare(sql).bind(...params).all()).results;
  h.first = (sql, ...params) => h.db.prepare(sql).bind(...params).first();

  h.close = () => mf.dispose();
  return h;
}

/** Условия поиска для API (contracts/miniapp-api.md Criteria). */
export function criteria(overrides = {}) {
  return {
    settlementId: null,
    distanceMode: 'straight',
    maxKm: null,
    priceUsd: { min: null, max: null },
    houseM2: { min: null, max: null },
    plotSotki: { min: null, max: null },
    sources: ['kufar', 'realt', 'domovita', 'moyareklama'],
    ...overrides,
  };
}
