// Адаптер moyareklama.by на сохранённых страницах (contracts/source-adapter.md, «Тесты»).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import moyareklama from '../../src/sources/moyareklama.js';
import { isAllowed, parseRobots } from '../../src/sources/robots.js';

const read = (name) => readFileSync(new URL(`../fixtures/moyareklama/${name}`, import.meta.url), 'utf8');
const feed = (key) => moyareklama.feeds.find((f) => f.key === key);
const gomel = feed('gomel');
const gomelDistrict = feed('gomel-district');
const parse = (body, f = gomel) => moyareklama.parsePage(body, { feed: f, page: 1 });

const section = read('section.html');
const subsection = read('subsection.html');
const card = read('card.html');

const KINDS = new Set(['house', 'dacha', 'cottage', 'part']);
const KEYS = [
  'externalId', 'url', 'kind', 'paid', 'price', 'priceCurrency', 'priceUsd', 'priceByn', 'houseArea', 'plotArea', 'coords', 'place',
  'publishedAt', 'siteCreatedAt', 'photoUrl',
].sort();

const byId = (r, id) => r.items.find((i) => i.externalId === id);
const countKinds = (items) => {
  const kinds = {};
  for (const i of items) kinds[i.kind] = (kinds[i.kind] ?? 0) + 1;
  return kinds;
};
const listPage = (path, countAds) => `<!DOCTYPE html><html><body><div class="all_advert_list"></div>
<script>var listParams = ${JSON.stringify({ count_on_page: 20, countAds: String(countAds), path, page: 1 })};</script>
</body></html>`;

test('раздел Гомеля: 20 объявлений, счётчик 696, раздел тот', () => {
  const r = parse(section);
  assert.equal(r.looksValid, true);
  assert.equal(r.wrongSection, false);
  assert.equal(r.nextCursor, null);
  assert.equal(r.total, 696);
  assert.equal(r.items.length, 20);
  assert.deepEqual(countKinds(r.items), { house: 12, part: 2, cottage: 2, dacha: 4 });
});

test('подраздел Гомельского района: 20 объявлений, счётчик 267', () => {
  const r = parse(subsection, gomelDistrict);
  assert.equal(r.looksValid, true);
  assert.equal(r.wrongSection, false);
  assert.equal(r.total, 267);
  assert.equal(r.items.length, 20);
  assert.deepEqual(countKinds(r.items), { house: 7, dacha: 10, part: 3 });
});

test('обязательные поля и состав RawListing', () => {
  for (const r of [parse(section), parse(subsection, gomelDistrict)]) {
    for (const i of r.items) {
      assert.deepEqual(Object.keys(i).sort(), KEYS);
      assert.match(i.externalId, /^\d+$/);
      assert.equal(i.url, `https://www.moyareklama.by/single/ad/${i.externalId}`);
      assert.ok(moyareklama.allowHosts.includes(new URL(i.url).hostname), i.url);
      assert.ok(KINDS.has(i.kind), i.kind);
      assert.equal(typeof i.paid, 'boolean');
      assert.equal(i.priceUsd, null);
      assert.equal(i.coords, null);
      assert.equal(i.siteCreatedAt, null);
      assert.ok(i.publishedAt === null || !Number.isNaN(Date.parse(i.publishedAt)));
      assert.deepEqual(Object.keys(i.place).sort(), ['district', 'region', 'settlement', 'text']);
      assert.ok(i.place.text.length > 0);
    }
  }
});

test('первое объявление разобрано точно', () => {
  const [i] = parse(section).items;
  assert.deepEqual(i, {
    externalId: '211245530',
    url: 'https://www.moyareklama.by/single/ad/211245530',
    kind: 'house',
    paid: true,
    price: { amount: 312000, currency: 'BYN' },
    priceCurrency: 'BYN',
    priceUsd: null,
    priceByn: 312000,
    houseArea: { value: 235, unit: 'm2' },
    plotArea: { value: 10, unit: 'sotki' },
    coords: null,
    place: {
      text: 'Гомельский р-н, аг. Поколюбичи, ул. Луговая',
      settlement: 'Поколюбичи',
      district: 'Гомельский р-н',
      region: 'Гомельская область',
    },
    publishedAt: new Date('2026-11-22T00:00:00+03:00').toISOString(),
    siteCreatedAt: null,
    photoUrl: 'https://media1.moyareklama.by/i/p/medium/202502/20250225135825_4e1ab6c5d574e4e48464130e4275bb3f.jpg',
  });
});

