// domovita.by: JSON страниц Next.js `/_next/data/{buildId}/…` (research.md R1). `contacts` не читаются.

const ORIGIN = 'https://domovita.by';
const ALLOW_HOSTS = ['domovita.by'];
const BUILD_ID = /^[\w-]{1,64}$/;
// buildId — в <head> (у Минской области на ~95 КБ), но голову раздувает JSON-LD с текстами 20 объявлений.
const STATE_READ_BYTES = 256 * 1024;

const REGIONS = [
  'minsk', 'minskaya-oblast', 'brestskaya-oblast', 'vitebskaya-oblast', 'gomelskaya-oblast', 'grodnenskaya-oblast',
  'mogilevskaya-oblast',
];

// Типы объектов раздела «Дома»; дачи (ODachaSale) — отдельный раздел на старом сайте, в `_next/data` его нет.
const HOUSE_TYPES = new Set(['OCottagesSale', 'OHousesSale']);
const PART = /дуплекс|таунхаус|полдома|часть дома|блокир/;
const DISTRICT = /\s(р-н|район)$/i;

const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN);

const positive = (v) => {
  const n = num(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Абсолютная https-ссылка; относительные — от domovita.by. */
function httpsUrl(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  try {
    const u = new URL(v.trim(), ORIGIN);
    if (u.protocol === 'http:') u.protocol = 'https:';
    return u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

function listingUrl(v) {
  const u = httpsUrl(v);
  return u && ALLOW_HOSTS.includes(u.hostname) ? u.href : null;
}

function kindOf(it) {
  if (!HOUSE_TYPES.has(it.type)) return null;
  const t = String(it.object_type ?? '').trim().toLowerCase();
  if (num(it.is_half_house) === 1 || PART.test(t)) return 'part';
  if (t.includes('коттедж')) return 'cottage';
  if (t.includes('дач') || t.includes('садов')) return 'dacha';
  if (t === '' || t.includes('дом') || t.includes('усадьб')) return 'house';
  return null;
}

/** «2026-11-22 13:51:41» или «2026-11-22» по Минску (UTC+3) → мс. */
function minskTime(v) {
  const m = typeof v === 'string'
    ? /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?:[ T]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?)?$/.exec(v.trim())
    : null;
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0) - 3, +(m[5] ?? 0), +(m[6] ?? 0));
}

const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());

function toCoords(c) {
  const lat = num(c?.position_x);
  const lon = num(c?.position_y);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
  return { lat, lon };
}

