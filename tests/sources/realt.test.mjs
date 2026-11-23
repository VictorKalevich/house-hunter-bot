// Адаптер realt.by на сохранённых страницах (contracts/source-adapter.md, раздел «Тесты»).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import realt from '../../src/sources/realt.js';
import { isAllowed, parseRobots } from '../../src/sources/robots.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/realt/${name}`, import.meta.url), 'utf8');
const feed = (key) => realt.feeds.find((f) => f.key === key);
const MARKER = '<script id="__NEXT_DATA__"';
const LT = String.fromCharCode(92) + 'u003c';

/** Данные страницы как есть — для сверки с результатом адаптера. */
function nextData(html) {
  const start = html.indexOf('>', html.indexOf(MARKER)) + 1;
  return JSON.parse(html.slice(start, html.indexOf('</script>', start)));
}

/** Страница из pageProps; «<» экранируется, как у Next.js. */
function pageWith(pageProps) {
  const json = JSON.stringify({ props: { pageProps } }).replaceAll('<', LT);
  return `<!DOCTYPE html><html><body>${MARKER} type="application/json">${json}</script></body></html>`;
}

const PAGES = [
  { file: 'region-brest.html', feed: 'brest-region:cottages', page: 1, count: 30, total: 2136 },
  { file: 'region-brest-p2.html', feed: 'brest-region:cottages', page: 2, count: 30, total: 2136 },
  { file: 'minsk-oblast.html', feed: 'minsk-region:cottages', page: 1, count: 150, total: 4163 },
  { file: 'dachi.html', feed: 'minsk-region:dachi', page: 1, count: 120, total: 1571 },
];
for (const p of PAGES) {
  p.html = fixture(p.file);
  p.pageProps = nextData(p.html).props.pageProps;
  p.result = realt.parsePage(p.html, { feed: feed(p.feed), page: p.page });
  p.byId = new Map(p.result.items.map((it) => [it.externalId, it]));
}
const [brest, brestP2, minsk, dachi] = PAGES;

const KEYS = [
  'externalId', 'url', 'kind', 'paid', 'price', 'priceCurrency', 'priceUsd', 'priceByn', 'houseArea', 'plotArea', 'coords', 'place',
  'publishedAt', 'siteCreatedAt', 'photoUrl',
].sort();
const isIso = (s) => typeof s === 'string' && new Date(s).toISOString() === s;

test('число объявлений и счётчик выдачи на каждой странице', () => {
  for (const p of PAGES) {
    const r = p.result;
    assert.equal(r.looksValid, true, p.file);
    assert.equal(r.wrongSection, false, p.file);
    assert.equal(r.nextCursor, null, p.file);
    assert.equal(r.items.length, p.count, p.file);
    assert.equal(r.total, p.total, p.file);
  }
});

test('обязательные поля и форматы у всех объявлений', () => {
  for (const p of PAGES) {
    for (const it of p.result.items) {
      const where = `${p.file} ${it.externalId}`;
      assert.deepEqual(Object.keys(it).sort(), KEYS, where);
      assert.match(it.externalId, /^\d+$/, where);
      assert.match(it.url, /^https:\/\/realt\.by\/([a-z]+-region\/)?sale-(cottages|dachi)\/object\/\d+\/$/, where);
      assert.ok(it.url.endsWith(`/object/${it.externalId}/`), where);
      assert.ok(['house', 'dacha', 'cottage', 'part'].includes(it.kind), where);
      assert.equal(typeof it.paid, 'boolean', where);
      if (it.price) {
        assert.ok(it.price.amount > 0, where);
        assert.ok(['USD', 'BYN', 'EUR'].includes(it.price.currency), where);
      }
      for (const k of ['priceUsd', 'priceByn']) assert.ok(it[k] === null || it[k] > 0, where);
      if (it.houseArea) assert.ok(it.houseArea.value > 0 && it.houseArea.unit === 'm2', where);
      if (it.plotArea) assert.ok(it.plotArea.value > 0 && it.plotArea.unit === 'sotki', where);
      assert.ok(typeof it.place.text === 'string' && it.place.text.length > 0, where);
      assert.ok(it.publishedAt === null || isIso(it.publishedAt), where);
      assert.ok(isIso(it.siteCreatedAt), where);
      assert.ok(it.photoUrl === null || it.photoUrl.startsWith('https://'), where);
    }
  }
});

test('ссылки объявлений совпадают со ссылками на странице', () => {
  for (const p of PAGES) {
    const markup = p.html.slice(0, p.html.indexOf(MARKER));
    const hrefs = [...markup.matchAll(/href="(\/[^"]*\/object\/(\d+)\/)"/g)];
    assert.ok(hrefs.length >= 15, p.file);
    for (const [, href, code] of hrefs) assert.equal(p.byId.get(code)?.url, `https://realt.by${href}`, p.file);
  }
  assert.equal(brest.byId.get('4260667').url, 'https://realt.by/brest-region/sale-cottages/object/4260667/');
  assert.ok(minsk.result.items.every((it) => it.url.startsWith('https://realt.by/sale-cottages/object/')));
  assert.ok(dachi.result.items.every((it) => it.url.startsWith('https://realt.by/sale-dachi/object/')));
});

