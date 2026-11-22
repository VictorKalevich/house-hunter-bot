// RawListing → строка listings (data-model.md listings, contracts/source-adapter.md «Нормализация»).
import { NEW_BY_CREATED_MS } from '../config.js';

const BY_BOUNDS = { minLat: 50.5, maxLat: 57, minLon: 22.5, maxLon: 33.5 };

export function hostAllowed(adapter, url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const hosts = adapter.allowHosts ?? [new URL(adapter.origin).hostname];
  return hosts.includes(u.hostname);
}

const positive = (n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null);
const round2 = (n) => (n === null ? null : Math.round(n * 100) / 100);

export function priceUsd(raw, rate) {
  if (positive(raw.priceUsd)) return Math.round(raw.priceUsd);
  const amount = positive(raw.price?.amount);
  if (amount === null) return null;
  if (raw.price.currency === 'USD') return Math.round(amount);
  if (raw.price.currency === 'BYN' && positive(rate)) return Math.round(amount / rate);
  return null;
}

export function priceByn(raw) {
  if (positive(raw.priceByn)) return Math.round(raw.priceByn);
  const amount = positive(raw.price?.amount);
  return amount !== null && raw.price.currency === 'BYN' ? Math.round(amount) : null;
}

/** Участок → сотки: 1 га = 100 сот., 100 м² = 1 сот. */
export function plotSotki(area) {
  const v = positive(area?.value);
  if (v === null) return null;
  if (area.unit === 'ha') return round2(v * 100);
  if (area.unit === 'm2') return round2(v / 100);
  return round2(v);
}

export function validCoords(coords) {
  if (!coords) return null;
  const { lat, lon } = coords;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < BY_BOUNDS.minLat || lat > BY_BOUNDS.maxLat || lon < BY_BOUNDS.minLon || lon > BY_BOUNDS.maxLon) return null;
  return { lat, lon };
}

export function geoKey(lat, lon) {
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

const time = (iso) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/**
 * Новое на сайте (data-model.md listings.is_new). Вызывается только для объявлений, которых бот раньше не видел.
 * @param {{now: number, idFloor: number|null, firstCycle: boolean}} ctx
 */
export function computeIsNew(adapter, raw, { now, idFloor, firstCycle }) {
  if (firstCycle) return 0;
  if (adapter.idKind === 'numeric') {
    const id = Number(raw.externalId);
    return idFloor !== null && idFloor !== undefined && Number.isSafeInteger(id) && id > idFloor ? 1 : 0;
  }
  const created = time(raw.siteCreatedAt);
  return created !== null && now - created <= NEW_BY_CREATED_MS ? 1 : 0;
}

export function placeText(place) {
  const text = String(place?.text ?? '').replace(/\s+/g, ' ').trim();
  if (text) return text.slice(0, 300);
  return [place?.settlement, place?.district, place?.region].filter(Boolean).join(', ').slice(0, 300);
}

/**
 * @param {object} raw RawListing
 * @param {object} adapter
 * @param {{now: number, rate: number|null, settlement?: {id: number, lat: number, lon: number}|null}} ctx
 *   settlement — пункт справочника для объявления без координат
 * @returns {object|null} поля listings без is_new/first_seen_at (их ставит ingest); null — объявление отброшено
 */
export function normalizeListing(raw, adapter, { now, rate, settlement = null }) {
  if (!raw || typeof raw.externalId !== 'string' || raw.externalId === '' || raw.externalId.length > 64) return null;
  if (!hostAllowed(adapter, raw.url)) return null;

  const coords = validCoords(raw.coords);
  let lat = null;
  let lon = null;
  let geoApprox = 0;
  let settlementId = null;
  if (coords) {
    ({ lat, lon } = coords);
  } else if (settlement) {
    lat = settlement.lat;
    lon = settlement.lon;
    geoApprox = 1;
    settlementId = settlement.id;
  }
  const photo = raw.photoUrl && /^https:\/\//.test(raw.photoUrl) ? raw.photoUrl.slice(0, 500) : null;
  const publishedAt = time(raw.publishedAt);

  return {
    source: adapter.id,
    external_id: raw.externalId,
    url: raw.url,
    price_usd: priceUsd(raw, rate),
    price_byn: priceByn(raw),
    house_m2: round2(positive(raw.houseArea?.value)),
    plot_sotki: plotSotki(raw.plotArea),
    lat,
    lon,
    geo_approx: geoApprox,
    geo_key: lat === null ? null : geoKey(lat, lon),
    settlement_id: settlementId,
    place_text: placeText(raw.place),
    photo_url: photo,
    published_at: publishedAt,
    site_created_at: time(raw.siteCreatedAt),
    sort_at: publishedAt ?? now,
    needs_detail: !coords && typeof adapter.detailRequest === 'function' ? 1 : 0,
  };
}
