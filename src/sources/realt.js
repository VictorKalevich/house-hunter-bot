// Адаптер realt.by: HTML выдачи, данные — JSON из <script id="__NEXT_DATA__"> (research.md R1, contracts/source-adapter.md).

const ORIGIN = 'https://realt.by';
const NEXT_DATA = '<script id="__NEXT_DATA__"';
const SCRIPT_END = '</script>';

const REGIONS = ['brest', 'vitebsk', 'gomel', 'grodno', 'mogilev'];
const SECTIONS = ['cottages', 'dachi'];

/** Категории выдачи realt: продажа домов и продажа дач; в ссылке объявления — `/sale-<раздел>/object/<code>/`. */
const CATEGORY_SECTION = { 11: 'cottages', 13: 'dachi' };
const SECTION_CATEGORY = { cottages: 11, dachi: 13 };

/** objectType (справочник фильтров сайта): 1 дом, 2 полдома, 3 дача, 4 коттедж, 11 участок, 12 таунхаус. */
const KINDS = { 1: 'house', 2: 'part', 3: 'dacha', 4: 'cottage', 12: 'part' };

const CURRENCIES = { 840: 'USD', 933: 'BYN', 978: 'EUR' };

/** townType так, как сайт пишет его перед названием пункта. */
const TOWN_TYPES = {
  0: 'аг.', 1: 'г.', 2: 'г.п.', 3: 'д.', 4: 'к.п.', 5: 'п.', 6: 'р.п.', 7: 'с/т', 9: 'с.н.п.', 10: 'х.',
};
const TOWN_CITY = 1;

/** Ссылки объявлений сайт строит по области объекта; у Минской области префикса нет. */
const REGION_PATHS = {
  'Брестская область': '/brest-region',
  'Витебская область': '/vitebsk-region',
  'Гомельская область': '/gomel-region',
  'Гродненская область': '/grodno-region',
  'Могилевская область': '/mogilev-region',
  'Минская область': '',
};

const feeds = [
  { key: 'minsk-region:cottages', path: '/sale/cottages/', maxPages: 2, cost: 5 },
  { key: 'minsk-region:dachi', path: '/sale/dachi/', maxPages: 2, cost: 3 },
  ...REGIONS.flatMap((region) =>
    SECTIONS.map((section) => ({
      key: `${region}-region:${section}`,
      path: `/${region}-region/sale/${section}/`,
      maxPages: 2,
      cost: 2,
    })),
  ),
];

function feedSection(feed) {
  return feed.path.endsWith('/dachi/') ? 'dachi' : 'cottages';
}

function feedRegionPath(feed) {
  return feed.path.slice(0, feed.path.indexOf('/sale/'));
}

/** JSON из __NEXT_DATA__ или null: поиск по маркеру через indexOf, без HTML-парсера (страница до 2 МБ). */
function readNextData(body) {
  if (typeof body !== 'string') return null;
  const at = body.indexOf(NEXT_DATA);
  if (at < 0) return null;
  const start = body.indexOf('>', at) + 1;
  const end = body.indexOf(SCRIPT_END, start);
  if (start === 0 || end < 0) return null;
  try {
    return JSON.parse(body.slice(start, end));
  } catch {
    return null;
  }
}

function positive(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

function isoDate(value) {
  if (typeof value !== 'string' || !value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function readPrice(o) {
  const rates = o.priceRates ?? {};
  const priceUsd = positive(rates['840']);
  const priceByn = positive(rates['933']);
  const amount = positive(o.price);
  const currency = CURRENCIES[o.priceCurrency];
  let price = null;
  if (amount && currency) price = { amount, currency };
  else if (priceUsd) price = { amount: priceUsd, currency: 'USD' };
  return { price, priceUsd, priceByn };
}

function readCoords(location) {
  if (!Array.isArray(location) || location.length < 2) return null;
  const [lon, lat] = location;
  if (!positive(lat) || !positive(lon)) return null;
  return { lat, lon };
}

function readPlace(o) {
  const settlement = o.townName || null;
  const district = o.stateDistrictName ? `${o.stateDistrictName} район` : null;
  const region = o.stateRegionName || null;
  const type = TOWN_TYPES[o.townType];
  const town = settlement && type ? `${type} ${settlement}` : settlement;
  // Как на сайте: у города район не пишется.
  const districtText = o.stateDistrictName && o.townType !== TOWN_CITY ? `${o.stateDistrictName} р-н` : null;
  const text = [town, districtText, region].filter(Boolean).join(', ') || o.address || '';
  return { text, settlement, district, region };
}

function readPhoto(images) {
  const src = Array.isArray(images) ? images[0] : null;
  if (typeof src !== 'string' || !src) return null;
  if (src.startsWith('https://')) return src;
  if (src.startsWith('//')) return `https:${src}`;
  if (src.startsWith('/')) return ORIGIN + src;
  return null;
}

/** Объект выдачи → RawListing; чужие типы и разделы → null. Контакты продавца не читаются. */
function toListing(o, feed) {
  const kind = KINDS[o?.objectType];
  const section = CATEGORY_SECTION[o?.category];
  if (!kind || !section || o.code == null) return null;
  const regionPath = REGION_PATHS[o.stateRegionName] ?? feedRegionPath(feed);
  const houseArea = positive(o.areaTotal);
  const plotArea = positive(o.areaLand);
  return {
    externalId: String(o.code),
    url: `${ORIGIN}${regionPath}/sale-${section}/object/${o.code}/`,
    kind,
    paid: o.paymentStatus > 0,
    ...readPrice(o),
    houseArea: houseArea ? { value: houseArea, unit: 'm2' } : null,
    plotArea: plotArea ? { value: plotArea, unit: 'sotki' } : null,
    coords: readCoords(o.location),
    place: readPlace(o),
    publishedAt: isoDate(o.updatedAt),
    siteCreatedAt: isoDate(o.createdAt),
    photoUrl: readPhoto(o.images),
  };
}

export default {
  id: 'realt',
  title: 'realt.by',
  origin: ORIGIN,
  allowHosts: ['realt.by'],
  idKind: 'created_at',
  feeds,
  intervalMin: 20,

  pageRequest(feed, page) {
    return { url: ORIGIN + feed.path + (page > 1 ? `?page=${page}` : ''), accept: 'text/html' };
  },

  parsePage(body, { feed }) {
    const pageProps = readNextData(body)?.props?.pageProps;
    const objects = pageProps?.objects;
    if (!Array.isArray(objects)) {
      return { items: [], nextCursor: null, total: null, looksValid: false, wrongSection: false, state: null };
    }
    const total = pageProps.pagination?.totalCount ?? pageProps.totalCount ?? null;
    const wrongSection = pageProps.objectsCategory !== SECTION_CATEGORY[feedSection(feed)];
    const items = wrongSection ? [] : objects.map((o) => toListing(o, feed)).filter(Boolean);
    return { items, nextCursor: null, total, looksValid: true, wrongSection, state: null };
  },
};