test('/sale/cottages/ и /sale/dachi/ — Минская область, а не вся страна', () => {
  for (const p of [minsk, dachi]) {
    assert.ok(p.result.items.every((it) => it.place.region === 'Минская область'), p.file);
  }
});

test('цена, площади и место распознаны у ≥ 95 % объявлений, где сайт их показывает', () => {
  const fields = [
    ['price', (o) => o.price > 0],
    ['houseArea', (o) => o.areaTotal > 0],
    ['plotArea', (o) => o.areaLand > 0],
    ['coords', (o) => Array.isArray(o.location)],
    ['place', (o) => Boolean(o.townName)],
  ];
  for (const p of PAGES) {
    for (const [field, shown] of fields) {
      const withField = p.pageProps.objects.filter(shown);
      const found = withField.filter((o) => {
        const v = p.byId.get(String(o.code))?.[field];
        return field === 'place' ? Boolean(v?.settlement) : v != null;
      });
      assert.ok(withField.length > 0, `${p.file} ${field}`);
      assert.ok(found.length / withField.length >= 0.95, `${p.file} ${field}: ${found.length}/${withField.length}`);
    }
  }
});

test('платные помечены: блок сверху первой страницы, на второй — только бесплатные', () => {
  const paid = brest.result.items.map((it) => it.paid);
  assert.ok(paid.includes(true) && paid.includes(false));
  assert.ok(paid.lastIndexOf(true) < paid.indexOf(false), 'платные идут выше бесплатных');
  assert.equal(brestP2.result.items.filter((it) => it.paid).length, 0);
  for (const p of PAGES) {
    for (const o of p.pageProps.objects) assert.equal(p.byId.get(String(o.code)).paid, o.paymentStatus > 0);
  }
});

test('createdAt → siteCreatedAt, updatedAt → publishedAt (ISO, UTC)', () => {
  for (const p of PAGES) {
    for (const o of p.pageProps.objects) {
      const it = p.byId.get(String(o.code));
      assert.equal(it.siteCreatedAt, new Date(o.createdAt).toISOString());
      assert.equal(it.publishedAt, new Date(o.updatedAt).toISOString());
    }
  }
  assert.equal(brest.byId.get('4260667').siteCreatedAt, '2026-10-19T14:57:11.000Z');
});

test('objectType расшифрован: дом, полдома, коттедж, дача', () => {
  const count = (items) => items.reduce((acc, it) => ({ ...acc, [it.kind]: (acc[it.kind] ?? 0) + 1 }), {});
  assert.deepEqual(count(brest.result.items), { house: 27, part: 2, cottage: 1 });
  assert.deepEqual(count(dachi.result.items), { dacha: 120 });
  const expected = { 1: 'house', 2: 'part', 3: 'dacha', 4: 'cottage' };
  for (const p of PAGES) {
    for (const o of p.pageProps.objects) assert.equal(p.byId.get(String(o.code)).kind, expected[o.objectType]);
  }
});

test('чужие типы и категории отброшены, таунхаус — часть дома', () => {
  const pageProps = structuredClone(brest.pageProps);
  const [plot, townhouse, flat, agro, other] = pageProps.objects;
  plot.objectType = 11;
  townhouse.objectType = 12;
  flat.objectType = 50;
  agro.objectType = 5;
  other.category = 77;
  const r = realt.parsePage(pageWith(pageProps), { feed: feed('brest-region:cottages'), page: 1 });
  assert.equal(r.looksValid, true);
  assert.equal(r.items.length, 26);
  const ids = new Set(r.items.map((it) => it.externalId));
  for (const o of [plot, flat, agro, other]) assert.ok(!ids.has(String(o.code)), `${o.code} отброшен`);
  assert.equal(r.items.find((it) => it.externalId === String(townhouse.code)).kind, 'part');
});

test('координаты: location = [lon, lat] → { lat, lon } в границах Беларуси', () => {
  for (const p of PAGES) {
    for (const it of p.result.items) {
      assert.ok(it.coords, `${p.file} ${it.externalId}`);
      assert.ok(it.coords.lat >= 51 && it.coords.lat <= 56.5, `${p.file} ${it.externalId} lat`);
      assert.ok(it.coords.lon >= 23 && it.coords.lon <= 33, `${p.file} ${it.externalId} lon`);
    }
  }
  assert.deepEqual(brest.byId.get('4260667').coords, { lat: 52.160560827, lon: 23.674624599 });
});

