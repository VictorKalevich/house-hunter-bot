// kufar.by: открытый JSON API выдачи (research.md R1). Из `account_parameters` читается только адрес.

const API = 'https://api.kufar.by';
const PHOTO_BASE = 'https://rms.kufar.by/v1/gallery/';
const ALLOW_HOSTS = ['re.kufar.by', 'kufar.by', 'www.kufar.by'];

// house_type_for_sell: код и подпись при lang=ru. 20 — «Прочее», отбрасывается.
const KIND_BY_CODE = new Map([['1', 'house'], ['5', 'cottage'], ['10', 'dacha'], ['15', 'part'], ['25', 'part']]);
const KIND_BY_LABEL = new Map([
  ['дом', 'house'],
  ['коттедж', 'cottage'],
  ['дача', 'dacha'],
  ['часть дома', 'part'],
  ['полдома', 'part'],
  ['таунхаус', 'part'],
  ['дуплекс', 'part'],
]);

// Адрес — как у геокодера, от частного к общему: «улица, дом, пункт, сельсовет, район, область».
const ADMIN_PART = /(^|\s)(область|район|сельсовет|поссовет)$/i;
const DISTRICT = /(^|\s)район$/i;
const REGION = /(^|\s)область$/i;
const NOT_SETTLEMENT = new RegExp(
  '^\\d|^[НРМ]-\\d|^(СТ|СНТ|СОТ|ПСК|с/т|садовое|садоводческое|дачное|дачный)\\s' +
    '|(^|\\s)(ул|улица|пер|переулок|проезд|проспект|пр-т|бульвар|тупик|шоссе|тракт|площадь|набережная|аллея' +
    '|микрорайон|квартал)(\\.|\\s|$)',
  'i',
);

const positive = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const cents = (v) => {
  const n = positive(v);
  return n === null ? null : n / 100;
};

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function paramMap(list) {
  const map = new Map();
  if (Array.isArray(list)) for (const x of list) if (x && typeof x.p === 'string') map.set(x.p, x);
  return map;
}

function listingUrl(link) {
  try {
    const u = new URL(link);
    return u.protocol === 'https:' && ALLOW_HOSTS.includes(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

function toCoords(v) {
  if (!Array.isArray(v) || v.length < 2) return null;
  const lon = Number(v[0]);
  const lat = Number(v[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
  return { lat, lon };
}

function isoTime(v) {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** «Вежновца ул, 3, городской посёлок Городище, …, Барановичский район, Брестская область» → части места. */
function splitAddress(address) {
  const parts = address.split(',').map((s) => s.trim()).filter(Boolean);
  let settlement = null;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (ADMIN_PART.test(parts[i])) continue;
    if (!NOT_SETTLEMENT.test(parts[i])) settlement = parts[i];
    break;
  }
  return {
    settlement,
    district: parts.find((s) => DISTRICT.test(s)) ?? null,
    region: parts.find((s) => REGION.test(s)) ?? null,
  };
}

/** Объявление выдачи → RawListing (contracts/source-adapter.md) или null, если оно не подходит. */
function toListing(ad) {
  if (!ad || typeof ad !== 'object') return null;
  const externalId = /^\d+$/.test(String(ad.ad_id ?? '')) ? String(ad.ad_id) : null;
  const url = listingUrl(ad.ad_link);
  const params = paramMap(ad.ad_parameters);
  const type = params.get('house_type_for_sell');
  const kind = type
    ? (KIND_BY_CODE.get(String(type.v)) ?? KIND_BY_LABEL.get(String(type.vl).trim().toLowerCase()) ?? null)
    : null;
  if (!externalId || !url || !kind) return null;

  const address = Array.isArray(ad.account_parameters)
    ? text(ad.account_parameters.find((x) => x?.p === 'address')?.v)
    : null;
  const fromAddress = address ? splitAddress(address) : { settlement: null, district: null, region: null };
  const area = text(params.get('area')?.vl);
  const district = fromAddress.district ?? (area && DISTRICT.test(area) ? area : null);
  const region = text(params.get('region')?.vl) ?? fromAddress.region;

  const priceUsd = cents(ad.price_usd);
  const priceByn = cents(ad.price_byn);
  // Валюта продавца (specs/003-listing-likes/contracts/source-adapter.md): суммы в евро в выдаче нет.
  const currency = ad.currency === 'BYR' ? 'BYN' : ad.currency === 'USD' ? 'USD' : null;
  const sellerAmount = currency === 'BYN' ? priceByn : currency === 'USD' ? priceUsd : null;
  const houseArea = positive(params.get('size')?.v);
  const plotArea = positive(params.get('size_area')?.v);
  const photoPath = Array.isArray(ad.images) ? text(ad.images[0]?.path) : null;

  return {
    externalId,
    url,
    kind,
    paid: ad.paid_services?.polepos === true,
    price: sellerAmount !== null
      ? { amount: sellerAmount, currency }
      : priceUsd === null ? null : { amount: priceUsd, currency: 'USD' },
    priceCurrency: sellerAmount !== null ? currency : null,
    priceUsd,
    priceByn,
    houseArea: houseArea === null ? null : { value: houseArea, unit: 'm2' },
    plotArea: plotArea === null ? null : { value: plotArea, unit: 'sotki' },
    coords: toCoords(params.get('coordinates')?.v),
    place: {
      text: address ?? ([district, region].filter(Boolean).join(', ') || null),
      settlement: fromAddress.settlement,
      district,
      region,
    },
    publishedAt: isoTime(ad.list_time),
    siteCreatedAt: null,
    photoUrl: photoPath ? PHOTO_BASE + photoPath : null,
  };
}

export default {
  id: 'kufar',
  title: 'kufar.by',
  origin: 'https://re.kufar.by',
  allowHosts: ALLOW_HOSTS,
  idKind: 'numeric',
  paging: 'cursor',
  feeds: [
    {
      key: 'kufar:all',
      path: '/search-api/v2/search/rendered-paginated?cat=1020&typ=sell&sort=lst.d&size=30&lang=ru',
      maxPages: 3,
      cost: 2,
    },
  ],
  intervalMin: 15,

  pageRequest(feed, page, cursor) {
    if (page > 1 && !cursor) throw new Error(`kufar: нет курсора для страницы ${page}`);
    const url = `${API}${feed.path}${page > 1 ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    return { url, accept: 'application/json' };
  },

  parsePage(body) {
    const result = { items: [], nextCursor: null, total: null, looksValid: false, wrongSection: false, state: null };
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return result;
    }
    if (!data || !Array.isArray(data.ads)) return result;

    for (const ad of data.ads) {
      const item = toListing(ad);
      if (item) result.items.push(item);
    }
    const pages = Array.isArray(data.pagination?.pages) ? data.pagination.pages : [];
    result.nextCursor = text(pages.find((p) => p?.label === 'next')?.token);
    result.total = Number.isFinite(data.total) ? data.total : null;
    result.looksValid = true;
    return result;
  },
};