test('заголовок: «Часть дома 77,8 м² на участке 6,9 сот.», усадьба, доля, полдома', () => {
  const r = parse(section);
  const part = byId(r, '211397401');
  assert.equal(part.kind, 'part');
  assert.deepEqual(part.houseArea, { value: 77.8, unit: 'm2' });
  assert.deepEqual(part.plotArea, { value: 6.9, unit: 'sotki' });
  assert.equal(byId(r, '211044789').kind, 'house', 'Усадьба 420 м² на участке 80 сот.');
  assert.equal(byId(r, '211388399').kind, 'cottage');
  assert.equal(byId(r, '211409832').kind, 'part', 'Полдома');

  const sub = parse(subsection, gomelDistrict);
  assert.equal(byId(sub, '211392163').kind, 'part', 'Доля 41 м² на участке 12,9 сот.');
  assert.equal(byId(sub, '211400418').kind, 'dacha');
});

test('участок в гектарах и без площади дома', () => {
  const body = section.replace('Дом 235 м&sup2; на участке 10 сот.', 'Дом на участке 1,5 га');
  const i = byId(parse(body), '211245530');
  assert.equal(i.houseArea, null);
  assert.deepEqual(i.plotArea, { value: 1.5, unit: 'ha' });
});

test('цена «312 000 р.» → 312000 BYN; пустой блок цены → null', () => {
  const r = parse(section);
  assert.deepEqual(byId(r, '211245530').price, { amount: 312000, currency: 'BYN' });
  assert.deepEqual(byId(r, '211044789').price, { amount: 1100000, currency: 'BYN' });
  for (const id of ['211412585', '211427680', '211430380']) {
    assert.equal(byId(r, id).price, null, id);
    assert.equal(byId(r, id).priceByn, null, id);
  }
});

test('адрес: пункт и район; районы Гомеля → «Гомель» без района', () => {
  const r = parse(section);
  const place = (id) => byId(r, id).place;
  assert.deepEqual(place('211397401'), {
    text: 'Советский р-н, ул. Гоголя', settlement: 'Гомель', district: null, region: 'Гомельская область',
  });
  assert.equal(place('211430380').settlement, 'Гомель', 'Новобелицкий р-н, г. Гомель, пер. Поветовый');
  assert.equal(place('211193126').settlement, 'Гомель', 'Железнодорожный р-н, ул. Ломоносова (Костюковка)');
  assert.deepEqual([place('211097108').settlement, place('211097108').district], ['Жлобин', 'Жлобинский р-н']);
  assert.deepEqual([place('211400418').settlement, place('211400418').district], ['Хуторянка', 'Гомельский р-н']);
  assert.deepEqual(
    [place('211346931').settlement, place('211346931').district],
    [null, 'Буда-Кошелевский р-н'],
    'садовое товарищество — не населённый пункт',
  );
  assert.equal(place('211399931').settlement, null, 'Речицкий р-н, СТ Лесное-Копань, д. 41 — «д. 41» не деревня');
});

test('адрес вне Гомельской области: область не подставляется', () => {
  const body = section.replace('Гомельский р-н, аг. Поколюбичи, ул. Луговая', 'Минский р-н, д. Боровляны');
  assert.deepEqual(byId(parse(body), '211245530').place, {
    text: 'Минский р-н, д. Боровляны', settlement: 'Боровляны', district: 'Минский р-н', region: null,
  });
});

test('платные (класс premium) помечены', () => {
  const r = parse(section);
  assert.equal(r.items.filter((i) => i.paid).length, 16);
  assert.deepEqual(r.items.slice(16).map((i) => i.paid), [false, false, false, false]);
  assert.equal(parse(subsection, gomelDistrict).items.filter((i) => i.paid).length, 4);
});

test('фото — из style первого div.small_img, абсолютная https-ссылка', () => {
  for (const r of [parse(section), parse(subsection, gomelDistrict)]) {
    for (const i of r.items) assert.match(i.photoUrl, /^https:\/\/media1\.moyareklama\.by\/i\/p\/medium\/\S+\.jpg$/);
  }
  const relative = section.replace(
    "url('https://media1.moyareklama.by/i/p/medium/202502/20250225135825_4e1ab6c5d574e4e48464130e4275bb3f.jpg')",
    "url('/i/p/medium/a.jpg')",
  );
  assert.equal(parse(relative).items[0].photoUrl, 'https://www.moyareklama.by/i/p/medium/a.jpg');
});

