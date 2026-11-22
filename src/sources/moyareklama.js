// moyareklama.by: HTML первой страницы раздела «Продажа домов и дач» Гомеля и его подразделов (research.md R1).
// Разбор строк по известной разметке, без HTML-парсера.

// Голый домен отвечает 301 на www (проверено 22.11.2026): запросы — сразу на www, чтобы не удваивать их.
const ORIGIN = 'https://www.moyareklama.by';
const REGION = 'Гомельская область';
const CITY = 'Гомель';

const KINDS = new Map([
  ['дом', 'house'],
  ['усадьба', 'house'],
  ['коттедж', 'cottage'],
  ['дача', 'dacha'],
  ['часть дома', 'part'],
  ['полдома', 'part'],
  ['доля', 'part'],
  ['таунхаус', 'part'],
]);

const CITY_DISTRICTS = new Set(['железнодорожный', 'новобелицкий', 'советский', 'центральный']);

// Раздел Гомеля включает и группу «Вне области»: у таких адресов район чужой, и область не подставляется.
const REGION_DISTRICTS = new Set([
  'брагинский', 'буда-кошелевский', 'ветковский', 'гомельский', 'добрушский', 'ельский', 'житковичский',
  'жлобинский', 'калинковичский', 'кормянский', 'лельчицкий', 'лоевский', 'мозырский', 'наровлянский',
  'октябрьский', 'петриковский', 'речицкий', 'рогачевский', 'светлогорский', 'хойникский', 'чечерский',
]);

// Типы пунктов из справочника сайта; «СТ», «с/с», «тер.», «км» — не населённые пункты. «д. 20» — номер дома.
const SETTLEMENT_TYPES = ['г.п.', 'пгт', 'гп', 'рп', 'аг.', 'пос.', 'п.', 'д.', 'ст.', 'с.', 'х.', 'г.', 'местечко', 'слобода'];

const ENTITIES = {
  amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', sup2: '²', sup3: '³', laquo: '«', raquo: '»',
  ndash: '–', mdash: '—', hellip: '…', bull: '•', deg: '°', euro: '€', times: '×', minus: '−',
};

const ITEM_START = /<div\s+class="one_advert_list[\s"]/g;
const BLOCKED = /Just a moment\.\.\.|_cf_chl_opt|challenge-platform|cf-browser-verification|Attention Required!/;

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

function text(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function num(s) {
  return Number(s.replace(',', '.'));
}

/** «Дом 235 м² на участке 6,9 сот.» → тип, дом, участок. */
function parseTitle(title) {
  const [head, tail = ''] = title.replace(/\.$/, '').split(/\s+на\s+участке\s+/i);
  const area = head.match(/(\d+(?:[.,]\d+)?)\s*(?:м²|м2|кв\.\s?м)/i);
  const kindText = (area ? head.slice(0, area.index) : head).trim().toLowerCase();
  const plot = tail.match(/^(\d+(?:[.,]\d+)?)\s*(сот|га|м²|м2|кв\.\s?м)/i);
  let plotArea = null;
  if (plot && num(plot[1]) > 0) {
    const u = plot[2].toLowerCase();
    plotArea = { value: num(plot[1]), unit: u === 'сот' ? 'sotki' : u === 'га' ? 'ha' : 'm2' };
  }
  return {
    kind: KINDS.get(kindText) ?? null,
    houseArea: area && num(area[1]) > 0 ? { value: num(area[1]), unit: 'm2' } : null,
    plotArea,
  };
}

function settlementName(part) {
  if (!part) return null;
  for (const t of SETTLEMENT_TYPES) {
    if (part.startsWith(`${t} `) || (t.endsWith('.') && part.startsWith(t))) {
      const name = part.slice(t.length).trim();
      return /^[А-ЯЁA-Z]/.test(name) ? name : null;
    }
  }
  return null;
}

/** «Гомельский р-н, аг. Поколюбичи, ул. Луговая»; «Советский р-н, ул. Гоголя» — район Гомеля. */
function parsePlace(placeText) {
  const parts = placeText.replace(/\([^)]*\)/g, '').split(',').map((p) => p.trim()).filter(Boolean);
  let settlement = null;
  let district = null;
  let region = REGION;
  let i = 0;
  const d = parts[0]?.match(/^(.+?)\s+(?:р-н|район)\.?$/i);
  if (d) {
    const name = d[1].toLowerCase().replace(/ё/g, 'е');
    if (CITY_DISTRICTS.has(name)) {
      settlement = CITY;
    } else {
      district = parts[0];
      if (!REGION_DISTRICTS.has(name)) region = null;
    }
    i = 1;
  }
  settlement ??= settlementName(parts[i]);
  if (settlement === CITY) district = null;
  return { text: placeText, settlement, district, region };
}

