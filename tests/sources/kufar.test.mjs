// Адаптер kufar.by на сохранённых ответах API (contracts/source-adapter.md, «Тесты»).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import kufar from '../../src/sources/kufar.js';

const read = (name) => readFileSync(new URL(`../fixtures/kufar/${name}`, import.meta.url), 'utf8');
const feed = kufar.feeds[0];
const parse = (body, page = 1) => kufar.parsePage(body, { feed, page });

const page1 = read('page1.json');
const page2 = read('page2.json');
const raw1 = JSON.parse(page1);
const raw2 = JSON.parse(page2);

const KINDS = new Set(['house', 'dacha', 'cottage', 'part']);
const KEYS = [
  'externalId', 'url', 'kind', 'paid', 'price', 'priceUsd', 'priceByn', 'houseArea', 'plotArea', 'coords', 'place',
  'publishedAt', 'siteCreatedAt', 'photoUrl',
].sort();

const param = (ad, p) => ad.ad_parameters.find((x) => x.p === p);
const withAds = (raw, ads) => JSON.stringify({ ...raw, ads });
const cloneAd = (raw, i = 0) => structuredClone(raw.ads[i]);

test('page1: 30 объявлений, все типы известны, есть курсор и счётчик', () => {
  const r = parse(page1);
  assert.equal(r.looksValid, true);
  assert.equal(r.wrongSection, false);
  assert.equal(r.items.length, 30);
  assert.equal(r.total, 18318);
  assert.equal(r.nextCursor, raw1.pagination.pages.find((p) => p.label === 'next').token);
  const kinds = {};
  for (const i of r.items) kinds[i.kind] = (kinds[i.kind] ?? 0) + 1;
  assert.deepEqual(kinds, { house: 22, part: 2, dacha: 4, cottage: 2 });
});

test('page2 и последняя страница: «Прочее» отброшено, у последней нет курсора', () => {
  const r2 = parse(page2, 2);
  assert.equal(r2.items.length, 27);
  assert.ok(r2.nextCursor);
  assert.ok(r2.items.some((i) => i.kind === 'part'), 'таунхаус — part');

  const last = parse(read('last-page.json'), 3);
  assert.equal(last.looksValid, true);
  assert.equal(last.total, 3);
  assert.equal(last.items.length, 2);
  assert.equal(last.nextCursor, null);
});

test('обязательные поля и состав RawListing', () => {
  for (const r of [parse(page1), parse(page2, 2)]) {
    for (const i of r.items) {
      assert.deepEqual(Object.keys(i).sort(), KEYS);
      assert.match(i.externalId, /^\d+$/);
      const u = new URL(i.url);
      assert.equal(u.protocol, 'https:');
      assert.ok(kufar.allowHosts.includes(u.hostname), i.url);
      assert.ok(KINDS.has(i.kind), i.kind);
      assert.equal(typeof i.paid, 'boolean');
      assert.equal(i.siteCreatedAt, null);
      assert.ok(i.publishedAt === null || !Number.isNaN(Date.parse(i.publishedAt)));
      assert.deepEqual(Object.keys(i.place).sort(), ['district', 'region', 'settlement', 'text']);
    }
  }
});

test('первое объявление page1 разобрано точно', () => {
  const [i] = parse(page1).items;
  assert.deepEqual(i, {
    externalId: '1096499881',
    url: 'https://re.kufar.by/vi/1096499881',
    kind: 'house',
    paid: false,
    price: { amount: 75476.74, currency: 'USD' },
    priceUsd: 75476.74,
    priceByn: 226000,
    houseArea: { value: 89.6, unit: 'm2' },
    plotArea: { value: 18, unit: 'sotki' },
    coords: { lat: 52.140174, lon: 23.606369 },
    place: {
      text: '60 лет Октября ул, агрогородок Клейники, Клейниковский сельсовет, Брестский район, Брестская область',
      settlement: 'агрогородок Клейники',
      district: 'Брестский район',
      region: 'Брестская область',
    },
    publishedAt: '2026-11-22T12:13:00.000Z',
    siteCreatedAt: null,
    photoUrl: 'https://rms.kufar.by/v1/gallery/adim1/48bf8658-d265-43f6-8c42-d6540ef156de.jpg',
  });
});