test('дата: «22.11.2026» — полночь по Минску; относительная — null', () => {
  const r = parse(section);
  assert.equal(Date.parse(r.items[0].publishedAt), Date.parse('2026-11-22T00:00:00+03:00'));
  assert.equal(Date.parse(byId(r, '211097108').publishedAt), Date.parse('2026-11-20T00:00:00+03:00'));
  const today = section.replace(/(id="date_211245530" class="date">)\s*22\.11\.2026/, '$1 сегодня');
  assert.equal(byId(parse(today), '211245530').publishedAt, null);
});

test('доля распознанных цены, площадей и места ≥ 95 % там, где сайт их показывает', () => {
  for (const [body, f] of [[section, gomel], [subsection, gomelDistrict]]) {
    const { items } = parse(body, f);
    const shownPrices = body.match(/<div class="price">/g).length;
    assert.ok(items.filter((i) => i.price).length >= shownPrices * 0.95);
    assert.ok(items.filter((i) => i.houseArea).length >= items.length * 0.95);
    assert.ok(items.filter((i) => i.plotArea).length >= items.length * 0.95);
    assert.ok(items.filter((i) => i.place.settlement || i.place.district).length >= items.length * 0.95);
  }
});

test('чужие типы объектов отброшены', () => {
  const body = section.replace('Дом 235 м&sup2; на участке 10 сот.', 'Участок 10 сот.');
  const r = parse(body);
  assert.equal(r.items.length, 19);
  assert.equal(byId(r, '211245530'), undefined);
});

test('HTML-сущности в текстах декодируются', () => {
  const body = section
    .replace('Гомельский р-н, аг. Поколюбичи, ул. Луговая', 'Гомельский р-н, аг. Поколюбичи, ул. &quot;Луговая&quot; &amp; пер.&nbsp;Тихий')
    .replace('<div class="price">312 000 р.</div>', '<div class="price">312&nbsp;000&nbsp;р.</div>');
  const i = byId(parse(body), '211245530');
  assert.equal(i.place.text, 'Гомельский р-н, аг. Поколюбичи, ул. "Луговая" & пер. Тихий');
  assert.equal(i.place.settlement, 'Поколюбичи');
  assert.equal(i.price.amount, 312000);
});

test('страница защиты, страница без объявлений, сломанная вёрстка → looksValid: false, без исключений', () => {
  for (const body of [read('blocked.html'), read('broken.html'), card, '', 'не HTML', null]) {
    const r = parse(body);
    assert.equal(r.looksValid, false);
    assert.deepEqual(r.items, []);
    assert.equal(r.nextCursor, null);
  }
  const changed = parse(section.replaceAll('one_advert_list', 'advert_card'));
  assert.equal(changed.looksValid, false);
  assert.deepEqual(changed.items, []);
  assert.equal(changed.total, 696, 'счётчик есть, объявлений нет — вёрстка поменялась');
});

test('пустой раздел — верная страница с нулевым счётчиком', () => {
  const r = parse(listPage('Гомель/дома_продажа/все', 0));
  assert.deepEqual(r, { items: [], nextCursor: null, total: 0, looksValid: true, wrongSection: false });
});

test('чужой раздел → wrongSection, объявления не берутся', () => {
  const r = parse(section, gomelDistrict);
  assert.equal(r.wrongSection, true);
  assert.deepEqual(r.items, []);
  assert.equal(parse(listPage('Гомель/квартиры_продажа/все', 5)).wrongSection, true);
});

test('контактов продавца и заглушек обезличивания в результате нет', () => {
  const out = JSON.stringify([parse(section), parse(subsection, gomelDistrict), moyareklama.parseDetail(card)]);
  for (const s of ['Продавец', '+375', '000-00-00', 'seller@', 'tel:', 'Агентство', 'Собственник', 'single_spec']) {
    assert.ok(!out.includes(s), s);
  }
});

test('parseDetail: координаты карточки в границах Беларуси; нет или 0 → null', () => {
  const { coords } = moyareklama.parseDetail(card);
  assert.deepEqual(coords, { lat: 52.325759, lon: 30.949827 });
  assert.ok(coords.lat >= 51 && coords.lat <= 56.5);
  assert.ok(coords.lon >= 23 && coords.lon <= 33);
  const zero = card.replace('class="ads_geo_lat" value="52.325759"', 'class="ads_geo_lat" value="0"');
  assert.deepEqual(moyareklama.parseDetail(zero), { coords: null });
  for (const body of [section, read('blocked.html'), '', null]) {
    assert.deepEqual(moyareklama.parseDetail(body), { coords: null });
  }
});

