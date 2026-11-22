// Тексты: уведомление (contracts/telegram-bot.md «Уведомление»), подпись расстояния, карточка ListingCard
// (contracts/miniapp-api.md «Объекты»).
import { KIND_TITLES } from '../config.js';
import { escapeHtml } from '../telegram/html.js';
import { SOURCE_TITLES } from '../sources/titles.js';

const MODE_TEXT = { straight: 'по прямой', road_center: 'по дороге от центра', road_exit: 'по дороге от выезда' };

export function formatInt(n) {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function formatDecimal(n) {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? formatInt(r) : String(r).replace('.', ',');
}

export function formatKm(km) {
  return km < 10 ? formatDecimal(km) : formatInt(km);
}

/**
 * «Боровляны: ≈ 31 км по дороге от выезда», «Минск: 25 км по прямой (маршрут не построен)».
 * Название пункта — в начале строки, чтобы не склонять его.
 * @param {{km: number, mode: string, approx?: boolean, fallback?: boolean, settlementName?: string|null}} d
 */
export function distanceLabel({ km, mode, approx = false, fallback = false, settlementName = null }) {
  const how = fallback ? `${MODE_TEXT.straight} (маршрут не построен)` : MODE_TEXT[mode] ?? MODE_TEXT.straight;
  const value = `${approx ? '≈ ' : ''}${formatKm(km)} км ${how}`;
  return settlementName ? `${settlementName}: ${value}` : value;
}

export function priceLine(listing) {
  if (listing.price_usd !== null && listing.price_usd !== undefined) return `<b>${formatInt(listing.price_usd)} $</b>`;
  if (listing.price_byn !== null && listing.price_byn !== undefined) return `<b>${formatInt(listing.price_byn)} BYN</b>`;
  return 'цена не указана';
}

/**
 * Сообщение sendMessage о новом объявлении (без chat_id).
 * @param {object} listing строка listings
 * @param {{searchTitles: string[], distanceLabel?: string|null}} ctx
 */
export function notificationMessage(listing, { searchTitles, distanceLabel: distance = null }) {
  const house = listing.house_m2 ? `дом ${formatDecimal(listing.house_m2)} м²` : 'дом: не указано';
  const plot = listing.plot_sotki ? `участок ${formatDecimal(listing.plot_sotki)} сот.` : 'участок: не указано';
  const titles = searchTitles.map((t) => `«${escapeHtml(t)}»`).join(', ');
  const kind = KIND_TITLES[listing.kind];
  const lines = [
    `${kind ? `${kind} · ` : ''}${priceLine(listing)} · ${house} · ${plot}`,
    distance ? escapeHtml(distance) : null,
    listing.place_text ? escapeHtml(listing.place_text) : null,
    `${escapeHtml(SOURCE_TITLES[listing.source] ?? listing.source)} · ${searchTitles.length > 1 ? 'Поиски' : 'Поиск'}: ${titles}`,
  ].filter(Boolean);
  return {
    text: lines.join('\n'),
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: 'Открыть объявление', url: listing.url }]] },
    link_preview_options: listing.photo_url
      ? { url: listing.photo_url, prefer_large_media: true, show_above_text: true }
      : { is_disabled: true },
  };
}

/**
 * Строка listings → ListingCard.
 * @param {object} row
 * @param {{km: number|null, mode: string, approx: boolean, fallback: boolean, pending: boolean}|null} distance
 */
export function listingCard(row, distance) {
  return {
    source: row.source,
    url: row.url,
    photoUrl: row.photo_url ?? null,
    kind: row.kind ?? null,
    priceUsd: row.price_usd ?? null,
    priceByn: row.price_byn ?? null,
    houseM2: row.house_m2 ?? null,
    plotSotki: row.plot_sotki ?? null,
    distance: distance
      ? {
          km: distance.km === null ? null : Math.round(distance.km * 10) / 10,
          mode: distance.mode,
          approx: Boolean(distance.approx),
          fallback: Boolean(distance.fallback),
          pending: Boolean(distance.pending),
        }
      : null,
    place: row.place_text ?? '',
    publishedAt: new Date(row.published_at ?? row.first_seen_at).toISOString(),
    isNew: row.is_new === 1,
    createdAt: row.site_created_at == null ? null : new Date(row.site_created_at).toISOString(),
  };
}