test('цена, площади и место распознаны ≥ 95 % там, где сайт их показывает', () => {
  for (const [raw, body] of [[raw1, page1], [raw2, page2]]) {
    const byId = new Map(parse(body).items.map((i) => [i.externalId, i]));
    const shown = { price: 0, houseArea: 0, plotArea: 0, place: 0 };
    const found = { price: 0, houseArea: 0, plotArea: 0, place: 0 };
    for (const ad of raw.ads) {
      const item = byId.get(String(ad.ad_id));
      if (!item) continue;
      const has = {
        price: Number(ad.price_usd) > 0,
        houseArea: Number(param(ad, 'size')?.v) > 0,
        plotArea: Number(param(ad, 'size_area')?.v) > 0,
        place: Boolean(ad.account_parameters.find((x) => x.p === 'address')?.v),
      };
      const got = {
        price: item.price !== null && item.priceUsd !== null,
        houseArea: item.houseArea !== null,
        plotArea: item.plotArea !== null,
        place: Boolean(item.place.text && item.place.region),
      };
      for (const k of Object.keys(shown)) {
        if (!has[k]) continue;
        shown[k] += 1;
        if (got[k]) found[k] += 1;
      }
    }
    for (const k of Object.keys(shown)) {
      assert.ok(shown[k] > 0, k);
      assert.ok(found[k] / shown[k] >= 0.95, `${k}: ${found[k]} из ${shown[k]}`);
    }
  }
});

test('цена 0 → null, участок без площади → null', () => {
  const items = parse(page1).items;
  const noPrice = raw1.ads.find((ad) => ad.price_usd === '0');
  const item = items.find((i) => i.externalId === String(noPrice.ad_id));
  assert.equal(item.price, null);
  assert.equal(item.priceUsd, null);
  assert.equal(item.priceByn, null);
  const noPlot = raw1.ads.find((ad) => !param(ad, 'size_area'));
  assert.equal(items.find((i) => i.externalId === String(noPlot.ad_id)).plotArea, null);
});

test('координаты — [lon, lat] → {lat, lon}, все в границах Беларуси', () => {
  for (const r of [parse(page1), parse(page2, 2)]) {
    const withCoords = r.items.filter((i) => i.coords);
    assert.equal(withCoords.length, r.items.length);
    for (const { coords } of withCoords) {
      assert.ok(coords.lat >= 51 && coords.lat <= 56.5, `lat ${coords.lat}`);
      assert.ok(coords.lon >= 23 && coords.lon <= 33, `lon ${coords.lon}`);
    }
  }
});

test('населённый пункт, район и область из адреса', () => {
  const cases = [
    ['Вежновца ул, 3, городской посёлок Городище, Городищенский сельсовет, Барановичский район, Брестская область',
      'Другие города', 'городской посёлок Городище', 'Барановичский район'],
    ['микрорайон Козловичи, Брест, Брестская область', 'Брест', 'Брест', null],
    ['12, СТ Птицевод, Лошанский сельсовет, Минский район, Минская область', 'Минский район', null, 'Минский район'],
    ['Н-2115, Витебская область', 'Другие города', null, null],
    ['Минская область', 'Минский район', null, 'Минский район'],
  ];
  const ads = cases.map(([address, area], n) => {
    const ad = cloneAd(raw1);
    ad.ad_id += n + 1;
    ad.ad_link = `https://re.kufar.by/vi/${ad.ad_id}`;
    ad.account_parameters.find((x) => x.p === 'address').v = address;
    param(ad, 'area').vl = area;
    return ad;
  });
  const { items } = parse(withAds(raw1, ads));
  assert.equal(items.length, cases.length);
  cases.forEach(([address, , settlement, district], n) => {
    assert.equal(items[n].place.text, address);
    assert.equal(items[n].place.settlement, settlement, address);
    assert.equal(items[n].place.district, district, address);
    assert.equal(items[n].place.region, 'Брестская область');
  });
});