test('detailRequest — карточка объявления на домене источника', () => {
  const expected = { url: 'https://www.moyareklama.by/single/ad/211429196', accept: 'text/html' };
  assert.deepEqual(moyareklama.detailRequest('211429196'), expected);
  assert.deepEqual(moyareklama.detailRequest({ externalId: '211429196' }), expected);
});

test('ленты: 6 первых страниц; адреса без /search/, /все/ и параметров', () => {
  assert.deepEqual(moyareklama.feeds.map((f) => f.path), [
    '/Гомель/дома_продажа/',
    '/Советский_район_Гомеля/дома_продажа/',
    '/Центральный_район_Гомеля/дома_продажа/',
    '/Железнодорожный_район_Гомеля/дома_продажа/',
    '/Новобелицкий_район_Гомеля/дома_продажа/',
    '/Гомельский_район/дома_продажа/',
  ]);
  assert.equal(new Set(moyareklama.feeds.map((f) => f.key)).size, 6);
  for (const f of moyareklama.feeds) {
    assert.match(f.key, /^[a-z-]+$/);
    assert.equal(f.maxPages, 1);
    assert.ok(f.cost >= 1 && f.cost <= 8);
    const req = moyareklama.pageRequest(f, 1, null, null);
    assert.equal(req.accept, 'text/html');
    const u = new URL(req.url);
    assert.equal(u.protocol, 'https:');
    assert.ok(moyareklama.allowHosts.includes(u.hostname), req.url);
    assert.equal(u.search, '');
    assert.equal(u.hash, '');
    assert.ok(!/[^\x21-\x7e]/.test(req.url), 'кириллица закодирована');
    const path = decodeURI(u.pathname);
    assert.equal(path, f.path);
    assert.ok(!path.startsWith('/search/') && !path.includes('/все/'), req.url);
  }
});

test('описание источника по контракту', () => {
  assert.equal(moyareklama.id, 'moyareklama');
  assert.equal(moyareklama.title, 'moyareklama.by');
  assert.equal(moyareklama.origin, 'https://www.moyareklama.by');
  assert.deepEqual(moyareklama.allowHosts, ['www.moyareklama.by', 'moyareklama.by']);
  assert.equal(moyareklama.idKind, 'numeric');
  assert.equal(moyareklama.intervalMin, 15);
});

// Страница объявления для проверки понравившихся (specs/003-listing-likes/contracts/source-adapter.md).
test('parseCard: 7 000 BYN, дом 36,1 м², участок 25 сот.', () => {
  assert.deepEqual(moyareklama.parseCard(card), {
    gone: false,
    price: { amount: 7000, currency: 'BYN' },
    priceCurrency: 'BYN',
    priceUsd: null,
    priceByn: 7000,
    houseArea: { value: 36.1, unit: 'm2' },
    plotArea: { value: 25, unit: 'sotki' },
  });
});

test('parseCard: «Ошибка 404» — снято; выдача, защита, пусто — null', () => {
  assert.deepEqual(moyareklama.parseCard(read('card-404.html')), { gone: true });
  for (const body of [section, subsection, read('blocked.html'), '', null]) assert.equal(moyareklama.parseCard(body), null);
  assert.equal(moyareklama.parseCard(section), null, 'повторный вызов: состояние регулярки не мешает');
});

test('parseCard: договорная цена — цены нет, площади есть', () => {
  const noPrice = card.replace(/<div class="price">[\s\S]*?<\/div>/, '<div class="price">Договорная</div>');
  const r = moyareklama.parseCard(noPrice);
  assert.deepEqual([r.gone, r.price, r.priceCurrency, r.priceByn, r.houseArea.value], [false, null, null, null, 36.1]);
});

test('cardRequest — /single/ad/<id>; cardSample открыт в robots.txt', () => {
  assert.deepEqual(moyareklama.cardRequest({ id: 5, external_id: '1366262', url: 'x' }), {
    url: 'https://www.moyareklama.by/single/ad/1366262', accept: 'text/html',
  });
  const robots = parseRobots(read('../robots/moyareklama.txt'));
  assert.ok(isAllowed(robots, moyareklama.cardSample, 'house-hunter-bot/0.1.0'));
});