/** Заголовок «1-этажный дом, д. Ректа, Жлобинский р-н, ул. Молодёжная» и адрес → место. */
function placeOf(it) {
  const town = it.address?.town ?? {};
  const settlement = text(town.name);
  const parts = (text(it.title) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const district = parts.find((s) => DISTRICT.test(s)) ?? null;
  const at = settlement ? parts.findIndex((s) => s.includes(settlement)) : -1;
  const fromTitle = (at >= 0 ? parts.slice(at) : parts.slice(1)).join(', ');
  const composed = [[text(town.type), settlement].filter(Boolean).join(' '), district, text(it.address?.street_name)]
    .filter(Boolean)
    .join(', ');
  return { text: fromTitle || composed || null, settlement, district, region: text(town.stateRegion?.name) };
}

/** Карточка выдачи → RawListing (contracts/source-adapter.md) или null, если она не подходит. */
function toListing(it) {
  if (!it || typeof it !== 'object') return null;
  const externalId = /^\d+$/.test(String(it.id ?? '')) ? String(it.id) : null;
  const url = listingUrl(it.url);
  const kind = kindOf(it);
  if (!externalId || !url || !kind) return null;

  const priceUsd = positive(it.price?.USD);
  const priceByn = positive(it.price?.BYN);
  const houseArea = positive(it.area?.total);
  const plotArea = positive(it.area_ground);
  const created = minskTime(it.date_reception);
  // date_revision — только день поднятия: начало дня, но не раньше создания.
  const revised = minskTime(it.date_revision);
  const published = created === null ? revised : revised === null ? created : Math.max(created, revised);
  const photo = Array.isArray(it.photos) ? httpsUrl(it.photos[0]?.url) : null;

  return {
    externalId,
    url,
    kind,
    paid: num(it.is_vip) === 3,
    price: priceUsd !== null
      ? { amount: priceUsd, currency: 'USD' }
      : priceByn !== null ? { amount: priceByn, currency: 'BYN' } : null,
    priceCurrency: null,
    priceUsd,
    priceByn,
    houseArea: houseArea === null ? null : { value: houseArea, unit: 'm2' },
    plotArea: plotArea === null ? null : { value: plotArea, unit: 'sotki' },
    coords: toCoords(it.address?.coords),
    place: placeOf(it),
    publishedAt: iso(published),
    siteCreatedAt: iso(created),
    photoUrl: photo ? photo.href : null,
  };
}

export default {
  id: 'domovita',
  title: 'domovita.by',
  origin: ORIGIN,
  allowHosts: ALLOW_HOSTS,
  idKind: 'created_at',
  feeds: REGIONS.map((slug) => ({
    key: `${slug}:houses`,
    path: `/${slug}/houses/sale`,
    maxPages: slug === 'minskaya-oblast' ? 3 : 2,
    cost: 2,
  })),
  intervalMin: 20,
  resetStateOn404: true,

  pageRequest(feed, page, cursor, state) {
    const buildId = typeof state?.buildId === 'string' && BUILD_ID.test(state.buildId) ? state.buildId : null;
    if (!buildId) {
      return { url: ORIGIN + feed.path, accept: 'text/html', purpose: 'state', readLimitBytes: STATE_READ_BYTES };
    }
    return {
      url: `${ORIGIN}/_next/data/${buildId}${feed.path}.json${page > 1 ? `?page=${page}` : ''}`,
      accept: 'application/json',
      purpose: 'page',
    };
  },

  /** buildId из `<script src="/_next/static/{buildId}/_buildManifest.js">`, запасной — из `__NEXT_DATA__`. */
  parseState(body) {
    if (typeof body !== 'string') return null;
    const manifest = body.indexOf('/_buildManifest.js');
    if (manifest > 0) {
      const start = body.lastIndexOf('/_next/static/', manifest);
      const id = start >= 0 ? body.slice(start + '/_next/static/'.length, manifest) : '';
      if (BUILD_ID.test(id)) return { buildId: id };
    }
    const key = body.indexOf('"buildId":"');
    if (key >= 0) {
      const from = key + '"buildId":"'.length;
      const id = body.slice(from, body.indexOf('"', from));
      if (BUILD_ID.test(id)) return { buildId: id };
    }
    return null;
  },

  parsePage(body, { feed } = {}) {
    const result = { items: [], nextCursor: null, total: null, looksValid: false, wrongSection: false, state: null };
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return result;
    }
    const props = data?.pageProps;
    const cards = props?.listingCardsFromSSR;
    if (!cards || !Array.isArray(cards.items)) return result;
    result.looksValid = true;
    result.total = Number.isFinite(cards.totalCount) ? cards.totalCount : null;

    // Чужой раздел: /dacha/sale отдаёт в listingCardsFromSSR квартиры (OFlatsSale).
    const section = feed?.path?.split('/')[2] ?? 'houses';
    const object = props.pageSettingsByPath?.urlParams?.object;
    if ((typeof object === 'string' && object !== section)
      || (cards.items.length > 0 && !cards.items.some((it) => HOUSE_TYPES.has(it?.type)))) {
      result.wrongSection = true;
      return result;
    }
    for (const it of cards.items) {
      const item = toListing(it);
      if (item) result.items.push(item);
    }
    return result;
  },
};