test('цена: исходная валюта, $ и BYN с сайта; нет цены → null', () => {
  const it = brest.byId.get('4260667');
  assert.deepEqual(it.price, { amount: 750000, currency: 'BYN' });
  assert.equal(it.priceUsd, 250476);
  assert.equal(it.priceByn, 750000);
  assert.deepEqual(dachi.byId.get('4198567').price, { amount: 22500, currency: 'USD' });

  const pageProps = structuredClone(brest.pageProps);
  const [none, rub] = pageProps.objects;
  Object.assign(none, { price: 0, priceRates: {} });
  Object.assign(rub, { price: 20502447, priceCurrency: 643 });
  const r = realt.parsePage(pageWith(pageProps), { feed: feed('brest-region:cottages'), page: 1 });
  const got = new Map(r.items.map((x) => [x.externalId, x]));
  const noPrice = got.get(String(none.code));
  assert.equal(noPrice.price, null);
  assert.equal(noPrice.priceUsd, null);
  assert.equal(noPrice.priceByn, null);
  assert.deepEqual(got.get(String(rub.code)).price, { amount: rub.priceRates['840'], currency: 'USD' });
});

test('площади: дом в м², участок в сотках; место как на сайте', () => {
  const it = brest.byId.get('4260667');
  assert.deepEqual(it.houseArea, { value: 450, unit: 'm2' });
  assert.deepEqual(it.plotArea, { value: 25, unit: 'sotki' });
  assert.ok(brest.html.includes('>25 соток<'), 'сайт показывает участок в сотках');
  assert.deepEqual(it.place, {
    text: 'д. Тюхиничи, Брестский р-н, Брестская область',
    settlement: 'Тюхиничи',
    district: 'Брестский район',
    region: 'Брестская область',
  });
  assert.equal(it.photoUrl, 'https://cdn.realt.by/img/55/887749de-da0f-11f1-97ba-a6cfe75afd90');

  const city = brestP2.pageProps.objects.find((o) => o.townType === 1 && o.townName === 'Брест');
  assert.equal(brestP2.byId.get(String(city.code)).place.text, 'г. Брест, Брестская область');
  const st = dachi.pageProps.objects.find((o) => o.townType === 7);
  assert.ok(dachi.byId.get(String(st.code)).place.text.startsWith(`с/т ${st.townName}, `));
});

test('страница защиты, страница без __NEXT_DATA__ и битый JSON → looksValid: false', () => {
  const html = brest.html;
  const start = html.indexOf('>', html.indexOf(MARKER)) + 1;
  const bodies = {
    'blocked.html': fixture('blocked.html'),
    'broken.html': fixture('broken.html'),
    'обрезанный JSON': `${html.slice(0, start + 5000)}</script></body></html>`,
    'без закрывающего тега': html.slice(0, start + 5000),
    'пустой ответ': '',
    'нет objects': pageWith({ objectsCategory: 11, totalCount: 5 }),
  };
  for (const [name, body] of Object.entries(bodies)) {
    const r = realt.parsePage(body, { feed: feed('brest-region:cottages'), page: 1 });
    assert.equal(r.looksValid, false, name);
    assert.deepEqual(r.items, [], name);
    assert.equal(r.wrongSection, false, name);
  }
});

test('чужой раздел → wrongSection, объявления не отдаются', () => {
  const cases = [
    [dachi.html, 'minsk-region:cottages'],
    [brest.html, 'brest-region:dachi'],
    [pageWith({ ...brest.pageProps, objectsCategory: 5 }), 'brest-region:cottages'],
  ];
  for (const [body, key] of cases) {
    const r = realt.parsePage(body, { feed: feed(key), page: 1 });
    assert.equal(r.looksValid, true, key);
    assert.equal(r.wrongSection, true, key);
    assert.deepEqual(r.items, [], key);
  }
});

test('в результате нет контактов продавца', () => {
  for (const p of PAGES) assert.ok(p.html.includes('"contactName":"Продавец"'), `${p.file}: заглушки на месте`);
  const out = JSON.stringify(PAGES.map((p) => p.result));
  for (const s of ['Продавец', '+375 00 000-00-00', 'seller@example.com', 'contact', 'agency']) {
    assert.ok(!out.includes(s), s);
  }
});

test('сохранённые страницы обезличены', () => {
  for (const name of ['region-brest.html', 'region-brest-p2.html', 'minsk-oblast.html', 'dachi.html']) {
    const html = fixture(name);
    assert.doesNotMatch(html, /(?<!\d)375\d{9}(?!\d)/, name);
    assert.doesNotMatch(html, /\+375(?! 00 000-00-00)[\s(]*\d/, name);
    const emails = new Set(html.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []);
    assert.deepEqual([...emails], ['seller@example.com'], name);
    assert.doesNotMatch(html, /"contactName":"(?!Продавец")/, name);
  }
});