/** «312 000 р.» → 312000; пусто, «договорная», 0 → null. */
function parsePrice(priceText) {
  const m = priceText.match(/(\d[\d\s]*)\s*(?:р\.|руб)/);
  if (!m) return null;
  const amount = Number(m[1].replace(/\s/g, ''));
  return amount > 0 ? amount : null;
}

/** «22.11.2026» → полночь по Минску (UTC+3) в ISO; «сегодня», «вчера» без текущего времени не перевести → null. */
function parseDate(dateText) {
  const m = dateText.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  const ms = Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])) - 3 * 3600_000;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function absoluteUrl(u) {
  if (u.startsWith('https://')) return u;
  if (u.startsWith('http://')) return `https://${u.slice(7)}`;
  if (u.startsWith('//')) return `https:${u}`;
  if (u.startsWith('/')) return `${ORIGIN}${u}`;
  return null;
}

function parseItem(fragment) {
  const open = fragment.slice(0, fragment.indexOf('>') + 1);
  const id = (open.match(/idAds="(\d+)"/i) ?? fragment.match(/href="\/single\/ad\/(\d+)"/))?.[1];
  const title = fragment.match(/<div class="title">\s*<a([^>]*)>([\s\S]*?)<\/a>/);
  if (!id || !title) return null;
  const { kind, houseArea, plotArea } = parseTitle(text(title[2]));
  if (!kind) return null;

  const price = parsePrice(text(fragment.match(/<div class="price">([\s\S]*?)<\/div>/)?.[1] ?? ''));
  const placeText = text(fragment.match(/<div class="address">([\s\S]*?)<\/div>/)?.[1] ?? '');
  const date = text(fragment.match(/class="date">([\s\S]*?)<\/div>/)?.[1] ?? '');
  const style = fragment.match(/<div class="small_img"\s+style="([^"]*)"/)?.[1] ?? '';
  const photo = decodeEntities(style).match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/)?.[1];

  return {
    externalId: id,
    url: `${ORIGIN}/single/ad/${id}`,
    kind,
    paid: /\bmaxi\b/.test(open) || /class="[^"]*\bpremium\b/.test(title[1]),
    price: price ? { amount: price, currency: 'BYN' } : null,
    priceUsd: null,
    priceByn: price,
    houseArea,
    plotArea,
    coords: null,
    place: placeText ? parsePlace(placeText) : { text: '', settlement: null, district: null, region: REGION },
    publishedAt: parseDate(date),
    siteCreatedAt: null,
    photoUrl: photo ? absoluteUrl(photo.trim()) : null,
  };
}

function readListParams(body) {
  const marker = 'var listParams = ';
  const at = body.indexOf(marker);
  if (at < 0) return null;
  const end = body.indexOf('};', at);
  if (end < 0) return null;
  try {
    return JSON.parse(body.slice(at + marker.length, end + 1));
  } catch {
    return null;
  }
}

function itemsEnd(body, from) {
  for (const marker of ['<ul class="pagination"', 'var listParams', 'id="footer-main"']) {
    const at = body.indexOf(marker, from);
    if (at >= 0) return at;
  }
  return body.length;
}

