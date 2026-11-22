// Адаптер domovita.by на сохранённых ответах `_next/data` и HTML раздела (contracts/source-adapter.md, «Тесты»).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import domovita from '../../src/sources/domovita.js';

const read = (name) => readFileSync(new URL(`../fixtures/domovita/${name}`, import.meta.url), 'utf8');
const feedOf = (slug) => domovita.feeds.find((f) => f.key === `${slug}:houses`);
const parse = (body, slug = 'gomelskaya-oblast', page = 1) => domovita.parsePage(body, { feed: feedOf(slug), page });

const gomel = read('houses-gomel-p2.json');
const brest = read('houses-brest-p1.json');
const minskRegion = read('houses-minskaya-oblast-p1.json');
const PAGES = [[gomel, 'gomelskaya-oblast'], [brest, 'brestskaya-oblast'], [minskRegion, 'minskaya-oblast']];

const KINDS = new Set(['house', 'dacha', 'cottage', 'part']);
const KEYS = [
  'externalId', 'url', 'kind', 'paid', 'price', 'priceUsd', 'priceByn', 'houseArea', 'plotArea', 'coords', 'place',
  'publishedAt', 'siteCreatedAt', 'photoUrl',
].sort();
const PLACEHOLDERS = ['+375 00 000-00-00', 'seller@example.com', 'Продавец'];

const withItems = (body, mutate) => {
  const raw = JSON.parse(body);
  raw.pageProps.listingCardsFromSSR.items = mutate(raw.pageProps.listingCardsFromSSR.items);
  return JSON.stringify(raw);
};
const firstWith = (body, patch) => parse(withItems(body, (items) => [{ ...items[0], ...patch }])).items;

test('ленты: 7 регионов, раздел «Дома», Минская область — до 3 страниц', () => {
  assert.equal(domovita.id, 'domovita');
  assert.equal(domovita.idKind, 'created_at');
  assert.equal(domovita.resetStateOn404, true);
  assert.deepEqual(domovita.allowHosts, ['domovita.by']);
  assert.deepEqual(domovita.feeds.map((f) => f.path), [
    '/minsk/houses/sale', '/minskaya-oblast/houses/sale', '/brestskaya-oblast/houses/sale',
    '/vitebskaya-oblast/houses/sale', '/gomelskaya-oblast/houses/sale', '/grodnenskaya-oblast/houses/sale',
    '/mogilevskaya-oblast/houses/sale',
  ]);
  assert.equal(new Set(domovita.feeds.map((f) => f.key)).size, 7);
  for (const f of domovita.feeds) {
    assert.equal(f.maxPages, f.key === 'minskaya-oblast:houses' ? 3 : 2, f.key);
    assert.ok(f.cost > 0);
  }
});

test('страницы выдачи: число объявлений, счётчик, типы', () => {
  const g = parse(gomel);
  assert.equal(g.looksValid, true);
  assert.equal(g.wrongSection, false);
  assert.equal(g.items.length, 18);
  assert.equal(g.total, 224);
  assert.equal(g.nextCursor, null);
  const kinds = {};
  for (const i of g.items) kinds[i.kind] = (kinds[i.kind] ?? 0) + 1;
  assert.deepEqual(kinds, { house: 16, part: 2 });

  const b = parse(brest, 'brestskaya-oblast');
  assert.equal(b.items.length, 18);
  assert.equal(b.total, 566);

  const m = parse(minskRegion, 'minskaya-oblast');
  assert.equal(m.items.length, 18);
  assert.equal(m.total, 1863);
  assert.equal(m.items.find((i) => i.externalId === '656907').kind, 'part', 'Дуплекс, полдома');
});

test('платные (is_vip = 3) помечены и идут сверху', () => {
  const m = parse(minskRegion, 'minskaya-oblast').items;
  assert.deepEqual(m.map((i) => i.paid), [...Array(8).fill(true), ...Array(10).fill(false)]);
  assert.equal(parse(gomel).items.filter((i) => i.paid).length, 0);
  assert.equal(parse(brest, 'brestskaya-oblast').items.filter((i) => i.paid).length, 0);
});