test('pageRequest: первая страница без параметров, дальше ?page=N', () => {
  assert.deepEqual(realt.pageRequest(feed('brest-region:cottages'), 1), {
    url: 'https://realt.by/brest-region/sale/cottages/',
    accept: 'text/html',
  });
  assert.deepEqual(realt.pageRequest(feed('brest-region:cottages'), 2), {
    url: 'https://realt.by/brest-region/sale/cottages/?page=2',
    accept: 'text/html',
  });
  assert.equal(realt.pageRequest(feed('minsk-region:dachi'), 1).url, 'https://realt.by/sale/dachi/');
  assert.equal(realt.pageRequest(feed('minsk-region:dachi'), 2).url, 'https://realt.by/sale/dachi/?page=2');
});

test('12 лент: 6 областей × дома и дачи, уникальные ключи и пути без параметров', () => {
  const { feeds } = realt;
  assert.equal(feeds.length, 12);
  assert.equal(new Set(feeds.map((f) => f.key)).size, 12);
  assert.equal(new Set(feeds.map((f) => f.path)).size, 12);
  for (const f of feeds) {
    assert.match(f.key, /^(minsk|brest|vitebsk|gomel|grodno|mogilev)-region:(cottages|dachi)$/, f.key);
    assert.match(f.path, /^\/([a-z]+-region\/)?sale\/(cottages|dachi)\/$/, f.key);
    assert.ok(!f.path.includes('?'), f.key);
    assert.equal(f.path.endsWith(`/${f.key.split(':')[1]}/`), true, f.key);
    assert.equal(f.maxPages, 2, f.key);
    assert.ok(Number.isInteger(f.cost) && f.cost >= 1 && f.cost <= 6, f.key);
  }
  assert.equal(feed('minsk-region:cottages').path, '/sale/cottages/');
  assert.equal(feed('minsk-region:cottages').cost, 5);
  assert.equal(feed('gomel-region:dachi').path, '/gomel-region/sale/dachi/');
  assert.equal(feed('gomel-region:dachi').cost, 2);
  assert.equal(realt.id, 'realt');
  assert.equal(realt.idKind, 'created_at');
  assert.equal(realt.origin, 'https://realt.by');
  assert.deepEqual(realt.allowHosts, ['realt.by']);
  assert.equal(realt.intervalMin, 20);
});

// Страница объявления для проверки понравившихся (specs/003-listing-likes/contracts/source-adapter.md).
test('parseCard: цена в валюте продавца, курсы и площади живого объявления', () => {
  assert.deepEqual(realt.parseCard(fixture('card.html')), {
    gone: false,
    price: { amount: 73000, currency: 'USD' },
    priceCurrency: 'USD',
    priceUsd: 73000,
    priceByn: 218781,
    houseArea: { value: 99.2, unit: 'm2' },
    plotArea: { value: 13.5, unit: 'sotki' },
  });
});

test('parseCard: archive и страница 404 сайта — снято; без данных — null', () => {
  assert.deepEqual(realt.parseCard(fixture('card-archived.html')), { gone: true });
  assert.deepEqual(realt.parseCard(fixture('card-404.html')), { gone: true });
  for (const body of ['<html></html>', '', null, pageWith({ objects: [] }), pageWith({ object: null })]) {
    assert.equal(realt.parseCard(body), null);
  }
});

test('parseCard: цена в рублях у продавца; без цены — null', () => {
  const object = { code: 1, price: 150000, priceCurrency: 933, priceRates: { 840: 50000, 933: 150000 }, areaTotal: 80, areaLand: 10, archive: 0 };
  const byn = realt.parseCard(pageWith({ object }));
  assert.deepEqual([byn.price, byn.priceCurrency, byn.priceUsd], [{ amount: 150000, currency: 'BYN' }, 'BYN', 50000]);
  const none = realt.parseCard(pageWith({ object: { ...object, price: null, priceRates: {} } }));
  assert.deepEqual([none.price, none.priceCurrency, none.priceUsd, none.priceByn], [null, null, null, null]);
});

test('cardRequest — адрес объявления; cardSample открыт в robots.txt', () => {
  const url = 'https://realt.by/brest-region/sale-cottages/object/3958190/';
  assert.deepEqual(realt.cardRequest({ id: 1, external_id: '3958190', url }), { url, accept: 'text/html' });
  const robots = parseRobots(readFileSync(new URL('../fixtures/robots/realt.txt', import.meta.url), 'utf8'));
  assert.ok(isAllowed(robots, realt.cardSample, 'house-hunter-bot/0.1.0'));
  assert.ok(isAllowed(robots, 'https://realt.by/brest-region/sale-cottages/object/3958190/', 'house-hunter-bot/0.1.0'));
});