export default {
  id: 'moyareklama',
  title: 'moyareklama.by',
  origin: ORIGIN,
  allowHosts: ['www.moyareklama.by', 'moyareklama.by'],
  idKind: 'numeric',
  // Пагинация (`/*/все/`), `/search/` и сортировка закрыты robots.txt — только первая страница каждой ленты.
  feeds: [
    { key: 'gomel', path: '/Гомель/дома_продажа/', maxPages: 1, cost: 1 },
    { key: 'gomel-sovetsky', path: '/Советский_район_Гомеля/дома_продажа/', maxPages: 1, cost: 1 },
    { key: 'gomel-tsentralny', path: '/Центральный_район_Гомеля/дома_продажа/', maxPages: 1, cost: 1 },
    { key: 'gomel-zheleznodorozhny', path: '/Железнодорожный_район_Гомеля/дома_продажа/', maxPages: 1, cost: 1 },
    { key: 'gomel-novobelitsky', path: '/Новобелицкий_район_Гомеля/дома_продажа/', maxPages: 1, cost: 1 },
    { key: 'gomel-district', path: '/Гомельский_район/дома_продажа/', maxPages: 1, cost: 1 },
  ],
  intervalMin: 15,

  /** @param {{path: string}} feed */
  pageRequest(feed) {
    return { url: ORIGIN + encodeURI(feed.path), accept: 'text/html' };
  },

  /**
   * @param {string} body
   * @param {{feed?: {path: string}, page?: number}} [ctx]
   */
  parsePage(body, { feed } = {}) {
    const html = String(body ?? '');
    const invalid = { items: [], nextCursor: null, total: null, looksValid: false, wrongSection: false };
    if (BLOCKED.test(html.slice(0, 20_000))) return invalid;

    const params = readListParams(html);
    const countAds = Number(params?.countAds);
    const total = params && Number.isFinite(countAds) ? countAds : null;
    const sectionPath = typeof params?.path === 'string' ? params.path : null;
    const want = feed?.path?.replace(/^\/+|\/+$/g, '');
    const wrongSection = sectionPath !== null
      && (want ? sectionPath !== want && !sectionPath.startsWith(`${want}/`) : !sectionPath.includes('/дома_продажа'));

    const starts = [...html.matchAll(ITEM_START)].map((m) => m.index);
    if (starts.length === 0) {
      const empty = total === 0 && sectionPath !== null && !wrongSection;
      return { ...invalid, total, looksValid: empty, wrongSection };
    }
    if (wrongSection) return { items: [], nextCursor: null, total, looksValid: true, wrongSection };

    const items = [];
    const seen = new Set();
    starts.forEach((start, i) => {
      const end = i + 1 < starts.length ? starts[i + 1] : itemsEnd(html, start);
      const item = parseItem(html.slice(start, end));
      if (item && !seen.has(item.externalId)) {
        seen.add(item.externalId);
        items.push(item);
      }
    });
    return { items, nextCursor: null, total, looksValid: true, wrongSection: false };
  },

  /** Карточка — ради координат: в выдаче их нет. @param {string | {externalId: string}} item */
  detailRequest(item) {
    const id = typeof item === 'object' && item !== null ? item.externalId : item;
    return { url: `${ORIGIN}/single/ad/${id}`, accept: 'text/html' };
  },

  /** Только `input.ads_geo_lat`/`ads_geo_lng`; контакты карточки не читаются. @param {string} body */
  parseDetail(body) {
    const html = String(body ?? '');
    const value = (cls) => {
      const tag = html.match(new RegExp(`<input[^>]*class="${cls}"[^>]*>`))?.[0];
      const v = tag?.match(/value="([^"]*)"/)?.[1];
      return v === undefined ? NaN : Number(v.trim().replace(',', '.'));
    };
    const lat = value('ads_geo_lat');
    const lon = value('ads_geo_lng');
    const ok = Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0 && lon !== 0
      && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    return { coords: ok ? { lat, lon } : null };
  },
};