test('чужие типы и чужие ссылки отброшены', () => {
  const ads = structuredClone(raw1.ads);
  Object.assign(param(ads[0], 'house_type_for_sell'), { v: '20', vl: 'Прочее' });
  ads[1].ad_parameters = ads[1].ad_parameters.filter((x) => x.p !== 'house_type_for_sell');
  Object.assign(param(ads[2], 'house_type_for_sell'), { v: '99', vl: 'Квартира' });
  ads[3].ad_link = `http://re.kufar.by/vi/${ads[3].ad_id}`;
  ads[4].ad_link = `https://kufar.example.com/vi/${ads[4].ad_id}`;
  ads[5].ad_id = null;
  Object.assign(param(ads[6], 'house_type_for_sell'), { v: '99', vl: 'Полдома' });
  const dropped = new Set(raw1.ads.slice(0, 6).map((ad) => String(ad.ad_id)));

  const { items, looksValid } = parse(withAds(raw1, [...ads, null, 7, {}, { ad_parameters: 'x' }]));
  assert.equal(looksValid, true);
  assert.equal(items.length, 24);
  assert.ok(items.every((i) => !dropped.has(i.externalId)));
  assert.equal(items.find((i) => i.externalId === String(raw1.ads[6].ad_id)).kind, 'part');
});

test('платное — только закрепление (polepos); выделение цветом не платное', () => {
  const highlighted = raw1.ads.filter((ad) => ad.paid_services.highlight).length;
  assert.ok(highlighted > 0);
  assert.ok(parse(page1).items.every((i) => i.paid === false));

  const ads = structuredClone(raw1.ads);
  ads[0].paid_services.polepos = true;
  const { items } = parse(withAds(raw1, ads));
  assert.equal(items[0].paid, true);
  assert.ok(items.slice(1).every((i) => i.paid === false));
});

test('пустая выдача: валидна, total 0', () => {
  const r = parse(read('empty.json'));
  assert.deepEqual(r, { items: [], nextCursor: null, total: 0, looksValid: true, wrongSection: false, state: null });
});

test('страница проверки браузера, битый JSON и JSON без ads → looksValid: false', () => {
  const bodies = [read('blocked.html'), page1.slice(0, 5000), '', 'null', '{"error":"Bad Request"}', '[]'];
  for (const body of bodies) {
    const r = parse(body);
    assert.equal(r.looksValid, false, body.slice(0, 40));
    assert.deepEqual(r.items, []);
    assert.equal(r.nextCursor, null);
  }
});

test('контактов продавца в результате нет', () => {
  for (const body of [page1, page2, read('last-page.json')]) {
    assert.ok(body.includes('Продавец'), 'в сохранённом ответе есть заглушка имени');
    const out = JSON.stringify(parse(body));
    for (const s of ['Продавец', '+375 00', 'seller@example.com', 'Агентство', 'account']) {
      assert.ok(!out.includes(s), s);
    }
    assert.doesNotMatch(out, /"(name|phone|email|contact\w*|account\w*|vat_number|company\w*)"\s*:/);
  }
});

test('pageRequest: страница 1 без курсора, следующие — с курсором', () => {
  const base =
    'https://api.kufar.by/search-api/v2/search/rendered-paginated?cat=1020&typ=sell&sort=lst.d&size=30&lang=ru';
  const p1 = kufar.pageRequest(feed, 1, null, null);
  assert.deepEqual(p1, { url: base, accept: 'application/json' });
  assert.ok(!p1.url.includes('cursor='));

  const token = raw1.pagination.pages.find((p) => p.label === 'next').token;
  const p2 = kufar.pageRequest(feed, 2, token, null);
  assert.equal(p2.url, `${base}&cursor=${encodeURIComponent(token)}`);
  assert.equal(new URL(p2.url).searchParams.get('cursor'), token);
  assert.equal(p2.accept, 'application/json');

  assert.throws(() => kufar.pageRequest(feed, 2, null, null));
});

test('описание источника', () => {
  assert.equal(kufar.id, 'kufar');
  assert.equal(kufar.idKind, 'numeric');
  assert.equal(kufar.intervalMin, 15);
  assert.equal(new URL(kufar.origin).hostname, 're.kufar.by');
  assert.deepEqual(feed, {
    key: 'kufar:all',
    path: '/search-api/v2/search/rendered-paginated?cat=1020&typ=sell&sort=lst.d&size=30&lang=ru',
    maxPages: 3,
    cost: 2,
  });
});