test('обязательные поля и состав RawListing', () => {
  for (const [body, slug] of PAGES) {
    for (const i of parse(body, slug).items) {
      assert.deepEqual(Object.keys(i).sort(), KEYS);
      assert.match(i.externalId, /^\d+$/);
      const u = new URL(i.url);
      assert.equal(u.protocol, 'https:');
      assert.equal(u.hostname, 'domovita.by');
      assert.ok(KINDS.has(i.kind), i.kind);
      assert.equal(typeof i.paid, 'boolean');
      assert.ok(!Number.isNaN(Date.parse(i.siteCreatedAt)), i.siteCreatedAt);
      assert.ok(Date.parse(i.publishedAt) >= Date.parse(i.siteCreatedAt), i.externalId);
      assert.deepEqual(Object.keys(i.place).sort(), ['district', 'region', 'settlement', 'text']);
      assert.match(i.photoUrl, /^https:\/\/s\.domovita\.by\//);
    }
  }
});

test('первое объявление страницы разобрано точно', () => {
  assert.deepEqual(parse(gomel).items[0], {
    externalId: '658296',
    url: 'https://domovita.by/rechica/cottages/sale/ul-turcinskogo-1-7',
    kind: 'house',
    paid: false,
    price: { amount: 37800, currency: 'USD' },
    priceUsd: 37800,
    priceByn: 113286.6,
    houseArea: { value: 74.9, unit: 'm2' },
    plotArea: { value: 7, unit: 'sotki' },
    coords: { lat: 52.3691, lon: 30.375 },
    place: {
      text: 'г. Речица, Речицкий р-н, ул. Турчинского',
      settlement: 'Речица',
      district: 'Речицкий р-н',
      region: 'Гомельская область',
    },
    publishedAt: '2026-11-18T21:00:00.000Z',
    siteCreatedAt: '2026-04-09T01:16:05.000Z',
    photoUrl: 'https://s.domovita.by/images/3c/1f6b4db8ebb8fa75e4db4d62b378551d.webp',
  });
});

test('даты: date_reception — время Минска (UTC+3), date_revision — день поднятия', () => {
  const items = parse(minskRegion, 'minskaya-oblast').items;
  // Создано и поднято в один день: дата публикации — точное время создания.
  const fresh = items.find((i) => i.externalId === '664446');
  assert.equal(fresh.siteCreatedAt, '2026-11-22T10:51:41.000Z');
  assert.equal(fresh.publishedAt, fresh.siteCreatedAt);
  // Создано в августе, поднято 22.11: начало дня по Минску.
  const raised = items.find((i) => i.externalId === '661843');
  assert.equal(raised.siteCreatedAt, '2026-08-03T15:04:19.000Z');
  assert.equal(raised.publishedAt, '2026-11-21T21:00:00.000Z');

  const [noRevision] = firstWith(gomel, { date_revision: null });
  assert.equal(noRevision.publishedAt, noRevision.siteCreatedAt);
  const [broken] = firstWith(gomel, { date_reception: '09.04.2026', date_revision: '2026-13-01' });
  assert.equal(broken.siteCreatedAt, null);
  assert.equal(broken.publishedAt, null);
});

test('цена, площади и место распознаны ≥ 95 % там, где сайт их показывает', () => {
  for (const [body, slug] of PAGES) {
    const byId = new Map(parse(body, slug).items.map((i) => [i.externalId, i]));
    const shown = { price: 0, houseArea: 0, plotArea: 0, place: 0, district: 0 };
    const found = { price: 0, houseArea: 0, plotArea: 0, place: 0, district: 0 };
    for (const it of JSON.parse(body).pageProps.listingCardsFromSSR.items) {
      const item = byId.get(String(it.id));
      assert.ok(item, `объявление ${it.id} потеряно`);
      const has = {
        price: it.price?.USD > 0,
        houseArea: it.area?.total > 0,
        plotArea: it.area_ground > 0,
        place: Boolean(it.address?.town?.name),
        district: / р-н(,|$)/.test(it.title),
      };
      const got = {
        price: item.price !== null && item.priceUsd !== null && item.priceByn !== null,
        houseArea: item.houseArea !== null,
        plotArea: item.plotArea !== null,
        place: Boolean(item.place.text && item.place.settlement && item.place.region),
        district: Boolean(item.place.district),
      };
      for (const k of Object.keys(shown)) {
        if (!has[k]) continue;
        shown[k] += 1;
        if (got[k]) found[k] += 1;
      }
    }
    for (const k of Object.keys(shown)) {
      assert.ok(shown[k] > 0, `${slug}: ${k}`);
      assert.ok(found[k] / shown[k] >= 0.95, `${slug}: ${k} ${found[k]}/${shown[k]}`);
    }
  }
});

test('координаты: position_x — широта, position_y — долгота, в границах Беларуси', () => {
  for (const [body, slug] of PAGES) {
    for (const i of parse(body, slug).items) {
      assert.ok(i.coords, i.externalId);
      assert.ok(i.coords.lat >= 51 && i.coords.lat <= 56.5, `${i.externalId} lat ${i.coords.lat}`);
      assert.ok(i.coords.lon >= 23 && i.coords.lon <= 33, `${i.externalId} lon ${i.coords.lon}`);
    }
  }
  assert.equal(firstWith(gomel, { address: { coords: null } })[0].coords, null);
  assert.equal(firstWith(gomel, { address: { coords: { position_x: 0, position_y: 0 } } })[0].coords, null);
});

test('типы объектов: чужие отброшены, дома — по object_type и is_half_house', () => {
  const flat = JSON.parse(read('wrong-section.json')).pageProps.listingCardsFromSSR.items[0];
  const mixed = parse(withItems(gomel, (items) => [flat, ...items]));
  assert.equal(mixed.wrongSection, false);
  assert.equal(mixed.items.length, 18);
  assert.ok(!mixed.items.some((i) => i.externalId === String(flat.id)));

  const kind = (patch) => firstWith(gomel, patch)[0]?.kind ?? null;
  assert.equal(kind({ object_type: 'Дом', is_half_house: 0 }), 'house');
  assert.equal(kind({ object_type: 'Дом', is_half_house: 1 }), 'part');
  assert.equal(kind({ object_type: 'Таунхаус' }), 'part');
  assert.equal(kind({ object_type: 'Коттедж' }), 'cottage');
  assert.equal(kind({ object_type: 'Дача' }), 'dacha');
  assert.equal(kind({ object_type: 'Участок' }), null);
  assert.equal(kind({ type: 'OAreaSale' }), null);
});

test('ссылки, цены и площади: относительное дополняется, чужое и пустое отбрасывается', () => {
  const [rel] = firstWith(gomel, { url: '/rechica/cottages/sale/x-1', photos: [{ url: '/images/a.webp' }] });
  assert.equal(rel.url, 'https://domovita.by/rechica/cottages/sale/x-1');
  assert.equal(rel.photoUrl, 'https://domovita.by/images/a.webp');
  assert.deepEqual(firstWith(gomel, { url: 'https://evil.example/rechica/cottages/sale/x-1' }), []);
  assert.deepEqual(firstWith(gomel, { id: null }), []);

  const [empty] = firstWith(gomel, { price: { USD: 0, BYN: 0 }, area: { total: 0 }, area_ground: null, photos: [] });
  assert.equal(empty.price, null);
  assert.equal(empty.priceUsd, null);
  assert.equal(empty.priceByn, null);
  assert.equal(empty.houseArea, null);
  assert.equal(empty.plotArea, null);
  assert.equal(empty.photoUrl, null);
  const [bynOnly] = firstWith(gomel, { price: { BYN: 30000 } });
  assert.deepEqual(bynOnly.price, { amount: 30000, currency: 'BYN' });
});

test('чужой раздел: /dacha/sale отдал квартиры → wrongSection, без объявлений', () => {
  const body = read('wrong-section.json');
  for (const feed of [feedOf('gomelskaya-oblast'), { key: 'gomelskaya-oblast:dacha', path: '/gomelskaya-oblast/dacha/sale' }]) {
    const r = domovita.parsePage(body, { feed, page: 1 });
    assert.equal(r.wrongSection, true, feed.path);
    assert.deepEqual(r.items, []);
  }
  const relabeled = JSON.parse(gomel);
  relabeled.pageProps.pageSettingsByPath.urlParams.object = 'flats';
  assert.equal(parse(JSON.stringify(relabeled)).wrongSection, true);
});

test('buildId: из <script src=…/_buildManifest.js> в начале HTML, запасной — из __NEXT_DATA__', () => {
  const html = read('section.html');
  assert.deepEqual(domovita.parseState(html), { buildId: 'z30W-cmHbRTMuR1Zo07Xs' });
  const { readLimitBytes } = domovita.pageRequest(feedOf('minskaya-oblast'), 1, null, null);
  assert.ok(Buffer.byteLength(html.slice(0, html.indexOf('_buildManifest.js'))) < readLimitBytes / 2);

  const nextData = '<script id="__NEXT_DATA__" type="application/json">{"page":"/x","buildId":"abc_DEF-123"}</script>';
  assert.deepEqual(domovita.parseState(nextData), { buildId: 'abc_DEF-123' });
  assert.equal(domovita.parseState(read('blocked.html')), null);
  assert.equal(domovita.parseState('<script src="/_next/static/a/b/_buildManifest.js"></script>'), null);
  assert.equal(domovita.parseState('"buildId":"../../x"'), null);
  assert.equal(domovita.parseState(''), null);
});

test('pageRequest: без buildId — HTML раздела, с buildId — _next/data, ?page только со 2-й страницы', () => {
  const feed = feedOf('gomelskaya-oblast');
  const state = domovita.pageRequest(feed, 1, null, null);
  assert.equal(state.url, 'https://domovita.by/gomelskaya-oblast/houses/sale');
  assert.equal(state.accept, 'text/html');
  assert.equal(state.purpose, 'state');
  assert.ok(state.readLimitBytes > 0);
  assert.equal(domovita.pageRequest(feed, 2, null, { buildId: '../x' }).purpose, 'state');

  const s = { buildId: 'z30W-cmHbRTMuR1Zo07Xs' };
  assert.deepEqual(domovita.pageRequest(feed, 1, null, s), {
    url: 'https://domovita.by/_next/data/z30W-cmHbRTMuR1Zo07Xs/gomelskaya-oblast/houses/sale.json',
    accept: 'application/json',
    purpose: 'page',
  });
  assert.equal(
    domovita.pageRequest(feed, 2, null, s).url,
    'https://domovita.by/_next/data/z30W-cmHbRTMuR1Zo07Xs/gomelskaya-oblast/houses/sale.json?page=2',
  );
});

test('страница защиты, HTML и сломанный JSON → looksValid: false без исключения', () => {
  const bodies = [
    read('blocked.html'),
    read('section.html'),
    gomel.slice(0, 5000),
    '',
    'null',
    '{"pageProps":{"__N_REDIRECT":"/minsk"}}',
    '{"pageProps":{"listingCardsFromSSR":{"items":null}}}',
  ];
  for (const body of bodies) {
    const r = parse(body);
    assert.equal(r.looksValid, false, body.slice(0, 40));
    assert.deepEqual(r.items, []);
    assert.equal(r.wrongSection, false);
  }
});

test('контакты продавца и заглушки обезличивания в результат не попадают', () => {
  for (const [body, slug] of PAGES) {
    for (const p of PLACEHOLDERS) assert.ok(body.includes(p), `в фикстуре ${slug} есть «${p}»`);
    const out = JSON.stringify(parse(body, slug));
    for (const p of [...PLACEHOLDERS, 'contacts', 'phones', 'viber', 'email', 'contact_name']) {
      assert.ok(!out.includes(p), `${slug}: «${p}» в результате`);
    }
  }
});
