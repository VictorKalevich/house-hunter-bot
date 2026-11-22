// npm run bench — CPU разбора сохранённых страниц адаптерами против `cost` их лент (research.md R2, plan.md).
//
// Бюджет тика — 6 единиц `cost`, одна единица ≈ 1 мс CPU Worker'а; лимит вызова на бесплатном тарифе — 10 мс,
// остальные ~4 мс — на нормализацию, отбор и D1. Внутри Worker'а CPU не измерить (Date.now() стоит на месте без
// ввода-вывода), поэтому меряем в Node тот же код на том же V8.
//
// Порог (plan.md «Цели производительности»): медиана в Node ≤ cost мс; запас до лимита — 4 мс из 10. Машина
// разработчика бывает быстрее общего сервера Cloudflare, поэтому медиана выше 0,5 мс × cost помечается «мало
// запаса» — предупреждение: такие ленты сверить по CPU в логах настоящего Worker'а при выкате. Первый
// («холодный») прогон включает компиляцию кода разбора и тоже только предупреждение: в Worker'е изоляция обычно
// переиспользуется между вызовами cron, но это не гарантировано. Код выхода 1 — если хоть одна медиана выше cost.
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import domovita from '../src/sources/domovita.js';
import kufar from '../src/sources/kufar.js';
import moyareklama from '../src/sources/moyareklama.js';
import realt from '../src/sources/realt.js';

const RUNS = 20;
const WARMUP = 5;
const MS_PER_UNIT = 1;
const MS_PER_UNIT_MARGIN = 0.5;

const fixture = (path) => readFileSync(new URL(`../tests/fixtures/${path}`, import.meta.url), 'utf8');
const feedOf = (adapter, key) => {
  const feed = adapter.feeds.find((f) => f.key === key);
  if (!feed) throw new Error(`${adapter.id}: нет ленты ${key}`);
  return feed;
};

/** Страница → вызов разбора и cost запроса (как его считает src/jobs/poll-feeds.js). */
function pageCase(adapter, file, key, page = 1) {
  const feed = feedOf(adapter, key);
  return { adapter: adapter.id, file, what: `${key} p${page}`, cost: feed.cost, run: (body) => adapter.parsePage(body, { feed, page }) };
}

const CASES = [
  pageCase(kufar, 'kufar/page1.json', 'kufar:all', 1),
  pageCase(kufar, 'kufar/page2.json', 'kufar:all', 2),
  pageCase(kufar, 'kufar/last-page.json', 'kufar:all', 3),
  pageCase(realt, 'realt/region-brest.html', 'brest-region:cottages', 1),
  pageCase(realt, 'realt/region-brest-p2.html', 'brest-region:cottages', 2),
  pageCase(realt, 'realt/minsk-oblast.html', 'minsk-region:cottages', 1),
  pageCase(realt, 'realt/dachi.html', 'minsk-region:dachi', 1),
  pageCase(domovita, 'domovita/houses-brest-p1.json', 'brestskaya-oblast:houses', 1),
  pageCase(domovita, 'domovita/houses-gomel-p2.json', 'gomelskaya-oblast:houses', 2),
  pageCase(domovita, 'domovita/houses-minskaya-oblast-p1.json', 'minskaya-oblast:houses', 1),
  pageCase(domovita, 'domovita/wrong-section.json', 'gomelskaya-oblast:houses', 1),
  // Запрос версии сборки (purpose: 'state') стоит 1 единицу.
  { adapter: 'domovita', file: 'domovita/section.html', what: 'parseState', cost: 1, run: (body) => domovita.parseState(body) },
  pageCase(moyareklama, 'moyareklama/section.html', 'gomel', 1),
  pageCase(moyareklama, 'moyareklama/subsection.html', 'gomel-district', 1),
  // Карточка объявления (doDetail) стоит 1 единицу.
  { adapter: 'moyareklama', file: 'moyareklama/card.html', what: 'parseDetail', cost: 1, run: (body) => moyareklama.parseDetail(body) },
];

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const fmt = (ms) => ms.toFixed(2);

const rows = [];
let failed = 0;
for (const c of CASES) {
  const body = fixture(c.file);
  let t = performance.now();
  c.run(body);
  const cold = performance.now() - t;
  for (let i = 0; i < WARMUP; i++) c.run(body);
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    t = performance.now();
    c.run(body);
    times.push(performance.now() - t);
  }
  const med = median(times);
  const limit = c.cost * MS_PER_UNIT;
  const ok = med <= limit;
  const tight = ok && med > c.cost * MS_PER_UNIT_MARGIN;
  if (!ok) failed += 1;
  rows.push({
    сайт: c.adapter,
    страница: c.file.split('/')[1],
    что: c.what,
    КБ: Math.round(Buffer.byteLength(body) / 1024),
    cost: c.cost,
    'порог, мс': fmt(limit),
    'медиана, мс': fmt(med),
    'макс, мс': fmt(Math.max(...times)),
    'холодный, мс': fmt(cold) + (cold > c.cost ? ' !' : ''),
    итог: ok ? (tight ? 'мало запаса' : 'ok') : 'ПРЕВЫШЕН',
  });
}

console.table(rows);
console.log(`Node ${process.version}; прогрев ${WARMUP}, замеров ${RUNS}; порог — ${MS_PER_UNIT} мс × cost (медиана).`);
if (rows.some((r) => r.итог === 'мало запаса')) console.log(`«мало запаса» — медиана выше ${MS_PER_UNIT_MARGIN} мс × cost: сверить CPU этих лент в логах Worker'а.`);
if (rows.some((r) => r['холодный, мс'].endsWith('!'))) console.log('«!» — первый прогон дольше cost мс: предупреждение, не ошибка.');
if (failed) {
  console.error(`Превышено: ${failed} из ${rows.length}. Поднимите cost ленты или ускорьте разбор.`);
  process.exit(1);
}
console.log(`Все ${rows.length} страниц укладываются в cost.`);
